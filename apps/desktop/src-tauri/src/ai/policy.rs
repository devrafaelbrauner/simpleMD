//! Política do transporte de IA (R-11.5, AC-11.8; arch-backend r2 §1.7.2): tudo é recusado ANTES
//! de abrir um socket. Hosts fixos para OpenAI e Anthropic (só `https`); para o Ollama, só um
//! endereço `http` de loopback. Lista exata de (método, caminho) por provedor; cabeçalhos vindos do
//! webview só entre `content-type`, `accept` e `anthropic-version` (autenticação nunca vem dele).

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Deserialize;

use crate::error::AppError;

pub const OPENAI_BASE: &str = "https://api.openai.com";
pub const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
pub const OLLAMA_DEFAULT: &str = "http://127.0.0.1:11434";
/// Corpo do pedido: até 4 MB.
pub const MAX_BODY: usize = 4 * 1024 * 1024;
const HEADERS_ALLOWED: [&str; 3] = ["content-type", "accept", "anthropic-version"];
const MAX_HEADER_VALUE: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Openai,
    Anthropic,
    Ollama,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Provider::Openai => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Ollama => "ollama",
        }
    }

    /// Conta do keychain (`ai.openai`, `ai.anthropic`); o Ollama não usa chave.
    pub fn account(self) -> Option<&'static str> {
        match self {
            Provider::Openai => Some("ai.openai"),
            Provider::Anthropic => Some("ai.anthropic"),
            Provider::Ollama => None,
        }
    }

    /// Primeiro byte (e intervalo entre pedaços): 60 s na nuvem, 120 s no Ollama (NFR-35).
    pub fn timeout(self) -> Duration {
        Duration::from_secs(match self {
            Provider::Ollama => 120,
            _ => 60,
        })
    }

    fn routes(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Provider::Openai => &[("GET", "/v1/models"), ("POST", "/v1/chat/completions")],
            Provider::Anthropic => &[("GET", "/v1/models?limit=1000"), ("POST", "/v1/messages")],
            Provider::Ollama => &[("GET", "/api/tags"), ("POST", "/api/chat")],
        }
    }
}

/// Pedido como o webview o descreve (`packages/ai` `AiHttpRequest`). Sem campo de autenticação.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiRequest {
    pub provider: Provider,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

/// Pedido aprovado pela política: URL final, cabeçalhos permitidos e corpo.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub provider: Provider,
    pub method: &'static str,
    pub path: &'static str,
    pub base: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl Checked {
    pub fn url(&self) -> String {
        format!("{}{}", self.base, self.path)
    }
}

/// Bases dos provedores de nuvem: as constantes no app; um servidor local só nos testes.
#[derive(Debug, Clone)]
pub struct Bases {
    pub openai: String,
    pub anthropic: String,
}

impl Default for Bases {
    fn default() -> Self {
        Self {
            openai: OPENAI_BASE.to_owned(),
            anthropic: ANTHROPIC_BASE.to_owned(),
        }
    }
}

/// Endereço do Ollama: `http://` + host de loopback (`127.0.0.1`, `localhost`, `[::1]`) + porta
/// opcional; sem usuário, caminho (só `/` final), consulta nem fragmento. Devolve a origem normal.
pub fn ollama_origin(input: &str) -> Option<String> {
    let rest = input.strip_prefix("http://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty()
        || rest.contains(['/', '?', '#', '@', '\\'])
        || rest.contains(char::is_whitespace)
    {
        return None;
    }
    let (host, port) = if let Some(after) = rest.strip_prefix("[::1]") {
        ("[::1]", after)
    } else {
        match rest.find(':') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, ""),
        }
    };
    let host = host.to_ascii_lowercase();
    if !matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return None;
    }
    let port = match port.strip_prefix(':') {
        Some(digits) => {
            if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            let value: u32 = digits.parse().ok()?;
            if value == 0 || value > 65_535 {
                return None;
            }
            format!(":{value}")
        }
        None if port.is_empty() => String::new(),
        None => return None,
    };
    Some(format!("http://{host}{port}"))
}

