//! Chaves de IA só no keychain do sistema (regra 7; R-11.4, D-21; arch-backend r2 §1.7.3): crate
//! `keyring` (Keychain no macOS, Credential Manager no Windows), serviço
//! `io.github.devrafaelbrauner.simplemd`, contas `ai.openai` e `ai.anthropic`.
//!
//! A superfície IPC é EXATAMENTE `set_key`, `has_key` e `delete_key`: nenhum comando devolve o
//! valor (AC-11.5). O transporte lê a chave aqui, por pedido, num `Zeroizing<String>`, e põe o
//! cabeçalho de autenticação ele mesmo.
//!
//! `has_key` só consulta atributos, nunca o segredo: no macOS por uma busca do Security framework
//! que pede só atributos (`load_attributes`, nunca `load_data`), porque o backend macOS do
//! `keyring` lê a senha até em `get_attributes` e ler o segredo dispara o pedido de acesso do
//! keychain num binário sem assinatura (EC2-K-1). No Windows o `get_attributes` do `keyring` copia
//! só nome/alvo/comentário e apaga o segredo sem trazê-lo para o Rust.
//!
//! `set_key` e `delete_key` só mexem no keychain depois de um diálogo nativo que nomeia o provedor
//! (APPSEC-R2-02): sem o clique, `CANCELLED`.

