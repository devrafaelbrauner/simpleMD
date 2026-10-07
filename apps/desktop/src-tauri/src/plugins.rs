//! Aprovações de plugins POR DISPOSITIVO, fora do vault (D-9, D-10; arch-backend r2 §1.3.2). O
//! arquivo `plugin-approvals.json` fica nos dados do app e nunca viaja com uma pasta sincronizada:
//! quem só tem acesso de escrita à pasta não consegue plantar o código E a aprovação. Cada comando
//! usa a raiz ATIVA guardada no Rust (pelo token): o webview nunca informa uma raiz, então não lê
//! nem grava aprovações de outra pasta. `plugin_enabled_set` nunca liga um hash não aprovado.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::vault::VaultState;

const FILE_NAME: &str = "plugin-approvals.json";
const MAX_BYTES: u64 = 1024 * 1024;
const VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub sha256: String,
    pub enabled: bool,
    pub approved_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    version: u32,
    vaults: BTreeMap<String, BTreeMap<String, Approval>>,
}

/// O que o webview recebe: hash e liga/desliga (sem datas).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovalView {
    pub sha256: String,
    pub enabled: bool,
}

/// Armazém em `app_data_dir()/plugin-approvals.json`, com escrita serializada por mutex.
pub struct Approvals {
    path: PathBuf,
    lock: Mutex<()>,
}

/// Id de manifesto: `^[a-z0-9]+(\.[a-z0-9-]+)+$`, até 128 caracteres (mesma regra do validador TS).
pub fn valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    let mut parts = id.split('.');
    let first = parts.next().unwrap_or("");
    let lower_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    if first.is_empty() || !first.chars().all(lower_digit) {
        return false;
    }
    let mut rest = 0;
    for part in parts {
        rest += 1;
        if part.is_empty() || !part.chars().all(|c| lower_digit(c) || c == '-') {
            return false;
        }
    }
    rest > 0
}

pub fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Data UTC em ISO 8601 (`2026-10-07T12:00:00Z`) sem dependência de calendário.
fn iso_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Algoritmo civil_from_days (H. Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

impl Approvals {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(FILE_NAME),
            lock: Mutex::new(()),
        }
    }

    /// Falha fechada: ausente, corrompido, grande demais ou de versão desconhecida → vazio (todo
    /// plugin `Desativado`); o próximo `set` regrava o arquivo.
    fn load(&self) -> StoreFile {
        let empty = || StoreFile {
            version: VERSION,
            vaults: BTreeMap::new(),
        };
        let Ok(file) = fs::File::open(&self.path) else {
            return empty();
        };
        let mut bytes = Vec::new();
        if file.take(MAX_BYTES + 1).read_to_end(&mut bytes).is_err()
            || bytes.len() as u64 > MAX_BYTES
        {
            return empty();
        }
        match serde_json::from_slice::<StoreFile>(&bytes) {
            Ok(store) if store.version == VERSION => store,
            _ => empty(),
        }
    }

    /// Grava de forma atômica (temporário + rename) dentro dos dados do app.
    fn save(&self, store: &StoreFile) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(store).map_err(|_| AppError::new("STORE_IO"))?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(AppError::new("STORE_IO"));
        }
        let dir = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("STORE_IO"))?;
        fs::create_dir_all(dir).map_err(|_| AppError::new("STORE_IO"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &bytes).map_err(|_| AppError::new("STORE_IO"))?;
        fs::rename(&tmp, &self.path).map_err(|_| AppError::new("STORE_IO"))
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn get(&self, root: &str) -> BTreeMap<String, ApprovalView> {
        let _guard = self.guard();
        self.load()
            .vaults
            .remove(root)
            .unwrap_or_default()
            .into_iter()
            .map(|(id, a)| {
                (
                    id,
                    ApprovalView {
                        sha256: a.sha256,
                        enabled: a.enabled,
                    },
                )
            })
            .collect()
    }

    pub fn set(&self, root: &str, id: &str, sha256: &str) -> Result<(), AppError> {
        if !valid_id(id) {
            return Err(AppError::new("INVALID_ID"));
        }
        if !valid_hash(sha256) {
            return Err(AppError::new("INVALID_HASH"));
        }
        let _guard = self.guard();
        let mut store = self.load();
        store.vaults.entry(root.to_owned()).or_default().insert(
            id.to_owned(),
            Approval {
                sha256: sha256.to_owned(),
                enabled: true,
                approved_at: iso_now(),
            },
        );
        self.save(&store)
    }

    pub fn set_enabled(&self, root: &str, id: &str, enabled: bool) -> Result<(), AppError> {
        if !valid_id(id) {
            return Err(AppError::new("INVALID_ID"));
        }
        let _guard = self.guard();
        let mut store = self.load();
        let approval = store
            .vaults
            .get_mut(root)
            .and_then(|vault| vault.get_mut(id))
            .ok_or_else(|| AppError::new("NOT_APPROVED"))?;
        approval.enabled = enabled;
        self.save(&store)
    }

    pub fn clear(&self, root: &str, id: &str) -> Result<(), AppError> {
        if !valid_id(id) {
            return Err(AppError::new("INVALID_ID"));
        }
        let _guard = self.guard();
        let mut store = self.load();
        let removed = store
            .vaults
            .get_mut(root)
            .and_then(|vault| vault.remove(id));
        if removed.is_none() {
            return Ok(());
        }
        if store.vaults.get(root).is_some_and(BTreeMap::is_empty) {
            store.vaults.remove(root);
        }
        self.save(&store)
    }
}

