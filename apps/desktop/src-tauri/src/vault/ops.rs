//! Operações de arquivo do gateway sobre uma raiz já resolvida (arch-backend r2 §1.2). Toda
//! operação valida o caminho e a classe ANTES de qualquer syscall, percorre os prefixos com
//! `symlink_metadata` (links e junções são recusados) e nunca sai da raiz: não há canonicalização
//! dos caminhos juntados.

use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::policy::{can_mkdir, can_read_dir, file_class, validate_rel};
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirItem {
    pub name: String,
    pub kind: Kind,
    pub size: u64,
    pub mtime: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    CreateNew,
    Overwrite,
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

fn stat_of(meta: &Metadata) -> Stat {
    Stat {
        kind: kind_of(meta),
        size: meta.len(),
        mtime: mtime_ms(meta),
    }
}

fn join(root: &Path, segments: &[&str]) -> PathBuf {
    let mut path = root.to_path_buf();
    for segment in segments {
        path.push(segment);
    }
    path
}

/// `symlink_metadata` em cada prefixo existente, sempre dentro da raiz. Um link (ou junção) num
/// componente intermediário → `OUTSIDE_VAULT`; o último componente é devolvido como está.
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

/// Percurso para operar no último componente: link → `OUTSIDE_VAULT`, intermediário que não é
/// pasta → `INVALID_PATH`.
fn walk_target(root: &Path, segments: &[&str]) -> Result<Option<Metadata>, AppError> {
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
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else {
            continue; // nome que não é UTF-8: a guarda do provider o recusaria de qualquer forma
        };
        let meta = entry.metadata()?;
        let stat = stat_of(&meta);
        items.push(DirItem {
            name,
            kind: stat.kind,
            size: stat.size,
            mtime: stat.mtime,
        });
    }
    Ok(items)
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
    let file = File::open(join(root, &segments))?;
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

fn too_large(size: u64) -> AppError {
    AppError::new("TOO_LARGE").with_detail(serde_json::json!({ "size": size }))
}

/// Grava num arquivo de uma classe gravável. `CreateNew` falha com `ALREADY_EXISTS` se existir;
/// `Overwrite` grava no lugar e nunca cria (inexistente → `NOT_FOUND`).
pub fn write_file(root: &Path, rel: &str, bytes: &[u8], mode: WriteMode) -> Result<(), AppError> {
    let segments = validate_rel(rel, false)?;
    let class = file_class(&segments).ok_or_else(|| AppError::new("PERMISSION_DENIED"))?;
    if !class.writable {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    match (walk_target(root, &segments)?, mode) {
        (Some(_), WriteMode::CreateNew) => return Err(AppError::new("ALREADY_EXISTS")),
        (None, WriteMode::Overwrite) => return Err(AppError::new("NOT_FOUND")),
        (Some(meta), WriteMode::Overwrite) if !meta.is_file() => {
            return Err(AppError::new("INVALID_PATH"))
        }
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.write(true);
    match mode {
        WriteMode::CreateNew => options.create_new(true),
        WriteMode::Overwrite => options.truncate(true),
    };
    let mut file = options.open(join(root, &segments))?;
    file.write_all(bytes)?;
    Ok(())
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

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    #[test]
    fn read_write_roundtrip_and_modes() {
        let v = TempDir::new();
        v.put("a.md", b"\xEF\xBB\xBFa\r\n");
        assert_eq!(read_file(&v.0, "a.md").unwrap(), b"\xEF\xBB\xBFa\r\n");
        write_file(&v.0, "a.md", b"novo", WriteMode::Overwrite).unwrap();
        assert_eq!(fs::read(v.0.join("a.md")).unwrap(), b"novo");
        assert_eq!(
            code(write_file(&v.0, "a.md", b"x", WriteMode::CreateNew)),
            "ALREADY_EXISTS"
        );
        assert_eq!(fs::read(v.0.join("a.md")).unwrap(), b"novo");
        assert_eq!(
            code(write_file(&v.0, "b.md", b"x", WriteMode::Overwrite)),
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
            for mode in [WriteMode::CreateNew, WriteMode::Overwrite] {
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
            code(write_file(&v.0, "atalho.md", b"x", WriteMode::Overwrite)),
            "OUTSIDE_VAULT"
        );
        assert_eq!(fs::read(outside.0.join("segredo.md")).unwrap(), b"fora");
        let items = read_dir(&v.0, "").unwrap();
        assert!(items.iter().all(|i| i.kind == Kind::Symlink));
    }
}
