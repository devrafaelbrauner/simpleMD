//! Operações de arquivo do gateway sobre uma raiz já resolvida (arch-backend r2 §1.2). Toda
//! operação valida o caminho e a classe ANTES de qualquer syscall, percorre os prefixos com
//! `symlink_metadata` (links e junções são recusados) e nunca sai da raiz: não há canonicalização
//! dos caminhos juntados.

use std::ffi::OsStr;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::dictionaries::{listed, FOLDER_LAYER};
use super::policy::{can_mkdir, can_read_dir, file_class, validate_rel};
use super::replace;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stat {
    pub kind: Kind,
    pub size: u64,
    pub mtime: u64,
    /// [`is_cloud_only`] (r36b): vai ao webview como `cloudOnly: true`, e só quando verdadeiro.
    #[serde(rename = "cloudOnly", skip_serializing_if = "std::ops::Not::not")]
    pub cloud_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirItem {
    pub name: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime: u64,
    /// Como em [`Stat`], com o `Metadata` da própria listagem.
    #[serde(rename = "cloudOnly", skip_serializing_if = "std::ops::Not::not")]
    pub cloud_only: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    CreateNew,
    /// Troca atômica só se o sha256 do conteúdo atual for este (r26, D-R26-2).
    Overwrite {
        expected_sha256: [u8; 32],
    },
}

/// Resultado do percurso dos prefixos de um caminho.
enum Walk {
    /// O último componente existe (pode ser um link: quem chama decide).
    Found(Metadata),
    /// Algum componente não existe.
    Missing,
    /// Um componente intermediário existe mas não é pasta.
    Blocked,
}

fn kind_of(meta: &Metadata) -> Kind {
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        Kind::Symlink
    } else if file_type.is_dir() {
        Kind::Dir
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// `mtime` em milissegundos inteiros (o mesmo valor que a porta Node e o plugin fs davam).
fn mtime_ms(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Windows (r36b, D-R36-6): `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`, que todo placeholder de nuvem
/// tem enquanto o conteúdo não está todo no disco (MS Learn `ifs/placeholders_guidance`), ou
/// `FILE_ATTRIBUTE_OFFLINE` (`attrib +o`). `RECALL_ON_OPEN` (0x40000) fica de fora: é o mesmo bit
/// de `FILE_ATTRIBUTE_EA`.
#[cfg(any(windows, test))]
const WINDOWS_CLOUD_ONLY: u32 = 0x0040_0000 | 0x0000_1000;
/// macOS (r36b): `SF_DATALESS` do SDK (`sys/stat.h`), marca sintética de arquivo sem os dados no
/// disco (TN3150). Constante local.
#[cfg(any(target_os = "macos", test))]
const SF_DATALESS: u32 = 0x4000_0000;

/// Atributos do Windows de um arquivo só na nuvem (bits puros, testados em todo SO).
#[cfg(any(windows, test))]
fn cloud_only_attributes(attributes: u32) -> bool {
    attributes & WINDOWS_CLOUD_ONLY != 0
}

/// `st_flags` do macOS de um arquivo só na nuvem (bits puros, testados em todo SO).
#[cfg(any(target_os = "macos", test))]
fn cloud_only_flags(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// Arquivo só na nuvem (r36b; contrato que a r37 reaproveita): o cliente de sincronização deixou no
/// disco só o nome e os metadados, e ler o conteúdo faz o sistema baixá-lo. Só bits do `Metadata`
/// que o chamador já tem (0 syscalls; no Windows, os da própria listagem); pasta nunca é; fora do
/// Windows e do macOS, sempre falso.
pub fn is_cloud_only(meta: &Metadata) -> bool {
    meta.is_file() && cloud_bits(meta)
}

#[cfg(windows)]
fn cloud_bits(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    cloud_only_attributes(meta.file_attributes())
}

#[cfg(target_os = "macos")]
fn cloud_bits(meta: &Metadata) -> bool {
    use std::os::darwin::fs::MetadataExt;
    cloud_only_flags(meta.st_flags())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn cloud_bits(_meta: &Metadata) -> bool {
    false
}

fn stat_of(meta: &Metadata) -> Stat {
    Stat {
        kind: kind_of(meta),
        size: meta.len(),
        mtime: mtime_ms(meta),
        cloud_only: is_cloud_only(meta),
    }
}

pub(super) fn join(root: &Path, segments: &[&str]) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
    }
    path
}

/// `symlink_metadata` em cada prefixo existente, sempre dentro da raiz. Um link (ou junção) num
/// componente intermediário → `OUTSIDE_VAULT`; o último componente é devolvido como está. No
/// Windows, cada componente que existe (o último também; a raiz não) precisa ter no disco o nome
/// pedido (W3f-N1): um alias 8.3 (`GIT~1` → `.git`) → `OUTSIDE_VAULT`.
fn walk(root: &Path, segments: &[&str]) -> Result<Walk, AppError> {
    let mut path = root.to_path_buf();
    for (i, segment) in segments.iter().enumerate() {
        path.push(segment);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Walk::Missing),
            Err(e) if e.kind() == io::ErrorKind::NotADirectory => return Ok(Walk::Blocked),
            Err(e) => return Err(AppError::io(&e)),
        };
        #[cfg(windows)]
        match long_name(&path, segment)? {
            None => return recheck_verdict(fs::symlink_metadata(&path)),
            Some(name) if !same_name(&name, segment) => return Err(AppError::new("OUTSIDE_VAULT")),
            Some(_) => {}
        }
        if i + 1 == segments.len() {
            return Ok(Walk::Found(meta));
        }
        if meta.file_type().is_symlink() {
            return Err(AppError::new("OUTSIDE_VAULT"));
        }
        if !meta.is_dir() {
            return Ok(Walk::Blocked);
        }
    }
    Ok(Walk::Found(fs::symlink_metadata(root)?))
}

/// Windows: o nome no disco é o segmento pedido, sem diferenciar maiúsculas (`NOTA.MD` →
/// `nota.md` passa; `GIT~1` → `.git` não). A regra do percurso e de `check_final_name`.
#[cfg(windows)]
fn same_name(on_disk: &str, segment: &str) -> bool {
    on_disk == segment || on_disk.to_uppercase() == segment.to_uppercase()
}

/// W3f (AppSec NB-1): o `FindFirstFileW` não achou uma entrada que o `symlink_metadata` tinha
/// acabado de achar. `recheck` é um segundo `symlink_metadata`: só se ele também não achar a entrada
/// sumiu (`Missing`); se ela continua lá, as duas chamadas leram o caminho de jeitos diferentes e a
/// resposta é `IO` (falha fechada: um `Missing` aqui deixaria o `CreateNew` e o `mkdir` criarem).
/// Outra falha → `AppError::io`.
#[cfg(any(windows, test))]
fn recheck_verdict(recheck: io::Result<Metadata>) -> Result<Walk, AppError> {
    match recheck {
        Ok(_) => Err(AppError::new("IO")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Walk::Missing),
        Err(e) => Err(AppError::io(&e)),
    }
}

/// Windows (W3f-N1): o nome longo do último componente de `path`, lido da entrada da pasta-mãe
/// (`FindFirstFileW` sem curinga: `cFileName`). A entrada é lida, não aberta, então um reparse
/// point no fim não é seguido; os componentes anteriores o percurso já provou que não são link.
/// `None` se o componente sumiu desde o `symlink_metadata`; outra falha → `AppError::io`.
#[cfg(windows)]
fn long_name(path: &Path, segment: &str) -> Result<Option<String>, AppError> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{FindClose, FindFirstFileW, WIN32_FIND_DATAW};
    // Curingas do `FindFirstFileW`: com eles a busca poderia achar outra entrada.
    if segment.contains(['*', '?', '<', '>', '"']) {
        return Err(AppError::new("INVALID_PATH"));
    }
    let wide = api_path(path).ok_or_else(|| AppError::new("INVALID_PATH"))?;
    let mut data = WIN32_FIND_DATAW::default();
    // SAFETY: `wide` termina em NUL e `data` é gravável e do tamanho da estrutura; os dois ficam
    // vivos durante a chamada.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(AppError::io(&error));
    }
    // SAFETY: `handle` veio de um `FindFirstFileW` que deu certo e é fechado uma vez só.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    unsafe { FindClose(handle) };
    let len = data
        .cFileName
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(data.cFileName.len());
    Ok(Some(String::from_utf16_lossy(&data.cFileName[..len])))
}

