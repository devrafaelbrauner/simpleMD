//! Busca no texto das notas (r37b; design-r37 §1–2; D-R37-1..3): o motor da porta Tauri, com as
//! regras do motor TS (`packages/vault/src/search.ts`), conferidas nos dois lados pela fixture
//! compartilhada `packages/vault/test/fixtures/search-fold.json`. Sem índice: o texto só passa pela
//! memória durante a busca, nada é gravado e o log leva só contagens.
//!
//! - Dobra por ponto de código (`fold`): NFD (`icu_normalizer`), sem as marcas (`\p{M}`,
//!   `icu_properties`) e em minúsculas sem contexto (`char::to_lowercase`). Casamento literal em
//!   cada linha, sem regex e sem colapsar espaços (D-R37-3). Cada linha é dobrada uma vez só, e o
//!   cancelamento é conferido também dentro da nota (AppSec r37a item 5).
//! - Percurso por descritor (AppSec r37a item 1): cada pasta é aberta pelo descritor da pasta-mãe
//!   (`openat` no Unix; `NtOpenFile` com `RootDirectory` no Windows) e listada pelo próprio
//!   descritor, e cada nota é aberta do mesmo jeito, sempre sem seguir link (`O_NOFOLLOW`;
//!   `FILE_OPEN_REPARSE_POINT`). Nenhum caminho abaixo da raiz é resolvido inteiro: uma pasta trocada
//!   por um link depois de listada (ou de aberta) não leva a nada fora do vault.
//! - Pulados e contados: ocultos (`.simplemd`, `.git`, temporários), links e junções, notas só na
//!   nuvem (`ops::is_cloud_only` no arquivo já aberto, antes de ler — vale também para a nota que
//!   saiu do disco entre a listagem e a abertura; AppSec r37a item 7), acima de 2 MiB, não UTF-8 e
//!   ilegíveis. No macOS a thread da busca não materializa arquivo sem dados: ler um que ficou só
//!   na nuvem no meio do caminho dá `EDEADLK`, nunca um download.
//! - Lotes de até 16 notas ou 50 ms (conferidos também antes de cada abertura), progresso a cada
//!   200 notas, `limit` notas (achar a `limit + 1` prova `truncated`). O cancelamento é conferido
//!   antes de cada pasta, de cada nota e de cada lote: depois dele nada mais sai, só o resumo.
//! - Uma busca por abertura (`ActiveVault::search`): uma nova, `vault_search_cancel` com o id dela
//!   ou a troca de pasta cancelam a anterior.

use std::fs::Metadata;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use icu_normalizer::DecomposingNormalizerBorrowed;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
use icu_properties::CodePointMapData;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use super::{blocking, ops, policy, VaultState};
use crate::error::AppError;

/// Consulta: até 256 pontos de código como digitada e, dobrada, ao menos 2.
const QUERY_MIN: usize = 2;
const QUERY_MAX: usize = 256;
/// Teto por nota: 2 MiB passa; 2 MiB + 1 → `tooLarge`, sem ler o conteúdo.
const NOTE_MAX_BYTES: u64 = 2 * 1024 * 1024;
/// Trechos por nota e teto da contagem de casamentos de uma nota.
const HITS_PER_NOTE: usize = 5;
const TOTAL_MAX: u32 = 999;
/// Notas com resultado antes de parar: até 500 (o provider manda 1 a 500; padrão 200).
const LIMIT_MAX: u32 = 500;
/// Contexto do trecho em unidades UTF-16 e quanto do casamento entra nele.
const CONTEXT_BEFORE: u32 = 40;
const CONTEXT_AFTER: u32 = 80;
const SNIPPET_MATCH_MAX: u32 = 256;
/// Lotes de até 16 notas ou 50 ms; progresso a cada 200 notas examinadas.
const BATCH_NOTES: usize = 16;
const BATCH_TIME: Duration = Duration::from_millis(50);
const PROGRESS_EVERY: u32 = 200;
/// Tamanho máximo de um caminho em unidades UTF-16, como o `toVaultPath` do TS (o `validate_rel`
/// conta pontos de código).
const PATH_MAX_UNITS: usize = 1024;
/// Pontos de código dobrados, ou candidatos descartados, entre duas conferências do cancelamento
/// dentro de uma linha.
const CANCEL_EVERY: usize = 4096;

/// Dobra de busca de um ponto de código fora do ASCII, acrescentada a `out`: NFD, sem as marcas
/// (`\p{M}`) e em minúsculas sem contexto (`Σ` → `σ` sempre; `İ` → `i`; `ß`, `ø` e `ς` ficam). Uma
/// marca solta some.
fn fold_non_ascii(c: char, out: &mut String) {
    let category = CodePointMapData::<GeneralCategory>::new();
    for d in DecomposingNormalizerBorrowed::new_nfd().normalize_iter(std::iter::once(c)) {
        if !GeneralCategoryGroup::Mark.contains(category.get(d)) {
            out.extend(d.to_lowercase());
        }
    }
}

/// `foldForSearch` do TS: cada ponto de código dobrado em separado (o ASCII só vai a minúsculas),
/// para a posição voltar ao original.
fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if c.is_ascii() {
            out.push(c.to_ascii_lowercase());
        } else {
            fold_non_ascii(c, &mut out);
        }
    }
    out
}

/// `checkSearchQuery` do TS: `Long` acima de 256 pontos de código como digitada (conferido
/// primeiro), `Short` com menos de 2 depois da dobra, senão a consulta dobrada. Uma `String` do Rust
/// é sempre bem formada: a consulta com substituto solto, que o TS recusa como `short`, nem chega
/// aqui (o IPC recusa o `\ud800` ao ler o JSON).
#[derive(Debug, PartialEq, Eq)]
enum Query {
    Ok(String),
    Short,
    Long,
}

fn check_query(query: &str) -> Query {
    if query.chars().nth(QUERY_MAX).is_some() {
        return Query::Long;
    }
    let folded = fold(query);
    if folded.chars().nth(QUERY_MIN - 1).is_none() {
        Query::Short
    } else {
        Query::Ok(folded)
    }
}

/// Consulta curta ou longa: o provider confere antes (`short`/`long` sem IPC); aqui é a defesa do
/// comando. O TS mapeia o código 1:1 (`toVaultError`).
fn invalid_query() -> AppError {
    AppError {
        code: "INVALID_QUERY",
        message: "Consulta de busca inválida.",
        detail: None,
    }
}

/// Um trecho: a posição em coordenadas do editor (linha 0-based sem o BOM, CRLF/CR/LF = 1 quebra;
/// `col`, `len` e `at` em unidades UTF-16 da linha) e o pedaço da linha original em volta dela.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    line: u32,
    col: u32,
    len: u32,
    text: String,
    at: u32,
    cut_before: bool,
    cut_after: bool,
}

/// Uma nota com resultado: caminho relativo POSIX, o total contado até 999 e até 5 trechos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Note {
    path: String,
    total: u32,
    hits: Vec<Hit>,
}

/// O que a busca pulou, por motivo (`TextSearchSkipped` do TS).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    hidden: u32,
    links: u32,
    cloud: u32,
    too_large: u32,
    not_utf8: u32,
    unreadable: u32,
}

/// O resumo (`TextSearchSummary` do TS): notas examinadas, entregues, se parou no `limit` ou num
/// cancelamento e o que foi pulado.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    scanned: u32,
    matched: u32,
    truncated: bool,
    cancelled: bool,
    skipped: Skipped,
}

/// Evento do canal de `vault_search_text`, na ordem: lotes `{ notes }` e `{ progress }` e, por
/// último, sempre (também depois de cancelar), `{ done }` com o resumo.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SearchEvent {
    Notes { notes: Vec<Note> },
    Progress { progress: u32 },
    Done { done: Summary },
}

/// A busca parou dentro de uma nota (cancelamento).
#[derive(Debug, PartialEq, Eq)]
struct Stopped;

/// Linhas como no editor (`codec.ts`): CRLF, CR e LF valem uma quebra cada; o que vem depois da
/// última quebra (vazio inclusive) é a última linha.
struct Lines<'a>(Option<&'a str>);

impl<'a> Iterator for Lines<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<&'a str> {
        let rest = self.0?;
        match rest.find(['\r', '\n']) {
            None => {
                self.0 = None;
                Some(rest)
            }
            Some(i) => {
                let skip = if rest[i..].starts_with("\r\n") { 2 } else { 1 };
                self.0 = Some(&rest[i + skip..]);
                Some(&rest[..i])
            }
        }
    }
}

/// Onde começa, na dobra da linha, a dobra de um ponto de código de dobra não vazia: o byte na
/// dobra, a unidade UTF-16 e o byte na linha original. Uma sequência ASCII vira um item só, de
/// `ascii` pontos de código (1 byte na dobra = 1 unidade = 1 byte na linha).
#[derive(Debug, Clone, Copy)]
struct Start {
    fold: u32,
    unit: u32,
    byte: u32,
    ascii: u32,
}

/// Vagas do cache de dobras.
const FOLD_SLOTS: usize = 4096;

/// A dobra de um ponto de código fora do ASCII já vista (até 4 pontos de código; a de um Hangul
/// tem 3). `key` `'\0'` = vaga vazia: o NUL é ASCII e nunca passa por aqui.
#[derive(Debug, Clone, Copy)]
struct Slot {
    key: char,
    len: u8,
    folded: [char; 4],
}

