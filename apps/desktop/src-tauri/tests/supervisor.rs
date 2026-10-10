#[cfg(unix)]
use agentcomms_desktop::preferences::{DaemonProfile, PreferenceStore};
use agentcomms_desktop::supervisor::{DesktopSupervisor, SupervisorState};
#[cfg(unix)]
use std::fs;

#[test]
fn login_startup_is_inert() {
    let supervisor = DesktopSupervisor::default();
    assert_eq!(supervisor.status().state, SupervisorState::Idle);
    assert_eq!(supervisor.status().epoch, 0);
}

// desktop-rust-mutation: desktop-daemon-profile-drift | cargo --test supervisor | exact_selected_executable_runs_and_exited_child_is_not_adopted
#[test]
#[cfg(unix)]
fn exact_selected_executable_runs_and_exited_child_is_not_adopted() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executable = root.join("agent-events");
    let marker = root.join("ran-selected-executable");
    fs::write(
        &executable,
        format!("#!/bin/sh\nprintf reached > '{}'\n", marker.display()),
    )
    .unwrap();
    let state_dir = root.join("state");
    let config_dir = root.join("config");
    fs::create_dir(&state_dir).unwrap();
    fs::create_dir(&config_dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&executable, &state_dir, &config_dir] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let profile = DaemonProfile::new(executable, state_dir, config_dir).unwrap();
    let store = PreferenceStore::new(root.join("private/prefs"));
    let supervisor = DesktopSupervisor::default();
    assert!(supervisor
        .start_selected(&store, 0, profile, false)
        .is_err());
    assert!(
        marker.exists(),
        "the exact configured executable must be launched"
    );
    assert_eq!(supervisor.status().state, SupervisorState::Idle);
}
