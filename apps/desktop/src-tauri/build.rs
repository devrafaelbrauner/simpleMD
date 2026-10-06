fn main() {
    // Comandos do app são negados por padrão até uma capability conceder
    // `allow-pick-vault` / `allow-app-mark` (arch-backend §1.4.1).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["pick_vault", "app_mark"])),
    )
    .expect("falha no build do Tauri");
}
