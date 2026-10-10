//! Abrir URL externa no navegador ou no cliente de e-mail do sistema (r7 arch-backend §1.2;
//! R-X7.6, U-3, D-28). O webview pede `open_url(url)`; aqui a URL é validada (ordem fixa, abaixo),
//! passa por um anteparo de taxa (5 aberturas por 10 s, D-R7-B07) e só a forma RE-SERIALIZADA pelo
//! crate `url` chega ao SO, pela função livre `tauri_plugin_opener::open_url`. O plugin do opener
//! nunca é registrado: não existe nenhum comando IPC `plugin:opener|*` (D-R7-B05). O log tem só o
//! esquema e o resultado, nunca a URL.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tauri::State;
use url::Url;

use crate::error::AppError;

/// Entrada crua, em scalar values.
pub const URL_MAX_CHARS: usize = 2048;
/// Bytes de `Url::as_str()` (IDN e percent-encoding crescem a entrada).
pub const URL_MAX_SERIALIZED: usize = 8192;
/// Aberturas bem-sucedidas…
pub const RATE_MAX: usize = 5;
/// …por janela deslizante.
pub const RATE_WINDOW: Duration = Duration::from_secs(10);
/// Chaves de consulta aceitas num `mailto:` (sem caixa). `attach`/`attachment` exfiltram arquivos
/// locais em alguns clientes de e-mail (D-R7-B06).
const MAILTO_KEYS: [&str; 6] = ["to", "cc", "bcc", "subject", "body", "in-reply-to"];
const SCHEMES: [&str; 3] = ["http", "https", "mailto"];

/// Formatação bidi que esconde o destino real (U+200E/F, U+202A–E, U+2066–9; D-R7-B13).
fn is_bidi_format(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

/// Pura (testável sem Tauri): a URL normalizada ou o código de recusa. A primeira regra que falha
/// decide o código. Controle e espaço são checados na entrada CRUA: o parser removeria `\t`/`\n`
/// e espaços das pontas em silêncio (E-10).
pub fn validate(input: &str) -> Result<Url, AppError> {
    if input.chars().count() > URL_MAX_CHARS {
        return Err(AppError::new("URL_TOO_LONG"));
    }
    if input.chars().any(|c| c.is_control() || is_bidi_format(c)) {
        return Err(AppError::new("URL_CONTROL_CHAR"));
    }
    if input.starts_with(char::is_whitespace) || input.ends_with(char::is_whitespace) {
        return Err(AppError::new("URL_INVALID"));
    }
    let url = Url::parse(input).map_err(|_| AppError::new("URL_INVALID"))?;
    if !SCHEMES.contains(&url.scheme()) {
        return Err(AppError::new("URL_SCHEME_NOT_ALLOWED"));
    }
    if url.scheme() == "mailto" {
        let keys: Vec<String> = url
            .query_pairs()
            .map(|(key, _)| key.to_ascii_lowercase())
            .collect();
        if url.path().is_empty() && !keys.iter().any(|k| k == "to") {
            return Err(AppError::new("URL_INVALID"));
        }
        if keys.iter().any(|k| !MAILTO_KEYS.contains(&k.as_str())) {
            return Err(AppError::new("URL_MAILTO_PARAM"));
        }
    } else if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new("URL_CREDENTIALS"));
    }
    if url.as_str().len() > URL_MAX_SERIALIZED {
        return Err(AppError::new("URL_TOO_LONG"));
    }
    Ok(url)
}

/// Quem entrega a URL ao SO. Trocável só nos testes (lançador falso).
pub trait Launcher: Send + Sync {
    fn open(&self, url: &str) -> Result<(), ()>;
}

/// `open::that_detached` por baixo: `/usr/bin/open <url>` no macOS, `ShellExecuteW` no Windows,
/// sem shell. O texto do erro do SO é descartado (`OPEN_FAILED` tem mensagem fixa).
struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn open(&self, url: &str) -> Result<(), ()> {
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| ())
    }
}

/// Estado do comando: o anteparo de taxa (instantes das aberturas na janela) e o lançador.
pub struct OpenerState {
    recent: Mutex<VecDeque<Instant>>,
    launcher: Arc<dyn Launcher>,
}

impl OpenerState {
    pub fn new() -> Self {
        Self::with_launcher(Arc::new(SystemLauncher))
    }

    fn with_launcher(launcher: Arc<dyn Launcher>) -> Self {
        Self {
            recent: Mutex::new(VecDeque::with_capacity(RATE_MAX)),
            launcher,
        }
    }

