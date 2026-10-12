use tauri::{App, Url};
include!(concat!(env!("OUT_DIR"), "/app_commands.rs"));

#[cfg(feature = "no-egress-probe")]
mod probe {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::Url;

    static COUNTERS: [AtomicUsize; 10] = [const { AtomicUsize::new(0) }; 10];

    fn base(label: &str) -> Option<usize> {
        match label {
            "settings" => Some(0),
            "secrets" => Some(5),
            _ => None,
        }
    }

    pub fn navigation(label: &str, url: &Url, allowed: bool) {
        let Some(base) = base(label) else { return };
        if url.scheme() == "desktop-probe" && !allowed {
            COUNTERS[base].fetch_add(1, Ordering::Relaxed);
        }
        if url.host_str() == Some("127.0.0.1") && !allowed {
            COUNTERS[base + 1].fetch_add(1, Ordering::Relaxed);
        }
        if allowed && (url.scheme() == "desktop-probe" || url.host_str() == Some("127.0.0.1")) {
            COUNTERS[base + 2].fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn download(label: &str) {
        if let Some(base) = base(label) {
            COUNTERS[base + 3].fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn popup(label: &str) {
        if let Some(base) = base(label) {
            COUNTERS[base + 4].fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn snapshot(label: &str) -> String {
        let Some(base) = base(label) else {
            return String::new();
        };
        let values = (0..5)
            .map(|index| COUNTERS[base + index].load(Ordering::Relaxed).to_string())
            .collect::<Vec<_>>();
        values.join(",")
    }
}

/// Register the app-wide navigation refusal before either webview is constructed.
pub fn install_security_before_windows(app: &mut App) -> tauri::Result<()> {
    app.handle().plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("desktop-security")
            .on_navigation(|_, url| allow_app_navigation(url))
            .build(),
    )
}

pub fn deny_download(label: &str) -> bool {
    #[cfg(feature = "no-egress-probe")]
    probe::download(label);
    #[cfg(not(feature = "no-egress-probe"))]
    let _ = label;
    false
}

pub fn deny_new_window(label: &str) -> tauri::webview::NewWindowResponse<tauri::Wry> {
    #[cfg(feature = "no-egress-probe")]
    probe::popup(label);
    #[cfg(not(feature = "no-egress-probe"))]
    let _ = label;
    tauri::webview::NewWindowResponse::Deny
}

#[cfg(feature = "no-egress-probe")]
pub fn probe_snapshot(label: &str) -> String {
    probe::snapshot(label)
}

pub fn allow_app_navigation(url: &Url) -> bool {
    is_app_origin(url)
}

/// The window callback is the effective first refusal; record its result before returning it.
pub fn allow_window_navigation(label: &str, url: &Url) -> bool {
    let allowed = allow_app_navigation(url);
    #[cfg(feature = "no-egress-probe")]
    probe::navigation(label, url, allowed);
    #[cfg(not(feature = "no-egress-probe"))]
    let _ = label;
    allowed
}

/// Accept only the compiled app origin. Debug builds may load the fixed Vite origin.
pub fn is_app_origin(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" if cfg!(target_os = "macos") => {
            url.host_str() == Some("localhost") && url.port().is_none()
        }
        "http" if !cfg!(target_os = "macos") && url.host_str() == Some("tauri.localhost") => {
            url.port().is_none()
        }
        "http" if cfg!(debug_assertions) => {
            url.host_str() == Some("localhost") && url.port() == Some(1420)
        }
        _ => false,
    }
}
