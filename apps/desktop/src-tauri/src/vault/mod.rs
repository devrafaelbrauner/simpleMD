//! Gateway do vault (arch-backend r2 §1.2, D-B2; AS-01/02/03): o webview só fala com comandos do
//! app que recebem caminhos RELATIVOS ao vault. A raiz mora aqui, em `VaultState`. Cada abertura
//! gera um token novo; um token antigo vira `VAULT_CLOSED`. A pasta anterior fica inalcançável por
//! construção, sem `forbid` (reabri-la continua possível).
//!
//! A troca tem duas fases (r1 CR-02, CR2-02): `pick_vault` só deixa a pasta escolhida PENDENTE e a
//! ativa continua valendo, então o app ainda grava o que foi digitado com o diálogo aberto. A
//! pendente vira a ativa, de uma vez, no primeiro uso do token dela; o webview só o usa depois que
//! a regravação da pasta anterior deu certo.

pub mod image;
pub mod ops;
pub mod policy;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::save_targets::SaveTargets;
use ops::{DirItem, Stat, WriteMode};

type Watcher = Debouncer<notify::RecommendedWatcher, RecommendedCache>;

struct ActiveVault {
    root: PathBuf,
    token: u32,
    /// Observadores desta abertura; saem (e param) junto com ela.
    watchers: HashMap<u32, Watcher>,
}

/// Pasta escolhida no diálogo e ainda não usada: nenhum acesso, nenhum observador.
struct PendingVault {
    root: PathBuf,
    token: u32,
}

#[derive(Default)]
struct Slots {
    active: Option<ActiveVault>,
    pending: Option<PendingVault>,
}

impl Slots {
    /// Token da pendente → ela vira a ativa (a anterior sai e é devolvida para ser descartada fora
    /// da trava). Depois: sem pasta → `NO_VAULT`; token de outra abertura → `VAULT_CLOSED`.
    fn resolve(&mut self, token: u32) -> Result<(PathBuf, Option<ActiveVault>), AppError> {
        let mut previous = None;
        if self.pending.as_ref().is_some_and(|p| p.token == token) {
            if let Some(PendingVault { root, token }) = self.pending.take() {
                previous = self.active.replace(ActiveVault {
                    root,
                    token,
                    watchers: HashMap::new(),
                });
            }
        }
        match self.active.as_ref() {
            None => Err(AppError::new("NO_VAULT")),
            Some(active) if active.token != token => Err(AppError::new("VAULT_CLOSED")),
            Some(active) => Ok((active.root.clone(), previous)),
        }
    }
}

/// Estado nativo do vault: no máximo uma pasta ativa (uma janela, um vault) e uma pendente.
#[derive(Default)]
pub struct VaultState {
    slots: Mutex<Slots>,
    next_watch: AtomicU32,
}

impl VaultState {
    /// Primeira fase da troca: guarda `root` como pendente com um token novo. A ativa (e seus
    /// observadores) continua valendo até o primeiro uso desse token; um novo `stage` substitui a
    /// pendente anterior, que nunca chegou a ser usada. O token é aleatório (APPSEC-R2-05): nunca
    /// 0 nem igual ao da ativa ou da pendente, então a abertura seguinte não é adivinhável.
    pub fn stage(&self, root: PathBuf) -> Result<u32, AppError> {
        let mut slots = self.lock();
        let token = loop {
            let mut raw = [0u8; 4];
            getrandom::fill(&mut raw).map_err(|_| AppError::new("IO"))?;
            let t = u32::from_ne_bytes(raw);
            let taken = slots.active.as_ref().is_some_and(|a| a.token == t)
                || slots.pending.as_ref().is_some_and(|p| p.token == t);
            if t != 0 && !taken {
                break t;
            }
        };
        slots.pending = Some(PendingVault { root, token });
        Ok(token)
    }

    /// Raiz da abertura `token` (o token da pendente a ativa antes). Sem pasta → `NO_VAULT`; token
    /// de outra abertura → `VAULT_CLOSED`.
    pub fn root(&self, token: u32) -> Result<PathBuf, AppError> {
        let (root, previous) = self.lock().resolve(token)?;
        // A pasta anterior (com seus observadores) para fora da trava.
        drop(previous);
        Ok(root)
    }