    /// Valida e reserva uma vaga no anteparo (relógio injetado: `now`). A 6ª abertura dentro de
    /// 10 s → `RATE_LIMITED`, e nada chega ao SO.
    fn admit(&self, input: &str, now: Instant) -> Result<Url, AppError> {
        let url = validate(input)?;
        let mut recent = self.recent.lock();
        while recent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= RATE_WINDOW)
        {
            recent.pop_front();
        }
        if recent.len() >= RATE_MAX {
            return Err(AppError::new("RATE_LIMITED"));
        }
        recent.push_back(now);
        Ok(url)
    }

    /// Abertura que falhou não conta no anteparo (só as bem-sucedidas contam).
    fn release(&self, at: Instant) {
        let mut recent = self.recent.lock();
        if let Some(i) = recent.iter().rposition(|t| *t == at) {
            recent.remove(i);
        }
    }

    /// Caminho completo, síncrono (testes): validar → anteparo → lançador com a URL re-serializada.
    #[cfg(test)]
    fn open_at(&self, input: &str, now: Instant) -> Result<(), AppError> {
        let url = self.admit(input, now)?;
        self.launcher.open(url.as_str()).map_err(|()| {
            self.release(now);
            AppError::new("OPEN_FAILED")
        })
    }
}

/// Linha de log: só o esquema permitido (ou `-`) e o resultado; nunca a URL (§1.1).
fn log_line(input: &str, result: &Result<(), AppError>) -> String {
    let scheme = Url::parse(input)
        .ok()
        .map(|u| u.scheme().to_owned())
        .filter(|s| SCHEMES.contains(&s.as_str()))
        .unwrap_or_else(|| "-".to_owned());
    let outcome = match result {
        Ok(()) => "ok",
        Err(error) => error.code,
    };
    format!("opener: {scheme} -> {outcome}")
}

