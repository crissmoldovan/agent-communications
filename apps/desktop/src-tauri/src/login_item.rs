//! Start at login (DA2): off until the person switches it on in Settings, and kept by the system, not by the app.
//! On macOS it is the app's own login item, through SMAppService (macOS 13 and later), as Supbuddy's is; everywhere
//! else it is tauri-plugin-autostart's.

use crate::ipc::AppError;
use tauri::AppHandle;

/// Whether this system can start the app at login: macOS 13 or later, and every other platform.
pub fn available() -> bool {
    imp::available()
}

/// Whether the app starts at login now.
pub fn enabled(app: &AppHandle) -> bool {
    available() && imp::enabled(app)
}

/// Starts the app at login, or stops it.
pub fn set(app: &AppHandle, on: bool) -> Result<(), AppError> {
    if !available() {
        return Err(AppError::refused(
            "starting at login needs macOS 13 or later",
        ));
    }
    imp::set(app, on).map_err(|error| {
        AppError::io(format!(
            "start at login could not be switched {}: {error}",
            if on { "on" } else { "off" }
        ))
    })
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use tauri::AppHandle;

    pub fn available() -> bool {
        objc2::available!(macos = 13.0)
    }

    fn status() -> SMAppServiceStatus {
        // SAFETY: SMAppService exists from macOS 13, which `available` checks before any call here.
        unsafe { SMAppService::mainAppService().status() }
    }

    pub fn enabled(_app: &AppHandle) -> bool {
        status() == SMAppServiceStatus::Enabled
    }

    /// Registers the app's own login item, or unregisters it; nothing when it is already so.
    pub fn set(_app: &AppHandle, on: bool) -> Result<(), String> {
        let now = status();
        // SAFETY: as above; the service is the main app's, registered or unregistered as a whole.
        let result = unsafe {
            let service = SMAppService::mainAppService();
            if on {
                if now == SMAppServiceStatus::Enabled {
                    return Ok(());
                }
                service.registerAndReturnError()
            } else {
                if matches!(
                    now,
                    SMAppServiceStatus::NotRegistered | SMAppServiceStatus::NotFound
                ) {
                    return Ok(());
                }
                service.unregisterAndReturnError()
            }
        };
        result.map_err(|error| error.localizedDescription().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_autostart::ManagerExt;

    pub fn available() -> bool {
        true
    }

    pub fn enabled(app: &AppHandle) -> bool {
        app.autolaunch().is_enabled().unwrap_or(false)
    }

    pub fn set(app: &AppHandle, on: bool) -> Result<(), String> {
        let manager = app.autolaunch();
        if manager.is_enabled().unwrap_or(false) == on {
            return Ok(());
        }
        if on {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|error| error.to_string())
    }
}
