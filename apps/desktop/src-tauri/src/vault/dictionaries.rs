//! Dicionários do usuário em camadas (r32, D-P26-03). A camada GLOBAL, deste computador, fica nos
//! dados do app (`app_data_dir()/dictionaries/*.txt`) e só é alcançada por `dict_global_read` e
//! `dict_global_write`; a da PASTA (`.simplemd/dictionaries/*.txt`) é uma classe de arquivo do
//! gateway (`policy::file_class`). Formato v1 (UTF-8, um termo por linha): quem interpreta é o app.
//!
//! O webview manda só o NOME (`policy::dictionary_name`): a pasta é fixa e nenhum caminho entra ou
//! sai. Nenhum componente abaixo da raiz segue link (`ops::walk_target`, `ops::open_no_follow`). Os
//! tetos valem antes de ler e de gravar: 10 MiB por arquivo e, por camada, 16 arquivos e 20 MiB — o
//! excesso fica de fora e é contado (D-R32-2). Pelo webview só `pessoal.txt` nasce (D-R32-3), por
//! temporário e `rename` (`replace::write_new`); os outros só são sobrescritos, sempre de forma
//! condicional (sha256 da base) e atômica (`replace`, r26). Erros só com o código; logs só com
//! contagens.
//!
//! r33 (`import`): a importação de listas (`dict_import`) e renomear/remover (`dict_manage`), nas
//! duas camadas, sob a mesma trava. O par Hunspell original de uma lista importada fica em
//! `<camada>/hunspell/<nome>.dic|.aff`, fora das classes do gateway.
//!
//! r34 (corretor, D-R34-5): `GlobalDictionaries::engine_sources` é a única porta do motor
//! (`crate::spell`) para as camadas. Lê as duas com este leitor (`read_layer`: mesmos tetos, link
//! recusado, sob a trava), tira os termos v1 em NFC como o leitor do app (até 200.000 por camada) e
//! lê o par de cada lista visível — o `<nome>.txt` precisa existir — sem seguir link, só arquivo
//! comum, com teto ANTES de ler (`.aff` 2 MiB, `.dic` 10 MiB; até 8 pares e 24 MiB por recarga) e
//! decodificado pelo `SET` (`import::declared_encoding`, `import::decode`). O par continua entrada
//! não confiável (AppSec r33a N5): diretivas, contagens e tempo ficam com o motor. Nada disso volta
//! ao webview: só contagens.

pub mod import;

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};

use icu_normalizer::ComposingNormalizerBorrowed;
use serde::Serialize;
use tauri::State;

use super::ops::{join, open_no_follow, read_capped, too_large, walk_target};
use super::policy::{dictionary_name, DICTIONARY_MAX_BYTES};
use super::{blocking, replace};
use crate::error::AppError;

/// Pasta da camada global, dentro dos dados do app.
pub(super) const GLOBAL_DIR: &str = "dictionaries";
/// Segmentos da camada global a partir dos dados do app.
pub(super) const GLOBAL_LAYER: &[&str] = &[GLOBAL_DIR];
/// Segmentos da camada da pasta a partir da raiz do vault (a classe de `policy::file_class`).
pub(super) const FOLDER_LAYER: &[&str] = &[".simplemd", "dictionaries"];
/// Subpasta de uma camada com o par Hunspell original de cada lista importada (r33, D-R33-6):
/// `hunspell/<nome>.dic|.aff`, sem classe no gateway (o webview não lê nem lista).
pub(super) const PAIR_DIR: &str = "hunspell";
/// O único arquivo que a camada global cria pelo webview (D-R32-3); nunca renomeado nem removido
/// pelo app (r33, `PROTECTED`).
pub(super) const PERSONAL: &str = "pessoal.txt";
/// Arquivos lidos por camada (D-R32-2).
pub(super) const LAYER_MAX_FILES: usize = 16;
/// Bytes lidos por camada (D-R32-2).
pub(super) const LAYER_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// Termos por camada, na união dos arquivos (D-R32-2; o teto do leitor do TS).
pub(super) const LAYER_MAX_TERMS: usize = 200_000;

/// Um arquivo da camada: o texto e o sha256 dos bytes (hex minúsculo, a base da gravação
/// condicional) ou o código do erro desse arquivo (`OUTSIDE_VAULT` = link, `TOO_LARGE`, `NOT_UTF8`,
/// `PERMISSION_DENIED`, `IO`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum LayerFile {
    Text {
        name: String,
        text: String,
        sha256: String,
    },
    Error {
        name: String,
        error: &'static str,
    },
}

/// Uma camada lida: `pessoal.txt` primeiro, o resto pela ordem dos bytes do nome; `skipped` = os
/// arquivos deixados de fora pelos tetos da camada (16 arquivos, 20 MiB).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Layer {
    pub files: Vec<LayerFile>,
    pub skipped: u32,
}

/// Camada global (estado do app, num `Arc`): a pasta de dados do app, raiz confiável do percurso
/// até `GLOBAL_DIR`, e a trava que serializa leitura e gravação — a conferência do sha256 e a troca
/// de um pedido nunca se intercalam com as de outro; a importação e renomear/remover (r33) gravam
/// nas duas camadas sob ela. `importing`: uma importação por vez (`BUSY`), diálogo incluído.
pub struct GlobalDictionaries {
    data_dir: PathBuf,
    lock: Mutex<()>,
    importing: AtomicBool,
}