/// Dobras recentes por endereçamento direto (`ponto % 4.096`), para a busca inteira: memória fixa,
/// e um texto com muitos pontos distintos só deixa de aproveitá-lo — nunca dobra de novo o que já
/// dobrou nem zera tudo (o cache do TS zera ao passar de 8.192; AppSec r37a P3).
#[derive(Debug)]
struct FoldCache(Box<[Slot]>);

impl Default for FoldCache {
    fn default() -> Self {
        let empty = Slot {
            key: '\0',
            len: 0,
            folded: ['\0'; 4],
        };
        Self(vec![empty; FOLD_SLOTS].into_boxed_slice())
    }
}

impl FoldCache {
    /// `fold_non_ascii(c)` acrescentada a `out`, do cache quando possível.
    fn fold(&mut self, c: char, out: &mut String) {
        let slot = &mut self.0[c as usize % FOLD_SLOTS];
        if slot.key == c {
            out.extend(&slot.folded[..usize::from(slot.len)]);
            return;
        }
        let start = out.len();
        fold_non_ascii(c, out);
        let mut folded = ['\0'; 4];
        let mut len = 0;
        for d in out[start..].chars() {
            let Some(place) = folded.get_mut(len) else {
                return;
            };
            *place = d;
            len += 1;
        }
        *slot = Slot {
            key: c,
            len: len as u8,
            folded,
        };
    }
}

/// A dobra de uma linha e o caminho de volta ao original (os buffers e o cache servem a todas as
/// linhas). Os deslocamentos cabem em `u32`: a nota tem até 2 MiB, e a dobra de um ponto de código,
/// poucos bytes.
#[derive(Debug, Default)]
struct FoldedLine {
    text: String,
    starts: Vec<Start>,
    cache: FoldCache,
    /// Tamanho da linha em unidades UTF-16 e em bytes.
    units: u32,
    bytes: u32,
}

impl FoldedLine {
    /// Dobra `line`, uma vez só: cada trecho ASCII de uma vez e os outros pontos de código um a um
    /// (do cache), conferindo o cancelamento a cada 4.096 deles.
    fn fold(&mut self, line: &str, cancel: &AtomicBool) -> Result<(), Stopped> {
        self.text.clear();
        self.starts.clear();
        let bytes = line.as_bytes();
        let (mut at, mut unit, mut unchecked) = (0usize, 0u32, 0usize);
        while at < bytes.len() {
            if unchecked >= CANCEL_EVERY {
                unchecked = 0;
                if cancel.load(Ordering::Relaxed) {
                    return Err(Stopped);
                }
            }
            let fold_at = self.text.len();
            let ascii = bytes[at..]
                .iter()
                .position(|b| !b.is_ascii())
                .unwrap_or(bytes.len() - at);
            if ascii > 0 {
                self.text.push_str(&line[at..at + ascii]);
                self.text[fold_at..].make_ascii_lowercase();
                self.starts.push(Start {
                    fold: fold_at as u32,
                    unit,
                    byte: at as u32,
                    ascii: ascii as u32,
                });
                at += ascii;
                unit += ascii as u32;
                unchecked += ascii;
                continue;
            }
            let Some(c) = line[at..].chars().next() else {
                break;
            };
            self.cache.fold(c, &mut self.text);
            if self.text.len() > fold_at {
                self.starts.push(Start {
                    fold: fold_at as u32,
                    unit,
                    byte: at as u32,
                    ascii: 0,
                });
            }
            at += c.len_utf8();
            unit += c.len_utf16() as u32;
            unchecked += 1;
        }
        self.units = unit;
        self.bytes = bytes.len() as u32;
        Ok(())
    }

    /// O ponto de código cuja dobra começa no byte `at` da dobra, como `(unidade UTF-16, byte)` na
    /// linha; o fim da dobra é o fim da linha. `None` no meio da dobra de um ponto de código.
    fn origin(&self, at: usize) -> Option<(u32, u32)> {
        if at == self.text.len() {
            return Some((self.units, self.bytes));
        }
        let at = at as u32;
        let i = self
            .starts
            .partition_point(|s| s.fold <= at)
            .checked_sub(1)?;
        let s = self.starts[i];
        let offset = at - s.fold;
        if s.ascii > 0 {
            (offset < s.ascii).then_some((s.unit + offset, s.byte + offset))
        } else {
            (offset == 0).then_some((s.unit, s.byte))
        }
    }
}

/// A fronteira de ponto de código na unidade UTF-16 `target` da linha, andando a partir de
/// `(byte, unidade)`, uma fronteira conhecida: `(byte, unidade)`. Entre as duas metades de um par
/// substituto, vai ao fim dele (`forward`) ou ao começo.
fn boundary(line: &str, (byte, unit): (u32, u32), target: u32, forward: bool) -> (usize, u32) {
    let (mut byte, mut unit) = (byte as usize, unit);
    if target >= unit {
        for c in line[byte..].chars() {
            if unit == target {
                break;
            }
            let next = unit + c.len_utf16() as u32;
            if next > target {
                return if forward {
                    (byte + c.len_utf8(), next)
                } else {
                    (byte, unit)
                };
            }
            byte += c.len_utf8();
            unit = next;
        }
        return (byte, unit);
    }
    for c in line[..byte].chars().rev() {
        byte -= c.len_utf8();
        unit -= c.len_utf16() as u32;
        if unit == target {
            break;
        }
        if unit < target {
            return if forward {
                (byte + c.len_utf8(), unit + c.len_utf16() as u32)
            } else {
                (byte, unit)
            };
        }
    }
    (byte, unit)
}

/// O trecho do casamento que começa em `col` (byte `col_byte`) e termina na unidade `end`: 40
/// unidades antes e 80 depois (até 256 do casamento), sem partir par substituto.
fn hit_at(line: &str, n: usize, (col, col_byte): (u32, u32), end: u32, units: u32) -> Hit {
    let len = end - col;
    let (from_byte, from) = boundary(
        line,
        (col_byte, col),
        col.saturating_sub(CONTEXT_BEFORE),
        true,
    );
    let to_unit = units.min(col + len.min(SNIPPET_MATCH_MAX) + CONTEXT_AFTER);
    let (to_byte, to) = boundary(line, (col_byte, col), to_unit, false);
    Hit {
        line: n as u32,
        col,
        len,
        text: line[from_byte..to_byte].to_owned(),
        at: col - from,
        cut_before: from > 0,
        cut_after: to < units,
    }
}

/// Casamentos de `query` (já dobrada) numa nota decodificada, com BOM e CR/CRLF como no disco: o
/// total contado até 999 e os 5 primeiros trechos; `None` sem casamento. A dobra da consulta na
/// dobra da linha, sem sobreposição; começo ou fim no meio da dobra de um ponto de código ("하" em
/// "한") não é casamento, e a procura recomeça no ponto de código seguinte da dobra (a unidade
/// seguinte do TS), não depois do candidato.
fn match_note(
    text: &str,
    query: &str,
    line_fold: &mut FoldedLine,
    cancel: &AtomicBool,
) -> Result<Option<(u32, Vec<Hit>)>, Stopped> {
    if query.is_empty() {
        return Ok(None);
    }
    let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let mut hits = Vec::new();
    let mut total = 0u32;
    let mut candidates = 0usize;
    for (n, line) in Lines(Some(body)).enumerate() {
        if total >= TOTAL_MAX {
            break;
        }
        if cancel.load(Ordering::Relaxed) {
            return Err(Stopped);
        }
        line_fold.fold(line, cancel)?;
        let folded = line_fold.text.as_str();
        let mut from = 0;
        while total < TOTAL_MAX {
            let Some(found) = folded[from..].find(query) else {
                break;
            };
            candidates += 1;
            if candidates.is_multiple_of(CANCEL_EVERY) && cancel.load(Ordering::Relaxed) {
                return Err(Stopped);
            }
            let at = from + found;
            let end = at + query.len();
            match (line_fold.origin(at), line_fold.origin(end)) {
                (Some(start), Some((end_unit, _))) => {
                    total += 1;
                    if hits.len() < HITS_PER_NOTE {
                        hits.push(hit_at(line, n, start, end_unit, line_fold.units));
                    }
                    from = end;
                }
                _ => from = at + folded[at..].chars().next().map_or(1, char::len_utf8),
            }
        }
    }
    Ok((total > 0).then_some((total, hits)))
}

/// O caminho passa pela guarda do vault como está: `validate_rel` e até 1.024 unidades UTF-16 (o
/// `isGuarded` do TS, `toVaultPath(rel) === rel`).
fn guarded(rel: &str) -> bool {
    policy::validate_rel(rel, false).is_ok() && rel.encode_utf16().count() <= PATH_MAX_UNITS
}

/// Nome de nota: termina em `.md`, sem diferenciar caixa (o `MD_NAME` do TS).
fn is_note_name(name: &str) -> bool {
    name.len() > 3 && name.as_bytes()[name.len() - 3..].eq_ignore_ascii_case(b".md")
}

/// O tipo de um item pela própria listagem, sem seguir link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Link,
    /// FIFO, socket, dispositivo (só no Unix): nem lido nem contado.
    #[cfg(unix)]
    Other,
}

#[derive(Debug)]
struct Entry {
    name: String,
    kind: Kind,
}

/// Por que a abertura de um item falhou: um link no lugar (nunca seguido) ou outra falha.
#[derive(Debug)]
enum OpenError {
    Link,
    Io(io::Error),
}

