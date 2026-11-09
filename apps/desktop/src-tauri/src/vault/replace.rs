//! Sobrescrita atômica do gateway do vault (r26, D-R26-1/2). Os bytes novos vão para um
//! temporário oculto na MESMA pasta (`.~simplemd-<16 hex>.tmp`, com as permissões do original e
//! `sync_all`); logo antes da troca, o conteúdo atual é conferido pelo sha256 que o app conhece,
//! numa abertura que não segue link e exige escrita (a mesma exigência da gravação no lugar); só
//! então `rename` troca a entrada da pasta. Uma falha antes da troca deixa o original intacto e
//! apaga o temporário; depois dela nada vira erro (seria um conflito falso no salvamento seguinte).
//!
//! O nome nunca some do disco e nada é apagado antes da troca: um link plantado no destino é
//! trocado, não seguido, e um link físico para fora do vault fica com o conteúdo antigo (API-04).
//! No Windows, `std::fs::rename` faz `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` e, com o destino
//! aberto por outro programa (`ACCESS_DENIED`), a troca com semântica POSIX; sem write-through
//! (D-R26-1). Metadados além de permissões, grupo, "oculto" e data de criação não são copiados
//! (D-R26-3).

use std::fmt::Write as _;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::ops::{open_no_follow, too_large};
use crate::error::AppError;

const TEMP_PREFIX: &str = ".~simplemd-";
const TEMP_SUFFIX: &str = ".tmp";
/// Dígitos hexadecimais do sufixo aleatório (8 bytes do `getrandom`).
const TEMP_HEX: usize = 16;
/// Nomes tentados para o temporário (64 bits aleatórios: colidir é só por sabotagem).
const TEMP_ATTEMPTS: usize = 8;

/// `true` para o nome de um temporário de gravação (`.~simplemd-<16 hex minúsculos>.tmp`): nunca é
/// listado (`ops::read_dir`) nem repassado pelo observador (AC-R26-4). O `.` inicial o esconde do
/// app e o `.tmp` o deixa fora da sincronização do OneDrive.
pub fn is_temp_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == TEMP_PREFIX.len() + TEMP_HEX + TEMP_SUFFIX.len()
        && name.starts_with(TEMP_PREFIX)
        && name.ends_with(TEMP_SUFFIX)
        && bytes[TEMP_PREFIX.len()..TEMP_PREFIX.len() + TEMP_HEX]
            .iter()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// sha256 dos bytes (o mesmo valor do `sha256Hex` do TS, em bytes).
pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Etapas antes da troca em que um teste injeta uma falha ou uma corrida. A falha injetada em
/// `Written` e em `Verified` conta como a da operação seguinte (`sync_all` e `rename`): é assim que
/// os testes chegam à recaída do macOS e ao `IO` da troca recusada.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Temporário criado, ainda vazio.
    Created,
    /// Bytes e metadados no temporário.
    Written,
    /// Temporário no disco (`sync_all`) e fechado; a conferência ainda não.
    Synced,
    /// Conferência feita; a troca ainda não.
    Verified,
}

/// Gancho dos testes: recebe cada etapa e pode falhar ou agir (corrida) antes de devolver.
#[cfg(test)]
type HookFn = Box<dyn FnMut(Step) -> io::Result<()>>;

