#[cfg(unix)]
use agentcomms_desktop::control::client::DesktopControlClient;
use agentcomms_desktop::control::client::NonSecretControlRequest;
#[cfg(unix)]
use agentcomms_desktop::preferences::DaemonProfile;
#[cfg(unix)]
use agentcomms_desktop::preferences::PreferenceStore;
#[cfg(unix)]
use agentcomms_desktop::supervisor::{DesktopSupervisor, SupervisorState};
use std::path::PathBuf;

fn main() {
    let mut executable = None;
    let mut state_dir = None;
    let mut config_dir = None;
    let mut operation = None;
    let mut versions = None;
    let mut mode = None;
    let mut preferences_path = None;
    let mut words = std::env::args().skip(1);
    while let Some(flag) = words.next() {
        let value = words.next();
        match flag.as_str() {
            "--executable" => executable = value.map(PathBuf::from),
            "--state-dir" => state_dir = value.map(PathBuf::from),
            "--config-dir" => config_dir = value.map(PathBuf::from),
            "--operation" => operation = value,
            "--versions" => versions = value,
            "--mode" => mode = value,
            "--preferences-path" => preferences_path = value.map(PathBuf::from),
            _ => {
                eprintln!("invalid probe option");
                std::process::exit(2);
            }
        }
    }
    let (Some(executable), Some(state_dir), Some(config_dir), Some(operation)) =
        (executable, state_dir, config_dir, operation)
    else {
        eprintln!("missing probe option");
        std::process::exit(2);
    };
    let operation = match operation.as_str() {
        "status" => NonSecretControlRequest::Status,
        "doctor" => NonSecretControlRequest::Doctor,
        "stop" => NonSecretControlRequest::Stop,
        _ => {
            eprintln!("invalid probe operation");
            std::process::exit(2);
        }
    };
    #[cfg(windows)]
    {
        let _ = (
            executable,
            state_dir,
            config_dir,
            operation,
            versions,
            mode,
            preferences_path,
        );
        println!("WINDOWS_CONTROL_UNAVAILABLE");
        std::process::exit(2);
    }
    #[cfg(unix)]
    let profile = match DaemonProfile::new(executable, state_dir, config_dir) {
        Ok(profile) => profile,
        Err(error) => {
            println!("{}", error.code);
            std::process::exit(2);
        }
    };
    #[cfg(unix)]
    {
        if mode.as_deref() == Some("supervision-cycle") {
            let Some(preferences_path) = preferences_path else {
                eprintln!("missing preferences path");
                std::process::exit(2);
            };
            let store = PreferenceStore::new(preferences_path);
            let supervisor = DesktopSupervisor::default();
            match supervisor.start_selected(&store, 0, profile, false) {
                Ok(started) if started.attached => {}
                Ok(_) => {
                    println!("CONTROL_OWNER_CHANGED");
                    std::process::exit(2);
                }
                Err(error) => {
                    println!("{}", error.code);
                    std::process::exit(2);
                }
            }
            match supervisor.stop_daemon(&store) {
                Ok(stopped) if stopped.state == SupervisorState::Idle => {
                    println!("{{\"attached\":true,\"stopped\":true}}");
                    return;
                }
                Ok(_) => {
                    println!("SUPERVISOR_STALE");
                    std::process::exit(2);
                }
                Err(error) => {
                    println!("{}", error.code);
                    std::process::exit(2);
                }
            }
        }
        let client = DesktopControlClient::new(profile);
        let versions: Vec<u32> = versions
            .as_deref()
            .unwrap_or("1")
            .split(',')
            .filter_map(|v| v.parse().ok())
            .collect();
        match client.request_with_versions(operation, &versions) {
            Ok(reply) => println!("{}", reply.data),
            Err(error) => {
                println!("{}", error.code);
                std::process::exit(if error.code == "PROTOCOL_UNSUPPORTED" {
                    3
                } else {
                    2
                });
            }
        }
    }
}
