//! Importar uma lista de termos para uma camada do dicionário (r33, D-R33-1..7; design-r33 §1, §3).
//!
//! `dict_import` abre o diálogo nativo pelo Rust — o webview nunca recebe nem envia um caminho —,
//! lê um `.txt` (um termo por linha) ou um `.dic` do Hunspell (com o `.aff` ao lado, se houver) e
//! grava a lista convertida em `<camada>/<nome>.txt`, no formato v1 (UTF-8, LF). A fonte não é
//! confiável: link recusado (`SYMLINK`, também no `.aff`), 10 MiB no arquivo aberto e de novo
//! depois da conversão (`TOO_LARGE`), NUL → `NOT_TEXT`, a codificação do `SET` do `.aff`
//! (`UNSUPPORTED_ENCODING`, `BAD_ENCODING`), os tetos da camada antes de gravar (`LAYER_FULL`) e
//! uma importação por vez (`BUSY`). O nome é o slug ASCII do arquivo, com `-2`…`-99` (D-R33-2);
//! nada é sobrescrito (fora a corrida com outro programa aceita em D-R33-5: `replace::write_new`).
//! Cada arquivo nasce por temporário + `rename` sob a trava dos dicionários (D-R33-5); com `.dic` +
//! `.aff`, os bytes originais ficam em `<camada>/hunspell/<nome>.dic|.aff` para o corretor
//! (D-R33-6). A fonte e o `.aff` abrem sem esperar (um FIFO é recusado na hora). `dict_manage`
//! renomeia ou remove uma lista, com o par, e nunca o `pessoal.txt` — em caixa Unicode nenhuma, e
//! só pelo nome exato da listagem (`PROTECTED`, D-R33-7; AppSec r33a N1).
//!
//! Para a r34 (D-R34-5), o decodificador (`declared_encoding`, `decode`) e o parser dos termos
//! (`v1_term`, `dic_word`, `parse_terms`) ficam visíveis ao módulo pai. Sem NFC no Rust (D-R33-3):
//! numa lista em NFD, a contagem pode passar da que o leitor do app (NFC) vê. Logs só com contagens
//! e códigos: nunca nomes, caminhos ou termos.

use std::collections::HashSet;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::{
    candidate, ensure_layer_dir, read_layer, GlobalDictionaries, LayerFile, FOLDER_LAYER,
    LAYER_MAX_BYTES, LAYER_MAX_FILES, LAYER_MAX_TERMS, PAIR_DIR, PERSONAL,
};
use crate::error::AppError;
#[cfg(not(unix))]
use crate::vault::ops::open_no_follow;
use crate::vault::ops::{join, read_capped, walk_target};
use crate::vault::policy::{dictionary_name, is_format_char, DICTIONARY_MAX_BYTES};
use crate::vault::{blocking, replace, VaultState};

/// Caracteres de um termo do formato v1 (r32).
const TERM_MAX_CHARS: usize = 64;
/// Tamanho do slug, sem o sufixo de colisão (D-R33-2).
const SLUG_MAX: usize = 48;
/// O nome de uma lista cujo arquivo não deixa slug (ou deixa um nome reservado).
const FALLBACK_SLUG: &str = "importado";
/// O slug `pessoal` vira este: o `pessoal.txt` é do app.
const PERSONAL_SLUG: &str = "pessoal-importado";
/// Sufixos de colisão: `-2` … `-99`.
const MAX_SUFFIX: u32 = 99;
/// Caracteres do nome do arquivo no cabeçalho da lista.
const HEADER_NAME_MAX: usize = 128;
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// Camada de destino. Do webview vêm só ela, o token da pasta e nomes de lista validados.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LayerKind {
    Global,
    Folder,
}

impl LayerKind {
    fn label(self) -> &'static str {
        match self {
            LayerKind::Global => "global",
            LayerKind::Folder => "pasta",
        }
    }
}

/// `dict_manage`: renomear a lista (`to` = o nome novo, `<nome>.txt`) ou removê-la.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ManageAction {
    Rename { to: String },
    Remove,
}

/// Resultado de `dict_import`: o nome do arquivo criado, as contagens, a codificação lida e se o
/// par `.dic`/`.aff` ficou guardado. Nenhum caminho.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Imported {
    pub name: String,
    pub words: u32,
    pub discarded: u32,
    pub encoding: &'static str,
    pub pair: bool,
}

/// Codificação em que a fonte foi lida.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Latin1,
    Latin9,
    Windows1252,
}

impl Encoding {
    pub(super) fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf16Le => "UTF-16LE",
            Encoding::Utf16Be => "UTF-16BE",
            Encoding::Latin1 => "ISO-8859-1",
            Encoding::Latin9 => "ISO-8859-15",
            Encoding::Windows1252 => "Windows-1252",
        }
    }
}

/// Formato da fonte: um termo por linha (`.txt`) ou dicionário Hunspell (`.dic`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Format {
    Txt,
    Dic,
}

/// Uma linha da fonte: fora da contagem (vazia ou comentário), termo ou descartada.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Line<'a> {
    Skip,
    Invalid,
    Term(&'a str),
}

/// O arquivo escolhido, lido com os tetos: o nome base (slug e mensagens), o formato, os bytes e,
/// num `.dic`, o `.aff` ao lado.
pub(super) struct Source {
    file_name: String,
    format: Format,
    bytes: Vec<u8>,
    aff: Option<Vec<u8>>,
}

/// A lista pronta para gravar: o slug, o texto do `.txt`, os termos (para os tetos da camada), as
/// contagens, a codificação e, com `.dic` + `.aff`, os bytes originais do par.
pub(super) struct List {
    slug: String,
    text: String,
    terms: Vec<String>,
    discarded: u32,
    encoding: Encoding,
    pair: Option<(Vec<u8>, Vec<u8>)>,
}

/// Uma importação por vez, do diálogo à gravação (`BUSY`); solta no `drop`, também quando o comando
/// é abandonado no meio.
struct Busy(Arc<GlobalDictionaries>);

impl Busy {
    fn take(global: &Arc<GlobalDictionaries>) -> Result<Self, AppError> {
        if global.importing.swap(true, Ordering::SeqCst) {
            return Err(AppError::new("BUSY"));
        }
        Ok(Self(Arc::clone(global)))
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.importing.store(false, Ordering::SeqCst);
    }
}

impl GlobalDictionaries {
    /// Grava a lista na camada global, sob a trava dos dicionários.
    fn import_global(&self, list: &List) -> Result<Imported, AppError> {
        let _guard = self.guard();
        let (root, dir) = self.global_dir();
        write_list(root, dir, list)
    }

    /// Grava a lista na camada da pasta aberta (`root`, a raiz do token), sob a mesma trava.
    fn import_folder(&self, root: &Path, list: &List) -> Result<Imported, AppError> {
        let _guard = self.guard();
        write_list(root, FOLDER_LAYER, list)
    }

    fn manage_global(&self, manage: &Manage) -> Result<(), AppError> {
        let _guard = self.guard();
        let (root, dir) = self.global_dir();
        manage_in(root, dir, manage)
    }

    fn manage_folder(&self, root: &Path, manage: &Manage) -> Result<(), AppError> {
        let _guard = self.guard();
        manage_in(root, FOLDER_LAYER, manage)
    }
}

/// O token da camada `folder`, conferido sem ativar a pendente (`VaultState::check`) antes do
/// diálogo e do disco: sem token → `NO_VAULT`. A camada global não usa token.
fn folder_token(
    vault: &VaultState,
    layer: LayerKind,
    token: Option<u32>,
) -> Result<Option<u32>, AppError> {
    match layer {
        LayerKind::Global => Ok(None),
        LayerKind::Folder => {
            let token = token.ok_or_else(|| AppError::new("NO_VAULT"))?;
            vault.check(token)?;
            Ok(Some(token))
        }
    }
}

/// Importa uma lista de termos para a camada (`global` ou `folder` com o token da pasta). O diálogo,
/// a leitura e a gravação rodam em threads de bloqueio (`vault::blocking`, `with_root`). Cancelar →
/// `null`; sucesso → `{ name, words, discarded, encoding, pair }`.
#[tauri::command]
pub async fn dict_import(
    app: AppHandle,
    global: State<'_, Arc<GlobalDictionaries>>,
    vault: State<'_, VaultState>,
    layer: LayerKind,
    token: Option<u32>,
) -> Result<Option<Imported>, AppError> {
    let global = global.inner().clone();
    let vault = vault.inner().clone();
    let token = folder_token(&vault, layer, token)?;
    let busy = Busy::take(&global)?;
    let picked = blocking(move || match pick_list(&app)? {
        None => Ok(None),
        Some(path) => read_list(&path).map(Some),
    })
    .await;
    let result = match (picked, token) {
        (Err(error), _) => Err(error),
        (Ok(None), _) => Ok(None),
        (Ok(Some(list)), None) => blocking(move || global.import_global(&list))
            .await
            .map(Some),
        (Ok(Some(list)), Some(token)) => vault
            .with_root(token, move |root| global.import_folder(root, &list))
            .await
            .map(Some),
    };
    drop(busy);
    // Só contagens, a codificação e o código: nunca nomes, caminhos ou termos.
    match &result {
        Ok(Some(imported)) => println!(
            "dictionaries: import ({}) -> ok: {} termo(s), {} descartado(s), {}, par {}",
            layer.label(),
            imported.words,
            imported.discarded,
            imported.encoding,
            imported.pair
        ),
        Ok(None) => println!("dictionaries: import ({}) -> cancelado", layer.label()),
        Err(error) => println!("dictionaries: import ({}) -> {}", layer.label(), error.code),
    }
    result
}

/// Renomeia ou remove uma lista da camada (com o par, se houver). `name` e `to` são validados
/// antes do disco (`INVALID_NAME`; `pessoal.txt` → `PROTECTED`); depois, sob a trava:
/// inexistente → `NOT_FOUND`, destino ocupado → `ALREADY_EXISTS`, link → `OUTSIDE_VAULT`.
#[tauri::command]
pub async fn dict_manage(
    global: State<'_, Arc<GlobalDictionaries>>,
    vault: State<'_, VaultState>,
    layer: LayerKind,
    token: Option<u32>,
    name: String,
    action: ManageAction,
) -> Result<(), AppError> {
    let global = global.inner().clone();
    let vault = vault.inner().clone();
    let token = folder_token(&vault, layer, token)?;
    let manage = Manage::new(name, action)?;
    let kind = manage.kind();
    let result = match token {
        None => blocking(move || global.manage_global(&manage)).await,
        Some(token) => {
            vault
                .with_root(token, move |root| global.manage_folder(root, &manage))
                .await
        }
    };
    println!(
        "dictionaries: manage {kind} ({}) -> {}",
        layer.label(),
        result.as_ref().map_or_else(|error| error.code, |_| "ok")
    );
    result
}

