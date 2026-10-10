#![cfg(unix)]

use agentcomms_desktop::preferences::{DaemonProfile, DesktopPreferences, PreferenceStore};
use std::fs;

#[test]
fn profile_is_absolute_canonical_and_fixed() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let exe = root.join("agent-events");
    fs::write(&exe, b"dummy").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let state = root.join("state");
    let config = root.join("config");
    fs::create_dir(&state).unwrap();
    fs::create_dir(&config).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&state, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(DaemonProfile::new(exe.clone(), state.clone(), config.clone()).is_ok());
    assert!(DaemonProfile::new("agent-events".into(), state.clone(), config.clone()).is_err());
    let wrong_name = root.join("another-daemon");
    fs::write(&wrong_name, b"dummy").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&wrong_name, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(DaemonProfile::new(exe.clone(), state.clone(), config.clone()).is_err());
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(DaemonProfile::new(wrong_name, state.clone(), config.clone()).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&state, root.join("link")).unwrap();
        assert!(DaemonProfile::new(exe, root.join("link"), config).is_err());
    }
}

// desktop-rust-mutation: desktop-preferences-private | cargo --test preferences_security | preferences_are_private_atomic_and_recover_only_complete_records
#[test]
fn preferences_are_private_atomic_and_recover_only_complete_records() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = PreferenceStore::new(root.join("private/prefs"));
    let first = DesktopPreferences {
        revision: 1,
        ..DesktopPreferences::default()
    };
    store.save(&first).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.revision, first.revision);
    assert!(!loaded.open_at_login);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(store.path(), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.load().is_err());
    }
}

// desktop-rust-mutation: desktop-preferences-atomic-recovery | cargo --test preferences_security | preferences_refuse_symlink_and_torn_record
#[test]
fn preferences_refuse_symlink_and_torn_record() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let private = root.join("private");
    fs::create_dir(&private).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    let store = PreferenceStore::new(private.join("prefs"));
    fs::write(store.path(), b"{\"revision\":").unwrap();
    fs::set_permissions(store.path(), fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(store.load().unwrap_err().code, "PREFERENCES_TORN");
    #[cfg(unix)]
    {
        fs::remove_file(store.path()).unwrap();
        std::os::unix::fs::symlink(root.join("other"), store.path()).unwrap();
        assert!(store.load().is_err());
    }
}

#[test]
fn preferences_revision_is_checked_under_private_sibling_lock() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let store = PreferenceStore::new(root.join("private/prefs"));
    let first = DesktopPreferences {
        revision: 1,
        ..DesktopPreferences::default()
    };
    store.save_if_revision(&first, 0).unwrap();
    let mut second = first.clone();
    second.revision = 2;
    assert!(store.save_if_revision(&second, 0).is_err());
    assert_eq!(store.load().unwrap().revision, 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let lock = store.path().with_extension("json.lock");
        assert_eq!(
            fs::metadata(&lock).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&lock).unwrap();
        std::os::unix::fs::symlink(store.path(), &lock).unwrap();
        assert!(store.save_if_revision(&second, 1).is_err());
    }
}

// desktop-rust-mutation: desktop-preferences-lock | cargo --test preferences_security | preferences_save_waits_for_held_sibling_lock
#[test]
fn preferences_save_waits_for_held_sibling_lock() {
    use std::os::fd::AsRawFd;
    use std::sync::mpsc;
    use std::time::Duration;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let path = root.join("private/prefs");
    let store = PreferenceStore::new(path.clone());
    store
        .save(&DesktopPreferences {
            revision: 1,
            ..DesktopPreferences::default()
        })
        .unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path.with_extension("json.lock"))
        .unwrap();
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) }, 0);
    let (tx, rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let next = DesktopPreferences {
            revision: 2,
            ..DesktopPreferences::default()
        };
        ready_tx.send(()).unwrap();
        tx.send(store.save_if_revision(&next, 1)).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_UN) }, 0);
    rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap();
    worker.join().unwrap();
}

// desktop-rust-mutation: desktop-preferences-symlink-reparse | cargo --test preferences_security | preferences_refuse_symlinked_ancestor_before_load_or_save
#[test]
fn preferences_refuse_symlinked_ancestor_before_load_or_save() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let real = root.join("real");
    let private = real.join("private");
    fs::create_dir(&real).unwrap();
    fs::create_dir(&private).unwrap();
    fs::set_permissions(&private, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&real, root.join("link")).unwrap();
    let store = PreferenceStore::new(root.join("link/private/desktop.json"));
    let first = DesktopPreferences {
        revision: 1,
        ..DesktopPreferences::default()
    };
    assert!(store.load().is_err());
    assert!(store.save_if_revision(&first, 0).is_err());
    assert!(!private.join("desktop.json").exists());
}
