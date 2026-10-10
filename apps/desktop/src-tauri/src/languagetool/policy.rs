//! Validação do pedido ao LanguageTool e montagem do corpo (r7 arch-backend §1.4, D-R7-B14). O
//! webview manda um pedido TIPADO (campos fechados, `deny_unknown_fields`); qualquer desvio vira
//! `LT_INVALID_REQUEST` antes de qualquer socket. O corpo `application/x-www-form-urlencoded` é
//! montado AQUI, só com `language`, `preferredVariants`, `data`, `disabledRules` e
//! `disabledCategories` — nunca `text`, `username`, `apiKey`, `level` nem campo vindo do webview.

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Segmentos da anotação (`data.annotation`).
pub const MAX_SEGMENTS: usize = 20_000;
/// Σ unidades UTF-16 de `text` + `markup` (R-I8.4; os offsets do LT são índices de string Java).
pub const MAX_UNITS: usize = 20_000;
pub const MAX_LANGUAGE_BYTES: usize = 35;
pub const MAX_VARIANTS: usize = 10;
pub const MAX_RULE_IDS: usize = 1_000;
pub const MAX_RULE_ID_LEN: usize = 128;
pub const MAX_INTERPRET_AS_UNITS: usize = 4;
/// Corpo codificado (`BODY_TOO_LARGE` acima disto).
pub const MAX_BODY: usize = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LtSegment {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markup: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interpret_as: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LtCheckRequest {
    pub language: String,
    #[serde(default)]
    pub preferred_variants: Vec<String>,
    pub annotation: Vec<LtSegment>,
    #[serde(default)]
    pub disabled_rules: Vec<String>,
    #[serde(default)]
    pub disabled_categories: Vec<String>,
}

/// Pedido validado: o corpo pronto e as unidades UTF-16 enviadas (para o log).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub body: String,
    pub units: usize,
}

fn invalid() -> AppError {
    AppError::new("LT_INVALID_REQUEST")
}

/// JSON cru do webview → pedido tipado. Campo extra (`host`, `url`, `port`, `path`…), tipo errado
/// ou campo ausente → `LT_INVALID_REQUEST`.
pub fn parse_request(value: serde_json::Value) -> Result<LtCheckRequest, AppError> {
    serde_json::from_value(value).map_err(|_| invalid())
}

/// `^[a-z]{2,3}(-[A-Za-z0-9]{1,8}){0,3}$`; `with_region` exige ao menos um `-…`.
fn is_language_code(code: &str, with_region: bool) -> bool {
    if code.len() > MAX_LANGUAGE_BYTES {
        return false;
    }
    let mut parts = code.split('-');
    let primary = parts.next().unwrap_or_default();
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|b| b.is_ascii_lowercase()) {
        return false;
    }
    let rest: Vec<&str> = parts.collect();
    rest.len() <= 3
        && (!with_region || !rest.is_empty())
        && rest
            .iter()
            .all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// `^[A-Za-z0-9_.:\-]{1,128}$`
