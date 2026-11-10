//! Gateway do vault (arch-backend r2 §1.2, D-B2; AS-01/02/03): o webview só fala com comandos do
//! app que recebem caminhos RELATIVOS ao vault. A raiz mora aqui, em `VaultState`. Cada abertura
//! gera um token novo; um token antigo vira `VAULT_CLOSED`. A pasta anterior fica inalcançável por
//! construção, sem `forbid` (reabri-la continua possível).
//!
//! A troca tem duas fases (r1 CR-02, CR2-02): `pick_vault` só deixa a pasta escolhida PENDENTE e a
//! ativa continua valendo, então o app ainda grava o que foi digitado com o diálogo aberto. A
//! pendente vira a ativa, de uma vez, no primeiro uso do token dela; o webview só o usa depois que
//! a regravação da pasta anterior deu certo.
//!
//! r36a (R21-RS-02, R21-RS-03): nenhum comando daqui (`src/vault/**`) nem de `save_targets.rs` faz
//! E/S numa thread do runtime assíncrono; os de `plugins.rs` ainda resolvem o token no worker
//! (R36A-PLUGINS). Diálogo, disco e a resolução do token (o primeiro uso de uma pendente derruba a
//! pasta anterior, e o observador dela para com `join`) rodam numa thread de bloqueio (`blocking`,
//! `VaultState::with_root`); o `check:security` reprova um comando daqui ou de `save_targets.rs`
//! sem isso, sem o `.await`, com um job que não seja uma closure ou com `ops::`, `fs::` ou `.root(`
//! fora dela (r37b, review r36a NB1). Cada abertura tem no máximo UM observador, filtrado pela
//! política (`policy::watchable`).
//!
//! r37b: e no máximo UMA busca no texto (`search`, `ActiveVault::search`): uma nova, o
//! `vault_search_cancel` com o id dela ou a troca de pasta a cancelam; um id já cancelado nasce
//! cancelado (code review r37b NB-1).

pub mod dictionaries;
pub mod image;
pub mod ops;
pub mod policy;
pub mod replace;
pub mod search;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, NoCache};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::AppError;
use crate::save_targets::SaveTargets;
use ops::{DirItem, Stat, WriteMode};

/// Aviso ao canal de um `vault_watch` cujo observador outro pedido da mesma abertura tomou: o
/// webview dele passa a sondar.
const REPLACED: &str = "observação substituída";
/// Aviso ao canal dono quando `vault_unwatch` para o observador (AppSec r36a N4): o id não exige
/// token, então quem pediu a parada pode não ser o dono; o webview dele passa a sondar.
const STOPPED: &str = "observação encerrada";

/// Roda `job` numa thread de bloqueio, fora dos workers do runtime assíncrono (R21-RS-02; a forma
/// do `ai::keys`): disco, diálogo nativo e a parada de um observador nunca prendem a ponte IPC.
/// `spawn_blocking`, não `block_in_place`, que entra em pânico num runtime `current_thread`
/// (D-R36-1). Job que entra em pânico → `IO`.
pub(crate) async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| AppError::new("IO"))?
}

/// Trava que sobrevive ao pânico de quem a segurava (sob ela só há trocas inteiras).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Canal do último `vault_watch` de uma abertura, compartilhado com o handler do debouncer.
type Sink = Arc<Mutex<Channel<WatchEvent>>>;

/// O observador de uma abertura, no máximo um (R21-RS-03): o id e o canal do último `vault_watch`
/// e o debouncer, que para quando isto sai.
struct VaultWatch {
    id: u32,
    sink: Sink,
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl VaultWatch {
    /// Recursivo, 500 ms de debounce (o do plugin fs no r1). `NoCache`: o `FileIdMap` padrão do
    /// macOS e do Windows varre a árvore inteira, seguindo links, a cada `watch`; e o inotify não
    /// segue links ao montar a observação.
    fn start(root: &Path, id: u32, channel: Channel<WatchEvent>) -> Result<Self, AppError> {
        let sink: Sink = Arc::new(Mutex::new(channel));
        let event_root = root.to_path_buf();
        let event_sink = Arc::clone(&sink);
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
            Duration::from_millis(500),
            None,
            move |result: DebounceEventResult| forward(&event_root, &event_sink, result),
            NoCache,
            notify::Config::default().with_follow_symlinks(false),
        )
        .map_err(|_| AppError::new("IO"))?;
        debouncer
            .watch(root, RecursiveMode::Recursive)
            .map_err(|_| AppError::new("IO"))?;
        Ok(Self {
            id,
            sink,
            _debouncer: debouncer,
        })
    }

