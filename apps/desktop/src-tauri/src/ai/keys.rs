//! Chaves de IA só no keychain do sistema (regra 7; R-11.4, D-21; arch-backend r2 §1.7.3): crate
//! `keyring` (Keychain no macOS, Credential Manager no Windows), serviço
//! `io.github.devrafaelbrauner.simplemd`, contas `ai.openai` e `ai.anthropic`.
//!
//! A superfície IPC é EXATAMENTE `set_key`, `has_key` e `delete_key`: nenhum comando devolve o
//! valor (AC-11.5). O transporte lê a chave aqui, por pedido, num `Zeroizing<String>`, e põe o
//! cabeçalho de autenticação ele mesmo.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::error::AppError;

pub const SERVICE: &str = "io.github.devrafaelbrauner.simplemd";
const MAX_KEY_CHARS: usize = 512;

/// Valor de chave vindo do webview: nunca aparece em `Debug` (nem em pânico ou log).
#[derive(Deserialize)]
#[serde(transparent)]
pub struct Secret(Zeroizing<String>);

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([chave redigida])")
    }
}

/// Armazém de segredos (o keychain no app; memória nos testes).
pub trait SecretStore: Send + Sync {
    fn set(&self, account: &str, value: &str) -> Result<(), AppError>;
    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, AppError>;
    fn delete(&self, account: &str) -> Result<(), AppError>;
}

/// Keychain do sistema pela crate `keyring`.
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(&self.service, account).map_err(|e| keychain_error(&e))
    }
}

/// Erro do keychain → código fixo (STR-125). A mensagem do sistema nunca vai para o webview.
fn keychain_error(error: &keyring::Error) -> AppError {
    AppError::new(match error {
        keyring::Error::NoStorageAccess(_) => "KEYCHAIN_DENIED",
        keyring::Error::TooLong(..)
        | keyring::Error::Invalid(..)
        | keyring::Error::BadEncoding(_) => "INVALID_KEY_FORMAT",
        _ => "KEYCHAIN_UNAVAILABLE",
    })
}

impl SecretStore for KeyringStore {
    fn set(&self, account: &str, value: &str) -> Result<(), AppError> {
        self.entry(account)?
            .set_password(value)
            .map_err(|e| keychain_error(&e))
    }

    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, AppError> {
        match self.entry(account)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
}

/// Armazém em memória (testes do transporte e dos comandos).
#[derive(Default)]
pub struct MemoryStore {
    values: Mutex<HashMap<String, Zeroizing<String>>>,
}

impl SecretStore for MemoryStore {
    fn set(&self, account: &str, value: &str) -> Result<(), AppError> {
        self.values
            .lock()
            .insert(account.to_owned(), Zeroizing::new(value.to_owned()));
        Ok(())
    }

    fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, AppError> {
        Ok(self.values.lock().get(account).cloned())
    }

    fn delete(&self, account: &str) -> Result<(), AppError> {
        self.values.lock().remove(account);
        Ok(())
    }
}

/// Estado do app: o armazém de chaves compartilhado com o transporte.
pub struct Keys(pub Arc<dyn SecretStore>);

/// Só os provedores com chave (`openai`, `anthropic`); o resto é `INVALID_PROVIDER`.
pub fn account_for(provider: &str) -> Result<&'static str, AppError> {
    match provider {
        "openai" => Ok("ai.openai"),
        "anthropic" => Ok("ai.anthropic"),
        _ => Err(AppError::new("INVALID_PROVIDER")),
    }
}

/// 1–512 caracteres depois de aparar as pontas, sem caracteres de controle.
fn normalized(value: &str) -> Result<&str, AppError> {
    let trimmed = value.trim();
    let count = trimmed.chars().count();
    if count == 0 || count > MAX_KEY_CHARS || trimmed.chars().any(char::is_control) {
        return Err(AppError::new("INVALID_KEY_FORMAT"));
    }
    Ok(trimmed)
}

pub fn store_key(store: &dyn SecretStore, provider: &str, value: &Secret) -> Result<(), AppError> {
    let account = account_for(provider)?;
    store.set(account, normalized(&value.0)?)
}

pub fn key_present(store: &dyn SecretStore, provider: &str) -> Result<bool, AppError> {
    let account = account_for(provider)?;
    // Lido num `Zeroizing` e descartado na hora: só o booleano sai daqui.
    Ok(store.get(account)?.is_some())
}

