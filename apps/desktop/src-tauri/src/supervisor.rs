use crate::control::types::ControlError;
#[cfg(unix)]
use crate::control::{
    client::{DesktopControlClient, NonSecretControlRequest},
    types::AuthenticatedReply,
};
#[cfg(unix)]
use crate::preferences::DesktopPreferences;
use crate::preferences::{DaemonProfile, PreferenceStore};
use serde::Serialize;
#[cfg(unix)]
use std::process::{Child, Command, Stdio};
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::sync::Condvar;
use std::sync::Mutex;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
pub use crate::control::types::InstanceIdentity;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SupervisorState {
    Idle,
    Starting,
    Cancelling,
    Running,
    Stopping,
}

#[derive(Clone, Debug)]
pub struct SupervisorStatus {
    pub state: SupervisorState,
    pub epoch: u64,
    pub pid: Option<u32>,
    pub process_start: Option<String>,
    pub attached: bool,
}

#[cfg(unix)]
pub struct AuthenticatedStatus {
    pub data: serde_json::Value,
    pub identity: InstanceIdentity,
}

#[cfg(unix)]
pub trait DaemonProcess: Send {
    fn id(&self) -> u32;
    fn try_wait(&mut self) -> Result<bool, ControlError>;
    fn terminate_and_wait(&mut self) -> Result<(), ControlError>;
}

#[cfg(unix)]
pub trait DaemonRuntime: Send + Sync {
    fn status(&self, profile: &DaemonProfile) -> Result<AuthenticatedStatus, ControlError>;
    fn stop(
        &self,
        profile: &DaemonProfile,
        expected: &InstanceIdentity,
    ) -> Result<(), ControlError>;
    fn spawn(&self, profile: &DaemonProfile) -> Result<Box<dyn DaemonProcess>, ControlError>;
}

#[cfg(unix)]
struct StartReservation {
    profile: DaemonProfile,
    expected_revision: u64,
}

#[cfg(unix)]
struct BoundOwner {
    profile: DaemonProfile,
    preference_revision: u64,
    identity: InstanceIdentity,
    child: Option<Box<dyn DaemonProcess>>,
    attached: bool,
    keep_after_quit: bool,
}

#[cfg(unix)]
#[derive(Clone)]
struct OwnerSnapshot {
    profile: DaemonProfile,
    preference_revision: u64,
    identity: InstanceIdentity,
    keep_after_quit: bool,
}

struct Ledger {
    state: SupervisorState,
    epoch: u64,
    #[cfg(unix)]
    start_in_flight: bool,
    #[cfg(unix)]
    cleanup_failed: bool,
    #[cfg(unix)]
    cleanup_child: Option<Box<dyn DaemonProcess>>,
    #[cfg(unix)]
    reservation: Option<StartReservation>,
    #[cfg(unix)]
    owner: Option<BoundOwner>,
}

pub struct DesktopSupervisor {
    ledger: Mutex<Ledger>,
    #[cfg(unix)]
    changed: Condvar,
    #[cfg(unix)]
    runtime: Arc<dyn DaemonRuntime>,
}

impl Default for DesktopSupervisor {
    fn default() -> Self {
        Self {
            ledger: Mutex::new(Ledger {
                state: SupervisorState::Idle,
                epoch: 0,
                #[cfg(unix)]
                start_in_flight: false,
                #[cfg(unix)]
                cleanup_failed: false,
                #[cfg(unix)]
                cleanup_child: None,
                #[cfg(unix)]
                reservation: None,
                #[cfg(unix)]
                owner: None,
            }),
            #[cfg(unix)]
            changed: Condvar::new(),
            #[cfg(unix)]
            runtime: Arc::new(RealDaemonRuntime),
        }
    }
}

#[cfg(unix)]
struct StartGuard<'a> {
    supervisor: &'a DesktopSupervisor,
    child: Option<Box<dyn DaemonProcess>>,
    committed: bool,
}