    /// Outro `vault_watch` da mesma abertura: o id e o canal passam a ser os dele. Devolve o canal
    /// anterior, para o aviso fora da trava.
    fn take_over(&mut self, id: u32, channel: &Channel<WatchEvent>) -> Channel<WatchEvent> {
        self.id = id;
        std::mem::replace(&mut *lock(&self.sink), channel.clone())
    }
}

struct ActiveVault {
    root: PathBuf,
    token: u32,
    /// O observador desta abertura; sai (e para) junto com ela.
    watch: Option<VaultWatch>,
    /// A busca no texto desta abertura (r37b) e o maior id já cancelado; sair daqui (busca nova,
    /// cancelamento, troca de pasta) a cancela.
    search: search::SearchSlot,
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
                    watch: None,
                    search: search::SearchSlot::default(),
                });
            }
        }
        let root = self.active_for(token)?.root.clone();
        Ok((root, previous))
    }

    /// A ativa, se for a abertura `token` (sem ativar a pendente). Sem pasta → `NO_VAULT`; token de
    /// outra abertura → `VAULT_CLOSED`.
    fn active_for(&mut self, token: u32) -> Result<&mut ActiveVault, AppError> {
        match self.active.as_mut() {
            None => Err(AppError::new("NO_VAULT")),
            Some(active) if active.token != token => Err(AppError::new("VAULT_CLOSED")),
            Some(active) => Ok(active),
        }
    }
}

/// Estado nativo do vault: no máximo uma pasta ativa (uma janela, um vault) e uma pendente. Num
/// `Arc` (clonar é barato): `with_root` e os comandos de observação levam uma cópia para a thread
/// de bloqueio.
#[derive(Clone, Default)]
pub struct VaultState(Arc<Shared>);

#[derive(Default)]
struct Shared {
    slots: Mutex<Slots>,
    /// Um `vault_watch` por vez: o debouncer nasce fora da trava das pastas (no Linux o inotify
    /// percorre a árvore) e dois pedidos juntos nunca criam dois.
    watching: Mutex<()>,
    next_watch: AtomicU32,
}

