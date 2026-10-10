//! LanguageTool local, variante N (r7 arch-backend §1.4; R-I8.2, D-26/D-27, Q-R7-1). O HTTP é feito
//! no Rust, fora do WebView: `connect-src` da CSP e o proxy morto do WebView2 (W-01,
//! `webview_net.rs`) não mudam. Só dois endereços constantes, sem DNS (D-R7-B04b): `127.0.0.1:8081`
//! e, se ele recusar a conexão, `[::1]:8081`. Nenhum comando recebe host, porta, esquema ou caminho
//! ("localhost só para loopback" vale por construção). "Último vence" (D-R7-B03): um `lt_check`
//! novo aborta o anterior (`CANCELLED`); a sonda idem. Log: uma linha por pedido, só status/código,
//! tempo e contagem de unidades — nunca texto, corpo, regra ou palavra (R-I8.10).

pub mod policy;
pub mod transport;

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use reqwest::redirect::Policy;
use reqwest::Method;
use tauri::async_runtime::JoinHandle;
use tauri::State;
use tokio::sync::oneshot;

use crate::ai::transport::{LogSink, StdoutLog};
use crate::error::AppError;
use transport::{Call, Transport, CHECK_MAX, CHECK_TIMEOUT, LANGUAGES_MAX, PROBE_TIMEOUT};

pub const LT_PORT: u16 = 8081;
/// Tentados nesta ordem (o 2º só se o 1º der `CONNECTION_REFUSED`); o que funcionou fica preferido.
pub const ENDPOINTS: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), LT_PORT),
    SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), LT_PORT),
];
/// `GET`.
pub const PATH_LANGUAGES: &str = "/v2/languages";
/// `POST`.
pub const PATH_CHECK: &str = "/v2/check";
/// Por endereço. Cabe 2× na sonda de 2 s (D-R7-SN-14).
pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(700);