use std::collections::HashMap;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
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
    /// Existe uma chave salva? Sem ler o segredo.
    fn exists(&self, account: &str) -> Result<bool, AppError>;
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

    #[cfg(not(target_os = "macos"))]
    fn exists(&self, account: &str) -> Result<bool, AppError> {
        match self.entry(account)?.get_attributes() {
            Ok(_) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    /// Mesmo keychain do `keyring` (domínio do usuário) e mesmos códigos do seu `decode_error`.
    #[cfg(target_os = "macos")]
    fn exists(&self, account: &str) -> Result<bool, AppError> {
        use security_framework::item::{ItemClass, ItemSearchOptions, Limit};
        use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
        let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .map_err(|_| AppError::new("KEYCHAIN_UNAVAILABLE"))?;
        // Só atributos: sem algum `load_*` a busca devolve vazio mesmo com o item presente.
        match ItemSearchOptions::new()
            .class(ItemClass::generic_password())
            .keychains(&[keychain])
            .service(&self.service)
            .account(account)
            .load_attributes(true)
            .limit(Limit::Max(1))
            .search()
        {
            Ok(found) => Ok(!found.is_empty()),
            Err(e) if e.code() == -25300 => Ok(false), // errSecItemNotFound
            Err(e) => Err(AppError::new(match e.code() {
                -25291 | -25292 | -25294 | -25295 => "KEYCHAIN_DENIED",
                _ => "KEYCHAIN_UNAVAILABLE",
            })),
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

    fn exists(&self, account: &str) -> Result<bool, AppError> {
        Ok(self.values.lock().contains_key(account))
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
    store.exists(account_for(provider)?)
}

pub fn remove_key(store: &dyn SecretStore, provider: &str) -> Result<(), AppError> {
    store.delete(account_for(provider)?)
}

#[derive(Clone, Copy)]
pub enum KeyAction {
    Save,
    Remove,
}

/// Pergunta nativa antes de mexer no keychain (APPSEC-R2-02). Injetável nos testes.
pub trait Confirm: Send + Sync {
    fn confirm(&self, action: KeyAction, provider: &str) -> bool;
}

/// Um diálogo por vez: um pedido que chega com outro aberto é recusado (`CANCELLED`), sem empilhar.
pub struct OneAtATime<C>(C, AtomicBool);

impl<C> OneAtATime<C> {
    pub fn new(inner: C) -> Self {
        Self(inner, AtomicBool::new(false))
    }
}

impl<C: Confirm> Confirm for OneAtATime<C> {
    fn confirm(&self, action: KeyAction, provider: &str) -> bool {
        if self.1.swap(true, Ordering::SeqCst) {
            return false;
        }
        let answer = self.0.confirm(action, provider);
        self.1.store(false, Ordering::SeqCst);
        answer
    }
}

/// O diálogo do sistema, sobre a janela principal. Só chamado fora da thread principal
/// (`blocking_show`); Esc ou fechar o diálogo = Cancelar.
pub struct NativeConfirm(pub AppHandle);

impl Confirm for NativeConfirm {
    fn confirm(&self, action: KeyAction, provider: &str) -> bool {
        let p = if provider == "openai" {
            "OpenAI"
        } else {
            "Anthropic"
        };
        let (title, message, ok, kind) = match action {
            KeyAction::Save => (
                format!("Salvar a chave da {p}?"),
                format!(
                    "O simpleMD vai gravar esta chave no keychain do sistema. Se já houver uma \
                     chave da {p} salva, ela será substituída. Confirme só se foi você quem pediu \
                     isso agora."
                ),
                "Salvar chave",
                MessageDialogKind::Info,
            ),
            KeyAction::Remove => (
                format!("Remover a chave da {p}?"),
                format!(
                    "A chave da {p} será apagada do keychain do sistema. Para usar a {p} de novo, \
                     será preciso colar a chave outra vez. Confirme só se foi você quem pediu isso \
                     agora."
                ),
                "Remover chave",
                MessageDialogKind::Warning,
            ),
        };
        let dialog = self
            .0
            .dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .buttons(MessageDialogButtons::OkCancelCustom(
                ok.into(),
                "Cancelar".into(),
            ));
        match self.0.get_webview_window(crate::MAIN) {
            Some(window) => dialog.parent(&window),
            None => dialog,
        }
        .blocking_show()
    }
}

/// Estado do app: o diálogo de confirmação das chaves, um por vez.
pub struct KeyConfirm(pub Arc<dyn Confirm>);

/// Valida, pergunta e só então grava. Entrada inválida não abre diálogo.
pub fn confirmed_store_key(
    store: &dyn SecretStore,
    confirm: &dyn Confirm,
    provider: &str,
    value: &Secret,
) -> Result<(), AppError> {
    let account = account_for(provider)?;
    let value = normalized(&value.0)?;
    if !confirm.confirm(KeyAction::Save, provider) {
        return Err(AppError::new("CANCELLED"));
    }
    store.set(account, value)
}

/// Valida, pergunta e só então apaga.
pub fn confirmed_remove_key(
    store: &dyn SecretStore,
    confirm: &dyn Confirm,
    provider: &str,
) -> Result<(), AppError> {
    let account = account_for(provider)?;
    if !confirm.confirm(KeyAction::Remove, provider) {
        return Err(AppError::new("CANCELLED"));
    }
    store.delete(account)
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
    confirm: State<'_, KeyConfirm>,
    provider: String,
    value: Secret,
) -> Result<(), AppError> {
    let store = keys.0.clone();
    let confirm = confirm.0.clone();
    blocking(move || confirmed_store_key(store.as_ref(), confirm.as_ref(), &provider, &value)).await
}

#[tauri::command]
pub async fn has_key(keys: State<'_, Keys>, provider: String) -> Result<bool, AppError> {
    let store = keys.0.clone();
    blocking(move || key_present(store.as_ref(), &provider)).await
}

#[tauri::command]
pub async fn delete_key(
    keys: State<'_, Keys>,
    confirm: State<'_, KeyConfirm>,
    provider: String,
) -> Result<(), AppError> {
    let store = keys.0.clone();
    let confirm = confirm.0.clone();
    blocking(move || confirmed_remove_key(store.as_ref(), confirm.as_ref(), &provider)).await
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

    /// Armazém que falha (keychain indisponível): `has_key` devolve só o código fixo (STR-125).
    struct FailingStore;

    impl SecretStore for FailingStore {
        fn set(&self, _: &str, _: &str) -> Result<(), AppError> {
            Err(AppError::new("KEYCHAIN_UNAVAILABLE"))
        }
        fn get(&self, _: &str) -> Result<Option<Zeroizing<String>>, AppError> {
            Err(AppError::new("KEYCHAIN_UNAVAILABLE"))
        }
        fn exists(&self, _: &str) -> Result<bool, AppError> {
            Err(AppError::new("KEYCHAIN_UNAVAILABLE"))
        }
        fn delete(&self, _: &str) -> Result<(), AppError> {
            Err(AppError::new("KEYCHAIN_UNAVAILABLE"))
        }
    }

    #[test]
    fn has_key_asks_only_for_existence() {
        let store = MemoryStore::default();
        store.set("ai.openai", "sk-test-CANARY-exists").unwrap();
        assert!(store.exists("ai.openai").unwrap());
        assert!(!store.exists("ai.anthropic").unwrap());
        assert!(key_present(&store, "openai").unwrap());
        assert!(!key_present(&store, "anthropic").unwrap());
        let error = key_present(&FailingStore, "openai").unwrap_err();
        assert_eq!(error, AppError::new("KEYCHAIN_UNAVAILABLE"));
    }

    /// Resposta fixa do diálogo, contando as perguntas.
    struct Fixed(bool, std::sync::atomic::AtomicUsize);

    impl Fixed {
        fn new(answer: bool) -> Self {
            Self(answer, std::sync::atomic::AtomicUsize::new(0))
        }
        fn asked(&self) -> usize {
            self.1.load(Ordering::SeqCst)
        }
    }

    impl Confirm for Fixed {
        fn confirm(&self, _: KeyAction, _: &str) -> bool {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0
        }
    }

    fn stored(store: &MemoryStore, account: &str) -> Option<String> {
        store
            .get(account)
            .unwrap()
            .map(|value| value.as_str().to_owned())
    }

    #[test]
    fn save_and_remove_only_after_confirm() {
        let store = MemoryStore::default();
        let yes = Fixed::new(true);
        let no = Fixed::new(false);
        confirmed_store_key(&store, &yes, "openai", &secret("sk-test-CANARY-a")).unwrap();
        assert_eq!(
            stored(&store, "ai.openai").as_deref(),
            Some("sk-test-CANARY-a")
        );
        // Cancelar a troca: CANCELLED e a chave anterior intacta.
        let error =
            confirmed_store_key(&store, &no, "openai", &secret("sk-test-CANARY-b")).unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert_eq!(
            stored(&store, "ai.openai").as_deref(),
            Some("sk-test-CANARY-a")
        );
        // Cancelar a remoção: continua salva.
        let error = confirmed_remove_key(&store, &no, "openai").unwrap_err();
        assert_eq!(error.code, "CANCELLED");
        assert!(key_present(&store, "openai").unwrap());
        confirmed_remove_key(&store, &yes, "openai").unwrap();
        assert!(!key_present(&store, "openai").unwrap());
        assert_eq!((yes.asked(), no.asked()), (2, 2));
    }

    #[test]
    fn invalid_input_never_opens_the_dialog() {
        let store = MemoryStore::default();
        let yes = Fixed::new(true);
        let error = confirmed_store_key(&store, &yes, "ollama", &secret("x")).unwrap_err();
        assert_eq!(error.code, "INVALID_PROVIDER");
        let error = confirmed_store_key(&store, &yes, "openai", &secret("a\nb")).unwrap_err();
        assert_eq!(error.code, "INVALID_KEY_FORMAT");
        let error = confirmed_remove_key(&store, &yes, "OpenAI").unwrap_err();
        assert_eq!(error.code, "INVALID_PROVIDER");
        assert_eq!(yes.asked(), 0);
    }

    /// Diálogo que fica aberto até o teste mandar fechar (só na primeira pergunta).
    struct Held {
        open: std::sync::Barrier,
        asked: std::sync::atomic::AtomicUsize,
    }

    impl Confirm for Held {
        fn confirm(&self, _: KeyAction, _: &str) -> bool {
            if self.asked.fetch_add(1, Ordering::SeqCst) == 0 {
                self.open.wait(); // aberto
                self.open.wait(); // fechado pelo teste
            }
            true
        }
    }

    #[test]
    fn one_dialog_at_a_time() {
        let guard = Arc::new(OneAtATime::new(Held {
            open: std::sync::Barrier::new(2),
            asked: std::sync::atomic::AtomicUsize::new(0),
        }));
        let first = {
            let guard = guard.clone();
            std::thread::spawn(move || guard.confirm(KeyAction::Save, "openai"))
        };
        guard.0.open.wait();
        // Outro pedido com o diálogo aberto: recusado na hora, sem um segundo diálogo.
        assert!(!guard.confirm(KeyAction::Remove, "anthropic"));
        assert_eq!(guard.0.asked.load(Ordering::SeqCst), 1);
        guard.0.open.wait();
        assert!(first.join().unwrap());
        // Fechado o primeiro, o próximo pedido pergunta de novo.
        assert!(guard.confirm(KeyAction::Remove, "anthropic"));
        assert_eq!(guard.0.asked.load(Ordering::SeqCst), 2);
    }

    /// AC-11.5 (RUST): o keychain REAL, com um serviço de teste aleatório e limpeza no fim. Fora da
    /// execução padrão (B-11): roda só com `SIMPLEMD_KEYRING_TEST=1` e `--include-ignored` (Windows
    /// no CI); nunca no Mac de desenvolvimento (MNC-9), e o keychain do macOS no CI pode estar
    /// trancado (R-E4).
    #[test]
    #[ignore = "keychain real: só com SIMPLEMD_KEYRING_TEST=1 e --include-ignored (Windows no CI); nunca no Mac de desenvolvimento"]
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
        eprintln!(
            "roundtrip_real_keychain: OK — set/has/delete executados (serviço {SERVICE}.test-{suffix}, removido)"
        );
    }
}
