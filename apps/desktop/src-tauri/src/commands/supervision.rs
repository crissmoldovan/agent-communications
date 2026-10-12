#[cfg(windows)]
use crate::control::types::ControlError;
#[cfg(unix)]
use crate::preferences::DaemonProfile;
#[cfg(unix)]
use crate::preferences::DesktopPreferences;
use crate::preferences::PreferenceStore;
#[cfg(unix)]
use crate::supervisor::SupervisorStatus;
use crate::supervisor::{DesktopSupervisor, SupervisorState};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{Manager, State, WebviewWindow};

pub struct DesktopService {
    pub secrets: super::secrets::SecretLifecycle,
    pub store: PreferenceStore,
    pub supervisor: DesktopSupervisor,
    pub control: std::sync::Mutex<super::control::ControlState>,
}
impl DesktopService {
    pub fn new(preferences_path: PathBuf) -> Self {
        Self {
            secrets: super::secrets::SecretLifecycle::default(),
            store: PreferenceStore::new(preferences_path),
            supervisor: DesktopSupervisor::default(),
            control: std::sync::Mutex::default(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisionView {
    pub revision: u64,
    pub keep_collecting_after_quit: bool,
    pub profile_configured: bool,
    pub state: SupervisorState,
    pub attached: bool,
}

#[cfg(unix)]
fn view(preferences: DesktopPreferences, supervisor: SupervisorStatus) -> SupervisionView {
    SupervisionView {
        revision: preferences.revision,
        keep_collecting_after_quit: preferences.keep_collecting_after_quit,
        profile_configured: preferences.daemon_profile.is_some(),
        state: supervisor.state,
        attached: supervisor.attached,
    }
}

fn settings_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings" {
        Ok(())
    } else {
        Err("WINDOW_NOT_AUTHORIZED".into())
    }
}

#[tauri::command]
pub fn desktop_supervision_status(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
) -> Result<SupervisionView, String> {
    settings_only(&window)?;
    #[cfg(windows)]
    {
        let _ = service;
        Err(ControlError::windows_unavailable().code)
    }
    #[cfg(unix)]
    {
        let preferences = service.store.load().map_err(|e| e.code)?;
        Ok(view(preferences, service.supervisor.startup()))
    }
}

#[tauri::command]
pub fn desktop_start_daemon(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    executable: PathBuf,
    state_dir: PathBuf,
    config_dir: PathBuf,
    expected_revision: u64,
    keep_collecting_after_quit: bool,
) -> Result<SupervisionView, String> {
    settings_only(&window)?;
    #[cfg(windows)]
    {
        let _ = (
            service,
            executable,
            state_dir,
            config_dir,
            expected_revision,
            keep_collecting_after_quit,
        );
        Err(ControlError::windows_unavailable().code)
    }
    #[cfg(unix)]
    {
        let profile = DaemonProfile::new(executable, state_dir, config_dir).map_err(|e| e.code)?;
        let supervisor = service
            .supervisor
            .start_selected(
                &service.store,
                expected_revision,
                profile,
                keep_collecting_after_quit,
            )
            .map_err(|e| e.code)?;
        let preferences = service.store.load().map_err(|e| e.code)?;
        Ok(view(preferences, supervisor))
    }
}

#[tauri::command]
pub fn desktop_quit_daemon(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
) -> Result<SupervisionView, String> {
    settings_only(&window)?;
    #[cfg(windows)]
    {
        let _ = service;
        Err(ControlError::windows_unavailable().code)
    }
    #[cfg(unix)]
    {
        let supervisor = service
            .supervisor
            .stop_daemon(&service.store)
            .map_err(|e| e.code)?;
        let preferences = service.store.load().map_err(|e| e.code)?;
        Ok(view(preferences, supervisor))
    }
}

#[tauri::command]
pub fn desktop_open_secrets(window: WebviewWindow) -> Result<(), String> {
    settings_only(&window)?;
    let secrets = window
        .app_handle()
        .get_webview_window("secrets")
        .ok_or("SECRETS_WINDOW_UNAVAILABLE")?;
    secrets
        .show()
        .map_err(|_| "SECRETS_WINDOW_UNAVAILABLE".to_string())?;
    secrets
        .set_focus()
        .map_err(|_| "SECRETS_WINDOW_UNAVAILABLE".to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn supervision_view_exposes_only_five_nonsecret_fields() {
        let value = serde_json::to_value(view(
            DesktopPreferences::default(),
            DesktopSupervisor::default().status(),
        ))
        .unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<_> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "attached",
                "keepCollectingAfterQuit",
                "profileConfigured",
                "revision",
                "state"
            ]
        );
        assert_eq!(value["state"], "idle");
    }
}
