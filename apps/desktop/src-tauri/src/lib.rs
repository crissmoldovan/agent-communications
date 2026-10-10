pub mod security;
mod tray;

use tauri::{WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[cfg(feature = "no-egress-probe")]
#[tauri::command]
fn desktop_probe_ping() -> &'static str {
    "pong"
}

#[cfg(feature = "no-egress-probe")]
#[tauri::command]
fn desktop_probe_port() -> u16 {
    std::env::var("DESKTOP_PROBE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0)
}

#[cfg(feature = "no-egress-probe")]
#[tauri::command]
fn desktop_probe_report(window: tauri::WebviewWindow, report: String) {
    use tauri::Manager;
    if report.len() < 8192
        && report
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_,-:|".contains(c))
    {
        println!(
            "desktop-probe:{}:{}:{}:{}",
            window.label(),
            window.app_handle().webview_windows().len(),
            security::probe_snapshot(window.label()),
            report
        );
    }
}

pub fn run() {
    let builder = tauri::Builder::default().on_window_event(|window, event| {
        if window.label() == "settings" {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });
    #[cfg(feature = "no-egress-probe")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        desktop_probe_ping,
        desktop_probe_port,
        desktop_probe_report
    ]);
    builder
        .setup(|app| {
            security::install_security_before_windows(app)?;
            tray::install_tray(app)?;
            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                .title("Settings")
                .on_navigation(|url| security::allow_window_navigation("settings", url))
                .on_new_window(|_, _| security::deny_new_window("settings"))
                .on_download(|_, _| security::deny_download("settings"))
                .build()?;
            WebviewWindowBuilder::new(app, "secrets", WebviewUrl::App("secrets.html".into()))
                .title("Secrets")
                .visible(false)
                .on_navigation(|url| security::allow_window_navigation("secrets", url))
                .on_new_window(|_, _| security::deny_new_window("secrets"))
                .on_download(|_, _| security::deny_download("secrets"))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}
