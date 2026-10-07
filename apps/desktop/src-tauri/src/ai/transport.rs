//! Transporte HTTP de IA (arch-backend r2 §1.7.2). O webview descreve o pedido (`AiRequest`); aqui
//! ele passa pela política, a chave sai do keychain por pedido (num `Zeroizing`), o cabeçalho de
//! autenticação é posto aqui e a resposta volta como eventos `head` → `chunk`… → `end` (ou
//! `error`). Sem redirecionamento, sem proxy, HTTP/1.1, TLS do sistema. Nunca registra cabeçalhos,
//! corpos nem chaves: o log é uma linha por pedido e a marca `ai:first-byte`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderName, HeaderValue, CONTENT_TYPE};
use serde::Serialize;
use zeroize::Zeroizing;

use super::keys::SecretStore;
use super::policy::{check, AiRequest, Bases, Checked, Provider};
use super::redact::redact;
use crate::error::AppError;

/// Pedidos simultâneos (anteparo): o 5º recebe `LOCAL_LIMIT`.
pub const MAX_IN_FLIGHT: usize = 4;
/// Corpo de resposta: até 8 MB (`RESPONSE_TOO_LARGE`).
pub const MAX_RESPONSE: usize = 8 * 1024 * 1024;
/// Corpo de erro (não 2xx) lido para mostrar: até 64 KB, redigido.
pub const MAX_ERROR_BODY: usize = 64 * 1024;

/// Evento enviado ao webview pelo `Channel` de `ai_send`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AiEvent {
    Head {
        status: u16,
        #[serde(rename = "contentType")]
        content_type: Option<String>,
    },
    Chunk {
        text: String,
    },
    End,
    Error {
        code: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Value>,
    },
}

/// Destino dos eventos; `false` = ninguém mais escuta (webview fechou): o pedido termina.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: AiEvent) -> bool;
}

/// Saída de log (stdout no app; captura nos testes). Recebe só linhas sem cabeçalhos nem corpos.
pub trait LogSink: Send + Sync {
    fn line(&self, line: &str);
}

pub struct StdoutLog;

impl LogSink for StdoutLog {
    fn line(&self, line: &str) {
        println!("{line}");
    }
}

/// Vaga no anteparo de pedidos simultâneos; liberada ao sair de escopo (também no cancelamento).
pub struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Pedido validado, com a chave lida e a vaga reservada.
pub struct Prepared {
    pub checked: Checked,
    pub key: Option<Zeroizing<String>>,
    /// Guardar os pedaços da resposta (só o gravador de fixtures, em debug, liga isto).
    pub collect: bool,
    _slot: Slot,
}

/// O que aconteceu com um pedido (para o gravador de fixtures; sem cabeçalhos).
#[derive(Debug, Default, Clone)]
pub struct Trace {
    pub status: Option<u16>,
    pub content_type: Option<String>,
    pub chunks: Vec<String>,
    pub error: Option<&'static str>,
}

pub struct Transport {
    client: reqwest::Client,
    keys: Arc<dyn SecretStore>,
    bases: Bases,
    log: Arc<dyn LogSink>,
    in_flight: Arc<AtomicUsize>,
    /// Tempo de espera encurtado: SÓ nos testes (o app usa o do provedor, NFR-35).
    #[cfg(test)]
    test_limit: Option<Duration>,
}

fn epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Erro de rede → código. Recusa de conexão pelo `io::ErrorKind` da cadeia; TLS pelo texto da
/// cadeia (o reqwest não expõe um tipo próprio); o resto é `NETWORK`.
fn network_error(error: &reqwest::Error) -> AppError {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    let mut tls = false;
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::ConnectionRefused {
                return AppError::new("CONNECTION_REFUSED");
            }
        }
        let text = current.to_string().to_ascii_lowercase();
        if ["tls", "certificate", "ssl", "handshake"]
            .iter()
            .any(|w| text.contains(w))
        {
            tls = true;
        }
        source = current.source();
    }
    AppError::new(if tls { "TLS" } else { "NETWORK" })
}

