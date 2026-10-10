//! Leitura binária de imagens do vault (r7 arch-backend §1.3; R-I1.7, U-4, D-32, D-R7-B01). Só 5
//! tipos (png, jpg/jpeg, gif, webp, svg); extensão e bytes mágicos precisam concordar (um `.png`
//! com bytes JPEG, HTML ou SVG é recusado). A política de caminho é a do gateway (`validate_rel` +
//! percurso sem links + abertura `O_NOFOLLOW`/`FILE_FLAG_OPEN_REPARSE_POINT`), e nenhuma imagem
//! sob `.simplemd/` é servida. A leitura para em `teto + 1` bytes; nada atravessa o IPC antes da
//! checagem de tipo.

use std::fs::OpenOptions;
use std::path::Path;

use super::ops::{join, open_no_follow, read_capped, walk_target};
use super::policy::validate_rel;
use crate::error::AppError;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ImageKind {
    Png,
    Jpeg,
    Gif,
    Webp,
    Svg,
}

/// Teto das imagens raster (NFR-45).
pub const RASTER_MAX: u64 = 20 * 1024 * 1024;
/// Teto do SVG (texto; NFR-45).
pub const SVG_MAX: u64 = 2 * 1024 * 1024;
/// Janela em que o `<svg` precisa aparecer.
pub const SVG_SNIFF: usize = 4096;
const CONFIG_DIR: &str = ".simplemd";

/// Tipo pela extensão do nome (sem caixa); qualquer outra → `None`.
pub fn kind_of_name(name: &str) -> Option<ImageKind> {
    let (stem, ext) = name.rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => ImageKind::Png,
        "jpg" | "jpeg" => ImageKind::Jpeg,
        "gif" => ImageKind::Gif,
        "webp" => ImageKind::Webp,
        "svg" => ImageKind::Svg,
        _ => return None,
    })
}

pub fn cap(kind: ImageKind) -> u64 {
    match kind {
        ImageKind::Svg => SVG_MAX,
        _ => RASTER_MAX,
    }
}

/// Os bytes são do tipo `kind`? (tabela do §1.3; a mesma de `image-type.ts`).
pub fn sniff(kind: ImageKind, bytes: &[u8]) -> bool {
    match kind {
        ImageKind::Png => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        ImageKind::Jpeg => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        ImageKind::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        ImageKind::Webp => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        ImageKind::Svg => sniff_svg(bytes),
    }
}

/// SVG: depois do BOM UTF-8 opcional e de espaços ASCII, o 1º byte é `<`; os primeiros 4.096 bytes
/// (em minúsculas ASCII) contêm `<svg`; o texto não começa por `<!doctype html` nem `<html`.
/// UTF-16 e gzip (`svgz`) caem fora: o 1º byte não é `<` ou o `<svg` não aparece em ASCII.
/// É CONFERÊNCIA DE TIPO, não sanitização (SN-SEC-05): um SVG com `<script>` (ou um poliglota com
/// `<html>` depois de um comentário) passa. A fronteira é o contexto `<img src=blob:>` no webview.
fn sniff_svg(bytes: &[u8]) -> bool {
    let window: Vec<u8> = bytes[..bytes.len().min(SVG_SNIFF)].to_ascii_lowercase();
    let body = window.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&window);
    let start = body
        .iter()
        .position(|b| !matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0C))
        .unwrap_or(body.len());
    let body = &body[start..];
    body.first() == Some(&b'<')
        && !body.starts_with(b"<!doctype html")
        && !body.starts_with(b"<html")
        && window.windows(4).any(|w| w == b"<svg")
}