    /// Raiz da pasta ativa, se houver (comparações nativas, nunca exposta como caminho de acesso).
    pub fn active_root(&self) -> Option<PathBuf> {
        self.lock()
            .active
            .as_ref()
            .map(|active| active.root.clone())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Slots> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn add_watcher(&self, token: u32, watcher: Watcher) -> Result<u32, AppError> {
        let mut guard = self.lock();
        match guard.active.as_mut() {
            None => Err(AppError::new("NO_VAULT")),
            Some(active) if active.token != token => Err(AppError::new("VAULT_CLOSED")),
            Some(active) => {
                let id = self.next_watch.fetch_add(1, Ordering::SeqCst) + 1;
                active.watchers.insert(id, watcher);
                Ok(id)
            }
        }
    }

    fn remove_watcher(&self, id: u32) {
        let removed = self
            .lock()
            .active
            .as_mut()
            .and_then(|a| a.watchers.remove(&id));
        drop(removed);
    }
}

#[derive(Serialize)]
pub struct PickedVault {
    root: String,
    token: u32,
}

/// Diálogo nativo de pasta. Não recebe argumentos: o webview não consegue escolher um caminho.
/// Cancelar → `null` e nada muda. Sucesso → a pasta escolhida fica PENDENTE (`VaultState::stage`):
/// a atual continua ativa até o primeiro uso do token novo; destinos de gravação descartados.
#[tauri::command]
pub async fn pick_vault(
    app: AppHandle,
    state: State<'_, VaultState>,
    targets: State<'_, SaveTargets>,
) -> Result<Option<PickedVault>, AppError> {
    // Comando assíncrono → fora da thread principal, então o diálogo bloqueante é permitido.
    let Some(picked) = app
        .dialog()
        .file()
        .set_title("Abrir pasta")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let root = picked
        .into_path()
        .map_err(|_| AppError::new("INVALID_PATH"))?;
    // CR-10: o observador (FSEvents/inotify) relata caminhos canônicos (`/private/tmp/...`); a
    // raiz precisa estar na mesma forma para os eventos casarem. No Windows `canonicalize` devolve
    // `\\?\C:\...`, que quebra as junções de caminho, então lá a raiz fica como veio.
    #[cfg(unix)]
    let root = std::fs::canonicalize(&root)?;
    if !root.is_dir() {
        return Err(AppError::new("INVALID_PATH"));
    }
    let root_str = root
        .to_str()
        .ok_or_else(|| AppError::new("INVALID_PATH"))?
        .to_owned();
    let token = state.stage(root)?;
    targets.clear();
    Ok(Some(PickedVault {
        root: root_str,
        token,
    }))
}

#[tauri::command]
pub async fn vault_read_dir(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Vec<DirItem>, AppError> {
    ops::read_dir(&state.root(token)?, &rel)
}

#[tauri::command]
pub async fn vault_lstat(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Option<Stat>, AppError> {
    ops::lstat(&state.root(token)?, &rel)
}

/// Bytes crus (ArrayBuffer no JS), sem passar por JSON.
#[tauri::command]
pub async fn vault_read_file(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Response, AppError> {
    Ok(Response::new(ops::read_file(&state.root(token)?, &rel)?))
}

/// Imagem do vault (r7 §1.3): bytes crus (ArrayBuffer no JS), só depois da checagem de caminho,
/// tipo pela extensão, teto e bytes mágicos (`image::read_image`).
#[tauri::command]
pub async fn vault_read_image(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Response, AppError> {
    let result = image::read_image(&state.root(token)?, &rel);
    // Só o código, nunca o caminho (§1.1).
    println!(
        "vault: read_image -> {}",
        result.as_ref().map_or_else(|e| e.code, |_| "ok")
    );
    Ok(Response::new(result?))
}

/// Corpo cru = bytes; cabeçalhos `x-simplemd-token`, `x-simplemd-rel` (URI-encoded) e
/// `x-simplemd-mode` (`create-new` | `overwrite`).
#[tauri::command]
pub async fn vault_write_file(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let token = header(&request, "x-simplemd-token")?
        .parse::<u32>()
        .map_err(|_| AppError::new("VAULT_CLOSED"))?;
    let rel = header(&request, "x-simplemd-rel")?;
    let mode = match header(&request, "x-simplemd-mode")?.as_str() {
        "create-new" => WriteMode::CreateNew,
        "overwrite" => WriteMode::Overwrite,
        _ => return Err(AppError::new("INVALID_PATH")),
    };
    let root = state.root(token)?;
    ops::write_file(&root, &rel, raw_body(&request)?, mode)
}

#[tauri::command]
pub async fn vault_mkdir(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<(), AppError> {
    ops::mkdir(&state.root(token)?, &rel)
}

/// Evento de observação: caminhos relativos à raiz (`/` em todo SO) ou uma falha.
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum WatchEvent {
    Paths { paths: Vec<String> },
    Error { error: &'static str },
}

/// Caminho absoluto de um evento → relativo à raiz; fora da raiz (ou a própria raiz) → `None`.
fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = rel.iter().map(|c| c.to_str()).collect();
    let parts = parts?;
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Observa a pasta ativa inteira (500 ms de debounce, recursivo; o mesmo do plugin fs no r1).
/// O observador para quando a pasta é trocada ou em `vault_unwatch`.
#[tauri::command]
pub async fn vault_watch(
    state: State<'_, VaultState>,
    token: u32,
    on_event: Channel<WatchEvent>,
) -> Result<u32, AppError> {
    let root = state.root(token)?;
    let event_root = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        None,
        move |result: DebounceEventResult| {
            let event = match result {
                Ok(events) => {
                    let mut paths: Vec<String> = events
                        .iter()
                        .flat_map(|e| e.event.paths.iter())
                        .filter_map(|p| rel_of(&event_root, p))
                        .collect();
                    paths.sort();
                    paths.dedup();
                    if paths.is_empty() {
                        return;
                    }
                    WatchEvent::Paths { paths }
                }
                Err(_) => WatchEvent::Error {
                    error: "falha na observação de arquivos",
                },
            };
            let _ = on_event.send(event);
        },
    )
    .map_err(|_| AppError::new("IO"))?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|_| AppError::new("IO"))?;
    state.add_watcher(token, debouncer)
}

#[tauri::command]
pub async fn vault_unwatch(state: State<'_, VaultState>, id: u32) -> Result<(), AppError> {
    state.remove_watcher(id);
    Ok(())
}

pub(crate) fn header(request: &Request<'_>, name: &str) -> Result<String, AppError> {
    let value = request
        .headers()
        .get(name)
        .ok_or_else(|| AppError::new("INVALID_PATH"))?;
    percent_encoding::percent_decode(value.as_bytes())
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| AppError::new("INVALID_PATH"))
}

pub(crate) fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], AppError> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes),
        InvokeBody::Json(_) => Err(AppError::new("IO")),
    }
}

