//! Start at login (DA2): off until the person switches it on in Settings, and kept by the system, not by the app.
//! On macOS it is the app's own login item, through SMAppService (macOS 13 and later), as Supbuddy's is; everywhere
//! else it is tauri-plugin-autostart's.

use crate::ipc::AppError;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tauri::AppHandle;

/// How long the app waits for the system to say whether it starts at login, or to switch it.
///
/// On a Mac whose login-items service does not answer (macOS 14's `backgroundtaskmanagementd` restarting every few
/// seconds, which Apple's own `sfltool dumpbtm` hangs on too), `SMAppService` waits for ever. The app used to ask on
/// its main thread, so opening Settings froze the whole window (2026-10-24, desktop-v0.26.1). Now it asks on a thread
/// of its own, waits this long, and says the system did not answer.
pub const SYSTEM_ANSWER_TIMEOUT: Duration = Duration::from_secs(3);

/// What the app says when the system does not answer in time.
pub const NOT_ANSWERING: &str =
    "macOS did not answer about starting at login: its login-items service is not \
responding. Restarting the Mac usually brings it back.";

/// Set while a question to the system is still unanswered.
static WAITING: AtomicBool = AtomicBool::new(false);

/// Whether this system can start the app at login: macOS 13 or later, and every other platform.
pub fn available() -> bool {
    imp::available()
}

/// Whether the app starts at login now, or `None` when the system did not answer within `SYSTEM_ANSWER_TIMEOUT`.
pub fn enabled(app: &AppHandle) -> Option<bool> {
    if !available() {
        return Some(false);
    }
    let app = app.clone();
    within(&WAITING, SYSTEM_ANSWER_TIMEOUT, move || imp::enabled(&app))
}

/// Starts the app at login, or stops it.
pub fn set(app: &AppHandle, on: bool) -> Result<(), AppError> {
    if !available() {
        return Err(AppError::refused(
            "starting at login needs macOS 13 or later",
        ));
    }
    let app = app.clone();
    match within(&WAITING, SYSTEM_ANSWER_TIMEOUT, move || imp::set(&app, on)) {
        None => Err(AppError::io(NOT_ANSWERING)),
        Some(result) => result.map_err(|error| {
            AppError::io(format!(
                "start at login could not be switched {}: {error}",
                if on { "on" } else { "off" }
            ))
        }),
    }
}

/// Runs `work` on a thread of its own and waits at most `timeout` for its answer: `None` when it has none by then.
///
/// A question the system never answers keeps its thread, which nothing can cancel. While one is still waiting
/// (`waiting` set), no other thread is started, and the answer is `None` at once: a service that has stopped
/// answering costs one thread, not one for every time Settings opens.
fn within<T: Send + 'static>(
    waiting: &'static AtomicBool,
    timeout: Duration,
    work: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if waiting.swap(true, Ordering::SeqCst) {
        return None;
    }
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("login-item".into())
        .spawn(move || {
            let answer = work();
            waiting.store(false, Ordering::SeqCst);
            let _ = sender.send(answer);
        });
    if spawned.is_err() {
        waiting.store(false, Ordering::SeqCst);
        return None;
    }
    receiver.recv_timeout(timeout).ok()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2_service_management::{SMAppService, SMAppServiceStatus};
    use tauri::AppHandle;

    pub fn available() -> bool {
        objc2::available!(macos = 13.0)
    }

    fn status() -> SMAppServiceStatus {
        // SAFETY: SMAppService exists from macOS 13, which `available` checks before any call here. It is asked on
        // the `login-item` thread (`within`), which has no autorelease pool of its own, so it gets one here.
        objc2::rc::autoreleasepool(|_| unsafe { SMAppService::mainAppService().status() })
    }

    pub fn enabled(_app: &AppHandle) -> bool {
        status() == SMAppServiceStatus::Enabled
    }

    /// Registers the app's own login item, or unregisters it; nothing when it is already so.
    pub fn set(_app: &AppHandle, on: bool) -> Result<(), String> {
        let now = status();
        // SAFETY: as above; the service is the main app's, registered or unregistered as a whole.
        let result = objc2::rc::autoreleasepool(|_| unsafe {
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
        });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    #[test]
    fn an_answer_in_time_is_the_answer() {
        static WAITING: AtomicBool = AtomicBool::new(false);
        assert_eq!(within(&WAITING, Duration::from_secs(5), || 7), Some(7));
        assert!(!WAITING.load(Ordering::SeqCst), "nothing is left waiting");
    }

    #[test]
    fn a_system_that_never_answers_costs_its_timeout_once_and_one_thread() {
        static WAITING: AtomicBool = AtomicBool::new(false);
        static STARTED: AtomicUsize = AtomicUsize::new(0);
        let (release, stuck) = mpsc::channel::<()>();

        // The question that hangs, as SMAppService does when the login-items service is down: none, after the
        // timeout, and not for ever.
        let asked = Instant::now();
        let answer = within(&WAITING, Duration::from_millis(100), move || {
            STARTED.fetch_add(1, Ordering::SeqCst);
            let _ = stuck.recv();
            1
        });
        assert_eq!(answer, None);
        assert!(
            asked.elapsed() < Duration::from_secs(2),
            "it waited its timeout, not for ever"
        );

        // While it still waits: none at once, and no second thread.
        let again = Instant::now();
        assert_eq!(
            within(&WAITING, Duration::from_secs(5), || {
                STARTED.fetch_add(1, Ordering::SeqCst);
                2
            }),
            None
        );
        assert!(
            again.elapsed() < Duration::from_millis(500),
            "answered at once"
        );
        assert_eq!(STARTED.load(Ordering::SeqCst), 1);

        // Once the stuck question ends, the next one is asked again.
        release.send(()).expect("the stuck thread is there");
        let deadline = Instant::now() + Duration::from_secs(5);
        while WAITING.load(Ordering::SeqCst) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(within(&WAITING, Duration::from_secs(5), || 3), Some(3));
    }
}