pub fn remove_key(store: &dyn SecretStore, provider: &str) -> Result<(), AppError> {
    store.delete(account_for(provider)?)
}

/// O keychain pode bloquear (pedido de acesso do sistema): roda fora da thread principal.
async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| AppError::new("KEYCHAIN_UNAVAILABLE"))?
}

#[tauri::command]
pub async fn set_key(
    keys: State<'_, Keys>,
    provider: String,
    value: Secret,
) -> Result<(), AppError> {
    let store = keys.0.clone();
    blocking(move || store_key(store.as_ref(), &provider, &value)).await
}

#[tauri::command]
pub async fn has_key(keys: State<'_, Keys>, provider: String) -> Result<bool, AppError> {
    let store = keys.0.clone();
    blocking(move || key_present(store.as_ref(), &provider)).await
}

#[tauri::command]
pub async fn delete_key(keys: State<'_, Keys>, provider: String) -> Result<(), AppError> {
    let store = keys.0.clone();
    blocking(move || remove_key(store.as_ref(), &provider)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secret(value: &str) -> Secret {
        serde_json::from_value(serde_json::json!(value)).unwrap()
    }

    #[test]
    fn set_has_delete_roundtrip_in_memory() {
        let store = MemoryStore::default();
        assert!(!key_present(&store, "openai").unwrap());
        store_key(&store, "openai", &secret("  sk-test-CANARY-memory  ")).unwrap();
        assert!(key_present(&store, "openai").unwrap());
        assert!(!key_present(&store, "anthropic").unwrap());
        // Guardada aparada.
        assert_eq!(
            store
                .get("ai.openai")
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("sk-test-CANARY-memory")
        );
        remove_key(&store, "openai").unwrap();
        assert!(!key_present(&store, "openai").unwrap());
        // Remover o que não existe não é erro.
        remove_key(&store, "anthropic").unwrap();
    }

    #[test]
    fn only_cloud_providers_and_valid_values() {
        let store = MemoryStore::default();
        for provider in ["ollama", "", "OpenAI", "ai.openai"] {
            assert_eq!(
                store_key(&store, provider, &secret("x")).unwrap_err().code,
                "INVALID_PROVIDER"
            );
            assert_eq!(
                key_present(&store, provider).unwrap_err().code,
                "INVALID_PROVIDER"
            );
        }
        for bad in ["", "   ", "a\nb", "a\u{7}b", &"k".repeat(513)] {
            assert_eq!(
                store_key(&store, "anthropic", &secret(bad))
                    .unwrap_err()
                    .code,
                "INVALID_KEY_FORMAT"
            );
        }
        store_key(&store, "anthropic", &secret(&"k".repeat(512))).unwrap();
    }

    #[test]
    fn secret_debug_never_shows_the_value() {
        let value = secret("sk-test-CANARY-debug");
        let shown = format!("{value:?}");
        assert!(!shown.contains("CANARY"), "{shown}");
        assert_eq!(shown, "Secret([chave redigida])");
    }

    /// AC-11.5 (RUST): o keychain REAL, com um serviço de teste aleatório e limpeza no fim. Roda só
    /// com `SIMPLEMD_KEYRING_TEST=1` (macOS local, Windows no CI); o keychain do macOS no CI pode
    /// estar trancado (R-E4).
    #[test]
    fn roundtrip_real_keychain() {
        if std::env::var("SIMPLEMD_KEYRING_TEST").as_deref() != Ok("1") {
            eprintln!("roundtrip_real_keychain: pulado (SIMPLEMD_KEYRING_TEST != 1)");
            return;
        }
        let mut random = [0u8; 8];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let store = KeyringStore::new(format!("{SERVICE}.test-{suffix}"));
        let canary = format!("sk-test-CANARY-{suffix}");
        let result = (|| -> Result<(), AppError> {
            assert!(!key_present(&store, "openai")?);
            store_key(&store, "openai", &secret(&canary))?;
            assert!(key_present(&store, "openai")?);
            remove_key(&store, "openai")?;
            assert!(!key_present(&store, "openai")?);
            Ok(())
        })();
        // Limpeza mesmo se algo falhou no meio.
        let _ = remove_key(&store, "openai");
        result.unwrap();
        eprintln!("roundtrip_real_keychain: OK (serviço {SERVICE}.test-{suffix}, removido)");
    }
}