/// Cliente próprio (separado do da IA): sem redirecionamento, sem proxy (nem `HTTP_PROXY`/
/// `ALL_PROXY` do ambiente; o reqwest não usa o proxy do sistema), HTTP/1.1, 700 ms para conectar
/// em cada endereço (as duas tentativas cabem na sonda de 2 s mesmo no Windows, onde a porta
/// fechada não recusa na hora; D-R7-SN-14), 1 conexão ociosa.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .http1_only()
        .connect_timeout(CONNECT_TIMEOUT)
        .pool_max_idle_per_host(1)
        .user_agent(concat!("simpleMD/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("cliente HTTP do LanguageTool")
}

/// Vaga da verificação: o id do pedido mais novo (reservado ANTES da validação) e a tarefa dele.
#[derive(Default)]
struct CheckSlot {
    id: Option<u32>,
    handle: Option<JoinHandle<()>>,
}

/// Estado: o transporte e as tarefas em voo (no máximo 1 verificação + 1 sonda = 2 sockets).
pub struct LtState {
    transport: Arc<Transport>,
    check: Mutex<CheckSlot>,
    probe: Mutex<Option<JoinHandle<()>>>,
    log: Arc<dyn LogSink>,
}

impl LtState {
    pub fn new() -> Self {
        Self::with_transport(Transport::new(client(), ENDPOINTS), Arc::new(StdoutLog))
    }

    fn with_transport(transport: Transport, log: Arc<dyn LogSink>) -> Self {
        Self {
            transport: Arc::new(transport),
            check: Mutex::new(CheckSlot::default()),
            probe: Mutex::new(None),
            log,
        }
    }

    /// Um `lt_check` novo — válido ou não — toma a vaga e aborta o anterior (§1.4, F-03).
    fn reserve_check(&self, request_id: u32) {
        let mut slot = self.check.lock();
        if let Some(previous) = slot.handle.take() {
            previous.abort();
        }
        slot.id = Some(request_id);
    }

    /// Guarda a tarefa se a vaga ainda é deste id; senão (um `lt_cancel` ou um check mais novo
    /// chegou durante a validação) devolve a própria tarefa para ser abortada → `CANCELLED`.
    fn store_check(&self, request_id: u32, handle: JoinHandle<()>) -> Option<JoinHandle<()>> {
        let mut slot = self.check.lock();
        if slot.id == Some(request_id) {
            slot.handle.replace(handle)
        } else {
            Some(handle)
        }
    }

    /// Roda `call` numa tarefa própria guardada em `slot` (a anterior é abortada: o receptor dela
    /// vê o emissor cair → `CANCELLED`).
    async fn spawn_latest(
        &self,
        call: Call,
        store: impl FnOnce(JoinHandle<()>) -> Option<JoinHandle<()>>,
    ) -> Result<String, AppError> {
        let (tx, rx) = oneshot::channel();
        let transport = self.transport.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let _ = tx.send(transport.run(call).await);
        });
        if let Some(previous) = store(handle) {
            previous.abort();
        }
        rx.await.unwrap_or_else(|_| Err(AppError::new("CANCELLED")))
    }

    async fn languages(&self) -> Result<String, AppError> {
        let started = Instant::now();
        let call = Call {
            method: Method::GET,
            path: PATH_LANGUAGES,
            body: None,
            cap: LANGUAGES_MAX,
            timeout: PROBE_TIMEOUT,
        };
        let result = self
            .spawn_latest(call, |handle| self.probe.lock().replace(handle))
            .await;
        self.log.line(&format!(
            "lt: languages {} {}ms",
            outcome(&result),
            started.elapsed().as_millis()
        ));
        result
    }

    async fn check(&self, request_id: u32, req: serde_json::Value) -> Result<String, AppError> {
        let started = Instant::now();
        self.reserve_check(request_id);
        let checked = policy::parse_request(req).and_then(|r| policy::check(&r));
        let (result, units) = match checked {
            Err(error) => {
                let mut slot = self.check.lock();
                if slot.id == Some(request_id) {
                    slot.id = None;
                }
                (Err(error), 0)
            }
            Ok(checked) => {
                let call = Call {
                    method: Method::POST,
                    path: PATH_CHECK,
                    body: Some(checked.body.into()),
                    cap: CHECK_MAX,
                    timeout: CHECK_TIMEOUT,
                };
                let result = self
                    .spawn_latest(call, |handle| self.store_check(request_id, handle))
                    .await;
                (result, checked.units)
            }
        };
        self.log.line(&format!(
            "lt: check {} {}ms {units}u",
            outcome(&result),
            started.elapsed().as_millis()
        ));
        result
    }

    /// Aborta a verificação do id dado — em voo ou ainda validando (a vaga é liberada e a tarefa,
    /// se vier, é abortada ao ser guardada); id de outro pedido: nada.
    fn cancel(&self, request_id: u32) {
        let mut slot = self.check.lock();
        if slot.id == Some(request_id) {
            slot.id = None;
            if let Some(handle) = slot.handle.take() {
                handle.abort();
            }
        }
    }
}

fn outcome(result: &Result<String, AppError>) -> &'static str {
    match result {
        Ok(_) => "200",
        Err(error) => error.code,
    }
}

/// `GET /v2/languages` (2 s no total, corpo ≤ 256 KiB): corpo JSON cru. Último vence (sonda).
#[tauri::command]
pub async fn lt_languages(state: State<'_, LtState>) -> Result<String, AppError> {
    state.languages().await
}

/// `POST /v2/check` (15 s no total, corpo ≤ 2 MiB): corpo JSON cru. Um novo check aborta o anterior
/// (`CANCELLED`). `req` chega como JSON e vira o pedido tipado aqui (D-R7-SN-03): campo extra →
/// `LT_INVALID_REQUEST`, antes de qualquer socket.
#[tauri::command]
pub async fn lt_check(
    state: State<'_, LtState>,
    request_id: u32,
    req: serde_json::Value,
) -> Result<String, AppError> {
    state.check(request_id, req).await
}

/// Aborta o check em voo se o id bater; senão nada.
#[tauri::command]
pub fn lt_cancel(state: State<'_, LtState>, request_id: u32) {
    state.cancel(request_id);
}

#[cfg(test)]
mod tests {
    //! Servidores HTTP/1.1 mínimos em `127.0.0.1:0`/`[::1]:0` (thread + `TcpListener`); as portas
    //! entram só aqui, por `Transport::new` com endereços de teste (o app usa `ENDPOINTS`).

    use super::*;
    use crate::ai::transport::tests::Lines;
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::thread;

    fn block<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    struct Server {
        addr: SocketAddr,
        requests: mpsc::Receiver<String>,
        accepted: Arc<AtomicUsize>,
    }