/// O caminho em UTF-16 com NUL para a API do Windows, com as regras do `replace::long_path`
/// (privado de `replace.rs`, por isso repetido aqui): `/` vira `\`; a partir de 247 unidades, o
/// prefixo `\\?\` (`C:\` → `\\?\C:\`, `\\.\` → `\\?\`) ou `\\?\UNC\` (`\\servidor\` →
/// `\\?\UNC\servidor\`), sem o limite `MAX_PATH`. Um caminho que já vem `\\?\` ou `\??\` fica
/// como veio. Um NUL no meio → `None` (a API leria só o começo).
#[cfg(windows)]
fn api_path(path: &Path) -> Option<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;
    const SEP: u16 = b'\\' as u16;
    const ALT_SEP: u16 = b'/' as u16;
    const QUERY: u16 = b'?' as u16;
    const DOT: u16 = b'.' as u16;
    const COLON: u16 = b':' as u16;
    let verbatim = |units: &[u16]| matches!(units, [SEP, SEP | QUERY, QUERY, SEP, ..]);
    let mut units: Vec<u16> = path.as_os_str().encode_wide().collect();
    if units.contains(&0) {
        return None;
    }
    if !verbatim(&units) {
        for unit in units.iter_mut().filter(|unit| **unit == ALT_SEP) {
            *unit = SEP;
        }
    }
    let (prefix, skip) = match units.as_slice() {
        short if short.len() < 247 || verbatim(short) => ("", 0),
        [_, COLON, SEP, ..] => (r"\\?\", 0),
        [SEP, SEP, DOT, SEP, ..] => (r"\\?\", 4),
        [SEP, SEP, ..] => (r"\\?\UNC\", 2),
        _ => ("", 0),
    };
    Some(
        prefix
            .encode_utf16()
            .chain(units.into_iter().skip(skip))
            .chain([0])
            .collect(),
    )
}

/// Percurso para operar no último componente: link → `OUTSIDE_VAULT`, intermediário que não é
/// pasta → `INVALID_PATH`.
pub(super) fn walk_target(root: &Path, segments: &[&str]) -> Result<Option<Metadata>, AppError> {
    match walk(root, segments)? {
        Walk::Found(meta) if meta.file_type().is_symlink() => Err(AppError::new("OUTSIDE_VAULT")),
        Walk::Found(meta) => Ok(Some(meta)),
        Walk::Missing => Ok(None),
        Walk::Blocked => Err(AppError::new("INVALID_PATH")),
    }
}

/// `null` quando o caminho não existe (ou um prefixo não é pasta, como a porta Node: API-05).
/// Nunca segue links: um link no fim é relatado como `symlink`.
pub fn lstat(root: &Path, rel: &str) -> Result<Option<Stat>, AppError> {
    let segments = validate_rel(rel, true)?;
    Ok(match walk(root, &segments)? {
        Walk::Found(meta) => Some(stat_of(&meta)),
        Walk::Missing | Walk::Blocked => None,
    })
}

/// Itens de uma pasta (nomes ocultos incluídos; o provider filtra), sem seguir links.
pub fn read_dir(root: &Path, rel: &str) -> Result<Vec<DirItem>, AppError> {
    let segments = validate_rel(rel, true)?;
    if !can_read_dir(&segments) {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    match walk_target(root, &segments)? {
        None => return Err(AppError::new("NOT_FOUND")),
        Some(meta) if !meta.is_dir() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(join(root, &segments))? {
        if let Some(item) = dir_item(entry)? {
            items.push(item);
        }
    }
    Ok(items)
}

/// Um item da listagem. Um item que sumiu no meio da listagem (`git checkout`, sincronização) é
/// pulado em vez de falhar a pasta inteira (CR2-04); um temporário de gravação também (AC-R26-4).
fn dir_item(entry: io::Result<fs::DirEntry>) -> Result<Option<DirItem>, AppError> {
    let entry = match entry {
        Ok(entry) => entry,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::io(&e)),
    };
    let Ok(name) = entry.file_name().into_string() else {
        return Ok(None); // nome que não é UTF-8: a guarda do provider o recusaria de qualquer forma
    };
    if replace::is_temp_name(&name) {
        return Ok(None);
    }
    let meta = match entry.metadata() {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::io(&e)),
    };
    let stat = stat_of(&meta);
    Ok(Some(DirItem {
        name,
        kind: stat.kind,
        size: stat.size,
        mtime: stat.mtime,
        cloud_only: stat.cloud_only,
    }))
}

/// Abre o último componente SEM seguir link (CR2-04): o percurso provou que nenhum componente é
/// link, mas outro processo pode trocar o arquivo por um link entre o percurso e a abertura. No
/// Unix `O_NOFOLLOW` faz a abertura de um link falhar (`ELOOP`); no Windows
/// `FILE_FLAG_OPEN_REPARSE_POINT` abre o próprio link, que não é arquivo comum. Em ambos, o que
/// foi aberto precisa ser um arquivo comum.
pub(super) fn open_no_follow(path: &Path, options: &mut OpenOptions) -> Result<File, AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        #[cfg(unix)]
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => {
            return Err(AppError::new("OUTSIDE_VAULT"))
        }
        Err(e) => return Err(AppError::io(&e)),
    };
    let meta = file.metadata()?;
    if meta.file_type().is_symlink() {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    if !meta.is_file() {
        return Err(AppError::new("INVALID_PATH"));
    }
    Ok(file)
}

/// SN-SEC-06 (Windows): o arquivo aberto precisa estar no caminho pedido. Um nome curto 8.3
/// (`GIT~1` → `.git`) abriria o arquivo por um alias que a política não vê, e uma pasta do meio
/// trocada por junção depois do percurso o abriria fora da raiz (W3f-N2). Ordem: primeiro a raiz é
/// aberta (agora, então um nome curto na raiz não atrapalha) e o arquivo precisa estar no mesmo
/// volume dela (número de série; `VOLUME_NAME_NONE` tira o volume dos caminhos), sempre, mesmo
/// que o caminho final falhe depois (AppSec NB-3); depois o caminho final do handle já aberto (sem
/// corrida), com os nomes longos, precisa terminar nos segmentos de `rel` e, por fim, ser o caminho
/// final da raiz mais esses segmentos, sem diferenciar maiúsculas (`same_name`). Fora de
/// `open_no_follow`, que o `verify` da gravação também usa. Se o caminho final falha (no arquivo
/// ou na raiz), quem decide é `fallback_verdict`; se ela aceita uma falha só na raiz, sobram o
/// volume e os segmentos.
#[cfg(windows)]
pub(super) fn check_final_name(
    root: &Path,
    file: &File,
    segments: &[&str],
) -> Result<(), AppError> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    let root_dir = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(root)?;
    if volume_serial(&root_dir)? != volume_serial(file)? {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    let path = match final_path(file) {
        Ok(path) => path,
        Err(code) => return fallback_verdict(code, segments),
    };
    let names: Vec<&str> = path.split('\\').collect();
    let tail = names.len().saturating_sub(segments.len());
    let same = tail > 0
        && names[tail..]
            .iter()
            .zip(segments)
            .all(|(name, segment)| same_name(name, segment));
    if !same {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    let root_path = match final_path(&root_dir) {
        Ok(root_path) => root_path,
        Err(code) => return fallback_verdict(code, segments),
    };
    // A raiz de um volume vem como `\`: sem a barra final, os nomes alinham com os do arquivo.
    let root_names: Vec<&str> = root_path.trim_end_matches('\\').split('\\').collect();
    let inside = root_names.len() == tail
        && root_names
            .iter()
            .zip(&names)
            .all(|(root_name, name)| same_name(name, root_name));
    if !inside {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    Ok(())
}

/// Windows: o número de série do volume de um handle aberto (`GetFileInformationByHandle`).
/// Falha → `AppError::io`.
#[cfg(windows)]
fn volume_serial(file: &File) -> Result<u32, AppError> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `info` é gravável e do tamanho da estrutura; o handle é do arquivo aberto e fica
    // aberto durante a chamada.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(AppError::io(&io::Error::last_os_error()));
    }
    Ok(info.dwVolumeSerialNumber)
}

/// Windows: o caminho final de um handle aberto (`GetFinalPathNameByHandleW` com
/// `FILE_NAME_NORMALIZED | VOLUME_NAME_NONE`: nomes longos, sem o volume). Falha → o código do
/// Windows, para `fallback_verdict`.
#[cfg(windows)]
fn final_path(file: &File) -> Result<String, i32> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_NONE,
    };
    let mut buffer = vec![0u16; 512];
    let len = loop {
        // SAFETY: `buffer` tem `buffer.len()` unidades graváveis; o handle é do arquivo aberto e
        // fica aberto durante a chamada.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_NONE,
            )
        } as usize;
        if len == 0 {
            return Err(io::Error::last_os_error()
                .raw_os_error()
                .unwrap_or_default());
        }
        if len < buffer.len() {
            break len;
        }
        buffer.resize(len, 0);
    };
    Ok(String::from_utf16_lossy(&buffer[..len]))
}

