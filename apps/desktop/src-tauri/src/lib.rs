//! Agent Comms: a tray app that shows this machine's agent-communications. It never sends, posts or approves.

pub mod allowlist;
pub mod commands;
pub mod grammar;
pub mod ipc;
pub mod launchers;
pub mod paths;
pub mod runner;
pub mod version;
pub mod window;

use paths::FolderOverrides;
use std::sync::Mutex;

/// What the commands share: the folder overrides from Settings, empty until Task 6 loads them at start.
#[derive(Default)]
pub struct AppState {
    pub overrides: Mutex<FolderOverrides>,
}

/// Starts the app: its state, its thirteen commands, and the main window, built by `window::build_main`.
pub fn run() {
    tauri::Builder::default()
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
            window::build_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Agent Comms could not start");
}
