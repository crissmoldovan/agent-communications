#![cfg(unix)]

use agentcomms_desktop::control::types::ControlError;
use agentcomms_desktop::preferences::{DaemonProfile, DesktopPreferences, PreferenceStore};
use agentcomms_desktop::supervisor::{
    AuthenticatedStatus, DaemonProcess, DaemonRuntime, DesktopSupervisor, InstanceIdentity,
    SupervisorState,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Barrier, Mutex};
use std::time::Duration;

struct FakeRuntime {
    current: Mutex<Option<InstanceIdentity>>,
    stop_calls: Mutex<Vec<PathBuf>>,
    spawn_calls: AtomicUsize,
    child_terminated: Arc<AtomicBool>,
    child_cleanup_fails: Arc<AtomicBool>,
    child_dropped: Arc<AtomicBool>,
    spawned_identity: Mutex<Option<InstanceIdentity>>,
    block_status: Mutex<Option<(Arc<Barrier>, Arc<Barrier>)>>,
    block_stop: Mutex<Option<(Arc<Barrier>, Arc<Barrier>)>>,
    stop_ack_without_exit: AtomicBool,
}

impl FakeRuntime {
    fn attached(identity: InstanceIdentity) -> Arc<Self> {
        Arc::new(Self {
            current: Mutex::new(Some(identity)),
            stop_calls: Mutex::new(Vec::new()),
            spawn_calls: AtomicUsize::new(0),
            child_terminated: Arc::new(AtomicBool::new(false)),
            child_cleanup_fails: Arc::new(AtomicBool::new(false)),
            child_dropped: Arc::new(AtomicBool::new(false)),
            spawned_identity: Mutex::new(None),
            block_status: Mutex::new(None),
            block_stop: Mutex::new(None),
            stop_ack_without_exit: AtomicBool::new(false),
        })
    }
    fn absent() -> Arc<Self> {
        let runtime = Self::attached(identity(42));
        *runtime.current.lock().unwrap() = None;
        runtime
    }
}

struct FakeChild {
    terminated: Arc<AtomicBool>,
    cleanup_fails: Arc<AtomicBool>,
    dropped: Arc<AtomicBool>,
}

