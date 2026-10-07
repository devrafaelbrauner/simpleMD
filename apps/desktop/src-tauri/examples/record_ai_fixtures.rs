//! Gravador de fixtures de contrato da IA (R-11.10, AC-11.4; arch-backend r2 §1.7.4). Só no build
//! de debug (o módulo `ai::recorder` não existe no release). Usa o MESMO transporte nativo do app
//! (política, hosts fixos, chave lida do keychain do sistema por pedido) e grava só corpos +
//! `content-type`, redigidos, numa pasta FORA do repositório.
//!
//! Os pedidos vêm do plano `packages/ai/test/fixtures/plan.json`, que um teste do Vitest confere
//! contra os adaptadores TypeScript (o plano não pode divergir do que o app envia).
//!
//! ```text
//! cargo run --example record_ai_fixtures -- \
//!   --provider ollama|openai|anthropic --model <modelo> --out <pasta fora do repo> \
//!   [--plan <plan.json>] [--ollama-url http://127.0.0.1:11434]
//! ```
//!
//! Casos: `list-models`, `chat-stream`, `chat-nostream`; nuvem: `error-401` (constante inválida,
//! nunca a chave real); Ollama: `error-404` (modelo inexistente). `stream-truncated` é o
//! `chat-stream` gravado cortado no meio de um evento. 429/5xx e a conexão recusada ficam como
//! fixtures `sintético` documentadas. Escreve também `meta.json` com `origem: gravado`.

#[cfg(not(debug_assertions))]
fn main() {
    eprintln!("record_ai_fixtures: só existe no build de debug (o gravador fica fora do release).");
}

#[cfg(debug_assertions)]
fn main() {
    if let Err(message) = recording::run() {
        eprintln!("record_ai_fixtures: {message}");
        std::process::exit(1);
    }
}

#[cfg(debug_assertions)]
mod recording {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use parking_lot::Mutex;
    use serde_json::{json, Value};
    use simplemd_lib::ai::keys::{KeyringStore, SERVICE};
    use simplemd_lib::ai::policy::{AiRequest, Provider};
    use simplemd_lib::ai::recorder::{self, Recording};
    use simplemd_lib::ai::transport::{AiEvent, EventSink, Trace, Transport};

    struct Args {
        provider: String,
        model: String,
        out: PathBuf,
        plan: PathBuf,
        ollama_url: Option<String>,
    }