impl VaultState {
    /// Primeira fase da troca: guarda `root` como pendente com um token novo. A ativa (e seu
    /// observador) continua valendo até o primeiro uso desse token; um novo `stage` substitui a
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
        // A pasta anterior (com seu observador) para fora da trava.
        drop(previous);
        Ok(root)
    }

    /// Confere, sem ativar a pendente, que `token` é o da ativa ou o da pendente, com os códigos de
    /// `root` (AppSec r36a N5): `vault_write_file` recusa o pedido de outra abertura antes de
    /// copiar o corpo. A troca de pasta continua no primeiro uso, em `with_root`.
    pub fn check(&self, token: u32) -> Result<(), AppError> {
        let mut slots = self.lock();
        if slots.pending.as_ref().is_some_and(|p| p.token == token) {
            return Ok(());
        }
        slots.active_for(token).map(|_| ())
    }

    /// `job` com a raiz da abertura `token`, numa thread de bloqueio (`blocking`). O token resolve
    /// lá também: o primeiro uso de uma pendente derruba a pasta anterior, e o observador dela para
    /// com `join` (FSEvents).
    pub async fn with_root<T: Send + 'static>(
        &self,
        token: u32,
        job: impl FnOnce(&Path) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let state = self.clone();
        blocking(move || job(&state.root(token)?)).await
    }

    /// Raiz da pasta ativa, se houver (comparações nativas, nunca exposta como caminho de acesso).
    pub fn active_root(&self) -> Option<PathBuf> {
        self.lock()
            .active
            .as_ref()
            .map(|active| active.root.clone())
    }

    fn lock(&self) -> MutexGuard<'_, Slots> {
        lock(&self.0.slots)
    }

    /// `vault_watch`: um observador por abertura. O primeiro pedido o cria; os seguintes tomam o
    /// canal (o anterior recebe `{ error }` e o webview dele passa a sondar) e ganham um id novo, o
    /// único que `unwatch` aceita dali em diante.
    fn watch(&self, token: u32, channel: Channel<WatchEvent>) -> Result<u32, AppError> {
        let _one_at_a_time = lock(&self.0.watching);
        let root = self.root(token)?;
        let id = self.0.next_watch.fetch_add(1, Ordering::SeqCst) + 1;
        // Já observada: o debouncer fica e só o canal muda de dono.
        let previous = self
            .lock()
            .active_for(token)?
            .watch
            .as_mut()
            .map(|watch| watch.take_over(id, &channel));
        if let Some(previous) = previous {
            let _ = previous.send(WatchEvent::Error { error: REPLACED });
            return Ok(id);
        }
        self.install(token, VaultWatch::start(&root, id, channel)?)
    }

    /// Instala na abertura `token` o observador que acabou de nascer e devolve o id dele. O
    /// debouncer nasce fora da trava das pastas: se a pasta trocou nesse meio-tempo, a
    /// reconferência do token dá `VAULT_CLOSED` (ou `NO_VAULT`) e ele para aqui, fora da trava — o
    /// observador de A nunca fica na abertura B (nomes de A no canal de B, e B sem eventos).
    fn install(&self, token: u32, watch: VaultWatch) -> Result<u32, AppError> {
        let id = watch.id;
        let mut watch = Some(watch);
        let installed = self
            .lock()
            .active_for(token)
            .map(|active| active.watch = watch.take());
        drop(watch);
        installed.map(|()| id)
    }

    /// `vault_unwatch`: para o observador só se `id` for o do último `vault_watch`; um id antigo
    /// (canal já tomado, ou de outra abertura) não faz nada. O id é sequencial e não exige token
    /// (AppSec r36a N4): quem pede a parada pode não ser o dono do canal, então o dono recebe
    /// `{ error }`, como na tomada, e o webview dele passa a sondar em vez de esperar eventos que
    /// não vêm mais. O dono que pediu a parada já saiu e ignora o aviso.
    fn unwatch(&self, id: u32) {
        let removed = self
            .lock()
            .active
            .as_mut()
            .filter(|active| active.watch.as_ref().is_some_and(|watch| watch.id == id))
            .and_then(|active| active.watch.take());
        let Some(watch) = removed else {
            return;
        };
        // Fora da trava. Até a thread do debouncer sair, o handler fala com um canal mudo: depois
        // do aviso, silêncio. A parada do observador faz `join` (FSEvents).
        let owner = std::mem::replace(&mut *lock(&watch.sink), Channel::new(|_| Ok(())));
        drop(watch);
        let _ = owner.send(WatchEvent::Error { error: STOPPED });
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
    // O diálogo bloqueia: numa thread de bloqueio, nunca na principal nem num worker do runtime.
    let Some(root) = blocking(move || pick_folder(&app)).await? else {
        return Ok(None);
    };
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

/// A pasta escolhida no diálogo (cancelado → `None`), conferida no disco.
fn pick_folder(app: &AppHandle) -> Result<Option<PathBuf>, AppError> {
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
    Ok(Some(root))
}

#[tauri::command]
pub async fn vault_read_dir(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Vec<DirItem>, AppError> {
    state
        .with_root(token, move |root| ops::read_dir(root, &rel))
        .await
}

#[tauri::command]
pub async fn vault_lstat(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Option<Stat>, AppError> {
    state
        .with_root(token, move |root| ops::lstat(root, &rel))
        .await
}

/// Bytes crus (ArrayBuffer no JS), sem passar por JSON.
#[tauri::command]
pub async fn vault_read_file(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Response, AppError> {
    let bytes = state
        .with_root(token, move |root| ops::read_file(root, &rel))
        .await?;
    Ok(Response::new(bytes))
}

/// Imagem do vault (r7 §1.3): bytes crus (ArrayBuffer no JS), só depois da checagem de caminho,
/// tipo pela extensão, teto e bytes mágicos (`image::read_image`). A leitura (até 20 MiB) roda
/// numa thread de bloqueio, fora dos workers do runtime (F-06).
#[tauri::command]
pub async fn vault_read_image(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<Response, AppError> {
    let result = state
        .with_root(token, move |root| image::read_image(root, &rel))
        .await;
    // Só o código, nunca o caminho (§1.1).
    println!(
        "vault: read_image -> {}",
        result.as_ref().map_or_else(|e| e.code, |_| "ok")
    );
    Ok(Response::new(result?))
}

/// Corpo cru = bytes; cabeçalhos `x-simplemd-token`, `x-simplemd-rel` (URI-encoded),
/// `x-simplemd-mode` (`create-new` | `overwrite`) e, só com `overwrite`,
/// `x-simplemd-expected-sha256`: o sha256 (hex minúsculo) do conteúdo que o app conhece; a troca só
/// acontece se o disco ainda o tiver (r26, D-R26-2). A troca (temporário, `sync_all`, `rename`)
/// roda numa thread de bloqueio, com uma cópia do corpo: o `Request` é emprestado
/// (R26-FSYNC-ASYNC). A cópia só sai depois de o token ser o da ativa ou o da pendente
/// (`copy_after_check`; AppSec r36a N5): o pedido de outra abertura não dobra a memória com o corpo.
#[tauri::command]
pub async fn vault_write_file(
    state: State<'_, VaultState>,
    request: Request<'_>,
) -> Result<(), AppError> {
    let token = header(&request, "x-simplemd-token")?
        .parse::<u32>()
        .map_err(|_| AppError::new("VAULT_CLOSED"))?;
    let rel = header(&request, "x-simplemd-rel")?;
    let mode = write_mode(
        &header(&request, "x-simplemd-mode")?,
        optional_header(&request, "x-simplemd-expected-sha256")?.as_deref(),
    )?;
    let bytes = copy_after_check(&state, token, || Ok(raw_body(&request)?.to_vec()))?;
    state
        .with_root(token, move |root| ops::write_file(root, &rel, &bytes, mode))
        .await
}

/// `copy` (a cópia do corpo de `vault_write_file`) só roda depois de `VaultState::check` aceitar o
/// token, sem ativar a pendente (AppSec r36a N5; review r36a NB2, o mutante M10).
fn copy_after_check<T>(
    state: &VaultState,
    token: u32,
    copy: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    state.check(token)?;
    copy()
}

/// `create-new` sem hash; `overwrite` só com o sha256 esperado (64 hex minúsculos). Qualquer outra
/// combinação → `INVALID_PATH`, como os demais cabeçalhos malformados: não existe sobrescrita cega.
fn write_mode(mode: &str, expected_sha256: Option<&str>) -> Result<WriteMode, AppError> {
    match (mode, expected_sha256) {
        ("create-new", None) => Ok(WriteMode::CreateNew),
        ("overwrite", Some(hex)) => parse_sha256(hex)
            .map(|expected_sha256| WriteMode::Overwrite { expected_sha256 })
            .ok_or_else(|| AppError::new("INVALID_PATH")),
        _ => Err(AppError::new("INVALID_PATH")),
    }
}

fn parse_sha256(hex: &str) -> Option<[u8; 32]> {
    let digit = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let (pairs, rest) = hex.as_bytes().as_chunks::<2>();
    if pairs.len() != 32 || !rest.is_empty() {
        return None;
    }
    let mut out = [0u8; 32];
    for (byte, [high, low]) in out.iter_mut().zip(pairs) {
        *byte = (digit(*high)? << 4) | digit(*low)?;
    }
    Some(out)
}

#[tauri::command]
pub async fn vault_mkdir(
    state: State<'_, VaultState>,
    token: u32,
    rel: String,
) -> Result<(), AppError> {
    state
        .with_root(token, move |root| ops::mkdir(root, &rel))
        .await
}

/// Evento de observação: caminhos relativos à raiz (`/` em todo SO) ou uma falha.
#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum WatchEvent {
    Paths { paths: Vec<String> },
    Error { error: &'static str },
}

/// Caminho absoluto de um evento → relativo à raiz; fora da raiz, a própria raiz ou o temporário
/// de uma gravação (`replace::is_temp_name`, AC-R26-4) → `None`.
fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = rel.iter().map(|c| c.to_str()).collect();
    let parts = parts?;
    if parts.last().is_some_and(|name| replace::is_temp_name(name)) {
        return None;
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Um lote do debouncer → o canal atual da abertura: só os caminhos relativos que a política deixa
/// observar (`policy::watchable`: nada de `.git`, oculto, temporário, `node_modules` ou o resto de
/// `.simplemd` sem classe), em ordem e sem repetir; lote que fica vazio não sai.
fn forward(root: &Path, sink: &Mutex<Channel<WatchEvent>>, result: DebounceEventResult) {
    let event = match result {
        Ok(events) => {
            let mut paths: Vec<String> = events
                .iter()
                .flat_map(|e| e.event.paths.iter())
                .filter_map(|p| rel_of(root, p))
                .filter(|rel| policy::watchable(rel))
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
    let _ = lock(sink).send(event);
}

/// Observa a pasta ativa inteira com UM observador por abertura (`VaultWatch`): outro
/// `vault_watch` da mesma abertura toma o canal, e o anterior recebe `{ error }`. Para quando a
/// pasta é trocada ou em `vault_unwatch` com o id atual.
#[tauri::command]
pub async fn vault_watch(
    state: State<'_, VaultState>,
    token: u32,
    on_event: Channel<WatchEvent>,
) -> Result<u32, AppError> {
    let state = state.inner().clone();
    blocking(move || state.watch(token, on_event)).await
}

/// Para o observador se `id` for o atual, e o canal dono recebe `{ error }` (AppSec r36a N4); senão
/// nada.
#[tauri::command]
pub async fn vault_unwatch(state: State<'_, VaultState>, id: u32) -> Result<(), AppError> {
    let state = state.inner().clone();
    blocking(move || {
        state.unwatch(id);
        Ok(())
    })
    .await
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

/// Cabeçalho opcional: ausente → `None`; presente → decodificado como em `header`.
fn optional_header(request: &Request<'_>, name: &str) -> Result<Option<String>, AppError> {
    if request.headers().get(name).is_none() {
        return Ok(None);
    }
    header(request, name).map(Some)
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
    use std::future::Future;
    use std::pin::pin;
    use std::sync::mpsc;
    use std::task::{Context, Waker};
    use std::time::Instant;

    use notify::{Event, EventKind};
    use notify_debouncer_full::DebouncedEvent;
    use serde_json::{json, Value};
    use tauri::ipc::InvokeResponseBody;

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

    /// Canal como o do webview, guardando o que recebe (JSON).
    fn recorder() -> (Channel<WatchEvent>, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                lock(&sink).push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, seen)
    }

    /// O que o canal recebeu desde a última consulta.
    fn taken(seen: &Mutex<Vec<Value>>) -> Vec<Value> {
        std::mem::take(&mut *lock(seen))
    }

    /// Id e canal compartilhado do observador da ativa (`None` sem observador).
    fn current(state: &VaultState) -> Option<(u32, Sink)> {
        let slots = state.lock();
        let watch = slots.active.as_ref()?.watch.as_ref()?;
        Some((watch.id, Arc::clone(&watch.sink)))
    }

    /// Lote do debouncer com estes caminhos absolutos.
    fn batch(paths: &[PathBuf]) -> DebounceEventResult {
        Ok(paths
            .iter()
            .map(|path| {
                DebouncedEvent::new(
                    Event::new(EventKind::Any).add_path(path.clone()),
                    Instant::now(),
                )
            })
            .collect())
    }

    /// Espera (até 5 s) a condição: a thread do debouncer sai no tick seguinte à parada.
    fn eventually(mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    /// AC-R36-1 (R21-RS-02): `with_root` roda o job (e a resolução do token) numa thread de
    /// bloqueio. O 1º `poll` devolve `Pending` com o job ainda à espera de um sinal que o teste só
    /// manda depois; se o job rodasse dentro do `poll`, a espera estouraria o prazo e o `poll`
    /// sairia `Ready` (falha).
    #[test]
    fn with_root_runs_the_job_on_a_blocking_thread() {
        let dir = TempDir::new();
        dir.put("a.md", b"# A\n");
        let state = VaultState::default();
        let token = open(&state, dir.0.clone());
        let (go, signal) = mpsc::channel::<()>();
        let mut job = pin!(state.with_root(token, move |root| {
            signal
                .recv_timeout(Duration::from_secs(5))
                .map_err(|_| AppError::new("IO"))?;
            Ok((std::thread::current().id(), ops::read_file(root, "a.md")?))
        }));
        let first = job.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        assert!(first.is_pending(), "o job rodou dentro do poll");
        go.send(()).unwrap();
        let (thread, bytes) = tauri::async_runtime::block_on(job).unwrap();
        assert_ne!(thread, std::thread::current().id());
        assert_eq!(bytes, b"# A\n");
    }

    /// O primeiro uso de uma pendente por `with_root` troca a pasta lá dentro e derruba o
    /// observador da anterior; o token antigo vira `VAULT_CLOSED`.
    #[test]
    fn with_root_activates_the_pending_vault() {
        let a = TempDir::new();
        let b = TempDir::new();
        b.put("b.md", b"de B");
        let state = VaultState::default();
        let token_a = open(&state, a.0.clone());
        let (channel, _) = recorder();
        state.watch(token_a, channel).unwrap();
        let token_b = state.stage(b.0.clone()).unwrap();
        let read_b = state.with_root(token_b, |root| ops::read_file(root, "b.md"));
        assert_eq!(tauri::async_runtime::block_on(read_b).unwrap(), b"de B");
        assert_eq!(state.active_root().as_deref(), Some(b.0.as_path()));
        assert!(current(&state).is_none());
        let late = state.with_root(token_a, |_| Ok(()));
        assert_eq!(code(tauri::async_runtime::block_on(late)), "VAULT_CLOSED");
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
            ops::tests::overwrite(b"# N\n"),
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

    /// AC-R36-1 (R21-RS-03): no máximo um observador por abertura. A 2ª inscrição reaproveita o
    /// debouncer e toma o canal: o anterior recebe o aviso (o webview dele passa a sondar) e mais
    /// nada; o `unwatch` do id antigo não faz nada e o do atual para o observador.
    #[test]
    fn second_watch_takes_over_the_single_watcher() {
        let dir = TempDir::new();
        let state = VaultState::default();
        let token = open(&state, dir.0.clone());
        let (first, first_seen) = recorder();
        let old = state.watch(token, first).unwrap();
        let (id, sink) = current(&state).unwrap();
        assert_eq!(id, old);
        // O canal é do observador, do handler do único debouncer e deste teste.
        assert_eq!(Arc::strong_count(&sink), 3);

        let (second, second_seen) = recorder();
        let new = state.watch(token, second).unwrap();
        assert_ne!(new, old);
        let (id, same) = current(&state).unwrap();
        assert_eq!(id, new);
        assert!(Arc::ptr_eq(&sink, &same), "outro observador nasceu");
        drop(same);
        assert_eq!(Arc::strong_count(&sink), 3, "outro debouncer nasceu");
        assert_eq!(
            taken(&first_seen),
            [json!({ "error": "observação substituída" })]
        );
        assert!(taken(&second_seen).is_empty());

        // O handler fala só com o canal atual.
        forward(&dir.0, &sink, batch(&[dir.0.join("nota.md")]));
        assert_eq!(taken(&second_seen), [json!({ "paths": ["nota.md"] })]);
        assert!(taken(&first_seen).is_empty());

        state.unwatch(old);
        assert_eq!(current(&state).map(|(id, _)| id), Some(new), "id antigo");
        state.unwatch(new);
        assert!(current(&state).is_none());
        assert!(
            eventually(|| Arc::strong_count(&sink) == 1),
            "o debouncer parou"
        );

        // Parado, a próxima inscrição cria outro.
        let (third, _) = recorder();
        let again = state.watch(token, third).unwrap();
        let (id, fresh) = current(&state).unwrap();
        assert_eq!(id, again);
        assert!(!Arc::ptr_eq(&sink, &fresh));
    }

    /// Trocar de pasta derruba o observador (o debouncer para); token e id antigos não fazem nada.
    #[test]
    fn switch_drops_the_watcher() {
        let a = TempDir::new();
        let b = TempDir::new();
        let state = VaultState::default();
        let token_a = open(&state, a.0.clone());
        let (channel, _) = recorder();
        let id = state.watch(token_a, channel).unwrap();
        let (_, sink) = current(&state).unwrap();
        let token_b = state.stage(b.0.clone()).unwrap();
        assert!(
            current(&state).is_some(),
            "pendente: o observador de A continua"
        );
        assert_eq!(state.root(token_b).unwrap(), b.0);
        assert!(current(&state).is_none());
        assert!(
            eventually(|| Arc::strong_count(&sink) == 1),
            "o debouncer parou"
        );
        let (late, _) = recorder();
        assert_eq!(code(state.watch(token_a, late)), "VAULT_CLOSED");
        state.unwatch(id); // id de uma abertura antiga: nada acontece
        assert_eq!(state.root(token_b).unwrap(), b.0);
    }

    /// Code review r36a NB-1 (mutante M2): o debouncer nasce fora da trava das pastas. Se a pasta
    /// trocou nesse meio-tempo, `install` reconfere o token e recusa: o observador de A para e
    /// nunca fica na abertura B (nomes de A no canal de B, e B sem eventos).
    #[test]
    fn install_refuses_a_watcher_born_before_a_folder_switch() {
        let a = TempDir::new();
        let b = TempDir::new();
        let state = VaultState::default();
        let token_a = open(&state, a.0.clone());
        let (channel, seen) = recorder();
        let born = VaultWatch::start(&a.0, 7, channel).unwrap();
        let sink = Arc::clone(&born.sink);
        let token_b = open(&state, b.0.clone());
        assert_eq!(code(state.install(token_a, born)), "VAULT_CLOSED");
        assert!(
            current(&state).is_none(),
            "o observador de A ficou na abertura B"
        );
        assert!(
            eventually(|| Arc::strong_count(&sink) == 1),
            "o debouncer de A parou"
        );
        assert!(taken(&seen).is_empty());

        // Na abertura do token, instala.
        let (channel, _) = recorder();
        let born = VaultWatch::start(&b.0, 8, channel).unwrap();
        assert_eq!(state.install(token_b, born).unwrap(), 8);
        assert_eq!(current(&state).map(|(id, _)| id), Some(8));
    }

    /// AppSec r36a N4 (prova A4): o id é sequencial e `vault_unwatch` não exige token. Adivinhar o
    /// id ainda para o observador, mas o dono do canal recebe o aviso (o webview dele passa a
    /// sondar) e, depois dele, nada mais.
    #[test]
    fn unwatch_tells_the_owner_of_the_channel() {
        let dir = TempDir::new();
        let state = VaultState::default();
        let token = open(&state, dir.0.clone());
        let (channel, seen) = recorder();
        state.watch(token, channel).unwrap();
        let (_, sink) = current(&state).unwrap();
        for guess in 1..=64 {
            state.unwatch(guess);
        }
        assert!(current(&state).is_none());
        assert_eq!(taken(&seen), [json!({ "error": "observação encerrada" })]);
        forward(&dir.0, &sink, batch(&[dir.0.join("nota.md")]));
        assert!(
            taken(&seen).is_empty(),
            "o canal dono recebeu algo depois do aviso"
        );
        assert!(
            eventually(|| Arc::strong_count(&sink) == 1),
            "o debouncer parou"
        );
    }

    /// AppSec r36a N5: `vault_write_file` confere o token (`check`) antes de copiar o corpo. A
    /// conferência aceita a ativa e a pendente sem trocar de pasta — a pendente só vira a ativa no
    /// primeiro uso, em `with_root` — e o observador da ativa continua.
    #[test]
    fn check_accepts_the_active_and_the_pending_without_switching() {
        let a = TempDir::new();
        let b = TempDir::new();
        let state = VaultState::default();
        assert_eq!(code(state.check(1)), "NO_VAULT");
        let token_a = open(&state, a.0.clone());
        let (channel, _) = recorder();
        state.watch(token_a, channel).unwrap();
        let token_b = state.stage(b.0.clone()).unwrap();
        assert_eq!(code(state.check(token_a)), "OK");
        assert_eq!(code(state.check(token_b)), "OK");
        assert_eq!(
            state.active_root().as_deref(),
            Some(a.0.as_path()),
            "a pendente virou a ativa"
        );
        assert!(current(&state).is_some(), "o observador de A parou");

        state.root(token_b).unwrap();
        assert_eq!(code(state.check(token_a)), "VAULT_CLOSED");
        assert_eq!(code(state.check(token_b)), "OK");
    }

    /// Review r36a NB2 (o mutante M10, sem o `check`, sobrevivia): `vault_write_file` só copia o
    /// corpo depois de o token ser o da ativa ou o da pendente; o de nenhuma pasta, o de uma
    /// abertura antiga e o de uma pendente descartada não copiam nada, e a pendente não vira a ativa.
    #[test]
    fn write_copies_the_body_only_after_the_token_check() {
        let a = TempDir::new();
        let b = TempDir::new();
        let c = TempDir::new();
        let state = VaultState::default();
        let copies = std::cell::Cell::new(0);
        let copy = || {
            copies.set(copies.get() + 1);
            Ok(())
        };
        assert_eq!(code(copy_after_check(&state, 1, copy)), "NO_VAULT");
        let token_a = open(&state, a.0.clone());
        let token_b = state.stage(b.0.clone()).unwrap();
        assert_eq!(code(copy_after_check(&state, token_a, copy)), "OK");
        assert_eq!(code(copy_after_check(&state, token_b, copy)), "OK");
        assert_eq!(copies.get(), 2);
        assert_eq!(state.active_root().as_deref(), Some(a.0.as_path()));
        let token_c = state.stage(c.0.clone()).unwrap();
        assert_eq!(
            code(copy_after_check(&state, token_b, copy)),
            "VAULT_CLOSED"
        );
        state.root(token_c).unwrap();
        assert_eq!(
            code(copy_after_check(&state, token_a, copy)),
            "VAULT_CLOSED"
        );
        assert_eq!(copies.get(), 2, "o corpo foi copiado sem o check");
    }

    /// Review r37b NB-6 (R37B-NB2-PONTO): o pedido de verdade ao comando `vault_write_file`, pelo
    /// IPC do runtime falso do Tauri (`tauri::test`), e não só o helper: o teste de cima passaria
    /// com o corpo copiado direto no comando, antes do `check`. Aqui o corpo de um token recusado
    /// nem é bytes crus (JSON): tocá-lo antes do `check` daria o `IO` da leitura do corpo, e o
    /// comando tem de responder o código do token (`NO_VAULT`, ou `VAULT_CLOSED` para uma pendente
    /// descartada ou uma abertura antiga) sem gravar nada. A pendente passa pelo `check` sem virar
    /// a ativa (só aí o corpo é lido e recusado), e o token certo grava o corpo cru.
    #[test]
    fn the_write_command_checks_the_token_before_touching_the_body() {
        use tauri::http::{HeaderMap, HeaderValue};
        use tauri::ipc::{CallbackFn, InvokeBody};
        use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
        use tauri::webview::InvokeRequest;
        use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

        let app = mock_builder()
            .manage(VaultState::default())
            .invoke_handler(tauri::generate_handler![vault_write_file])
            .build(mock_context(noop_assets()))
            .unwrap();
        let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let url = webview.url().unwrap();
        let write = |token: u32, rel: &str, body: InvokeBody| -> String {
            let mut headers = HeaderMap::new();
            for (name, value) in [
                ("x-simplemd-token", token.to_string()),
                ("x-simplemd-rel", rel.to_owned()),
                ("x-simplemd-mode", "create-new".to_owned()),
            ] {
                headers.insert(name, HeaderValue::from_str(&value).unwrap());
            }
            let request = InvokeRequest {
                cmd: "vault_write_file".to_owned(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.clone(),
                body,
                headers,
                invoke_key: INVOKE_KEY.to_owned(),
            };
            match get_ipc_response(&webview, request) {
                Ok(_) => "OK".to_owned(),
                Err(error) => error["code"].as_str().unwrap_or("sem código").to_owned(),
            }
        };
        let not_raw = || InvokeBody::Json(json!({ "corpo": "não é bytes crus" }));
        let state = app.state::<VaultState>();
        let (a, b, c) = (TempDir::new(), TempDir::new(), TempDir::new());
        assert_eq!(write(1, "nota.md", not_raw()), "NO_VAULT");
        let token_a = open(&state, a.0.clone());
        let token_b = state.stage(b.0.clone()).unwrap();
        assert_eq!(write(token_b, "nota.md", not_raw()), "IO");
        assert_eq!(state.active_root().as_deref(), Some(a.0.as_path()));
        let token_c = state.stage(c.0.clone()).unwrap();
        assert_eq!(write(token_b, "nota.md", not_raw()), "VAULT_CLOSED");
        assert_eq!(
            write(token_a, "nota.md", InvokeBody::Raw(b"# A\n".to_vec())),
            "OK"
        );
        assert_eq!(fs::read(a.0.join("nota.md")).unwrap(), b"# A\n");
        state.root(token_c).unwrap();
        assert_eq!(write(token_a, "outra.md", not_raw()), "VAULT_CLOSED");
        assert!(!a.0.join("outra.md").exists());
        assert!(!b.0.join("nota.md").exists() && !c.0.join("nota.md").exists());
    }

    /// AC-R36-1 (R21-RS-03): o lote sai só com o que a política deixa observar — nada de `.git`,
    /// `node_modules`, oculto, temporário da gravação, `.simplemd` sem classe, fora da raiz ou a
    /// própria raiz —, em ordem e sem repetir; lote que fica vazio não sai; falha → `{ error }`.
    #[test]
    fn forward_sends_only_watchable_paths() {
        let root = Path::new("/v/raiz");
        let (channel, seen) = recorder();
        let sink = Mutex::new(channel);
        let abs = |rels: &[&str]| -> Vec<PathBuf> { rels.iter().map(|r| root.join(r)).collect() };
        let mut paths = abs(&[
            "notas/b.md",
            ".git/index",
            ".git/objects/ab/cdef",
            "node_modules",
            "node_modules/pacote/README.md",
            "notas/node_modules/x.md",
            ".env",
            "notas/.oculto.md",
            "notas/.~simplemd-0123456789abcdef.tmp",
            ".simplemd",
            ".simplemd/themes/meu",
            ".simplemd/config.json",
            ".simplemd/dictionaries/pessoal.txt",
            ".markdownlint.json",
            "imagens/foto.png",
            "notas/b.md",
            "a.md",
        ]);
        paths.extend([PathBuf::from("/v/outra/x.md"), root.to_path_buf()]);
        forward(root, &sink, batch(&paths));
        assert_eq!(
            taken(&seen),
            [json!({ "paths": [
                ".markdownlint.json",
                ".simplemd/config.json",
                ".simplemd/dictionaries/pessoal.txt",
                "a.md",
                "imagens/foto.png",
                "notas/b.md",
            ] })]
        );
        forward(
            root,
            &sink,
            batch(&abs(&[".git/HEAD", "node_modules/x/y.md"])),
        );
        assert!(taken(&seen).is_empty());
        forward(root, &sink, Err(Vec::new()));
        assert_eq!(
            taken(&seen),
            [json!({ "error": "falha na observação de arquivos" })]
        );
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
        // AC-R26-4: o temporário de uma gravação nunca é repassado (o alvo da troca é).
        assert_eq!(
            rel_of(root, Path::new("/v/raiz/a/.~simplemd-0123456789abcdef.tmp")),
            None
        );
        assert_eq!(
            rel_of(root, Path::new("/v/raiz/.~simplemd-0123456789abcdef.tmp")),
            None
        );
    }

    /// r26 (D-R26-2): `overwrite` só com o sha256 esperado bem formado; `create-new` sem ele.
    #[test]
    fn write_mode_requires_the_expected_hash_only_on_overwrite() {
        let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        assert_eq!(
            write_mode("create-new", None).unwrap(),
            WriteMode::CreateNew
        );
        assert_eq!(
            write_mode("overwrite", Some(hex)).unwrap(),
            WriteMode::Overwrite {
                expected_sha256: replace::sha256(b"")
            }
        );
        let upper = hex.to_ascii_uppercase();
        let long = format!("{hex}0");
        for (mode, expected) in [
            ("overwrite", None),
            ("overwrite", Some(upper.as_str())),
            ("overwrite", Some(&hex[..63])),
            ("overwrite", Some(long.as_str())),
            (
                "overwrite",
                Some("g3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ),
            ("overwrite", Some("")),
            ("create-new", Some(hex)),
            ("append", None),
            ("", None),
        ] {
            assert_eq!(
                code(write_mode(mode, expected)),
                "INVALID_PATH",
                "{mode} {expected:?}"
            );
        }
    }
}