/// Decodificação UTF-8 incremental: guarda uma sequência partida entre pedaços.
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> Result<String, AppError> {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => {
                let text = text.to_owned();
                self.pending.clear();
                Ok(text)
            }
            Err(e) if e.error_len().is_none() => {
                let valid = e.valid_up_to();
                let text = String::from_utf8(self.pending[..valid].to_vec())
                    .map_err(|_| AppError::new("BAD_UTF8"))?;
                self.pending.drain(..valid);
                Ok(text)
            }
            Err(_) => Err(AppError::new("BAD_UTF8")),
        }
    }

    fn finish(&self) -> Result<(), AppError> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err(AppError::new("BAD_UTF8"))
        }
    }
}

enum Flow {
    Continue,
    /// O receptor sumiu: parar sem mais eventos.
    Stop,
}

impl Transport {
    pub fn new(keys: Arc<dyn SecretStore>) -> Self {
        Self::build(keys, Bases::default(), Arc::new(StdoutLog))
    }

    /// Bases de nuvem trocadas por um servidor local: SÓ nos testes (o app usa as constantes).
    #[cfg(test)]
    pub fn with_bases(keys: Arc<dyn SecretStore>, bases: Bases, log: Arc<dyn LogSink>) -> Self {
        Self::build(keys, bases, log)
    }

    fn build(keys: Arc<dyn SecretStore>, bases: Bases, log: Arc<dyn LogSink>) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .http1_only()
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!("simpleMD/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("cliente HTTP da IA");
        Self {
            client,
            keys,
            bases,
            log,
            in_flight: Arc::new(AtomicUsize::new(0)),
            #[cfg(test)]
            test_limit: None,
        }
    }

    /// Espera pelo primeiro byte e entre pedaços.
    fn limit(&self, provider: Provider) -> Duration {
        #[cfg(test)]
        if let Some(limit) = self.test_limit {
            return limit;
        }
        provider.timeout()
    }

    /// Política, vaga e chave (lida do keychain agora, nunca guardada). Nada sai pela rede aqui.
    pub fn prepare(&self, req: &AiRequest) -> Result<Prepared, AppError> {
        let checked = check(req, &self.bases)?;
        let taken = self.in_flight.fetch_add(1, Ordering::SeqCst);
        let slot = Slot(self.in_flight.clone());
        if taken >= MAX_IN_FLIGHT {
            return Err(AppError::new("LOCAL_LIMIT"));
        }
        let key = match checked.provider.account() {
            Some(account) => Some(
                self.keys
                    .get(account)?
                    .ok_or_else(|| AppError::new("KEY_MISSING"))?,
            ),
            None => None,
        };
        Ok(Prepared {
            checked,
            key,
            collect: false,
            _slot: slot,
        })
    }

    /// Executa o pedido e emite os eventos. Erros viram um evento `error` redigido.
    pub async fn run(&self, prepared: Prepared, sink: &dyn EventSink) -> Trace {
        let started = Instant::now();
        let mut trace = Trace::default();
        let checked = &prepared.checked;
        let key = prepared.key.as_deref().map(String::as_str);
        let outcome = self.exchange(&prepared, sink, &mut trace).await;
        let elapsed = started.elapsed().as_millis();
        let label = format!(
            "ai: {} {} {}",
            checked.provider.name(),
            checked.method,
            checked.path
        );
        match outcome {
            Ok(()) => {
                let status = trace
                    .status
                    .map_or_else(|| "-".to_owned(), |s| s.to_string());
                self.log.line(&format!("{label} -> {status} {elapsed}ms"));
            }
            Err(error) => {
                self.log
                    .line(&format!("{label} -> {} {elapsed}ms", error.code));
                trace.error = Some(error.code);
                sink.emit(AiEvent::Error {
                    code: error.code,
                    message: redact(error.message, key),
                    detail: error.detail,
                });
            }
        }
        trace
    }