/// Unix: cada abertura é um `openat` no descritor da pasta-mãe, sem seguir link no último (e
/// único) componente; a listagem lê o próprio descritor (`rustix`, sem `unsafe` aqui).
#[cfg(unix)]
mod dir {
    use std::fs::File;
    use std::io;
    use std::os::fd::OwnedFd;
    use std::path::Path;

    use rustix::fs::{openat, statat, AtFlags, Dir as Listing, FileType, Mode, OFlags, CWD};
    use rustix::io::Errno;

    use super::{Entry, Kind, OpenError};

    /// Uma pasta aberta: o que há nela só é alcançado por este descritor.
    #[derive(Debug)]
    pub(super) struct Dir(OwnedFd);

    impl Dir {
        /// A raiz da abertura, como os outros comandos a usam (`pick_vault` a canonicaliza).
        pub(super) fn open_root(root: &Path) -> io::Result<Self> {
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC;
            Ok(Self(openat(CWD, root, flags, Mode::empty())?))
        }

        /// Com `O_DIRECTORY`, o macOS recusa um link no lugar com `ENOTDIR` (o Linux, com
        /// `ELOOP`): nesse caso o `fstatat` sem seguir link diz se era um link.
        pub(super) fn open_dir(&self, name: &str) -> Result<Self, OpenError> {
            let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
            match openat(&self.0, name, flags, Mode::empty()) {
                Ok(fd) => Ok(Self(fd)),
                Err(Errno::NOTDIR)
                    if statat(&self.0, name, AtFlags::SYMLINK_NOFOLLOW).is_ok_and(|stat| {
                        FileType::from_raw_mode(stat.st_mode) == FileType::Symlink
                    }) =>
                {
                    Err(OpenError::Link)
                }
                Err(error) => Err(opened(error)),
            }
        }

        /// `NONBLOCK`: um FIFO posto no lugar da nota não prende a abertura.
        pub(super) fn open_file(&self, name: &str) -> Result<File, OpenError> {
            let flags = OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC;
            openat(&self.0, name, flags, Mode::empty())
                .map(File::from)
                .map_err(opened)
        }

        /// Os itens da pasta (sem `.` e `..`; nome que não é UTF-8 fica de fora, como na listagem
        /// do gateway), com o tipo do `d_type` ou, sem ele, do `fstatat` sem seguir link.
        pub(super) fn entries(&self) -> io::Result<Vec<Entry>> {
            let mut entries = Vec::new();
            for entry in Listing::read_from(&self.0)? {
                let entry = entry?;
                let Ok(name) = entry.file_name().to_str() else {
                    continue;
                };
                if name == "." || name == ".." {
                    continue;
                }
                let file_type = match entry.file_type() {
                    FileType::Unknown => match statat(&self.0, name, AtFlags::SYMLINK_NOFOLLOW) {
                        Ok(stat) => FileType::from_raw_mode(stat.st_mode),
                        // Sumiu no meio da listagem (CR2-04): fica de fora.
                        Err(Errno::NOENT) => continue,
                        Err(error) => return Err(error.into()),
                    },
                    known => known,
                };
                let kind = match file_type {
                    FileType::Directory => Kind::Dir,
                    FileType::RegularFile => Kind::File,
                    FileType::Symlink => Kind::Link,
                    _ => Kind::Other,
                };
                entries.push(Entry {
                    name: name.to_owned(),
                    kind,
                });
            }
            Ok(entries)
        }
    }

    /// Link no lugar: `O_NOFOLLOW` dá `ELOOP` (`EMLINK` no FreeBSD).
    fn opened(error: Errno) -> OpenError {
        if error == Errno::LOOP || error == Errno::MLINK {
            OpenError::Link
        } else {
            OpenError::Io(error.into())
        }
    }
}

/// Windows: cada abertura é um `NtOpenFile` relativo ao handle da pasta-mãe (`RootDirectory`, o
/// `openat` do Windows; a técnica do `remove_dir_all` da std), com `FILE_OPEN_REPARSE_POINT` (um
/// link ou junção no lugar é aberto como ele mesmo, e o `metadata` o reconhece) e
/// `OBJ_DONT_REPARSE`. A listagem lê o próprio handle (`GetFileInformationByHandleEx`).
#[cfg(windows)]
mod dir {
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::mem::offset_of;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::Path;
    use std::ptr;
    use std::sync::atomic::{AtomicU32, Ordering};

    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        NtOpenFile, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Foundation::{
        RtlNtStatusToDosError, ERROR_NO_MORE_FILES, HANDLE, NTSTATUS, OBJ_DONT_REPARSE,
        STATUS_INVALID_PARAMETER, UNICODE_STRING,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdBothDirectoryInfo, FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_GENERIC_READ, FILE_ID_BOTH_DIR_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    use super::{Entry, Kind, OpenError};

    /// `OBJ_DONT_REPARSE` (Windows 10 1709+): nenhum ponto de reparse no nome é seguido. Num
    /// Windows sem ele (`STATUS_INVALID_PARAMETER`), as aberturas seguintes vão sem; o
    /// `FILE_OPEN_REPARSE_POINT` continua valendo.
    static ATTRIBUTES: AtomicU32 = AtomicU32::new(OBJ_DONT_REPARSE);
    /// Marca de reparse de "substituto de nome" (link simbólico, junção):
    /// `IsReparseTagNameSurrogate`, o mesmo `is_symlink` da std.
    const NAME_SURROGATE: u32 = 0x2000_0000;
    /// Buffer da listagem: 64 KiB alinhados em 8 (os campos de 8 bytes da entrada).
    const LISTING_WORDS: usize = 8 * 1024;

    /// Uma pasta aberta: o que há nela só é alcançado por este handle.
    #[derive(Debug)]
    pub(super) struct Dir(File);

    impl Dir {
        /// A raiz da abertura, pelo caminho, como os outros comandos a usam.
        pub(super) fn open_root(root: &Path) -> io::Result<Self> {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(root)?;
            if !file.metadata()?.is_dir() {
                return Err(io::Error::from(io::ErrorKind::NotADirectory));
            }
            Ok(Self(file))
        }

        pub(super) fn open_dir(&self, name: &str) -> Result<Self, OpenError> {
            let file = self.open(name)?;
            let meta = file.metadata().map_err(OpenError::Io)?;
            if meta.file_type().is_symlink() {
                return Err(OpenError::Link);
            }
            if !meta.is_dir() {
                return Err(OpenError::Io(io::Error::from(io::ErrorKind::NotADirectory)));
            }
            Ok(Self(file))
        }

        /// O próprio link, se houver um no lugar: quem chama confere pelo `metadata` (link, arquivo
        /// comum, nuvem) antes de ler.
        pub(super) fn open_file(&self, name: &str) -> Result<File, OpenError> {
            self.open(name)
        }

        fn open(&self, name: &str) -> Result<File, OpenError> {
            let wide: Vec<u16> = name.encode_utf16().collect();
            let length = u16::try_from(wide.len() * 2)
                .map_err(|_| OpenError::Io(io::Error::from(io::ErrorKind::InvalidInput)))?;
            let object_name = UNICODE_STRING {
                Length: length,
                MaximumLength: length,
                Buffer: wide.as_ptr().cast_mut(),
            };
            let mut attributes = OBJECT_ATTRIBUTES {
                Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
                RootDirectory: self.0.as_raw_handle(),
                ObjectName: &object_name,
                Attributes: ATTRIBUTES.load(Ordering::Relaxed),
                SecurityDescriptor: ptr::null(),
                SecurityQualityOfService: ptr::null(),
            };
            let mut opened = nt_open(&attributes);
            if opened.as_ref().err() == Some(&STATUS_INVALID_PARAMETER)
                && attributes.Attributes == OBJ_DONT_REPARSE
            {
                ATTRIBUTES.store(0, Ordering::Relaxed);
                attributes.Attributes = 0;
                opened = nt_open(&attributes);
            }
            opened.map_err(|status| {
                // SAFETY: só converte o código; nenhum ponteiro.
                // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
                let code = unsafe { RtlNtStatusToDosError(status) };
                OpenError::Io(io::Error::from_raw_os_error(code as i32))
            })
        }

        /// Os itens da pasta (sem `.` e `..`; nome que não é UTF-16 bem formado fica de fora), com
        /// o tipo dos atributos da própria listagem: reparse de substituto de nome → link.
        pub(super) fn entries(&self) -> io::Result<Vec<Entry>> {
            let mut buffer = vec![0u64; LISTING_WORDS];
            let size = (LISTING_WORDS * size_of::<u64>()) as u32;
            let mut class = FileIdBothDirectoryRestartInfo;
            let mut entries = Vec::new();
            loop {
                // SAFETY: o buffer tem `size` bytes graváveis, alinhados em 8; o handle é desta
                // pasta e fica aberto durante a chamada.
                // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
                let ok = unsafe {
                    GetFileInformationByHandleEx(
                        self.0.as_raw_handle(),
                        class,
                        buffer.as_mut_ptr().cast(),
                        size,
                    )
                };
                if ok == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                        return Ok(entries);
                    }
                    return Err(error);
                }
                class = FileIdBothDirectoryInfo;
                // SAFETY: a mesma memória do `Vec<u64>`, vista como bytes (alinhamento 1).
                // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
                let bytes = unsafe {
                    std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), size as usize)
                };
                parse(bytes, &mut entries);
            }
        }
    }

    /// Um `NtOpenFile` para leitura, sem bloquear ninguém (todos os compartilhamentos).
    fn nt_open(attributes: &OBJECT_ATTRIBUTES) -> Result<File, NTSTATUS> {
        let mut handle: HANDLE = ptr::null_mut();
        let mut status_block = IO_STATUS_BLOCK::default();
        // SAFETY: os ponteiros de `attributes` (nome e raiz) valem durante a chamada; o handle de
        // uma abertura que deu certo passa a ser só deste `File`.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let status = unsafe {
            NtOpenFile(
                &mut handle,
                FILE_GENERIC_READ,
                attributes,
                &mut status_block,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
            )
        };
        if status < 0 {
            return Err(status);
        }
        // SAFETY: `NtOpenFile` deu certo: `handle` é um handle aberto que ninguém mais fecha.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
        let word = bytes.get(at..at + 4)?;
        Some(u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
    }

    /// As entradas de um lote (`FILE_ID_BOTH_DIR_INFO` encadeadas por `NextEntryOffset`), sem
    /// passar do fim do buffer.
    fn parse(bytes: &[u8], entries: &mut Vec<Entry>) {
        let name_at = offset_of!(FILE_ID_BOTH_DIR_INFO, FileName);
        let mut offset = 0usize;
        while let Some(info) = bytes.get(offset..) {
            let field = |at: usize| u32_at(info, at);
            let (Some(next), Some(attributes), Some(length), Some(tag)) = (
                field(offset_of!(FILE_ID_BOTH_DIR_INFO, NextEntryOffset)),
                field(offset_of!(FILE_ID_BOTH_DIR_INFO, FileAttributes)),
                field(offset_of!(FILE_ID_BOTH_DIR_INFO, FileNameLength)),
                // Com `FILE_ATTRIBUTE_REPARSE_POINT`, o `EaSize` traz a marca de reparse.
                field(offset_of!(FILE_ID_BOTH_DIR_INFO, EaSize)),
            ) else {
                return;
            };
            let Some(name) = info.get(name_at..name_at + length as usize) else {
                return;
            };
            let units: Vec<u16> = name
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&pair| u16::from_le_bytes(pair))
                .collect();
            if let Ok(name) = String::from_utf16(&units) {
                if name != "." && name != ".." {
                    let kind = if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                        && tag & NAME_SURROGATE != 0
                    {
                        Kind::Link
                    } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                        Kind::Dir
                    } else {
                        Kind::File
                    };
                    entries.push(Entry { name, kind });
                }
            }
            if next == 0 {
                return;
            }
            offset += next as usize;
        }
    }
}

