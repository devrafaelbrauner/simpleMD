//! APPSEC-R2-01 (B-06, W-01): canais de rede que a CSP não cobre.
//! Windows (WebView2): `--webrtc-ip-handling-policy=disable_non_proxied_udp` (switch da camada chrome,
//! vira a preferência `webrtc.ip_handling_policy`: nenhuma porta UDP nem STUN, em qualquer realm) e
//! proxy morto (`--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>`) para todo TCP do
//! webview: TURN por TCP/TLS, `preconnect`, `dns-prefetch` (sem DNS local quando há proxy). O app não
//! usa a rede pelo webview: tauri.localhost e ipc.localhost são atendidos antes da rede e a IA fala
//! pelo Rust. A `--force-webrtc-ip-handling-policy` do r3 só é lida pelo content_shell e pelo headless
//! do Chromium; no WebView2 não tinha efeito (F-WIN-01). `tauri dev` fica sem o proxy (o dev server
//! é http://localhost:1420), com o UDP fechado.
//! macOS (WKWebView): RTCPeerConnection e <link rel=preconnect> desligados por preferências
//! internas do WebKit, conferidas antes do uso (respondsToSelector / _features). Se o macOS
//! remover a preferência, o app abre normalmente e escreve UMA linha no stderr.

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Wry};

/// Os padrões do wry (que somem quando o campo é definido) + a política de WebRTC + o proxy morto.
#[cfg_attr(not(windows), allow(dead_code))]
pub const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--webrtc-ip-handling-policy=disable_non_proxied_udp \
--proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>";

/// `tauri dev`: os mesmos argumentos sem o proxy morto, que derrubaria o dev server.
#[cfg_attr(not(windows), allow(dead_code))]
pub const WEBVIEW2_DEV_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--webrtc-ip-handling-policy=disable_non_proxied_udp";

#[cfg_attr(not(windows), allow(dead_code))]
fn webview2_args(dev: bool) -> &'static str {
    if dev {
        WEBVIEW2_DEV_ARGS
    } else {
        WEBVIEW2_ARGS
    }
}

pub fn harden(
    builder: WebviewWindowBuilder<'_, Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    #[cfg(windows)]
    let builder = builder.additional_browser_args(webview2_args(tauri::is_dev()));
    #[cfg(target_os = "macos")]
    let builder = match macos::configuration() {
        Some(config) => builder.with_webview_configuration(config),
        None => builder,
    };
    builder
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol};
    use objc2::{msg_send, sel, ClassType, MainThreadMarker};
    use objc2_foundation::{NSArray, NSString};
    use objc2_web_kit::{WKPreferences, WKWebViewConfiguration};

    // `unsafe` abaixo (nosemgrep com a mesma justificativa): só chamadas Objective-C ao WebKit, na
    // thread principal (MainThreadMarker), com seletores conferidos antes (respondsToSelector /
    // `+_features`) e tipos de argumento e retorno iguais aos do método (BOOL, objeto, NSArray,
    // NSString). Nenhum ponteiro cru é criado ou desreferenciado aqui.

    /// Configuração nova (a mesma que o wry criaria) com WebRTC e preconnect desligados antes de a
    /// primeira página existir.
    pub fn configuration() -> Option<Retained<WKWebViewConfiguration>> {
        let Some(mtm) = MainThreadMarker::new() else {
            eprintln!("simplemd: WebRTC/preconnect não desligados (fora da thread principal)");
            return None;
        };
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let config = unsafe { WKWebViewConfiguration::new(mtm) };
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let prefs = unsafe { config.preferences() };
        if prefs.respondsToSelector(sel!(_setPeerConnectionEnabled:)) {
            // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
            let _: () = unsafe { msg_send![&*prefs, _setPeerConnectionEnabled: false] };
        } else {
            eprintln!(
                "simplemd: WKPreferences sem _setPeerConnectionEnabled:; WebRTC continua ligado"
            );
        }
        match link_preconnect(&prefs) {
            Some(feature) => {
                let _: () =
                    // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
                    unsafe { msg_send![&*prefs, _setEnabled: false, forFeature: &*feature] };
            }
            None => {
                eprintln!("simplemd: WKPreferences sem LinkPreconnect; preconnect continua ligado")
            }
        }
        Some(config)
    }

    /// O `_WKFeature` de chave "LinkPreconnect", se esta versão do WebKit o tiver.
    fn link_preconnect(prefs: &WKPreferences) -> Option<Retained<NSObject>> {
        let class = WKPreferences::class();
        if !class.metaclass().responds_to(sel!(_features))
            || !prefs.respondsToSelector(sel!(_setEnabled:forFeature:))
        {
            return None;
        }
        // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
        let features: Option<Retained<NSArray<NSObject>>> = unsafe { msg_send![class, _features] };
        features?.to_vec().into_iter().find(|feature| {
            feature.respondsToSelector(sel!(key)) && {
                // nosemgrep: rust.lang.security.unsafe-usage.unsafe-usage
                let key: Option<Retained<NSString>> = unsafe { msg_send![&**feature, key] };
                key.is_some_and(|key| key.to_string() == "LinkPreconnect")
            }
        })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn webview2_args_keep_wry_defaults_block_udp_and_send_tcp_to_a_dead_proxy() {
        assert_eq!(
            super::WEBVIEW2_ARGS,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --webrtc-ip-handling-policy=disable_non_proxied_udp \
             --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback>"
        );
    }

    #[test]
    fn webview2_dev_args_keep_the_policy_without_the_proxy() {
        assert_eq!(
            super::WEBVIEW2_DEV_ARGS,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --webrtc-ip-handling-policy=disable_non_proxied_udp"
        );
    }

    #[test]
    fn release_builds_get_the_dead_proxy_and_dev_builds_do_not() {
        assert_eq!(super::webview2_args(false), super::WEBVIEW2_ARGS);
        assert_eq!(super::webview2_args(true), super::WEBVIEW2_DEV_ARGS);
    }

    #[test]
    fn webview2_args_never_use_the_switch_webview2_ignores() {
        // F-WIN-01: --force-webrtc-ip-handling-policy só vale no content_shell/headless.
        for args in [super::WEBVIEW2_ARGS, super::WEBVIEW2_DEV_ARGS] {
            assert!(
                !args.contains("--force-webrtc-ip-handling-policy"),
                "{args}"
            );
        }
    }
}
