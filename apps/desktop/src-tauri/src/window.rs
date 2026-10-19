//! The main window: Supbuddy's shell (desktop design DA2), with nothing loaded but the app itself.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    Window, WindowEvent,
};

/// The one window's label, which the capability file grants (`capabilities/default.json`).
pub const MAIN: &str = "main";

/// Set once the app is quitting (Quit in the tray, Cmd+Q, an update's restart): from then on a close closes.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

/// What closing the window does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide it to the tray: the app keeps running.
    Hide,
    /// Let it close: the app is quitting.
    Close,
}

/// Closing hides the window to the tray, unless the app is quitting (DA2).
pub fn on_close(quitting: bool) -> CloseAction {
    if quitting {
        CloseAction::Close
    } else {
        CloseAction::Hide
    }
}

/// The event that tells the window whether it can be seen: the UI polls only while it can (DA4).
pub const VISIBILITY: &str = "window-visibility";

#[derive(Clone, Serialize)]
struct Visibility {
    visible: bool,
}

/// Shows the main window and brings it forward: Open in the tray, the Dock icon, a deep link, a second launch.
pub fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit(VISIBILITY, Visibility { visible: true });
}

/// Closing the main window hides it to the tray, unless the app is quitting.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        if on_close(QUITTING.load(Ordering::SeqCst)) == CloseAction::Hide {
            api.prevent_close();
            let _ = window.hide();
            let _ = window.emit(VISIBILITY, Visibility { visible: false });
        }
    }
}

/// The app's own events: any exit (Quit, Cmd+Q, an update's restart) marks the app as quitting, so a close it causes is
/// not turned into a hide; on macOS, clicking the Dock icon shows the window again.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { .. } => QUITTING.store(true, Ordering::SeqCst),
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    }
}

/// The macOS menu bar: Tauri's default, whose Quit (Cmd+Q) quits and whose Close Window hides to the tray.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    tauri::menu::Menu::default(app)
}

/// Builds the main window: 1200×800, never smaller than 900×600, its title bar over the app's header on macOS.
///
/// It goes nowhere but the app's own origin, opens no other window and downloads nothing.
pub fn build_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Agent Comms")
        .inner_size(1200.0, 800.0)
        .min_inner_size(900.0, 600.0)
        .on_navigation(is_app_origin)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder.build()
}

/// Accepts only the compiled app's origin; a debug build may also load the fixed Vite origin.
///
/// Phase C's (`feat/events-c`, `security.rs`), with one correction: Tauri serves the app from `tauri://localhost` on
/// Linux as well as macOS, and from `http://tauri.localhost` only on Windows (`tauri::protocol::origin`), so Linux is
/// accepted at its own origin rather than refused there.
pub fn is_app_origin(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" if !cfg!(windows) => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" if cfg!(windows) && url.host_str() == Some("tauri.localhost") => {
            url.port().is_none()
        }
        "http" if cfg!(debug_assertions) => {
            url.host_str() == Some("localhost") && url.port() == Some(1420)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).expect("a test URL parses")
    }

    #[test]
    fn the_app_origin_is_the_only_one_accepted() {
        let own = if cfg!(windows) {
            "http://tauri.localhost/index.html"
        } else {
            "tauri://localhost/index.html"
        };
        assert!(is_app_origin(&url(own)));
        for other in [
            "https://example.com/",
            "http://localhost:8080/",
            "tauri://localhost:1/",
            "tauri://user:secret@localhost/",
            "file:///etc/passwd",
            "data:text/html,hello",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_origin(&url(other)), "{other} was accepted");
        }
        // The other platforms' origins are not this one's.
        let foreign = if cfg!(windows) {
            "tauri://localhost/"
        } else {
            "http://tauri.localhost/"
        };
        assert!(!is_app_origin(&url(foreign)));
    }

    #[test]
    fn close_hides_unless_quitting() {
        assert_eq!(on_close(false), CloseAction::Hide);
        assert_eq!(on_close(true), CloseAction::Close);
        // The app starts not quitting, so the first close hides.
        assert!(!QUITTING.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn the_vite_origin_is_accepted_only_in_a_debug_build() {
        assert_eq!(
            is_app_origin(&url("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }
}