impl GlobalDictionaries {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            lock: Mutex::new(()),
            importing: AtomicBool::new(false),
        }
    }

    /// Trava dos dicionários gravados pelo Rust: a camada global e a importação (r33), nas duas
    /// camadas.
    pub(super) fn guard(&self) -> MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A camada global para o leitor (`read_layer`) e para quem grava nela: a raiz confiável do
    /// percurso (os dados do app, que recusa um link em `GLOBAL_DIR`) e os segmentos até a pasta.
    /// Também o ponto de leitura do corretor da r34 (D-R34-5).
    pub(super) fn global_dir(&self) -> (&Path, &'static [&'static str]) {
        (&self.data_dir, GLOBAL_LAYER)
    }

    /// A camada inteira (`read_layer`); pasta ainda inexistente → camada vazia.
    pub(super) fn read(&self) -> Result<Layer, AppError> {
        let _guard = self.guard();
        let (root, dir) = self.global_dir();
        read_layer(root, dir)
    }

    /// Gravação pedida pelo webview. Sem `expected_sha256` só cria, e só `pessoal.txt` (outro nome
    /// → `PERMISSION_DENIED`; já existe → `ALREADY_EXISTS`). Com ele (64 hex minúsculos), troca
    /// atômica só se o conteúdo atual tiver esse sha256 (senão `CONFLICT`, 0 bytes gravados;
    /// inexistente → `NOT_FOUND`). Nome inválido ou hash malformado → `INVALID_PATH`; texto acima de
    /// 10 MiB → `TOO_LARGE`. Tudo isso é conferido antes de qualquer acesso ao disco.
    pub(super) fn write(
        &self,
        name: &str,
        text: &str,
        expected_sha256: Option<&str>,
    ) -> Result<(), AppError> {
        let name = dictionary_name(name)?;
        let expected = match expected_sha256 {
            None => None,
            Some(given) => {
                Some(super::parse_sha256(given).ok_or_else(|| AppError::new("INVALID_PATH"))?)
            }
        };
        let bytes = text.as_bytes();
        if bytes.len() as u64 > DICTIONARY_MAX_BYTES {
            return Err(too_large(bytes.len() as u64));
        }
        if expected.is_none() && name != PERSONAL {
            return Err(AppError::new("PERMISSION_DENIED"));
        }
        let _guard = self.guard();
        match expected {
            None => self.create_new(name, bytes),
            Some(expected) => self.overwrite(name, bytes, &expected),
        }
    }

    /// Cria `name` (a pasta da camada nasce se faltar) sem seguir link: um link na pasta ou no nome
    /// → `OUTSIDE_VAULT`; nome existente → `ALREADY_EXISTS`. Os bytes vão por um temporário com
    /// `sync_all` e `rename` (`replace::write_new`; AppSec r32a item 4): uma queda no meio nunca
    /// deixa um `pessoal.txt` pela metade, e uma falha não deixa nada.
    fn create_new(&self, name: &str, bytes: &[u8]) -> Result<(), AppError> {
        let (root, dir) = self.global_dir();
        ensure_layer_dir(root, dir)?;
        let segments = [GLOBAL_DIR, name];
        if walk_target(root, &segments)?.is_some() {
            return Err(AppError::new("ALREADY_EXISTS"));
        }
        replace::write_new(&join(root, &segments), bytes)
    }

    /// Troca atômica e condicional (`replace::replace_file`, r26): inexistente → `NOT_FOUND`; link
    /// → `OUTSIDE_VAULT`; o que não é arquivo comum → `INVALID_PATH`.
    fn overwrite(&self, name: &str, bytes: &[u8], expected: &[u8; 32]) -> Result<(), AppError> {
        let segments = [GLOBAL_DIR, name];
        match walk_target(&self.data_dir, &segments)? {
            None => Err(AppError::new("NOT_FOUND")),
            Some(meta) if !meta.is_file() => Err(AppError::new("INVALID_PATH")),
            Some(meta) => replace::replace_file(
                &join(&self.data_dir, &segments),
                &meta,
                Some(DICTIONARY_MAX_BYTES),
                expected,
                bytes,
            ),
        }
    }
}

/// A pasta de uma camada, criada (com as intermediárias) se faltar, sem seguir link: link em
/// qualquer componente abaixo de `root` → `OUTSIDE_VAULT`; algo que não é pasta → `INVALID_PATH`.
pub(super) fn ensure_layer_dir(root: &Path, dir: &[&str]) -> Result<(), AppError> {
    match walk_target(root, dir)? {
        None => fs::create_dir_all(join(root, dir))?,
        Some(meta) if !meta.is_dir() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    Ok(())
}

/// Lê uma camada: os `.txt` de nome válido em `root/<dir…>`, sem seguir link em nenhum componente
/// abaixo de `root` (raiz confiável: os dados do app ou a raiz do vault). Pasta ausente → camada
/// vazia; pasta que é link → `OUTSIDE_VAULT`. Cada arquivo vem com o texto e o sha256 ou com o
/// código do erro dele (link → `OUTSIDE_VAULT`, sem abrir; acima de 10 MiB → `TOO_LARGE`, sem ler;
/// `NOT_UTF8`). A lista para em 16 entradas (as com erro contam: a resposta fica limitada) e em
/// 20 MiB lidos; o resto fica de fora e é contado em `skipped`. Pastas, ocultos, temporários e
/// outras extensões não contam.
pub(super) fn read_layer(root: &Path, dir: &[&str]) -> Result<Layer, AppError> {
    let mut layer = Layer {
        files: Vec::new(),
        skipped: 0,
    };
    match walk_target(root, dir)? {
        None => return Ok(layer),
        Some(meta) if !meta.is_dir() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    let folder = join(root, dir);
    let mut candidates = Vec::new();
    for entry in fs::read_dir(&folder)? {
        if let Some(candidate) = candidate(entry)? {
            candidates.push(candidate);
        }
    }
    candidates.sort_unstable_by(|a, b| layer_order(&a.name, &b.name));
    let mut budget = LAYER_MAX_BYTES;
    for candidate in candidates {
        if layer.files.len() == LAYER_MAX_FILES {
            layer.skipped += 1;
            continue;
        }
        match read_candidate(&folder, candidate, &mut budget) {
            Outcome::File(file) => layer.files.push(file),
            Outcome::OverBudget => layer.skipped += 1,
            Outcome::Vanished => {}
        }
    }
    Ok(layer)
}

/// `pessoal.txt` primeiro; o resto pela ordem dos bytes (UTF-8) do nome, igual em todo SO.
fn layer_order(a: &str, b: &str) -> Ordering {
    (a != PERSONAL).cmp(&(b != PERSONAL)).then_with(|| a.cmp(b))
}

/// Item da pasta que conta como dicionário: nome válido e arquivo comum ou link. O `metadata` do
/// `DirEntry` não segue link (é o do próprio link).
struct Candidate {
    name: String,
    link: bool,
    len: u64,
}

fn candidate(entry: io::Result<fs::DirEntry>) -> Result<Option<Candidate>, AppError> {
    let entry = match entry {
        Ok(entry) => entry,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::io(&e)),
    };
    let Ok(name) = entry.file_name().into_string() else {
        return Ok(None); // nome que não é UTF-8 nunca é um nome de dicionário
    };
    if dictionary_name(&name).is_err() {
        return Ok(None);
    }
    let meta = match entry.metadata() {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::io(&e)),
    };
    let kind = meta.file_type();
    if !kind.is_file() && !kind.is_symlink() {
        return Ok(None);
    }
    Ok(Some(Candidate {
        name,
        link: kind.is_symlink(),
        len: meta.len(),
    }))
}

