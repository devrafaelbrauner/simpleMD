//! Gravador de fixtures de IA — SÓ no build de debug (`#[cfg(debug_assertions)]` no `mod`; AC-11.17,
//! R-11.10; arch-backend r2 §1.7.4). Os nomes das variáveis de ambiente moram aqui dentro, então o
//! binário de release não tem nenhuma ocorrência deles (`strings`).
//!
//! Grava só o corpo do pedido e o corpo da resposta + `content-type` (nenhum outro cabeçalho),
//! ambos redigidos. Com `SIMPLEMD_AI_RECORD_INVALID_KEY=1`, um provedor de nuvem usa a constante
//! `invalid-key-for-401-fixture` no lugar da chave (o caso 401) — nunca uma alteração da chave real.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::redact::redact;
use super::transport::{Prepared, Trace};

pub const DIR_VAR: &str = "SIMPLEMD_AI_RECORD_DIR";
pub const INVALID_KEY_VAR: &str = "SIMPLEMD_AI_RECORD_INVALID_KEY";
pub const INVALID_KEY: &str = "invalid-key-for-401-fixture";

/// Um pedido sendo gravado (o que vai para o arquivo sai daqui, já redigido).
pub struct Recording {
    dir: PathBuf,
    provider: &'static str,
    method: &'static str,
    path: &'static str,
    body: Option<String>,
}

/// Troca a chave pela constante inválida (caso 401). Só provedores de nuvem.
pub fn use_invalid_key(prepared: &mut Prepared) {
    if prepared.key.is_some() {
        prepared.key = Some(Zeroizing::new(INVALID_KEY.to_owned()));
    }
}

/// Gravação ligada pelo ambiente (`SIMPLEMD_AI_RECORD_DIR=<pasta fora do repositório>`).
pub fn from_env(prepared: &mut Prepared) -> Option<Recording> {
    let dir = std::env::var_os(DIR_VAR)?;
    if std::env::var(INVALID_KEY_VAR).as_deref() == Ok("1") {
        use_invalid_key(prepared);
    }
    Some(Recording::new(PathBuf::from(dir), prepared))
}

/// Nome do caso a partir do pedido e da resposta (`list-models`, `chat-stream`, `chat-nostream`,
/// `error-<status>`).
pub fn case_name(method: &str, body: Option<&str>, status: Option<u16>) -> String {
    if let Some(status) = status.filter(|s| !(200..300).contains(s)) {
        return format!("error-{status}");
    }
    if method == "GET" {
        return "list-models".to_owned();
    }
    let streaming = body
        .and_then(|b| serde_json::from_str::<Value>(b).ok())
        .and_then(|v| v.get("stream").and_then(Value::as_bool))
        .unwrap_or(false);
    if streaming {
        "chat-stream"
    } else {
        "chat-nostream"
    }
    .to_owned()
}

impl Recording {
    pub fn new(dir: PathBuf, prepared: &mut Prepared) -> Self {
        prepared.collect = true;
        let key = prepared.key.as_deref().map(String::as_str);
        let checked = &prepared.checked;
        Self {
            dir,
            provider: checked.provider.name(),
            method: checked.method,
            path: checked.path,
            body: checked.body.as_deref().map(|b| redact(b, key)),
        }
    }

    pub fn case(&self, trace: &Trace) -> String {
        case_name(self.method, self.body.as_deref(), trace.status)
    }

    /// Conteúdo do arquivo: pedido (provedor, método, caminho, corpo) e resposta (status,
    /// `contentType`, pedaços na ordem em que chegaram). Nenhum cabeçalho além do content-type.
    pub fn document(&self, trace: &Trace) -> Value {
        let body = self.body.as_deref().map(|b| {
            serde_json::from_str::<Value>(b).unwrap_or_else(|_| Value::String(b.to_owned()))
        });
        let mut response = json!({
            "status": trace.status,
            "contentType": trace.content_type,
            "chunks": trace.chunks,
        });
        if let Some(code) = trace.error {
            response["error"] = json!(code);
        }
        json!({
            "request": {
                "provider": self.provider,
                "method": self.method,
                "path": self.path,
                "body": body,
            },
            "response": response,
        })
    }

