pub mod commands;
pub mod control;
pub mod preferences;
pub mod preview;
pub mod security;
pub mod supervisor;
mod tray;
pub mod untrusted_result;

use tauri::Manager;
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
fn desktop_probe_capability_mode(window: tauri::WebviewWindow) -> Option<String> {
    (std::env::var("DESKTOP_PROBE_CAPABILITIES").as_deref() == Ok("1"))
        .then(|| window.label().to_owned())
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
        if window.label() == "secrets"
            && matches!(
                event,
                WindowEvent::CloseRequested { .. }
                    | WindowEvent::Destroyed
                    | WindowEvent::Focused(false)
            )
        {
            if let Some(service) = window.try_state::<commands::supervision::DesktopService>() {
                service.secrets.clear();
            }
            if let Some(secrets) = window.app_handle().get_webview_window("secrets") {
                let _ = secrets.eval("window.dispatchEvent(new Event('agentcomms:secret-clear'))");
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }
        if window.label() == "settings" {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        }
    });
    #[cfg(not(feature = "no-egress-probe"))]
    let builder = builder.invoke_handler(crate::desktop_secret_command_handler!(
        commands::supervision::desktop_supervision_status,
        commands::supervision::desktop_start_daemon,
        commands::supervision::desktop_quit_daemon,
        commands::supervision::desktop_open_secrets,
        commands::control::desktop_control,
        commands::control::desktop_approve,
        commands::control::desktop_preferences,
    ));
    #[cfg(feature = "no-egress-probe")]
    let builder = builder.invoke_handler(crate::desktop_secret_command_handler!(
        commands::supervision::desktop_supervision_status,
        commands::supervision::desktop_start_daemon,
        commands::supervision::desktop_quit_daemon,
        commands::supervision::desktop_open_secrets,
        commands::control::desktop_control,
        commands::control::desktop_approve,
        commands::control::desktop_preferences,
        desktop_probe_ping,
        desktop_probe_port,
        desktop_probe_capability_mode,
        desktop_probe_report
    ));
    builder
        .setup(|app| {
            security::install_security_before_windows(app)?;
            tray::install_tray(app)?;
            let preferences_path = app
                .path()
                .app_local_data_dir()?
                .join("preferences")
                .join("desktop.json");
            app.manage(commands::supervision::DesktopService::new(preferences_path));
            WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("settings.html".into()))
                .title("Settings")
                .on_navigation(|url| security::allow_window_navigation("settings", url))
                .on_new_window(|_, _| security::deny_new_window("settings"))
                .on_download(|_, _| security::deny_download("settings"))
                .build()?;
            let secret_handle = app.handle().clone();
            WebviewWindowBuilder::new(app, "secrets", WebviewUrl::App("secrets.html".into()))
                .title("Secrets")
                .visible(false)
                .on_navigation(move |url| {
                    let allowed = security::allow_window_navigation("secrets", url);
                    if !allowed {
                        if let Some(service) =
                            secret_handle.try_state::<commands::supervision::DesktopService>()
                        {
                            service.secrets.clear();
                        }
                        if let Some(window) = secret_handle.get_webview_window("secrets") {
                            let _ = window.eval(
                                "window.dispatchEvent(new Event('agentcomms:navigation-failure'))",
                            );
                        }
                    }
                    allowed
                })
                .on_new_window(|_, _| security::deny_new_window("secrets"))
                .on_download(|_, _| security::deny_download("secrets"))
                .build()?;
            #[cfg(feature = "no-egress-probe")]
            if std::env::var("DESKTOP_PROBE_CAPABILITIES").as_deref() == Ok("1") {
                WebviewWindowBuilder::new(
                    app,
                    "synthetic-third",
                    WebviewUrl::App("secrets.html".into()),
                )
                .visible(false)
                .on_navigation(|url| security::allow_window_navigation("synthetic-third", url))
                .on_new_window(|_, _| security::deny_new_window("synthetic-third"))
                .on_download(|_, _| security::deny_download("synthetic-third"))
                .build()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}
