//! Casca Tauri 2 do simpleMD (arch-backend §1.4). O Rust tem só dois comandos: `pick_vault`
//! (diálogo de pasta + escopo de fs em tempo de execução) e `app_mark` (linhas de log das NFRs).
//! Toda leitura e escrita de arquivos passa pelo plugin fs, limitado ao escopo concedido aqui.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;

const MAIN: &str = "main";

/// A janela principal já foi destruída: daí em diante o app pode encerrar.
static MAIN_GONE: AtomicBool = AtomicBool::new(false);

/// Abre o diálogo nativo de pasta e concede o escopo de fs só para a pasta escolhida e para
/// `<pasta>/.simplemd` (a concessão literal satisfaz `require_literal_leading_dot` no macOS).
/// Não recebe argumentos: o webview não consegue pedir um caminho arbitrário.
#[tauri::command]
async fn pick_vault(app: AppHandle) -> Result<Option<String>, String> {
    // Comando assíncrono → fora da thread principal, então o diálogo bloqueante é permitido.
    let Some(picked) = app.dialog().file().set_title("Abrir pasta").blocking_pick_folder() else {
        return Ok(None);
    };
    let root = picked.into_path().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("NOT_A_DIRECTORY".into());
    }
    let root_str = root.to_str().ok_or("INVALID_PATH")?.to_owned();
    let scope = app.fs_scope();
    scope.allow_directory(&root, true).map_err(|e| e.to_string())?;
    scope
        .allow_directory(root.join(".simplemd"), true)
        .map_err(|e| e.to_string())?;
    Ok(Some(root_str))
}

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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_vault, app_mark])
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
