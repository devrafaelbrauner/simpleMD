//! APPSEC-R2-01 (B-06): canais de rede que a CSP não cobre.
//! Windows (WebView2): STUN/UDP desligado por argumento do Chromium. TURN por TCP continua
//! possível (resíduo documentado em docs/plugins.md item 5).
//! macOS (WKWebView): RTCPeerConnection e <link rel=preconnect> desligados por preferências
//! internas do WebKit, conferidas antes do uso (respondsToSelector / _features). Se o macOS
//! remover a preferência, o app abre normalmente e escreve UMA linha no stderr.

use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Wry};

/// Os padrões do wry (que somem quando o campo é definido) + a política de WebRTC.
#[cfg_attr(not(windows), allow(dead_code))]
pub const WEBVIEW2_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
--force-webrtc-ip-handling-policy=disable_non_proxied_udp";

pub fn harden(
    builder: WebviewWindowBuilder<'_, Wry, AppHandle>,
) -> WebviewWindowBuilder<'_, Wry, AppHandle> {
    #[cfg(windows)]
    let builder = builder.additional_browser_args(WEBVIEW2_ARGS);
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
    fn webview2_args_keep_wry_defaults_and_add_webrtc_policy() {
        assert_eq!(
            super::WEBVIEW2_ARGS,
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection \
             --force-webrtc-ip-handling-policy=disable_non_proxied_udp"
        );
    }
}