#[cfg(test)]
mod tests {
    use super::ops::tests::TempDir;
    use super::*;
    use std::fs;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    fn read(state: &VaultState, token: u32, rel: &str) -> Result<Vec<u8>, AppError> {
        ops::read_file(&state.root(token)?, rel)
    }

    /// Abertura completa como no app: `pick_vault` (pendente) e o primeiro uso do token.
    fn open(state: &VaultState, root: PathBuf) -> u32 {
        let token = state.stage(root).unwrap();
        state.root(token).unwrap();
        token
    }

    /// CR2-02 (r1 CR-02): a pasta escolhida fica pendente; a atual continua lendo e gravando até o
    /// primeiro uso do token novo, que a troca de uma vez. Uma pendente nunca usada não vale nada.
    #[test]
    fn pick_is_pending_until_first_use() {
        let a = TempDir::new();
        let b = TempDir::new();
        let c = TempDir::new();
        a.put("nota.md", b"# N\n");
        b.put("outra.md", b"de B");
        let state = VaultState::default();
        let staged = state.stage(a.0.clone()).unwrap();
        assert_eq!(state.active_root(), None, "pendente não é ativa");
        assert_eq!(read(&state, staged, "nota.md").unwrap(), b"# N\n");
        assert_eq!(state.active_root().as_deref(), Some(a.0.as_path()));
        let token_a = staged;

        // Diálogo devolveu B: A continua valendo (regravação do que foi digitado com ele aberto).
        let token_b = state.stage(b.0.clone()).unwrap();
        assert_eq!(state.active_root().as_deref(), Some(a.0.as_path()));
        ops::write_file(
            &state.root(token_a).unwrap(),
            "nota.md",
            b"# N\ndigitado",
            ops::WriteMode::Overwrite,
        )
        .unwrap();
        assert_eq!(fs::read(a.0.join("nota.md")).unwrap(), b"# N\ndigitado");

        // Outro diálogo antes de usar B: B é descartada sem nunca ter valido.
        let token_c = state.stage(c.0.clone()).unwrap();
        assert_eq!(code(read(&state, token_b, "outra.md")), "VAULT_CLOSED");
        assert_eq!(read(&state, token_a, "nota.md").unwrap(), b"# N\ndigitado");

        // Primeiro uso do token pendente: C vira a ativa e A é revogada.
        assert_eq!(state.root(token_c).unwrap(), c.0);
        assert_eq!(state.active_root().as_deref(), Some(c.0.as_path()));
        assert_eq!(code(read(&state, token_a, "nota.md")), "VAULT_CLOSED");
        assert_eq!(code(read(&state, token_b, "outra.md")), "VAULT_CLOSED");
    }