/// Valida o pedido contra a política (AC-11.8). Nenhum socket é aberto antes disto.
pub fn check(req: &AiRequest, bases: &Bases) -> Result<Checked, AppError> {
    let base = match req.provider {
        Provider::Openai | Provider::Anthropic => {
            if req.base_url.is_some() {
                return Err(AppError::new("HOST_NOT_ALLOWED"));
            }
            if req.provider == Provider::Openai {
                bases.openai.clone()
            } else {
                bases.anthropic.clone()
            }
        }
        Provider::Ollama => match &req.base_url {
            None => OLLAMA_DEFAULT.to_owned(),
            Some(url) => ollama_origin(url).ok_or_else(|| AppError::new("HOST_NOT_ALLOWED"))?,
        },
    };
    let (method, path) = req
        .provider
        .routes()
        .iter()
        .find(|(m, p)| *m == req.method && *p == req.path)
        .copied()
        .ok_or_else(|| AppError::new("PATH_NOT_ALLOWED"))?;
    let mut headers = Vec::with_capacity(req.headers.len());
    for (name, value) in &req.headers {
        let lower = name.to_ascii_lowercase();
        if !HEADERS_ALLOWED.contains(&lower.as_str())
            || value.len() > MAX_HEADER_VALUE
            || value.contains(['\r', '\n'])
        {
            return Err(AppError::new("HEADER_NOT_ALLOWED"));
        }
        headers.push((lower, value.clone()));
    }
    // GET nunca leva corpo; POST leva o corpo do adaptador (até 4 MB).
    let body = if method == "GET" {
        None
    } else {
        req.body.clone()
    };
    if body.as_ref().is_some_and(|b| b.len() > MAX_BODY) {
        return Err(AppError::new("BODY_TOO_LARGE"));
    }
    Ok(Checked {
        provider: req.provider,
        method,
        path,
        base,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(provider: Provider, method: &str, path: &str) -> AiRequest {
        AiRequest {
            provider,
            method: method.into(),
            path: path.into(),
            headers: BTreeMap::new(),
            body: None,
            base_url: None,
        }
    }

    #[test]
    fn cloud_hosts_are_fixed_https_constants() {
        let ok = check(
            &req(Provider::Openai, "GET", "/v1/models"),
            &Bases::default(),
        )
        .unwrap();
        assert_eq!(ok.url(), "https://api.openai.com/v1/models");
        let anthropic = req(Provider::Anthropic, "GET", "/v1/models?limit=1000");
        assert_eq!(
            check(&anthropic, &Bases::default()).unwrap().url(),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
        // O webview não escolhe o host da nuvem (http://api.openai.com, https://evil.example).
        for base in ["http://api.openai.com", "https://evil.example", OPENAI_BASE] {
            let mut r = req(Provider::Openai, "GET", "/v1/models");
            r.base_url = Some(base.into());
            assert_eq!(
                check(&r, &Bases::default()).unwrap_err().code,
                "HOST_NOT_ALLOWED",
                "{base}"
            );
        }
    }

    #[test]
    fn exact_method_and_path_per_provider() {
        let b = Bases::default();
        for (p, m, path) in [
            (Provider::Openai, "POST", "/v1/models"),
            (Provider::Openai, "GET", "/v1/files"),
            (Provider::Openai, "POST", "/v1/chat/completions?x=1"),
            (Provider::Anthropic, "GET", "/v1/models"),
            (Provider::Ollama, "POST", "/api/pull"),
            (Provider::Ollama, "DELETE", "/api/tags"),
        ] {
            assert_eq!(
                check(&req(p, m, path), &b).unwrap_err().code,
                "PATH_NOT_ALLOWED",
                "{m} {path}"
            );
        }
    }

    #[test]
    fn ollama_only_loopback_http() {
        for good in [
            "http://127.0.0.1:11434",
            "http://localhost:11434",
            "http://[::1]:11434",
            "http://LOCALHOST:8080/",
            "http://127.0.0.1",
        ] {
            assert!(ollama_origin(good).is_some(), "{good}");
        }
        assert_eq!(
            ollama_origin("http://LOCALHOST:8080/").as_deref(),
            Some("http://localhost:8080")
        );
        for bad in [
            "http://192.168.0.2:11434",
            "https://127.0.0.1:11434",
            "http://127.0.0.1:11434/api",
            "http://user@127.0.0.1:11434",
            "http://127.0.0.1.evil.example:11434",
            "http://localhost:0",
            "http://localhost:70000",
            "http://localhost:11434?x",
            "http://[::2]:11434",
            "ftp://localhost:11434",
            "http://localhost:11434 ",
        ] {
            assert!(ollama_origin(bad).is_none(), "{bad}");
            let mut r = req(Provider::Ollama, "GET", "/api/tags");
            r.base_url = Some(bad.into());
            assert_eq!(
                check(&r, &Bases::default()).unwrap_err().code,
                "HOST_NOT_ALLOWED"
            );
        }
        let default = check(
            &req(Provider::Ollama, "GET", "/api/tags"),
            &Bases::default(),
        );
        assert_eq!(default.unwrap().url(), "http://127.0.0.1:11434/api/tags");
    }

    #[test]
    fn headers_from_the_webview_never_carry_auth() {
        let b = Bases::default();
        for name in [
            "authorization",
            "Authorization",
            "x-api-key",
            "cookie",
            "host",
            "x-other",
        ] {
            let mut r = req(Provider::Openai, "GET", "/v1/models");
            r.headers.insert(name.into(), "v".into());
            assert_eq!(
                check(&r, &b).unwrap_err().code,
                "HEADER_NOT_ALLOWED",
                "{name}"
            );
        }
        let mut crlf = req(Provider::Anthropic, "POST", "/v1/messages");
        crlf.headers
            .insert("anthropic-version".into(), "2023-06-01\r\nx: y".into());
        assert_eq!(check(&crlf, &b).unwrap_err().code, "HEADER_NOT_ALLOWED");
        let mut ok = req(Provider::Anthropic, "POST", "/v1/messages");
        ok.headers
            .insert("Anthropic-Version".into(), "2023-06-01".into());
        ok.headers
            .insert("content-type".into(), "application/json".into());
        ok.body = Some("{}".into());
        let checked = check(&ok, &b).unwrap();
        assert_eq!(
            checked.headers,
            vec![
                ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
                ("content-type".to_owned(), "application/json".to_owned())
            ]
        );
        assert_eq!(checked.body.as_deref(), Some("{}"));
    }

    #[test]
    fn body_cap_and_no_body_on_get() {
        let b = Bases::default();
        let mut big = req(Provider::Ollama, "POST", "/api/chat");
        big.body = Some("x".repeat(MAX_BODY + 1));
        assert_eq!(check(&big, &b).unwrap_err().code, "BODY_TOO_LARGE");
        let mut get = req(Provider::Ollama, "GET", "/api/tags");
        get.body = Some("ignored".into());
        assert_eq!(check(&get, &b).unwrap().body, None);
    }

    #[test]
    fn unknown_request_fields_are_refused_by_serde() {
        let parsed: Result<AiRequest, _> = serde_json::from_value(serde_json::json!({
            "provider": "openai", "method": "GET", "path": "/v1/models", "apiKey": "x"
        }));
        assert!(parsed.is_err());
        let parsed: Result<AiRequest, _> = serde_json::from_value(serde_json::json!({
            "provider": "other", "method": "GET", "path": "/v1/models"
        }));
        assert!(parsed.is_err());
    }
}