/// O diálogo nativo "Importar lista de termos" (`.txt` ou `.dic`), com a janela principal de mãe.
/// Cancelar → `None`.
fn pick_list(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
    let builder = app
        .dialog()
        .file()
        .set_title("Importar lista de termos")
        .add_filter(
            "Lista de termos (.txt) ou dicionário Hunspell (.dic)",
            &["txt", "dic"],
        );
    let builder = match app.get_webview_window(crate::MAIN) {
        Some(window) => builder.set_parent(&window),
        None => builder,
    };
    let Some(picked) = builder.blocking_pick_file() else {
        return Ok(None);
    };
    picked
        .into_path()
        .map(Some)
        .map_err(|_| AppError::new("INVALID_PATH"))
}

/// Lê e converte o arquivo escolhido.
fn read_list(path: &Path) -> Result<List, AppError> {
    convert(read_source(path)?)
}

/// Lê a fonte com os tetos: `.txt` ou `.dic` (sem diferença de caixa; outra extensão →
/// `UNSUPPORTED_TYPE`) e, num `.dic`, o `.aff` de mesmo nome ao lado, se houver.
pub(super) fn read_source(path: &Path) -> Result<Source, AppError> {
    let file_name = base_name(path);
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    let format = match extension.as_deref() {
        Some("txt") => Format::Txt,
        Some("dic") => Format::Dic,
        _ => return Err(AppError::new("UNSUPPORTED_TYPE")),
    };
    let bytes = read_picked(path, &file_name)?;
    let aff = match format {
        Format::Txt => None,
        Format::Dic => read_aff(path)?,
    };
    Ok(Source {
        file_name,
        format,
        bytes,
        aff,
    })
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Lê um arquivo escolhido sem seguir link: o próprio arquivo como link → `SYMLINK`; o que não é
/// arquivo comum → `INVALID_PATH` (conferido antes de abrir e de novo no arquivo aberto, que nunca
/// espera: `open_picked`); acima de 10 MiB → `TOO_LARGE { fileName, size, max }`, com o teto
/// conferido no arquivo aberto e nada além dele lido.
fn read_picked(path: &Path, file_name: &str) -> Result<Vec<u8>, AppError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(AppError::new("SYMLINK"));
    }
    if !meta.is_file() {
        return Err(AppError::new("INVALID_PATH"));
    }
    read_capped(open_picked(path)?, Some(DICTIONARY_MAX_BYTES)).map_err(|error| {
        if error.code != "TOO_LARGE" {
            return error;
        }
        let size = error
            .detail
            .as_ref()
            .and_then(|detail| detail["size"].as_u64())
            .unwrap_or(DICTIONARY_MAX_BYTES + 1);
        too_large(file_name, size)
    })
}

/// Abre a fonte (ou o `.aff`) sem seguir link e sem esperar (AppSec r33a N2): no Unix,
/// `O_NOFOLLOW | O_NONBLOCK`, e o que foi aberto precisa ser arquivo comum (`fstat`), senão
/// `INVALID_PATH`. Um FIFO trocado depois do `symlink_metadata` abre na hora e é recusado, sem
/// prender a thread nem o `Busy`. Num arquivo comum o `O_NONBLOCK` não muda nada e a leitura segue
/// normal. Link → `SYMLINK`. No Windows, a abertura do vault (`open_no_follow`): lá não há FIFO numa
/// pasta.
fn open_picked(path: &Path) -> Result<File, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|error| match error.raw_os_error() {
                Some(libc::ELOOP) => AppError::new("SYMLINK"),
                _ => AppError::io(&error),
            })?;
        if !file.metadata()?.is_file() {
            return Err(AppError::new("INVALID_PATH"));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    open_no_follow(path, OpenOptions::new().read(true)).map_err(|error| {
        if error.code == "OUTSIDE_VAULT" {
            AppError::new("SYMLINK")
        } else {
            error
        }
    })
}

/// `TOO_LARGE` com o nome base do arquivo, o tamanho e o teto (o webview monta a mensagem).
fn too_large(file_name: &str, size: u64) -> AppError {
    AppError::new("TOO_LARGE").with_detail(serde_json::json!({
        "fileName": file_name,
        "size": size,
        "max": DICTIONARY_MAX_BYTES,
    }))
}

/// O `.aff` de mesmo nome do `.dic`, com a caixa da extensão acompanhando a do `.dic` letra a letra
/// (`.Dic` → `.Aff`, `.DIC` → `.AFF`) e, se ele faltar, `.aff` e `.AFF` (num FS sensível a caixa):
/// nenhum → `None`; o primeiro que existe decide: não é arquivo comum → `None`; link → `SYMLINK`;
/// o resto como o `.dic`.
fn read_aff(dic: &Path) -> Result<Option<Vec<u8>>, AppError> {
    let extension = dic
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("dic");
    let matching: String = extension
        .chars()
        .zip("aff".chars())
        .map(|(d, a)| {
            if d.is_ascii_uppercase() {
                a.to_ascii_uppercase()
            } else {
                a
            }
        })
        .collect();
    let mut tried: Vec<&str> = Vec::with_capacity(3);
    for candidate in [matching.as_str(), "aff", "AFF"] {
        if tried.contains(&candidate) {
            continue;
        }
        tried.push(candidate);
        let path = dic.with_extension(candidate);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(AppError::io(&error)),
            Ok(meta) if meta.file_type().is_symlink() => return Err(AppError::new("SYMLINK")),
            Ok(meta) if !meta.is_file() => return Ok(None),
            Ok(_) => return read_picked(&path, &base_name(&path)).map(Some),
        }
    }
    Ok(None)
}

/// Converte a fonte: decodifica, tira os termos (uma lista com mais de 200.000 não cabe numa
/// camada → `LAYER_FULL`; nenhum → `EMPTY`) e monta o `.txt`, que também não passa de 10 MiB
/// (`TOO_LARGE`). O par fica com os bytes originais só com `.dic` + `.aff` (D-R33-6).
pub(super) fn convert(source: Source) -> Result<List, AppError> {
    let declared = match &source.aff {
        Some(aff) => declared_encoding(aff)?,
        None => None,
    };
    let (text, encoding) = decode(&source.bytes, declared)?;
    let (terms, discarded) = parse_terms(source.format, &text, LAYER_MAX_TERMS)
        .ok_or_else(|| AppError::new("LAYER_FULL"))?;
    if terms.is_empty() {
        return Err(AppError::new("EMPTY"));
    }
    let text = list_text(&source.file_name, &terms, today());
    if text.len() as u64 > DICTIONARY_MAX_BYTES {
        return Err(too_large(&source.file_name, text.len() as u64));
    }
    let pair = match (source.format, source.aff) {
        (Format::Dic, Some(aff)) => Some((source.bytes, aff)),
        _ => None,
    };
    Ok(List {
        slug: slug(&source.file_name),
        text,
        terms,
        discarded,
        encoding,
        pair,
    })
}

/// A codificação do `SET` do `.aff` (a primeira linha `SET <nome>`): `UTF-8`, `ISO8859-1`,
/// `ISO8859-15` ou `microsoft-cp1252`, sem diferença de caixa, `-` e `_`; sem `SET` → `None`;
/// outra → `UNSUPPORTED_ENCODING { encoding }` (o nome só com `[A-Za-z0-9._-]`, até 32).
pub(super) fn declared_encoding(aff: &[u8]) -> Result<Option<Encoding>, AppError> {
    let body = aff.strip_prefix(UTF8_BOM).unwrap_or(aff);
    for line in body.split(|&byte| byte == b'\n') {
        let Some(rest) = line.trim_ascii_start().strip_prefix(b"SET") else {
            continue;
        };
        if !rest
            .first()
            .is_some_and(|&byte| byte == b' ' || byte == b'\t')
        {
            continue;
        }
        let name: Vec<u8> = rest
            .trim_ascii_start()
            .iter()
            .copied()
            .take_while(|byte| !byte.is_ascii_whitespace())
            .collect();
        if name.is_empty() {
            continue;
        }
        let key: Vec<u8> = name
            .iter()
            .filter(|&&byte| byte != b'-' && byte != b'_')
            .map(u8::to_ascii_uppercase)
            .collect();
        return match key.as_slice() {
            b"UTF8" => Ok(Some(Encoding::Utf8)),
            b"ISO88591" => Ok(Some(Encoding::Latin1)),
            b"ISO885915" => Ok(Some(Encoding::Latin9)),
            b"MICROSOFTCP1252" | b"CP1252" | b"WINDOWS1252" => Ok(Some(Encoding::Windows1252)),
            _ => {
                let shown: String = String::from_utf8_lossy(&name)
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
                    .take(32)
                    .collect();
                Err(AppError::new("UNSUPPORTED_ENCODING")
                    .with_detail(serde_json::json!({ "encoding": shown })))
            }
        };
    }
    Ok(None)
}