    /// Uma resposta crua por conexão (depois de `delay`); conta as conexões aceitas.
    fn serve(bind: &str, responses: Vec<Vec<u8>>, delay: Duration) -> Server {
        let listener = TcpListener::bind(bind).unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::channel();
        let counter = accepted.clone();
        thread::spawn(move || {
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                tx.send(read_request(&mut stream)).ok();
                thread::sleep(delay);
                stream.write_all(&response).ok();
                stream.flush().ok();
            }
        });
        Server {
            addr,
            requests: rx,
            accepted,
        }
    }

    /// Ouvinte que só conta conexões (proxy/destino de redirecionamento que não deve ser tocado).
    fn counting_listener() -> (SocketAddr, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = accepted.clone();
        thread::spawn(move || {
            for stream in listener.incoming() {
                if stream.is_ok() {
                    counter.fetch_add(1, Ordering::SeqCst);
                }
            }
        });
        (addr, accepted)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut data = Vec::new();
        let mut buf = [0u8; 8192];
        while let Ok(n) = stream.read(&mut buf) {
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                    })
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).to_string()
    }

    fn response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    /// Resposta em pedaços (sem `content-length`): só o corte por leitura pode recusar.
    fn chunked(body: &[u8]) -> Vec<u8> {
        let mut out =
            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
                .to_vec();
        for piece in body.chunks(64 * 1024) {
            out.extend_from_slice(format!("{:x}\r\n", piece.len()).as_bytes());
            out.extend_from_slice(piece);
            out.extend_from_slice(b"\r\n");
        }
        out.extend_from_slice(b"0\r\n\r\n");
        out
    }

    fn free_port_v4() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    }

    fn state_at(endpoints: [SocketAddr; 2], log: Arc<Lines>) -> LtState {
        LtState::with_transport(Transport::new(client(), endpoints), log)
    }

    fn request() -> serde_json::Value {
        serde_json::json!({ "language": "pt-BR", "annotation": [{ "text": "Isso é uma excessão SEGREDO." }] })
    }

    fn code(result: Result<String, AppError>) -> &'static str {
        match result {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    #[test]
    fn endpoints_are_loopback_8081_constants() {
        assert_eq!(LT_PORT, 8081);
        assert_eq!(ENDPOINTS[0].to_string(), "127.0.0.1:8081");
        assert_eq!(ENDPOINTS[1].to_string(), "[::1]:8081");
        assert!(ENDPOINTS.iter().all(|a| a.ip().is_loopback()));
        assert_eq!((PATH_LANGUAGES, PATH_CHECK), ("/v2/languages", "/v2/check"));
        assert_eq!(PROBE_TIMEOUT, Duration::from_secs(2));
        assert!(CONNECT_TIMEOUT * 2 < PROBE_TIMEOUT);
        assert_eq!(CHECK_TIMEOUT, Duration::from_secs(15));
        assert_eq!((LANGUAGES_MAX, CHECK_MAX), (256 * 1024, 2 * 1024 * 1024));
    }

    #[test]
    fn check_posts_form_to_fixed_path_and_returns_raw_body() {
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", br#"{"matches":[]}"#)],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(
            block(state.check(1, request())).unwrap(),
            r#"{"matches":[]}"#
        );
        let raw = server.requests.recv().unwrap();
        assert!(raw.starts_with("POST /v2/check HTTP/1.1\r\n"), "{raw}");
        assert!(raw.contains("content-type: application/x-www-form-urlencoded\r\n"));
        assert!(
            raw.contains("\r\n\r\nlanguage=pt-BR&data=%7B%22annotation%22"),
            "{raw}"
        );
        let lower = raw.to_ascii_lowercase();
        assert!(!lower.contains("proxy-") && !lower.contains("authorization"));
    }

    #[test]
    fn languages_gets_fixed_path() {
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", br#"[{"longCode":"pt-BR"}]"#)],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(
            block(state.languages()).unwrap(),
            r#"[{"longCode":"pt-BR"}]"#
        );
        let raw = server.requests.recv().unwrap();
        assert!(raw.starts_with("GET /v2/languages HTTP/1.1\r\n"), "{raw}");
    }

    #[test]
    fn invalid_request_opens_no_socket() {
        let (addr, accepted) = counting_listener();
        let state = state_at([addr, addr], Arc::default());
        let mut req = request();
        req["host"] = serde_json::json!("evil.example");
        assert_eq!(code(block(state.check(1, req))), "LT_INVALID_REQUEST");
        thread::sleep(Duration::from_millis(50));
        assert_eq!(accepted.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn refused_on_both_addresses() {
        let state = state_at([free_port_v4(), free_port_v4()], Arc::default());
        // Cada chamada cabe na sonda de 2 s (no Windows: 2 × 700 ms de conexão sem resposta).
        for _ in 0..2 {
            let started = Instant::now();
            assert_eq!(code(block(state.languages())), "CONNECTION_REFUSED");
            assert!(started.elapsed() < PROBE_TIMEOUT, "{:?}", started.elapsed());
        }
        assert_eq!(code(block(state.check(1, request()))), "CONNECTION_REFUSED");
    }

    #[test]
    fn falls_back_to_ipv6_when_v4_refused() {
        let Ok(probe) = TcpListener::bind("[::1]:0") else {
            eprintln!("sem ::1 neste runner: teste pulado");
            return;
        };
        drop(probe);
        let server = serve(
            "[::1]:0",
            vec![
                response("200 OK", br#"{"matches":[]}"#),
                response("200 OK", br#"{"matches":[1]}"#),
            ],
            Duration::ZERO,
        );
        let refused_v4 = free_port_v4();
        let state = state_at([refused_v4, server.addr], Arc::default());
        assert_eq!(
            block(state.check(1, request())).unwrap(),
            r#"{"matches":[]}"#
        );
        // O [::1] ficou preferido: o próximo pedido vai direto a ele.
        assert_eq!(
            block(state.check(2, request())).unwrap(),
            r#"{"matches":[1]}"#
        );
        assert_eq!(server.accepted.load(Ordering::SeqCst), 2);
    }

    /// F-04: as variáveis de proxy valem para o processo inteiro, então o caso roda num PROCESSO
    /// FILHO (o próprio binário de teste, `--exact`), com o ambiente definido só nele; nenhum outro
    /// teste em paralelo vê `HTTP_PROXY`/`ALL_PROXY`. O pai conta as conexões no "proxy".
    #[test]
    fn env_proxy_ignored() {
        let (proxy, proxied) = counting_listener();
        let proxy_url = format!("http://{proxy}");
        // Só teste: reexecuta o PRÓPRIO binário de teste com o ambiente de proxy definido só no
        // filho (nenhuma decisão de segurança depende do caminho do executável).
        // nosemgrep: rust.lang.security.current-exe.current-exe
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "languagetool::tests::env_proxy_child",
                "--exact",
                "--nocapture",
            ])
            .env("SIMPLEMD_LT_PROXY_CHILD", "1")
            .envs(["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].map(|v| (v, &proxy_url)))
            .status()
            .unwrap();
        assert!(status.success(), "processo filho falhou: {status}");
        thread::sleep(Duration::from_millis(50));
        assert_eq!(
            proxied.load(Ordering::SeqCst),
            0,
            "o proxy do ambiente foi usado"
        );
    }

    /// Metade filha de `env_proxy_ignored` (só roda com `SIMPLEMD_LT_PROXY_CHILD=1`): o cliente é
    /// montado com o proxy no ambiente e mesmo assim fala direto com o servidor.
    #[test]
    fn env_proxy_child() {
        if std::env::var("SIMPLEMD_LT_PROXY_CHILD").as_deref() != Ok("1") {
            return;
        }
        assert!(std::env::var("HTTP_PROXY").is_ok());
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", b"[]")],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(block(state.languages()).unwrap(), "[]");
        assert_eq!(server.accepted.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn redirect_not_followed_and_target_untouched() {
        let (target, touched) = counting_listener();
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nlocation: http://{target}/v2/check\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let server = serve("127.0.0.1:0", vec![redirect.into_bytes()], Duration::ZERO);
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(
            code(block(state.check(1, request()))),
            "REDIRECT_NOT_FOLLOWED"
        );
        thread::sleep(Duration::from_millis(50));
        assert_eq!(touched.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn non_200_maps_status_and_discards_body() {
        let echo = b"Erro: Isso \xc3\xa9 uma excess\xc3\xa3o SEGREDO";
        let server = serve(
            "127.0.0.1:0",
            vec![
                response("500 Internal Server Error", echo),
                response("413 Payload Too Large", b"x"),
            ],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        let error = block(state.check(1, request())).unwrap_err();
        assert_eq!(error.code, "LT_HTTP_STATUS");
        assert_eq!(error.detail, Some(serde_json::json!({ "status": 500 })));
        let wire = serde_json::to_string(&error).unwrap();
        assert!(!wire.contains("SEGREDO"), "{wire}");
        let error = block(state.check(2, request())).unwrap_err();
        assert_eq!(error.detail, Some(serde_json::json!({ "status": 413 })));
    }

    #[test]
    fn content_length_over_cap_refused_unread() {
        let head = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            CHECK_MAX + 1
        );
        let server = serve("127.0.0.1:0", vec![head.into_bytes()], Duration::ZERO);
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        let started = Instant::now();
        assert_eq!(code(block(state.check(1, request()))), "RESPONSE_TOO_LARGE");
        // Sem corpo enviado: se o transporte tentasse ler, esperaria o tempo-limite.
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn stream_over_cap_2mib_plus_1() {
        let exact = vec![b' '; CHECK_MAX];
        let over = vec![b' '; CHECK_MAX + 1];
        let server = serve(
            "127.0.0.1:0",
            vec![chunked(&exact), chunked(&over)],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(block(state.check(1, request())).unwrap().len(), CHECK_MAX);
        assert_eq!(code(block(state.check(2, request()))), "RESPONSE_TOO_LARGE");
    }

    #[test]
    fn languages_cap_256kib() {
        let server = serve(
            "127.0.0.1:0",
            vec![
                chunked(&vec![b' '; LANGUAGES_MAX]),
                chunked(&vec![b' '; LANGUAGES_MAX + 1]),
            ],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(block(state.languages()).unwrap().len(), LANGUAGES_MAX);
        assert_eq!(code(block(state.languages())), "RESPONSE_TOO_LARGE");
    }

    #[test]
    fn bad_utf8() {
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", b"{\"a\":\"\xff\"}")],
            Duration::ZERO,
        );
        let state = state_at([server.addr, free_port_v4()], Arc::default());
        assert_eq!(code(block(state.check(1, request()))), "BAD_UTF8");
    }

    #[test]
    fn timeouts_probe_and_check() {
        // Aceita e nunca responde.
        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = silent.local_addr().unwrap();
        let mut transport = Transport::new(client(), [addr, free_port_v4()]);
        transport.test_timeout = Some(Duration::from_millis(300));
        let state = LtState::with_transport(transport, Arc::new(Lines::default()));
        let started = Instant::now();
        let error = block(state.check(1, request())).unwrap_err();
        assert_eq!(error.code, "TIMEOUT");
        assert_eq!(error.detail, Some(serde_json::json!({ "seconds": 15 })));
        let error = block(state.languages()).unwrap_err();
        assert_eq!(error.detail, Some(serde_json::json!({ "seconds": 2 })));
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(silent);
    }

    #[test]
    fn latest_wins_cancels_previous() {
        let server = serve(
            "127.0.0.1:0",
            vec![
                response("200 OK", br#"{"n":1}"#),
                response("200 OK", br#"{"n":2}"#),
            ],
            Duration::from_millis(400),
        );
        let state = Arc::new(state_at([server.addr, free_port_v4()], Arc::default()));
        let first = {
            let state = state.clone();
            tauri::async_runtime::spawn(async move { state.check(1, request()).await })
        };
        thread::sleep(Duration::from_millis(100));
        let second = block(state.check(2, request()));
        let first = block(first).unwrap();
        assert_eq!(code(first), "CANCELLED");
        assert_eq!(second.unwrap(), r#"{"n":2}"#);
    }

    #[test]
    fn cancel_by_id_only_matching() {
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", br#"{"n":5}"#)],
            Duration::from_millis(400),
        );
        let state = Arc::new(state_at([server.addr, free_port_v4()], Arc::default()));
        let pending = {
            let state = state.clone();
            tauri::async_runtime::spawn(async move { state.check(5, request()).await })
        };
        thread::sleep(Duration::from_millis(100));
        state.cancel(4); // outro id: nada acontece
        assert!(state.check.lock().handle.is_some());
        state.cancel(5);
        assert_eq!(code(block(pending).unwrap()), "CANCELLED");
        assert!(state.check.lock().handle.is_none());
    }

    /// F-03: `lt_cancel(n)` que chega enquanto o `lt_check(n)` ainda valida (vaga reservada, tarefa
    /// não guardada) cancela mesmo assim: a tarefa que chega depois é devolvida para abortar.
    #[test]
    fn cancel_during_validation_still_cancels() {
        let state = state_at([free_port_v4(), free_port_v4()], Arc::default());
        state.reserve_check(5);
        state.cancel(5);
        let late = tauri::async_runtime::spawn(async {});
        assert!(
            state.store_check(5, late).is_some(),
            "a tarefa tardia deve ser abortada"
        );
        // Sem cancelamento, a tarefa do mesmo id é guardada.
        state.reserve_check(6);
        let kept = tauri::async_runtime::spawn(async {});
        assert!(state.store_check(6, kept).is_none());
        // Um check mais novo reservou a vaga: a tarefa do anterior é devolvida.
        state.reserve_check(7);
        let stale = tauri::async_runtime::spawn(async {});
        assert!(state.store_check(6, stale).is_some());
    }

    /// F-03: um check novo INVÁLIDO também aborta o anterior em voo (§1.4 "um novo check aborta o
    /// anterior") e libera a vaga.
    #[test]
    fn invalid_new_check_aborts_previous() {
        let server = serve(
            "127.0.0.1:0",
            vec![response("200 OK", br#"{"n":1}"#)],
            Duration::from_millis(400),
        );
        let state = Arc::new(state_at([server.addr, free_port_v4()], Arc::default()));
        let first = {
            let state = state.clone();
            tauri::async_runtime::spawn(async move { state.check(1, request()).await })
        };
        thread::sleep(Duration::from_millis(100));
        let mut bad = request();
        bad["host"] = serde_json::json!("evil.example");
        assert_eq!(code(block(state.check(2, bad))), "LT_INVALID_REQUEST");
        assert_eq!(code(block(first).unwrap()), "CANCELLED");
        let slot = state.check.lock();
        assert!(slot.id.is_none() && slot.handle.is_none());
    }

    #[test]
    fn log_lines_have_no_text() {
        let server = serve(
            "127.0.0.1:0",
            vec![
                response("200 OK", br#"{"matches":[{"message":"SEGREDO"}]}"#),
                response("500 Internal Server Error", b"SEGREDO"),
            ],
            Duration::ZERO,
        );
        let log = Arc::new(Lines::default());
        let state = state_at([server.addr, free_port_v4()], log.clone());
        block(state.check(1, request())).unwrap();
        block(state.check(2, request())).unwrap_err();
        let lines = log.0.lock().clone();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(
            lines[0].starts_with("lt: check 200 ") && lines[0].ends_with("ms 28u"),
            "{lines:?}"
        );
        assert!(
            lines[1].starts_with("lt: check LT_HTTP_STATUS "),
            "{lines:?}"
        );
        for line in &lines {
            assert!(
                !line.contains("SEGREDO") && !line.contains("excess") && !line.contains("pt-BR")
            );
        }
    }

    /// Fumaça contra um LanguageTool REAL em 127.0.0.1:8081 (fora da suíte padrão: só com
    /// `SIMPLEMD_LT_SMOKE=1`; o CI do Windows roda `--include-ignored`, então não é `#[ignore]`).
    #[test]
    fn real_server_smoke() {
        if std::env::var("SIMPLEMD_LT_SMOKE").as_deref() != Ok("1") {
            eprintln!("SIMPLEMD_LT_SMOKE != 1: fumaça do LanguageTool real pulada");
            return;
        }
        let log = Arc::new(Lines::default());
        let state = LtState::with_transport(Transport::new(client(), ENDPOINTS), log.clone());
        let languages = block(state.languages()).expect("GET /v2/languages");
        assert!(languages.contains("\"longCode\":\"pt-BR\""), "{languages}");
        let body = block(state.check(
            1,
            serde_json::json!({
                "language": "pt-BR",
                "annotation": [
                    { "markup": "# " },
                    { "text": "Isso é uma excessão." },
                    { "markup": "\n\n```js\nx\n```", "interpretAs": "\n\n" }
                ]
            }),
        ))
        .expect("POST /v2/check");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let matches = json["matches"].as_array().unwrap();
        assert!(!matches.is_empty(), "{body}");
        eprintln!(
            "fumaça LT: {} match(es); log: {:?}",
            matches.len(),
            log.0.lock()
        );
    }
}