/// macOS: enquanto vive, a thread não materializa arquivo nem pasta sem dados (`SF_DATALESS`):
/// ler um deles dá `EDEADLK` em vez de baixá-lo (`setiopolicy_np(3)`,
/// `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`, `sys/resource.h`). Ao sair, volta a política
/// anterior: a thread de bloqueio é reaproveitada por outros comandos.
#[cfg(target_os = "macos")]
mod materialize {
    use std::os::raw::c_int;

    const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: c_int = 3;
    const IOPOL_SCOPE_THREAD: c_int = 1;
    pub(super) const IOPOL_MATERIALIZE_DATALESS_FILES_OFF: c_int = 1;

    extern "C" {
        fn getiopolicy_np(iotype: c_int, scope: c_int) -> c_int;
        fn setiopolicy_np(iotype: c_int, scope: c_int, policy: c_int) -> c_int;
    }

    /// A política desta thread (`-1` numa falha).
    pub(super) fn current() -> c_int {
        // SAFETY: só lê a política de E/S desta thread; nenhum ponteiro.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        unsafe {
            getiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
            )
        }
    }

    fn set(policy: c_int) -> bool {
        // SAFETY: só troca a política de E/S desta thread; nenhum ponteiro.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let result = unsafe {
            setiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
                policy,
            )
        };
        result == 0
    }

    /// A materialização desligada nesta thread até o `drop`.
    #[derive(Debug)]
    pub(super) struct Off(Option<c_int>);

    impl Off {
        pub(super) fn new() -> Self {
            let previous = current();
            Self((previous >= 0 && set(IOPOL_MATERIALIZE_DATALESS_FILES_OFF)).then_some(previous))
        }
    }

    impl Drop for Off {
        fn drop(&mut self) {
            if let Some(previous) = self.0 {
                set(previous);
            }
        }
    }
}

/// Ler um arquivo sem dados com a materialização desligada nesta thread (macOS): `EDEADLK`.
fn dataless(error: &io::Error) -> bool {
    #[cfg(target_os = "macos")]
    {
        error.raw_os_error() == Some(libc::EDEADLK)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = error;
        false
    }
}

/// O que o sistema diz de cada item; os testes trocam para simular a nuvem e as corridas.
trait Probe {
    /// Só na nuvem, pelo arquivo já aberto e antes de ler (o contrato da r36b).
    fn cloud_only(&self, _rel: &str, meta: &Metadata) -> bool {
        ops::is_cloud_only(meta)
    }

    /// Entre listar a pasta-mãe e abrir o item `rel`.
    fn before_open(&self, _rel: &str) {}
}

/// O sistema de verdade.
struct System;

impl Probe for System {}

/// Uma pasta ainda por visitar: aberta, quando chegar a vez dela, pelo descritor da mãe.
struct Pending {
    parent: Rc<dir::Dir>,
    name: String,
    rel: String,
}

/// O resultado da leitura de uma nota.
enum NoteRead {
    /// Os bytes, em `Walk::bytes`.
    Bytes,
    Links,
    TooLarge,
    Unreadable,
    /// Só na nuvem no arquivo aberto (ou `EDEADLK` ao ler): nunca baixada.
    Cloud,
}

/// O percurso de uma busca.
struct Walk<'a, P: Probe> {
    query: &'a str,
    limit: u32,
    cancel: &'a AtomicBool,
    probe: &'a P,
    emit: &'a mut dyn FnMut(SearchEvent) -> bool,
    summary: Summary,
    batch: Vec<Note>,
    flushed_at: Instant,
    stopped: bool,
    pending: Vec<Pending>,
    line: FoldedLine,
    bytes: Vec<u8>,
}

impl<P: Probe> Walk<'_, P> {
    /// Cancelada: o lote pendente sai do caminho, nada mais é enviado e o resumo diz `cancelled`.
    fn cancelled(&mut self) -> bool {
        if self.cancel.load(Ordering::Relaxed) {
            self.summary.cancelled = true;
            self.stopped = true;
            self.batch.clear();
        }
        self.summary.cancelled
    }

    fn send(&mut self, event: SearchEvent) {
        // O webview que esperava os eventos foi embora: para como num cancelamento.
        if !(self.emit)(event) {
            self.summary.cancelled = true;
            self.stopped = true;
            self.batch.clear();
        }
    }

    fn flush(&mut self) {
        if self.batch.is_empty() || self.cancelled() {
            return;
        }
        let notes = std::mem::take(&mut self.batch);
        self.summary.matched += notes.len() as u32;
        self.flushed_at = Instant::now();
        self.send(SearchEvent::Notes { notes });
    }

    /// O lote que espera há 50 ms sai antes da próxima abertura (que pode demorar).
    fn flush_if_due(&mut self) {
        if !self.batch.is_empty() && self.flushed_at.elapsed() >= BATCH_TIME {
            self.flush();
        }
    }

    /// As entradas de uma pasta já aberta, nesta ordem: em cada pasta, as notas pela ordem dos
    /// pontos de código do nome e depois as subpastas (que vão para a pilha).
    fn visit(&mut self, dir: Rc<dir::Dir>, rel: &str, mut entries: Vec<Entry>) {
        entries.sort_unstable_by(|a, b| a.name.cmp(&b.name));
        let mut subdirs = Vec::new();
        for Entry { name, kind } in entries {
            if name.starts_with('.') {
                self.summary.skipped.hidden += 1;
                continue;
            }
            let child = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            match kind {
                Kind::Link => self.summary.skipped.links += 1,
                Kind::Dir if guarded(&child) => subdirs.push((name, child)),
                Kind::File if is_note_name(&name) && guarded(&child) => {
                    if self.cancelled() {
                        return;
                    }
                    self.note(&dir, &name, child);
                    if self.stopped {
                        return;
                    }
                }
                _ => {}
            }
        }
        for (name, rel) in subdirs.into_iter().rev() {
            self.pending.push(Pending {
                parent: Rc::clone(&dir),
                name,
                rel,
            });
        }
    }

    /// Abre e lê uma nota sem seguir link, conferindo no arquivo aberto o tipo, a nuvem e o teto
    /// antes de ler; a leitura para em 2 MiB + 1.
    fn read(&mut self, dir: &dir::Dir, name: &str, rel: &str) -> NoteRead {
        let file = match dir.open_file(name) {
            Ok(file) => file,
            Err(OpenError::Link) => return NoteRead::Links,
            Err(OpenError::Io(error)) if dataless(&error) => return NoteRead::Cloud,
            Err(OpenError::Io(_)) => return NoteRead::Unreadable,
        };
        let Ok(meta) = file.metadata() else {
            return NoteRead::Unreadable;
        };
        if meta.file_type().is_symlink() {
            return NoteRead::Links;
        }
        if !meta.is_file() {
            return NoteRead::Unreadable;
        }
        if self.probe.cloud_only(rel, &meta) {
            return NoteRead::Cloud;
        }
        if meta.len() > NOTE_MAX_BYTES {
            return NoteRead::TooLarge;
        }
        self.bytes.clear();
        match (&file)
            .take(NOTE_MAX_BYTES + 1)
            .read_to_end(&mut self.bytes)
        {
            Err(error) if dataless(&error) => NoteRead::Cloud,
            Err(_) => NoteRead::Unreadable,
            Ok(_) if self.bytes.len() as u64 > NOTE_MAX_BYTES => NoteRead::TooLarge,
            Ok(_) => NoteRead::Bytes,
        }
    }

    /// Examina uma nota (a ordem do `examine` do TS): conta, casa, guarda no lote, avisa o
    /// progresso e envia o lote cheio ou vencido.
    fn note(&mut self, dir: &dir::Dir, name: &str, rel: String) {
        self.flush_if_due();
        if self.stopped {
            return;
        }
        self.probe.before_open(&rel);
        let read = self.read(dir, name, &rel);
        if let NoteRead::Cloud = read {
            self.summary.skipped.cloud += 1;
            return;
        }
        self.summary.scanned += 1;
        let skipped = &mut self.summary.skipped;
        let found = match read {
            NoteRead::Links => {
                skipped.links += 1;
                Ok(None)
            }
            NoteRead::TooLarge => {
                skipped.too_large += 1;
                Ok(None)
            }
            NoteRead::Unreadable | NoteRead::Cloud => {
                skipped.unreadable += 1;
                Ok(None)
            }
            NoteRead::Bytes => match std::str::from_utf8(&self.bytes) {
                Ok(text) => match_note(text, self.query, &mut self.line, self.cancel),
                Err(_) => {
                    skipped.not_utf8 += 1;
                    Ok(None)
                }
            },
        };
        match found {
            Err(Stopped) => {
                self.cancelled();
                return;
            }
            Ok(Some((total, hits))) => {
                if self.summary.matched + self.batch.len() as u32 >= self.limit {
                    self.summary.truncated = true;
                    self.stopped = true;
                    return;
                }
                self.batch.push(Note {
                    path: rel,
                    total,
                    hits,
                });
            }
            Ok(None) => {}
        }
        if self.summary.scanned.is_multiple_of(PROGRESS_EVERY) && !self.cancelled() {
            self.send(SearchEvent::Progress {
                progress: self.summary.scanned,
            });
        }
        if self.batch.len() >= BATCH_NOTES {
            self.flush();
        } else {
            self.flush_if_due();
        }
    }
}

