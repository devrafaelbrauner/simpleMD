//! Casca Tauri 2 do simpleMD (arch-backend §1.4; r2 §1.2, §1.3). O webview não tem plugin fs nem
//! permissões de diálogo: todo acesso a arquivos passa pelo gateway do vault (`vault::*`, caminhos
//! relativos à pasta aberta, raiz guardada no Rust) e pelos diálogos de salvar/abrir com token
//! (`save_targets::*`). As aprovações de plugins ficam nos dados do app (`plugins::*`). A janela
//! principal é criada aqui com navegação, janelas novas e downloads bloqueados (`nav`, R-6.25).
//! A IA (`ai::*`) faz o HTTP no Rust e guarda as chaves só no keychain (D-20, D-21).
//! `app_mark` escreve as linhas de log das NFRs.

pub mod ai;
mod error;
mod nav;
mod plugins;
mod save_targets;
mod vault;
mod webview_net;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::webview::{NewWindowResponse, WebviewWindowBuilder};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

pub(crate) const MAIN: &str = "main";

/// A janela principal já foi destruída: daí em diante o app pode encerrar.
static MAIN_GONE: AtomicBool = AtomicBool::new(false);

/// Marcadores fechados (sem injeção de log): `simplemd:ready` (NFR-7), `simplemd:conflict-shown`
/// (NFR-12), `simplemd:plugin-active` (NFR-19), `simplemd:catalog-shown` (NFR-26),
/// `ai:first-paint` (NFR-33e; o par nativo `ai:first-byte` sai do transporte) e
/// `simplemd:export-print` (NFR-32: o pedido do painel de impressão), com o horário em ms desde a
/// época.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Marker {
    Ready,
    ConflictShown,
    PluginActive,
    CatalogShown,
    AiFirstPaint,
    ExportPrint,
}

impl Marker {
    fn line(&self) -> &'static str {
        match self {
            Marker::Ready => "simplemd:ready",
            Marker::ConflictShown => "simplemd:conflict-shown",
            Marker::PluginActive => "simplemd:plugin-active",
            Marker::CatalogShown => "simplemd:catalog-shown",
            Marker::AiFirstPaint => "ai:first-paint",
            Marker::ExportPrint => "simplemd:export-print",
        }
    }
}

#[tauri::command]
fn app_mark(marker: Marker) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    println!("{} {ms}", marker.line());
}

/// Menu próprio do macOS (arch-backend §1.4.6): "Sair" (Cmd+Q) é um item customizado que fecha a
/// janela pelo mesmo caminho do botão fechar (flush no JS). Não há item ligado a Cmd+W, então o
/// atalho chega ao webview e fecha a aba ativa.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let quit = MenuItemBuilder::with_id("sair", "Sair do simpleMD")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "simpleMD")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "Editar")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "Janela")
        .minimize()
        .maximize()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

fn close_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        // Emite CloseRequested → o JS faz o flush e destrói a janela (ou a mantém aberta).
        let _ = window.close();
    }
}

/// Cria a janela `main` a partir do `tauri.conf.json` (`create: false` lá) com os guardas de
/// navegação: só a origem do app; `window.open`/`target=_blank` negados; nenhum download.
fn build_main_window(app: &tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .cloned()
        .expect("tauri.conf.json sem a janela main");
    let dev = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| nav::is_app_url(url, dev.as_ref()))
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false);
    webview_net::harden(builder).build()?;
    Ok(())
}

pub fn run() {
    // O plugin de diálogo fica registrado só para a API Rust (`DialogExt`); a capability não dá
    // nenhuma permissão `dialog:*` ao webview. O plugin fs não é registrado (AS-02).
    // Um armazém de chaves (keychain do sistema) compartilhado pelos comandos de chave e pelo
    // transporte de IA, que lê a chave por pedido e nunca a devolve ao webview.
    let secrets: Arc<dyn ai::keys::SecretStore> =
        Arc::new(ai::keys::KeyringStore::new(ai::keys::SERVICE));
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::VaultState::default())
        .manage(save_targets::SaveTargets::default())
        .manage(ai::keys::Keys(secrets.clone()))
        .manage(ai::AiState::new(ai::transport::Transport::new(secrets)))
        .setup(|app| {
            app.manage(plugins::Approvals::new(&app.path().app_data_dir()?));
            app.manage(ai::keys::KeyConfirm(Arc::new(ai::keys::OneAtATime::new(
                ai::keys::NativeConfirm(app.handle().clone()),
            ))));
            build_main_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::pick_vault,
            app_mark,
            vault::vault_read_dir,
            vault::vault_lstat,
            vault::vault_read_file,
            vault::vault_write_file,
            vault::vault_mkdir,
            vault::vault_watch,
            vault::vault_unwatch,
            save_targets::save_target_pick,
            save_targets::save_target_write,
            save_targets::open_file_pick,
            plugins::plugin_approvals_get,
            plugins::plugin_approval_set,
            plugins::plugin_enabled_set,
            plugins::plugin_approval_clear,
            ai::keys::set_key,
            ai::keys::has_key,
            ai::keys::delete_key,
            ai::ai_send,
            ai::ai_cancel,
        ])
        .on_window_event(|window, event| {
            if window.label() == MAIN && matches!(event, WindowEvent::Destroyed) {
                MAIN_GONE.store(true, Ordering::SeqCst);
            }
        });

    #[cfg(target_os = "macos")]
    let builder = builder.menu(build_menu).on_menu_event(|app, event| {
        if event.id() == "sair" {
            close_main(app);
        }
    });

    builder
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o simpleMD")
        .run(|app, event| {
            // Segunda rede para saídas fora do menu (Dock → Encerrar, logout): passa pelo mesmo
            // caminho de fechar a janela, que faz o flush. Depois que a janela some, o app sai.
            if let RunEvent::ExitRequested { api, .. } = event {
                if !MAIN_GONE.load(Ordering::SeqCst) && app.get_webview_window(MAIN).is_some() {
                    api.prevent_exit();
                    close_main(app);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::Marker;

    #[test]
    fn markers_are_a_closed_kebab_case_set() {
        let cases = [
            ("ready", "simplemd:ready"),
            ("conflict-shown", "simplemd:conflict-shown"),
            ("plugin-active", "simplemd:plugin-active"),
            ("catalog-shown", "simplemd:catalog-shown"),
            ("ai-first-paint", "ai:first-paint"),
            ("export-print", "simplemd:export-print"),
        ];
        for (wire, line) in cases {
            let marker: Marker = serde_json::from_value(serde_json::json!(wire)).unwrap();
            assert_eq!(marker.line(), line);
        }
        // Texto livre nunca vira linha de log (sem injeção).
        assert!(
            serde_json::from_value::<Marker>(serde_json::json!("simplemd:ready\nfalso")).is_err()
        );
    }
}