/// Bytes → texto. O BOM manda (UTF-8 sai; UTF-16 LE/BE é decodificado), acima do `SET`; sem BOM, um
/// byte NUL → `NOT_TEXT` e a declarada decide (inválido nela → `BAD_ENCODING`); sem declarada,
/// UTF-8 se for válido, senão Windows-1252. NUL no texto decodificado → `NOT_TEXT`.
pub(super) fn decode(
    bytes: &[u8],
    declared: Option<Encoding>,
) -> Result<(String, Encoding), AppError> {
    let (text, encoding) = if let Some(body) = bytes.strip_prefix(UTF8_BOM) {
        (utf8(body)?, Encoding::Utf8)
    } else if let Some(body) = bytes.strip_prefix(b"\xFF\xFE") {
        (utf16(body, Encoding::Utf16Le)?, Encoding::Utf16Le)
    } else if let Some(body) = bytes.strip_prefix(b"\xFE\xFF") {
        (utf16(body, Encoding::Utf16Be)?, Encoding::Utf16Be)
    } else if bytes.contains(&0) {
        return Err(AppError::new("NOT_TEXT"));
    } else {
        match declared {
            Some(Encoding::Utf8) => (utf8(bytes)?, Encoding::Utf8),
            Some(Encoding::Latin1) => (
                bytes.iter().map(|&b| char::from(b)).collect(),
                Encoding::Latin1,
            ),
            Some(Encoding::Latin9) => {
                (bytes.iter().map(|&b| latin9(b)).collect(), Encoding::Latin9)
            }
            Some(Encoding::Windows1252) => (windows_1252(bytes, true)?, Encoding::Windows1252),
            // O `SET` nunca declara UTF-16 (`declared_encoding`): o caso cai na detecção.
            Some(Encoding::Utf16Le | Encoding::Utf16Be) | None => {
                match std::str::from_utf8(bytes) {
                    Ok(text) => (text.to_owned(), Encoding::Utf8),
                    Err(_) => (windows_1252(bytes, false)?, Encoding::Windows1252),
                }
            }
        }
    };
    if text.contains('\0') {
        return Err(AppError::new("NOT_TEXT"));
    }
    Ok((text, encoding))
}

fn bad_encoding(encoding: Encoding) -> AppError {
    AppError::new("BAD_ENCODING").with_detail(serde_json::json!({ "encoding": encoding.label() }))
}

fn utf8(bytes: &[u8]) -> Result<String, AppError> {
    String::from_utf8(bytes.to_vec()).map_err(|_| bad_encoding(Encoding::Utf8))
}

/// UTF-16 sem o BOM: número ímpar de bytes ou substituto sem par → `BAD_ENCODING`.
fn utf16(bytes: &[u8], encoding: Encoding) -> Result<String, AppError> {
    let (units, rest) = bytes.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(bad_encoding(encoding));
    }
    let unit = |pair: &[u8; 2]| match encoding {
        Encoding::Utf16Be => u16::from_be_bytes(*pair),
        _ => u16::from_le_bytes(*pair),
    };
    char::decode_utf16(units.iter().map(unit))
        .collect::<Result<String, _>>()
        .map_err(|_| bad_encoding(encoding))
}

/// ISO-8859-15: a ISO-8859-1 com 8 posições trocadas (€, Š, š, Ž, ž, Œ, œ, Ÿ).
fn latin9(byte: u8) -> char {
    match byte {
        0xA4 => '\u{20AC}',
        0xA6 => '\u{160}',
        0xA8 => '\u{161}',
        0xB4 => '\u{17D}',
        0xB8 => '\u{17E}',
        0xBC => '\u{152}',
        0xBD => '\u{153}',
        0xBE => '\u{178}',
        _ => char::from(byte),
    }
}

/// 0x80–0x9F da Windows-1252; os 5 indefinidos (0x81, 0x8D, 0x8F, 0x90, 0x9D) são `None`.
const CP1252_HIGH: [Option<char>; 32] = [
    Some('\u{20AC}'),
    None,
    Some('\u{201A}'),
    Some('\u{192}'),
    Some('\u{201E}'),
    Some('\u{2026}'),
    Some('\u{2020}'),
    Some('\u{2021}'),
    Some('\u{2C6}'),
    Some('\u{2030}'),
    Some('\u{160}'),
    Some('\u{2039}'),
    Some('\u{152}'),
    None,
    Some('\u{17D}'),
    None,
    None,
    Some('\u{2018}'),
    Some('\u{2019}'),
    Some('\u{201C}'),
    Some('\u{201D}'),
    Some('\u{2022}'),
    Some('\u{2013}'),
    Some('\u{2014}'),
    Some('\u{2DC}'),
    Some('\u{2122}'),
    Some('\u{161}'),
    Some('\u{203A}'),
    Some('\u{153}'),
    None,
    Some('\u{17E}'),
    Some('\u{178}'),
];

/// Windows-1252. Declarada (`strict`), um byte indefinido → `BAD_ENCODING`; na recaída sem `SET`,
/// ele vira o controle C1 de mesmo número (como no `TextDecoder` do navegador), que nenhum termo
/// aceita.
fn windows_1252(bytes: &[u8], strict: bool) -> Result<String, AppError> {
    bytes
        .iter()
        .map(|&byte| match byte {
            0x80..=0x9F => match CP1252_HIGH[usize::from(byte - 0x80)] {
                Some(c) => Ok(c),
                None if strict => Err(bad_encoding(Encoding::Windows1252)),
                None => Ok(char::from(byte)),
            },
            _ => Ok(char::from(byte)),
        })
        .collect()
}

/// Espaço que o `trim()` do JavaScript tira (o do leitor do app, `normalizeWord`): `White_Space`
/// sem o NEL (U+0085, um controle que lá não sai) e com o U+FEFF.
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// Termo do formato v1 (r32; o `normalizeWord` do TS sem o NFC, D-R33-3): sem os espaços das
/// pontas; vazio ou `#` no início → fora; mais de 64 caracteres, espaço, controle (Cc) ou
/// formatação invisível (Cf) → descartado.
pub(super) fn v1_term(raw: &str) -> Line<'_> {
    let term = raw.trim_matches(is_js_space);
    if term.is_empty() || term.starts_with('#') {
        return Line::Skip;
    }
    if term.chars().count() > TERM_MAX_CHARS
        || term
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || is_format_char(c))
    {
        return Line::Invalid;
    }
    Line::Term(term)
}

/// A palavra de uma linha de `.dic`: até a primeira `/` não escapada (`\/` vira `/`) — as flags
/// saem —, cortada no TAB e no primeiro campo morfológico (` xx:`, como ` po:subst`).
pub(super) fn dic_word(line: &str) -> String {
    let mut word = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'/') => {
                word.push('/');
                chars.next();
            }
            '/' | '\t' => break,
            _ => word.push(c),
        }
    }
    let bytes = word.as_bytes();
    let field = (0..bytes.len()).find(|&at| {
        bytes[at] == b' '
            && bytes.get(at + 1..at + 4).is_some_and(|id| {
                id[0].is_ascii_lowercase() && id[1].is_ascii_lowercase() && id[2] == b':'
            })
    });
    if let Some(at) = field {
        word.truncate(at);
    }
    word
}

/// A 1ª linha de um `.dic` que é só a contagem (dígitos).
fn is_count_line(line: &str) -> bool {
    let line = line.trim_matches(is_js_space);
    !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit())
}

/// Os termos do texto já decodificado, na ordem e sem repetidos, e quantas linhas foram descartadas
/// (fora do formato v1 ou repetidas). CRLF e CR viram LF. No `.dic`: a 1ª linha só com dígitos sai,
/// linha vazia ou começada por `#` ou TAB é comentário e a linha que não deixa palavra é
/// descartada. Mais de `max_terms` termos → `None` (para de juntar: a memória fica limitada).
pub(super) fn parse_terms(
    format: Format,
    text: &str,
    max_terms: usize,
) -> Option<(Vec<String>, u32)> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut seen: HashSet<String> = HashSet::new();
    let mut terms = Vec::new();
    let mut discarded = 0u32;
    for (index, line) in text.split('\n').enumerate() {
        let word;
        let parsed = match format {
            Format::Txt => v1_term(line),
            Format::Dic => {
                if (index == 0 && is_count_line(line))
                    || line.starts_with(['#', '\t'])
                    || line.trim_matches(is_js_space).is_empty()
                {
                    continue;
                }
                word = dic_word(line);
                match v1_term(&word) {
                    Line::Skip => Line::Invalid,
                    parsed => parsed,
                }
            }
        };
        match parsed {
            Line::Skip => {}
            Line::Invalid => discarded += 1,
            Line::Term(term) => {
                if seen.contains(term) {
                    discarded += 1;
                } else if terms.len() == max_terms {
                    return None;
                } else {
                    seen.insert(term.to_owned());
                    terms.push(term.to_owned());
                }
            }
        }
    }
    Some((terms, discarded))
}

/// O `.txt` da lista: o cabeçalho `# Importado de <arquivo> em <AAAA-MM-DD>` (comentário no formato
/// v1; controles, `Cf` e quebras do nome viram U+FFFD) e um termo por linha, em UTF-8 com LF.
fn list_text(file_name: &str, terms: &[String], (year, month, day): (i64, u32, u32)) -> String {
    let shown: String = file_name
        .chars()
        .take(HEADER_NAME_MAX)
        .map(|c| {
            if c.is_control() || is_format_char(c) || (c.is_whitespace() && c != ' ') {
                '\u{FFFD}'
            } else {
                c
            }
        })
        .collect();
    let mut text = format!("# Importado de {shown} em {year:04}-{month:02}-{day:02}\n");
    text.reserve(terms.iter().map(|term| term.len() + 1).sum());
    for term in terms {
        text.push_str(term);
        text.push('\n');
    }
    text
}

/// A data de hoje (UTC), sem crate de datas.
fn today() -> (i64, u32, u32) {
    let days = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs() / 86_400);
    civil_from_days(i64::try_from(days).unwrap_or(0))
}

/// Dias desde 1970-01-01 → (ano, mês, dia) no calendário gregoriano (`civil_from_days`, de H.
/// Hinnant).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (
        year,
        u32::try_from(month).unwrap_or(1),
        u32::try_from(day).unwrap_or(1),
    )
}

/// O nome de uma lista importada (D-R33-2): o nome do arquivo sem a extensão em ASCII minúsculo —
/// letras latinas sem acento (`Termos Médicos.txt` → `termos-medicos`), dígitos e `_`, o resto vira
/// um `-` só —, até 48 caracteres. Vazio ou reservado (`con`, `com1`…) → `importado`; `pessoal` →
/// `pessoal-importado`. Espelho: `slugOf` do falso (`harness/dictionaries.ts`).
pub(super) fn slug(file_name: &str) -> String {
    let stem = match file_name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem,
        _ => file_name,
    };
    let mut out = String::new();
    let mut dash = false;
    for c in stem.chars() {
        // Acento combinado (NFD): some sem separar.
        if ('\u{300}'..='\u{36F}').contains(&c) {
            continue;
        }
        let ascii = c.is_ascii_alphanumeric() || c == '_';
        let latin = if ascii { None } else { latin_letter(c) };
        if !ascii && latin.is_none() {
            dash = true;
            continue;
        }
        if dash && !out.is_empty() {
            out.push('-');
        }
        dash = false;
        match latin {
            Some(letters) => out.push_str(letters),
            None => out.push(c.to_ascii_lowercase()),
        }
    }
    shorten(&mut out, SLUG_MAX);
    if out.is_empty() || dictionary_name(&format!("{out}.txt")).is_err() {
        return FALLBACK_SLUG.to_owned();
    }
    if out == "pessoal" {
        return PERSONAL_SLUG.to_owned();
    }
    out
}