impl Drop for FakeChild {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

impl DaemonProcess for FakeChild {
    fn id(&self) -> u32 {
        42
    }
    fn try_wait(&mut self) -> Result<bool, ControlError> {
        Ok(self.terminated.load(Ordering::SeqCst))
    }
    fn terminate_and_wait(&mut self) -> Result<(), ControlError> {
        if self.cleanup_fails.load(Ordering::SeqCst) {
            return Err(ControlError::new(
                "DAEMON_CLEANUP_FAILED",
                "cannot reap child",
            ));
        }
        self.terminated.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl DaemonRuntime for FakeRuntime {
    fn status(&self, _profile: &DaemonProfile) -> Result<AuthenticatedStatus, ControlError> {
        if let Some((entered, release)) = self.block_status.lock().unwrap().take() {
            entered.wait();
            release.wait();
        }
        self.current
            .lock()
            .unwrap()
            .clone()
            .map(|identity| AuthenticatedStatus {
                data: json!({"owner":"running"}),
                identity,
            })
            .ok_or_else(|| ControlError::new("NOT_FOUND", "no owner"))
    }
    fn stop(
        &self,
        profile: &DaemonProfile,
        expected: &InstanceIdentity,
    ) -> Result<(), ControlError> {
        self.stop_calls
            .lock()
            .unwrap()
            .push(profile.state_dir.clone());
        if let Some((entered, release)) = self.block_stop.lock().unwrap().take() {
            entered.wait();
            release.wait();
        }
        if self.current.lock().unwrap().as_ref() != Some(expected) {
            return Err(ControlError::new(
                "CONTROL_OWNER_CHANGED",
                "replacement owner",
            ));
        }
        if !self.stop_ack_without_exit.load(Ordering::SeqCst) {
            *self.current.lock().unwrap() = None;
        }
        Ok(())
    }
    fn spawn(&self, _profile: &DaemonProfile) -> Result<Box<dyn DaemonProcess>, ControlError> {
        self.spawn_calls.fetch_add(1, Ordering::SeqCst);
        *self.current.lock().unwrap() = self.spawned_identity.lock().unwrap().clone();
        Ok(Box::new(FakeChild {
            terminated: self.child_terminated.clone(),
            cleanup_fails: self.child_cleanup_fails.clone(),
            dropped: self.child_dropped.clone(),
        }))
    }
}

fn identity(pid: u32) -> InstanceIdentity {
    InstanceIdentity {
        instance_id: format!("{pid:032x}"),
        pid,
        process_start: format!("{pid}:fixture"),
    }
}

fn profile(root: &std::path::Path, name: &str) -> DaemonProfile {
    use std::os::unix::fs::PermissionsExt;
    let base = root.join(name);
    fs::create_dir(&base).unwrap();
    let executable = base.join("agent-events");
    let state_dir = base.join("state");
    let config_dir = base.join("config");
    fs::write(&executable, b"synthetic executable").unwrap();
    fs::create_dir(&state_dir).unwrap();
    fs::create_dir(&config_dir).unwrap();
    for path in [&executable, &state_dir, &config_dir] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    DaemonProfile::new(executable, state_dir, config_dir).unwrap()
}

#[test]
fn rejected_second_start_keeps_bound_profile_for_quit() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let a = profile(&root, "a");
    let b = profile(&root, "b");
    let store = PreferenceStore::new(root.join("private/desktop.json"));
    let runtime = FakeRuntime::attached(identity(101));
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    supervisor
        .start_selected(&store, 0, a.clone(), false)
        .unwrap();
    assert_eq!(
        supervisor
            .start_selected(&store, 1, b, false)
            .unwrap_err()
            .code,
        "SUPERVISOR_BUSY"
    );
    assert_eq!(store.load().unwrap().daemon_profile, Some(a.clone()));
    supervisor.quit(&store).unwrap();
    assert_eq!(*runtime.stop_calls.lock().unwrap(), vec![a.state_dir]);
}

// desktop-rust-mutation: desktop-supervisor-late-spawn | cargo --test supervisor_lifecycle | tray_quit_waits_for_cancelled_start_before_late_spawn
#[test]
fn tray_quit_waits_for_cancelled_start_before_late_spawn() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let path = root.join("private/desktop.json");
    let store = PreferenceStore::new(path.clone());
    let mut preferences = DesktopPreferences::default();
    preferences.revision = 1;
    store.save(&preferences).unwrap();
    let before_start = fs::read(&path).unwrap();
    let runtime = FakeRuntime::absent();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *runtime.block_status.lock().unwrap() = Some((entered.clone(), release.clone()));
    let supervisor = Arc::new(DesktopSupervisor::with_runtime(runtime.clone()));
    let starting = {
        let supervisor = supervisor.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            supervisor.start_selected(&PreferenceStore::new(path), 1, selected, false)
        })
    };
    entered.wait();
    let (done, received) = mpsc::channel();
    let quitting = {
        let supervisor = supervisor.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            done.send(supervisor.quit(&PreferenceStore::new(path)))
                .unwrap()
        })
    };
    assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
    release.wait();
    assert_eq!(
        starting.join().unwrap().unwrap_err().code,
        "SUPERVISOR_STALE"
    );
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .state,
        SupervisorState::Idle
    );
    quitting.join().unwrap();
    assert_eq!(runtime.spawn_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(&path).unwrap(), before_start);
}

// desktop-rust-mutation: desktop-preferences-race | cargo --test supervisor_lifecycle | start_rejects_external_revision_change_after_authenticated_status
#[test]
fn start_rejects_external_revision_change_after_authenticated_status() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let path = root.join("private/desktop.json");
    let store = PreferenceStore::new(path.clone());
    let mut preferences = DesktopPreferences::default();
    preferences.revision = 1;
    store.save(&preferences).unwrap();
    let runtime = FakeRuntime::attached(identity(101));
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *runtime.block_status.lock().unwrap() = Some((entered.clone(), release.clone()));
    let supervisor = Arc::new(DesktopSupervisor::with_runtime(runtime));
    let starting = {
        let supervisor = supervisor.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            supervisor.start_selected(&PreferenceStore::new(path), 1, selected, false)
        })
    };
    entered.wait();
    let store = PreferenceStore::new(path);
    let mut changed = store.load().unwrap();
    changed.revision = 2;
    store.save(&changed).unwrap();
    release.wait();
    assert_eq!(
        starting.join().unwrap().unwrap_err().code,
        "PREFERENCES_CHANGED"
    );
    assert_eq!(supervisor.status().state, SupervisorState::Idle);
}

#[test]
fn spawned_pid_must_match_authenticated_instance_and_child_is_cleaned() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let store = PreferenceStore::new(root.join("private/desktop.json"));
    let runtime = FakeRuntime::absent();
    *runtime.spawned_identity.lock().unwrap() = Some(identity(99));
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    assert_eq!(
        supervisor
            .start_selected(&store, 0, selected, false)
            .unwrap_err()
            .code,
        "CONTROL_OWNER_CHANGED"
    );
    assert!(runtime.child_terminated.load(Ordering::SeqCst));
    assert_eq!(supervisor.status().state, SupervisorState::Idle);
}