#[cfg(test)]
thread_local! {
    /// Gancho dos testes, por thread (os testes rodam em paralelo).
    static HOOK: std::cell::RefCell<Option<HookFn>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn checkpoint(step: Step) -> io::Result<()> {
    HOOK.with(|hook| hook.borrow_mut().as_mut().map_or(Ok(()), |f| f(step)))
}

#[cfg(not(test))]
fn checkpoint(_step: Step) -> io::Result<()> {
    Ok(())
}

/// Temporário desta gravação: apagado em qualquer saída antes da troca (`armed`).
struct Temp {
    path: PathBuf,
    armed: bool,
}

impl Drop for Temp {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Troca o arquivo comum `path` (já percorrido; `meta` é dele) pelos `bytes`, só se o sha256 do
/// conteúdo atual for `expected` (senão `CONFLICT`, 0 bytes gravados). Conteúdo atual igual aos
/// bytes novos → nada muda. `read_cap` é o teto de leitura da classe (`TOO_LARGE`, como hoje).
pub(super) fn replace_file(
    path: &Path,
    meta: &Metadata,
    read_cap: Option<u64>,
    expected: &[u8; 32],
    bytes: &[u8],
) -> Result<(), AppError> {
    let dir = path.parent().ok_or_else(|| AppError::new("INVALID_PATH"))?;
    let (mut temp, mut file) = create_temp(dir, meta)?;
    checkpoint(Step::Created)?;
    file.write_all(bytes)?;
    copy_metadata(&file, meta)?;
    checkpoint(Step::Written)
        .and_then(|()| file.sync_all())
        .or_else(|e| fsync_if_unsupported(&file, e))?;
    // Fechado antes da troca (no Windows, o `rename` de um arquivo aberto pode falhar).
    drop(file);
    checkpoint(Step::Synced)?;
    if !verify(path, read_cap, expected, bytes)? {
        return Ok(()); // o disco já tem os bytes novos; o `Drop` apaga o temporário
    }
    // A escrita já foi provada (temporário criado, alvo aberto com escrita): um `rename` recusado é
    // passageiro (no Windows, o alvo aberto por outro programa sem `FILE_SHARE_DELETE`) → `IO`, que o
    // autosave tenta de novo, nunca `PERMISSION_DENIED` (Review #2); o `Drop` apaga o temporário.
    checkpoint(Step::Verified)
        .and_then(|()| fs::rename(&temp.path, path))
        .map_err(|_| AppError::new("IO"))?;
    // Ponto sem volta: a troca aconteceu e nada daqui em diante vira erro.
    temp.armed = false;
    sync_dir(dir);
    Ok(())
}

/// Cria o temporário ao lado do alvo, com um nome novo a cada tentativa (nunca reaproveitado).
fn create_temp(dir: &Path, meta: &Metadata) -> Result<(Temp, File), AppError> {
    let mut name = String::with_capacity(TEMP_PREFIX.len() + TEMP_HEX + TEMP_SUFFIX.len());
    for _ in 0..TEMP_ATTEMPTS {
        let mut raw = [0u8; TEMP_HEX / 2];
        getrandom::fill(&mut raw).map_err(|_| AppError::new("IO"))?;
        name.clear();
        name.push_str(TEMP_PREFIX);
        for byte in raw {
            let _ = write!(name, "{byte:02x}");
        }
        name.push_str(TEMP_SUFFIX);
        let path = dir.join(&name);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        temp_options(&mut options, meta);
        match options.open(&path) {
            Ok(file) => return Ok((Temp { path, armed: true }, file)),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(AppError::io(&e)),
        }
    }
    Err(AppError::new("IO"))
}

/// Unix: só o dono lê até as permissões do original serem copiadas; `O_NOFOLLOW` como em toda
/// abertura do vault.
#[cfg(unix)]
fn temp_options(options: &mut OpenOptions, _meta: &Metadata) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
}

/// Windows: o temporário nasce com o atributo "oculto" do original (os demais vêm do sistema) e com
/// `FILE_FLAG_OPEN_REPARSE_POINT`, como toda abertura do vault (a std 1.98 já o soma a `create_new`;
/// aqui ele fica explícito, como o `O_NOFOLLOW` do Unix).
#[cfg(windows)]
fn temp_options(options: &mut OpenOptions, meta: &Metadata) {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options
        .attributes(meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

/// Unix: o grupo do original por melhor esforço (pastas compartilhadas) e as permissões (bits rwx;
/// sem setuid/setgid/sticky) por `fchmod`, sem umask. Sem o grupo (o usuário não é membro), só os
/// bits do dono ficam: os de grupo valeriam para o grupo do usuário (`staff` no macOS) e os de
/// outros, para o grupo antigo (AppSec N3). O dono passa a ser o usuário do app.
#[cfg(unix)]
fn copy_metadata(file: &File, meta: &Metadata) -> io::Result<()> {
    use std::os::unix::fs::{fchown, MetadataExt, PermissionsExt};
    let mode = match fchown(file, None, Some(meta.gid())) {
        Ok(()) => meta.mode() & 0o777,
        Err(_) => meta.mode() & 0o700,
    };
    file.set_permissions(fs::Permissions::from_mode(mode))
}

/// Windows: a data de criação do original (a "Data de criação" não muda a cada salvamento).
#[cfg(windows)]
fn copy_metadata(file: &File, meta: &Metadata) -> io::Result<()> {
    use std::fs::FileTimes;
    use std::os::windows::fs::FileTimesExt;
    match meta.created() {
        Ok(created) => file.set_times(FileTimes::new().set_created(created)),
        Err(_) => Ok(()),
    }
}

/// Conferência logo antes da troca, numa abertura sem seguir link e com escrita (um arquivo sem
/// permissão de escrita continua `PERMISSION_DENIED`, como na gravação no lugar): sha256 do conteúdo
/// atual ≠ `expected` → `CONFLICT`. `false` = o disco já tem os bytes novos (o mesmo sha256). O
/// conteúdo passa pelo sha256 aos pedaços (`io::copy`, buffer fixo), nunca inteiro na memória (o
/// `.md` não tem teto; AppSec N4), com o teto da classe como em `read_capped`. O arquivo é fechado
/// antes de voltar.
fn verify(
    path: &Path,
    read_cap: Option<u64>,
    expected: &[u8; 32],
    bytes: &[u8],
) -> Result<bool, AppError> {
    let file = open_no_follow(path, OpenOptions::new().read(true).write(true))?;
    let len = file.metadata()?.len();
    if read_cap.is_some_and(|cap| len > cap) {
        return Err(too_large(len));
    }
    let mut hasher = Sha256::new();
    let read = io::copy(
        &mut file.take(read_cap.map_or(u64::MAX, |cap| cap + 1)),
        &mut hasher,
    )?;
    if read_cap.is_some_and(|cap| read > cap) {
        return Err(too_large(read));
    }
    let current: [u8; 32] = hasher.finalize().into();
    if current != *expected {
        return Err(AppError::new("CONFLICT"));
    }
    Ok(sha256(bytes) != *expected)
}

/// fsync da pasta depois do `rename` (Unix), por melhor esforço: a troca já aconteceu. No Windows,
/// a entrada nova fica no journal do NTFS (sem write-through, D-R26-1).
#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(dir) = File::open(dir) {
        let _ = dir.sync_all();
    }
}

#[cfg(windows)]
fn sync_dir(_dir: &Path) {}

/// macOS: `sync_all` é `fcntl(F_FULLFSYNC)`, e um volume que não o tem recusa a chamada (`ENOTSUP`
/// no SMB e no NTFS, `EINVAL` no WebDAV, `ENOTTY` no ZFS, nas fontes da Apple citadas no commit
/// 6fc797c do libuv): sem recaída, todo salvamento ali falharia (Review #1). Só nessas recusas
/// recai em `fsync` comum, como Go e libuv; uma falha de E/S de verdade continua falha.
#[cfg(target_vendor = "apple")]
fn fsync_if_unsupported(file: &File, error: io::Error) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    if !matches!(
        error.raw_os_error(),
        Some(libc::ENOTSUP | libc::EINVAL | libc::ENOTTY)
    ) {
        return Err(error);
    }
    // SAFETY: `fsync` só recebe o descritor de `file`, aberto durante toda a chamada.
    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
    if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Fora da Apple, `sync_all` já é `fsync` (Unix) ou `FlushFileBuffers` (Windows): sem recaída.
#[cfg(not(target_vendor = "apple"))]
fn fsync_if_unsupported(_file: &File, error: io::Error) -> io::Result<()> {
    Err(error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::{overwrite, TempDir};
    use crate::vault::ops::{read_dir, write_file};
    use std::io::Read;
    use std::time::SystemTime;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    /// Temporários que sobraram numa pasta (listagem crua do SO, sem o filtro do gateway).
    fn temps(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with(TEMP_PREFIX))
            .collect()
    }

    fn modified(path: &Path) -> SystemTime {
        fs::metadata(path).unwrap().modified().unwrap()
    }

    /// Gancho da thread atual, desligado no `drop`.
    struct Hook;

    impl Hook {
        fn set(hook: impl FnMut(Step) -> io::Result<()> + 'static) -> Self {
            HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
            Hook
        }
    }

    impl Drop for Hook {
        fn drop(&mut self) {
            HOOK.with(|slot| *slot.borrow_mut() = None);
        }
    }

    #[test]
    fn temp_names_are_recognized_exactly() {
        assert!(is_temp_name(".~simplemd-0123456789abcdef.tmp"));
        for name in [
            ".~simplemd-0123456789ABCDEF.tmp",
            ".~simplemd-0123456789abcdeg.tmp",
            ".~simplemd-0123.tmp",
            "~simplemd-0123456789abcdef.tmp",
            ".~simplemd-0123456789abcdef.md",
            ".~simplemd-éééééééé.tmp",
            "nota.md",
            "",
        ] {
            assert!(!is_temp_name(name), "{name}");
        }
        assert_eq!(
            sha256(b""),
            [
                0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
                0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
                0x78, 0x52, 0xb8, 0x55
            ]
        );
    }

    /// AC-R26-1: a sobrescrita troca o arquivo em vez de truncá-lo no lugar. Quem tinha o arquivo
    /// aberto continua lendo a versão antiga inteira (no Windows, o destino aberto passa pela troca
    /// POSIX da std).
    #[test]
    fn overwrite_replaces_instead_of_truncating_in_place() {
        let v = TempDir::new();
        v.put("a.md", b"\xEF\xBB\xBFversao antiga\r\ninteira\r\n");
        let path = v.0.join("a.md");
        let mut old = File::open(&path).unwrap();
        write_file(
            &v.0,
            "a.md",
            b"\xEF\xBB\xBFnova\r\n",
            overwrite(b"\xEF\xBB\xBFversao antiga\r\ninteira\r\n"),
        )
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFnova\r\n");
        let mut before = Vec::new();
        old.read_to_end(&mut before).unwrap();
        assert_eq!(before, b"\xEF\xBB\xBFversao antiga\r\ninteira\r\n");
        assert!(temps(&v.0).is_empty());
    }

    /// AC-R26-1: falha injetada em cada etapa antes da troca → o original fica byte a byte igual
    /// (e com o mesmo mtime) e o temporário some.
    #[test]
    fn failure_before_the_swap_keeps_the_original_and_removes_the_temp() {
        for step in [Step::Created, Step::Written, Step::Synced, Step::Verified] {
            let v = TempDir::new();
            let original: &[u8] = b"\xEF\xBB\xBForiginal\r\n";
            v.put("nota.md", original);
            let path = v.0.join("nota.md");
            let before = modified(&path);
            let _hook = Hook::set(move |at| {
                if at == step {
                    Err(io::Error::other("falha injetada"))
                } else {
                    Ok(())
                }
            });
            let result = write_file(&v.0, "nota.md", b"novo", overwrite(original));
            assert_eq!(code(result), "IO", "{step:?}");
            assert_eq!(fs::read(&path).unwrap(), original, "{step:?}");
            assert_eq!(modified(&path), before, "{step:?}");
            assert!(temps(&v.0).is_empty(), "{step:?}");
        }
    }

    /// Review #2/#4: o `rename` recusado depois da conferência (no Windows, o alvo aberto por outro
    /// programa sem `FILE_SHARE_DELETE` → `ACCESS_DENIED`) vira `IO`, que o autosave tenta de novo,
    /// e não `PERMISSION_DENIED`: a escrita já foi provada. Original intacto, sem temporário.
    #[test]
    fn refused_rename_is_retryable_and_keeps_the_original() {
        let v = TempDir::new();
        v.put("n.md", b"base");
        let _hook = Hook::set(|at| match at {
            Step::Verified => Err(io::ErrorKind::PermissionDenied.into()),
            _ => Ok(()),
        });
        assert_eq!(
            code(write_file(&v.0, "n.md", b"app", overwrite(b"base"))),
            "IO"
        );
        assert_eq!(fs::read(v.0.join("n.md")).unwrap(), b"base");
        assert!(temps(&v.0).is_empty());
    }

    /// Review #1 (macOS): volume sem `F_FULLFSYNC` (`ENOTSUP` no SMB, `EINVAL` no WebDAV, `ENOTTY`
    /// no ZFS) → `fsync` comum e o salvamento segue; `EIO` não recai: original intacto, sem
    /// temporário. A recusa é injetada no lugar do `sync_all`.
    #[cfg(target_vendor = "apple")]
    #[test]
    fn full_fsync_refused_by_the_volume_falls_back_to_fsync() {
        for (errno, expected) in [
            (libc::ENOTSUP, "OK"),
            (libc::EINVAL, "OK"),
            (libc::ENOTTY, "OK"),
            (libc::EIO, "IO"),
        ] {
            let v = TempDir::new();
            v.put("n.md", b"base");
            let _hook = Hook::set(move |at| match at {
                Step::Written => Err(io::Error::from_raw_os_error(errno)),
                _ => Ok(()),
            });
            let result = write_file(&v.0, "n.md", b"app", overwrite(b"base"));
            assert_eq!(code(result), expected, "{errno}");
            let on_disk: &[u8] = if expected == "OK" { b"app" } else { b"base" };
            assert_eq!(fs::read(v.0.join("n.md")).unwrap(), on_disk, "{errno}");
            assert!(temps(&v.0).is_empty(), "{errno}");
        }
    }

    /// AC-R26-1 com falha real (D-R26-4): pasta sem escrita → `PERMISSION_DENIED`, nada gravado,
    /// sem temporário (antes, a gravação no lugar passava; agora não há como trocar).
    #[cfg(unix)]
    #[test]
    fn folder_without_write_permission_is_refused_cleanly() {
        use std::os::unix::fs::PermissionsExt;
        let v = TempDir::new();
        v.put("pasta/nota.md", b"original");
        let dir = v.0.join("pasta");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        // Com privilégio (root), o modo não barra nada: o teste não se aplica.
        let privileged = fs::write(dir.join("sonda"), b"").is_ok();
        let result = write_file(&v.0, "pasta/nota.md", b"novo", overwrite(b"original"));
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        if privileged {
            return;
        }
        assert_eq!(code(result), "PERMISSION_DENIED");
        assert_eq!(fs::read(dir.join("nota.md")).unwrap(), b"original");
        assert!(temps(&dir).is_empty());
    }

    /// AC-R26-2: o disco não tem a base do app → `CONFLICT` e 0 bytes gravados.
    #[test]
    fn hash_mismatch_is_a_conflict_and_writes_nothing() {
        let v = TempDir::new();
        v.put("n.md", b"externo");
        let path = v.0.join("n.md");
        let before = modified(&path);
        assert_eq!(
            code(write_file(&v.0, "n.md", b"app", overwrite(b"base"))),
            "CONFLICT"
        );
        assert_eq!(fs::read(&path).unwrap(), b"externo");
        assert_eq!(modified(&path), before);
        assert!(temps(&v.0).is_empty());
    }

    /// AC-R26-2: uma mudança vinda da nuvem enquanto o temporário era gravado é pega na
    /// conferência final (a conferência e a troca andam juntas no Rust).
    #[test]
    fn external_change_during_the_save_is_a_conflict() {
        let v = TempDir::new();
        v.put("n.md", b"base");
        let path = v.0.join("n.md");
        let target = path.clone();
        let _hook = Hook::set(move |at| {
            if at == Step::Synced {
                fs::write(&target, b"da nuvem")?;
            }
            Ok(())
        });
        assert_eq!(
            code(write_file(&v.0, "n.md", b"app", overwrite(b"base"))),
            "CONFLICT"
        );
        assert_eq!(fs::read(&path).unwrap(), b"da nuvem");
        assert!(temps(&v.0).is_empty());
    }

    /// Review #4: a nota apagada durante o salvamento → `NOT_FOUND` (no TS, "apagada"); nada é
    /// recriado e o temporário some.
    #[test]
    fn target_deleted_during_the_save_is_not_found() {
        let v = TempDir::new();
        v.put("n.md", b"base");
        let target = v.0.join("n.md");
        let _hook = Hook::set(move |at| {
            if at == Step::Synced {
                fs::remove_file(&target)?;
            }
            Ok(())
        });
        assert_eq!(
            code(write_file(&v.0, "n.md", b"app", overwrite(b"base"))),
            "NOT_FOUND"
        );
        assert!(!v.0.join("n.md").exists());
        assert!(temps(&v.0).is_empty());
    }

    /// Bytes iguais aos do disco: nada é trocado (mesmo mtime; no Unix, o mesmo inode).
    #[test]
    fn bytes_already_on_disk_change_nothing() {
        let v = TempDir::new();
        v.put("n.md", b"igual");
        let path = v.0.join("n.md");
        let before = fs::metadata(&path).unwrap();
        write_file(&v.0, "n.md", b"igual", overwrite(b"igual")).unwrap();
        let after = fs::metadata(&path).unwrap();
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(after.ino(), before.ino());
        }
        assert!(temps(&v.0).is_empty());
    }

    /// AppSec N4: o conteúdo atual passa pelo sha256 aos pedaços; uma nota maior que o buffer de
    /// leitura dá o mesmo sha256 que o app calcula do texto inteiro.
    #[test]
    fn a_note_larger_than_the_read_buffer_is_hashed_whole() {
        let v = TempDir::new();
        let big: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
        v.put("grande.md", &big);
        write_file(&v.0, "grande.md", b"novo", overwrite(&big)).unwrap();
        assert_eq!(fs::read(v.0.join("grande.md")).unwrap(), b"novo");
    }

    /// Permissões do original copiadas; um arquivo sem escrita continua recusado (política igual).
    #[cfg(unix)]
    #[test]
    fn permissions_are_kept_and_a_read_only_file_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let v = TempDir::new();
        v.put("n.md", b"a");
        let path = v.0.join("n.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_file(&v.0, "n.md", b"b", overwrite(b"a")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"b");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o640
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let privileged = OpenOptions::new().write(true).open(&path).is_ok();
        let result = write_file(&v.0, "n.md", b"c", overwrite(b"b"));
        if !privileged {
            assert_eq!(code(result), "PERMISSION_DENIED");
            assert_eq!(fs::read(&path).unwrap(), b"b");
        }
        assert!(temps(&v.0).is_empty());
    }

    /// AppSec N3: sem o grupo do original (o usuário não é membro), só os bits do dono são copiados.
    /// O "original" é a raiz `/` (grupo do root, 0755); quem pode usar esse grupo copia tudo.
    #[cfg(unix)]
    #[test]
    fn without_the_original_group_only_the_owner_bits_are_copied() {
        use std::os::unix::fs::MetadataExt;
        let v = TempDir::new();
        v.put("t", b"");
        let file = OpenOptions::new().write(true).open(v.0.join("t")).unwrap();
        let root = fs::metadata("/").unwrap();
        copy_metadata(&file, &root).unwrap();
        let after = file.metadata().unwrap();
        let kept = if after.gid() == root.gid() {
            0o777
        } else {
            0o700
        };
        assert_eq!(after.mode() & 0o777, root.mode() & kept);
    }

    /// Windows: "oculto" e data de criação do original ficam; somente leitura continua recusado.
    #[cfg(windows)]
    #[test]
    fn hidden_and_creation_time_are_kept_and_read_only_is_refused() {
        use std::os::windows::fs::MetadataExt;
        use std::process::Command;
        let v = TempDir::new();
        v.put("n.md", b"a");
        let path = v.0.join("n.md");
        let created = fs::metadata(&path).unwrap().created().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(50));
        let hidden = Command::new("attrib")
            .arg("+h")
            .arg(&path)
            .status()
            .unwrap();
        assert!(hidden.success());
        write_file(&v.0, "n.md", b"b", overwrite(b"a")).unwrap();
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"b");
        assert_ne!(meta.file_attributes() & 0x2, 0, "oculto");
        assert_eq!(meta.created().unwrap(), created);
        let mut permissions = meta.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let result = write_file(&v.0, "n.md", b"c", overwrite(b"b"));
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)] // a limpeza do TempDir precisa apagar
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        assert_eq!(code(result), "PERMISSION_DENIED");
        assert_eq!(fs::read(&path).unwrap(), b"b");
        assert!(temps(&v.0).is_empty());
    }

    /// AC-R26-3 (API-04): um link físico dentro do vault para um arquivo de fora não escreve fora:
    /// a troca leva o nome para o arquivo novo e o de fora fica com o conteúdo antigo.
    #[test]
    fn hard_link_to_a_file_outside_is_not_written_through() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"fora");
        fs::hard_link(outside.0.join("segredo.md"), v.0.join("nota.md")).unwrap();
        write_file(&v.0, "nota.md", b"novo", overwrite(b"fora")).unwrap();
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        assert_eq!(fs::read(v.0.join("nota.md")).unwrap(), b"novo");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(v.0.join("nota.md")).unwrap().nlink(), 1);
        }
        assert!(temps(&v.0).is_empty());
    }

    /// AC-R26-3: um link plantado no destino entre a conferência e a troca é trocado (a entrada da
    /// pasta), nunca seguido: o arquivo de fora fica intacto.
    #[cfg(unix)]
    #[test]
    fn link_planted_right_before_the_swap_is_replaced_not_followed() {
        use std::os::unix::fs::symlink;
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.md", b"fora");
        v.put("nota.md", b"base");
        let (target, secret) = (v.0.join("nota.md"), outside.0.join("segredo.md"));
        let _hook = Hook::set(move |at| {
            if at == Step::Verified {
                fs::remove_file(&target)?;
                symlink(&secret, &target)?;
            }
            Ok(())
        });
        write_file(&v.0, "nota.md", b"app", overwrite(b"base")).unwrap();
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        assert!(fs::symlink_metadata(v.0.join("nota.md")).unwrap().is_file());
        assert_eq!(fs::read(v.0.join("nota.md")).unwrap(), b"app");
    }

    /// AC-R26-3 (TA-R2-10 na escrita): uma junção do Windows no caminho é recusada antes de criar
    /// qualquer temporário; nada é escrito na pasta de fora.
    #[cfg(windows)]
    #[test]
    fn junction_in_the_path_is_refused() {
        use crate::vault::ops::WriteMode;
        use std::process::Command;
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("nota.md", b"fora");
        let junction = Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(v.0.join("j"))
            .arg(&outside.0)
            .status()
            .unwrap();
        assert!(junction.success());
        assert_eq!(
            code(write_file(&v.0, "j/nota.md", b"x", overwrite(b"fora"))),
            "OUTSIDE_VAULT"
        );
        assert_eq!(
            code(write_file(&v.0, "j/nova.md", b"x", WriteMode::CreateNew)),
            "OUTSIDE_VAULT"
        );
        assert_eq!(fs::read(outside.0.join("nota.md")).unwrap(), b"fora");
        assert!(!outside.0.join("nova.md").exists());
        assert!(temps(&outside.0).is_empty());
    }

    /// AC-R26-3: tetos e classes iguais; o arquivo grande demais é recusado sem temporário.
    #[test]
    fn caps_are_unchanged() {
        let v = TempDir::new();
        let big = vec![b' '; 1024 * 1024 + 1];
        v.put(".simplemd/config.json", &big);
        assert_eq!(
            code(write_file(
                &v.0,
                ".simplemd/config.json",
                b"{}",
                overwrite(&big)
            )),
            "TOO_LARGE"
        );
        assert_eq!(
            fs::read(v.0.join(".simplemd/config.json")).unwrap().len(),
            big.len()
        );
        assert!(temps(&v.0.join(".simplemd")).is_empty());
        v.put(".simplemd/index.json", b"{}");
        write_file(&v.0, ".simplemd/index.json", b"{\"v\":3}", overwrite(b"{}")).unwrap();
        assert_eq!(
            fs::read(v.0.join(".simplemd/index.json")).unwrap(),
            b"{\"v\":3}"
        );
    }

    /// AC-R26-4: um temporário (em curso ou órfão de uma queda) nunca aparece na listagem.
    #[test]
    fn temps_are_never_listed() {
        let v = TempDir::new();
        v.put("a.md", b"a");
        v.put(".~simplemd-0123456789abcdef.tmp", b"orfao");
        v.put("sub/.~simplemd-fedcba9876543210.tmp", b"orfao");
        let names = |rel: &str| -> Vec<String> {
            let mut names: Vec<String> = read_dir(&v.0, rel)
                .unwrap()
                .into_iter()
                .map(|item| item.name)
                .collect();
            names.sort();
            names
        };
        assert_eq!(names(""), vec!["a.md".to_owned(), "sub".to_owned()]);
        assert!(names("sub").is_empty());
    }
}