    fn request(&self, prepared: &Prepared) -> Result<reqwest::Request, AppError> {
        let checked = &prepared.checked;
        let method = reqwest::Method::from_bytes(checked.method.as_bytes())
            .map_err(|_| AppError::new("PATH_NOT_ALLOWED"))?;
        let mut builder = self.client.request(method, checked.url());
        for (name, value) in &checked.headers {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| AppError::new("HEADER_NOT_ALLOWED"))?;
            let value =
                HeaderValue::from_str(value).map_err(|_| AppError::new("HEADER_NOT_ALLOWED"))?;
            builder = builder.header(name, value);
        }
        if let Some(key) = &prepared.key {
            let (name, value) = match checked.provider {
                Provider::Openai => ("authorization", Zeroizing::new(format!("Bearer {}", **key))),
                _ => ("x-api-key", Zeroizing::new(key.to_string())),
            };
            let mut header =
                HeaderValue::from_str(&value).map_err(|_| AppError::new("KEY_MISSING"))?;
            header.set_sensitive(true);
            builder = builder.header(name, header);
        }
        if let Some(body) = &checked.body {
            builder = builder.body(body.clone());
        }
        builder.build().map_err(|_| AppError::new("NETWORK"))
    }

    async fn exchange(
        &self,
        prepared: &Prepared,
        sink: &dyn EventSink,
        trace: &mut Trace,
    ) -> Result<(), AppError> {
        let provider = prepared.checked.provider;
        let limit = self.limit(provider);
        let request = self.request(prepared)?;
        let first_byte = async {
            let mut response = self
                .client
                .execute(request)
                .await
                .map_err(|e| network_error(&e))?;
            let first = response.chunk().await.map_err(|e| network_error(&e))?;
            Ok::<_, AppError>((response, first))
        };
        let (mut response, first) =
            tokio::time::timeout(limit, first_byte)
                .await
                .map_err(|_| {
                    AppError::new("TIMEOUT_FIRST_BYTE")
                        .with_detail(serde_json::json!({ "seconds": provider.timeout().as_secs() }))
                })??;
        let status = response.status();
        trace.status = Some(status.as_u16());
        if status.is_redirection() {
            return Err(AppError::new("REDIRECT_NOT_FOLLOWED"));
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        trace.content_type = content_type.clone();
        if !sink.emit(AiEvent::Head {
            status: status.as_u16(),
            content_type,
        }) {
            return Ok(());
        }
        let key = prepared.key.as_deref().map(String::as_str);
        let mut next = first;
        let mut decoder = Utf8Decoder::default();
        let mut total = 0usize;
        if !status.is_success() {
            // Corpo de erro: até 64 KB, decodificado com perda e redigido antes de sair daqui.
            let mut body = Vec::new();
            while let Some(bytes) = next {
                let room = MAX_ERROR_BODY.saturating_sub(body.len());
                body.extend_from_slice(&bytes[..bytes.len().min(room)]);
                if body.len() >= MAX_ERROR_BODY {
                    break;
                }
                next = tokio::time::timeout(limit, response.chunk())
                    .await
                    .map_err(|_| AppError::new("TIMEOUT_IDLE"))?
                    .map_err(|e| network_error(&e))?;
            }
            let text = redact(&String::from_utf8_lossy(&body), key);
            if prepared.collect {
                trace.chunks.push(text.clone());
            }
            if !text.is_empty() && !sink.emit(AiEvent::Chunk { text }) {
                return Ok(());
            }
            sink.emit(AiEvent::End);
            return Ok(());
        }
        let mut marked = false;
        while let Some(bytes) = next {
            total += bytes.len();
            if total > MAX_RESPONSE {
                return Err(AppError::new("RESPONSE_TOO_LARGE"));
            }
            let text = decoder.push(&bytes)?;
            if !text.is_empty() {
                if !marked {
                    marked = true;
                    self.log.line(&format!("ai:first-byte {}", epoch_ms()));
                }
                if prepared.collect {
                    trace.chunks.push(redact(&text, key));
                }
                if let Flow::Stop = emit_chunk(sink, text) {
                    return Ok(());
                }
            }
            next = tokio::time::timeout(limit, response.chunk())
                .await
                .map_err(|_| AppError::new("TIMEOUT_IDLE"))?
                .map_err(|e| network_error(&e))?;
        }
        decoder.finish()?;
        sink.emit(AiEvent::End);
        Ok(())
    }
}

