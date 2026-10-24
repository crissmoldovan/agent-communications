//! The main window: Supbuddy's shell (desktop design DA2), with nothing loaded but the app itself.

use crate::event_service::{self, QuitRoute};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::MenuEvent;
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

/// The app's own events. An exit the app did not start itself (`QUITTING` not set) is held while Quit asks about the
/// event service, or stops it first (P3); any other marks the app as quitting, so a close it causes is not turned into a
/// hide. On macOS, clicking the Dock icon shows the window again.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn on_run_event(app: &AppHandle, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { api, .. } => {
            if QUITTING.load(Ordering::SeqCst) {
                return;
            }
            match event_service::on_quit(app) {
                QuitRoute::Quit => QUITTING.store(true, Ordering::SeqCst),
                QuitRoute::Ask | QuitRoute::StopThenQuit => api.prevent_exit(),
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => {}
    }
}

/// The app menu's own Quit item. macOS's predefined Quit sends `terminate:`, which ends the app without an exit
/// request anyone can hold, so Cmd+Q is this item instead, and asks about the event service first (P3).
pub const QUIT_ITEM: &str = "app-quit";
pub const QUIT_LABEL: &str = "Quit Agent Comms";
pub const QUIT_KEYS: &str = "CmdOrCtrl+Q";

/// The macOS menu bar: Tauri's default, whose Close Window hides to the tray, with its Quit (Cmd+Q) the app's own.
#[cfg(target_os = "macos")]
pub fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
        let quit = first.items()?.iter().position(|item| {
            matches!(item, MenuItemKind::Predefined(predefined)
                if predefined.text().is_ok_and(|text| text.starts_with("Quit")))
        });
        if let Some(at) = quit {
            first.remove_at(at)?;
            let own = MenuItem::with_id(app, QUIT_ITEM, QUIT_LABEL, true, Some(QUIT_KEYS))?;
            first.insert(&own, at)?;
        }
    }
    Ok(menu)
}

/// The app menu's events: its Quit asks first, as the tray's does.
pub fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    if event.id().as_ref() == QUIT_ITEM && event_service::on_quit(app) == QuitRoute::Quit {
        event_service::quit(app);
    }
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

    /// Cmd+Q is the app's own item, and an exit the app did not start goes through the event service's question
    /// (P3): never Tauri's predefined Quit, which nothing can hold.
    #[test]
    fn cmd_q_and_an_unasked_exit_ask_about_the_event_service_first() {
        assert_eq!(QUIT_ITEM, "app-quit");
        assert_ne!(QUIT_ITEM, crate::tray::TrayAction::Quit.id());
        assert_eq!(QUIT_LABEL, "Quit Agent Comms");
        assert_eq!(QUIT_KEYS, "CmdOrCtrl+Q");
        let source = include_str!("window.rs");
        let code = &source[..source.find("#[cfg(test)]").expect("the tests")];
        let exit = &code[code
            .find("RunEvent::ExitRequested { api, .. } => {")
            .expect("the exit arm")..];
        let exit = &exit[..exit.find("#[cfg(target_os").expect("its end")];
        assert!(
            exit.contains("if QUITTING.load(Ordering::SeqCst)"),
            "{exit}"
        );
        assert!(exit.contains("event_service::on_quit(app)"), "{exit}");
        assert!(exit.contains("api.prevent_exit()"), "{exit}");
        let lib = include_str!("lib.rs");
        assert!(lib.contains(".on_menu_event(window::on_menu_event)"));
    }

    #[test]
    fn the_vite_origin_is_accepted_only_in_a_debug_build() {
        assert_eq!(
            is_app_origin(&url("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }
}