enum Outcome {
    File(LayerFile),
    /// Passaria dos 20 MiB da camada: fica de fora (`skipped`).
    OverBudget,
    /// Sumiu entre a listagem e a abertura (sincronização): não conta.
    Vanished,
}

/// Lê um candidato com os tetos ANTES de ler (tamanho da listagem) e no arquivo aberto
/// (`read_capped`, sem seguir link), descontando do orçamento da camada.
fn read_candidate(folder: &Path, candidate: Candidate, budget: &mut u64) -> Outcome {
    let Candidate { name, link, len } = candidate;
    if link {
        return Outcome::File(LayerFile::Error {
            name,
            error: "OUTSIDE_VAULT",
        });
    }
    if len > DICTIONARY_MAX_BYTES {
        return Outcome::File(LayerFile::Error {
            name,
            error: "TOO_LARGE",
        });
    }
    if len > *budget {
        return Outcome::OverBudget;
    }
    let read = open_no_follow(&folder.join(&name), OpenOptions::new().read(true))
        .and_then(|file| read_capped(file, Some(DICTIONARY_MAX_BYTES)));
    let bytes = match read {
        Ok(bytes) => bytes,
        Err(error) if error.code == "NOT_FOUND" => return Outcome::Vanished,
        Err(error) => {
            return Outcome::File(LayerFile::Error {
                name,
                error: error.code,
            })
        }
    };
    let size = bytes.len() as u64;
    if size > *budget {
        return Outcome::OverBudget;
    }
    *budget -= size;
    match String::from_utf8(bytes) {
        Ok(text) => {
            let sha256 = hex(&replace::sha256(text.as_bytes()));
            Outcome::File(LayerFile::Text { name, text, sha256 })
        }
        Err(_) => Outcome::File(LayerFile::Error {
            name,
            error: "NOT_UTF8",
        }),
    }
}

/// sha256 em hex minúsculo (o `sha256Hex` do TS e o formato de `expectedSha256`).
fn hex(digest: &[u8; 32]) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Camada global inteira, numa thread de bloqueio (`vault::blocking`). Sem argumentos: o webview
/// não escolhe pasta nem arquivo.
#[tauri::command]
pub async fn dict_global_read(
    state: State<'_, Arc<GlobalDictionaries>>,
) -> Result<Layer, AppError> {
    let global = state.inner().clone();
    let result = blocking(move || global.read()).await;
    // Só contagens e o código: nunca nomes, caminhos ou termos.
    match &result {
        Ok(layer) => {
            let errors = layer
                .files
                .iter()
                .filter(|file| matches!(file, LayerFile::Error { .. }))
                .count();
            println!(
                "dictionaries: global read -> {} arquivo(s), {errors} com erro, {} fora pelos tetos",
                layer.files.len(),
                layer.skipped
            );
        }
        Err(error) => println!("dictionaries: global read -> {}", error.code),
    }
    result
}

/// Grava um arquivo da camada global (`GlobalDictionaries::write`) numa thread de bloqueio
/// (`vault::blocking`): do webview vêm só o nome, o texto e o sha256 da base (`null` = criar, só
/// `pessoal.txt`).
#[tauri::command]
pub async fn dict_global_write(
    state: State<'_, Arc<GlobalDictionaries>>,
    name: String,
    text: String,
    expected_sha256: Option<String>,
) -> Result<(), AppError> {
    let global = state.inner().clone();
    let size = text.len();
    let result = blocking(move || global.write(&name, &text, expected_sha256.as_deref())).await;
    println!(
        "dictionaries: global write ({size} B) -> {}",
        result.as_ref().map_or_else(|error| error.code, |_| "ok")
    );
    result
}

