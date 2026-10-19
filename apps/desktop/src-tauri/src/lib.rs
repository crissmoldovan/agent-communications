//! Agent Comms: a tray app that shows this machine's agent-communications. It never sends, posts or approves.

pub mod allowlist;
pub mod commands;
pub mod deeplink;
pub mod grammar;
pub mod ipc;
pub mod launchers;
pub mod links;
pub mod login_item;
pub mod paths;
pub mod runner;
pub mod settings;
pub mod terminal;
pub mod tray;
pub mod updater;
pub mod version;
pub mod window;

use paths::FolderOverrides;
use std::sync::Mutex;

/// What the commands share: the folder overrides from Settings, loaded from `settings.json` at start (`settings`).
#[derive(Default)]
pub struct AppState {
    pub overrides: Mutex<FolderOverrides>,
}

/// Starts the app: its plugins, its state, its thirteen commands, the main window (`window::build_main`), the tray, the
/// deep links and the updater.
pub fn run() {
    let builder = tauri::Builder::default()
        // First: a second launch hands its arguments, and any agentcomms:// link in them, to this copy, and shows it.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show(app)
        }))
        .plugin(tauri_plugin_deep_link::init());
    // Only in a copy built with the updater key (DA8).
    let builder = if updater::UPDATER_ON {
        builder.plugin(tauri_plugin_updater::Builder::new().build())
    } else {
        builder
    };
    // Task 6's plugins, used from Rust only: the capability file grants the webview none of their commands.
    let builder = builder
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init());
    // The login item is SMAppService's on macOS (`login_item`), and autostart's everywhere else.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(window::app_menu);
    builder
        .manage(AppState::default())
        .manage(updater::Updates::default())
        .manage(deeplink::DeepLinks::default())
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
        .on_window_event(window::on_window_event)
        .setup(|app| {
            settings::load_into_state(app.handle());
            window::build_main(app.handle())?;
            tray::build(app.handle())?;
            deeplink::listen(app.handle());
            updater::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Agent Comms could not start")
        .run(window::on_run_event);
}