/// Falha do `GetFinalPathNameByHandleW` (código do Windows). Num volume que não dá o nome
/// normalizado (`ERROR_INVALID_FUNCTION`/`ERROR_NOT_SUPPORTED`: DriveFS, WinFsp, RAM disk), não
/// há como provar o nome: recusa (`OUTSIDE_VAULT`) todo `rel` com `~` em algum segmento (8.3,
/// `GIT~1`, e aliases do Samba, `~A`), inclusive nomes legítimos, e aceita o resto. Outro erro →
/// `AppError::io`.
#[cfg(any(windows, test))]
fn fallback_verdict(code: i32, segments: &[&str]) -> Result<(), AppError> {
    const ERROR_INVALID_FUNCTION: i32 = 1;
    const ERROR_NOT_SUPPORTED: i32 = 50;
    if code != ERROR_INVALID_FUNCTION && code != ERROR_NOT_SUPPORTED {
        return Err(AppError::io(&io::Error::from_raw_os_error(code)));
    }
    if segments.iter().any(|segment| segment.contains('~')) {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    Ok(())
}

/// Lê um arquivo de uma classe legível. O tamanho é checado no arquivo já aberto e a leitura
/// para em `teto + 1` bytes: não há corrida entre `stat` e leitura (AS-08).
pub fn read_file(root: &Path, rel: &str) -> Result<Vec<u8>, AppError> {
    let segments = validate_rel(rel, false)?;
    let class = file_class(&segments).ok_or_else(|| AppError::new("PERMISSION_DENIED"))?;
    match walk_target(root, &segments)? {
        None => return Err(AppError::new("NOT_FOUND")),
        Some(meta) if !meta.is_file() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    let file = open_no_follow(&join(root, &segments), OpenOptions::new().read(true))?;
    #[cfg(windows)]
    check_final_name(root, &file, &segments)?;
    read_capped(file, class.read_cap)
}

/// Lê de um arquivo aberto respeitando um teto opcional (`TOO_LARGE` sem ler nada além do teto).
pub fn read_capped(mut file: File, cap: Option<u64>) -> Result<Vec<u8>, AppError> {
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(AppError::new("INVALID_PATH"));
    }
    let mut bytes = Vec::new();
    match cap {
        None => {
            file.read_to_end(&mut bytes)?;
        }
        Some(cap) => {
            if meta.len() > cap {
                return Err(too_large(meta.len()));
            }
            file.take(cap + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > cap {
                return Err(too_large(bytes.len() as u64));
            }
        }
    }
    Ok(bytes)
}

pub(super) fn too_large(size: u64) -> AppError {
    AppError::new("TOO_LARGE").with_detail(serde_json::json!({ "size": size }))
}

/// Grava num arquivo de uma classe gravável. Acima do teto de leitura da classe → `TOO_LARGE` antes
/// de qualquer syscall (AppSec r32a item 1, r36b): o que a leitura recusaria não é gravado.
/// `CreateNew` falha com `ALREADY_EXISTS` se existir; `Overwrite` troca o arquivo de forma atômica
/// (`replace::replace_file`) só se o sha256 do conteúdo atual for o esperado (senão `CONFLICT`, 0
/// bytes gravados) e nunca cria (inexistente → `NOT_FOUND`). Um dicionário da pasta
/// (`.simplemd/dictionaries/<nome>.txt`) só é trocado pelo nome exato da listagem, como na camada
/// global (`dictionaries::listed`; R32A-DETALHES): num disco sem caixa, `PESSOAL.TXT` abriria o
/// `pessoal.txt` e a troca renomearia a entrada; outra grafia → `NOT_FOUND`.
pub fn write_file(root: &Path, rel: &str, bytes: &[u8], mode: WriteMode) -> Result<(), AppError> {
    let segments = validate_rel(rel, false)?;
    let class = file_class(&segments).ok_or_else(|| AppError::new("PERMISSION_DENIED"))?;
    if !class.writable {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    let len = bytes.len() as u64;
    if class.read_cap.is_some_and(|cap| len > cap) {
        return Err(too_large(len));
    }
    let existing = walk_target(root, &segments)?;
    let path = join(root, &segments);
    match mode {
        WriteMode::CreateNew => {
            if existing.is_some() {
                return Err(AppError::new("ALREADY_EXISTS"));
            }
            let mut file = open_no_follow(&path, OpenOptions::new().write(true).create_new(true))?;
            file.write_all(bytes)?;
            Ok(())
        }
        WriteMode::Overwrite { expected_sha256 } => match existing {
            None => Err(AppError::new("NOT_FOUND")),
            Some(meta) if !meta.is_file() => Err(AppError::new("INVALID_PATH")),
            Some(meta) => {
                if let [layer @ .., name] = segments.as_slice() {
                    if layer == FOLDER_LAYER && !listed(&join(root, layer), OsStr::new(name))? {
                        return Err(AppError::new("NOT_FOUND"));
                    }
                }
                replace::replace_file(&path, &meta, class.read_cap, &expected_sha256, bytes)
            }
        },
    }
}

/// Cria a pasta e as intermediárias (`create_dir_all`) depois do percurso. Sob
/// `.simplemd/plugins` nada é criado (instalar um plugin é copiar a pasta fora do app), mas
/// garantir uma pasta legível que JÁ existe é um no-op aceito: o `data.json` de um plugin nasce
/// dentro da pasta dele (R-6.16).
pub fn mkdir(root: &Path, rel: &str) -> Result<(), AppError> {
    let segments = validate_rel(rel, false)?;
    let creatable = can_mkdir(&segments);
    if !creatable && !can_read_dir(&segments) {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    if let Some(meta) = walk_target(root, &segments)? {
        return if meta.is_dir() {
            Ok(())
        } else {
            Err(AppError::new("ALREADY_EXISTS"))
        };
    }
    if !creatable {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    fs::create_dir_all(join(root, &segments))?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Pasta temporária apagada no `drop` (sem dependência extra só para testes).
    pub struct TempDir(pub PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let nanos = std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            // Só teste (#[cfg(test)]): pasta de nome único, apagada no `drop`.
            // nosemgrep: rust.lang.security.temp-dir.temp-dir
            let dir = std::env::temp_dir().join(format!(
                "simplemd-vault-test-{nanos}-{}",
                N.fetch_add(1, Ordering::SeqCst)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            // Como em `pick_vault`: canônica no Unix (/var → /private/var no macOS); no Windows,
            // `canonicalize` devolve `\\?\C:\…`, que não aceita `/` nas junções dos testes.
            #[cfg(unix)]
            let dir = dir.canonicalize().unwrap();
            Self(dir)
        }

        pub fn put(&self, rel: &str, content: &[u8]) {
            let path = self.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Sobrescrita condicional com a base `base` (o sha256 que o app conhece; r26).
    pub fn overwrite(base: &[u8]) -> WriteMode {
        WriteMode::Overwrite {
            expected_sha256: replace::sha256(base),
        }
    }

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    /// O nome curto 8.3 do último componente de `path` (`GetShortPathNameW`); `None` quando o
    /// volume não gera nome curto (o curto vem igual ao longo).
    #[cfg(windows)]
    pub fn short_name(path: &Path) -> Option<String> {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
        let mut buffer = vec![0u16; 1024];
        let cap = buffer.len() as u32;
        // SAFETY: `wide` termina em NUL; `buffer` tem `buffer.len()` unidades graváveis; os dois
        // ficam vivos durante a chamada.
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let len = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), cap) } as usize;
        assert!(
            len > 0 && len < buffer.len(),
            "{}",
            io::Error::last_os_error()
        );
        let short = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len]));
        let short = short.file_name()?.to_str()?.to_owned();
        (short != path.file_name()?.to_str()?).then_some(short)
    }

    #[test]
    fn read_write_roundtrip_and_modes() {
        let v = TempDir::new();
        v.put("a.md", b"\xEF\xBB\xBFa\r\n");
        assert_eq!(read_file(&v.0, "a.md").unwrap(), b"\xEF\xBB\xBFa\r\n");
        write_file(&v.0, "a.md", b"novo", overwrite(b"\xEF\xBB\xBFa\r\n")).unwrap();
        assert_eq!(fs::read(v.0.join("a.md")).unwrap(), b"novo");
        assert_eq!(
            code(write_file(&v.0, "a.md", b"x", WriteMode::CreateNew)),
            "ALREADY_EXISTS"
        );
        assert_eq!(fs::read(v.0.join("a.md")).unwrap(), b"novo");
        assert_eq!(
            code(write_file(&v.0, "b.md", b"x", overwrite(b"x"))),
            "NOT_FOUND"
        );
        assert!(!v.0.join("b.md").exists());
        write_file(&v.0, "b.md", b"b", WriteMode::CreateNew).unwrap();
        assert_eq!(
            code(write_file(&v.0, "nova/c.md", b"c", WriteMode::CreateNew)),
            "NOT_FOUND"
        );
        mkdir(&v.0, "nova/pasta").unwrap();
        write_file(&v.0, "nova/pasta/c.md", b"c", WriteMode::CreateNew).unwrap();
        mkdir(&v.0, "nova/pasta").unwrap();
        assert_eq!(code(read_file(&v.0, "nada.md")), "NOT_FOUND");
    }

    #[test]
    fn lstat_and_read_dir() {
        let v = TempDir::new();
        v.put("a.md", b"abc");
        v.put("sub/c.md", b"c");
        v.put(".git/config", b"segredo");
        let stat = lstat(&v.0, "a.md").unwrap().unwrap();
        assert_eq!((stat.kind, stat.size), (Kind::File, 3));
        let expected = fs::metadata(v.0.join("a.md")).unwrap();
        assert_eq!(stat.mtime, mtime_ms(&expected));
        assert_eq!(lstat(&v.0, "nada.md").unwrap(), None);
        // API-05: um prefixo que é arquivo → `null`, como na porta Node.
        assert_eq!(lstat(&v.0, "a.md/x.md").unwrap(), None);
        assert_eq!(lstat(&v.0, "").unwrap().unwrap().kind, Kind::Dir);
        let mut names: Vec<(String, Kind)> = read_dir(&v.0, "")
            .unwrap()
            .into_iter()
            .map(|i| (i.name, i.kind))
            .collect();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            names,
            vec![
                (".git".into(), Kind::Dir),
                ("a.md".into(), Kind::File),
                ("sub".into(), Kind::Dir)
            ]
        );
        assert_eq!(code(read_dir(&v.0, ".git")), "PERMISSION_DENIED");
        assert_eq!(code(read_file(&v.0, ".git/config")), "PERMISSION_DENIED");
        assert_eq!(code(read_dir(&v.0, "a.md")), "INVALID_PATH");
        assert_eq!(code(read_dir(&v.0, "nada")), "NOT_FOUND");
        assert_eq!(code(read_file(&v.0, "sub")), "PERMISSION_DENIED");
        v.put("sub.md/x.md", b"");
        assert_eq!(code(read_file(&v.0, "sub.md")), "INVALID_PATH");
    }

    /// SN-SEC-06: `GIT~1/x.md` é o mesmo arquivo de `.git/x.md` e contornaria a recusa da pasta
    /// oculta; o nome final do arquivo aberto precisa ser o pedido.
    #[cfg(windows)]
    #[test]
    fn short_name_alias_refused() {
        let v = TempDir::new();
        v.put(".git/x.md", b"segredo");
        let Some(short) = short_name(&v.0.join(".git")) else {
            eprintln!(
                "8.3 PULADO: o volume de {} não gera nome curto",
                v.0.display()
            );
            return;
        };
        eprintln!("8.3 exercitado: .git → {short}");
        assert_eq!(
            code(read_file(&v.0, &format!("{short}/x.md"))),
            "OUTSIDE_VAULT"
        );
        v.put("comum.md", b"ok");
        assert_eq!(read_file(&v.0, "comum.md").unwrap(), b"ok");
    }

    /// SN-SEC-06, `GetFinalPathNameByHandleW` falhou: volume sem nome normalizado (códigos 1 e 50)
    /// recusa todo `~`; outro código é erro de E/S.
    #[test]
    fn fallback_verdict_table() {
        let cases: [(i32, &[&str], &str); 12] = [
            (1, &["GIT~1", "x.md"], "OUTSIDE_VAULT"),
            (50, &["GIT~1", "x.md"], "OUTSIDE_VAULT"),
            (1, &["a", "PASTA~A.MD"], "OUTSIDE_VAULT"),
            (50, &["nota~.md"], "OUTSIDE_VAULT"),
            (1, &["~", "x.md"], "OUTSIDE_VAULT"),
            (1, &["a.md"], "OK"),
            (50, &["sub", "nota.md"], "OK"),
            (1, &[], "OK"),
            (1117, &["GIT~1"], "IO"),
            (1117, &["a.md"], "IO"),
            (87, &["a.md"], "IO"),
            (0, &["GIT~1", "x.md"], "IO"),
        ];
        for (os_code, segments, expected) in cases {
            assert_eq!(
                code(fallback_verdict(os_code, segments)),
                expected,
                "{os_code} {segments:?}"
            );
        }
    }

    /// R37A: o `read_file` continua lendo um hard link para outra nota do vault (só a imagem
    /// recusa link físico) e um `rel` em outra caixa que o disco (`NOTA.MD` → `nota.md`).
    #[cfg(windows)]
    #[test]
    fn hard_link_and_other_case_still_read() {
        let v = TempDir::new();
        v.put("nota.md", b"conteudo");
        fs::hard_link(v.0.join("nota.md"), v.0.join("link.md")).unwrap();
        assert_eq!(read_file(&v.0, "link.md").unwrap(), b"conteudo");
        assert_eq!(read_file(&v.0, "NOTA.MD").unwrap(), b"conteudo");
    }

    /// W3f-N1: o alias 8.3 da pasta oculta (`GIT~1` → `.git`) é recusado no percurso de toda
    /// operação, não só na leitura: nada é listado, criado ou trocado dentro de `.git`.
    #[cfg(windows)]
    #[test]
    fn short_name_alias_refused_in_walk() {
        let v = TempDir::new();
        v.put(".git/x.md", b"segredo");
        let Some(short) = short_name(&v.0.join(".git")) else {
            eprintln!(
                "8.3 PULADO: o volume de {} não gera nome curto",
                v.0.display()
            );
            return;
        };
        eprintln!("8.3 exercitado: .git → {short}");
        let x = format!("{short}/x.md");
        assert_eq!(code(lstat(&v.0, &short)), "OUTSIDE_VAULT");
        assert_eq!(code(lstat(&v.0, &x)), "OUTSIDE_VAULT");
        assert_eq!(code(read_dir(&v.0, &short)), "OUTSIDE_VAULT");
        let novo = format!("{short}/novo.md");
        assert_eq!(
            code(write_file(&v.0, &novo, b"n", WriteMode::CreateNew)),
            "OUTSIDE_VAULT"
        );
        assert!(!v.0.join(".git/novo.md").exists());
        assert_eq!(
            code(write_file(&v.0, &x, b"trocado", overwrite(b"segredo"))),
            "OUTSIDE_VAULT"
        );
        assert_eq!(fs::read(v.0.join(".git/x.md")).unwrap(), b"segredo");
        assert_eq!(code(mkdir(&v.0, &format!("{short}/sub"))), "OUTSIDE_VAULT");
        assert!(!v.0.join(".git/sub").exists());
    }

    /// W3f-N5: sobrescrever uma nota pelo próprio nome curto (`NOTASL~1.MD`) é recusado; o
    /// arquivo mantém o nome longo e o conteúdo.
    #[cfg(windows)]
    #[test]
    fn own_short_name_overwrite_refused() {
        let v = TempDir::new();
        v.put("notas longas.md", b"original");
        let Some(short) = short_name(&v.0.join("notas longas.md")) else {
            eprintln!(
                "8.3 PULADO: o volume de {} não gera nome curto",
                v.0.display()
            );
            return;
        };
        eprintln!("8.3 exercitado: notas longas.md → {short}");
        assert_eq!(
            code(write_file(&v.0, &short, b"trocado", overwrite(b"original"))),
            "OUTSIDE_VAULT"
        );
        let names: Vec<String> = fs::read_dir(&v.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["notas longas.md".to_owned()]);
        assert_eq!(fs::read(v.0.join("notas longas.md")).unwrap(), b"original");
    }

    /// W3f: o caminho normal continua: `rel` em outra caixa que o disco é lido, listado e
    /// conferido no percurso; a raiz aberta pelo próprio nome curto continua lendo e gravando.
    #[cfg(windows)]
    #[test]
    fn other_case_and_short_root_still_work() {
        let v = TempDir::new();
        v.put("sub/nota.md", b"conteudo");
        assert_eq!(read_file(&v.0, "SUB/NOTA.MD").unwrap(), b"conteudo");
        assert_eq!(
            lstat(&v.0, "SUB/NOTA.MD").unwrap().unwrap().kind,
            Kind::File
        );
        let names: Vec<String> = read_dir(&v.0, "SUB")
            .unwrap()
            .into_iter()
            .map(|i| i.name)
            .collect();
        assert_eq!(names, vec!["nota.md".to_owned()]);
        mkdir(&v.0, "SUB").unwrap();
        let Some(short) = short_name(&v.0) else {
            eprintln!(
                "8.3 PULADO: o volume de {} não gera nome curto",
                v.0.display()
            );
            return;
        };
        let root = v.0.with_file_name(&short);
        eprintln!("8.3 exercitado: raiz → {}", root.display());
        assert_eq!(read_file(&root, "sub/nota.md").unwrap(), b"conteudo");
        write_file(&root, "sub/nova.md", b"n", WriteMode::CreateNew).unwrap();
        write_file(&root, "sub/nota.md", b"novo", overwrite(b"conteudo")).unwrap();
        mkdir(&root, "sub/pasta").unwrap();
        assert_eq!(fs::read(v.0.join("sub/nota.md")).unwrap(), b"novo");
        assert_eq!(fs::read(v.0.join("sub/nova.md")).unwrap(), b"n");
        assert!(v.0.join("sub/pasta").is_dir());
    }

    /// W3f-N2: um arquivo aberto fora da raiz com os mesmos nomes finais dos segmentos (o que uma
    /// junção trocada no meio do caminho depois do percurso abriria) → `OUTSIDE_VAULT`; dentro
    /// da raiz, mas um nível abaixo do pedido, também.
    #[cfg(windows)]
    #[test]
    fn final_name_outside_root_refused() {
        let v = TempDir::new();
        let fora = TempDir::new();
        v.put("sub/x.md", b"dentro");
        v.put("a/sub/x.md", b"fundo");
        fora.put("sub/x.md", b"fora");
        let segments = ["sub", "x.md"];
        let dentro = File::open(v.0.join("sub/x.md")).unwrap();
        assert_eq!(code(check_final_name(&v.0, &dentro, &segments)), "OK");
        let file = File::open(fora.0.join("sub/x.md")).unwrap();
        assert_eq!(
            code(check_final_name(&v.0, &file, &segments)),
            "OUTSIDE_VAULT"
        );
        let fundo = File::open(v.0.join("a/sub/x.md")).unwrap();
        assert_eq!(
            code(check_final_name(&v.0, &fundo, &segments)),
            "OUTSIDE_VAULT"
        );
    }

    /// W3f: o nome longo do percurso também é lido num caminho além de `MAX_PATH` (`\\?\`).
    #[cfg(windows)]
    #[test]
    fn walk_past_max_path_still_works() {
        let v = TempDir::new();
        let pasta = "p".repeat(60);
        let fundo = format!("{pasta}/{pasta}/{pasta}/{pasta}/{pasta}");
        let rel = format!("{fundo}/nota.md");
        v.put(&rel, b"fundo");
        assert!(v.0.join(&rel).as_os_str().len() > 300);
        assert_eq!(lstat(&v.0, &rel).unwrap().unwrap().kind, Kind::File);
        assert_eq!(read_file(&v.0, &rel).unwrap(), b"fundo");
        write_file(&v.0, &rel, b"novo", overwrite(b"fundo")).unwrap();
        assert_eq!(read_file(&v.0, &rel.to_uppercase()).unwrap(), b"novo");
        // AppSec nit-3: o alias 8.3 continua recusado além de `MAX_PATH` (`\\?\` no percurso).
        v.put(&format!("{fundo}/.git/x.md"), b"segredo");
        let git = PathBuf::from(format!(
            r"\\?\{}\{}\.git",
            v.0.display(),
            fundo.replace('/', "\\")
        ));
        let Some(short) = short_name(&git) else {
            eprintln!(
                "8.3 PULADO: o volume de {} não gera nome curto",
                v.0.display()
            );
            return;
        };
        eprintln!("8.3 exercitado: caminho longo, .git → {short}");
        let alias = format!("{fundo}/{short}");
        assert!(v.0.join(&alias).as_os_str().len() > 260);
        assert_eq!(code(lstat(&v.0, &alias)), "OUTSIDE_VAULT");
        assert_eq!(code(lstat(&v.0, &format!("{alias}/x.md"))), "OUTSIDE_VAULT");
        assert_eq!(code(mkdir(&v.0, &format!("{alias}/sub"))), "OUTSIDE_VAULT");
        assert_eq!(
            code(write_file(
                &v.0,
                &format!("{alias}/novo.md"),
                b"n",
                WriteMode::CreateNew
            )),
            "OUTSIDE_VAULT"
        );
        assert!(!git.join("sub").exists());
        assert!(!git.join("novo.md").exists());
    }

    /// AppSec NB-1: o `FindFirstFileW` não achou o que o `symlink_metadata` achou. Só é `Missing`
    /// se a segunda consulta também não achar; se a entrada continua lá → `IO` (nunca "segue e
    /// cria"); outra falha → o código dela.
    #[test]
    fn recheck_after_find_not_found() {
        let v = TempDir::new();
        v.put("a.md", b"a");
        let verdict = |recheck| match recheck_verdict(recheck) {
            Ok(Walk::Missing) => "MISSING",
            Ok(_) => "OUTRO",
            Err(e) => e.code,
        };
        assert_eq!(
            verdict(Err(io::Error::from(io::ErrorKind::NotFound))),
            "MISSING"
        );
        assert_eq!(verdict(fs::symlink_metadata(v.0.join("a.md"))), "IO");
        assert_eq!(
            verdict(Err(io::Error::from(io::ErrorKind::PermissionDenied))),
            "PERMISSION_DENIED"
        );
        assert_eq!(verdict(Err(io::Error::other("x"))), "IO");
    }

    #[test]
    fn class_enforced_before_any_syscall() {
        let v = TempDir::new();
        v.put("x.txt", b"x");
        v.put(".simplemd/plugins/p/main.js", b"export default () => {}");
        v.put(".simplemd/plugins/p/manifest.json", b"{}");
        assert_eq!(code(read_file(&v.0, "x.txt")), "PERMISSION_DENIED");
        assert_eq!(
            read_file(&v.0, ".simplemd/plugins/p/main.js")
                .unwrap()
                .len(),
            23
        );
        for rel in [
            ".simplemd/plugins/p/main.js",
            ".simplemd/plugins/p/manifest.json",
        ] {
            for mode in [WriteMode::CreateNew, overwrite(b"x")] {
                assert_eq!(
                    code(write_file(&v.0, rel, b"x", mode)),
                    "PERMISSION_DENIED",
                    "{rel}"
                );
            }
        }
        assert_eq!(
            code(write_file(
                &v.0,
                ".simplemd/plugins/q/new.js",
                b"x",
                WriteMode::CreateNew
            )),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            code(mkdir(&v.0, ".simplemd/plugins/q")),
            "PERMISSION_DENIED"
        );
        assert!(!v.0.join(".simplemd/plugins/q").exists());
        mkdir(&v.0, ".simplemd/themes/meu").unwrap();
        write_file(
            &v.0,
            ".simplemd/themes/meu/theme.json",
            b"{}",
            WriteMode::CreateNew,
        )
        .unwrap();
        // Garantir a pasta de um plugin que JÁ existe é um no-op aceito (o `data.json` nasce nela).
        fs::create_dir_all(v.0.join(".simplemd/plugins/p")).unwrap();
        mkdir(&v.0, ".simplemd/plugins/p").unwrap();
        assert_eq!(fs::read(v.0.join("x.txt")).unwrap(), b"x");
    }

    #[test]
    fn read_cap_on_open_handle() {
        let v = TempDir::new();
        v.put(".simplemd/config.json", &vec![b' '; 1024 * 1024]);
        assert_eq!(
            read_file(&v.0, ".simplemd/config.json").unwrap().len(),
            1024 * 1024
        );
        v.put(".simplemd/config.json", &vec![b' '; 1024 * 1024 + 1]);
        let error = read_file(&v.0, ".simplemd/config.json").unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({ "size": 1024 * 1024 + 1 }))
        );
        v.put(".simplemd/themes/t/theme.json", &vec![b' '; 256 * 1024 + 1]);
        assert_eq!(
            code(read_file(&v.0, ".simplemd/themes/t/theme.json")),
            "TOO_LARGE"
        );
        v.put("grande.md", &vec![b'a'; 3 * 1024 * 1024]);
        assert_eq!(read_file(&v.0, "grande.md").unwrap().len(), 3 * 1024 * 1024);
    }

    /// r7 §1.13: os 3 arquivos de configuração são lidos pelo `vault_read_file` com teto e nunca
    /// gravados; o mesmo nome numa subpasta e os outros formatos do markdownlint ficam recusados.
    #[test]
    fn vault_config_files_read_only_with_caps() {
        let v = TempDir::new();
        v.put(".markdownlint.json", b"{\"MD013\": false}");
        v.put(".markdownlint.jsonc", &vec![b' '; 64 * 1024 + 1]);
        v.put(".simplemd/latex-snippets.json", b"[]");
        v.put(".markdownlint.cjs", b"module.exports = {}");
        v.put("a/.markdownlint.json", b"{}");
        assert_eq!(
            read_file(&v.0, ".markdownlint.json").unwrap(),
            b"{\"MD013\": false}"
        );
        assert_eq!(
            read_file(&v.0, ".simplemd/latex-snippets.json").unwrap(),
            b"[]"
        );
        assert_eq!(code(read_file(&v.0, ".markdownlint.jsonc")), "TOO_LARGE");
        assert_eq!(
            code(read_file(&v.0, ".markdownlint.cjs")),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            code(read_file(&v.0, "a/.markdownlint.json")),
            "PERMISSION_DENIED"
        );
        for rel in [".markdownlint.json", ".simplemd/latex-snippets.json"] {
            for mode in [WriteMode::CreateNew, overwrite(b"x")] {
                assert_eq!(
                    code(write_file(&v.0, rel, b"x", mode)),
                    "PERMISSION_DENIED",
                    "{rel}"
                );
            }
        }
        assert_eq!(
            code(mkdir(&v.0, ".markdownlint.jsonc")),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            fs::read(v.0.join(".markdownlint.json")).unwrap(),
            b"{\"MD013\": false}"
        );
        // F-09: o provider chega por `vault_lstat` antes de ler (o `#walk` do TS).
        assert_eq!(
            lstat(&v.0, ".markdownlint.json").unwrap().unwrap().kind,
            Kind::File
        );
        assert_eq!(
            lstat(&v.0, ".markdownlint.jsonc").unwrap().unwrap().size,
            64 * 1024 + 1
        );
        assert_eq!(
            lstat(&v.0, ".simplemd/latex-snippets.json")
                .unwrap()
                .unwrap()
                .size,
            2
        );
        assert_eq!(
            code(lstat(&v.0, "a/.markdownlint.json")),
            "PERMISSION_DENIED"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_prefix_refused() {
        use std::os::unix::fs::symlink;
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"fora");
        symlink(&outside.0, v.0.join("link")).unwrap();
        symlink(outside.0.join("segredo.md"), v.0.join("atalho.md")).unwrap();
        // Prefixo link: ler, criar (AS-03: o arquivo novo não existe) e listar são recusados.
        assert_eq!(code(read_file(&v.0, "link/segredo.md")), "OUTSIDE_VAULT");
        assert_eq!(
            code(write_file(&v.0, "link/novo.md", b"x", WriteMode::CreateNew)),
            "OUTSIDE_VAULT"
        );
        assert!(!outside.0.join("novo.md").exists());
        assert_eq!(code(mkdir(&v.0, "link/pasta")), "OUTSIDE_VAULT");
        assert_eq!(code(read_dir(&v.0, "link")), "OUTSIDE_VAULT");
        assert_eq!(code(lstat(&v.0, "link/segredo.md")), "OUTSIDE_VAULT");
        // Link no fim: lstat relata `symlink`; ler ou gravar é recusado.
        assert_eq!(
            lstat(&v.0, "atalho.md").unwrap().unwrap().kind,
            Kind::Symlink
        );
        assert_eq!(code(read_file(&v.0, "atalho.md")), "OUTSIDE_VAULT");
        assert_eq!(
            code(write_file(&v.0, "atalho.md", b"x", overwrite(b"fora"))),
            "OUTSIDE_VAULT"
        );
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        let items = read_dir(&v.0, "").unwrap();
        assert!(items.iter().all(|i| i.kind == Kind::Symlink));
    }

    /// r36b (AC-R36-2), bits puros em todo SO: no Windows, RECALL_ON_DATA_ACCESS ou OFFLINE; no
    /// macOS, SF_DATALESS. Os vizinhos não marcam: EA (= RECALL_ON_OPEN), PINNED/UNPINNED,
    /// esparso, reparse, oculto; UF_HIDDEN, UF_COMPRESSED, UF_TRACKED, SF_ARCHIVED, SF_FIRMLINK.
    #[test]
    fn cloud_only_bits() {
        for (attributes, expected) in [
            (0x0040_0000, true),  // RECALL_ON_DATA_ACCESS
            (0x0000_1000, true),  // OFFLINE
            (0x0040_0620, true),  // placeholder: + ARCHIVE, SPARSE_FILE, REPARSE_POINT
            (0, false),           // arquivo comum
            (0x0000_0020, false), // ARCHIVE
            (0x0000_0200, false), // SPARSE_FILE
            (0x0000_0400, false), // REPARSE_POINT
            (0x0000_0002, false), // HIDDEN
            (0x0004_0000, false), // RECALL_ON_OPEN = EA
            (0x0008_0000, false), // PINNED
            (0x0010_0620, false), // placeholder já no disco: UNPINNED, sem RECALL
        ] {
            assert_eq!(
                cloud_only_attributes(attributes),
                expected,
                "{attributes:#x}"
            );
        }
        for (flags, expected) in [
            (0x4000_0000, true),  // SF_DATALESS
            (0x4000_8000, true),  // + UF_HIDDEN
            (0, false),           // arquivo comum
            (0x0000_8000, false), // UF_HIDDEN
            (0x0000_0020, false), // UF_COMPRESSED
            (0x0000_0040, false), // UF_TRACKED
            (0x0001_0000, false), // SF_ARCHIVED
            (0x0080_0000, false), // SF_FIRMLINK
        ] {
            assert_eq!(cloud_only_flags(flags), expected, "{flags:#x}");
        }
    }

    /// r36b: `cloudOnly` só vai ao webview quando verdadeiro (o TS lê a ausência como "local").
    #[test]
    fn cloud_only_is_serialized_only_when_true() {
        let local = Stat {
            kind: Kind::File,
            size: 3,
            mtime: 9,
            cloud_only: false,
        };
        assert_eq!(
            serde_json::to_value(&local).unwrap(),
            serde_json::json!({ "kind": "file", "size": 3, "mtime": 9 })
        );
        let cloud = DirItem {
            name: "a.md".into(),
            kind: Kind::File,
            size: 3,
            mtime: 9,
            cloud_only: true,
        };
        assert_eq!(
            serde_json::to_value(&cloud).unwrap(),
            serde_json::json!({ "name": "a.md", "kind": "file", "size": 3, "mtime": 9, "cloudOnly": true })
        );
    }

    /// r36b: arquivo e pasta locais nunca são "só na nuvem", na listagem e no `lstat`.
    #[test]
    fn local_items_are_not_cloud_only() {
        let v = TempDir::new();
        v.put("a.md", b"a");
        v.put("sub/b.md", b"b");
        assert!(read_dir(&v.0, "").unwrap().iter().all(|i| !i.cloud_only));
        assert!(!lstat(&v.0, "a.md").unwrap().unwrap().cloud_only);
        assert!(!lstat(&v.0, "sub").unwrap().unwrap().cloud_only);
    }

    /// r36b (macOS): os `st_flags` reais chegam a `is_cloud_only` e só `SF_DATALESS` marca — um
    /// arquivo oculto (`chflags hidden`, UF_HIDDEN) continua local. `SF_DATALESS` só o sistema liga
    /// (cliente de nuvem): o caso marcado fica nos bits puros e no roteiro `docs/qa/nuvem.md`.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reads_st_flags_and_only_dataless_marks() {
        use std::os::darwin::fs::MetadataExt;
        use std::process::Command;
        let v = TempDir::new();
        v.put("a.md", b"a");
        let path = v.0.join("a.md");
        let hidden = Command::new("chflags")
            .arg("hidden")
            .arg(&path)
            .status()
            .unwrap();
        assert!(hidden.success());
        let meta = fs::symlink_metadata(&path).unwrap();
        assert_ne!(meta.st_flags() & 0x8000, 0, "UF_HIDDEN");
        assert!(!is_cloud_only(&meta));
        assert!(!lstat(&v.0, "a.md").unwrap().unwrap().cloud_only);
        assert!(read_dir(&v.0, "").unwrap().iter().all(|i| !i.cloud_only));
    }

    /// r36b (Windows, AC-R36-2): `attrib +o` (OFFLINE) marca a listagem e o `lstat`, e a leitura
    /// segue normal; `attrib -o` desmarca.
    #[cfg(windows)]
    #[test]
    fn offline_attribute_marks_listing_and_lstat_and_read_still_works() {
        use std::process::Command;
        let v = TempDir::new();
        v.put("a.md", b"conteudo");
        let path = v.0.join("a.md");
        let attrib = |flag: &str| {
            Command::new("attrib")
                .arg(flag)
                .arg(&path)
                .status()
                .unwrap()
                .success()
        };
        assert!(attrib("+o"));
        assert!(lstat(&v.0, "a.md").unwrap().unwrap().cloud_only);
        let items = read_dir(&v.0, "").unwrap();
        assert!(items.iter().any(|i| i.name == "a.md" && i.cloud_only));
        assert_eq!(read_file(&v.0, "a.md").unwrap(), b"conteudo");
        assert!(attrib("-o"));
        assert!(!lstat(&v.0, "a.md").unwrap().unwrap().cloud_only);
    }

    /// AppSec r32a item 1 (r36b): gravar acima do teto de leitura da classe → `TOO_LARGE` antes do
    /// percurso (um `.simplemd` que é arquivo nem é olhado), nos dois modos; no teto, grava; `.md`
    /// continua sem teto.
    #[test]
    fn write_refuses_more_than_the_class_read_cap() {
        use crate::vault::policy::DICTIONARY_MAX_BYTES;
        const KIB: u64 = 1024;
        const MIB: u64 = 1024 * KIB;
        let v = TempDir::new();
        let blocked = TempDir::new();
        blocked.put(".simplemd", b"arquivo");
        for (rel, cap) in [
            (".simplemd/config.json", MIB),
            (".simplemd/index.json", 20 * MIB),
            (".simplemd/themes/t/theme.json", 256 * KIB),
            (".simplemd/plugins/p/data.json", MIB),
            (".simplemd/dictionaries/medicos.txt", DICTIONARY_MAX_BYTES),
        ] {
            let over = vec![b' '; cap as usize + 1];
            // `.simplemd` é arquivo: com o percurso antes do teto, seria `INVALID_PATH`.
            assert_eq!(
                code(write_file(&blocked.0, rel, &over, WriteMode::CreateNew)),
                "TOO_LARGE",
                "{rel}"
            );
            // A pasta ainda não existe: sem teto nenhum, a criação daria `NOT_FOUND`.
            let error = write_file(&v.0, rel, &over, WriteMode::CreateNew).unwrap_err();
            assert_eq!(error.code, "TOO_LARGE", "{rel}");
            assert_eq!(
                error.detail,
                Some(serde_json::json!({ "size": cap + 1 })),
                "{rel}"
            );
            let path = v.0.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let exact = vec![b' '; cap as usize];
            write_file(&v.0, rel, &exact, WriteMode::CreateNew).unwrap();
            assert_eq!(
                code(write_file(&v.0, rel, &over, overwrite(&exact))),
                "TOO_LARGE",
                "{rel}"
            );
            assert_eq!(fs::metadata(&path).unwrap().len(), cap, "{rel}");
        }
        let big = vec![b'a'; 3 * MIB as usize];
        write_file(&v.0, "grande.md", &big, WriteMode::CreateNew).unwrap();
        assert_eq!(fs::metadata(v.0.join("grande.md")).unwrap().len(), 3 * MIB);
    }
}