/// `.aff` de um par lido pelo corretor (D-R34-4; o do pt_BR tem 957 KiB).
pub(crate) const PAIR_AFF_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// `.dic` de um par lido pelo corretor (D-R34-4): o teto de um arquivo de dicionário.
pub(crate) const PAIR_DIC_MAX_BYTES: u64 = DICTIONARY_MAX_BYTES;
/// Pares por recarga do corretor, nas duas camadas (D-R34-4).
pub(crate) const ENGINE_MAX_PAIRS: usize = 8;
/// Bytes dos pares por recarga do corretor, nas duas camadas (D-R34-4).
pub(crate) const ENGINE_MAX_PAIR_BYTES: u64 = 24 * 1024 * 1024;
/// Acima disto uma palavra nunca é termo e nem passa pelo NFC: 64 caracteres em NFC não passam de
/// 1 KiB nem decompostos (a decomposição canônica de um caractere tem até 4 pontos de código).
const WORD_MAX_BYTES: usize = 1024;

/// Uma lista Hunspell para o corretor (r34): o `.aff` e o `.dic` de `<camada>/hunspell/<nome>.*`,
/// decodificados pela codificação do `SET` e em NFC. Entrada não confiável (AppSec r33a N5).
pub(crate) struct EnginePair {
    pub(crate) aff: String,
    pub(crate) dic: String,
}

/// O que o corretor lê das camadas do usuário (r34, D-R34-5).
#[derive(Default)]
pub(crate) struct EngineSources {
    /// Os termos v1 das duas camadas em NFC, sem repetidos (por camada, os primeiros 200.000 na
    /// ordem do leitor do app, `buildLayer`).
    pub(crate) terms: Vec<String>,
    /// Os pares das listas visíveis, a camada global antes (até 8 e 24 MiB).
    pub(crate) pairs: Vec<EnginePair>,
    /// Fontes deixadas de fora: camada ilegível, arquivo com erro ou fora dos tetos da camada,
    /// termos além de 200.000 (uma vez por camada) e par recusado na leitura.
    pub(crate) skipped: u32,
}

/// O que ainda cabe de pares numa recarga (D-R34-4).
struct PairBudget {
    pairs: usize,
    bytes: u64,
}

impl GlobalDictionaries {
    /// As fontes do corretor (r34, D-R34-5): a camada global e, com `folder` (a raiz da pasta
    /// aberta), a da pasta, sob a trava dos dicionários — como uma importação ou um renomear as
    /// deixam. Uma camada ilegível conta em `skipped` e o resto segue.
    pub(crate) fn engine_sources(&self, folder: Option<&Path>) -> EngineSources {
        let _guard = self.guard();
        let mut sources = EngineSources::default();
        let mut budget = PairBudget {
            pairs: ENGINE_MAX_PAIRS,
            bytes: ENGINE_MAX_PAIR_BYTES,
        };
        let (root, dir) = self.global_dir();
        let mut terms = engine_layer(root, dir, &mut sources, &mut budget);
        if let Some(root) = folder {
            terms.extend(engine_layer(root, FOLDER_LAYER, &mut sources, &mut budget));
        }
        sources.terms = terms.into_iter().collect();
        sources
    }
}

/// Uma camada para o corretor: os termos (sem repetidos, até 200.000) e os pares das listas lidas.
/// Arquivo com erro (link, acima de 10 MiB, não UTF-8) fica de fora com o par dele; a pasta
/// `hunspell/` que é link (ou não é pasta) conta uma vez e nenhum par da camada entra.
fn engine_layer(
    root: &Path,
    dir: &[&str],
    sources: &mut EngineSources,
    budget: &mut PairBudget,
) -> HashSet<String> {
    let mut terms = HashSet::new();
    let layer = match read_layer(root, dir) {
        Ok(layer) => layer,
        Err(_) => {
            sources.skipped += 1;
            return terms;
        }
    };
    sources.skipped += layer.skipped;
    let mut pair_dir = dir.to_vec();
    pair_dir.push(PAIR_DIR);
    let pairs = match walk_target(root, &pair_dir) {
        Ok(None) => false,
        Ok(Some(meta)) if meta.is_dir() => true,
        _ => {
            sources.skipped += 1;
            false
        }
    };
    let mut full = false;
    for file in &layer.files {
        let LayerFile::Text { name, text, .. } = file else {
            sources.skipped += 1;
            continue;
        };
        if !full && !add_terms(text, &mut terms) {
            full = true;
            sources.skipped += 1;
        }
        if !pairs {
            continue;
        }
        match read_pair(root, dir, &name[..name.len() - ".txt".len()], budget) {
            Ok(Some(pair)) => sources.pairs.push(pair),
            Ok(None) => {}
            Err(()) => sources.skipped += 1,
        }
    }
    terms
}

/// Junta à camada os termos v1 de um `.txt` como o `parseWordList` do app (BOM fora; cada linha em
/// NFC antes da regra), sem repetidos. `false` = a camada chegou a 200.000 e sobrou termo: o resto
/// fica de fora.
fn add_terms(text: &str, terms: &mut HashSet<String>) -> bool {
    let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    for line in body.split('\n') {
        let line = nfc(line);
        let import::Line::Term(term) = import::v1_term(&line) else {
            continue;
        };
        if terms.contains(term) {
            continue;
        }
        if terms.len() == LAYER_MAX_TERMS {
            return false;
        }
        terms.insert(term.to_owned());
    }
    true
}

