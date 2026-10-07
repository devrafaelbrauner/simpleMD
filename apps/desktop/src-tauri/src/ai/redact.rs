//! Redação de chaves (R-11.5, AC-11.7; arch-backend r2 §1.7.2). Troca por `[chave redigida]`:
//! `sk-ant-…`, `sk-…` (letras, dígitos, `_` e `-`) e `Bearer <token>`, cada um só no começo de uma
//! "palavra" (o caractere anterior não é letra, dígito, `_` nem `-`, para não mutilar `task-list`).
//! Também troca o valor exato da chave carregada, quando há uma. Varredura manual, sem regex. O
//! espelho em TypeScript (`packages/ai/src/redact.ts`) segue as mesmas regras.

pub const REDACTED: &str = "[chave redigida]";

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// Tamanho (em bytes) do token que começa em `rest`, se `rest` começa um padrão de chave.
fn match_at(rest: &str) -> Option<usize> {
    if let Some(after) = rest.strip_prefix("sk-") {
        let body = after
            .find(|c: char| !is_token_char(c))
            .unwrap_or(after.len());
        return (body > 0).then_some(3 + body);
    }
    let head = rest.get(..6)?;
    if !head.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let after = &rest[6..];
    let spaces = after
        .find(|c: char| !c.is_whitespace())
        .unwrap_or(after.len());
    if spaces == 0 {
        return None;
    }
    let token = &after[spaces..];
    let len = token.find(char::is_whitespace).unwrap_or(token.len());
    (len > 0).then_some(6 + spaces + len)
}

/// Texto com toda chave aparente (e o valor exato de `key`, se dado) trocado por `[chave redigida]`.
pub fn redact(text: &str, key: Option<&str>) -> String {
    let source = match key {
        Some(key) if !key.is_empty() => text.replace(key, REDACTED),
        _ => text.to_owned(),
    };
    let mut out = String::with_capacity(source.len());
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < source.len() {
        let rest = &source[i..];
        if !prev.is_some_and(is_token_char) {
            if let Some(len) = match_at(rest) {
                out.push_str(REDACTED);
                i += len;
                prev = Some(']');
                continue;
            }
        }
        let c = rest
            .chars()
            .next()
            .expect("índice em fronteira de caractere");
        out.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_openai_anthropic_and_bearer_tokens() {
        let openai = r#"{"error":{"message":"Incorrect API key provided: sk-proj-abcd1234wxyz."}}"#;
        assert_eq!(
            redact(openai, None),
            r#"{"error":{"message":"Incorrect API key provided: [chave redigida]."}}"#
        );
        let anthropic = "invalid x-api-key sk-ant-api03-AbC_d-9 here";
        assert_eq!(
            redact(anthropic, None),
            "invalid x-api-key [chave redigida] here"
        );
        assert_eq!(
            redact("Authorization: Bearer abc.def-123 ok", None),
            "Authorization: [chave redigida] ok"
        );
        assert_eq!(redact("bearer\tXYZ", None), "[chave redigida]");
    }

    #[test]
    fn keeps_words_that_only_contain_the_prefix() {
        let text = "task-list desk-top risk- Bearerless sk- só";
        assert_eq!(redact(text, None), text);
    }

    #[test]
    fn replaces_the_exact_loaded_key_even_without_a_prefix() {
        assert_eq!(
            redact("echo: weird-key-0001 end", Some("weird-key-0001")),
            "echo: [chave redigida] end"
        );
        assert_eq!(redact("nada", Some("")), "nada");
    }

    #[test]
    fn handles_multibyte_text() {
        assert_eq!(
            redact("ação: sk-çã não", None),
            "ação: sk-çã não",
            "ç não é caractere de chave: `sk-` sem corpo fica"
        );
        assert_eq!(redact("é sk-AB1 ü", None), "é [chave redigida] ü");
    }
}
