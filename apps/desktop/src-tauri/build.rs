fn main() {
    // Comandos do app são negados por padrão até uma capability conceder `allow-<comando>`
    // (arch-backend §1.4.1; inventário r2 §1.8). `scripts/check-tauri-security.mjs` confere esta
    // lista contra o registro em `lib.rs` e a capability.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "pick_vault",
            "app_mark",
            "vault_read_dir",
            "vault_lstat",
            "vault_read_file",
            "vault_write_file",
            "vault_mkdir",
            "vault_watch",
            "vault_unwatch",
            "save_target_pick",
            "save_target_write",
            "open_file_pick",
            "plugin_approvals_get",
            "plugin_approval_set",
            "plugin_enabled_set",
            "plugin_approval_clear",
            "set_key",
            "has_key",
            "delete_key",
            "ai_send",
            "ai_cancel",
            "open_url",
            "vault_read_image",
            "lt_languages",
            "lt_check",
            "lt_cancel",
        ]),
    ))
    .expect("falha no build do Tauri");
}