#[cfg(test)]
mod race_tests {
    use super::tests::TempDir;
    use super::*;

    /// CR2-04: o arquivo trocado por um link DEPOIS do percurso (corrida) não é seguido na abertura:
    /// nem leitura de fora do vault, nem gravação (truncar) de um arquivo de fora.
    #[cfg(unix)]
    #[test]
    fn open_refuses_a_link_planted_after_the_walk() {
        use std::os::unix::fs::symlink;
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"fora");
        let link = v.0.join("nota.md");
        symlink(outside.0.join("segredo.md"), &link).unwrap();
        let read = open_no_follow(&link, OpenOptions::new().read(true));
        assert_eq!(read.unwrap_err().code, "OUTSIDE_VAULT");
        let write = open_no_follow(&link, OpenOptions::new().write(true));
        assert_eq!(write.unwrap_err().code, "OUTSIDE_VAULT");
        let create = open_no_follow(&link, OpenOptions::new().write(true).create_new(true));
        assert!(create.is_err());
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        // Arquivo comum: abre normalmente.
        v.put("comum.md", b"ok");
        let mut file =
            open_no_follow(&v.0.join("comum.md"), OpenOptions::new().read(true)).unwrap();
        let mut text = String::new();
        file.read_to_string(&mut text).unwrap();
        assert_eq!(text, "ok");
    }

    /// TA-R2-10: no Windows, a junção (e o link simbólico, se o SO deixar criar) no lugar do
    /// arquivo, plantada depois do percurso, não é seguida. Chamado direto: o `read_file` já recusa
    /// no percurso. A junção é recusada pelo próprio SO na abertura (`PERMISSION_DENIED`), não pelo
    /// `open_no_follow`; quem prova o `FILE_FLAG_OPEN_REPARSE_POINT` é o caso do link simbólico de
    /// arquivo, que abre como ele mesmo → `OUTSIDE_VAULT`.
    #[cfg(windows)]
    #[test]
    fn open_refuses_a_junction_planted_after_the_walk() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"fora");
        let junction = v.0.join("juncao");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside.0)
            .output()
            .unwrap();
        assert!(made.status.success(), "mklink /J");
        let mut links = vec![(junction, "PERMISSION_DENIED")];
        let link = v.0.join("nota.md");
        if std::os::windows::fs::symlink_file(outside.0.join("segredo.md"), &link).is_ok() {
            links.push((link, "OUTSIDE_VAULT"));
        } else {
            eprintln!("sem permissão para link simbólico: só a junção");
        }
        for (link, expected) in &links {
            let read = open_no_follow(link, OpenOptions::new().read(true));
            assert_eq!(read.unwrap_err().code, *expected, "{link:?}");
            let write = open_no_follow(link, OpenOptions::new().write(true));
            assert_eq!(write.unwrap_err().code, *expected, "{link:?}");
        }
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        eprintln!("TA-R2-10: {} link(s) recusado(s)", links.len());
    }

    /// CR2-04: um item apagado no meio da listagem é pulado; a pasta não falha inteira.
    #[test]
    fn read_dir_skips_an_entry_that_vanished() {
        let v = TempDir::new();
        v.put("fica.md", b"a");
        v.put("some.md", b"b");
        let entries: Vec<_> = fs::read_dir(&v.0).unwrap().collect();
        fs::remove_file(v.0.join("some.md")).unwrap();
        let mut names = Vec::new();
        for entry in entries {
            if let Some(item) = dir_item(entry).unwrap() {
                names.push(item.name);
            }
        }
        names.sort();
        // No Windows a listagem já traz os metadados (o item continua); no Unix ele é pulado.
        if cfg!(unix) {
            assert_eq!(names, vec!["fica.md".to_owned()]);
        } else {
            assert!(names.contains(&"fica.md".to_owned()));
        }
        assert_eq!(read_dir(&v.0, "").unwrap().len(), 1);
    }
}
