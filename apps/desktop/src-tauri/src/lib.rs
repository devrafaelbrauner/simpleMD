//! Casca Tauri 2 do simpleMD (arch-backend §1.4; r2 §1.2). O webview não tem plugin fs nem
//! permissões de diálogo: todo acesso a arquivos passa pelo gateway do vault (`vault::*`, caminhos
//! relativos à pasta aberta, raiz guardada no Rust) e pelos diálogos de salvar/abrir com token
//! (`save_targets::*`). `app_mark` escreve as linhas de log das NFRs.

mod error;
mod save_targets;
mod vault;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

pub(crate) const MAIN: &str = "main";

/// A janela principal já foi destruída: daí em diante o app pode encerrar.
static MAIN_GONE: AtomicBool = AtomicBool::new(false);

/// Marcadores fechados (sem injeção de log): `simplemd:ready` (NFR-7) e
/// `simplemd:conflict-shown` (NFR-12), com o horário em ms desde a época.
#[derive(serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Marker {
    Ready,
    ConflictShown,
}

#[tauri::command]
fn app_mark(marker: Marker) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = match marker {
        Marker::Ready => "ready",
        Marker::ConflictShown => "conflict-shown",
    };
    println!("simplemd:{name} {ms}");
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

pub fn run() {
    // O plugin de diálogo fica registrado só para a API Rust (`DialogExt`); a capability não dá
    // nenhuma permissão `dialog:*` ao webview. O plugin fs não é registrado (AS-02).
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(vault::VaultState::default())
        .manage(save_targets::SaveTargets::default())
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