#[test]
fn failed_child_cleanup_blocks_tray_quit_and_new_start() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let store = PreferenceStore::new(root.join("private/desktop.json"));
    let runtime = FakeRuntime::absent();
    *runtime.spawned_identity.lock().unwrap() = Some(identity(99));
    runtime.child_cleanup_fails.store(true, Ordering::SeqCst);
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    assert_eq!(
        supervisor
            .start_selected(&store, 0, selected.clone(), false)
            .unwrap_err()
            .code,
        "CONTROL_OWNER_CHANGED"
    );
    assert_eq!(
        supervisor.quit(&store).unwrap_err().code,
        "DAEMON_CLEANUP_FAILED"
    );
    assert_eq!(
        supervisor
            .start_selected(&store, 1, selected, false)
            .unwrap_err()
            .code,
        "SUPERVISOR_BUSY"
    );
    assert!(
        !runtime.child_dropped.load(Ordering::SeqCst),
        "failed cleanup must retain exact child handle"
    );
}

#[test]
fn explicit_stop_ignores_keep_after_quit_but_tray_quit_detaches() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let store = PreferenceStore::new(root.join("private/desktop.json"));
    let runtime = FakeRuntime::attached(identity(101));
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    supervisor
        .start_selected(&store, 0, selected.clone(), true)
        .unwrap();
    supervisor.stop_daemon(&store).unwrap();
    assert_eq!(runtime.stop_calls.lock().unwrap().len(), 1);
    let runtime = FakeRuntime::attached(identity(102));
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    supervisor
        .start_selected(&store, 1, selected, true)
        .unwrap();
    supervisor.quit(&store).unwrap();
    assert!(runtime.stop_calls.lock().unwrap().is_empty());
}

// desktop-rust-mutation: desktop-supervisor-exact-identity | cargo --test supervisor_lifecycle | replacement_owner_is_not_stopped_or_cleared
#[test]
fn replacement_owner_is_not_stopped_or_cleared() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let store = PreferenceStore::new(root.join("private/desktop.json"));
    let runtime = FakeRuntime::attached(identity(101));
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    supervisor
        .start_selected(&store, 0, selected, false)
        .unwrap();
    *runtime.current.lock().unwrap() = Some(identity(202));
    assert_eq!(
        supervisor.quit(&store).unwrap_err().code,
        "CONTROL_OWNER_CHANGED"
    );
    assert!(runtime.stop_calls.lock().unwrap().is_empty());
    assert_eq!(supervisor.status().state, SupervisorState::Running);
}

#[test]
fn stop_waits_for_acknowledged_owner_to_leave() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let path = root.join("private/desktop.json");
    let store = PreferenceStore::new(path.clone());
    let runtime = FakeRuntime::attached(identity(101));
    let supervisor = Arc::new(DesktopSupervisor::with_runtime(runtime.clone()));
    supervisor
        .start_selected(&store, 0, selected, false)
        .unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    *runtime.block_stop.lock().unwrap() = Some((entered.clone(), release.clone()));
    let (done, received) = mpsc::channel();
    let thread = {
        let supervisor = supervisor.clone();
        std::thread::spawn(move || {
            done.send(supervisor.stop_daemon(&PreferenceStore::new(path)))
                .unwrap()
        })
    };
    entered.wait();
    assert_eq!(supervisor.status().state, SupervisorState::Stopping);
    assert!(received.recv_timeout(Duration::from_millis(100)).is_err());
    release.wait();
    assert_eq!(
        received
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap()
            .state,
        SupervisorState::Idle
    );
    thread.join().unwrap();
}

#[test]
fn acknowledged_stop_does_not_finish_until_owner_exits() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let selected = profile(&root, "a");
    let path = root.join("private/desktop.json");
    let runtime = FakeRuntime::attached(identity(101));
    runtime.stop_ack_without_exit.store(true, Ordering::SeqCst);
    let supervisor = Arc::new(DesktopSupervisor::with_runtime(runtime.clone()));
    supervisor
        .start_selected(&PreferenceStore::new(path.clone()), 0, selected, false)
        .unwrap();
    let (tx, rx) = mpsc::channel();
    let worker = {
        let supervisor = supervisor.clone();
        std::thread::spawn(move || {
            tx.send(supervisor.stop_daemon(&PreferenceStore::new(path)))
                .unwrap()
        })
    };
    assert!(rx.recv_timeout(Duration::from_millis(150)).is_err());
    assert_eq!(supervisor.status().state, SupervisorState::Stopping);
    *runtime.current.lock().unwrap() = None;
    rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    worker.join().unwrap();
}

// desktop-rust-mutation: desktop-autostart-no-spawn | cargo --test supervisor_lifecycle | login_startup_never_calls_runtime_spawn
#[test]
fn login_startup_never_calls_runtime_spawn() {
    let runtime = FakeRuntime::absent();
    let supervisor = DesktopSupervisor::with_runtime(runtime.clone());
    assert_eq!(supervisor.startup().state, SupervisorState::Idle);
    assert_eq!(runtime.spawn_calls.load(Ordering::SeqCst), 0);
}