/// Letra latina com acento (Latin-1 e as de ISO-8859-15/Windows-1252) em ASCII minúsculo; o resto
/// fora do ASCII é separador.
fn latin_letter(c: char) -> Option<&'static str> {
    Some(match c {
        'À'..='Å' | 'à'..='å' => "a",
        'Æ' | 'æ' => "ae",
        'Ç' | 'ç' => "c",
        'È'..='Ë' | 'è'..='ë' => "e",
        'Ì'..='Ï' | 'ì'..='ï' => "i",
        'Ð' | 'ð' => "d",
        'Ñ' | 'ñ' => "n",
        'Ò'..='Ö' | 'Ø' | 'ò'..='ö' | 'ø' => "o",
        'Ù'..='Ü' | 'ù'..='ü' => "u",
        'Ý' | 'ý' | 'ÿ' | 'Ÿ' => "y",
        'Þ' | 'þ' => "th",
        'ß' => "ss",
        'Œ' | 'œ' => "oe",
        'Š' | 'š' => "s",
        'Ž' | 'ž' => "z",
        _ => return None,
    })
}

/// Corta o slug (ASCII) em `max` e tira os `-` do fim.
fn shorten(slug: &mut String, max: usize) {
    slug.truncate(max);
    while slug.ends_with('-') {
        slug.pop();
    }
}

/// `true` se `<dir>/<stem>.txt` ou o par `<dir>/hunspell/<stem>.dic|.aff` existe (sem seguir link:
/// um link também ocupa o nome). Um par órfão também ocupa: senão o corretor o juntaria à lista nova.
/// Ao renomear, `moving` são os pares (origem, destino): um destino ocupado pela própria origem —
/// renomear só a caixa num FS sem caixa, `a.txt` → `A.txt` (`case_of`) — não ocupa.
fn taken(
    root: &Path,
    dir: &[&str],
    stem: &str,
    moving: &[(PathBuf, PathBuf)],
) -> Result<bool, AppError> {
    let folder = join(root, dir);
    let pair = folder.join(PAIR_DIR);
    for path in [
        folder.join(format!("{stem}.txt")),
        pair.join(format!("{stem}.dic")),
        pair.join(format!("{stem}.aff")),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(found)
                if moving
                    .iter()
                    .any(|(from, to)| *to == path && case_of(from, to, &found)) => {}
            Ok(_) => return Ok(true),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                ) => {}
            Err(error) => return Err(AppError::io(&error)),
        }
    }
    Ok(false)
}

/// O primeiro nome livre: o slug e depois `-2` … `-99` (o slug encurtado para o todo caber em 48).
/// Tudo ocupado → `ALREADY_EXISTS`.
fn free_name(root: &Path, dir: &[&str], slug: &str) -> Result<String, AppError> {
    for n in 1..=MAX_SUFFIX {
        let stem = if n == 1 {
            slug.to_owned()
        } else {
            let suffix = format!("-{n}");
            let mut base = slug.to_owned();
            shorten(&mut base, SLUG_MAX - suffix.len());
            base + &suffix
        };
        if !taken(root, dir, &stem, &[])? {
            return Ok(stem);
        }
    }
    Err(AppError::new("ALREADY_EXISTS"))
}

/// Os tetos da camada antes de gravar (D-R32-2, D-R33-4), contados como o leitor conta: entradas de
/// dicionário (links e arquivos com erro contam) + a nova ≤ 16; bytes dos arquivos que o leitor
/// leria + os da nova ≤ 20 MiB; a união dos termos ≤ 200.000. Senão → `LAYER_FULL`.
fn check_room(root: &Path, dir: &[&str], list: &List) -> Result<(), AppError> {
    let full = || AppError::new("LAYER_FULL");
    let mut entries = 0usize;
    let mut bytes = list.text.len() as u64;
    for entry in fs::read_dir(join(root, dir))? {
        if let Some(found) = candidate(entry)? {
            entries += 1;
            if !found.link && found.len <= DICTIONARY_MAX_BYTES {
                bytes += found.len;
            }
        }
    }
    if entries + 1 > LAYER_MAX_FILES || bytes > LAYER_MAX_BYTES {
        return Err(full());
    }
    let layer = read_layer(root, dir)?;
    let mut union: HashSet<&str> = list.terms.iter().map(String::as_str).collect();
    for file in &layer.files {
        let LayerFile::Text { text, .. } = file else {
            continue;
        };
        let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
        for line in body.split('\n') {
            if let Line::Term(term) = v1_term(line) {
                union.insert(term);
                if union.len() > LAYER_MAX_TERMS {
                    return Err(full());
                }
            }
        }
    }
    Ok(())
}

