//! Política de caminhos do gateway do vault (arch-backend r2 §1.2): defesa em profundidade que
//! espelha `toVaultPath` e as classes de arquivo do `LocalFsProvider`. Puro: nenhuma chamada ao
//! sistema de arquivos. As mesmas regras valem em todo SO.

use crate::error::AppError;

const MAX_LEN: usize = 1024;
const CONFIG_DIR: &str = ".simplemd";

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;

/// O que um caminho de arquivo permite: teto de leitura (`None` = sem teto, r1 OQ-2/AS-09) e se a
/// escrita é aceita. Código de plugin e manifestos nunca são graváveis pelo IPC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileClass {
    pub read_cap: Option<u64>,
    pub writable: bool,
}

/// Valida um caminho relativo ao vault (`/` em todo SO) e devolve os segmentos. `''` (a raiz) só
/// quando `allow_root`. Estrutura inválida → `INVALID_PATH`; sair da raiz → `OUTSIDE_VAULT`;
/// segmento oculto que não seja `.simplemd` no início → `PERMISSION_DENIED` (pasta proibida).
pub fn validate_rel(rel: &str, allow_root: bool) -> Result<Vec<&str>, AppError> {
    if rel.is_empty() {
        return if allow_root {
            Ok(Vec::new())
        } else {
            Err(AppError::new("INVALID_PATH"))
        };
    }
    if rel.chars().count() > MAX_LEN || rel.chars().any(|c| c.is_ascii_control()) {
        return Err(AppError::new("INVALID_PATH"));
    }
    if rel.contains('\\') {
        return Err(AppError::new("INVALID_PATH"));
    }
    let bytes = rel.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if rel.starts_with('/') || rel.starts_with('~') || drive {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    let segments: Vec<&str> = rel.split('/').collect();
    if segments.contains(&"..") {
        return Err(AppError::new("OUTSIDE_VAULT"));
    }
    for (i, segment) in segments.iter().enumerate() {
        if segment.is_empty() || *segment == "." {
            return Err(AppError::new("INVALID_PATH"));
        }
        if segment.starts_with('.') && !(i == 0 && *segment == CONFIG_DIR) {
            return Err(AppError::new("PERMISSION_DENIED"));
        }
        if segment.contains(':') || segment.ends_with(' ') || segment.ends_with('.') {
            return Err(AppError::new("INVALID_PATH"));
        }
        if is_windows_reserved(segment) {
            return Err(AppError::new("INVALID_PATH"));
        }
    }
    Ok(segments)
}

fn is_windows_reserved(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or(segment)
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn has_ext(name: &str, ext: &str) -> bool {
    name.len() > ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext)
}

/// Classe de um arquivo (tabela do §1.2); `None` = nenhum acesso a arquivo nesse caminho.
pub fn file_class(segments: &[&str]) -> Option<FileClass> {
    let class = |read_cap, writable| Some(FileClass { read_cap, writable });
    match segments {
        [] => None,
        [first, ..] if *first != CONFIG_DIR => {
            let name = segments[segments.len() - 1];
            if has_ext(name, ".md") {
                class(None, true)
            } else {
                None
            }
        }
        [_, "config.json"] => class(Some(MIB), true),
        [_, "index.json"] => class(Some(20 * MIB), true),
        [_, "themes", _, "theme.json"] => class(Some(256 * KIB), true),
        [_, "plugins", _, "manifest.json"] => class(Some(64 * KIB), false),
        [_, "plugins", _, "data.json"] => class(Some(MIB), true),
        [_, "plugins", _, .., last] if has_ext(last, ".js") => class(Some(5 * MIB), false),
        _ => None,
    }
}

/// Pastas que podem ser listadas: a raiz, pastas comuns, `.simplemd` e as árvores de temas e
/// plugins (só nomes e metadados).
pub fn can_read_dir(segments: &[&str]) -> bool {
    match segments {
        [] => true,
        [first, ..] if *first != CONFIG_DIR => true,
        [_] | [_, "themes", ..] | [_, "plugins", ..] => true,
        _ => false,
    }
}

/// Pastas que podem ser criadas: pastas comuns, `.simplemd`, `.simplemd/themes[/<slug>]`. Nada
/// sob `.simplemd/plugins` (instalar um plugin é copiar a pasta fora do app).
pub fn can_mkdir(segments: &[&str]) -> bool {
    match segments {
        [] => false,
        [first, ..] if *first != CONFIG_DIR => true,
        [_] | [_, "themes"] | [_, "themes", _] => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(rel: &str) -> &'static str {
        match validate_rel(rel, false) {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    /// Entradas de travessia do r1 (V-10 / traversal.test.ts) e as regras do §1.2.
    #[test]
    fn rel_validation_table() {
        let table: &[(&str, &str)] = &[
            ("nota.md", "OK"),
            ("pasta/sub/nota.md", "OK"),
            (".simplemd/config.json", "OK"),
            ("", "INVALID_PATH"),
            ("../fora.md", "OUTSIDE_VAULT"),
            ("a/../../fora.md", "OUTSIDE_VAULT"),
            ("..", "OUTSIDE_VAULT"),
            ("/etc/passwd", "OUTSIDE_VAULT"),
            ("~/x.md", "OUTSIDE_VAULT"),
            ("C:/Windows/x.md", "OUTSIDE_VAULT"),
            ("c:x.md", "OUTSIDE_VAULT"),
            ("a\\b.md", "INVALID_PATH"),
            ("..\\fora.md", "INVALID_PATH"),
            ("a//b.md", "INVALID_PATH"),
            ("./a.md", "INVALID_PATH"),
            ("a/./b.md", "INVALID_PATH"),
            ("a/", "INVALID_PATH"),
            ("nota\u{0}.md", "INVALID_PATH"),
            ("nota\n.md", "INVALID_PATH"),
            ("nota\u{7f}.md", "INVALID_PATH"),
            (".git/config", "PERMISSION_DENIED"),
            (".env", "PERMISSION_DENIED"),
            ("a/.simplemd/config.json", "PERMISSION_DENIED"),
            ("pasta/.oculto.md", "PERMISSION_DENIED"),
            ("a.md:stream", "INVALID_PATH"),
            ("nota.md ", "INVALID_PATH"),
            ("nota.md.", "INVALID_PATH"),
            ("CON", "INVALID_PATH"),
            ("con.md", "INVALID_PATH"),
            ("pasta/LPT1.md", "INVALID_PATH"),
            ("com9", "INVALID_PATH"),
            ("com0.md", "OK"),
            ("console.md", "OK"),
        ];
        for (rel, expected) in table {
            assert_eq!(code(rel), *expected, "{rel:?}");
        }
        assert_eq!(code(&"a".repeat(1025)), "INVALID_PATH");
        assert_eq!(code(&format!("{}.md", "a".repeat(1021))), "OK");
        assert_eq!(validate_rel("", true).unwrap(), Vec::<&str>::new());
    }

    #[test]
    fn class_table_read_write() {
        let class = |rel: &str| file_class(&validate_rel(rel, false).unwrap());
        let rw = |cap| {
            Some(FileClass {
                read_cap: cap,
                writable: true,
            })
        };
        let ro = |cap| {
            Some(FileClass {
                read_cap: cap,
                writable: false,
            })
        };
        assert_eq!(class("nota.md"), rw(None));
        assert_eq!(class("pasta/NOTA.MD"), rw(None));
        assert_eq!(class(".simplemd/config.json"), rw(Some(MIB)));
        assert_eq!(class(".simplemd/index.json"), rw(Some(20 * MIB)));
        assert_eq!(
            class(".simplemd/themes/meu/theme.json"),
            rw(Some(256 * KIB))
        );
        assert_eq!(
            class(".simplemd/plugins/p/manifest.json"),
            ro(Some(64 * KIB))
        );
        assert_eq!(class(".simplemd/plugins/p/data.json"), rw(Some(MIB)));
        assert_eq!(class(".simplemd/plugins/p/main.js"), ro(Some(5 * MIB)));
        assert_eq!(class(".simplemd/plugins/p/lib/util.js"), ro(Some(5 * MIB)));
        for denied in [
            "nota.txt",
            "imagem.png",
            ".md",
            ".simplemd/outro.json",
            ".simplemd/nota.md",
            ".simplemd/themes/meu/other.json",
            ".simplemd/themes/theme.json",
            ".simplemd/plugins/p/x.json",
            ".simplemd/plugins/main.js",
            ".simplemd/x.js",
            "pasta/script.js",
        ] {
            let segments = validate_rel(denied, false).map(|s| file_class(&s));
            assert!(matches!(segments, Ok(None) | Err(_)), "{denied}");
        }
    }

    #[test]
    fn dir_rules() {
        fn segs(rel: &str) -> Vec<&str> {
            validate_rel(rel, true).unwrap()
        }
        for ok in [
            "",
            "pasta",
            "pasta/sub",
            ".simplemd",
            ".simplemd/themes",
            ".simplemd/themes/x",
        ] {
            assert!(can_read_dir(&segs(ok)), "read_dir {ok}");
        }
        for ok in [
            ".simplemd/plugins",
            ".simplemd/plugins/p",
            ".simplemd/plugins/p/lib",
        ] {
            assert!(can_read_dir(&segs(ok)), "read_dir {ok}");
            assert!(!can_mkdir(&segs(ok)), "mkdir {ok}");
        }
        assert!(!can_read_dir(&segs(".simplemd/outra")));
        for ok in [
            "pasta",
            "a/b/c",
            ".simplemd",
            ".simplemd/themes",
            ".simplemd/themes/x",
        ] {
            assert!(can_mkdir(&segs(ok)), "mkdir {ok}");
        }
        for denied in ["", ".simplemd/themes/x/y", ".simplemd/outra"] {
            assert!(!can_mkdir(&segs(denied)), "mkdir {denied}");
        }
    }
}