fn emit_chunk(sink: &dyn EventSink, text: String) -> Flow {
    if sink.emit(AiEvent::Chunk { text }) {
        Flow::Continue
    } else {
        Flow::Stop
    }
}

#[cfg(test)]
pub mod tests {
    //! Servidor HTTP/1.1 mínimo em `127.0.0.1:<aleatória>` (thread + `TcpListener`), sem crates
    //! extras: cada teste escreve a resposta crua e lê o pedido cru que chegou.

    use super::*;
    use crate::ai::keys::MemoryStore;
    use parking_lot::Mutex;
    use std::collections::BTreeMap;
    use std::future::Future;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[derive(Default)]
    pub struct Collect {
        pub events: Mutex<Vec<AiEvent>>,
        /// Depois de N eventos, finge que o webview fechou.
        pub stop_after: Option<usize>,
    }

    impl EventSink for Collect {
        fn emit(&self, event: AiEvent) -> bool {
            let mut events = self.events.lock();
            events.push(event);
            self.stop_after.is_none_or(|n| events.len() < n)
        }
    }

    #[derive(Default)]
    pub struct Lines(pub Mutex<Vec<String>>);

    impl LogSink for Lines {
        fn line(&self, line: &str) {
            self.0.lock().push(line.to_owned());
        }
    }