/// Abre `http`/`https`/`mailto` validados no navegador ou cliente de e-mail do sistema.
#[tauri::command]
pub async fn open_url(state: State<'_, OpenerState>, url: String) -> Result<(), AppError> {
    let now = Instant::now();
    let result = match state.admit(&url, now) {
        Err(error) => Err(error),
        Ok(parsed) => {
            let launcher = state.launcher.clone();
            let serialized = String::from(parsed);
            let launched =
                tauri::async_runtime::spawn_blocking(move || launcher.open(&serialized)).await;
            match launched {
                Ok(Ok(())) => Ok(()),
                _ => {
                    state.release(now);
                    Err(AppError::new("OPEN_FAILED"))
                }
            }
        }
    };
    println!("{}", log_line(&url, &result));
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// Tabela única de casos, também lida pelo Vitest do espelho TS (S1; §5.3).
    const CASES: &str = include_str!("../../../../packages/core/test/fixtures/open-url-cases.json");

    #[derive(Deserialize)]
    struct Case {
        input: String,
        expect: String,
        normalized: Option<String>,
    }

    fn code(input: &str) -> String {
        match validate(input) {
            Ok(_) => "ok".to_owned(),
            Err(error) => error.code.to_owned(),
        }
    }

    #[derive(Default)]
    struct FakeLauncher {
        opened: Mutex<Vec<String>>,
        fail: bool,
    }

    impl Launcher for FakeLauncher {
        fn open(&self, url: &str) -> Result<(), ()> {
            self.opened.lock().push(url.to_owned());
            if self.fail {
                Err(())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn validate_matches_shared_table() {
        let cases: Vec<Case> = serde_json::from_str(CASES).unwrap();
        assert!(cases.len() >= 30, "{} casos", cases.len());
        for case in &cases {
            assert_eq!(code(&case.input), case.expect, "{:?}", case.input);
            if let Some(normalized) = &case.normalized {
                assert_eq!(validate(&case.input).unwrap().as_str(), normalized);
            }
        }
    }

    #[test]
    fn https_uppercase_normalized() {
        let url = validate("HTTPS://Exemplo.org/a?b=1#c").unwrap();
        assert_eq!(url.as_str(), "https://exemplo.org/a?b=1#c");
        assert_eq!(code("JaVaScRiPt:alert(1)"), "URL_SCHEME_NOT_ALLOWED");
    }

    #[test]
    fn credentials_refused() {
        for input in [
            "https://user:pw@exemplo.org/",
            "https://banco.com@mal.com/",
            "http://:senha@exemplo.org/",
        ] {
            assert_eq!(code(input), "URL_CREDENTIALS", "{input}");
        }
    }

    #[test]
    fn control_bidi_and_edge_whitespace_refused() {
        for input in [
            "https://exemplo.org/\na",
            "http://exa\tmple.org/",
            "https://exemplo.org/\u{85}",
            "https://exemplo.org/\u{202E}gpj.exe",
            "https://exemplo.org/\u{2066}",
            "https://exemplo.org/\u{0}",
            "https://exemplo.org/\u{7f}",
        ] {
            assert_eq!(code(input), "URL_CONTROL_CHAR", "{input:?}");
        }
        assert_eq!(code(" https://exemplo.org/"), "URL_INVALID");
        assert_eq!(code("https://exemplo.org/\u{3000}"), "URL_INVALID");
    }

    #[test]
    fn length_2048_ok_2049_refused() {
        let base = "https://exemplo.org/";
        let ok = format!("{base}{}", "a".repeat(URL_MAX_CHARS - base.len()));
        assert_eq!(ok.chars().count(), 2048);
        assert_eq!(code(&ok), "ok");
        assert_eq!(code(&format!("{ok}a")), "URL_TOO_LONG");
        // Dentro de 2.048 caracteres, mas > 8.192 bytes depois do percent-encoding.
        let wide = format!("{base}{}", "\u{4e00}".repeat(1000));
        assert_eq!(code(&wide), "URL_TOO_LONG");
    }

    #[test]
    fn mailto_param_allowlist() {
        assert_eq!(code("mailto:a@b.c?subject=oi&body=texto"), "ok");
        assert_eq!(code("mailto:a@b.c?Subject=oi&CC=d@e.f"), "ok");
        assert_eq!(code("mailto:?to=a@b.c"), "ok");
        assert_eq!(code("mailto:a@b.c?attach=/etc/passwd"), "URL_MAILTO_PARAM");
        assert_eq!(code("mailto:a@b.c?ATTACHMENT=C:/x"), "URL_MAILTO_PARAM");
        assert_eq!(code("mailto:"), "URL_INVALID");
        assert_eq!(code("mailto:?subject=oi"), "URL_INVALID");
    }

    #[test]
    fn rate_limit_5_per_10s() {
        let launcher = Arc::new(FakeLauncher::default());
        let state = OpenerState::with_launcher(launcher.clone());
        let t0 = Instant::now();
        for i in 0..RATE_MAX {
            let at = t0 + Duration::from_millis(i as u64 * 100);
            state.open_at("https://exemplo.org/", at).unwrap();
        }
        let sixth = state.open_at("https://exemplo.org/", t0 + Duration::from_secs(9));
        assert_eq!(sixth.unwrap_err().code, "RATE_LIMITED");
        assert_eq!(
            launcher.opened.lock().len(),
            RATE_MAX,
            "a 6ª não chega ao SO"
        );
        // Recusa de validação não consome vaga nem chega ao SO.
        assert_eq!(
            state
                .open_at("file:///etc/passwd", t0 + Duration::from_secs(9))
                .unwrap_err()
                .code,
            "URL_SCHEME_NOT_ALLOWED"
        );
        // A 1ª abertura sai da janela 10 s depois dela: uma vaga volta.
        state
            .open_at("https://exemplo.org/", t0 + Duration::from_secs(10))
            .unwrap();
        assert_eq!(
            state
                .open_at("https://exemplo.org/", t0 + Duration::from_secs(10))
                .unwrap_err()
                .code,
            "RATE_LIMITED"
        );
        assert_eq!(launcher.opened.lock().len(), RATE_MAX + 1);
    }

    #[test]
    fn launcher_gets_serialized_url_once() {
        let launcher = Arc::new(FakeLauncher::default());
        let state = OpenerState::with_launcher(launcher.clone());
        state
            .open_at("HTTPS://Exemplo.org/a b?q=ç#c", Instant::now())
            .unwrap();
        assert_eq!(
            *launcher.opened.lock(),
            vec!["https://exemplo.org/a%20b?q=%C3%A7#c".to_owned()]
        );
    }

    #[test]
    fn open_failed_has_no_os_text() {
        let launcher = Arc::new(FakeLauncher {
            fail: true,
            ..Default::default()
        });
        let state = OpenerState::with_launcher(launcher.clone());
        let t0 = Instant::now();
        let error = state.open_at("https://exemplo.org/", t0).unwrap_err();
        assert_eq!(error, AppError::new("OPEN_FAILED"));
        assert!(error.detail.is_none());
        // Falhas não contam no anteparo: mais 5 tentativas ainda chegam ao lançador.
        for i in 1..=RATE_MAX {
            let at = t0 + Duration::from_millis(i as u64);
            assert_eq!(
                state.open_at("https://exemplo.org/", at).unwrap_err().code,
                "OPEN_FAILED"
            );
        }
        assert_eq!(launcher.opened.lock().len(), RATE_MAX + 1);
    }

    #[test]
    fn log_line_never_has_the_url() {
        let secret = "https://exemplo.org/token-SEGREDO?k=v";
        let line = log_line(secret, &Ok(()));
        assert_eq!(line, "opener: https -> ok");
        let refused = log_line(
            "javascript:alert('SEGREDO')",
            &Err(AppError::new("URL_SCHEME_NOT_ALLOWED")),
        );
        assert_eq!(refused, "opener: - -> URL_SCHEME_NOT_ALLOWED");
        assert!(!line.contains("SEGREDO") && !refused.contains("SEGREDO"));
    }
}
