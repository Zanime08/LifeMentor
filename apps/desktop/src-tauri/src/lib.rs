//! LifeMentor Windows shell (Tauri 2).
//!
//! The window loads the shared web bundle (apps/web/dist). Inside it, the
//! runtime-aware bootstrap detects the Tauri webview and switches to:
//!   • the native SQLite driver (`sql_*` commands in `db.rs` — rusqlite, WAL),
//!   • the Windows platform adapter (store plugin for secure storage, notification
//!     plugin with native scheduling, dialog+fs for files).
//!
//! The Rust side never sees AI keys or raw user text from the server — it only
//! executes controlled SQL for the local database (req. 24) and OS services.

mod db;

use db::AppState;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            db::sql_open,
            db::sql_close,
            db::sql_exec,
            db::sql_run,
            db::sql_all,
            db::sql_get,
            db::sql_pragma,
            db::sql_backup_bytes,
            db::sql_restore_bytes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running LifeMentor");
}
