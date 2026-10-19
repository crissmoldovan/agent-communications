//! Agent Comms: a tray app that shows this machine's agent-communications. It never sends, posts or approves.

pub mod window;

/// Starts the app: the main window, built by `window::build_main`.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            window::build_main(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Agent Comms could not start");
}