/// Lê uma imagem do vault. Ordem (a primeira falha decide): estrutura do caminho
/// (`OUTSIDE_VAULT`/`PERMISSION_DENIED`/`INVALID_PATH`) → pasta de configuração
/// (`PERMISSION_DENIED`) → extensão (`UNSUPPORTED_IMAGE`) → percurso sem links (`OUTSIDE_VAULT`,
/// `NOT_FOUND`, `INVALID_PATH`) → abertura sem seguir link → (Unix) hard link `OUTSIDE_VAULT` →
/// teto (`TOO_LARGE` com `{size, cap}`, no máximo `teto + 1` bytes lidos) → bytes mágicos
/// (`UNSUPPORTED_IMAGE`).
pub fn read_image(root: &Path, rel: &str) -> Result<Vec<u8>, AppError> {
    let segments = validate_rel(rel, false)?;
    if segments.first() == Some(&CONFIG_DIR) {
        return Err(AppError::new("PERMISSION_DENIED"));
    }
    let name = segments.last().copied().unwrap_or_default();
    let kind = kind_of_name(name).ok_or_else(|| AppError::new("UNSUPPORTED_IMAGE"))?;
    match walk_target(root, &segments)? {
        None => return Err(AppError::new("NOT_FOUND")),
        Some(meta) if !meta.is_file() => return Err(AppError::new("INVALID_PATH")),
        Some(_) => {}
    }
    let file = open_no_follow(&join(root, &segments), OpenOptions::new().read(true))?;
    // SN-SEC-06: com `O_NOFOLLOW`, um hard link para um arquivo de fora é indistinguível de um
    // arquivo comum; o único sinal é `nlink > 1` no arquivo já aberto (sem corrida). No Windows a
    // contagem de links não é API estável do std: registrado em MELHORIAS (docs-notes SN).
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata()?.nlink() > 1 {
            return Err(AppError::new("OUTSIDE_VAULT"));
        }
    }
    let limit = cap(kind);
    let bytes = read_capped(file, Some(limit)).map_err(|error| match error.code {
        "TOO_LARGE" => {
            let size = error
                .detail
                .as_ref()
                .and_then(|d| d.get("size"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            AppError::new("TOO_LARGE")
                .with_detail(serde_json::json!({ "size": size, "cap": limit }))
        }
        _ => error,
    })?;
    if !sniff(kind, &bytes) {
        return Err(AppError::new("UNSUPPORTED_IMAGE"));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::super::ops::tests::TempDir;
    use super::*;
    use serde::Deserialize;
    use std::fs;

    /// Tabela única de paridade com `packages/vault/src/image-type.ts` (§5.3).
    const CASES: &str =
        include_str!("../../../../../packages/vault/test/fixtures/image-magic-cases.json");

    #[derive(Deserialize)]
    struct Case {
        name: String,
        hex: Option<String>,
        text: Option<String>,
        expect: String,
    }

    fn bytes_of(case: &Case) -> Vec<u8> {
        match (&case.hex, &case.text) {
            (Some(hex), None) => (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect(),
            (None, Some(text)) => text.as_bytes().to_vec(),
            _ => panic!("caso {} precisa de hex OU text", case.name),
        }
    }

    fn code<T>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "ok",
            Err(e) => e.code,
        }
    }

    const PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D,
    ];
    const JPEG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F'];

    #[test]
    fn magic_matches_shared_table() {
        let cases: Vec<Case> = serde_json::from_str(CASES).unwrap();
        assert!(cases.len() >= 25, "{} casos", cases.len());
        for case in &cases {
            let bytes = bytes_of(case);
            let got = match kind_of_name(&case.name) {
                Some(kind) if sniff(kind, &bytes) => "ok",
                _ => "UNSUPPORTED_IMAGE",
            };
            assert_eq!(got, case.expect, "{}", case.name);
            // Mesmo resultado lendo do disco (caminho completo do comando).
            let v = TempDir::new();
            v.put(&case.name, &bytes);
            assert_eq!(
                code(read_image(&v.0, &case.name)),
                case.expect,
                "{} (disco)",
                case.name
            );
        }
    }

    #[test]
    fn extension_magic_mismatch_refused() {
        let v = TempDir::new();
        v.put("a.png", JPEG);
        v.put(
            "b.png",
            b"<!doctype html><html><script>alert(1)</script></html>",
        );
        v.put("c.png", b"<svg xmlns='http://www.w3.org/2000/svg'/>");
        v.put("d.jpg", PNG);
        for rel in ["a.png", "b.png", "c.png", "d.jpg"] {
            assert_eq!(code(read_image(&v.0, rel)), "UNSUPPORTED_IMAGE", "{rel}");
        }
        v.put("ok.png", PNG);
        assert_eq!(read_image(&v.0, "ok.png").unwrap(), PNG);
    }

    #[test]
    fn svg_rules() {
        let ok: [&[u8]; 4] = [
            b"<svg xmlns='http://www.w3.org/2000/svg'/>",
            b"\xEF\xBB\xBF<svg/>",
            b"<?xml version=\"1.0\"?>\n<svg/>",
            b"  \r\n\t<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x\"><SVG/>",
        ];
        for bytes in ok {
            assert!(
                sniff(ImageKind::Svg, bytes),
                "{:?}",
                String::from_utf8_lossy(bytes)
            );
        }
        let refused: [&[u8]; 6] = [
            b"<!doctype html><svg/>",
            b"<HTML><svg/></HTML>",
            b"\xFF\xFE<\x00s\x00v\x00g\x00",
            b"<\x00s\x00v\x00g\x00",
            b"\x1F\x8B\x08\x00",
            b"texto <svg/>",
        ];
        for bytes in refused {
            assert!(!sniff(ImageKind::Svg, bytes), "{bytes:?}");
        }
        // `<svg` depois dos primeiros 4.096 bytes não conta.
        let mut late = b"<?xml version=\"1.0\"?>".to_vec();
        late.resize(SVG_SNIFF, b' ');
        late.extend_from_slice(b"<svg/>");
        assert!(!sniff(ImageKind::Svg, &late));
        late.truncate(SVG_SNIFF - 6);
        late.extend_from_slice(b"<svg/>");
        assert!(sniff(ImageKind::Svg, &late));
    }

    #[test]
    fn raster_cap_plus_one_refused_reads_at_most_cap_plus_one() {
        let v = TempDir::new();
        let mut big = PNG.to_vec();
        big.resize(RASTER_MAX as usize, 0);
        v.put("exata.png", &big);
        assert_eq!(
            read_image(&v.0, "exata.png").unwrap().len() as u64,
            RASTER_MAX
        );
        big.push(0);
        v.put("grande.png", &big);
        let error = read_image(&v.0, "grande.png").unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({ "size": RASTER_MAX + 1, "cap": RASTER_MAX }))
        );
        // A leitura limitada (o arquivo cresce entre o `stat` e a leitura) para em teto + 1.
        let file = fs::File::open(v.0.join("grande.png")).unwrap();
        assert_eq!(code(read_capped(file, Some(RASTER_MAX))), "TOO_LARGE");
    }

    #[test]
    fn svg_cap_plus_one() {
        let v = TempDir::new();
        let mut svg = b"<svg>".to_vec();
        svg.resize(SVG_MAX as usize, b' ');
        v.put("ok.svg", &svg);
        assert_eq!(code(read_image(&v.0, "ok.svg")), "ok");
        svg.push(b' ');
        v.put("grande.svg", &svg);
        let error = read_image(&v.0, "grande.svg").unwrap_err();
        assert_eq!(
            error.detail,
            Some(serde_json::json!({ "size": SVG_MAX + 1, "cap": SVG_MAX }))
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_final_and_intermediate_refused() {
        use std::os::unix::fs::symlink;
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("fora.png", PNG);
        symlink(outside.0.join("fora.png"), v.0.join("atalho.png")).unwrap();
        symlink(&outside.0, v.0.join("pasta")).unwrap();
        assert_eq!(code(read_image(&v.0, "atalho.png")), "OUTSIDE_VAULT");
        assert_eq!(code(read_image(&v.0, "pasta/fora.png")), "OUTSIDE_VAULT");
    }

    /// SN-SEC-06: hard link para um PNG de fora do vault → `OUTSIDE_VAULT`, sem devolver bytes.
    #[cfg(unix)]
    #[test]
    fn hard_link_refused() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("segredo.png", PNG);
        fs::hard_link(outside.0.join("segredo.png"), v.0.join("duro.png")).unwrap();
        assert_eq!(code(read_image(&v.0, "duro.png")), "OUTSIDE_VAULT");
        v.put("comum.png", PNG);
        assert_eq!(read_image(&v.0, "comum.png").unwrap(), PNG);
    }

    #[cfg(windows)]
    #[test]
    fn junction_refused() {
        let v = TempDir::new();
        let outside = TempDir::new();
        outside.put("fora.png", PNG);
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(v.0.join("juncao"))
            .arg(&outside.0)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(code(read_image(&v.0, "juncao/fora.png")), "OUTSIDE_VAULT");
    }

    #[test]
    fn hidden_git_env_and_simplemd_refused() {
        let v = TempDir::new();
        for rel in [".git/x.png", ".env", "a/.oculta.png", ".simplemd/x.png"] {
            v.put(rel, PNG);
        }
        assert_eq!(code(read_image(&v.0, ".git/x.png")), "PERMISSION_DENIED");
        assert_eq!(code(read_image(&v.0, ".env")), "PERMISSION_DENIED");
        assert_eq!(code(read_image(&v.0, "a/.oculta.png")), "PERMISSION_DENIED");
        assert_eq!(
            code(read_image(&v.0, ".simplemd/x.png")),
            "PERMISSION_DENIED"
        );
        assert_eq!(
            code(read_image(&v.0, ".simplemd/themes/t/x.png")),
            "PERMISSION_DENIED"
        );
    }

    #[test]
    fn outside_vault_refused() {
        let v = TempDir::new();
        for rel in ["../x.png", "a/../../x.png", "/etc/x.png", "C:/x.png"] {
            assert_eq!(code(read_image(&v.0, rel)), "OUTSIDE_VAULT", "{rel}");
        }
        assert_eq!(code(read_image(&v.0, "a\\x.png")), "INVALID_PATH");
    }

    #[test]
    fn not_found_unsupported_extension_and_directory() {
        let v = TempDir::new();
        assert_eq!(code(read_image(&v.0, "nada.png")), "NOT_FOUND");
        v.put("nota.md", b"# n");
        v.put("img.bmp", b"BM");
        assert_eq!(code(read_image(&v.0, "nota.md")), "UNSUPPORTED_IMAGE");
        assert_eq!(code(read_image(&v.0, "img.bmp")), "UNSUPPORTED_IMAGE");
        fs::create_dir_all(v.0.join("pasta.png")).unwrap();
        assert_eq!(code(read_image(&v.0, "pasta.png")), "INVALID_PATH");
    }
}