/// Grava a lista na camada `root/<dir…>` (D-R33-5/6), com a trava já segura: a pasta nasce se
/// faltar (link → `OUTSIDE_VAULT`), os tetos valem antes (`LAYER_FULL`) e o nome é o primeiro
/// livre. Cada arquivo nasce por `replace::write_new`: primeiro o par (`hunspell/`), por último o
/// `.txt`, que é o que torna a lista visível; uma falha apaga o que esta importação já criou.
fn write_list(root: &Path, dir: &[&str], list: &List) -> Result<Imported, AppError> {
    ensure_layer_dir(root, dir)?;
    check_room(root, dir, list)?;
    let pair_dir: Vec<&str> = dir.iter().copied().chain([PAIR_DIR]).collect();
    if list.pair.is_some() {
        ensure_layer_dir(root, &pair_dir)?;
    }
    let stem = free_name(root, dir, &list.slug)?;
    let mut created = Vec::new();
    if let Err(error) = write_files(root, dir, &pair_dir, &stem, list, &mut created) {
        for path in created.iter().rev() {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(Imported {
        name: format!("{stem}.txt"),
        words: u32::try_from(list.terms.len()).unwrap_or(u32::MAX),
        discarded: list.discarded,
        encoding: list.encoding.label(),
        pair: list.pair.is_some(),
    })
}

fn write_files(
    root: &Path,
    dir: &[&str],
    pair_dir: &[&str],
    stem: &str,
    list: &List,
    created: &mut Vec<PathBuf>,
) -> Result<(), AppError> {
    if let Some((dic, aff)) = &list.pair {
        for (extension, bytes) in [("dic", dic), ("aff", aff)] {
            let path = join(root, pair_dir).join(format!("{stem}.{extension}"));
            replace::write_new(&path, bytes)?;
            created.push(path);
        }
    }
    replace::write_new(
        &join(root, dir).join(format!("{stem}.txt")),
        list.text.as_bytes(),
    )
}

/// Pedido de `dict_manage` já validado, antes de qualquer acesso ao disco.
pub(super) struct Manage {
    name: String,
    to: Option<String>,
}

impl Manage {
    /// `name` e `to` são nomes de dicionário (`policy::dictionary_name`, senão `INVALID_NAME`) e
    /// nenhum é o `pessoal.txt` em caixa nenhuma (`is_personal`, `PROTECTED`).
    fn new(name: String, action: ManageAction) -> Result<Self, AppError> {
        let check = |name: &str| {
            if dictionary_name(name).is_err() {
                Err(AppError::new("INVALID_NAME"))
            } else if is_personal(name) {
                Err(AppError::new("PROTECTED"))
            } else {
                Ok(())
            }
        };
        check(&name)?;
        let to = match action {
            ManageAction::Remove => None,
            ManageAction::Rename { to } => {
                check(&to)?;
                Some(to)
            }
        };
        Ok(Self { name, to })
    }

    fn kind(&self) -> &'static str {
        if self.to.is_some() {
            "rename"
        } else {
            "remove"
        }
    }
}

/// `nome.txt` → `nome` (a extensão é `.txt`, ASCII: `dictionary_name`).
fn txt_stem(name: &str) -> &str {
    &name[..name.len() - ".txt".len()]
}

/// O par existente de uma lista (`hunspell/<stem>.dic|.aff`) como `(extensão, caminho)`, sem seguir
/// link: link na pasta do par ou no arquivo → `OUTSIDE_VAULT`; o que não é arquivo comum →
/// `INVALID_PATH`.
fn existing_pair(
    root: &Path,
    dir: &[&str],
    stem: &str,
) -> Result<Vec<(&'static str, PathBuf)>, AppError> {
    let mut found = Vec::new();
    for extension in ["dic", "aff"] {
        let file = format!("{stem}.{extension}");
        let segments: Vec<&str> = dir.iter().copied().chain([PAIR_DIR, &file]).collect();
        match walk_target(root, &segments)? {
            None => {}
            Some(meta) if !meta.is_file() => return Err(AppError::new("INVALID_PATH")),
            Some(_) => found.push((extension, join(root, &segments))),
        }
    }
    Ok(found)
}

/// `pessoal.txt` em qualquer caixa Unicode, não só ASCII (AppSec r33a N1): maiúsculas e minúsculas
/// completas, então `PESSOAL.TXT` e `peſsoal.txt` (o `ſ` U+017F vira `S`), que no APFS e no NTFS
/// abrem o mesmo arquivo.
fn is_personal(name: &str) -> bool {
    name.to_uppercase() == PERSONAL.to_uppercase() || name.to_lowercase() == PERSONAL
}

/// `name` está na listagem da pasta com estes bytes exatos (AppSec r33a N1): num FS sem caixa (ou
/// que normaliza), outra grafia abre o mesmo arquivo, mas só a gravada é listada.
fn listed(folder: &Path, name: &str) -> Result<bool, AppError> {
    for entry in fs::read_dir(folder)? {
        if entry?.file_name() == *name {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `to`, que já existe (`found`), é a própria `from` com outra caixa: os nomes iguais em minúsculas
/// e o mesmo arquivo.
fn case_of(from: &Path, to: &Path, found: &Metadata) -> bool {
    let lower = |path: &Path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_lowercase())
    };
    lower(from) == lower(to)
        && fs::symlink_metadata(from).is_ok_and(|source| same_file(&source, found))
}

/// Mesmo arquivo: dispositivo e inode.
#[cfg(unix)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

/// Mesmo arquivo: criação, última escrita e tamanho (o índice do arquivo não é API estável do std).
#[cfg(windows)]
fn same_file(a: &Metadata, b: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    a.creation_time() == b.creation_time()
        && a.last_write_time() == b.last_write_time()
        && a.file_size() == b.file_size()
}

/// Renomeia ou remove a lista `name` na camada `root/<dir…>`, com a trava já segura (D-R33-7).
/// `name` precisa estar listado com esses bytes (`listed`; senão `NOT_FOUND`): o `pessoal.txt`
/// nunca é alcançado por outra grafia. Renomear: o par antes, o `.txt` por último, desfazendo o que
/// andou se algo falhar; remover: o `.txt` antes (a lista some de vez), o par depois.
fn manage_in(root: &Path, dir: &[&str], manage: &Manage) -> Result<(), AppError> {
    let source: Vec<&str> = dir.iter().copied().chain([manage.name.as_str()]).collect();
    match walk_target(root, &source)? {
        None => return Err(AppError::new("NOT_FOUND")),
        Some(meta) if !meta.is_file() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    let folder = join(root, dir);
    if !listed(&folder, &manage.name)? {
        return Err(AppError::new("NOT_FOUND"));
    }
    let pair = existing_pair(root, dir, txt_stem(&manage.name))?;
    let Some(to) = &manage.to else {
        fs::remove_file(folder.join(&manage.name))?;
        for (_, path) in pair {
            let _ = fs::remove_file(path);
        }
        return Ok(());
    };
    let to_stem = txt_stem(to);
    let renames: Vec<(PathBuf, PathBuf)> = pair
        .into_iter()
        .map(|(extension, from)| {
            let to = folder.join(PAIR_DIR).join(format!("{to_stem}.{extension}"));
            (from, to)
        })
        .chain([(folder.join(&manage.name), folder.join(to))])
        .collect();
    if taken(root, dir, to_stem, &renames)? {
        return Err(AppError::new("ALREADY_EXISTS"));
    }
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (from, to) in renames {
        if let Err(error) = fs::rename(&from, &to) {
            for (back, forth) in moved.iter().rev() {
                let _ = fs::rename(forth, back);
            }
            return Err(AppError::io(&error));
        }
        moved.push((from, to));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;
    use crate::vault::policy::{can_read_dir, file_class};
    use crate::vault::replace::{Hook, Step};

    const MIB: usize = 1024 * 1024;

    fn code<T>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    /// Temporários de gravação que sobraram (listagem crua do SO); pasta ausente → nenhum.
    fn temps(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| replace::is_temp_name(name))
            .collect()
    }

    /// Nomes de uma pasta (listagem crua, em ordem); ausente → nenhum.
    fn listing(dir: &Path) -> Vec<String> {
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        names.sort();
        names
    }

    /// O "diálogo": a pasta de onde a fonte é escolhida, com os arquivos dados.
    fn picked(files: &[(&str, &[u8])]) -> TempDir {
        let dir = TempDir::new();
        for (name, bytes) in files {
            dir.put(name, bytes);
        }
        dir
    }

    /// Lê e converte um arquivo da pasta escolhida (a importação sem o diálogo).
    fn list_of(from: &TempDir, name: &str) -> Result<List, AppError> {
        read_list(&from.0.join(name))
    }

    /// Os termos do `.txt` gravado (sem o cabeçalho).
    fn body(text: &str) -> &str {
        assert!(text.starts_with("# Importado de "), "{text:?}");
        &text[text.find('\n').unwrap() + 1..]
    }

    fn read(path: &Path) -> String {
        String::from_utf8(fs::read(path).unwrap()).unwrap()
    }

    /// Vetores da regra v1 dos termos, da palavra de uma linha de `.dic` e do slug — os mesmos do
    /// espelho TS no falso (`apps/desktop/test/dictionary.test.ts`, "vetores da r33").
    #[test]
    fn terms_dic_lines_and_slugs_follow_the_vectors() {
        let (a64, a65) = ("a".repeat(64), "a".repeat(65));
        let (e64, e65) = ("😀".repeat(64), "😀".repeat(65));
        for (raw, term) in [
            ("excessão", "excessão"),
            ("  excessão \r", "excessão"),
            ("\u{FEFF}excessão\u{FEFF}", "excessão"),
            (a64.as_str(), a64.as_str()),
            (e64.as_str(), e64.as_str()),
            ("e-mail", "e-mail"),
            ("a/b", "a/b"),
            ("C++", "C++"),
            ("\u{201C}aspas\u{201D}", "\u{201C}aspas\u{201D}"),
        ] {
            assert_eq!(v1_term(raw), Line::Term(term), "{raw:?}");
        }
        for raw in [
            "duas palavras",
            "tab\tdentro",
            "sem\u{A0}quebra",
            "sino\u{7}",
            "bidi\u{202E}abc",
            "largura\u{200B}zero",
            "hífen\u{AD}mole",
            a65.as_str(),
            e65.as_str(),
            "\u{85}x",
            "x\u{2028}y",
        ] {
            assert_eq!(v1_term(raw), Line::Invalid, "{raw:?}");
        }
        for raw in ["", "   ", "\r", "# comentário", "#hashtag", "  #x"] {
            assert_eq!(v1_term(raw), Line::Skip, "{raw:?}");
        }
        for (line, word) in [
            ("abacaxi/S", "abacaxi"),
            ("maçã/SM", "maçã"),
            ("a\\/b/X", "a/b"),
            ("palavra\tpo:subst", "palavra"),
            ("casa po:subst st:casa", "casa"),
            ("Rio de Janeiro", "Rio de Janeiro"),
            ("/SOFLAG", ""),
            ("x\\", "x\\"),
            ("e-mail/S", "e-mail"),
            ("ab po", "ab po"),
            ("ab Po:x", "ab Po:x"),
        ] {
            assert_eq!(dic_word(line), word, "{line:?}");
        }
        let (long, long_slug) = (format!("{}.txt", "a".repeat(60)), "a".repeat(48));
        let (dash, dash_slug) = (format!("{}-b.txt", "a".repeat(47)), "a".repeat(47));
        for (file_name, expected) in [
            ("Termos Médicos.txt", "termos-medicos"),
            ("pt_BR.dic", "pt_br"),
            ("CON.txt", "importado"),
            ("com1.dic", "importado"),
            ("pessoal.txt", "pessoal-importado"),
            ("PESSOAL.dic", "pessoal-importado"),
            ("日本語.txt", "importado"),
            ("  --Lista  Nova--  .txt", "lista-nova"),
            ("Ação & Reação.dic", "acao-reacao"),
            ("Œuvre Straße.txt", "oeuvre-strasse"),
            ("cafe\u{301}.txt", "cafe"),
            ("lista.v2.txt", "lista-v2"),
            ("termos_médicos 2026.txt", "termos_medicos-2026"),
            ("nul-x.txt", "nul-x"),
            (".txt", "txt"),
            (long.as_str(), long_slug.as_str()),
            (dash.as_str(), dash_slug.as_str()),
        ] {
            assert_eq!(slug(file_name), expected, "{file_name:?}");
        }
    }

    /// `.txt`: o BOM UTF-8 sai, CRLF vira LF, comentários e linhas vazias não contam, o que sai do
    /// formato v1 e o repetido são descartados; a lista sai em UTF-8 com o cabeçalho e um termo por
    /// linha, na ordem.
    #[test]
    fn a_txt_with_bom_and_crlf_becomes_a_v1_list() {
        let from = picked(&[(
            "Termos Médicos.txt",
            "\u{FEFF}# lista da clínica\r\nexcessão\r\n\r\nExcessão\r\nduas palavras\r\nexcessão\r\n  colecistectomia  \r\n#comentário\r\n".as_bytes(),
        )]);
        let list = list_of(&from, "Termos Médicos.txt").unwrap();
        assert_eq!(list.terms, ["excessão", "Excessão", "colecistectomia"]);
        assert_eq!(list.discarded, 2);
        assert_eq!(list.encoding, Encoding::Utf8);
        assert_eq!(list.slug, "termos-medicos");
        assert!(list.pair.is_none());
        assert!(list
            .text
            .starts_with("# Importado de Termos Médicos.txt em "));
        assert_eq!(body(&list.text), "excessão\nExcessão\ncolecistectomia\n");
    }

    /// BOM UTF-16 (LE e BE) é decodificado; número ímpar de bytes ou substituto sem par →
    /// `BAD_ENCODING`; sem BOM e sem `SET`, o que não é UTF-8 é lido como Windows-1252.
    #[test]
    fn utf16_bom_and_the_windows_1252_fallback() {
        let utf16 = |words: &str, big: bool| -> Vec<u8> {
            let mut out = if big {
                vec![0xFE, 0xFF]
            } else {
                vec![0xFF, 0xFE]
            };
            for unit in words.encode_utf16() {
                out.extend(if big {
                    unit.to_be_bytes()
                } else {
                    unit.to_le_bytes()
                });
            }
            out
        };
        for (big, encoding) in [(false, Encoding::Utf16Le), (true, Encoding::Utf16Be)] {
            let (text, read) = decode(&utf16("ação\r\nçal\n", big), None).unwrap();
            assert_eq!((text.as_str(), read), ("ação\r\nçal\n", encoding));
        }
        let mut odd = utf16("a", false);
        odd.push(0x61);
        assert_eq!(code(decode(&odd, None)), "BAD_ENCODING");
        assert_eq!(
            code(decode(&[0xFF, 0xFE, 0x00, 0xD8], None)),
            "BAD_ENCODING"
        );
        let (text, read) = decode(b"caf\xe9\n\x93aspas\x94\n\x81x\n", None).unwrap();
        assert_eq!(read, Encoding::Windows1252);
        assert_eq!(text, "café\n\u{201C}aspas\u{201D}\n\u{81}x\n");
        // O byte indefinido virou um controle C1: a linha sai do formato v1.
        let (terms, discarded) = parse_terms(Format::Txt, &text, 10).unwrap();
        assert_eq!(
            (terms, discarded),
            (
                vec!["café".to_owned(), "\u{201C}aspas\u{201D}".to_owned()],
                1
            )
        );
    }

    /// AC-R33-2: `.dic` Hunspell em latin-1 (`SET ISO8859-1`) com a contagem na 1ª linha, flags,
    /// `\/`, campo morfológico e comentários: palavras certas, o par guardado com os bytes
    /// originais e fora das classes do gateway.
    #[test]
    fn a_latin1_hunspell_dic_with_flags_is_imported_with_its_pair() {
        let dic: &[u8] =
            b"7\nma\xe7\xe3/S\ncora\xe7\xe3o/SM\na\\/b/X\npalavra\tpo:subst\ncasa po:subst st:casa\n#coment\xe1rio\n\tdescri\xe7\xe3o\n/SOFLAG\nma\xe7\xe3/P\n";
        let aff: &[u8] = b"# pt_BR de teste\nSET ISO8859-1\nTRY esianrtolcdugmphbyfvkwz\nSFX S Y 1\nSFX S 0 s .\n";
        let from = picked(&[("pt_BR.dic", dic), ("pt_BR.aff", aff)]);
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let list = list_of(&from, "pt_BR.dic").unwrap();
        assert_eq!(list.encoding, Encoding::Latin1);
        assert_eq!(list.terms, ["maçã", "coração", "a/b", "palavra", "casa"]);
        assert_eq!(list.discarded, 2, "/SOFLAG sem palavra e maçã repetida");
        let imported = global.import_global(&list).unwrap();
        assert_eq!(
            imported,
            Imported {
                name: "pt_br.txt".to_owned(),
                words: 5,
                discarded: 2,
                encoding: "ISO-8859-1",
                pair: true,
            }
        );
        let layer = data.0.join("dictionaries");
        assert_eq!(
            body(&read(&layer.join("pt_br.txt"))),
            "maçã\ncoração\na/b\npalavra\ncasa\n"
        );
        assert_eq!(
            replace::sha256(&fs::read(layer.join("hunspell/pt_br.dic")).unwrap()),
            replace::sha256(dic)
        );
        assert_eq!(fs::read(layer.join("hunspell/pt_br.aff")).unwrap(), aff);
        assert_eq!(listing(&layer), ["hunspell", "pt_br.txt"]);
        // O leitor de camada não vê o par; o gateway da pasta não lista nem lê `hunspell/`.
        assert_eq!(global.read().unwrap().files.len(), 1);
        assert_eq!(
            file_class(&[".simplemd", "dictionaries", "hunspell", "pt_br.dic"]),
            None
        );
        assert!(!can_read_dir(&[".simplemd", "dictionaries", "hunspell"]));
        assert!(temps(&layer).is_empty() && temps(&layer.join("hunspell")).is_empty());
    }

    /// `SET` manda: ISO8859-15 (`0xA4` = €), microsoft-cp1252 (`0x80` = €; indefinido →
    /// `BAD_ENCODING`), UTF-8 declarado e inválido → `BAD_ENCODING`; `KOI8-R` →
    /// `UNSUPPORTED_ENCODING` com o nome; o BOM vale mais que o `SET`.
    #[test]
    fn the_declared_encoding_rules() {
        assert_eq!(
            declared_encoding(b"\xEF\xBB\xBF  SET ISO8859-15\r\n").unwrap(),
            Some(Encoding::Latin9)
        );
        assert_eq!(declared_encoding(b"FLAG long\nTRY abc\n").unwrap(), None);
        assert_eq!(declared_encoding(b"SETX ISO8859-1\nSET\n").unwrap(), None);
        for name in [
            "UTF-8",
            "utf8",
            "ISO8859-1",
            "iso-8859-1",
            "microsoft-cp1252",
        ] {
            assert!(
                declared_encoding(format!("SET {name}\n").as_bytes())
                    .unwrap()
                    .is_some(),
                "{name}"
            );
        }
        let error = declared_encoding(b"SET KOI8-R\n").unwrap_err();
        assert_eq!(error.code, "UNSUPPORTED_ENCODING");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({ "encoding": "KOI8-R" }))
        );
        assert_eq!(
            decode(b"\xa4uro\n", Some(Encoding::Latin9)).unwrap().0,
            "€uro\n"
        );
        assert_eq!(
            decode(b"\x80uro\n", Some(Encoding::Windows1252)).unwrap().0,
            "€uro\n"
        );
        assert_eq!(
            code(decode(b"\x81x\n", Some(Encoding::Windows1252))),
            "BAD_ENCODING"
        );
        let error = decode(b"caf\xe9\n", Some(Encoding::Utf8)).unwrap_err();
        assert_eq!(
            (error.code, error.detail),
            (
                "BAD_ENCODING",
                Some(serde_json::json!({ "encoding": "UTF-8" }))
            )
        );
        assert_eq!(
            decode("\u{FEFF}café\n".as_bytes(), Some(Encoding::Latin1)).unwrap(),
            ("café\n".to_owned(), Encoding::Utf8)
        );
        let from = picked(&[
            ("ru.dic", b"1\n\xc4\xce\xcd\n"),
            ("ru.aff", b"SET KOI8-R\n"),
        ]);
        assert_eq!(code(list_of(&from, "ru.dic")), "UNSUPPORTED_ENCODING");
    }

    /// NUL → `NOT_TEXT` (também depois do UTF-16); nada que vire termo → `EMPTY`; outra extensão →
    /// `UNSUPPORTED_TYPE`; um `.dic` sem `.aff` é lido como texto e não guarda par.
    #[test]
    fn not_text_empty_and_unsupported_type() {
        let from = picked(&[
            ("nul.txt", b"a\x00b\n"),
            ("vazio.txt", b"# so comentario\n\n   \n"),
            ("notas.md", b"palavra\n"),
            ("sem-aff.dic", b"2\num/A\ndois\n"),
        ]);
        assert_eq!(code(list_of(&from, "nul.txt")), "NOT_TEXT");
        assert_eq!(
            code(decode(&[0xFF, 0xFE, 0x61, 0x00, 0x00, 0x00], None)),
            "NOT_TEXT"
        );
        assert_eq!(code(list_of(&from, "vazio.txt")), "EMPTY");
        assert_eq!(code(list_of(&from, "notas.md")), "UNSUPPORTED_TYPE");
        let list = list_of(&from, "sem-aff.dic").unwrap();
        assert_eq!(list.terms, ["um", "dois"]);
        assert!(list.pair.is_none());
    }

    /// AC-R33-2: acima de 10 MiB → `TOO_LARGE { fileName, size, max }`, sem ler além do teto e sem
    /// tocar a camada (nem a pasta nasce); o `.aff` também; 10 MiB exatos passam.
    #[test]
    fn over_10_mib_is_refused_before_anything_is_written() {
        let mut big = vec![b'a'; 10 * MIB];
        big.push(b'\n');
        let mut exact = b"palavra\n#".to_vec();
        exact.resize(10 * MIB, b'#');
        let from = picked(&[
            ("grande.txt", &big),
            ("grande.dic", b"1\npalavra\n"),
            ("exato.txt", &exact),
        ]);
        from.put("grande.aff", &big);
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let import = |name: &str| list_of(&from, name).and_then(|list| global.import_global(&list));
        let error = import("grande.txt").unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({
                "fileName": "grande.txt",
                "size": 10 * MIB + 1,
                "max": 10 * MIB,
            }))
        );
        assert_eq!(
            import("grande.dic").unwrap_err().detail.unwrap()["fileName"],
            "grande.aff"
        );
        assert!(listing(&data.0).is_empty(), "nem a pasta da camada nasceu");
        assert_eq!(import("exato.txt").unwrap().words, 1);
    }

    /// Depois da conversão a lista também não passa de 10 MiB: 100.000 termos latin-1 de 60 letras
    /// (6,1 MB) viram 12,1 MB em UTF-8 → `TOO_LARGE` com o tamanho convertido.
    #[test]
    fn a_conversion_over_10_mib_is_refused() {
        let letters: Vec<u8> = std::iter::once(0xDF)
            .chain(0xE0..=0xF6)
            .chain(0xF8..=0xFF)
            .collect();
        assert_eq!(letters.len(), 32);
        let mut dic = b"100000\n".to_vec();
        for i in 0..100_000usize {
            dic.extend(std::iter::repeat_n(0xE7, 56));
            for k in 0..4 {
                dic.push(letters[(i >> (5 * k)) & 31]);
            }
            dic.push(b'\n');
        }
        let from = picked(&[("grande.dic", &dic), ("grande.aff", b"SET ISO8859-1\n")]);
        let error = list_of(&from, "grande.dic").err().unwrap();
        assert_eq!(error.code, "TOO_LARGE");
        let detail = error.detail.unwrap();
        assert_eq!(detail["fileName"], "grande.dic");
        assert!(
            detail["size"].as_u64().unwrap() > 12 * 1_000_000,
            "{detail}"
        );
    }

    /// AC-R33-2/D-R33 §3: a fonte como link → `SYMLINK`, e também o `.aff` como link; nada é lido
    /// do alvo nem gravado.
    #[cfg(unix)]
    #[test]
    fn links_are_refused_in_the_source_and_in_the_aff() {
        use std::os::unix::fs::symlink;
        let outside = TempDir::new();
        outside.put("segredo.txt", b"segredo\n");
        outside.put("segredo.aff", b"SET UTF-8\n");
        let from = picked(&[("par.dic", b"1\npalavra\n")]);
        symlink(outside.0.join("segredo.txt"), from.0.join("link.txt")).unwrap();
        symlink(outside.0.join("segredo.aff"), from.0.join("par.aff")).unwrap();
        assert_eq!(code(list_of(&from, "link.txt")), "SYMLINK");
        assert_eq!(code(list_of(&from, "par.dic")), "SYMLINK");
    }

    /// D-R33-2: o slug do arquivo, `-2` na colisão (também com um par órfão ou um link no nome),
    /// `pessoal` → `pessoal-importado`, reservado → `importado`; nada é sobrescrito.
    #[test]
    fn names_are_slugs_with_suffixes_and_nothing_is_overwritten() {
        let from = picked(&[
            ("Termos Médicos.txt", b"um\n"),
            ("pessoal.txt", b"dois\n"),
            ("CON.txt", b"tres\n"),
            ("orfao.txt", b"quatro\n"),
        ]);
        let data = TempDir::new();
        data.put("dictionaries/pessoal.txt", b"meu\n");
        data.put("dictionaries/hunspell/orfao.dic", b"1\nx\n");
        let global = GlobalDictionaries::new(data.0.clone());
        let import = |name: &str| {
            global
                .import_global(&list_of(&from, name).unwrap())
                .map(|imported| imported.name)
        };
        assert_eq!(import("Termos Médicos.txt").unwrap(), "termos-medicos.txt");
        assert_eq!(
            import("Termos Médicos.txt").unwrap(),
            "termos-medicos-2.txt"
        );
        assert_eq!(import("pessoal.txt").unwrap(), "pessoal-importado.txt");
        assert_eq!(import("CON.txt").unwrap(), "importado.txt");
        assert_eq!(import("orfao.txt").unwrap(), "orfao-2.txt");
        let layer = data.0.join("dictionaries");
        assert_eq!(read(&layer.join("pessoal.txt")), "meu\n");
        assert_eq!(body(&read(&layer.join("termos-medicos.txt"))), "um\n");
        assert_eq!(body(&read(&layer.join("termos-medicos-2.txt"))), "um\n");
        #[cfg(unix)]
        {
            let outside = TempDir::new();
            outside.put("x.txt", b"fora\n");
            std::os::unix::fs::symlink(outside.0.join("x.txt"), layer.join("importado-2.txt"))
                .unwrap();
            assert_eq!(import("CON.txt").unwrap(), "importado-3.txt");
            assert_eq!(read(&outside.0.join("x.txt")), "fora\n");
        }
        // Slug no teto: o sufixo cabe nos 48.
        let long = "a".repeat(60);
        assert_eq!(slug(&format!("{long}.txt")), "a".repeat(48));
        let base = "a".repeat(48);
        assert_eq!(
            free_name(&data.0, &["vazia"], &base).unwrap(),
            base,
            "pasta ausente: nada ocupado"
        );
        data.put(&format!("dictionaries/{base}.txt"), b"x\n");
        assert_eq!(
            free_name(&data.0, &["dictionaries"], &base).unwrap(),
            format!("{}-2", "a".repeat(46))
        );
        assert!(temps(&layer).is_empty());
    }

    /// D-R33-5: outro programa cria o nome escolhido antes da conferência → `ALREADY_EXISTS`, o
    /// arquivo dele intacto; falha injetada em cada etapa (no `.txt` ou no par) → nada da
    /// importação fica (nem o par) e nenhum temporário sobra.
    #[test]
    fn never_overwrites_and_a_failure_leaves_nothing() {
        let from = picked(&[
            ("lista.txt", b"um\ndois\n"),
            ("par.dic", b"1\num/S\n"),
            ("par.aff", b"SET UTF-8\n"),
        ]);
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let layer = data.0.join("dictionaries");
        let target = layer.join("lista.txt");
        {
            let racer = target.clone();
            let _hook = Hook::set(move |at| {
                if at == Step::Synced {
                    fs::write(&racer, b"do outro programa\n")?;
                }
                Ok(())
            });
            assert_eq!(
                code(global.import_global(&list_of(&from, "lista.txt").unwrap())),
                "ALREADY_EXISTS"
            );
        }
        assert_eq!(read(&target), "do outro programa\n");
        fs::remove_file(&target).unwrap();
        for step in [Step::Created, Step::Written, Step::Synced, Step::Verified] {
            for (name, nth) in [
                ("lista.txt", 1),
                ("par.dic", 1),
                ("par.dic", 2),
                ("par.dic", 3),
            ] {
                let mut seen = 0;
                let _hook = Hook::set(move |at| {
                    if at == step {
                        seen += 1;
                        if seen == nth {
                            return Err(io::Error::other("falha injetada"));
                        }
                    }
                    Ok(())
                });
                assert_eq!(
                    code(global.import_global(&list_of(&from, name).unwrap())),
                    "IO",
                    "{step:?} {name} {nth}"
                );
                assert!(
                    listing(&layer).iter().all(|n| n == "hunspell"),
                    "{step:?} {name} {nth}: {:?}",
                    listing(&layer)
                );
                assert!(
                    listing(&layer.join("hunspell")).is_empty(),
                    "{step:?} {name}"
                );
            }
        }
        assert!(temps(&layer).is_empty() && temps(&layer.join("hunspell")).is_empty());
    }

    /// D-R33-4: a camada cheia recusa (`LAYER_FULL`): 16 entradas (um link conta), 20 MiB ou
    /// 200.000 termos na união; uma lista sozinha acima de 200.000 também. Nada é gravado.
    #[test]
    fn a_full_layer_refuses_the_import() {
        let from = picked(&[("nova.txt", b"nova\n")]);
        let full = |files: &[(String, Vec<u8>)]| {
            let data = TempDir::new();
            for (name, bytes) in files {
                data.put(&format!("dictionaries/{name}"), bytes);
            }
            let global = GlobalDictionaries::new(data.0.clone());
            let result = global.import_global(&list_of(&from, "nova.txt").unwrap());
            let left = listing(&data.0.join("dictionaries"));
            (code(result), left.contains(&"nova.txt".to_owned()))
        };
        let sixteen: Vec<(String, Vec<u8>)> = (0..16)
            .map(|i| (format!("l{i:02}.txt"), format!("t{i}\n").into_bytes()))
            .collect();
        assert_eq!(full(&sixteen), ("LAYER_FULL", false));
        assert_eq!(full(&sixteen[..15]), ("OK", true));
        let seven = vec![b'#'; 7 * MIB];
        let heavy = vec![
            ("a.txt".to_owned(), seven.clone()),
            ("b.txt".to_owned(), seven.clone()),
            ("c.txt".to_owned(), vec![b'#'; 6 * MIB]),
        ];
        assert_eq!(full(&heavy), ("LAYER_FULL", false));
        let words = |range: std::ops::Range<usize>| -> Vec<u8> {
            range.flat_map(|i| format!("p{i}\n").into_bytes()).collect()
        };
        // União de 150.000 (a sobreposição conta uma vez): cabe.
        let overlapping = [
            ("a.txt".to_owned(), words(0..100_000)),
            ("b.txt".to_owned(), words(50_000..150_000)),
        ];
        assert_eq!(full(&overlapping), ("OK", true));
        // União de 200.000 exatos: a palavra nova passaria do teto.
        let crowded = [
            ("a.txt".to_owned(), words(0..100_000)),
            ("b.txt".to_owned(), words(100_000..200_000)),
        ];
        assert_eq!(full(&crowded), ("LAYER_FULL", false));
        // A palavra nova já está na camada: a união não cresce.
        let mut with_it = words(0..199_999);
        with_it.extend_from_slice(b"nova\n");
        assert_eq!(full(&[("a.txt".to_owned(), with_it)]), ("OK", true));
        let too_many: Vec<u8> = words(0..LAYER_MAX_TERMS + 1);
        let big = picked(&[("enorme.txt", &too_many)]);
        assert_eq!(code(list_of(&big, "enorme.txt")), "LAYER_FULL");
        #[cfg(unix)]
        {
            let data = TempDir::new();
            for (name, bytes) in &sixteen[..15] {
                data.put(&format!("dictionaries/{name}"), bytes);
            }
            std::os::unix::fs::symlink("/nao/existe", data.0.join("dictionaries/link.txt"))
                .unwrap();
            let global = GlobalDictionaries::new(data.0.clone());
            assert_eq!(
                code(global.import_global(&list_of(&from, "nova.txt").unwrap())),
                "LAYER_FULL"
            );
        }
    }

    /// A camada da pasta: `.simplemd/dictionaries` nasce se faltar e a lista vale para o gateway (a
    /// classe da pasta lê o `.txt`); `.simplemd` como link → `OUTSIDE_VAULT`, nada gravado fora.
    #[test]
    fn the_folder_layer_is_created_and_links_are_refused() {
        let from = picked(&[("medicos.txt", b"colecistectomia\n")]);
        let vault = TempDir::new();
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let imported = global
            .import_folder(&vault.0, &list_of(&from, "medicos.txt").unwrap())
            .unwrap();
        assert_eq!(imported.name, "medicos.txt");
        let text =
            crate::vault::ops::read_file(&vault.0, ".simplemd/dictionaries/medicos.txt").unwrap();
        assert_eq!(
            body(std::str::from_utf8(&text).unwrap()),
            "colecistectomia\n"
        );
        #[cfg(unix)]
        {
            let outside = TempDir::new();
            let other = TempDir::new();
            std::os::unix::fs::symlink(&outside.0, other.0.join(".simplemd")).unwrap();
            assert_eq!(
                code(global.import_folder(&other.0, &list_of(&from, "medicos.txt").unwrap())),
                "OUTSIDE_VAULT"
            );
            assert!(listing(&outside.0).is_empty());
        }
    }

    /// D-R33-7: renomear e remover levam o par; `pessoal.txt` (em qualquer caixa) é `PROTECTED`;
    /// nome inválido → `INVALID_NAME` antes do disco; destino ocupado → `ALREADY_EXISTS`;
    /// inexistente → `NOT_FOUND`.
    #[test]
    fn rename_and_remove_carry_the_pair_and_protect_pessoal() {
        let from = picked(&[("par.dic", b"1\num/S\n"), ("par.aff", b"SET UTF-8\n")]);
        let data = TempDir::new();
        data.put("dictionaries/pessoal.txt", b"meu\n");
        data.put("dictionaries/outra.txt", b"x\n");
        let global = GlobalDictionaries::new(data.0.clone());
        global
            .import_global(&list_of(&from, "par.dic").unwrap())
            .unwrap();
        let manage = |name: &str, action: ManageAction| {
            Manage::new(name.to_owned(), action).and_then(|m| global.manage_global(&m))
        };
        let rename = |to: &str| ManageAction::Rename { to: to.to_owned() };
        let layer = data.0.join("dictionaries");
        manage("par.txt", rename("cardiologia.txt")).unwrap();
        assert_eq!(
            listing(&layer),
            ["cardiologia.txt", "hunspell", "outra.txt", "pessoal.txt"]
        );
        assert_eq!(
            listing(&layer.join("hunspell")),
            ["cardiologia.aff", "cardiologia.dic"]
        );
        assert_eq!(
            code(manage("cardiologia.txt", rename("outra.txt"))),
            "ALREADY_EXISTS"
        );
        for name in ["pessoal.txt", "PESSOAL.TXT", "Pessoal.txt"] {
            assert_eq!(
                code(manage(name, ManageAction::Remove)),
                "PROTECTED",
                "{name}"
            );
            assert_eq!(
                code(manage("outra.txt", rename(name))),
                "PROTECTED",
                "{name}"
            );
        }
        for bad in [
            "",
            ".txt",
            "../x.txt",
            "a/b.txt",
            "x.md",
            "con.txt",
            "x\u{202E}.txt",
        ] {
            assert_eq!(
                code(manage(bad, ManageAction::Remove)),
                "INVALID_NAME",
                "{bad:?}"
            );
            assert_eq!(
                code(manage("outra.txt", rename(bad))),
                "INVALID_NAME",
                "{bad:?}"
            );
        }
        assert_eq!(code(manage("nada.txt", ManageAction::Remove)), "NOT_FOUND");
        manage("cardiologia.txt", ManageAction::Remove).unwrap();
        assert_eq!(listing(&layer), ["hunspell", "outra.txt", "pessoal.txt"]);
        assert!(listing(&layer.join("hunspell")).is_empty());
        assert_eq!(read(&layer.join("pessoal.txt")), "meu\n");
        #[cfg(unix)]
        {
            let outside = TempDir::new();
            outside.put("alvo.txt", b"fora\n");
            std::os::unix::fs::symlink(outside.0.join("alvo.txt"), layer.join("link.txt")).unwrap();
            assert_eq!(
                code(manage("link.txt", ManageAction::Remove)),
                "OUTSIDE_VAULT"
            );
            assert_eq!(read(&outside.0.join("alvo.txt")), "fora\n");
        }
    }

    /// AppSec r33a N1 (E1): o `pessoal.txt` não é alcançado por outra caixa Unicode. `Manage::new`
    /// recusa `peſsoal.txt` (o `ſ` vira `S`) e as variações de caixa como origem e destino; e, mesmo
    /// sem essa conferência, `manage_in` só aceita o nome listado: num FS sem caixa (APFS, NTFS), a
    /// grafia que abre o `pessoal.txt` → `NOT_FOUND` e nada muda. Num FS sensível a caixa a segunda
    /// metade não tem o que provar e é pulada.
    #[test]
    fn pessoal_is_protected_under_unicode_case_folding() {
        let folds = ["peſsoal.txt", "PEſSOAL.TXT", "Pessoal.Txt", "PESSOAL.TXT"];
        for name in folds {
            let remove = Manage::new(name.to_owned(), ManageAction::Remove);
            assert_eq!(code(remove), "PROTECTED", "{name}");
            let rename = ManageAction::Rename {
                to: name.to_owned(),
            };
            assert_eq!(code(Manage::new("a.txt".to_owned(), rename)), "PROTECTED");
        }
        let data = TempDir::new();
        data.put("dictionaries/pessoal.txt", b"meu\n");
        let global = GlobalDictionaries::new(data.0.clone());
        let layer = data.0.join("dictionaries");
        let aliases: Vec<&str> = folds
            .into_iter()
            .filter(|alias| fs::symlink_metadata(layer.join(alias)).is_ok())
            .collect();
        if aliases.is_empty() {
            eprintln!("FS sensível a caixa: sem grafia alternativa do pessoal.txt para provar");
            return;
        }
        for name in aliases {
            for to in [None, Some("roubado.txt".to_owned())] {
                let raw = Manage {
                    name: name.to_owned(),
                    to,
                };
                assert_eq!(code(global.manage_global(&raw)), "NOT_FOUND", "{name}");
            }
        }
        assert_eq!(listing(&layer), ["pessoal.txt"]);
        assert_eq!(read(&layer.join("pessoal.txt")), "meu\n");
    }

    /// Renomear só a caixa (`par.txt` → `PAR.txt`) não esbarra no próprio arquivo num FS sem caixa
    /// e leva o par; um `.Dic` acha o `.Aff` de mesma caixa (num FS sensível a caixa também).
    #[test]
    fn case_only_rename_and_the_aff_with_matching_case() {
        let from = picked(&[
            ("Medico.Dic", b"1\ncora\xe7\xe3o/S\n"),
            ("Medico.Aff", b"SET ISO8859-1\n"),
        ]);
        let list = list_of(&from, "Medico.Dic").unwrap();
        assert_eq!(list.encoding, Encoding::Latin1);
        assert_eq!(list.terms, ["coração"]);
        assert!(list.pair.is_some());
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        assert_eq!(global.import_global(&list).unwrap().name, "medico.txt");
        let rename = Manage::new(
            "medico.txt".to_owned(),
            ManageAction::Rename {
                to: "MEDICO.txt".to_owned(),
            },
        )
        .unwrap();
        global.manage_global(&rename).unwrap();
        let layer = data.0.join("dictionaries");
        assert_eq!(listing(&layer), ["MEDICO.txt", "hunspell"]);
        assert_eq!(
            listing(&layer.join("hunspell")),
            ["MEDICO.aff", "MEDICO.dic"]
        );
    }

    /// Code review r33a NB-1 (mutante M2): o `.txt` não pode ser renomeado (pasta da camada 0o555)
    /// depois de o par já ter andado em `hunspell/` (gravável) → o erro sai e o par volta ao nome
    /// antigo. Como root a permissão não vale e o teste é pulado.
    #[cfg(unix)]
    #[test]
    fn a_failed_rename_moves_the_pair_back() {
        use std::os::unix::fs::PermissionsExt;
        struct Restore(PathBuf);
        impl Drop for Restore {
            fn drop(&mut self) {
                let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
            }
        }
        let from = picked(&[("par.dic", b"1\num/S\n"), ("par.aff", b"SET UTF-8\n")]);
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        global
            .import_global(&list_of(&from, "par.dic").unwrap())
            .unwrap();
        let layer = data.0.join("dictionaries");
        fs::set_permissions(&layer, fs::Permissions::from_mode(0o555)).unwrap();
        let _restore = Restore(layer.clone());
        if fs::File::create(layer.join("sonda")).is_ok() {
            let _ = fs::remove_file(layer.join("sonda"));
            eprintln!("sem efeito de permissão (root): pulado");
            return;
        }
        let rename = Manage::new(
            "par.txt".to_owned(),
            ManageAction::Rename {
                to: "novo.txt".to_owned(),
            },
        )
        .unwrap();
        assert_eq!(code(global.manage_global(&rename)), "PERMISSION_DENIED");
        assert_eq!(listing(&layer), ["hunspell", "par.txt"]);
        assert_eq!(listing(&layer.join("hunspell")), ["par.aff", "par.dic"]);
    }

    /// AppSec r33a N2 / code review NB-4 (E3): um FIFO no lugar da fonte (o que a troca depois do
    /// `symlink_metadata` entregaria a `open_picked`) ou do `.aff` não prende a leitura: sai
    /// `INVALID_PATH` na hora (ou o `.dic` sem par) e o `Busy` fica livre para a próxima importação.
    #[cfg(unix)]
    #[test]
    fn a_fifo_never_blocks_the_import() {
        use std::sync::mpsc;
        use std::time::Duration;
        let from = picked(&[("par.dic", b"1\num\n")]);
        for fifo in ["fila.txt", "par.aff"] {
            let made = std::process::Command::new("mkfifo")
                .arg(from.0.join(fifo))
                .status()
                .unwrap();
            assert!(made.success());
        }
        let data = TempDir::new();
        let global = Arc::new(GlobalDictionaries::new(data.0.clone()));
        let (sender, receiver) = mpsc::channel();
        let (held, dir) = (Arc::clone(&global), from.0.clone());
        std::thread::spawn(move || {
            let busy = Busy::take(&held).unwrap();
            let fifo = dir.join("fila.txt");
            let codes = [
                code(open_picked(&fifo)),
                code(read_picked(&fifo, "fila.txt")),
                code(read_list(&fifo)),
            ];
            let pair = read_list(&dir.join("par.dic"))
                .ok()
                .map(|list| list.pair.is_some());
            drop(busy);
            sender.send((codes, pair)).unwrap();
        });
        let (codes, pair) = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("um FIFO prendeu a leitura");
        assert_eq!(codes, ["INVALID_PATH"; 3]);
        assert_eq!(pair, Some(false), "o .dic sai sem par, sem esperar o FIFO");
        assert!(Busy::take(&global).is_ok());
    }

    /// Uma importação por vez: a segunda → `BUSY` enquanto a primeira não sai; depois, livre.
    #[test]
    fn one_import_at_a_time() {
        let data = TempDir::new();
        let global = Arc::new(GlobalDictionaries::new(data.0.clone()));
        let first = Busy::take(&global).unwrap();
        assert_eq!(code(Busy::take(&global)), "BUSY");
        drop(first);
        assert!(Busy::take(&global).is_ok());
    }

    /// "Erros sem caminho": nenhuma resposta leva o caminho da fonte nem o da camada.
    #[test]
    fn errors_never_carry_a_path() {
        let from = picked(&[("nul.txt", b"\x00"), ("x.md", b"x")]);
        let data = TempDir::new();
        let global = GlobalDictionaries::new(data.0.clone());
        let errors = [
            list_of(&from, "nul.txt").err().unwrap(),
            list_of(&from, "x.md").err().unwrap(),
            list_of(&from, "nada.txt").err().unwrap(),
            Manage::new("nada.txt".to_owned(), ManageAction::Remove)
                .and_then(|m| global.manage_global(&m))
                .unwrap_err(),
        ];
        for error in errors {
            let wire = serde_json::to_string(&error).unwrap();
            for root in [&from.0, &data.0] {
                assert!(!wire.contains(root.to_str().unwrap()), "{wire}");
            }
        }
    }

    /// O cabeçalho: a data em UTC e o nome do arquivo sem quebra de linha nem controle.
    #[test]
    fn the_header_is_a_safe_comment() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(20_766), (2026, 11, 9));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        let text = list_text("a\nb\u{202E}c\td.txt", &["x".to_owned()], (2026, 11, 9));
        assert_eq!(
            text,
            "# Importado de a\u{FFFD}b\u{FFFD}c\u{FFFD}d.txt em 2026-11-09\nx\n"
        );
    }
}