    /// Uma resposta por conexão aceita; devolve a porta e o canal dos pedidos crus recebidos.
    pub fn serve(
        responses: Vec<Vec<Vec<u8>>>,
        pause: Duration,
    ) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            for parts in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                tx.send(read_request(&mut stream)).ok();
                for (i, part) in parts.iter().enumerate() {
                    if i > 0 {
                        thread::sleep(pause);
                    }
                    if stream.write_all(part).is_err() {
                        break;
                    }
                    stream.flush().ok();
                }
            }
        });
        (port, rx)
    }

    fn read_request(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
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
                        let lower = l.to_ascii_lowercase();
                        lower
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

    pub fn head(status: &str, content_type: &str, extra: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ntransfer-encoding: chunked\r\nconnection: close\r\n{extra}\r\n"
        )
        .into_bytes()
    }

    pub fn chunk(text: &str) -> Vec<u8> {
        let mut out = format!("{:x}\r\n", text.len()).into_bytes();
        out.extend_from_slice(text.as_bytes());
        out.extend_from_slice(b"\r\n");
        out
    }

    pub fn last() -> Vec<u8> {
        b"0\r\n\r\n".to_vec()
    }

    pub fn transport_at(port: u16, store: Arc<MemoryStore>, log: Arc<Lines>) -> Transport {
        let base = format!("http://127.0.0.1:{port}");
        Transport::with_bases(
            store,
            Bases {
                openai: base.clone(),
                anthropic: base,
            },
            log,
        )
    }

    pub fn request(provider: Provider, method: &str, path: &str, body: Option<&str>) -> AiRequest {
        AiRequest {
            provider,
            method: method.into(),
            path: path.into(),
            headers: BTreeMap::from([("content-type".to_owned(), "application/json".to_owned())]),
            body: body.map(str::to_owned),
            base_url: None,
        }
    }

    fn block<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    fn canary() -> String {
        let mut random = [0u8; 6];
        getrandom::fill(&mut random).unwrap();
        let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
        format!("sk-test-CANARY-{hex}")
    }

    /// AC-11.6 (RUST) + AC-11.7: a canária só chega ao servidor no cabeçalho de autenticação; o
    /// eco dela num corpo de erro sai redigido; o log não tem cabeçalho, corpo nem canária.
    #[test]
    fn canary_never_leaves_native() {
        let key = canary();
        let error_body = format!(
            r#"{{"error":{{"message":"Incorrect API key provided: {key}. Also sk-proj-abcd1234wxyz and sk-ant-api03-zzzz."}}}}"#
        );
        let mut parts = vec![head("401 Unauthorized", "application/json", "")];
        parts.push(chunk(&error_body));
        parts.push(last());
        let (port, requests) = serve(vec![parts], Duration::ZERO);
        let store = Arc::new(MemoryStore::default());
        store.set("ai.openai", &key).unwrap();
        let log = Arc::new(Lines::default());
        let transport = transport_at(port, store, log.clone());
        let sink = Collect::default();
        let prepared = transport
            .prepare(&request(Provider::Openai, "GET", "/v1/models", None))
            .unwrap();
        block(transport.run(prepared, &sink));
        let raw = requests.recv().unwrap();
        // Só no cabeçalho de autenticação, exatamente uma vez.
        assert_eq!(raw.matches(&key).count(), 1, "{raw}");
        assert!(
            raw.contains(&format!("authorization: Bearer {key}\r\n")),
            "{raw}"
        );
        let events = sink.events.lock().clone();
        assert_eq!(
            events[0],
            AiEvent::Head {
                status: 401,
                content_type: Some("application/json".into())
            }
        );
        let AiEvent::Chunk { text } = &events[1] else {
            panic!("{events:?}")
        };
        assert!(!text.contains("CANARY"), "{text}");
        assert!(
            !text.contains("sk-proj") && !text.contains("sk-ant"),
            "{text}"
        );
        assert_eq!(text.matches("[chave redigida]").count(), 3, "{text}");
        assert_eq!(events[2], AiEvent::End);
        let lines = log.0.lock().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].starts_with("ai: openai GET /v1/models -> 401 "),
            "{lines:?}"
        );
        for line in &lines {
            assert!(
                !line.contains("CANARY") && !line.to_ascii_lowercase().contains("authorization")
            );
        }
    }

    #[test]
    fn anthropic_key_goes_in_x_api_key_and_ollama_sends_none() {
        let key = canary();
        let ok = vec![
            head("200 OK", "application/json", ""),
            chunk(r#"{"data":[]}"#),
            last(),
        ];
        let (port, requests) = serve(vec![ok.clone()], Duration::ZERO);
        let store = Arc::new(MemoryStore::default());
        store.set("ai.anthropic", &key).unwrap();
        let transport = transport_at(port, store.clone(), Arc::new(Lines::default()));
        let mut req = request(Provider::Anthropic, "GET", "/v1/models?limit=1000", None);
        req.headers
            .insert("anthropic-version".into(), "2023-06-01".into());
        let sink = Collect::default();
        block(transport.run(transport.prepare(&req).unwrap(), &sink));
        let raw = requests.recv().unwrap();
        assert!(raw.contains(&format!("x-api-key: {key}\r\n")), "{raw}");
        assert!(!raw.to_ascii_lowercase().contains("authorization"), "{raw}");
        assert!(raw.contains("anthropic-version: 2023-06-01\r\n"));

        let (port, requests) = serve(vec![ok], Duration::ZERO);
        let mut ollama = request(Provider::Ollama, "GET", "/api/tags", None);
        ollama.base_url = Some(format!("http://localhost:{port}"));
        let sink = Collect::default();
        block(transport.run(transport.prepare(&ollama).unwrap(), &sink));
        let raw = requests.recv().unwrap();
        assert!(!raw.contains(&key) && !raw.contains("x-api-key"), "{raw}");
        assert!(raw.starts_with("GET /api/tags HTTP/1.1\r\n"), "{raw}");
    }

    #[test]
    fn missing_key_sends_nothing() {
        let transport = transport_at(1, Arc::new(MemoryStore::default()), Arc::default());
        let error = transport
            .prepare(&request(Provider::Openai, "GET", "/v1/models", None))
            .err()
            .unwrap();
        assert_eq!(error.code, "KEY_MISSING");
        // A vaga voltou: 4 pedidos seguidos do Ollama cabem.
        let held: Vec<_> = (0..MAX_IN_FLIGHT)
            .map(|_| {
                transport
                    .prepare(&request(Provider::Ollama, "GET", "/api/tags", None))
                    .unwrap()
            })
            .collect();
        let fifth = transport
            .prepare(&request(Provider::Ollama, "GET", "/api/tags", None))
            .err()
            .unwrap();
        assert_eq!(fifth.code, "LOCAL_LIMIT");
        drop(held);
        assert!(transport
            .prepare(&request(Provider::Ollama, "GET", "/api/tags", None))
            .is_ok());
    }

    /// AC-11.8: um 302 de um host permitido para outro host não é seguido.
    #[test]
    fn redirect_is_not_followed() {
        let parts = vec![
            b"HTTP/1.1 302 Found\r\nlocation: https://evil.example/steal\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_vec(),
        ];
        let (port, requests) = serve(vec![parts], Duration::ZERO);
        let store = Arc::new(MemoryStore::default());
        store.set("ai.openai", &canary()).unwrap();
        let transport = transport_at(port, store, Arc::default());
        let sink = Collect::default();
        let trace = block(
            transport.run(
                transport
                    .prepare(&request(Provider::Openai, "GET", "/v1/models", None))
                    .unwrap(),
                &sink,
            ),
        );
        requests.recv().unwrap();
        assert_eq!(trace.error, Some("REDIRECT_NOT_FOLLOWED"));
        let events = sink.events.lock();
        assert!(matches!(
            events.as_slice(),
            [AiEvent::Error {
                code: "REDIRECT_NOT_FOLLOWED",
                ..
            }]
        ));
        // Uma só conexão aceita: o destino do redirecionamento nunca foi pedido.
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn streams_chunks_in_order_and_keeps_split_utf8() {
        let mut parts = vec![head("200 OK", "application/x-ndjson", "")];
        let text = "{\"message\":{\"content\":\"ação\"},\"done\":false}\n";
        let bytes = text.as_bytes();
        let cut = text.find("çã").unwrap() + 1; // no meio do "ç"
        let mut first = format!("{:x}\r\n", cut).into_bytes();
        first.extend_from_slice(&bytes[..cut]);
        first.extend_from_slice(b"\r\n");
        let mut second = format!("{:x}\r\n", bytes.len() - cut).into_bytes();
        second.extend_from_slice(&bytes[cut..]);
        second.extend_from_slice(b"\r\n");
        parts.push(first);
        parts.push(second);
        parts.push(chunk("{\"done\":true}\n"));
        parts.push(last());
        let (port, _requests) = serve(vec![parts], Duration::from_millis(20));
        let log = Arc::new(Lines::default());
        let transport = transport_at(1, Arc::new(MemoryStore::default()), log.clone());
        let mut req = request(Provider::Ollama, "POST", "/api/chat", Some("{}"));
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let sink = Collect::default();
        block(transport.run(transport.prepare(&req).unwrap(), &sink));
        let events = sink.events.lock().clone();
        let joined: String = events
            .iter()
            .filter_map(|e| match e {
                AiEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(joined, format!("{text}{{\"done\":true}}\n"));
        assert!(events.len() >= 4, "{events:?}");
        assert_eq!(events.last(), Some(&AiEvent::End));
        let lines = log.0.lock().clone();
        assert!(
            lines.iter().any(|l| l.starts_with("ai:first-byte ")),
            "{lines:?}"
        );
    }

    #[test]
    fn first_byte_timeout_and_refused_connection() {
        // Porta sem ninguém escutando → CONNECTION_REFUSED.
        let free = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = free.local_addr().unwrap().port();
        drop(free);
        let transport = transport_at(1, Arc::new(MemoryStore::default()), Arc::default());
        let mut req = request(Provider::Ollama, "GET", "/api/tags", None);
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let sink = Collect::default();
        let trace = block(transport.run(transport.prepare(&req).unwrap(), &sink));
        assert_eq!(trace.error, Some("CONNECTION_REFUSED"));

        // Servidor que aceita e não responde: espera encurtada só neste teste.
        let silent = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = silent.local_addr().unwrap().port();
        let mut req = request(Provider::Ollama, "GET", "/api/tags", None);
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let mut transport = transport;
        transport.test_limit = Some(Duration::from_millis(300));
        let sink = Collect::default();
        let started = Instant::now();
        let trace = block(transport.run(transport.prepare(&req).unwrap(), &sink));
        assert!(started.elapsed() < Duration::from_secs(5));
        drop(silent);
        assert_eq!(trace.error, Some("TIMEOUT_FIRST_BYTE"));
        let events = sink.events.lock();
        let AiEvent::Error { detail, .. } = &events[0] else {
            panic!("{events:?}")
        };
        assert_eq!(detail, &Some(serde_json::json!({ "seconds": 120 })));
    }

    #[test]
    fn stops_when_the_webview_is_gone() {
        let mut parts = vec![head("200 OK", "text/event-stream", "")];
        for i in 0..10 {
            parts.push(chunk(&format!("data: {i}\n\n")));
        }
        parts.push(last());
        let (port, _requests) = serve(vec![parts], Duration::from_millis(5));
        let transport = transport_at(1, Arc::new(MemoryStore::default()), Arc::default());
        let mut req = request(Provider::Ollama, "POST", "/api/chat", Some("{}"));
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let sink = Collect {
            stop_after: Some(3),
            ..Default::default()
        };
        block(transport.run(transport.prepare(&req).unwrap(), &sink));
        assert_eq!(sink.events.lock().len(), 3);
    }

    /// AC-11.7: dez pedidos → o log tem 10 linhas e nenhuma traz cabeçalho, corpo ou chave.
    #[test]
    fn ten_requests_log_zero_headers() {
        let key = canary();
        let ok = vec![
            head("200 OK", "application/json", "x-request-id: abc\r\n"),
            chunk(r#"{"data":[{"id":"gpt-x"}]}"#),
            last(),
        ];
        let (port, _requests) = serve(vec![ok; 10], Duration::ZERO);
        let store = Arc::new(MemoryStore::default());
        store.set("ai.openai", &key).unwrap();
        let log = Arc::new(Lines::default());
        let transport = transport_at(port, store, log.clone());
        for _ in 0..10 {
            let sink = Collect::default();
            block(
                transport.run(
                    transport
                        .prepare(&request(Provider::Openai, "GET", "/v1/models", None))
                        .unwrap(),
                    &sink,
                ),
            );
        }
        let lines = log.0.lock().clone();
        let requests: Vec<_> = lines.iter().filter(|l| l.starts_with("ai: ")).collect();
        assert_eq!(requests.len(), 10, "{lines:?}");
        for line in &lines {
            let lower = line.to_ascii_lowercase();
            for banned in [
                "authorization",
                "bearer",
                "x-api-key",
                "content-type",
                "x-request-id",
                "gpt-x",
            ] {
                assert!(!lower.contains(banned), "{line}");
            }
            assert!(!line.contains(&key));
        }
    }

    #[test]
    fn response_cap_and_error_body_cap() {
        let mut parts = vec![head("500 Internal Server Error", "text/plain", "")];
        let big = "e".repeat(40 * 1024);
        parts.push(chunk(&big));
        parts.push(chunk(&big));
        parts.push(last());
        let (port, _requests) = serve(vec![parts], Duration::ZERO);
        let transport = transport_at(1, Arc::new(MemoryStore::default()), Arc::default());
        let mut req = request(Provider::Ollama, "POST", "/api/chat", Some("{}"));
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let sink = Collect::default();
        block(transport.run(transport.prepare(&req).unwrap(), &sink));
        let events = sink.events.lock();
        let AiEvent::Chunk { text } = &events[1] else {
            panic!()
        };
        assert_eq!(text.len(), MAX_ERROR_BODY);
        assert_eq!(events.last(), Some(&AiEvent::End));
    }

    #[test]
    fn invalid_utf8_is_an_error() {
        let mut parts = vec![head("200 OK", "text/plain", "")];
        let mut bad = b"3\r\n".to_vec();
        bad.extend_from_slice(&[b'a', 0xff, b'b']);
        bad.extend_from_slice(b"\r\n");
        parts.push(bad);
        parts.push(last());
        let (port, _requests) = serve(vec![parts], Duration::ZERO);
        let transport = transport_at(1, Arc::new(MemoryStore::default()), Arc::default());
        let mut req = request(Provider::Ollama, "POST", "/api/chat", Some("{}"));
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let sink = Collect::default();
        let trace = block(transport.run(transport.prepare(&req).unwrap(), &sink));
        assert_eq!(trace.error, Some("BAD_UTF8"));
    }

    #[test]
    fn event_wire_format() {
        let head = serde_json::to_value(AiEvent::Head {
            status: 200,
            content_type: Some("text/event-stream".into()),
        })
        .unwrap();
        assert_eq!(
            head,
            serde_json::json!({ "kind": "head", "status": 200, "contentType": "text/event-stream" })
        );
        assert_eq!(
            serde_json::to_value(AiEvent::End).unwrap(),
            serde_json::json!({ "kind": "end" })
        );
        assert_eq!(
            serde_json::to_value(AiEvent::Chunk { text: "a".into() }).unwrap(),
            serde_json::json!({ "kind": "chunk", "text": "a" })
        );
    }

    /// AC-11.3 (RUST): abortar a tarefa (o que `ai_cancel` faz) solta a conexão e a vaga em
    /// ≤ 300 ms, e nenhum evento chega depois.
    #[test]
    fn abort_ends_the_request_within_300ms() {
        let mut parts = vec![head("200 OK", "application/x-ndjson", "")];
        for i in 0..100 {
            parts.push(chunk(&format!(
                "{{\"message\":{{\"content\":\"{i} \"}},\"done\":false}}\n"
            )));
        }
        parts.push(last());
        let (port, _requests) = serve(vec![parts], Duration::from_millis(20));
        let transport = Arc::new(transport_at(
            1,
            Arc::new(MemoryStore::default()),
            Arc::default(),
        ));
        let mut req = request(Provider::Ollama, "POST", "/api/chat", Some("{}"));
        req.base_url = Some(format!("http://127.0.0.1:{port}"));
        let prepared = transport.prepare(&req).unwrap();
        let sink = Arc::new(Collect::default());
        let (task_transport, task_sink) = (transport.clone(), sink.clone());
        let handle = tauri::async_runtime::spawn(async move {
            task_transport.run(prepared, task_sink.as_ref()).await;
        });
        let waited = Instant::now();
        while sink.events.lock().len() < 3 {
            assert!(
                waited.elapsed() < Duration::from_secs(10),
                "o fluxo não começou"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        handle.abort();
        while transport.in_flight.load(Ordering::SeqCst) != 0 {
            assert!(
                started.elapsed() < Duration::from_millis(300),
                "a vaga não voltou"
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        let seen = sink.events.lock().len();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(
            sink.events.lock().len(),
            seen,
            "evento depois do cancelamento"
        );
        assert!(!sink.events.lock().contains(&AiEvent::End));
    }
}