/// Percorre a pasta `root` em profundidade atrás de `query` (já dobrada): em cada pasta, as notas
/// e depois as subpastas, pela ordem dos pontos de código do nome; até `limit` notas (1 a 500).
/// Os eventos saem por `emit` (`false` = ninguém mais ouve: para). Falha ao abrir ou listar a raiz
/// → erro; uma subpasta ilegível conta como `unreadable`.
fn run<P: Probe>(
    root: &Path,
    query: &str,
    limit: u32,
    cancel: &AtomicBool,
    probe: &P,
    emit: &mut dyn FnMut(SearchEvent) -> bool,
) -> Result<Summary, AppError> {
    let mut walk = Walk {
        query,
        limit: limit.clamp(1, LIMIT_MAX),
        cancel,
        probe,
        emit,
        summary: Summary::default(),
        batch: Vec::new(),
        flushed_at: Instant::now(),
        stopped: false,
        pending: Vec::new(),
        line: FoldedLine::default(),
        bytes: Vec::new(),
    };
    if !walk.cancelled() {
        let root = dir::Dir::open_root(root).map_err(|e| AppError::io(&e))?;
        let entries = root.entries().map_err(|e| AppError::io(&e))?;
        walk.visit(Rc::new(root), "", entries);
    }
    while !walk.stopped {
        let Some(Pending { parent, name, rel }) = walk.pending.pop() else {
            break;
        };
        if walk.cancelled() {
            break;
        }
        walk.flush_if_due();
        walk.probe.before_open(&rel);
        let dir = match parent.open_dir(&name) {
            Ok(dir) => dir,
            Err(OpenError::Link) => {
                walk.summary.skipped.links += 1;
                continue;
            }
            // Pasta sem dados (macOS, materialização desligada): o que há nela está só na nuvem.
            Err(OpenError::Io(error)) if dataless(&error) => {
                walk.summary.skipped.cloud += 1;
                continue;
            }
            Err(OpenError::Io(_)) => {
                walk.summary.skipped.unreadable += 1;
                continue;
            }
        };
        drop(parent);
        match dir.entries() {
            Ok(entries) => walk.visit(Rc::new(dir), &rel, entries),
            Err(_) => walk.summary.skipped.unreadable += 1,
        }
    }
    if !walk.summary.cancelled {
        walk.flush();
    }
    Ok(walk.summary)
}