fn is_rule_id(id: &str) -> bool {
    (1..=MAX_RULE_ID_LEN).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Regras da tabela do §1.4 e o corpo de formulário (campos nesta ordem; listas por vírgula).
pub fn check(req: &LtCheckRequest) -> Result<Checked, AppError> {
    if req.language != "auto" && !is_language_code(&req.language, false) {
        return Err(invalid());
    }
    if !req.preferred_variants.is_empty()
        && (req.language != "auto"
            || req.preferred_variants.len() > MAX_VARIANTS
            || !req
                .preferred_variants
                .iter()
                .all(|v| is_language_code(v, true)))
    {
        return Err(invalid());
    }
    if req.annotation.is_empty() || req.annotation.len() > MAX_SEGMENTS {
        return Err(invalid());
    }
    let mut units = 0usize;
    for segment in &req.annotation {
        let content = match (&segment.text, &segment.markup) {
            (Some(text), None) if segment.interpret_as.is_none() => text,
            (None, Some(markup)) => markup,
            _ => return Err(invalid()),
        };
        if let Some(interpret) = &segment.interpret_as {
            if utf16_len(interpret) > MAX_INTERPRET_AS_UNITS
                || !interpret.chars().all(|c| c == ' ' || c == '\n')
            {
                return Err(invalid());
            }
        }
        units += utf16_len(content);
        if units > MAX_UNITS {
            return Err(invalid());
        }
    }
    for ids in [&req.disabled_rules, &req.disabled_categories] {
        if ids.len() > MAX_RULE_IDS || !ids.iter().all(|id| is_rule_id(id)) {
            return Err(invalid());
        }
    }
    // `data` reconstruído dos campos validados (nada do JSON original passa direto), com os campos
    // na ordem da struct (`text`, `markup`, `interpretAs`).
    #[derive(Serialize)]
    struct Data<'a> {
        annotation: &'a [LtSegment],
    }
    let data = serde_json::to_string(&Data {
        annotation: &req.annotation,
    })
    .map_err(|_| invalid())?;
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("language", &req.language);
    if !req.preferred_variants.is_empty() {
        form.append_pair("preferredVariants", &req.preferred_variants.join(","));
    }
    form.append_pair("data", &data);
    if !req.disabled_rules.is_empty() {
        form.append_pair("disabledRules", &req.disabled_rules.join(","));
    }
    if !req.disabled_categories.is_empty() {
        form.append_pair("disabledCategories", &req.disabled_categories.join(","));
    }
    let body = form.finish();
    if body.len() > MAX_BODY {
        return Err(AppError::new("BODY_TOO_LARGE"));
    }
    Ok(Checked { body, units })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn outcome(value: serde_json::Value) -> &'static str {
        match parse_request(value).and_then(|r| check(&r)) {
            Ok(_) => "OK",
            Err(e) => e.code,
        }
    }

    fn with(patch: serde_json::Value) -> serde_json::Value {
        let mut base =
            json!({ "language": "pt-BR", "annotation": [{ "text": "Isso é uma excessão." }] });
        for (k, v) in patch.as_object().unwrap() {
            base[k] = v.clone();
        }
        base
    }

    #[test]
    fn request_validation_table() {
        let emoji_19998 = format!("{}{}", "a".repeat(19_998), "😀"); // 20.000 unidades
        let emoji_19999 = format!("{}{}", "a".repeat(19_999), "😀"); // 20.001 unidades
        let table: Vec<(&str, serde_json::Value, &str)> = vec![
            ("mínimo", with(json!({})), "OK"),
            ("en-US", with(json!({ "language": "en-US" })), "OK"),
            (
                "de-DE-x-simple",
                with(json!({ "language": "de-DE-x-simple" })),
                "OK",
            ),
            (
                "auto + variantes",
                with(json!({ "language": "auto", "preferredVariants": ["pt-BR", "en-US"] })),
                "OK",
            ),
            (
                "língua vazia",
                with(json!({ "language": "" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "língua maiúscula",
                with(json!({ "language": "PT-BR" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "língua com espaço",
                with(json!({ "language": "pt BR" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "língua 4 partes",
                with(json!({ "language": "pt-a-b-c-d" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "língua > 35 bytes",
                with(json!({ "language": "ptx-aaaaaaaa-bbbbbbbb-cccccccc-d" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "variantes sem auto",
                with(json!({ "preferredVariants": ["pt-BR"] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "variante sem região",
                with(json!({ "language": "auto", "preferredVariants": ["pt"] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "11 variantes",
                with(json!({ "language": "auto", "preferredVariants": vec!["pt-BR"; 11] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "anotação vazia",
                with(json!({ "annotation": [] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "segmento sem campo",
                with(json!({ "annotation": [{}] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "segmento com os dois",
                with(json!({ "annotation": [{ "text": "a", "markup": "<b>" }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "interpretAs com text",
                with(json!({ "annotation": [{ "text": "a", "interpretAs": " " }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "interpretAs ok",
                with(json!({ "annotation": [{ "markup": "<br>", "interpretAs": "\n\n" }] })),
                "OK",
            ),
            (
                "interpretAs com letra",
                with(json!({ "annotation": [{ "markup": "<b>", "interpretAs": "x" }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "interpretAs 5 unidades",
                with(json!({ "annotation": [{ "markup": "<b>", "interpretAs": "     " }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "20.000 unidades (emoji = 2)",
                with(json!({ "annotation": [{ "text": emoji_19998 }] })),
                "OK",
            ),
            (
                "20.001 unidades (emoji = 2)",
                with(json!({ "annotation": [{ "text": emoji_19999 }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "20.001 somando markup",
                with(
                    json!({ "annotation": [{ "text": "a".repeat(10_000) }, { "markup": "b".repeat(10_001) }] }),
                ),
                "LT_INVALID_REQUEST",
            ),
            (
                "ids de regra ok",
                with(
                    json!({ "disabledRules": ["UPPERCASE_SENTENCE_START", "pt-BR:X.1"], "disabledCategories": ["TYPOS"] }),
                ),
                "OK",
            ),
            (
                "id de regra com espaço",
                with(json!({ "disabledRules": ["A B"] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "id de regra com vírgula",
                with(json!({ "disabledCategories": ["A,B"] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "id de 129",
                with(json!({ "disabledRules": ["a".repeat(129)] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "1.001 ids",
                with(json!({ "disabledRules": vec!["A"; 1001] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra host",
                with(json!({ "host": "evil.example" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra url",
                with(json!({ "url": "http://evil.example/v2/check" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra port",
                with(json!({ "port": 8082 })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra path",
                with(json!({ "path": "/v2/words" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra username",
                with(json!({ "username": "x", "apiKey": "y" })),
                "LT_INVALID_REQUEST",
            ),
            (
                "campo extra no segmento",
                with(json!({ "annotation": [{ "text": "a", "offset": 3 }] })),
                "LT_INVALID_REQUEST",
            ),
            (
                "tipo errado",
                with(json!({ "language": 1 })),
                "LT_INVALID_REQUEST",
            ),
            (
                "sem language",
                json!({ "annotation": [{ "text": "a" }] }),
                "LT_INVALID_REQUEST",
            ),
        ];
        assert!(table.len() >= 25);
        for (name, value, expected) in table {
            assert_eq!(outcome(value), expected, "{name}");
        }
        // 20.000 segmentos ok; 20.001 recusado.
        let many = |n: usize| with(json!({ "annotation": vec![json!({ "markup": "" }); n] }));
        assert_eq!(outcome(many(MAX_SEGMENTS)), "OK");
        assert_eq!(outcome(many(MAX_SEGMENTS + 1)), "LT_INVALID_REQUEST");
    }

    #[test]
    fn body_over_1mib_refused() {
        // 20.000 segmentos (o máximo) de `markup` vazio com `interpretAs`: ~2 MB codificados.
        let segment = json!({ "markup": "", "interpretAs": "\n\n\n\n" });
        let value = with(json!({ "annotation": vec![segment; MAX_SEGMENTS] }));
        let req = parse_request(value).unwrap();
        assert_eq!(check(&req).unwrap_err().code, "BODY_TOO_LARGE");
    }

    #[test]
    fn form_body_exact() {
        let req = parse_request(json!({
            "language": "auto",
            "preferredVariants": ["pt-BR", "en-US"],
            "annotation": [{ "text": "Olá & " }, { "markup": "<b>", "interpretAs": " " }],
            "disabledRules": ["R1", "R2"],
            "disabledCategories": ["TYPOS"]
        }))
        .unwrap();
        let checked = check(&req).unwrap();
        assert_eq!(checked.units, 9);
        assert_eq!(
            checked.body,
            "language=auto&preferredVariants=pt-BR%2Cen-US&data=%7B%22annotation%22%3A%5B%7B%22text%22%3A%22Ol%C3%A1+%26+%22%7D%2C%7B%22markup%22%3A%22%3Cb%3E%22%2C%22interpretAs%22%3A%22+%22%7D%5D%7D&disabledRules=R1%2CR2&disabledCategories=TYPOS"
        );
        let fields: Vec<String> = url::form_urlencoded::parse(checked.body.as_bytes())
            .map(|(k, _)| k.into_owned())
            .collect();
        assert_eq!(
            fields,
            [
                "language",
                "preferredVariants",
                "data",
                "disabledRules",
                "disabledCategories"
            ]
        );
        // Mínimo: só language + data.
        let minimal = check(
            &parse_request(json!({ "language": "pt-BR", "annotation": [{ "text": "a" }] }))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            minimal.body,
            "language=pt-BR&data=%7B%22annotation%22%3A%5B%7B%22text%22%3A%22a%22%7D%5D%7D"
        );
        for banned in ["text=", "username", "apiKey", "level"] {
            assert!(
                !checked.body.starts_with(banned) && !checked.body.contains(&format!("&{banned}"))
            );
        }
    }
}