    /// AC-P.5 (RUST): depois de abrir A e depois B, nenhuma leitura alcança A.
    #[test]
    fn switch_revokes_previous_root() {
        let a = TempDir::new();
        let b = TempDir::new();
        a.put("x.md", b"de A");
        b.put("y.md", b"de B");
        let state = VaultState::default();
        assert_eq!(code(state.root(1)), "NO_VAULT");
        let token_a = open(&state, a.0.clone());
        assert_eq!(read(&state, token_a, "x.md").unwrap(), b"de A");

        let token_b = open(&state, b.0.clone());
        assert_ne!(token_a, token_b);
        assert_eq!(code(read(&state, token_a, "x.md")), "VAULT_CLOSED");
        assert_eq!(code(read(&state, token_b, "x.md")), "NOT_FOUND"); // resolve em B, nunca em A
        assert_eq!(read(&state, token_b, "y.md").unwrap(), b"de B");
        let a_name = a.0.file_name().unwrap().to_str().unwrap();
        for rel in [
            format!("../{a_name}/x.md"),
            a.0.join("x.md").to_str().unwrap().to_owned(),
        ] {
            let c = code(read(&state, token_b, &rel));
            assert!(c == "OUTSIDE_VAULT" || c == "INVALID_PATH", "{rel}: {c}");
        }
        assert_eq!(
            code(state.root(token_a).and_then(|r| ops::lstat(&r, "x.md"))),
            "VAULT_CLOSED"
        );
    }

    #[test]
    fn reopen_previous_root_ok() {
        let a = TempDir::new();
        let b = TempDir::new();
        a.put("x.md", b"de A");
        let state = VaultState::default();
        open(&state, a.0.clone());
        open(&state, b.0.clone());
        let again = open(&state, a.0.clone());
        assert_eq!(read(&state, again, "x.md").unwrap(), b"de A");
    }

    #[test]
    fn nested_vault_ok() {
        let outer = TempDir::new();
        outer.put("sub/n.md", b"interna");
        outer.put("o.md", b"externa");
        let state = VaultState::default();
        let outer_token = open(&state, outer.0.clone());
        let inner_token = open(&state, outer.0.join("sub"));
        assert_eq!(read(&state, inner_token, "n.md").unwrap(), b"interna");
        assert_eq!(code(read(&state, inner_token, "../o.md")), "OUTSIDE_VAULT");
        assert_eq!(code(read(&state, outer_token, "o.md")), "VAULT_CLOSED");
        let outer_again = open(&state, outer.0.clone());
        assert_eq!(read(&state, outer_again, "sub/n.md").unwrap(), b"interna");
    }

    #[test]
    fn switch_drops_old_watchers() {
        let a = TempDir::new();
        let b = TempDir::new();
        let state = VaultState::default();
        let token_a = open(&state, a.0.clone());
        let watcher = new_debouncer(
            Duration::from_millis(500),
            None,
            |_: DebounceEventResult| {},
        )
        .unwrap();
        let id = state.add_watcher(token_a, watcher).unwrap();
        let watchers = |state: &VaultState| state.lock().active.as_ref().unwrap().watchers.len();
        assert_eq!(watchers(&state), 1);
        let token_b = state.stage(b.0.clone()).unwrap();
        assert_eq!(
            watchers(&state),
            1,
            "pendente: os observadores de A continuam"
        );
        assert_eq!(state.root(token_b).unwrap(), b.0);
        assert_eq!(watchers(&state), 0);
        let late = new_debouncer(
            Duration::from_millis(500),
            None,
            |_: DebounceEventResult| {},
        )
        .unwrap();
        assert_eq!(code(state.add_watcher(token_a, late)), "VAULT_CLOSED");
        state.remove_watcher(id); // id de uma abertura antiga: nada acontece
        assert_eq!(state.root(token_b).unwrap(), b.0);
    }

    /// AC-B12.5 (APPSEC-R2-05): 1 000 tokens seguidos, nunca 0, nunca o da ativa nem o da
    /// pendente do momento, e nenhum é o anterior + 1.
    #[test]
    fn random_tokens_never_zero_active_or_pending_and_not_sequential() {
        let dir = TempDir::new();
        let state = VaultState::default();
        let mut previous: Option<u32> = None;
        for i in 0..1000 {
            let (active, pending) = {
                let slots = state.lock();
                (
                    slots.active.as_ref().map(|a| a.token),
                    slots.pending.as_ref().map(|p| p.token),
                )
            };
            let token = state.stage(dir.0.clone()).unwrap();
            assert_ne!(token, 0);
            assert_ne!(Some(token), active);
            assert_ne!(Some(token), pending);
            if let Some(previous) = previous {
                assert_ne!(token, previous.wrapping_add(1), "token sequencial");
            }
            if i % 2 == 0 {
                state.root(token).unwrap();
            }
            previous = Some(token);
        }
    }

    #[test]
    fn watch_paths_are_root_relative() {
        let root = Path::new("/v/raiz");
        assert_eq!(
            rel_of(root, Path::new("/v/raiz/a/b.md")).as_deref(),
            Some("a/b.md")
        );
        assert_eq!(rel_of(root, Path::new("/v/raiz")), None);
        assert_eq!(rel_of(root, Path::new("/v/outra/x.md")), None);
        assert_eq!(rel_of(root, Path::new("/v/raizX/x.md")), None);
    }
}
