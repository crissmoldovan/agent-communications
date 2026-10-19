//! Agent Comms: a tray app that shows this machine's agent-communications. It never sends, posts or approves.

pub mod allowlist;
pub mod commands;
pub mod grammar;
pub mod ipc;
pub mod launchers;
pub mod links;
pub mod login_item;
pub mod paths;
pub mod runner;
pub mod settings;
pub mod terminal;
pub mod version;
pub mod window;

use paths::FolderOverrides;
use std::sync::Mutex;

/// What the commands share: the folder overrides from Settings, loaded from `settings.json` at start (`settings`).
#[derive(Default)]
pub struct AppState {
    pub overrides: Mutex<FolderOverrides>,
}

/// Starts the app: its state, its thirteen commands, and the main window, built by `window::build_main`.
pub fn run() {
    // Task 6's plugins, used from Rust only: the capability file grants the webview none of their commands.
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init());
    // The login item is SMAppService's on macOS (`login_item`), and autostart's everywhere else.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::installation,
            commands::cli,
            commands::open_in_terminal,
            commands::copy_text,
            commands::open_link,
            commands::open_profile,
            commands::get_settings,
            commands::set_folders,
            commands::set_login_item,
            commands::updater_state,
            commands::check_for_updates,
            commands::install_update,
            commands::take_deep_link,
        ])
        .setup(|app| {
            settings::load_into_state(app.handle());
            window::build_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Agent Comms could not start");
}