/// O par da lista `<stem>.txt` (`hunspell/<stem>.aff` + `.dic`): nenhum dos dois → `None`. Um só,
/// link em qualquer componente, o que não é arquivo comum, acima do teto (antes de ler), fora do
/// orçamento da recarga, `SET` sem suporte ou bytes inválidos nele → `Err` (fica de fora).
fn read_pair(
    root: &Path,
    dir: &[&str],
    stem: &str,
    budget: &mut PairBudget,
) -> Result<Option<EnginePair>, ()> {
    let aff_name = format!("{stem}.aff");
    let dic_name = format!("{stem}.dic");
    let aff_size = pair_size(root, dir, &aff_name, PAIR_AFF_MAX_BYTES)?;
    let dic_size = pair_size(root, dir, &dic_name, PAIR_DIC_MAX_BYTES)?;
    let size = match (aff_size, dic_size) {
        (None, None) => return Ok(None),
        (Some(aff), Some(dic)) => aff + dic,
        _ => return Err(()),
    };
    if budget.pairs == 0 || size > budget.bytes {
        return Err(());
    }
    let aff = read_pair_file(root, dir, &aff_name, PAIR_AFF_MAX_BYTES)?;
    let dic = read_pair_file(root, dir, &dic_name, PAIR_DIC_MAX_BYTES)?;
    let read = (aff.len() + dic.len()) as u64;
    if read > budget.bytes {
        return Err(());
    }
    budget.pairs -= 1;
    budget.bytes -= read;
    let declared = import::declared_encoding(&aff).map_err(|_| ())?;
    let (aff, _) = import::decode(&aff, declared).map_err(|_| ())?;
    let (dic, _) = import::decode(&dic, declared).map_err(|_| ())?;
    Ok(Some(EnginePair {
        aff: nfc_owned(aff),
        dic: nfc_owned(dic),
    }))
}

/// O tamanho de `hunspell/<file>` na camada, sem seguir link e sem abrir: ausente → `None`; link em
/// qualquer componente, o que não é arquivo comum ou acima de `cap` → `Err`.
fn pair_size(root: &Path, dir: &[&str], file: &str, cap: u64) -> Result<Option<u64>, ()> {
    let mut segments = dir.to_vec();
    segments.extend([PAIR_DIR, file]);
    match walk_target(root, &segments) {
        Ok(None) => Ok(None),
        Ok(Some(meta)) if meta.is_file() && meta.len() <= cap => Ok(Some(meta.len())),
        _ => Err(()),
    }
}

/// Lê `hunspell/<file>` sem seguir link (`open_no_follow`) e com o teto no arquivo aberto.
fn read_pair_file(root: &Path, dir: &[&str], file: &str, cap: u64) -> Result<Vec<u8>, ()> {
    let mut segments = dir.to_vec();
    segments.extend([PAIR_DIR, file]);
    open_no_follow(&join(root, &segments), OpenOptions::new().read(true))
        .and_then(|file| read_capped(file, Some(cap)))
        .map_err(|_| ())
}

/// NFC (D-R34-6; o `normalize('NFC')` do app), sem cópia quando o texto já está em NFC.
pub(crate) fn nfc(text: &str) -> Cow<'_, str> {
    ComposingNormalizerBorrowed::new_nfc().normalize(text)
}

fn nfc_owned(text: String) -> String {
    let normalized = match nfc(&text) {
        Cow::Owned(normalized) => Some(normalized),
        Cow::Borrowed(_) => None,
    };
    normalized.unwrap_or(text)
}

