//! Diálogos de salvar/abrir sem permissões de diálogo nem de fs no JS (arch-backend r2 §1.2,
//! C-5; AS-01, AS-08, C-10). O webview nunca recebe nem envia um caminho absoluto:
//! - `save_target_pick` abre o diálogo nativo e guarda o destino sob um token aleatório de 128 bits
//!   (uso único, 10 min); `save_target_write` grava os bytes nesse destino;
//! - `open_file_pick` abre o diálogo nativo e devolve nome + bytes, com o teto checado no arquivo
//!   já aberto (nada além do teto é lido).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Request;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder};

use crate::error::AppError;
use crate::vault::{header, ops, policy, raw_body, VaultState};

const TOKEN_TTL: Duration = Duration::from_secs(10 * 60);
/// Teto absoluto de `open_file_pick` (a resposta vai por JSON).
const OPEN_MAX_BYTES: u64 = 1024 * 1024;

struct SaveTarget {
    path: PathBuf,
    expires: Instant,
}

/// Destinos escolhidos no diálogo de salvar e ainda não gravados.
#[derive(Default)]
pub struct SaveTargets(Mutex<HashMap<String, SaveTarget>>);

impl SaveTargets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SaveTarget>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn insert(&self, path: PathBuf, now: Instant) -> Result<String, AppError> {
        let mut raw = [0u8; 16];
        getrandom::fill(&mut raw).map_err(|_| AppError::new("IO"))?;
        let token: String = raw.iter().map(|b| format!("{b:02x}")).collect();
        let mut map = self.lock();
        map.retain(|_, target| target.expires > now);
        map.insert(
            token.clone(),
            SaveTarget {
                path,
                expires: now + TOKEN_TTL,
            },
        );
        Ok(token)
    }

    /// Consome o token (uso único). Desconhecido ou vencido → `TOKEN_INVALID`.
    fn take(&self, token: &str, now: Instant) -> Result<PathBuf, AppError> {
        match self.lock().remove(token) {
            Some(target) if target.expires > now => Ok(target.path),
            _ => Err(AppError::new("TOKEN_INVALID")),
        }
    }

    /// Trocar de pasta invalida todos os destinos pendentes.
    pub fn clear(&self) {
        self.lock().clear();
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SaveExt {
    Json,
    Md,
    Html,
}

impl SaveExt {
    fn filter(self) -> (&'static str, &'static str, &'static str) {
        match self {
            SaveExt::Json => ("Exportar tema", "Tema do simpleMD", "json"),
            SaveExt::Md => ("Exportar", "Markdown", "md"),
            SaveExt::Html => ("Exportar", "HTML", "html"),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePick {
    token: String,
    file_name: String,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_owned()
}

/// Forma comparável de um destino: canônico se existe; senão pasta-mãe canônica + nome.
fn comparable(path: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = fs::canonicalize(path) {
        return Some(canonical);
    }
    let parent = fs::canonicalize(path.parent()?).ok()?;
    Some(parent.join(path.file_name()?))
}

/// `true` se `chosen` é o mesmo arquivo que `<root>/<source_rel>` (R-10.3: nunca exportar por cima
/// da própria origem).
fn same_as_source(root: &Path, source_rel: &str, chosen: &Path) -> Result<bool, AppError> {
    let segments = policy::validate_rel(source_rel, false)?;
    let mut source = root.to_path_buf();
    for segment in &segments {
        source.push(segment);
    }
    Ok(match (comparable(&source), comparable(chosen)) {
        (Some(a), Some(b)) => a == b,
        _ => false,
    })
}

fn dialog(app: &AppHandle, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let builder = app.dialog().file().set_title(title);
    match app.get_webview_window(crate::MAIN) {
        Some(window) => builder.set_parent(&window),
        None => builder,
    }
}

#[tauri::command]
pub async fn save_target_pick(
    app: AppHandle,
    vault: State<'_, VaultState>,
    targets: State<'_, SaveTargets>,
    suggested_name: String,
    ext: SaveExt,
    source_rel: Option<String>,
) -> Result<Option<SavePick>, AppError> {
    let (title, filter_name, extension) = ext.filter();
    let Some(picked) = dialog(&app, title)
        .set_file_name(suggested_name)
        .add_filter(filter_name, &[extension])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| AppError::new("INVALID_PATH"))?;
    if let (Some(source_rel), Some(root)) = (&source_rel, vault.active_root()) {
        if same_as_source(&root, source_rel, &path)? {
            return Err(AppError::new("SAME_AS_SOURCE"));
        }
    }
    let file_name = file_name(&path);
    let token = targets.insert(path, Instant::now())?;
    Ok(Some(SavePick { token, file_name }))
}

/// Corpo cru = bytes; cabeçalho `x-simplemd-save-token`. Cria ou substitui o arquivo escolhido
/// (o diálogo do sistema já confirmou a substituição).
#[tauri::command]
pub async fn save_target_write(
    targets: State<'_, SaveTargets>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let token = header(&request, "x-simplemd-save-token")?;
    let path = targets.take(&token, Instant::now())?;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(raw_body(&request)?)?;
    Ok(())
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OpenExt {
    Json,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPick {
    file_name: String,
    bytes: Vec<u8>,
}

/// Lê o arquivo escolhido com teto; acima dele → `TOO_LARGE` com `{ fileName, size }` e nada lido.
fn read_picked(path: &Path, max_bytes: u64) -> Result<OpenPick, AppError> {
    let name = file_name(path);
    let cap = max_bytes.min(OPEN_MAX_BYTES);
    match ops::read_capped(File::open(path)?, Some(cap)) {
        Ok(bytes) => Ok(OpenPick {
            file_name: name,
            bytes,
        }),
        Err(mut error) if error.code == "TOO_LARGE" => {
            let size = error.detail.as_ref().and_then(|d| d["size"].as_u64());
            error.detail = Some(serde_json::json!({ "fileName": name, "size": size }));
            Err(error)
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn open_file_pick(
    app: AppHandle,
    ext: OpenExt,
    max_bytes: u64,
) -> Result<Option<OpenPick>, AppError> {
    let OpenExt::Json = ext;
    let Some(picked) = dialog(&app, "Importar tema")
        .add_filter("Tema do simpleMD", &["json"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| AppError::new("INVALID_PATH"))?;
    read_picked(&path, max_bytes).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;

    #[test]
    fn save_tokens_are_single_use_expire_and_clear() {
        let targets = SaveTargets::default();
        let now = Instant::now();
        let token = targets.insert(PathBuf::from("/x/a.json"), now).unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            targets.take(&token, now).unwrap(),
            PathBuf::from("/x/a.json")
        );
        assert_eq!(targets.take(&token, now).unwrap_err().code, "TOKEN_INVALID");
        let late = targets.insert(PathBuf::from("/x/b.json"), now).unwrap();
        let after = now + TOKEN_TTL + Duration::from_secs(1);
        assert_eq!(
            targets.take(&late, after).unwrap_err().code,
            "TOKEN_INVALID"
        );
        let cleared = targets.insert(PathBuf::from("/x/c.json"), now).unwrap();
        targets.clear();
        assert_eq!(
            targets.take(&cleared, now).unwrap_err().code,
            "TOKEN_INVALID"
        );
        assert_eq!(
            targets.take("nao-existe", now).unwrap_err().code,
            "TOKEN_INVALID"
        );
        let a = targets.insert(PathBuf::from("/x/d.json"), now).unwrap();
        let b = targets.insert(PathBuf::from("/x/d.json"), now).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn same_as_source_detection() {
        let v = TempDir::new();
        v.put("notas/a.md", b"a");
        let root = &v.0;
        assert!(same_as_source(root, "notas/a.md", &root.join("notas/a.md")).unwrap());
        assert!(same_as_source(root, "notas/a.md", &root.join("notas/../notas/a.md")).unwrap());
        assert!(!same_as_source(root, "notas/a.md", &root.join("notas/a.html")).unwrap());
        assert!(!same_as_source(root, "notas/b.md", &root.join("notas/a.md")).unwrap());
        assert_eq!(
            same_as_source(root, "../fora.md", &root.join("x"))
                .unwrap_err()
                .code,
            "OUTSIDE_VAULT"
        );
    }

    #[test]
    fn open_pick_reads_with_cap_on_open_handle() {
        let v = TempDir::new();
        v.put("tema.theme.json", b"{}");
        let ok = read_picked(&v.0.join("tema.theme.json"), 256 * 1024).unwrap();
        assert_eq!(
            (ok.file_name.as_str(), ok.bytes.as_slice()),
            ("tema.theme.json", &b"{}"[..])
        );
        v.put("grande.theme.json", &vec![b' '; 300_000]);
        let error = read_picked(&v.0.join("grande.theme.json"), 256 * 1024).unwrap_err();
        assert_eq!(error.code, "TOO_LARGE");
        assert_eq!(
            error.detail,
            Some(serde_json::json!({ "fileName": "grande.theme.json", "size": 300_000 }))
        );
        // O teto absoluto vale mesmo se o webview pedir mais.
        v.put("enorme.json", &vec![b' '; (OPEN_MAX_BYTES + 1) as usize]);
        assert_eq!(
            read_picked(&v.0.join("enorme.json"), u64::MAX)
                .unwrap_err()
                .code,
            "TOO_LARGE"
        );
        assert_eq!(
            read_picked(&v.0.join("nada.json"), 10).unwrap_err().code,
            "NOT_FOUND"
        );
    }
}