#[cfg(unix)]
impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        // Quit waits on this guard, so exact-child cleanup must precede notification.
        let cleanup_failed = self
            .child
            .as_mut()
            .is_some_and(|child| child.terminate_and_wait().is_err());
        let mut ledger = self.supervisor.ledger.lock().expect("supervisor ledger");
        ledger.start_in_flight = false;
        ledger.reservation = None;
        if cleanup_failed {
            ledger.cleanup_failed = true;
            ledger.cleanup_child = self.child.take();
            ledger.state = SupervisorState::Cancelling;
        } else if ledger.state == SupervisorState::Starting {
            ledger.state = SupervisorState::Idle;
        }
        self.supervisor.changed.notify_all();
    }
}

impl DesktopSupervisor {
    #[cfg(unix)]
    pub fn with_runtime(runtime: Arc<dyn DaemonRuntime>) -> Self {
        Self {
            runtime,
            ..Self::default()
        }
    }

    pub fn startup(&self) -> SupervisorStatus {
        self.status()
    }

    pub fn status(&self) -> SupervisorStatus {
        #[cfg(unix)]
        let mut ledger = self.ledger.lock().expect("supervisor ledger");
        #[cfg(windows)]
        let ledger = self.ledger.lock().expect("supervisor ledger");
        #[cfg(unix)]
        if ledger.state == SupervisorState::Running {
            if let Some(owner) = ledger.owner.as_mut() {
                if owner
                    .child
                    .as_mut()
                    .is_some_and(|child| child.try_wait().unwrap_or(false))
                {
                    ledger.owner = None;
                    ledger.state = SupervisorState::Idle;
                }
            }
        }
        Self::snapshot(&ledger)
    }

    fn snapshot(ledger: &Ledger) -> SupervisorStatus {
        #[cfg(unix)]
        let identity = ledger.owner.as_ref().map(|owner| &owner.identity);
        SupervisorStatus {
            state: ledger.state,
            epoch: ledger.epoch,
            #[cfg(unix)]
            pid: identity.map(|identity| identity.pid),
            #[cfg(windows)]
            pid: None,
            #[cfg(unix)]
            process_start: identity.map(|identity| identity.process_start.clone()),
            #[cfg(windows)]
            process_start: None,
            #[cfg(unix)]
            attached: ledger.owner.as_ref().is_some_and(|owner| owner.attached),
            #[cfg(windows)]
            attached: false,
        }
    }

    #[cfg(unix)]
    fn ensure_start_epoch(&self, epoch: u64) -> Result<(), ControlError> {
        let ledger = self.ledger.lock().expect("supervisor ledger");
        if ledger.epoch != epoch || ledger.state != SupervisorState::Starting {
            return Err(ControlError::new("SUPERVISOR_STALE", "start was cancelled"));
        }
        Ok(())
    }

