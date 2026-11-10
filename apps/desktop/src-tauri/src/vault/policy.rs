//! Política de caminhos do gateway do vault (arch-backend r2 §1.2): defesa em profundidade que
//! espelha `toVaultPath` e as classes de arquivo do `LocalFsProvider`. Puro: nenhuma chamada ao
//! sistema de arquivos. As mesmas regras valem em todo SO.

use icu_properties::props::DefaultIgnorableCodePoint;
use icu_properties::CodePointSetData;

use crate::error::AppError;

const MAX_LEN: usize = 1024;
const CONFIG_DIR: &str = ".simplemd";
/// Pasta de dependências do npm/pnpm: listada, nunca observada (r36a, D-R36-3).
const NODE_MODULES: &str = "node_modules";
/// Arquivos de configuração do vault lidos por plugins internos (r7 §1.13, D-R7-B18): lista
/// FECHADA, só leitura. Os dois da raiz são o único segmento oculto aceito fora de `.simplemd`, e
/// só como caminho de um segmento (`a/.markdownlint.json` continua recusado).
const ROOT_CONFIG_FILES: [&str; 2] = [".markdownlint.json", ".markdownlint.jsonc"];

const KIB: u64 = 1024;
const MIB: u64 = 1024 * KIB;
/// Extensão dos dicionários do usuário (r32, formato v1: UTF-8, um termo por linha).
const DICTIONARY_EXT: &str = ".txt";
/// Teto de um arquivo de dicionário, nas duas camadas: a global (`dictionaries`) e a da pasta
/// (`.simplemd/dictionaries`; r32 §1).
pub const DICTIONARY_MAX_BYTES: u64 = 10 * MIB;

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
        let config_file = i == 0 && segments.len() == 1 && ROOT_CONFIG_FILES.contains(segment);
        if segment.starts_with('.') && !(i == 0 && *segment == CONFIG_DIR) && !config_file {
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

/// Formatação invisível: a categoria Unicode `Cf` inteira (Unicode 15.1), a mesma lista de
/// `opener::is_format_char` — bidi (U+200E/F, U+202A–E, U+2066–9, U+061C), largura zero
/// (U+200B–D, U+2060–4), U+FEFF e o resto da categoria. Num nome, escondem ou reordenam o que se lê.
/// Também a regra dos termos do formato v1 na importação (`dictionaries::import`, r33).
pub(super) fn is_format_char(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// Invisível ou espaço fora de `Cc`/`Cf` (AppSec r36a N1; r37b, review r36a NB3): todo
/// `Default_Ignorable_Code_Point` pela tabela do `icu_properties` — o CGJ (U+034F), os seletores de
/// variação, os preenchedores Hangul (U+115F, U+1160, U+3164, U+FFA0), as vogais inerentes do khmer
/// (U+17B4, U+17B5) e os ainda não atribuídos (U+2065, U+FFF0–U+FFF8, U+E0000–U+E0FFF) —, o braille
/// vazio (U+2800), a cabeça de nota nula (U+1D159) e todo espaço em branco que não seja o U+0020
/// (`char::is_whitespace`: U+00A0 e os outros `Zs`, U+2028, U+2029). Num nome, somem na tela,
/// imitam um espaço ou quebram a linha.
fn is_invisible(c: char) -> bool {
    (c != ' ' && c.is_whitespace())
        || CodePointSetData::new::<DefaultIgnorableCodePoint>().contains(c)
        || matches!(c, '\u{2800}' | '\u{1D159}')
}

/// Nome de dispositivo do Windows como o Win32 o lê: o radical (até o primeiro `.`) sem os espaços
/// do fim — "con .txt" abre o CON. Além do que `is_windows_reserved` cobre: CONIN$/CONOUT$ e
/// COM¹–³/LPT¹–³, porque o Windows lê os sobrescritos do ISO 8859-1 como dígitos
/// (https://learn.microsoft.com/windows/win32/fileio/naming-a-file).
fn is_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_ascii_lowercase();
    let port = stem
        .strip_prefix("com")
        .or_else(|| stem.strip_prefix("lpt"));
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || port.is_some_and(|n| {
        matches!(
            n,
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        )
    })
}

fn has_ext(name: &str, ext: &str) -> bool {
    name.len() > ext.len()
        && name.as_bytes()[name.len() - ext.len()..].eq_ignore_ascii_case(ext.as_bytes())
}

/// Nome de um arquivo de dicionário (r32): UM segmento aceito por `validate_rel` e terminado em
/// `.txt`. É o nome que a camada global recebe do webview e o último segmento da classe
/// `.simplemd/dictionaries/<nome>.txt` da pasta: a mesma regra nas duas camadas. r36a (AppSec r32a,
/// item 3), antes de um nome aparecer na tela: também sem controle C1 nem formatação invisível
/// (`Cf`: bidi, largura zero), sem os invisíveis e espaços de fora dela (`is_invisible`; AppSec
/// r36a N1) e sem nome de dispositivo do Windows (`is_device_name`). Qualquer outra coisa (vazio,
/// `/`, `..`, oculto, outra extensão, nome reservado…) → `INVALID_PATH`.
///
/// Aceitos de propósito (D-R36A-FIX-1): NFC não é exigido — um nome NFD (o que o HFS+ devolve)
/// continua legível; `café.txt` em NFC e em NFD são dois nomes, e a criação de nomes em NFC fica no
/// TS (r33) —, e homóglifos (`pesso\u{430}l.txt`, com o `а` cirílico) passam: só uma tabela de
/// confusáveis por escrita os separaria.
pub fn dictionary_name(name: &str) -> Result<&str, AppError> {
    match validate_rel(name, false).as_deref() {
        Ok([single])
            if has_ext(single, DICTIONARY_EXT)
                && !single
                    .chars()
                    .any(|c| c.is_control() || is_format_char(c) || is_invisible(c))
                && !is_device_name(single) =>
        {
            Ok(name)
        }
        _ => Err(AppError::new("INVALID_PATH")),
    }
}

/// Classe de um arquivo (tabela do §1.2); `None` = nenhum acesso a arquivo nesse caminho.
pub fn file_class(segments: &[&str]) -> Option<FileClass> {
    let class = |read_cap, writable| Some(FileClass { read_cap, writable });
    match segments {
        [] => None,
        [name] if ROOT_CONFIG_FILES.contains(name) => class(Some(64 * KIB), false),
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
        [_, "latex-snippets.json"] => class(Some(256 * KIB), false),
        [_, "themes", _, "theme.json"] => class(Some(256 * KIB), true),
        [_, "plugins", _, "manifest.json"] => class(Some(64 * KIB), false),
        [_, "plugins", _, "data.json"] => class(Some(MIB), true),
        [_, "plugins", _, .., last] if has_ext(last, ".js") => class(Some(5 * MIB), false),
        // r32: dicionários da pasta, direto em `.simplemd/dictionaries` (sem subpastas).
        [_, "dictionaries", name] if dictionary_name(name).is_ok() => {
            class(Some(DICTIONARY_MAX_BYTES), true)
        }
        _ => None,
    }
}

/// Pastas que podem ser listadas: a raiz, pastas comuns, `.simplemd`, as árvores de temas e
/// plugins (só nomes e metadados) e a pasta dos dicionários (`.simplemd/dictionaries`, r32).
pub fn can_read_dir(segments: &[&str]) -> bool {
    match segments {
        [] => true,
        [name] if ROOT_CONFIG_FILES.contains(name) => false,
        [first, ..] if *first != CONFIG_DIR => true,
        [_] | [_, "themes", ..] | [_, "plugins", ..] | [_, "dictionaries"] => true,
        _ => false,
    }
}

/// Pastas que podem ser criadas: pastas comuns, `.simplemd`, `.simplemd/themes[/<slug>]` e
/// `.simplemd/dictionaries` (r32: o primeiro dicionário da pasta). Nada sob `.simplemd/plugins`
/// (instalar um plugin é copiar a pasta fora do app).
pub fn can_mkdir(segments: &[&str]) -> bool {
    match segments {
        [] => false,
        [name] if ROOT_CONFIG_FILES.contains(name) => false,
        [first, ..] if *first != CONFIG_DIR => true,
        [_] | [_, "themes"] | [_, "themes", _] | [_, "dictionaries"] => true,
        _ => false,
    }
}

/// Caminho que o observador do vault repassa ao webview (r36a, R21-RS-03, D-R36-4): só o que
/// `validate_rel` aceita (fora `.git`, `.env`, todo oculto e o temporário de uma gravação), nada
/// sob `node_modules` (listada, não observada; D-R36-3) e, em `.simplemd`, só arquivo com classe —
/// o que o gateway deixaria ler.
pub fn watchable(rel: &str) -> bool {
    validate_rel(rel, false).is_ok_and(|segments| {
        !segments.contains(&NODE_MODULES)
            && (segments.first() != Some(&CONFIG_DIR) || file_class(&segments).is_some())
    })
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
            // r7 §1.13: os dois arquivos do markdownlint só na raiz; o resto continua oculto.
            (".markdownlint.json", "OK"),
            (".markdownlint.jsonc", "OK"),
            ("a/.markdownlint.json", "PERMISSION_DENIED"),
            (".markdownlint.json/x.md", "PERMISSION_DENIED"),
            (".markdownlint.yaml", "PERMISSION_DENIED"),
            (".markdownlint.cjs", "PERMISSION_DENIED"),
            (".simplemd/latex-snippets.json", "OK"),
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
        assert_eq!(class(".markdownlint.json"), ro(Some(64 * KIB)));
        assert_eq!(class(".markdownlint.jsonc"), ro(Some(64 * KIB)));
        assert_eq!(class(".simplemd/latex-snippets.json"), ro(Some(256 * KIB)));
        // r32: dicionários da pasta, graváveis, 10 MiB, só `<nome>.txt` direto na pasta deles.
        assert_eq!(
            class(".simplemd/dictionaries/medicos.txt"),
            rw(Some(10 * MIB))
        );
        assert_eq!(
            class(".simplemd/dictionaries/Lista Antiga.TXT"),
            rw(Some(DICTIONARY_MAX_BYTES))
        );
        fn root_config(rel: &str) -> Vec<&str> {
            validate_rel(rel, true).unwrap()
        }
        assert!(!can_read_dir(&root_config(".markdownlint.json")));
        assert!(!can_mkdir(&root_config(".markdownlint.jsonc")));
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
            "dictionaries/x.txt",
            ".simplemd/x.txt",
            ".simplemd/dictionaries.txt",
            ".simplemd/dictionaries/x.md",
            ".simplemd/dictionaries/sub/x.txt",
            ".simplemd/dictionaries/.oculto.txt",
            ".simplemd/dictionaries/con.txt",
            ".simplemd/themes/meu/x.txt",
        ] {
            let segments = validate_rel(denied, false).map(|s| file_class(&s));
            assert!(matches!(segments, Ok(None) | Err(_)), "{denied}");
        }
    }

    #[test]
    fn has_ext_utf8() {
        for name in ["éé", "a😀", "メモ1", ".md", "md"] {
            assert!(!has_ext(name, ".md"), "{name}");
        }
        for name in ["nota.MD", "メモ.md", "a.md"] {
            assert!(has_ext(name, ".md"), "{name}");
        }
        assert!(!has_ext("é.j", ".js"));
    }

    /// r32: o nome de dicionário é um segmento só, aceito por `validate_rel`, com `.txt`; todo o
    /// resto vira `INVALID_PATH` (o mesmo código para a camada global e para a da pasta).
    #[test]
    fn dictionary_names_are_one_txt_segment() {
        let long_ok = format!("{}.txt", "a".repeat(1020));
        for ok in [
            "pessoal.txt",
            "médicos.txt",
            "Lista Antiga.TXT",
            "a.txt",
            "com0.txt",
            long_ok.as_str(),
        ] {
            assert_eq!(dictionary_name(ok).map_err(|e| e.code), Ok(ok), "{ok}");
        }
        let too_long = format!("{}.txt", "a".repeat(1021));
        for bad in [
            "",
            ".txt",
            "pessoal",
            "pessoal.md",
            "pessoal.txt.md",
            "a/b.txt",
            "../fora.txt",
            "..",
            "/etc/x.txt",
            "~/x.txt",
            "C:x.txt",
            ".oculto.txt",
            ".~simplemd-0123456789abcdef.tmp",
            ".simplemd",
            ".markdownlint.json",
            "a\\b.txt",
            "x:y.txt",
            "x.txt ",
            "x.txt.",
            "con.txt",
            "LPT1.txt",
            "x\n.txt",
            "x\u{0}.txt",
            too_long.as_str(),
        ] {
            assert_eq!(
                dictionary_name(bad).map_err(|e| e.code),
                Err("INVALID_PATH"),
                "{bad:?}"
            );
        }
    }

    /// r36a (AppSec r32a, item 3): o nome de dicionário também recusa o que `validate_rel` deixa
    /// passar — controle C1, formatação invisível (bidi, largura zero) e nome de dispositivo do
    /// Windows (COM¹–³/LPT¹–³, CONIN$/CONOUT$, reservado com espaço antes da extensão) —, nas duas
    /// camadas; nomes parecidos continuam valendo.
    #[test]
    fn dictionary_names_refuse_invisible_chars_and_device_names() {
        for bad in [
            "a\u{80}.txt",
            "a\u{85}b.txt",
            "\u{9f}x.txt",
            "abc\u{202E}txt.exe.txt",
            "a\u{2066}b\u{2069}.txt",
            "a\u{200F}.txt",
            "a\u{061C}.txt",
            "a\u{200B}b.txt",
            "a\u{200D}b.txt",
            "a\u{2060}b.txt",
            "\u{FEFF}pessoal.txt",
            "a\u{00AD}b.txt",
            "COM¹.txt",
            "com².txt",
            "lpt³.txt",
            "LPT¹.txt",
            "CONIN$.txt",
            "conout$.txt",
            "con .txt",
            "NUL  .txt",
            "aux .txt",
            "com1 .txt",
            "lpt² .txt",
            "conin$ .txt",
        ] {
            assert_eq!(
                dictionary_name(bad).map_err(|e| e.code),
                Err("INVALID_PATH"),
                "{bad:?}"
            );
            assert_eq!(
                file_class(&[CONFIG_DIR, "dictionaries", bad]),
                None,
                "{bad:?}"
            );
        }
        for ok in [
            "com0.txt",
            "com10.txt",
            "lpt.txt",
            "conin.txt",
            "console.txt",
            "contas .txt",
            "nul-x.txt",
            "a b.txt",
            "日記.txt",
        ] {
            assert_eq!(dictionary_name(ok).map_err(|e| e.code), Ok(ok), "{ok}");
        }
    }

    /// AppSec r36a N1 (prova A1): fora de `Cc`/`Cf`, o que some na tela, imita um espaço ou quebra
    /// a linha também é recusado, nas duas camadas. NFC × NFD e homóglifo continuam valendo
    /// (D-R36A-FIX-1, documentado em `dictionary_name`).
    #[test]
    fn dictionary_names_refuse_invisible_letters_and_non_ascii_spaces() {
        for bad in [
            "pessoal\u{034F}.txt",  // COMBINING GRAPHEME JOINER (Mn)
            "pessoal\u{FE00}.txt",  // VARIATION SELECTOR-1 (Mn)
            "pessoal\u{FE0F}.txt",  // VARIATION SELECTOR-16 (Mn)
            "pessoal\u{E0100}.txt", // VARIATION SELECTOR-17 (Mn)
            "pessoal\u{E01EF}.txt", // VARIATION SELECTOR-256 (Mn)
            "pessoal\u{180B}.txt",  // MONGOLIAN FREE VARIATION SELECTOR ONE (Mn)
            "pessoal\u{180F}.txt",  // MONGOLIAN FREE VARIATION SELECTOR FOUR (Mn)
            "\u{115F}pessoal.txt",  // HANGUL CHOSEONG FILLER (Lo)
            "pessoal\u{1160}.txt",  // HANGUL JUNGSEONG FILLER (Lo)
            "pessoal\u{3164}.txt",  // HANGUL FILLER (Lo)
            "pessoal\u{FFA0}.txt",  // HALFWIDTH HANGUL FILLER (Lo)
            "pessoal\u{2800}.txt",  // BRAILLE PATTERN BLANK (So)
            "pessoal\u{2028}x.txt", // LINE SEPARATOR (Zl)
            "pessoal\u{2029}x.txt", // PARAGRAPH SEPARATOR (Zp)
            "pessoal\u{00A0}.txt",  // NO-BREAK SPACE (Zs)
            "a\u{1680}b.txt",       // OGHAM SPACE MARK (Zs)
            "a\u{2000}b.txt",       // EN QUAD (Zs)
            "a\u{200A}b.txt",       // HAIR SPACE (Zs)
            "a\u{202F}b.txt",       // NARROW NO-BREAK SPACE (Zs)
            "a\u{205F}b.txt",       // MEDIUM MATHEMATICAL SPACE (Zs)
            "a\u{3000}b.txt",       // IDEOGRAPHIC SPACE (Zs)
        ] {
            assert_eq!(
                dictionary_name(bad).map_err(|e| e.code),
                Err("INVALID_PATH"),
                "{bad:?}"
            );
            assert_eq!(
                file_class(&[CONFIG_DIR, "dictionaries", bad]),
                None,
                "{bad:?}"
            );
        }
        for ok in [
            "caf\u{E9}.txt",     // NFC
            "cafe\u{301}.txt",   // NFD: NFC não é exigido
            "pesso\u{430}l.txt", // homóglifo cirílico
            "Lista Antiga.txt",
            "한국어.txt",
            "\u{2764}.txt", // sem seletor de variação
        ] {
            assert_eq!(dictionary_name(ok).map_err(|e| e.code), Ok(ok), "{ok:?}");
        }
    }

    /// Review r36a NB3 (r37b): todo `Default_Ignorable_Code_Point` é recusado nas duas camadas —
    /// os que a sonda achou passando (U+17B4/5, U+2065, U+FFF0, U+E0002), os não atribuídos do
    /// fim do plano 14 e a propriedade inteira —, e também o U+1D159; uma marca combinante comum
    /// (NFD) e a vogal khmer visível continuam valendo.
    #[test]
    fn dictionary_names_refuse_every_default_ignorable() {
        for bad in [
            '\u{17B4}',  // KHMER VOWEL INHERENT AQ (Mn)
            '\u{17B5}',  // KHMER VOWEL INHERENT AA (Mn)
            '\u{2065}',  // não atribuído (Cn)
            '\u{FFF0}',  // não atribuído (Cn)
            '\u{FFF8}',  // não atribuído (Cn)
            '\u{E0000}', // não atribuído (Cn)
            '\u{E0002}', // não atribuído (Cn)
            '\u{E01F0}', // não atribuído (Cn)
            '\u{E0FFF}', // não atribuído (Cn)
            '\u{1D159}', // MUSICAL SYMBOL NULL NOTEHEAD (So)
        ] {
            let name = format!("pessoal{bad}.txt");
            assert_eq!(
                dictionary_name(&name).map_err(|e| e.code),
                Err("INVALID_PATH"),
                "{bad:?}"
            );
            assert_eq!(
                file_class(&[CONFIG_DIR, "dictionaries", &name]),
                None,
                "{bad:?}"
            );
        }
        let ignorable = CodePointSetData::new::<DefaultIgnorableCodePoint>();
        let all: Vec<char> = (0..=0x10_FFFF)
            .filter_map(char::from_u32)
            .filter(|&c| ignorable.contains(c))
            .collect();
        assert!(all.len() > 4_000, "{}", all.len());
        for c in all {
            let name = format!("a{c}.txt");
            assert!(dictionary_name(&name).is_err(), "{c:?}");
        }
        for ok in ["cafe\u{301}.txt", "\u{1780}\u{17B6}.txt"] {
            assert_eq!(dictionary_name(ok).map_err(|e| e.code), Ok(ok), "{ok:?}");
        }
    }

    /// Tabela única de nomes de dicionário com o TS (r41e; `packages/vault/test/
    /// dictionary-names.test.ts`): `isDictionaryName`, `toVaultPath` e a classe de dicionário do
    /// `LocalFsProvider` recusam exatamente o que `dictionary_name`/`file_class` recusam — caixa,
    /// `Default_Ignorable`, teto em pontos de código e, em `refusedInside`, todo ponto de código.
    const NAMES: &str =
        include_str!("../../../../../packages/vault/test/fixtures/dictionary-names.json");

    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum Item {
        Text(String),
        Repeat {
            #[serde(default)]
            prefix: String,
            repeat: String,
            times: usize,
            #[serde(default)]
            suffix: String,
        },
    }

    impl Item {
        fn text(&self) -> String {
            match self {
                Item::Text(text) => text.clone(),
                Item::Repeat {
                    prefix,
                    repeat,
                    times,
                    suffix,
                } => format!("{prefix}{}{suffix}", repeat.repeat(*times)),
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct Table {
        accept: Vec<Item>,
        refuse: Vec<Item>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Names {
        names: Table,
        paths: Table,
        refused_inside: Vec<(String, String)>,
    }

    #[test]
    fn dictionary_names_follow_the_shared_fixture() {
        let fixture: Names = serde_json::from_str(NAMES).unwrap();
        for name in fixture.names.accept.iter().map(Item::text) {
            assert!(dictionary_name(&name).is_ok(), "{name:?}");
        }
        for name in fixture.names.refuse.iter().map(Item::text) {
            assert!(dictionary_name(&name).is_err(), "{name:?}");
        }
        let class = |rel: &str| validate_rel(rel, false).ok().and_then(|s| file_class(&s));
        let dictionary = Some(FileClass {
            read_cap: Some(DICTIONARY_MAX_BYTES),
            writable: true,
        });
        for rel in fixture.paths.accept.iter().map(Item::text) {
            assert_eq!(class(&rel), dictionary, "{rel:?}");
        }
        for rel in fixture.paths.refuse.iter().map(Item::text) {
            assert_eq!(class(&rel), None, "{rel:?}");
        }
        let ranges: Vec<(u32, u32)> = fixture
            .refused_inside
            .iter()
            .map(|(from, to)| {
                let hex = |h: &str| u32::from_str_radix(h, 16).unwrap();
                (hex(from), hex(to))
            })
            .collect();
        let wrong: Vec<String> = (0..=0x10_FFFF)
            .filter_map(char::from_u32)
            .filter(|&c| {
                let refused = ranges
                    .iter()
                    .any(|&(from, to)| (from..=to).contains(&(c as u32)));
                dictionary_name(&format!("a{c}.txt")).is_err() != refused
            })
            .map(|c| format!("U+{:04X}", c as u32))
            .collect();
        assert_eq!(wrong, Vec::<String>::new());
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
            ".simplemd/dictionaries",
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
        for denied in [".simplemd/outra", ".simplemd/dictionaries/sub"] {
            assert!(!can_read_dir(&segs(denied)), "read_dir {denied}");
        }
        for ok in [
            "pasta",
            "a/b/c",
            ".simplemd",
            ".simplemd/themes",
            ".simplemd/themes/x",
            ".simplemd/dictionaries",
        ] {
            assert!(can_mkdir(&segs(ok)), "mkdir {ok}");
        }
        for denied in [
            "",
            ".simplemd/themes/x/y",
            ".simplemd/outra",
            ".simplemd/dictionaries/sub",
        ] {
            assert!(!can_mkdir(&segs(denied)), "mkdir {denied}");
        }
    }

    /// AC-R36-1 (R21-RS-03, D-R36-3/4): o observador só repassa o que o gateway deixaria alcançar.
    #[test]
    fn watchable_follows_the_gateway() {
        for ok in [
            "nota.md",
            "pasta/sub/nota.md",
            "pasta",
            "imagens/foto.png",
            ".markdownlint.json",
            ".simplemd/config.json",
            ".simplemd/latex-snippets.json",
            ".simplemd/themes/meu/theme.json",
            ".simplemd/plugins/p/main.js",
            ".simplemd/dictionaries/pessoal.txt",
        ] {
            assert!(watchable(ok), "{ok}");
        }
        for denied in [
            "",
            ".git",
            ".git/config",
            ".git/objects/ab/cdef",
            ".env",
            "pasta/.oculto.md",
            ".~simplemd-0123456789abcdef.tmp",
            "pasta/.~simplemd-0123456789abcdef.tmp",
            "node_modules",
            "node_modules/pacote/README.md",
            "pasta/node_modules/x.md",
            ".simplemd",
            ".simplemd/outro.json",
            ".simplemd/themes/meu",
            ".simplemd/dictionaries",
            ".simplemd/dictionaries/.oculto.txt",
            ".simplemd/dictionaries/con .txt",
            "a/.markdownlint.json",
            "../fora.md",
            "a//b.md",
            "con.md",
        ] {
            assert!(!watchable(denied), "{denied}");
        }
    }
}
