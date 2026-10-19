//! The main window: Supbuddy's shell (desktop design DA2), with nothing loaded but the app itself.

use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// The one window's label, which the capability file grants (`capabilities/default.json`).
pub const MAIN: &str = "main";

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
        "http" if cfg!(windows) && url.host_str() == Some("tauri.localhost") => url.port().is_none(),
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
    fn the_vite_origin_is_accepted_only_in_a_debug_build() {
        assert_eq!(
            is_app_origin(&url("http://localhost:1420/")),
            cfg!(debug_assertions)
        );
    }
}
