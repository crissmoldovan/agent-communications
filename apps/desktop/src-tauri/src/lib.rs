//! Agent Comms: a tray app that shows this machine's agent-communications. It never sends, posts or approves.

pub mod allowlist;
pub mod commands;
pub mod deeplink;
pub mod event_service;
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
use std::sync::{Arc, Mutex};

/// What the commands share: the folder overrides from Settings, loaded from `settings.json` at start (`settings`), and
/// the approvals the app's own previews wait on (`terminal::Prepared`).
#[derive(Default)]
pub struct AppState {
    pub overrides: Mutex<FolderOverrides>,
    pub prepared: Arc<terminal::Prepared>,
}

/// Starts the app: its plugins, its state, its fourteen commands, the main window (`window::build_main`), the tray, the
/// deep links and the updater.
pub fn run() {
    let builder = tauri::Builder::default();
    // First, on Windows and Linux: a second launch hands its arguments, and any agentcomms:// link in them, to this
    // copy, and shows it. macOS keeps one copy itself and hands it later links through the deep-link plugin's
    // open-url, so the plugin, whose socket another local user could reach, is not used there.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        window::show(app)
    }));
    let builder = builder.plugin(tauri_plugin_deep_link::init());
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
            commands::revoke_preview,
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

#[cfg(test)]
mod tests {
    /// The table `name` heads in `manifest`, through the line before the next table.
    fn table<'a>(manifest: &'a str, name: &str) -> &'a str {
        let start = manifest
            .find(&format!("\n{name}\n"))
            .unwrap_or_else(|| panic!("Cargo.toml has {name}"));
        let rest = &manifest[start + 1..];
        let end = rest[1..].find("\n[").map_or(rest.len(), |at| at + 1);
        &rest[..end]
    }

    /// macOS keeps one copy of the app itself, and hands it every later link (DA16, after review): the single-instance
    /// plugin, whose socket another local user can reach in a shared temporary folder, is not built for it.
    #[test]
    fn single_instance_is_left_out_on_macos() {
        let manifest = include_str!("../Cargo.toml");
        assert!(table(manifest, "[dependencies]")
            .find("tauri-plugin-single-instance")
            .is_none());
        assert!(table(
            manifest,
            "[target.'cfg(not(target_os = \"macos\"))'.dependencies]"
        )
        .contains(
            "tauri-plugin-single-instance = { version = \"2.5\", features = [\"deep-link\"] }"
        ));
        assert_eq!(manifest.matches("tauri-plugin-single-instance").count(), 1);
        let source = include_str!("lib.rs");
        let registered = source
            .find(".plugin(tauri_plugin_single_instance::init(")
            .expect("registered");
        let guard = source[..registered]
            .rfind("#[cfg(not(target_os = \"macos\"))]")
            .expect("a guard");
        assert!(
            !source[guard..registered].contains(';'),
            "the guard is on the registration itself"
        );
    }
}