/// A palavra que o corretor confere (r34), em NFC: um termo v1 inteiro (`import::v1_term`: até 64
/// caracteres, sem espaço, Cc nem Cf, sem `#` no começo), sem espaço nem nas pontas. Fora disso,
/// `None`: a palavra nunca é marcada.
pub(crate) fn checkable_word(word: &str) -> Option<Cow<'_, str>> {
    if word.len() > WORD_MAX_BYTES {
        return None;
    }
    let word = nfc(word);
    let whole =
        matches!(import::v1_term(&word), import::Line::Term(term) if term.len() == word.len());
    whole.then_some(word)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;
    use crate::vault::ops::{self, WriteMode};
    use std::fs::File;
    use std::io::Read;

    const MIB: usize = 1024 * 1024;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    fn sha(bytes: &[u8]) -> String {
        hex(&replace::sha256(bytes))
    }

    fn text(name: &str, text: &str) -> LayerFile {
        LayerFile::Text {
            name: name.to_owned(),
            text: text.to_owned(),
            sha256: sha(text.as_bytes()),
        }
    }

    fn error(name: &str, error: &'static str) -> LayerFile {
        LayerFile::Error {
            name: name.to_owned(),
            error,
        }
    }

    fn names(layer: &Layer) -> Vec<&str> {
        layer
            .files
            .iter()
            .map(|file| match file {
                LayerFile::Text { name, .. } | LayerFile::Error { name, .. } => name.as_str(),
            })
            .collect()
    }

    /// Temporários de gravação que sobraram (listagem crua do SO).
    fn temps(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| replace::is_temp_name(name))
            .collect()
    }

    /// Dados do app de teste: `dictionaries/<nome>` com os arquivos dados.
    fn global_with(files: &[(&str, &[u8])]) -> (TempDir, GlobalDictionaries) {
        let data = TempDir::new();
        for (name, bytes) in files {
            data.put(&format!("{GLOBAL_DIR}/{name}"), bytes);
        }
        let global = GlobalDictionaries::new(data.0.clone());
        (data, global)
    }

    /// AC-R32A-1 (leitura): `pessoal.txt` primeiro e o resto pelos bytes do nome (`Beta.txt` antes
    /// de `alfa.txt`); só `.txt` de nome válido e arquivo comum conta; o texto vem como está (BOM e
    /// CR incluídos); acima de 10 MiB → `TOO_LARGE` e não UTF-8 → `NOT_UTF8`, cada um na sua
    /// entrada, sem derrubar a camada. O fio é `{files:[{name,text,sha256}|{name,error}],skipped}`.
    #[test]
    fn read_orders_personal_first_and_reports_errors_per_file() {
        let big = vec![b'a'; 10 * MIB + 1];
        let (data, global) = global_with(&[
            ("zeta.txt", b"z\n"),
            ("pessoal.txt", b"p\n"),
            ("Beta.txt", b"\xEF\xBB\xBFb\r\n"),
            ("alfa.txt", b"a\n"),
            ("grande.txt", &big),
            ("latin1.txt", b"caf\xe9\n"),
            ("notas.md", b"x"),
            (".oculto.txt", b"x"),
            (".~simplemd-0123456789abcdef.tmp", b"orfao"),
            ("sub/dentro.txt", b"x"),
        ]);
        fs::create_dir(data.0.join("dictionaries/pasta.txt")).unwrap();
        let layer = global.read().unwrap();
        assert_eq!(
            layer,
            Layer {
                files: vec![
                    text("pessoal.txt", "p\n"),
                    text("Beta.txt", "\u{feff}b\r\n"),
                    text("alfa.txt", "a\n"),
                    error("grande.txt", "TOO_LARGE"),
                    error("latin1.txt", "NOT_UTF8"),
                    text("zeta.txt", "z\n"),
                ],
                skipped: 0,
            }
        );
        let wire = serde_json::to_value(&layer).unwrap();
        assert_eq!(
            wire["files"][0],
            serde_json::json!({ "name": "pessoal.txt", "text": "p\n", "sha256": sha(b"p\n") })
        );
        assert_eq!(
            wire["files"][3],
            serde_json::json!({ "name": "grande.txt", "error": "TOO_LARGE" })
        );
        assert_eq!(wire["skipped"], 0);
        // O sha256 é o mesmo do `sha256Hex` do TS (vetor conhecido de "").
        assert_eq!(
            sha(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// Sem pasta (instalação nova), a camada é vazia e nada é criado na leitura.
    #[test]
    fn missing_folder_is_an_empty_layer() {
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.join("ainda-nao-existe"));
        assert_eq!(
            global.read().unwrap(),
            Layer {
                files: vec![],
                skipped: 0
            }
        );
        assert!(!data.0.join("ainda-nao-existe").exists());
    }

    /// D-R32-2: no máximo 16 arquivos por camada; o 17º (na ordem) fica em `skipped`.
    #[test]
    fn read_caps_the_layer_at_16_files() {
        let files: Vec<(String, Vec<u8>)> = (0..17)
            .map(|i| (format!("d{i:02}.txt"), format!("t{i}\n").into_bytes()))
            .collect();
        let refs: Vec<(&str, &[u8])> = files
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect();
        let (_data, global) = global_with(&refs);
        let layer = global.read().unwrap();
        assert_eq!(layer.files.len(), 16);
        assert_eq!(layer.skipped, 1);
        assert_eq!(names(&layer).last(), Some(&"d15.txt"));
    }

    /// D-R32-2: no máximo 20 MiB lidos por camada, contados antes de ler; o arquivo que passaria
    /// do teto fica de fora (`skipped`) e um menor depois dele ainda entra.
    #[test]
    fn read_caps_the_layer_at_20_mib() {
        let seven = vec![b'x'; 7 * MIB];
        let (_data, global) = global_with(&[
            ("pessoal.txt", &seven),
            ("b.txt", &seven),
            ("c.txt", &seven),
            ("d.txt", b"d\n"),
        ]);
        let layer = global.read().unwrap();
        assert_eq!(names(&layer), ["pessoal.txt", "b.txt", "d.txt"]);
        assert_eq!(layer.skipped, 1);
    }

    /// AC-R32A-1 (gravação, D-R32-3): `null` cria só `pessoal.txt` e só uma vez; outro nome nunca
    /// nasce pelo webview, mas um arquivo que já existe é sobrescrito com a base certa.
    #[test]
    fn only_pessoal_is_created_and_only_once() {
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let dir = data.0.join(GLOBAL_DIR);
        global
            .write("pessoal.txt", "colecistectomia\n", None)
            .unwrap();
        assert_eq!(
            fs::read(dir.join("pessoal.txt")).unwrap(),
            b"colecistectomia\n"
        );
        assert_eq!(
            code(global.write("pessoal.txt", "outro\n", None)),
            "ALREADY_EXISTS"
        );
        assert_eq!(
            fs::read(dir.join("pessoal.txt")).unwrap(),
            b"colecistectomia\n"
        );
        assert_eq!(
            code(global.write("medicos.txt", "x\n", None)),
            "PERMISSION_DENIED"
        );
        assert!(!dir.join("medicos.txt").exists());
        data.put("dictionaries/medicos.txt", b"antigo\n");
        global
            .write("medicos.txt", "novo\n", Some(&sha(b"antigo\n")))
            .unwrap();
        assert_eq!(fs::read(dir.join("medicos.txt")).unwrap(), b"novo\n");
        assert_eq!(
            code(global.write("nada.txt", "x\n", Some(&sha(b"")))),
            "NOT_FOUND"
        );
        assert!(!dir.join("nada.txt").exists());
        assert!(temps(&dir).is_empty());
    }

    /// AppSec r32a item 4 (r33): `pessoal.txt` nasce por temporário + `rename`; uma falha em
    /// qualquer etapa não deixa arquivo pela metade nem temporário, e a tentativa seguinte o cria
    /// inteiro.
    #[test]
    fn personal_is_born_through_a_temp_and_a_failure_leaves_nothing() {
        use crate::vault::replace::{Hook, Step};
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let dir = data.0.join(GLOBAL_DIR);
        for step in [Step::Created, Step::Written, Step::Synced, Step::Verified] {
            let _hook = Hook::set(move |at| {
                if at == step {
                    Err(io::Error::other("falha injetada"))
                } else {
                    Ok(())
                }
            });
            assert_eq!(
                code(global.write("pessoal.txt", "colecistectomia\n", None)),
                "IO",
                "{step:?}"
            );
            assert!(!dir.join("pessoal.txt").exists(), "{step:?}");
            assert!(temps(&dir).is_empty(), "{step:?}");
        }
        global
            .write("pessoal.txt", "colecistectomia\n", None)
            .unwrap();
        assert_eq!(
            fs::read(dir.join("pessoal.txt")).unwrap(),
            b"colecistectomia\n"
        );
        assert!(temps(&dir).is_empty());
    }

    /// AC-R32A-1 (r26): a sobrescrita troca o arquivo (quem o tinha aberto continua com a versão
    /// antiga inteira); base errada → `CONFLICT` sem tocar o disco (bytes e mtime iguais); bytes
    /// iguais aos do disco não mudam nada. Nenhum temporário sobra.
    #[test]
    fn overwrite_is_conditional_and_atomic() {
        let (data, global) = global_with(&[("pessoal.txt", b"base\n")]);
        let path = data.0.join("dictionaries/pessoal.txt");
        let mut old = File::open(&path).unwrap();
        global
            .write("pessoal.txt", "base\nnovo\n", Some(&sha(b"base\n")))
            .unwrap();
        let mut before = Vec::new();
        old.read_to_end(&mut before).unwrap();
        assert_eq!(before, b"base\n");
        assert_eq!(fs::read(&path).unwrap(), b"base\nnovo\n");

        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(
            code(global.write("pessoal.txt", "do app\n", Some(&sha(b"base\n")))),
            "CONFLICT"
        );
        assert_eq!(fs::read(&path).unwrap(), b"base\nnovo\n");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);

        global
            .write("pessoal.txt", "base\nnovo\n", Some(&sha(b"base\nnovo\n")))
            .unwrap();
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
        assert!(temps(&data.0.join(GLOBAL_DIR)).is_empty());
    }

    /// A trava serializa conferência e troca: 8 gravações com a mesma base → exatamente 1 vale e as
    /// outras 7 viram `CONFLICT` (nunca duas trocas sobre a mesma base).
    #[test]
    fn concurrent_writes_with_the_same_base_conflict() {
        let (data, global) = global_with(&[("pessoal.txt", b"base\n")]);
        let global = Arc::new(global);
        let base = sha(b"base\n");
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let global = Arc::clone(&global);
                let base = base.clone();
                std::thread::spawn(move || {
                    code(global.write("pessoal.txt", &format!("base\nt{i}\n"), Some(&base)))
                })
            })
            .collect();
        let mut codes: Vec<&str> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        codes.sort_unstable();
        assert_eq!(
            codes,
            ["CONFLICT"; 7]
                .iter()
                .copied()
                .chain(["OK"])
                .collect::<Vec<_>>()
        );
        assert!(temps(&data.0.join(GLOBAL_DIR)).is_empty());
    }

    /// AC-R32A-1: nome inválido, hash malformado e texto acima de 10 MiB são recusados antes de
    /// qualquer acesso ao disco (nem a pasta da camada nasce); 10 MiB exatos passam.
    #[test]
    fn invalid_names_hashes_and_oversize_are_refused_before_the_disk() {
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let base = sha(b"");
        for name in [
            "",
            "pessoal",
            "pessoal.md",
            "a/pessoal.txt",
            "../pessoal.txt",
            "/tmp/pessoal.txt",
            ".pessoal.txt",
            "pessoal.txt.",
            "a\\pessoal.txt",
            "con.txt",
        ] {
            for expected in [None, Some(base.as_str())] {
                assert_eq!(
                    code(global.write(name, "x\n", expected)),
                    "INVALID_PATH",
                    "{name:?} {expected:?}"
                );
            }
        }
        let upper = base.to_ascii_uppercase();
        let long = format!("{base}0");
        for hash in [upper.as_str(), &base[..63], long.as_str(), "", "não-hex"] {
            assert_eq!(
                code(global.write("pessoal.txt", "x\n", Some(hash))),
                "INVALID_PATH",
                "{hash:?}"
            );
        }
        let over = "a".repeat(10 * MIB + 1);
        for expected in [None, Some(base.as_str())] {
            let error = global.write("pessoal.txt", &over, expected).unwrap_err();
            assert_eq!(error.code, "TOO_LARGE");
            assert_eq!(
                error.detail,
                Some(serde_json::json!({ "size": 10 * MIB + 1 }))
            );
        }
        assert!(!data.0.join(GLOBAL_DIR).exists(), "nada tocou o disco");
        global
            .write("pessoal.txt", &"a".repeat(10 * MIB), None)
            .unwrap();
        assert_eq!(
            fs::metadata(data.0.join("dictionaries/pessoal.txt"))
                .unwrap()
                .len(),
            10 * MIB as u64
        );
    }

    /// "Erros sem caminho": a resposta serializada nunca leva o caminho dos dados do app.
    #[test]
    fn errors_never_carry_the_path() {
        let (data, global) = global_with(&[("pessoal.txt", b"base\n")]);
        let root = data.0.to_str().unwrap().to_owned();
        for result in [
            global.write("pessoal.txt", "x", None),
            global.write("pessoal.txt", "x", Some(&sha(b"outra"))),
            global.write("nada.txt", "x", Some(&sha(b""))),
            global.write("../x.txt", "x", None),
        ] {
            let wire = serde_json::to_string(&result.unwrap_err()).unwrap();
            assert!(!wire.contains(&root), "{wire}");
            assert!(!wire.contains("dictionaries"), "{wire}");
        }
    }

    /// AC-R32A-1 (link): um link no lugar de um dicionário vira a entrada `OUTSIDE_VAULT` (sem ser
    /// aberto) e nunca é gravado; a pasta da camada como link recusa a camada inteira. Nada de fora
    /// é lido nem gravado.
    #[cfg(unix)]
    #[test]
    fn links_are_refused_in_the_name_and_in_the_folder() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new();
        outside.put("segredo.txt", b"fora\n");
        outside.put("pasta/pessoal.txt", b"fora\n");
        let (data, global) = global_with(&[("a.txt", b"a\n")]);
        let link = data.0.join("dictionaries/pessoal.txt");
        symlink(outside.0.join("segredo.txt"), &link).unwrap();
        assert_eq!(
            global.read().unwrap().files,
            vec![error("pessoal.txt", "OUTSIDE_VAULT"), text("a.txt", "a\n")]
        );
        for expected in [None, Some(sha(b"fora\n"))] {
            assert_eq!(
                code(global.write("pessoal.txt", "app\n", expected.as_deref())),
                "OUTSIDE_VAULT"
            );
        }
        assert_eq!(fs::read(outside.0.join("segredo.txt")).unwrap(), b"fora\n");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());

        fs::remove_dir_all(data.0.join(GLOBAL_DIR)).unwrap();
        symlink(outside.0.join("pasta"), data.0.join(GLOBAL_DIR)).unwrap();
        assert_eq!(code(global.read()), "OUTSIDE_VAULT");
        for expected in [None, Some(sha(b"fora\n"))] {
            assert_eq!(
                code(global.write("pessoal.txt", "app\n", expected.as_deref())),
                "OUTSIDE_VAULT"
            );
        }
        assert_eq!(
            fs::read(outside.0.join("pasta/pessoal.txt")).unwrap(),
            b"fora\n"
        );
        assert_eq!(fs::read_dir(outside.0.join("pasta")).unwrap().count(), 1);
    }

    /// Windows (TA-R2-10): a pasta da camada como junção é recusada na leitura e na gravação; nada é
    /// escrito na pasta de fora.
    #[cfg(windows)]
    #[test]
    fn junction_as_the_layer_folder_is_refused() {
        use std::process::Command;
        let outside = TempDir::new();
        outside.put("pessoal.txt", b"fora\n");
        let data = TempDir::new();
        let junction = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(data.0.join(GLOBAL_DIR))
            .arg(&outside.0)
            .status()
            .unwrap();
        assert!(junction.success());
        let global = GlobalDictionaries::new(data.0.clone());
        assert_eq!(code(global.read()), "OUTSIDE_VAULT");
        assert_eq!(
            code(global.write("pessoal.txt", "app\n", Some(&sha(b"fora\n")))),
            "OUTSIDE_VAULT"
        );
        assert_eq!(fs::read(outside.0.join("pessoal.txt")).unwrap(), b"fora\n");
        assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
    }

    /// AC-R32A-2 no gateway: a classe `.simplemd/dictionaries/<nome>.txt` lê, cria e troca com o
    /// teto de 10 MiB; a pasta pode ser criada e listada; subpasta e outra extensão continuam fora.
    /// O leitor de camada serve à pasta também (r34), com o mesmo percurso sem link.
    #[test]
    fn folder_class_goes_through_the_gateway_and_the_layer_reader() {
        let v = TempDir::new();
        ops::mkdir(&v.0, ".simplemd/dictionaries").unwrap();
        ops::write_file(
            &v.0,
            ".simplemd/dictionaries/medicos.txt",
            b"colecistectomia\n",
            WriteMode::CreateNew,
        )
        .unwrap();
        ops::write_file(
            &v.0,
            ".simplemd/dictionaries/medicos.txt",
            "colecistectomia\nexceção\n".as_bytes(),
            ops::tests::overwrite(b"colecistectomia\n"),
        )
        .unwrap();
        assert_eq!(
            ops::read_file(&v.0, ".simplemd/dictionaries/medicos.txt").unwrap(),
            "colecistectomia\nexceção\n".as_bytes()
        );
        let listed: Vec<String> = ops::read_dir(&v.0, ".simplemd/dictionaries")
            .unwrap()
            .into_iter()
            .map(|item| item.name)
            .collect();
        assert_eq!(listed, ["medicos.txt"]);
        v.put(
            ".simplemd/dictionaries/grande.txt",
            &vec![b'a'; 10 * MIB + 1],
        );
        assert_eq!(
            code(ops::read_file(&v.0, ".simplemd/dictionaries/grande.txt")),
            "TOO_LARGE"
        );
        for rel in [
            ".simplemd/dictionaries/sub/x.txt",
            ".simplemd/dictionaries/x.md",
        ] {
            assert_eq!(
                code(ops::write_file(&v.0, rel, b"x", WriteMode::CreateNew)),
                "PERMISSION_DENIED",
                "{rel}"
            );
        }
        let layer = read_layer(&v.0, &[".simplemd", "dictionaries"]).unwrap();
        assert_eq!(
            layer.files,
            vec![
                error("grande.txt", "TOO_LARGE"),
                text("medicos.txt", "colecistectomia\nexceção\n"),
            ]
        );
        #[cfg(unix)]
        {
            let elsewhere = TempDir::new();
            elsewhere.put("dictionaries/x.txt", b"fora\n");
            let w = TempDir::new();
            std::os::unix::fs::symlink(&elsewhere.0, w.0.join(".simplemd")).unwrap();
            assert_eq!(
                code(read_layer(&w.0, &[".simplemd", "dictionaries"])),
                "OUTSIDE_VAULT"
            );
        }
    }
}