/// A busca de uma abertura (no máximo uma, em `ActiveVault::search`): o id que
/// `vault_search_cancel` aceita e o sinal. Sair da vaga (busca nova, cancelamento, troca de pasta,
/// fim) liga o sinal.
#[derive(Debug)]
pub(super) struct Running {
    id: u32,
    cancel: Arc<AtomicBool>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl VaultState {
    /// Começa a busca `id` na abertura `token` (o primeiro uso de uma pendente a ativa): a busca
    /// anterior desta abertura é cancelada. A raiz e o sinal da nova; pasta trocada nesse meio-tempo
    /// → `VAULT_CLOSED`, como em `install`.
    fn begin_search(&self, token: u32, id: u32) -> Result<(PathBuf, Arc<AtomicBool>), AppError> {
        let root = self.root(token)?;
        let cancel = Arc::new(AtomicBool::new(false));
        let previous = self.lock().active_for(token)?.search.replace(Running {
            id,
            cancel: Arc::clone(&cancel),
        });
        drop(previous);
        Ok((root, cancel))
    }

    /// Fim da busca: a vaga é liberada se ainda for dela.
    fn end_search(&self, cancel: &Arc<AtomicBool>) {
        let finished = self.lock().active.as_mut().and_then(|active| {
            active
                .search
                .take_if(|running| Arc::ptr_eq(&running.cancel, cancel))
        });
        drop(finished);
    }

    /// `vault_search_cancel`: cancela a busca `id` se for a atual; um id antigo não faz nada.
    fn cancel_search(&self, id: u32) {
        let cancelled = self
            .lock()
            .active
            .as_mut()
            .and_then(|active| active.search.take_if(|running| running.id == id));
        drop(cancelled);
    }
}

/// A busca inteira numa thread de bloqueio: ocupa a vaga, percorre (no macOS sem materializar
/// arquivo sem dados), libera a vaga e manda o resumo, sempre por último. O log leva só contagens.
fn search<P: Probe>(
    state: &VaultState,
    token: u32,
    id: u32,
    query: &str,
    limit: u32,
    channel: &Channel<SearchEvent>,
    probe: &P,
) -> Result<(), AppError> {
    let (root, cancel) = state.begin_search(token, id)?;
    let result = {
        #[cfg(target_os = "macos")]
        let _no_download = materialize::Off::new();
        run(&root, query, limit, &cancel, probe, &mut |event| {
            channel.send(event).is_ok()
        })
    };
    state.end_search(&cancel);
    let summary = result?;
    let Summary {
        scanned,
        matched,
        truncated,
        cancelled,
        skipped: ref s,
    } = summary;
    println!(
        "vault: search_text -> {scanned} lidas, {matched} com resultado, truncated {truncated}, cancelled {cancelled}, puladas {}/{}/{}/{}/{}/{}",
        s.hidden, s.links, s.cloud, s.too_large, s.not_utf8, s.unreadable
    );
    let _ = channel.send(SearchEvent::Done { done: summary });
    Ok(())
}

/// Busca no texto das notas da abertura `token` (design-r37 §2): a consulta como digitada (até 256
/// pontos de código; dobrada, ao menos 2: senão `INVALID_QUERY`), até `limit` notas (1 a 500). Os
/// resultados vêm pelo canal (`SearchEvent`), em lotes, e terminam com `{ done }`; o comando volta
/// depois do resumo. Uma busca por abertura: a nova cancela a anterior, e `vault_search_cancel`
/// com `search_id` ou a troca de pasta cancelam esta.
#[tauri::command]
pub async fn vault_search_text(
    state: State<'_, VaultState>,
    token: u32,
    search_id: u32,
    query: String,
    limit: u32,
    on_event: Channel<SearchEvent>,
) -> Result<(), AppError> {
    let Query::Ok(folded) = check_query(&query) else {
        return Err(invalid_query());
    };
    let state = state.inner().clone();
    blocking(move || search(&state, token, search_id, &folded, limit, &on_event, &System)).await
}

/// Cancela a busca `search_id` se for a atual; senão nada. Ela termina com `{ done }` e `cancelled`.
#[tauri::command]
pub async fn vault_search_cancel(
    state: State<'_, VaultState>,
    search_id: u32,
) -> Result<(), AppError> {
    let state = state.inner().clone();
    blocking(move || {
        state.cancel_search(search_id);
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;
    use std::fs;
    use std::sync::{mpsc, Mutex};

    use serde::Deserialize;
    use serde_json::{json, Value};
    use tauri::ipc::InvokeResponseBody;

    /// A fixture compartilhada com o Vitest (`search.test.ts`), lida em tempo de compilação.
    const FIXTURE: &str =
        include_str!("../../../../../packages/vault/test/fixtures/search-fold.json");
    const TERM: &str = "segredo";
    const MAX: usize = NOTE_MAX_BYTES as usize;

    #[derive(Deserialize)]
    struct Fixture {
        fold: Vec<FoldCase>,
        queries: Vec<QueryCase>,
        notes: Vec<NoteCase>,
    }

    #[derive(Deserialize)]
    struct FoldCase {
        input: String,
        folded: String,
    }

    /// `units`: as unidades UTF-16 de uma consulta com substituto solto, que o JSON do Rust (e o
    /// IPC) não carrega como texto.
    #[derive(Deserialize)]
    struct QueryCase {
        query: Option<String>,
        units: Option<Vec<u16>>,
        repeat: Option<usize>,
        result: String,
    }

    #[derive(Deserialize)]
    struct NoteCase {
        name: String,
        text: String,
        query: String,
        total: u32,
        hits: Vec<Hit>,
    }

    fn fixture() -> Fixture {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn status(query: &str) -> &'static str {
        match check_query(query) {
            Query::Ok(_) => "ok",
            Query::Short => "short",
            Query::Long => "long",
        }
    }

    fn folded(query: &str) -> String {
        match check_query(query) {
            Query::Ok(folded) => folded,
            other => panic!("consulta {query:?} inválida: {other:?}"),
        }
    }

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    /// AC-R37B-1: a dobra de cada caso da fixture é a do motor TS.
    #[test]
    fn fixture_fold_matches_the_ts_engine() {
        let cases = fixture().fold;
        assert!(cases.len() >= 17);
        let wrong: Vec<String> = cases
            .iter()
            .filter(|case| fold(&case.input) != case.folded)
            .map(|case| {
                format!(
                    "{:?} → {:?} ≠ {:?}",
                    case.input,
                    fold(&case.input),
                    case.folded
                )
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// AC-R37B-1: `ok`/`short`/`long` de cada consulta da fixture; a de substituto solto nem vira
    /// `String` (o TS diz `short` antes de qualquer IPC).
    #[test]
    fn fixture_queries_match_the_ts_engine() {
        let cases = fixture().queries;
        assert!(cases.len() >= 16);
        let mut lone = 0;
        for case in cases {
            match (&case.query, &case.units) {
                (Some(query), None) => {
                    let query = query.repeat(case.repeat.unwrap_or(1));
                    assert_eq!(status(&query), case.result, "{query:?}");
                }
                (None, Some(units)) => {
                    assert!(String::from_utf16(units).is_err(), "{units:?}");
                    assert_eq!(case.result, "short", "{units:?}");
                    lone += 1;
                }
                _ => panic!("caso de consulta sem `query` nem `units`"),
            }
        }
        assert!(lone >= 1, "a fixture perdeu o caso do substituto solto");
    }

    /// AC-R37B-1: total, linha, coluna, tamanho e trecho de cada nota da fixture, iguais aos do TS
    /// (inclusive o caso que separa "recomeça na unidade seguinte" de `match_indices`).
    #[test]
    fn fixture_notes_match_the_ts_engine() {
        let cases = fixture().notes;
        assert!(cases.len() >= 14);
        let mut line = FoldedLine::default();
        let cancel = AtomicBool::new(false);
        for case in cases {
            let found = match_note(&case.text, &folded(&case.query), &mut line, &cancel).unwrap();
            let expected = (case.total > 0).then(|| (case.total, case.hits.clone()));
            assert_eq!(found, expected, "{}", case.name);
        }
    }

    #[test]
    fn total_stops_at_999_with_5_hits() {
        let text = "ab ".repeat(1200);
        let (total, hits) = match_note(
            &text,
            "ab",
            &mut FoldedLine::default(),
            &AtomicBool::new(false),
        )
        .unwrap()
        .unwrap();
        assert_eq!((total, hits.len()), (999, 5));
    }

    /// AppSec r37a item 5: o cancelamento é conferido dentro da nota — a cada linha e, numa linha
    /// só de 2 MiB, no meio da dobra e dos candidatos.
    #[test]
    fn cancel_is_checked_inside_a_note() {
        let cancel = AtomicBool::new(true);
        let line = "한".repeat(MAX / 3);
        assert_eq!(FoldedLine::default().fold(&line, &cancel), Err(Stopped));
        let text = format!("primeira\n{line}");
        assert_eq!(
            match_note(&text, "한국", &mut FoldedLine::default(), &cancel),
            Err(Stopped)
        );
        // Sem cancelamento, a mesma linha vai até o fim: "ᆫᄒ" casa só desalinhado (descartado).
        let open = AtomicBool::new(false);
        assert_eq!(
            match_note(
                &text,
                &folded("\u{11AB}\u{1112}"),
                &mut FoldedLine::default(),
                &open
            ),
            Ok(None)
        );
    }

    #[test]
    fn guard_counts_utf16_units_like_to_vault_path() {
        let astral = format!("{}.md", "😀".repeat(511));
        assert_eq!(astral.encode_utf16().count(), 1025);
        assert!(
            policy::validate_rel(&astral, false).is_ok(),
            "o Rust conta pontos de código"
        );
        assert!(!guarded(&astral));
        assert!(guarded(&format!("{}.md", "😀".repeat(510))));
        for (name, note) in [
            ("a.md", true),
            ("A.MD", true),
            ("é.Md", true),
            (".md", false),
        ] {
            assert_eq!(is_note_name(name), note, "{name}");
        }
        assert!(!is_note_name("a.markdown"));
    }

    /// O sistema de verdade, com as notas "só na nuvem" que o teste escolhe (o `SF_DATALESS` e o
    /// `RECALL_ON_DATA_ACCESS` só o cliente de sincronização liga).
    struct Cloud(&'static [&'static str]);

    impl Probe for Cloud {
        fn cloud_only(&self, rel: &str, meta: &Metadata) -> bool {
            ops::is_cloud_only(meta) || self.0.contains(&rel)
        }
    }

    /// Uma ação do teste entre listar a pasta-mãe e abrir o item (as corridas).
    struct Before<F: Fn(&str)>(F);

    impl<F: Fn(&str)> Probe for Before<F> {
        fn before_open(&self, rel: &str) {
            (self.0)(rel);
        }
    }

    #[derive(Debug, Default)]
    struct Events {
        batches: Vec<Vec<Note>>,
        progress: Vec<u32>,
    }

    impl Events {
        fn paths(&self) -> Vec<&str> {
            self.batches
                .iter()
                .flatten()
                .map(|note| note.path.as_str())
                .collect()
        }

        fn note(&self, path: &str) -> &Note {
            self.batches
                .iter()
                .flatten()
                .find(|note| note.path == path)
                .unwrap()
        }
    }

    /// `run` com a consulta como digitada, guardando os eventos (o `done` sai do comando).
    fn search_in(
        root: &Path,
        query: &str,
        limit: u32,
        cancel: &AtomicBool,
        probe: &impl Probe,
    ) -> (Summary, Events) {
        let mut events = Events::default();
        let summary = run(root, &folded(query), limit, cancel, probe, &mut |event| {
            match event {
                SearchEvent::Notes { notes } => events.batches.push(notes),
                SearchEvent::Progress { progress } => events.progress.push(progress),
                SearchEvent::Done { .. } => panic!("o resumo sai de `search`"),
            }
            true
        })
        .unwrap();
        (summary, events)
    }

    fn open() -> AtomicBool {
        AtomicBool::new(false)
    }

    /// Link de pasta: simbólico no Unix, junção no Windows (sem privilégio).
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(made.status.success(), "mklink /J");
        }
    }

    /// Link de arquivo; `false` no Windows sem o privilégio de criar links (como no Vitest, A-4).
    fn link_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).unwrap();
            true
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }

    /// AC-R37B-2 (o AC-R37A-3 do motor TS): ocultos, links, nuvem (no arquivo aberto), teto de 2 MiB
    /// e não UTF-8 pulados e contados; o nome que a guarda recusa fica de fora sem contar; só as
    /// `.md` visíveis são lidas e nada de fora do vault aparece.
    #[test]
    fn skips_and_counts_like_the_ts_engine() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"segredo de fora");
        v.put("a.md", "segredo visível".as_bytes());
        for hidden in [
            ".simplemd/x.md",
            ".git/y.md",
            ".oculta.md",
            "pasta/.escondida/z.md",
        ] {
            v.put(hidden, TERM.as_bytes());
        }
        v.put("nuvem.md", TERM.as_bytes());
        v.put("imagem.png", TERM.as_bytes());
        v.put("grande.md", &vec![b'x'; MAX + 1]);
        let mut limit = TERM.as_bytes().to_vec();
        limit.resize(MAX, b'x');
        v.put("limite.md", &limit);
        v.put("binario.md", &[0x61, 0xff, 0xfe]);
        #[cfg(unix)]
        v.put("con.md", TERM.as_bytes());
        link_dir(&outside.0, &v.0.join("pasta-link"));
        let file_link = link_file(&outside.0.join("segredo.md"), &v.0.join("link.md"));
        let (summary, events) = search_in(&v.0, TERM, 200, &open(), &Cloud(&["nuvem.md"]));
        assert_eq!(events.paths(), ["a.md", "limite.md"]);
        assert_eq!(
            events.note("limite.md").hits,
            [Hit {
                line: 0,
                col: 0,
                len: 7,
                text: format!("{TERM}{}", "x".repeat(80)),
                at: 0,
                cut_before: false,
                cut_after: true,
            }]
        );
        assert_eq!(
            summary,
            Summary {
                scanned: 4,
                matched: 2,
                truncated: false,
                cancelled: false,
                skipped: Skipped {
                    hidden: 4,
                    links: 1 + u32::from(file_link),
                    cloud: 1,
                    too_large: 1,
                    not_utf8: 1,
                    unreadable: 0,
                },
            }
        );
    }

    /// Em cada pasta, as notas pela ordem dos pontos de código do nome ("Z" < "a" < U+E000 <
    /// emoji, a ordem do `byName` do TS) e depois as subpastas, em profundidade; posição e trecho
    /// em coordenadas do editor.
    #[test]
    fn walks_depth_first_notes_before_folders_in_code_point_order() {
        let v = TempDir::new();
        v.put("b.md", b"nada aqui");
        v.put("a.md", "# Ação\n\nprimeira AÇÃO".as_bytes());
        v.put("pasta/c.md", b"acao em c");
        v.put("pasta/sub/d.md", "ação".as_bytes());
        v.put("pasta/e.md", "ação".as_bytes());
        v.put("q/f.md", "ação".as_bytes());
        v.put("Z.md", b"Acao no Z");
        v.put("\u{1F600}.md", "ação".as_bytes());
        v.put("\u{E000}.md", "ação".as_bytes());
        let (summary, events) = search_in(&v.0, "ação", 200, &open(), &System);
        assert_eq!(
            events.paths(),
            [
                "Z.md",
                "a.md",
                "\u{E000}.md",
                "\u{1F600}.md",
                "pasta/c.md",
                "pasta/e.md",
                "pasta/sub/d.md",
                "q/f.md",
            ]
        );
        assert_eq!((summary.scanned, summary.matched), (9, 8));
        let a = events.note("a.md");
        assert_eq!(a.total, 2);
        assert_eq!(
            serde_json::to_value(&a.hits).unwrap(),
            json!([
                { "line": 0, "col": 2, "len": 4, "text": "# Ação", "at": 2, "cutBefore": false, "cutAfter": false },
                { "line": 2, "col": 9, "len": 4, "text": "primeira AÇÃO", "at": 9, "cutBefore": false, "cutAfter": false },
            ])
        );
    }

    fn many(v: &TempDir, count: usize, text: &str) {
        for i in 0..count {
            v.put(&format!("n-{i:04}.md"), text.as_bytes());
        }
    }

    /// A nota `limit + 1` prova que havia mais (`truncated`) e não sai; o limite exato não trunca;
    /// `limit` fora de 1..=500 vira o mais perto.
    #[test]
    fn limit_truncates_on_the_note_after_it() {
        let v = TempDir::new();
        many(&v, 510, "conteúdo");
        let (summary, events) = search_in(&v.0, "conteudo", 200, &open(), &System);
        assert_eq!(
            (summary.matched, summary.truncated, summary.scanned),
            (200, true, 201)
        );
        assert_eq!(events.paths().last(), Some(&"n-0199.md"));
        let (summary, _) = search_in(&v.0, "conteudo", 510, &open(), &System);
        assert_eq!((summary.matched, summary.truncated), (500, true));
        let (summary, _) = search_in(&v.0, "conteudo", 0, &open(), &System);
        assert_eq!((summary.matched, summary.truncated), (1, true));
        let w = TempDir::new();
        many(&w, 205, "conteúdo");
        let (summary, _) = search_in(&w.0, "conteudo", 205, &open(), &System);
        assert_eq!(
            (summary.matched, summary.truncated, summary.scanned),
            (205, false, 205)
        );
    }

    /// Lotes de até 16 notas na ordem do percurso; progresso a cada 200 notas examinadas.
    #[test]
    fn batches_of_16_in_walk_order_and_progress_every_200() {
        let v = TempDir::new();
        many(&v, 450, "sem nada");
        many(&v, 40, "conteúdo");
        let (summary, events) = search_in(&v.0, "conteudo", 200, &open(), &System);
        assert_eq!((summary.scanned, summary.matched), (450, 40));
        assert!(events.batches.iter().all(|b| (1..=16).contains(&b.len())));
        let expected: Vec<String> = (0..40).map(|i| format!("n-{i:04}.md")).collect();
        assert_eq!(events.paths(), expected);
        assert_eq!(events.progress, [200, 400]);
    }

    /// Cancelar depois do 1º lote: `cancelled`, menos de 2.000 examinadas e nenhum lote depois.
    /// Cancelada antes de começar: nem a raiz é aberta.
    #[test]
    fn cancel_after_the_first_batch_sends_nothing_more() {
        let v = TempDir::new();
        many(&v, 2000, "conteúdo");
        let cancel = AtomicBool::new(false);
        let mut batches = 0;
        let summary = run(&v.0, "conteudo", 500, &cancel, &System, &mut |event| {
            if let SearchEvent::Notes { .. } = event {
                batches += 1;
                cancel.store(true, Ordering::Relaxed);
            }
            true
        })
        .unwrap();
        assert_eq!(batches, 1);
        assert!(summary.cancelled && !summary.truncated);
        assert!(
            summary.matched <= 16 && summary.scanned < 2000,
            "{summary:?}"
        );

        let gone = v.0.join("não-existe");
        let mut events = 0;
        let summary = run(&gone, "conteudo", 200, &cancel, &System, &mut |_| {
            events += 1;
            true
        })
        .unwrap();
        assert!(summary.cancelled && summary.scanned == 0 && events == 0);
    }

    /// A raiz que não abre é erro (como o TS, que rejeita); a subpasta ilegível conta como
    /// `unreadable`. Ninguém mais ouvindo o canal: para.
    #[test]
    fn root_failure_rejects_and_a_dead_channel_stops() {
        let v = TempDir::new();
        let gone = v.0.join("não-existe");
        let result = run(&gone, "conteudo", 200, &open(), &System, &mut |_| true);
        assert_eq!(code(result), "NOT_FOUND");
        many(&v, 100, "conteúdo");
        let mut sent = 0;
        let summary = run(&v.0, "conteudo", 200, &open(), &System, &mut |_| {
            sent += 1;
            false
        })
        .unwrap();
        assert_eq!(sent, 1);
        assert!(summary.cancelled && summary.scanned < 100, "{summary:?}");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_subfolder_is_counted() {
        use std::os::unix::fs::PermissionsExt;
        let v = TempDir::new();
        v.put("a.md", TERM.as_bytes());
        v.put("fechada/b.md", TERM.as_bytes());
        let closed = v.0.join("fechada");
        fs::set_permissions(&closed, fs::Permissions::from_mode(0o000)).unwrap();
        let (summary, events) = search_in(&v.0, TERM, 200, &open(), &System);
        fs::set_permissions(&closed, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(events.paths(), ["a.md"]);
        assert_eq!(summary.skipped.unreadable, 1);
    }

    /// AppSec r37a item 1 (P6), AC-R37B-2: nada de fora do vault é lido, nem na corrida. Uma nota
    /// trocada por link entre a listagem e a abertura → `links`; uma pasta trocada por link antes de
    /// aberta → `links`; e uma pasta trocada por link DEPOIS de aberta continua sendo lida pelo
    /// descritor que já estava aberto: o conteúdo de fora nunca aparece.
    #[test]
    fn swaps_for_links_during_the_walk_never_reach_outside() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("n.md", b"segredo de fora");
        outside.put("troca.md", b"segredo de fora");
        v.put("a.md", b"segredo de dentro a");
        v.put("troca.md", b"segredo de dentro, trocado");
        v.put("antes/n.md", b"segredo de dentro, antes");
        v.put("depois/n.md", b"segredo de dentro, depois");
        let file_links = Mutex::new(true);
        let swap = Before(|rel: &str| match rel {
            "troca.md" => {
                fs::remove_file(v.0.join(rel)).unwrap();
                let made = link_file(&outside.0.join("troca.md"), &v.0.join(rel));
                *file_links.lock().unwrap() = made;
                if !made {
                    v.put(rel, b"sem link neste Windows");
                }
            }
            "antes" => {
                fs::rename(v.0.join("antes"), v.0.join("antes-velha")).unwrap();
                link_dir(&outside.0, &v.0.join("antes"));
            }
            "depois/n.md" => {
                fs::rename(v.0.join("depois"), v.0.join("depois-velha")).unwrap();
                link_dir(&outside.0, &v.0.join("depois"));
            }
            _ => {}
        });
        let (summary, events) = search_in(&v.0, TERM, 200, &open(), &swap);
        let texts: Vec<&str> = events
            .batches
            .iter()
            .flatten()
            .flat_map(|note| note.hits.iter().map(|hit| hit.text.as_str()))
            .collect();
        assert!(texts.iter().all(|text| !text.contains("fora")), "{texts:?}");
        assert_eq!(
            events.note("depois/n.md").hits[0].text,
            "segredo de dentro, depois"
        );
        let file_link = *file_links.lock().unwrap();
        assert_eq!(
            summary.skipped.links,
            1 + u32::from(file_link),
            "{summary:?}"
        );
        if file_link {
            assert_eq!(events.paths(), ["a.md", "depois/n.md"]);
        }
    }

    /// Um FIFO posto no lugar da nota não prende a abertura (`O_NONBLOCK`) nem é lido.
    #[cfg(unix)]
    #[test]
    fn a_fifo_swapped_in_does_not_block() {
        let v = TempDir::new();
        v.put("a.md", TERM.as_bytes());
        v.put("b.md", TERM.as_bytes());
        let swap = Before(|rel: &str| {
            if rel == "a.md" {
                let path = v.0.join(rel);
                fs::remove_file(&path).unwrap();
                let made = std::process::Command::new("mkfifo")
                    .arg(&path)
                    .status()
                    .unwrap();
                assert!(made.success());
            }
        });
        let (summary, events) = search_in(&v.0, TERM, 200, &open(), &swap);
        assert_eq!(events.paths(), ["b.md"]);
        assert_eq!(summary.skipped.unreadable, 1);
    }

    /// AC-R37B-3 (no Rust): uma busca por abertura. A nova cancela a anterior; o cancelamento pelo
    /// id só vale para a atual; a troca de pasta cancela; o token antigo dá `VAULT_CLOSED`; o fim
    /// libera só a própria vaga.
    #[test]
    fn one_search_per_folder_cancelled_by_a_new_one_by_id_and_by_switching() {
        let a = TempDir::new();
        let b = TempDir::new();
        let state = VaultState::default();
        assert_eq!(code(state.begin_search(1, 1)), "NO_VAULT");
        let token_a = state.stage(a.0.clone()).unwrap();
        let (root, first) = state.begin_search(token_a, 1).unwrap();
        assert_eq!(root, a.0, "a pendente virou a ativa");
        let (_, second) = state.begin_search(token_a, 2).unwrap();
        assert!(
            first.load(Ordering::Relaxed),
            "a busca nova não cancelou a anterior"
        );
        state.cancel_search(1);
        assert!(
            !second.load(Ordering::Relaxed),
            "id antigo cancelou a atual"
        );
        state.end_search(&first);
        assert!(
            !second.load(Ordering::Relaxed),
            "o fim da anterior liberou a vaga da atual"
        );
        state.cancel_search(2);
        assert!(second.load(Ordering::Relaxed));

        let (_, third) = state.begin_search(token_a, 3).unwrap();
        let token_b = state.stage(b.0.clone()).unwrap();
        assert!(
            !third.load(Ordering::Relaxed),
            "pendente: a busca de A continua"
        );
        state.root(token_b).unwrap();
        assert!(
            third.load(Ordering::Relaxed),
            "a troca de pasta não cancelou"
        );
        assert_eq!(code(state.begin_search(token_a, 4)), "VAULT_CLOSED");
        let (_, fourth) = state.begin_search(token_b, 4).unwrap();
        state.end_search(&fourth);
        assert!(state.lock().active.as_ref().unwrap().search.is_none());
    }

    /// Canal como o do webview, guardando o JSON de cada evento.
    fn recorder() -> (Channel<SearchEvent>, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, seen)
    }

    /// O que o canal leva (o contrato com a ponte `fsPort.ts`): lotes `{ notes }` com caminho
    /// relativo POSIX, `{ progress }` e, por último, `{ done }` com o resumo em camelCase.
    #[test]
    fn the_channel_carries_notes_then_done_and_frees_the_slot() {
        let v = TempDir::new();
        v.put("pasta/a.md", "Ação".as_bytes());
        let state = VaultState::default();
        let token = state.stage(v.0.clone()).unwrap();
        let (channel, seen) = recorder();
        search(&state, token, 9, "acao", 200, &channel, &System).unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            [
                json!({ "notes": [{ "path": "pasta/a.md", "total": 1, "hits": [
                    { "line": 0, "col": 0, "len": 4, "text": "Ação", "at": 0, "cutBefore": false, "cutAfter": false }
                ] }] }),
                json!({ "done": {
                    "scanned": 1, "matched": 1, "truncated": false, "cancelled": false,
                    "skipped": { "hidden": 0, "links": 0, "cloud": 0, "tooLarge": 0, "notUtf8": 0, "unreadable": 0 }
                } }),
            ]
        );
        assert!(state.lock().active.as_ref().unwrap().search.is_none());
        assert_eq!(
            serde_json::to_value(SearchEvent::Progress { progress: 200 }).unwrap(),
            json!({ "progress": 200 })
        );
        let gone = TempDir::new();
        let old = state.stage(gone.0.clone()).unwrap();
        state.root(old).unwrap();
        let (channel, seen) = recorder();
        assert_eq!(
            code(search(&state, token, 10, "acao", 200, &channel, &System)),
            "VAULT_CLOSED"
        );
        assert!(seen.lock().unwrap().is_empty());
        assert_eq!(invalid_query().code, "INVALID_QUERY");
        assert_ne!(invalid_query().message, AppError::new("IO").message);
    }

    /// Uma busca em andamento para quando outra começa: o sinal chega ao percurso, que termina com
    /// `{ done }` e `cancelled` sem mais lotes.
    #[test]
    fn a_new_search_stops_the_running_one() {
        let v = TempDir::new();
        many(&v, 40, "conteúdo");
        let state = VaultState::default();
        let token = state.stage(v.0.clone()).unwrap();
        state.root(token).unwrap();
        let (reached, wait_reached) = mpsc::channel();
        let (release, wait_release) = mpsc::channel::<()>();
        let wait_release = Mutex::new(wait_release);
        let gate = Before(move |rel: &str| {
            if rel == "n-0020.md" {
                reached.send(()).unwrap();
                wait_release.lock().unwrap().recv().unwrap();
            }
        });
        let (channel, seen) = recorder();
        std::thread::scope(|scope| {
            let running =
                scope.spawn(|| search(&state, token, 1, "conteudo", 200, &channel, &gate));
            wait_reached.recv().unwrap();
            let (_, newer) = state.begin_search(token, 2).unwrap();
            release.send(()).unwrap();
            running.join().unwrap().unwrap();
            state.end_search(&newer);
        });
        let seen = seen.lock().unwrap();
        let done = seen.last().unwrap();
        assert_eq!(done["done"]["cancelled"], json!(true), "{seen:?}");
        let delivered: usize = seen
            .iter()
            .filter_map(|event| event["notes"].as_array())
            .map(Vec::len)
            .sum();
        assert!(delivered <= 20, "{delivered}");
        assert_eq!(done["done"]["matched"], json!(delivered));
    }

    /// macOS (AppSec r37a item 7): durante a busca a thread não materializa arquivo sem dados; ao
    /// sair, a política anterior volta (a thread de bloqueio é reaproveitada).
    #[cfg(target_os = "macos")]
    #[test]
    fn dataless_files_are_not_downloaded_while_searching() {
        let before = materialize::current();
        assert!(before >= 0);
        {
            let _off = materialize::Off::new();
            assert_eq!(
                materialize::current(),
                materialize::IOPOL_MATERIALIZE_DATALESS_FILES_OFF
            );
        }
        assert_eq!(materialize::current(), before);
        assert!(dataless(&io::Error::from_raw_os_error(libc::EDEADLK)));
        assert!(!dataless(&io::Error::from_raw_os_error(libc::EACCES)));
    }

    const WORDS: [&str; 9] = [
        "ação",
        "coração",
        "você",
        "também",
        "não",
        "água",
        "página",
        "título",
        "análise",
    ];

    /// A nota do NFR-4 do TS (`noteText`): ~1,5 KB com acentos; a cada 10, "Índice remissivo".
    fn note_text(folder: usize, note: usize) -> String {
        let mut text = format!("# Nota {folder}-{note}\n\n");
        let mut units = text.chars().count();
        let mut i = 0;
        while units < 1500 {
            let word = WORDS[(folder * 7 + note * 13 + i) % WORDS.len()];
            text.push_str(word);
            text.push(if i % 12 == 11 { '\n' } else { ' ' });
            units += word.chars().count() + 1;
            i += 1;
        }
        if note.is_multiple_of(10) {
            text.push_str("\nÍndice remissivo da nota.\n");
        }
        text
    }

    /// NFR-4 (AC-R37B-2): 2.000 notas (20 pastas × 100), 200 com o termo. As 2.000 leituras e o
    /// resultado são conferidos sempre; o tempo (≤ 500 ms, mediana de 5 rodadas depois de 1 de
    /// aquecimento, robusta a uma rajada de carga) só com `SIMPLEMD_PERF=1`.
    #[test]
    fn nfr4_two_thousand_notes() {
        let v = TempDir::new();
        for folder in 1..=20 {
            for note in 1..=100 {
                v.put(
                    &format!("pasta-{folder:02}/nota-{note:03}.md"),
                    note_text(folder, note).as_bytes(),
                );
            }
        }
        let mut times = Vec::new();
        for round in 0..6 {
            let started = Instant::now();
            let (summary, events) = search_in(&v.0, "INDICE REMISSIVO", 200, &open(), &System);
            let elapsed = started.elapsed();
            assert_eq!(
                (summary.scanned, summary.matched, summary.truncated),
                (2000, 200, false)
            );
            let paths = events.paths();
            assert_eq!(paths.first(), Some(&"pasta-01/nota-010.md"));
            assert_eq!(paths.last(), Some(&"pasta-20/nota-100.md"));
            if round > 0 {
                times.push(elapsed);
            }
            if std::env::var("SIMPLEMD_PERF").as_deref() != Ok("1") {
                break;
            }
        }
        times.sort();
        if let Some(median) = times.get(times.len() / 2) {
            println!(
                "[NFR-4] busca no texto de 2.000 notas (Rust): mediana {median:?} de {times:?}"
            );
            assert!(*median <= Duration::from_millis(500), "{times:?}");
        }
    }
}
