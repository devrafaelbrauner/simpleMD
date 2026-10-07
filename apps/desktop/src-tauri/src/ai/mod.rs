//! Camada nativa de IA (D-20, D-21; arch-backend r2 §1.7). O tráfego de IA nunca passa pelo webview
//! (`connect-src` da CSP inalterado, AC-11.9): o webview chama `ai_send` com a descrição do pedido e
//! um `Channel` de eventos, e `ai_cancel` aborta a tarefa (a conexão cai junto). As chaves ficam no
//! keychain (`keys`), e nenhum comando as devolve.

pub mod keys;
pub mod policy;
pub mod redact;
pub mod transport;

#[cfg(debug_assertions)]
pub mod recorder;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use tauri::async_runtime::JoinHandle;
use tauri::ipc::Channel;
use tauri::State;

use crate::error::AppError;
use policy::AiRequest;
use transport::{AiEvent, EventSink, Transport};

impl EventSink for Channel<AiEvent> {
    fn emit(&self, event: AiEvent) -> bool {
        self.send(event).is_ok()
    }
}

/// Estado do app: o transporte (um cliente HTTP só) e as tarefas em andamento, por id.
pub struct AiState {
    transport: Arc<Transport>,
    tasks: Arc<Mutex<HashMap<u32, JoinHandle<()>>>>,
    next: AtomicU32,
}

impl AiState {
    pub fn new(transport: Transport) -> Self {
        Self {
            transport: Arc::new(transport),
            tasks: Arc::default(),
            next: AtomicU32::new(0),
        }
    }
}

/// Valida, lê a chave (o keychain pode bloquear: fora da thread principal) e dispara o pedido.
/// Devolve o id para `ai_cancel`. Erros de política, de vaga e de chave voltam aqui, antes de
/// qualquer socket; erros de rede chegam como evento `error`.
#[tauri::command]
pub async fn ai_send(
    state: State<'_, AiState>,
    req: AiRequest,
    on_event: Channel<AiEvent>,
) -> Result<u32, AppError> {
    let transport = state.transport.clone();
    #[allow(unused_mut)]
    let mut prepared = tauri::async_runtime::spawn_blocking(move || transport.prepare(&req))
        .await
        .map_err(|_| AppError::new("KEYCHAIN_UNAVAILABLE"))??;
    #[cfg(debug_assertions)]
    let recording = recorder::from_env(&mut prepared);
    let id = state.next.fetch_add(1, Ordering::SeqCst).wrapping_add(1);
    let transport = state.transport.clone();
    let tasks = state.tasks.clone();
    // A trava fica com esta função até o id entrar no mapa: a tarefa só se remove depois disso.
    let mut running = state.tasks.lock();
    let handle = tauri::async_runtime::spawn(async move {
        let _trace = transport.run(prepared, &on_event).await;
        #[cfg(debug_assertions)]
        if let Some(recording) = recording {
            if let Err(error) = recording.write(&_trace) {
                eprintln!("ai: gravação de fixture falhou ({:?})", error.kind());
            }
        }
        tasks.lock().remove(&id);
    });
    running.insert(id, handle);
    Ok(id)
}

/// Cancela (aborta a tarefa: o futuro e a conexão caem). Id desconhecido ou já terminado: nada.
#[tauri::command]
pub fn ai_cancel(state: State<'_, AiState>, id: u32) {
    if let Some(handle) = state.tasks.lock().remove(&id) {
        handle.abort();
    }
}