    /// `<dir>/<provedor>/<nome>.json`.
    pub fn write_named(&self, trace: &Trace, name: &str) -> io::Result<PathBuf> {
        let folder = self.dir.join(self.provider);
        fs::create_dir_all(&folder)?;
        let file = folder.join(format!("{name}.json"));
        write_json(&file, &self.document(trace))?;
        Ok(file)
    }

    /// `<dir>/<provedor>/<caso>-<ms>.json` (gravação pelo app em debug).
    pub fn write(&self, trace: &Trace) -> io::Result<PathBuf> {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let name = format!("{}-{ms}", self.case(trace));
        self.write_named(trace, &name)
    }
}

pub fn write_json(file: &Path, value: &Value) -> io::Result<()> {
    let mut text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    text.push('\n');
    fs::write(file, text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::keys::{MemoryStore, SecretStore};
    use crate::ai::policy::Provider;
    use crate::ai::transport::tests::{chunk, head, last, request, serve, transport_at, Collect};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn case_names() {
        assert_eq!(case_name("GET", None, Some(200)), "list-models");
        assert_eq!(
            case_name("POST", Some(r#"{"stream":true}"#), Some(200)),
            "chat-stream"
        );
        assert_eq!(
            case_name("POST", Some(r#"{"stream":false}"#), Some(200)),
            "chat-nostream"
        );
        assert_eq!(case_name("POST", Some("{}"), Some(429)), "error-429");
        assert_eq!(case_name("GET", None, Some(401)), "error-401");
    }

    /// AC-11.10/11.4: o arquivo gravado tem corpo + content-type, nada de cabeçalho nem de chave; o
    /// caso 401 usa a constante inválida, nunca a chave guardada.
    #[test]
    fn records_bodies_only_and_swaps_in_the_invalid_key() {
        let echo =
            r#"{"error":{"message":"Incorrect API key provided: invalid-key-for-401-fixture"}}"#;
        let parts = vec![
            head(
                "401 Unauthorized",
                "application/json",
                "x-request-id: r1\r\n",
            ),
            chunk(echo),
            last(),
        ];
        let (port, requests) = serve(vec![parts], Duration::ZERO);
        let store = Arc::new(MemoryStore::default());
        store.set("ai.openai", "sk-test-CANARY-recorder").unwrap();
        let transport = transport_at(port, store, Arc::default());
        let mut prepared = transport
            .prepare(&request(Provider::Openai, "GET", "/v1/models", None))
            .unwrap();
        use_invalid_key(&mut prepared);
        let mut random = [0u8; 6];
        getrandom::fill(&mut random).unwrap();
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("smd-rec-{suffix}"));
        let recording = Recording::new(dir.clone(), &mut prepared);
        let trace = tauri::async_runtime::block_on(transport.run(prepared, &Collect::default()));
        let raw = requests.recv().unwrap();
        assert!(raw.contains("authorization: Bearer invalid-key-for-401-fixture\r\n"));
        assert!(!raw.contains("CANARY"));
        let file = recording.write_named(&trace, "error-401").unwrap();
        let text = fs::read_to_string(&file).unwrap();
        fs::remove_dir_all(&dir).ok();
        let doc: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["request"]["path"], "/v1/models");
        assert_eq!(doc["response"]["status"], 401);
        assert_eq!(doc["response"]["contentType"], "application/json");
        assert!(text.contains("[chave redigida]"), "{text}");
        for banned in [
            "x-request-id",
            "authorization",
            "CANARY",
            "invalid-key-for-401-fixture",
        ] {
            assert!(!text.contains(banned), "{banned} em {text}");
        }
    }
}
