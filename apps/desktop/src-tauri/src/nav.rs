//! Bloqueio de navegação, janelas novas e downloads (R-6.25, arch-backend r2 §1.3.7). Com código de
//! terceiros no mesmo realm, navegar para fora do app seria um canal de saída que a CSP não fecha:
//! o webview principal só navega dentro da origem do app.

use tauri::Url;

/// `true` só para a origem do app: `tauri://localhost` (macOS/Linux), `http(s)://tauri.localhost`
/// (Windows) e a origem do `devUrl` nos builds de desenvolvimento. `blob:`, `data:`, `about:`,
/// `file:`, `javascript:` e qualquer origem remota → `false` (navegação cancelada).
pub fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev.is_some_and(|d| {
                    d.scheme() == url.scheme()
                        && d.host_str() == url.host_str()
                        && d.port_or_known_default() == url.port_or_known_default()
                })
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn app_origins_allowed_everything_else_denied() {
        let dev = url("http://localhost:1420");
        let table: &[(&str, bool, bool)] = &[
            // (url, permitido sem dev, permitido com dev)
            ("tauri://localhost/", true, true),
            ("tauri://localhost/index.html#x", true, true),
            ("http://tauri.localhost/", true, true),
            ("https://tauri.localhost/assets/a.js", true, true),
            ("http://localhost:1420/", false, true),
            ("http://localhost:1421/", false, false),
            ("https://localhost:1420/", false, false),
            ("https://example.com/", false, false),
            ("http://example.com/", false, false),
            ("tauri://example.com/", false, false),
            ("blob:tauri://localhost/0d6c-uuid", false, false),
            ("data:text/html,<p>x</p>", false, false),
            ("about:blank", false, false),
            ("file:///etc/passwd", false, false),
            ("javascript:alert(1)", false, false),
            ("http://tauri.localhost.example.com/", false, false),
        ];
        for (s, without_dev, with_dev) in table {
            assert_eq!(is_app_url(&url(s), None), *without_dev, "{s} sem dev");
            assert_eq!(is_app_url(&url(s), Some(&dev)), *with_dev, "{s} com dev");
        }
    }
}