/// Raiz ativa (chave do armazém); token de outra abertura → `VAULT_CLOSED`, sem pasta → `NO_VAULT`.
fn root_key(vault: &VaultState, token: u32) -> Result<String, AppError> {
    Ok(vault.root(token)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn plugin_approvals_get(
    vault: State<'_, VaultState>,
    approvals: State<'_, Approvals>,
    token: u32,
) -> Result<BTreeMap<String, ApprovalView>, AppError> {
    Ok(approvals.get(&root_key(&vault, token)?))
}

#[tauri::command]
pub async fn plugin_approval_set(
    vault: State<'_, VaultState>,
    approvals: State<'_, Approvals>,
    token: u32,
    id: String,
    sha256: String,
) -> Result<(), AppError> {
    approvals.set(&root_key(&vault, token)?, &id, &sha256)
}

#[tauri::command]
pub async fn plugin_enabled_set(
    vault: State<'_, VaultState>,
    approvals: State<'_, Approvals>,
    token: u32,
    id: String,
    enabled: bool,
) -> Result<(), AppError> {
    approvals.set_enabled(&root_key(&vault, token)?, &id, enabled)
}

#[tauri::command]
pub async fn plugin_approval_clear(
    vault: State<'_, VaultState>,
    approvals: State<'_, Approvals>,
    token: u32,
    id: String,
) -> Result<(), AppError> {
    approvals.clear(&root_key(&vault, token)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::ops::tests::TempDir;

    const H1: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const H2: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    #[test]
    fn id_and_hash_validation() {
        for ok in ["com.exemplo.hello", "a.b", "a1.b-2.c3"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "com", "Com.x", "a..b", ".a.b", "a.b.", "a.b_c", "a/b.c"] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_hash(H1));
        assert!(!valid_hash(&H1.to_uppercase()));
        assert!(!valid_hash(&H1[..63]));
    }

    #[test]
    fn keyed_by_root_and_never_crosses_vaults() {
        let dir = TempDir::new();
        let store = Approvals::new(&dir.0);
        store.set("/vaults/A", "com.x.p", H1).unwrap();
        assert_eq!(store.get("/vaults/A")["com.x.p"].sha256, H1);
        assert!(
            store.get("/vaults/B").is_empty(),
            "outra pasta não vê a aprovação"
        );
        let json = fs::read_to_string(dir.0.join(FILE_NAME)).unwrap();
        assert!(json.contains("\"approvedAt\""));
        assert!(json.contains("\"version\": 1"));
    }

    #[test]
    fn invalid_inputs_rejected_with_zero_writes() {
        let dir = TempDir::new();
        let store = Approvals::new(&dir.0);
        assert_eq!(store.set("/r", "Bad", H1).unwrap_err().code, "INVALID_ID");
        assert_eq!(
            store.set("/r", "a.b", "xyz").unwrap_err().code,
            "INVALID_HASH"
        );
        assert!(!dir.0.join(FILE_NAME).exists());
    }

    #[test]
    fn enabled_flag_keeps_the_hash_and_never_bypasses_consent() {
        let dir = TempDir::new();
        let store = Approvals::new(&dir.0);
        assert_eq!(
            store.set_enabled("/r", "a.b", true).unwrap_err().code,
            "NOT_APPROVED"
        );
        store.set("/r", "a.b", H1).unwrap();
        store.set_enabled("/r", "a.b", false).unwrap();
        let view = &store.get("/r")["a.b"];
        assert_eq!((view.sha256.as_str(), view.enabled), (H1, false));
        store.set_enabled("/r", "a.b", true).unwrap();
        assert!(store.get("/r")["a.b"].enabled);
        // Código novo: nova aprovação substitui o hash.
        store.set("/r", "a.b", H2).unwrap();
        assert_eq!(store.get("/r")["a.b"].sha256, H2);
        store.clear("/r", "a.b").unwrap();
        assert!(store.get("/r").is_empty());
    }

    #[test]
    fn fails_closed_on_corrupt_oversize_or_unknown_version() {
        let dir = TempDir::new();
        let store = Approvals::new(&dir.0);
        let path = dir.0.join(FILE_NAME);
        for content in [
            b"{ not json".to_vec(),
            br#"{"version":99,"vaults":{"/r":{"a.b":{"sha256":"x","enabled":true,"approvedAt":""}}}}"#
                .to_vec(),
            vec![b' '; (MAX_BYTES + 1) as usize],
        ] {
            fs::write(&path, &content).unwrap();
            assert!(store.get("/r").is_empty());
        }
        // O próximo `set` regrava um arquivo válido.
        store.set("/r", "a.b", H1).unwrap();
        assert_eq!(store.get("/r").len(), 1);
        assert!(!dir.0.join("plugin-approvals.json.tmp").exists());
    }

    #[test]
    fn iso_timestamp_shape() {
        let now = iso_now();
        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z') && now.as_bytes()[10] == b'T', "{now}");
    }
}