    fn parse_args() -> Result<Args, String> {
        let mut values = BTreeMap::new();
        // Só opções de linha de comando de uma ferramenta de desenvolvimento (argv[0] é pulado);
        // nenhuma decisão de segurança depende delas.
        // nosemgrep: rust.lang.security.args.args
        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let value = args
                .next()
                .ok_or_else(|| format!("falta o valor de {flag}"))?;
            values.insert(flag, value);
        }
        let take = |name: &str| values.get(name).cloned();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        Ok(Args {
            provider: take("--provider").ok_or("use --provider ollama|openai|anthropic")?,
            model: take("--model").ok_or("use --model <modelo>")?,
            out: take("--out")
                .map(PathBuf::from)
                .ok_or("use --out <pasta fora do repositório>")?,
            plan: take("--plan")
                .map(PathBuf::from)
                .unwrap_or_else(|| manifest.join("../../../packages/ai/test/fixtures/plan.json")),
            ollama_url: take("--ollama-url"),
        })
    }

    /// Coleta os eventos sem imprimir conteúdo.
    #[derive(Default)]
    struct Sink(Mutex<Vec<AiEvent>>);

    impl EventSink for Sink {
        fn emit(&self, event: AiEvent) -> bool {
            self.0.lock().push(event);
            true
        }
    }

    fn today() -> String {
        let days = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() / 86_400)
            .unwrap_or(0) as i64;
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let day = doy - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        let year = yoe + era * 400 + i64::from(month <= 2);
        format!("{year:04}-{month:02}-{day:02}")
    }

    /// Texto esperado de um fluxo, com um parser INDEPENDENTE do TypeScript (verificação cruzada).
    fn stream_text(provider: Provider, raw: &str) -> String {
        let mut text = String::new();
        match provider {
            Provider::Ollama => {
                for line in raw.lines().filter(|l| !l.trim().is_empty()) {
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        text.push_str(v["message"]["content"].as_str().unwrap_or(""));
                    }
                }
            }
            _ => {
                for line in raw.lines() {
                    let Some(data) = line.strip_prefix("data:") else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<Value>(data.trim()) else {
                        continue;
                    };
                    if provider == Provider::Openai {
                        text.push_str(v["choices"][0]["delta"]["content"].as_str().unwrap_or(""));
                    } else if v["type"] == "content_block_delta" {
                        text.push_str(v["delta"]["text"].as_str().unwrap_or(""));
                    }
                }
            }
        }
        text
    }

    fn whole_text(provider: Provider, raw: &str) -> String {
        let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        match provider {
            Provider::Openai => v["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            Provider::Anthropic => v["content"]
                .as_array()
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter_map(|b| b["text"].as_str())
                        .collect::<String>()
                })
                .unwrap_or_default(),
            Provider::Ollama => v["message"]["content"].as_str().unwrap_or("").to_owned(),
        }
    }

    /// Regra de filtro da OpenAI (packages/ai/README.md), repetida aqui para conferência cruzada.
    fn openai_chat_model(id: &str) -> bool {
        let prefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
        let excluded = [
            "-audio",
            "-realtime",
            "-transcribe",
            "-tts",
            "-search",
            "-image",
            "embedding",
            "moderation",
            "dall-e",
            "whisper",
        ];
        prefixes.iter().any(|p| id.starts_with(p)) && !excluded.iter().any(|x| id.contains(x))
    }

    fn models(provider: Provider, raw: &str) -> Vec<String> {
        let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let (list, field) = match provider {
            Provider::Ollama => (&v["models"], "name"),
            _ => (&v["data"], "id"),
        };
        let mut ids: Vec<String> = list
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|m| m[field].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if provider == Provider::Openai {
            ids.retain(|id| openai_chat_model(id));
            ids.sort();
        }
        ids
    }

    fn run_case(
        transport: &Transport,
        request: AiRequest,
        out: &Path,
        name: &str,
        invalid_key: bool,
    ) -> Result<(Value, Trace), String> {
        let mut prepared = transport
            .prepare(&request)
            .map_err(|e| format!("{name}: {} ({})", e.code, e.message))?;
        if invalid_key {
            recorder::use_invalid_key(&mut prepared);
        }
        let recording = Recording::new(out.to_path_buf(), &mut prepared);
        let sink = Sink::default();
        let trace = tauri::async_runtime::block_on(transport.run(prepared, &sink));
        if let Some(code) = trace.error {
            return Err(format!("{name}: erro de transporte {code}"));
        }
        let document = recording.document(&trace);
        eprintln!(
            "  {name}: status {} · {} pedaço(s)",
            trace.status.unwrap_or(0),
            trace.chunks.len()
        );
        Ok((document, trace))
    }

    /// O fluxo gravado cortado no meio de um evento (≈ 60 % do texto, dentro de uma linha `data:`
    /// ou de uma linha NDJSON), sem o fim do fluxo.
    fn truncate(chunks: &[String]) -> Vec<String> {
        let joined: String = chunks.concat();
        let mut cut = joined.len() * 6 / 10;
        while !joined.is_char_boundary(cut) {
            cut -= 1;
        }
        // Recua até ficar dentro de um JSON (depois de um `{`), para o corte partir o evento.
        if let Some(open) = joined[..cut].rfind('{') {
            cut = (open + 1 + (cut - open) / 2).min(joined.len() - 1);
            while !joined.is_char_boundary(cut) {
                cut -= 1;
            }
        }
        let mut out = Vec::new();
        let mut taken = 0;
        for chunk in chunks {
            if taken >= cut {
                break;
            }
            let room = cut - taken;
            if chunk.len() <= room {
                out.push(chunk.clone());
                taken += chunk.len();
            } else {
                let mut end = room;
                while !chunk.is_char_boundary(end) {
                    end -= 1;
                }
                out.push(chunk[..end].to_owned());
                taken += end;
            }
        }
        out
    }

    pub fn run() -> Result<(), String> {
        let args = parse_args()?;
        let provider: Provider = serde_json::from_value(json!(args.provider))
            .map_err(|_| "provedor deve ser ollama, openai ou anthropic".to_owned())?;
        let plan: Value = serde_json::from_str(
            &std::fs::read_to_string(&args.plan)
                .map_err(|e| format!("plano {}: {e}", args.plan.display()))?,
        )
        .map_err(|e| format!("plano inválido: {e}"))?;
        let section = &plan[provider.name()];
        let cases = section["cases"].as_array().ok_or("plano sem casos")?;
        let transport = Transport::new(Arc::new(KeyringStore::new(SERVICE)));
        let model_json = serde_json::to_string(&args.model).map_err(|e| e.to_string())?;
        let model_inner = &model_json[1..model_json.len() - 1];
        let dir = args.out.join(provider.name());
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        eprintln!("record_ai_fixtures: {} · {}", provider.name(), args.model);
        let mut recorded = Vec::new();
        for case in cases {
            let name = case["case"].as_str().ok_or("caso sem nome")?;
            let body = case["body"]
                .as_str()
                .map(|b| b.replace("{{model}}", model_inner));
            let headers: BTreeMap<String, String> =
                serde_json::from_value(case["headers"].clone()).unwrap_or_default();
            let request = AiRequest {
                provider,
                method: case["method"].as_str().unwrap_or("GET").to_owned(),
                path: case["path"].as_str().unwrap_or("").to_owned(),
                headers,
                body,
                base_url: (provider == Provider::Ollama)
                    .then(|| args.ollama_url.clone())
                    .flatten(),
            };
            let invalid_key = case["invalidKey"].as_bool().unwrap_or(false);
            let (mut document, trace) =
                run_case(&transport, request, &args.out, name, invalid_key)?;
            let raw: String = trace.chunks.concat();
            let status = trace.status.unwrap_or(0);
            let expected = if !(200..300).contains(&status) {
                json!({ "status": status })
            } else if name == "list-models" {
                json!({ "models": models(provider, &raw) })
            } else if name == "chat-stream" {
                json!({ "text": stream_text(provider, &raw) })
            } else {
                json!({ "text": whole_text(provider, &raw) })
            };
            document["expected"] = expected;
            if let Some(want) = case["expectStatus"].as_u64() {
                if u64::from(status) != want {
                    return Err(format!("{name}: status {status}, esperado {want}"));
                }
            }
            recorder::write_json(&dir.join(format!("{name}.json")), &document)
                .map_err(|e| e.to_string())?;
            if name == "chat-stream" {
                let mut cut = document.clone();
                let chunks = truncate(&trace.chunks);
                let partial = stream_text(provider, &chunks.concat());
                cut["response"]["chunks"] = json!(chunks);
                cut["expected"] = json!({ "partialText": partial, "error": "STREAM" });
                cut["note"] =
                    json!("chat-stream gravado, cortado no meio de um evento (sem o fim do fluxo)");
                recorder::write_json(&dir.join("stream-truncated.json"), &cut)
                    .map_err(|e| e.to_string())?;
                recorded.push("stream-truncated".to_owned());
            }
            recorded.push(name.to_owned());
        }
        let meta = json!({
            "provider": provider.name(),
            "model": args.model,
            "apiVersion": section["apiVersion"],
            "date": today(),
            "origem": "gravado",
            "gravados": recorded,
            "sinteticos": section["synthetic"],
        });
        recorder::write_json(&dir.join("meta.json"), &meta).map_err(|e| e.to_string())?;
        eprintln!("record_ai_fixtures: OK → {}", dir.display());
        Ok(())
    }
}
