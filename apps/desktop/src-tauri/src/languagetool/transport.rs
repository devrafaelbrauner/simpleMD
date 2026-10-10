//! Cliente HTTP do LanguageTool local (r7 arch-backend §1.4). Só os endereços constantes de
//! `super::ENDPOINTS` (literais IP, sem DNS), só `GET /v2/languages` e `POST /v2/check`, sem
//! redirecionamento, sem proxy, sem TLS; um tempo-limite TOTAL por chamada (conectar + enviar + ler,
//! as duas tentativas incluídas) e leitura limitada (para em teto + 1). 0 novas tentativas aqui: a
//! agenda de novas tentativas é do plugin (R-I8.7). O corpo de erro nunca sai daqui (pode ecoar o
//! texto da nota).

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use bytes::Bytes;
use reqwest::header::CONTENT_LENGTH;
use reqwest::Method;

use crate::ai::transport::network_error;
use crate::error::AppError;

/// Corpo de `/v2/languages`.
pub const LANGUAGES_MAX: usize = 256 * 1024;
/// Corpo de `/v2/check`.
pub const CHECK_MAX: usize = 2 * 1024 * 1024;
/// Corpo de erro lido (e descartado) antes de fechar.
pub const ERROR_BODY_MAX: usize = 64 * 1024;
/// Sonda: 2 s no total (NFR-51).
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
/// Verificação: 15 s no total (NFR-51).
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

/// Uma chamada: método e caminho fixos, corpo opcional (já montado pela política), teto da resposta.
pub struct Call {
    pub method: Method,
    pub path: &'static str,
    /// `Bytes`: o recuo para `[::1]` reusa o mesmo corpo (≤ 1 MiB) sem copiar (F-10).
    pub body: Option<Bytes>,
    pub cap: usize,
    pub timeout: Duration,
}

pub struct Transport {
    client: reqwest::Client,
    endpoints: [SocketAddr; 2],
    /// Índice do endereço que funcionou por último (preferido na sessão; OQ-B9).
    preferred: AtomicU8,
    /// Tempo-limite encurtado: SÓ nos testes (o app usa 2 s/15 s).
    #[cfg(test)]
    pub(super) test_timeout: Option<Duration>,
}

impl Transport {
    pub fn new(client: reqwest::Client, endpoints: [SocketAddr; 2]) -> Self {
        Self {
            client,
            endpoints,
            preferred: AtomicU8::new(0),
            #[cfg(test)]
            test_timeout: None,
        }
    }

    /// Executa a chamada dentro do tempo-limite total. Estouro → `TIMEOUT` com `{seconds}` do
    /// limite de produção.
    pub async fn run(&self, call: Call) -> Result<String, AppError> {
        #[cfg(test)]
        let limit = self.test_timeout.unwrap_or(call.timeout);
        #[cfg(not(test))]
        let limit = call.timeout;
        let seconds = call.timeout.as_secs();
        tokio::time::timeout(limit, self.attempts(&call))
            .await
            .unwrap_or_else(|_| {
                Err(AppError::new("TIMEOUT").with_detail(serde_json::json!({ "seconds": seconds })))
            })
    }

    /// O endereço preferido primeiro; o outro só se o primeiro recusar a conexão.
    async fn attempts(&self, call: &Call) -> Result<String, AppError> {
        let first = usize::from(self.preferred.load(Ordering::Relaxed) & 1);
        let order = [first, 1 - first];
        let mut last = AppError::new("CONNECTION_REFUSED");
        for index in order {
            match self.exchange(self.endpoints[index], call).await {
                Err(error) if error.code == "CONNECTION_REFUSED" => last = error,
                result => {
                    if result.is_ok() {
                        self.preferred.store(index as u8, Ordering::Relaxed);
                    }
                    return result;
                }
            }
        }
        Err(last)
    }

    async fn exchange(&self, addr: SocketAddr, call: &Call) -> Result<String, AppError> {
        // Montada das constantes: `http://127.0.0.1:8081/v2/check` ou `http://[::1]:8081/…`.
        let url = format!("http://{addr}{}", call.path);
        let mut builder = self.client.request(call.method.clone(), url);
        if let Some(body) = &call.body {
            builder = builder
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body.clone());
        }
        let mut response = builder.send().await.map_err(|e| send_error(&e))?;
        let status = response.status();
        if status.is_redirection() {
            return Err(AppError::new("REDIRECT_NOT_FOLLOWED"));
        }
        let declared = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        if declared.is_some_and(|n| n > call.cap as u64) {
            return Err(AppError::new("RESPONSE_TOO_LARGE"));
        }
        if status != reqwest::StatusCode::OK {
            // Lido até 64 KiB e descartado: nunca devolvido nem registrado.
            let mut read = 0usize;
            while read < ERROR_BODY_MAX {
                match response.chunk().await {
                    Ok(Some(bytes)) => read += bytes.len(),
                    _ => break,
                }
            }
            return Err(AppError::new("LT_HTTP_STATUS")
                .with_detail(serde_json::json!({ "status": status.as_u16() })));
        }
        let mut body = Vec::new();
        while let Some(bytes) = response.chunk().await.map_err(|e| network_error(&e))? {
            if body.len() + bytes.len() > call.cap {
                return Err(AppError::new("RESPONSE_TOO_LARGE"));
            }
            body.extend_from_slice(&bytes);
        }
        String::from_utf8(body).map_err(|_| AppError::new("BAD_UTF8"))
    }
}

/// Erro ao enviar → código. No Windows, uma porta de loopback sem ninguém escutando não recusa na
/// hora (o TCP repete o SYN por ~2 s), e o `connect_timeout` vence antes. Nestes endereços fixos de
/// loopback, um servidor real aceita em < 1 ms; então um tempo-limite na CONEXÃO quer dizer
/// "ninguém escutando" → `CONNECTION_REFUSED`, o que mantém o recuo para `[::1]` (D-R7-SN-14).
/// O resto segue a classificação comum (`ai::transport::network_error`).
fn send_error(error: &reqwest::Error) -> AppError {
    if error.is_connect() && error.is_timeout() {
        AppError::new("CONNECTION_REFUSED")
    } else {
        network_error(error)
    }
}