    /// The exact profile and revision are reserved before daemon control, then persisted only when ready.
    #[cfg(unix)]
    pub fn start_selected(
        &self,
        store: &PreferenceStore,
        expected_revision: u64,
        profile: DaemonProfile,
        keep_after_quit: bool,
    ) -> Result<SupervisorStatus, ControlError> {
        profile.paths()?;
        let epoch = {
            let mut ledger = self.ledger.lock().expect("supervisor ledger");
            if ledger.state != SupervisorState::Idle
                || ledger.start_in_flight
                || ledger.owner.is_some()
                || ledger.cleanup_failed
            {
                return Err(ControlError::new(
                    "SUPERVISOR_BUSY",
                    "daemon transition already active",
                ));
            }
            ledger.epoch += 1;
            ledger.state = SupervisorState::Starting;
            ledger.start_in_flight = true;
            ledger.reservation = Some(StartReservation {
                profile: profile.clone(),
                expected_revision,
            });
            ledger.epoch
        };
        let mut guard = StartGuard {
            supervisor: self,
            child: None,
            committed: false,
        };
        let current = store.load()?;
        if current.revision != expected_revision {
            return Err(ControlError::new(
                "PREFERENCES_CHANGED",
                "preferences changed before start",
            ));
        }
        self.ensure_start_epoch(epoch)?;
        let revision = expected_revision.checked_add(1).ok_or_else(|| {
            ControlError::new("PREFERENCES_CHANGED", "preference revision exhausted")
        })?;
        let preferences = DesktopPreferences {
            daemon_profile: Some(profile.clone()),
            keep_collecting_after_quit: keep_after_quit,
            open_at_login: current.open_at_login,
            revision,
            child_identity: None,
        };
        let initial = self.runtime.status(&profile);
        let (attached, initial_identity) = match initial {
            Ok(status) => (true, Some(status.identity)),
            Err(error) if error.code == "NOT_FOUND" => (false, None),
            Err(error) => return Err(error),
        };
        if !attached {
            self.ensure_start_epoch(epoch)?;
            guard.child = Some(self.runtime.spawn(&profile)?);
            self.ensure_start_epoch(epoch)?;
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let ready = loop {
            self.ensure_start_epoch(epoch)?;
            match self.runtime.status(&profile) {
                Ok(status) => break status,
                Err(error) if error.code == "NOT_FOUND" && Instant::now() < deadline => {
                    if guard
                        .child
                        .as_mut()
                        .is_some_and(|child| child.try_wait().unwrap_or(false))
                    {
                        return Err(ControlError::new(
                            "DAEMON_EXITED",
                            "spawned daemon exited before ready",
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error),
            }
        };
        self.ensure_start_epoch(epoch)?;
        if let Some(initial_identity) = initial_identity {
            if initial_identity != ready.identity {
                return Err(ControlError::new(
                    "CONTROL_OWNER_CHANGED",
                    "attached owner changed during start",
                ));
            }
        }
        if guard
            .child
            .as_ref()
            .is_some_and(|child| child.id() != ready.identity.pid)
        {
            return Err(ControlError::new(
                "CONTROL_OWNER_CHANGED",
                "spawned child is not authenticated owner",
            ));
        }
        let current = store.load()?;
        if current.revision != expected_revision {
            return Err(ControlError::new(
                "PREFERENCES_CHANGED",
                "profile changed while starting",
            ));
        }
        let mut ledger = self.ledger.lock().expect("supervisor ledger");
        if ledger.epoch != epoch
            || ledger.state != SupervisorState::Starting
            || ledger.reservation.as_ref().is_none_or(|pending| {
                pending.profile != profile || pending.expected_revision != expected_revision
            })
        {
            return Err(ControlError::new(
                "SUPERVISOR_STALE",
                "start reservation changed",
            ));
        }
        // This is the final commit point. Holding the supervisor ledger prevents Quit from
        // superseding the selected epoch between the check and the atomic preference write.
        if let Err(error) = store.save_if_revision(&preferences, expected_revision) {
            drop(ledger);
            return Err(error);
        }
        ledger.owner = Some(BoundOwner {
            profile,
            preference_revision: revision,
            identity: ready.identity,
            child: guard.child.take(),
            attached,
            keep_after_quit,
        });
        ledger.state = SupervisorState::Running;
        ledger.reservation = None;
        ledger.start_in_flight = false;
        guard.committed = true;
        self.changed.notify_all();
        Ok(Self::snapshot(&ledger))
    }

    #[cfg(windows)]
    pub fn start_selected(
        &self,
        _store: &PreferenceStore,
        _expected_revision: u64,
        _profile: DaemonProfile,
        _keep_after_quit: bool,
    ) -> Result<SupervisorStatus, ControlError> {
        Err(ControlError::windows_unavailable())
    }

    #[cfg(unix)]
    fn reserve_stop(&self) -> Result<(u64, Option<OwnerSnapshot>), ControlError> {
        let mut ledger = self.ledger.lock().expect("supervisor ledger");
        let mut cancelled_epoch = None;
        if ledger.state == SupervisorState::Starting {
            ledger.epoch += 1;
            ledger.state = SupervisorState::Cancelling;
            cancelled_epoch = Some(ledger.epoch);
            while ledger.start_in_flight {
                ledger = self.changed.wait(ledger).expect("supervisor ledger");
                if ledger.epoch != cancelled_epoch.expect("cancellation epoch")
                    || ledger.state != SupervisorState::Cancelling
                {
                    return Err(ControlError::new(
                        "SUPERVISOR_STALE",
                        "cancellation ownership changed",
                    ));
                }
            }
        }
        if ledger.cleanup_failed {
            return Err(ControlError::new(
                "DAEMON_CLEANUP_FAILED",
                "spawned child could not be reaped",
            ));
        }
        if ledger.state == SupervisorState::Stopping
            || (ledger.state == SupervisorState::Cancelling && cancelled_epoch.is_none())
        {
            return Err(ControlError::new(
                "SUPERVISOR_BUSY",
                "daemon transition already active",
            ));
        }
        ledger.epoch += 1;
        ledger.state = SupervisorState::Stopping;
        let owner = ledger.owner.as_ref().map(|owner| OwnerSnapshot {
            profile: owner.profile.clone(),
            preference_revision: owner.preference_revision,
            identity: owner.identity.clone(),
            keep_after_quit: owner.keep_after_quit,
        });
        Ok((ledger.epoch, owner))
    }

    #[cfg(unix)]
    fn restore_after_stop_error(&self, epoch: u64) {
        let mut ledger = self.ledger.lock().expect("supervisor ledger");
        if ledger.epoch == epoch && ledger.state == SupervisorState::Stopping {
            ledger.state = if ledger.owner.is_some() {
                SupervisorState::Running
            } else {
                SupervisorState::Idle
            };
        }
    }

    #[cfg(unix)]
    fn finish_stop(
        &self,
        epoch: u64,
        expected: Option<&InstanceIdentity>,
    ) -> Result<SupervisorStatus, ControlError> {
        let mut ledger = self.ledger.lock().expect("supervisor ledger");
        if ledger.epoch != epoch
            || ledger.state != SupervisorState::Stopping
            || ledger.owner.as_ref().map(|owner| &owner.identity) != expected
        {
            return Err(ControlError::new(
                "SUPERVISOR_STALE",
                "stop ownership changed",
            ));
        }
        ledger.owner = None;
        ledger.state = SupervisorState::Idle;
        Ok(Self::snapshot(&ledger))
    }

    #[cfg(unix)]
    fn stop_with_policy(
        &self,
        store: &PreferenceStore,
        tray_quit: bool,
    ) -> Result<SupervisorStatus, ControlError> {
        let (epoch, mut bound) = self.reserve_stop()?;
        let result = (|| {
            if bound.is_none() {
                let preferences = store.load()?;
                if tray_quit && preferences.keep_collecting_after_quit {
                    return self.finish_stop(epoch, None);
                }
                let Some(profile) = preferences.daemon_profile else {
                    return self.finish_stop(epoch, None);
                };
                match self.runtime.status(&profile) {
                    Ok(status) => {
                        let mut ledger = self.ledger.lock().expect("supervisor ledger");
                        if ledger.epoch != epoch || ledger.state != SupervisorState::Stopping {
                            return Err(ControlError::new(
                                "SUPERVISOR_STALE",
                                "stop reservation changed",
                            ));
                        }
                        ledger.owner = Some(BoundOwner {
                            profile: profile.clone(),
                            preference_revision: preferences.revision,
                            identity: status.identity.clone(),
                            child: None,
                            attached: true,
                            keep_after_quit: preferences.keep_collecting_after_quit,
                        });
                        bound = Some(OwnerSnapshot {
                            profile,
                            preference_revision: preferences.revision,
                            identity: status.identity,
                            keep_after_quit: preferences.keep_collecting_after_quit,
                        });
                    }
                    Err(error) if error.code == "NOT_FOUND" => {
                        return self.finish_stop(epoch, None)
                    }
                    Err(error) => return Err(error),
                }
            }
            let bound = bound.as_ref().expect("bound owner after status");
            let _ = bound.preference_revision;
            if tray_quit && bound.keep_after_quit {
                return self.finish_stop(epoch, Some(&bound.identity));
            }
            match self.runtime.status(&bound.profile) {
                Ok(status) if status.identity == bound.identity => {}
                Ok(_) => {
                    return Err(ControlError::new(
                        "CONTROL_OWNER_CHANGED",
                        "replacement owner is active",
                    ))
                }
                Err(error) if error.code == "NOT_FOUND" => {}
                Err(error) => return Err(error),
            }
            match self.runtime.stop(&bound.profile, &bound.identity) {
                Ok(()) => {}
                Err(error) if error.code == "NOT_FOUND" => {}
                Err(error) => return Err(error),
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                {
                    let ledger = self.ledger.lock().expect("supervisor ledger");
                    if ledger.epoch != epoch
                        || ledger.state != SupervisorState::Stopping
                        || ledger
                            .owner
                            .as_ref()
                            .is_none_or(|owner| owner.identity != bound.identity)
                    {
                        return Err(ControlError::new(
                            "SUPERVISOR_STALE",
                            "stop ownership changed",
                        ));
                    }
                }
                let endpoint_gone = match self.runtime.status(&bound.profile) {
                    Ok(status) if status.identity == bound.identity => false,
                    Ok(_) => {
                        return Err(ControlError::new(
                            "CONTROL_OWNER_CHANGED",
                            "replacement owner is active",
                        ))
                    }
                    Err(error) if error.code == "NOT_FOUND" => true,
                    Err(error) => return Err(error),
                };
                let child_gone = {
                    let mut ledger = self.ledger.lock().expect("supervisor ledger");
                    ledger
                        .owner
                        .as_mut()
                        .and_then(|owner| owner.child.as_mut())
                        .map(|child| child.try_wait())
                        .transpose()?
                        .unwrap_or(true)
                };
                if endpoint_gone && child_gone {
                    return self.finish_stop(epoch, Some(&bound.identity));
                }
                if Instant::now() >= deadline {
                    return Err(ControlError::new(
                        "CONTROL_TIMEOUT",
                        "daemon did not finish stopping",
                    ));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        if result.is_err() {
            self.restore_after_stop_error(epoch);
        }
        result
    }

    /// Explicit Settings action: it always requests D12 Stop, regardless of tray policy.
    #[cfg(unix)]
    pub fn stop_daemon(&self, store: &PreferenceStore) -> Result<SupervisorStatus, ControlError> {
        self.stop_with_policy(store, false)
    }

    #[cfg(windows)]
    pub fn stop_daemon(&self, _store: &PreferenceStore) -> Result<SupervisorStatus, ControlError> {
        Err(ControlError::windows_unavailable())
    }

    /// Tray Quit may detach only when the bound preference explicitly says to keep collecting.
    #[cfg(unix)]
    pub fn quit(&self, store: &PreferenceStore) -> Result<SupervisorStatus, ControlError> {
        self.stop_with_policy(store, true)
    }

    #[cfg(windows)]
    pub fn quit(&self, _store: &PreferenceStore) -> Result<SupervisorStatus, ControlError> {
        Err(ControlError::windows_unavailable())
    }
}

#[cfg(all(test, unix))]
mod cancellation_tests {
    use super::*;

    // desktop-rust-mutation: desktop-supervisor-cancel-handoff | cargo --lib | supervisor::cancellation_tests::cancelled_start_retains_reservation_until_quit_consumes_it
    #[test]
    fn cancelled_start_retains_reservation_until_quit_consumes_it() {
        let supervisor = DesktopSupervisor::default();
        {
            let mut ledger = supervisor.ledger.lock().unwrap();
            ledger.state = SupervisorState::Cancelling;
            ledger.epoch = 7;
            ledger.start_in_flight = true;
        }
        drop(StartGuard {
            supervisor: &supervisor,
            child: None,
            committed: false,
        });
        assert_eq!(supervisor.status().state, SupervisorState::Cancelling);
        assert_eq!(
            supervisor.reserve_stop().err().unwrap().code,
            "SUPERVISOR_BUSY"
        );
        assert_eq!(supervisor.status().state, SupervisorState::Cancelling);
    }

    // desktop-rust-mutation: desktop-supervisor-stop-race | cargo --lib | supervisor::cancellation_tests::stop_epoch_prevents_clearing_newer_owner
    #[test]
    fn stop_epoch_prevents_clearing_newer_owner() {
        let supervisor = DesktopSupervisor::default();
        {
            let mut ledger = supervisor.ledger.lock().unwrap();
            ledger.state = SupervisorState::Stopping;
            ledger.epoch = 8;
        }
        assert_eq!(
            supervisor.finish_stop(7, None).err().unwrap().code,
            "SUPERVISOR_STALE"
        );
        assert_eq!(supervisor.status().state, SupervisorState::Stopping);
    }

    #[test]
    fn three_actor_cancellation_handoff_rejects_competing_start() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let executable = root.join("agent-events");
        let state = root.join("state");
        let config = root.join("config");
        fs::write(&executable, b"fixture").unwrap();
        fs::create_dir(&state).unwrap();
        fs::create_dir(&config).unwrap();
        for path in [&executable, &state, &config] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let profile = DaemonProfile::new(executable, state, config).unwrap();
        let store = PreferenceStore::new(root.join("private/prefs"));
        let supervisor = Arc::new(DesktopSupervisor::default());
        {
            let mut ledger = supervisor.ledger.lock().unwrap();
            ledger.state = SupervisorState::Starting;
            ledger.start_in_flight = true;
            ledger.epoch = 7;
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let waiting_quit = {
            let supervisor = supervisor.clone();
            std::thread::spawn(move || {
                tx.send(supervisor.reserve_stop().map(|(epoch, _)| epoch))
                    .unwrap()
            })
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.status().state != SupervisorState::Cancelling {
            assert!(
                Instant::now() < deadline,
                "Quit never acquired cancellation reservation"
            );
            std::thread::yield_now();
        }
        let cancelled_start = {
            let supervisor = supervisor.clone();
            std::thread::spawn(move || {
                drop(StartGuard {
                    supervisor: &supervisor,
                    child: None,
                    committed: false,
                })
            })
        };
        cancelled_start.join().unwrap();
        assert_eq!(
            supervisor
                .start_selected(&store, 0, profile, false)
                .err()
                .unwrap()
                .code,
            "SUPERVISOR_BUSY"
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap(), 9);
        waiting_quit.join().unwrap();
        assert_eq!(supervisor.status().state, SupervisorState::Stopping);
        supervisor.finish_stop(9, None).unwrap();
        assert_eq!(supervisor.status().state, SupervisorState::Idle);
    }
}

#[cfg(unix)]
struct RealDaemonRuntime;

#[cfg(unix)]
impl DaemonRuntime for RealDaemonRuntime {
    fn status(&self, profile: &DaemonProfile) -> Result<AuthenticatedStatus, ControlError> {
        let AuthenticatedReply { data, identity } =
            DesktopControlClient::new(profile.clone()).request(NonSecretControlRequest::Status)?;
        Ok(AuthenticatedStatus { data, identity })
    }

    fn stop(
        &self,
        profile: &DaemonProfile,
        expected: &InstanceIdentity,
    ) -> Result<(), ControlError> {
        let reply = DesktopControlClient::new(profile.clone())
            .request_for_identity(NonSecretControlRequest::Stop, expected)?;
        if reply
            .data
            .get("stopping")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        {
            return Err(ControlError::new(
                "MALFORMED_FRAME",
                "stop acknowledgement is malformed",
            ));
        }
        Ok(())
    }

    fn spawn(&self, profile: &DaemonProfile) -> Result<Box<dyn DaemonProcess>, ControlError> {
        profile.paths()?;
        let child = Command::new(&profile.executable)
            .arg("--state-dir")
            .arg(&profile.state_dir)
            .arg("--config-dir")
            .arg(&profile.config_dir)
            .arg("run")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| {
                ControlError::new("DAEMON_SPAWN", "cannot start exact daemon executable")
            })?;
        Ok(Box::new(RealDaemonProcess(child)))
    }
}

#[cfg(unix)]
struct RealDaemonProcess(Child);

#[cfg(unix)]
impl DaemonProcess for RealDaemonProcess {
    fn id(&self) -> u32 {
        self.0.id()
    }
    fn try_wait(&mut self) -> Result<bool, ControlError> {
        self.0
            .try_wait()
            .map(|result| result.is_some())
            .map_err(|_| ControlError::new("DAEMON_WAIT", "cannot inspect child exit"))
    }
    fn terminate_and_wait(&mut self) -> Result<(), ControlError> {
        let _ = self.0.kill();
        self.0
            .wait()
            .map(|_| ())
            .map_err(|_| ControlError::new("DAEMON_WAIT", "cannot wait for child exit"))
    }
}
