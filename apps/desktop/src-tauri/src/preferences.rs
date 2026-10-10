use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::control::types::ControlError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonProfile {
    pub executable: PathBuf,
    pub state_dir: PathBuf,
    pub config_dir: PathBuf,
}

impl DaemonProfile {
    pub fn new(
        executable: PathBuf,
        state_dir: PathBuf,
        config_dir: PathBuf,
    ) -> Result<Self, ControlError> {
        if executable.file_name().and_then(|name| name.to_str()) != Some("agent-events") {
            return Err(ControlError::new(
                "DAEMON_PROFILE_EXECUTABLE",
                "wrong daemon executable name",
            ));
        }
        Ok(Self {
            executable: canonical_profile_path(&executable, false)?,
            state_dir: canonical_profile_path(&state_dir, true)?,
            config_dir: canonical_profile_path(&config_dir, true)?,
        })
    }

    pub fn paths(&self) -> Result<ProfilePaths, ControlError> {
        let selected = Self::new(
            self.executable.clone(),
            self.state_dir.clone(),
            self.config_dir.clone(),
        )?;
        if selected != *self {
            return Err(ControlError::new(
                "DAEMON_PROFILE_DRIFT",
                "selected profile changed",
            ));
        }
        let root = self.state_dir.join("events");
        Ok(ProfilePaths {
            root: root.clone(),
            socket_dir: root.join("socket"),
            socket: root.join("socket/control.sock"),
            instance: root.join("instance.json"),
            token: root.join("control.token"),
        })
    }
}

#[derive(Clone, Debug)]
pub struct ProfilePaths {
    pub root: PathBuf,
    pub socket_dir: PathBuf,
    pub socket: PathBuf,
    pub instance: PathBuf,
    pub token: PathBuf,
}

fn canonical_profile_path(path: &Path, directory: bool) -> Result<PathBuf, ControlError> {
    if !path.is_absolute() {
        return Err(ControlError::new(
            "DAEMON_PROFILE_PATH",
            "profile path must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ControlError::new("DAEMON_PROFILE_PATH", "profile path is missing"))?;
    if is_link(&metadata) {
        return Err(ControlError::new(
            "DAEMON_PROFILE_LINK",
            "profile path is a link",
        ));
    }
    if metadata.is_dir() != directory {
        return Err(ControlError::new(
            "DAEMON_PROFILE_PATH",
            "profile path has wrong type",
        ));
    }
    if !directory && !metadata.is_file() {
        return Err(ControlError::new(
            "DAEMON_PROFILE_EXECUTABLE",
            "daemon executable is not a regular file",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } {
            return Err(ControlError::new(
                "DAEMON_PROFILE_OWNER",
                "profile path has wrong owner",
            ));
        }
        if directory && metadata.mode() & 0o077 != 0 {
            return Err(ControlError::new(
                "DAEMON_PROFILE_MODE",
                "profile directory is not private",
            ));
        }
        if !directory && metadata.mode() & 0o500 != 0o500 {
            return Err(ControlError::new(
                "DAEMON_PROFILE_EXECUTABLE",
                "daemon executable is not owner readable and executable",
            ));
        }
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| ControlError::new("DAEMON_PROFILE_PATH", "profile path cannot be resolved"))?;
    if canonical != path {
        return Err(ControlError::new(
            "DAEMON_PROFILE_DRIFT",
            "profile path is not canonical",
        ));
    }
    Ok(canonical)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPreferences {
    pub daemon_profile: Option<DaemonProfile>,
    pub keep_collecting_after_quit: bool,
    pub open_at_login: bool,
    pub revision: u64,
    pub child_identity: Option<ChildDiagnosticIdentity>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildDiagnosticIdentity {
    pub pid: u32,
    pub process_start: String,
}

pub struct PreferenceStore {
    path: PathBuf,
}

impl PreferenceStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<DesktopPreferences, ControlError> {
        #[cfg(windows)]
        {
            return Err(ControlError::windows_unavailable());
        }
        #[cfg(unix)]
        {
            let Some(parent) = open_preference_parent(&self.path, false)? else {
                return Ok(DesktopPreferences::default());
            };
            self.load_from_parent(&parent)
        }
    }

    #[cfg(unix)]
    fn load_from_parent(&self, parent: &File) -> Result<DesktopPreferences, ControlError> {
        let name = preference_name(&self.path)?;
        let Some(file) = open_private_file(parent, &name, libc::O_RDONLY, 0, false)? else {
            return Ok(DesktopPreferences::default());
        };
        let mut bytes = Vec::new();
        file.take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ControlError::new("PREFERENCES_READ", "cannot read preferences"))?;
        if bytes.len() > 64 * 1024 {
            return Err(ControlError::new(
                "PREFERENCES_TORN",
                "preferences exceed limit",
            ));
        }
        let preferences: DesktopPreferences = serde_json::from_slice(&bytes)
            .map_err(|_| ControlError::new("PREFERENCES_TORN", "preferences are incomplete"))?;
        if preferences.revision == 0 {
            return Err(ControlError::new(
                "PREFERENCES_TORN",
                "stored preference revision is invalid",
            ));
        }
        if let Some(profile) = &preferences.daemon_profile {
            profile.paths()?;
        }
        Ok(preferences)
    }

    pub fn save(&self, preferences: &DesktopPreferences) -> Result<(), ControlError> {
        let expected_revision = self.load()?.revision;
        self.save_if_revision(preferences, expected_revision)
    }

    pub fn save_if_revision(
        &self,
        preferences: &DesktopPreferences,
        expected_revision: u64,
    ) -> Result<(), ControlError> {
        #[cfg(windows)]
        {
            let _ = (preferences, expected_revision);
            return Err(ControlError::windows_unavailable());
        }
        #[cfg(unix)]
        {
            self.save_if_revision_unix(preferences, expected_revision)
        }
    }

    #[cfg(unix)]
    fn save_if_revision_unix(
        &self,
        preferences: &DesktopPreferences,
        expected_revision: u64,
    ) -> Result<(), ControlError> {
        use std::ffi::CString;
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        if let Some(profile) = &preferences.daemon_profile {
            profile.paths()?;
        }
        let parent = open_preference_parent(&self.path, true)?
            .ok_or_else(|| ControlError::new("PREFERENCES_PATH", "no preference directory"))?;
        let lock_path = self.path.with_extension("json.lock");
        let lock_name = preference_name(&lock_path)?;
        let lock = open_private_file(&parent, &lock_name, libc::O_RDWR, 0o600, true)?
            .ok_or_else(|| ControlError::new("PREFERENCES_LOCK", "cannot open lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(ControlError::new(
                "PREFERENCES_LOCK",
                "cannot lock preferences",
            ));
        }
        let current = self.load_from_parent(&parent)?;
        if current.revision != expected_revision
            || Some(preferences.revision) != expected_revision.checked_add(1)
        {
            return Err(ControlError::new(
                "PREFERENCES_CHANGED",
                "preference revision changed",
            ));
        }
        let name = self
            .path
            .file_name()
            .ok_or_else(|| ControlError::new("PREFERENCES_PATH", "no preference filename"))?;
        static NEXT_TEMP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| ControlError::new("PREFERENCES_WRITE", "clock unavailable"))?
            .as_nanos();
        let temporary = format!(
            ".{}.{}.{}.{}.tmp",
            name.to_string_lossy(),
            std::process::id(),
            stamp,
            NEXT_TEMP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let temporary = CString::new(temporary)
            .map_err(|_| ControlError::new("PREFERENCES_PATH", "invalid temporary filename"))?;
        let name = CString::new(name.as_bytes())
            .map_err(|_| ControlError::new("PREFERENCES_PATH", "invalid preference filename"))?;
        let bytes = serde_json::to_vec(preferences)
            .map_err(|_| ControlError::new("PREFERENCES_WRITE", "cannot encode preferences"))?;
        let result = (|| {
            let mut file = open_private_file(
                &parent,
                &temporary,
                libc::O_WRONLY | libc::O_EXCL,
                0o600,
                true,
            )?
            .ok_or_else(|| {
                ControlError::new("PREFERENCES_WRITE", "cannot create temporary preferences")
            })?;
            file.write_all(&bytes)
                .map_err(|_| ControlError::new("PREFERENCES_WRITE", "cannot write preferences"))?;
            file.sync_all()
                .map_err(|_| ControlError::new("PREFERENCES_WRITE", "cannot sync preferences"))?;
            // A complete, synced replacement is the only recovery candidate. Torn temporary files are ignored.
            if unsafe {
                libc::renameat(
                    parent.as_raw_fd(),
                    temporary.as_ptr(),
                    parent.as_raw_fd(),
                    name.as_ptr(),
                )
            } != 0
            {
                return Err(ControlError::new(
                    "PREFERENCES_WRITE",
                    "cannot replace preferences",
                ));
            }
            let _reopened = open_private_file(&parent, &name, libc::O_RDONLY, 0, false)?
                .ok_or_else(|| ControlError::new("PREFERENCES_WRITE", "replacement is missing"))?;
            parent.sync_all().map_err(|_| {
                ControlError::new("PREFERENCES_WRITE", "cannot sync preference directory")
            })?;
            Ok(())
        })();
        if result.is_err() {
            unsafe { libc::unlinkat(parent.as_raw_fd(), temporary.as_ptr(), 0) };
        }
        drop(lock);
        result
    }
}

#[cfg(unix)]
fn preference_name(path: &Path) -> Result<std::ffi::CString, ControlError> {
    use std::os::unix::ffi::OsStrExt;
    let name = path
        .file_name()
        .ok_or_else(|| ControlError::new("PREFERENCES_PATH", "no preference filename"))?;
    std::ffi::CString::new(name.as_bytes())
        .map_err(|_| ControlError::new("PREFERENCES_PATH", "invalid preference filename"))
}

/// Open each ancestor from a directory descriptor, refusing symlinks at every component.
#[cfg(unix)]
fn open_preference_parent(path: &Path, create: bool) -> Result<Option<File>, ControlError> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Component;
    if !path.is_absolute() {
        return Err(ControlError::new(
            "PREFERENCES_PATH",
            "preference path must be absolute",
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| ControlError::new("PREFERENCES_PATH", "no preference parent"))?;
    let root = CString::new("/").expect("root has no NUL");
    let root_fd = unsafe {
        libc::open(
            root.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if root_fd < 0 {
        return Err(ControlError::new(
            "PREFERENCES_PATH",
            "cannot open root directory",
        ));
    }
    let mut dir = unsafe { File::from_raw_fd(root_fd) };
    for component in parent.components() {
        let Component::Normal(name) = component else {
            if matches!(component, Component::RootDir) {
                continue;
            }
            return Err(ControlError::new(
                "PREFERENCES_PATH",
                "noncanonical preference path",
            ));
        };
        let name = CString::new(name.as_bytes())
            .map_err(|_| ControlError::new("PREFERENCES_PATH", "invalid preference path"))?;
        let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let mut next_fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
        if next_fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::NotFound {
                if !create {
                    return Ok(None);
                }
                if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                    return Err(ControlError::new(
                        "PREFERENCES_PATH",
                        "cannot create private directory",
                    ));
                }
                next_fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags) };
            }
        }
        if next_fd < 0 {
            return Err(ControlError::new(
                "PREFERENCES_PATH",
                "unsafe preference ancestor",
            ));
        }
        dir = unsafe { File::from_raw_fd(next_fd) };
    }
    use std::os::unix::fs::MetadataExt;
    let metadata = dir
        .metadata()
        .map_err(|_| ControlError::new("PREFERENCES_PATH", "cannot inspect preference parent"))?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o700
    {
        return Err(ControlError::new(
            "PRIVATE_PATH_MODE",
            "preference parent is not owner-only",
        ));
    }
    Ok(Some(dir))
}

#[cfg(unix)]
fn open_private_file(
    parent: &File,
    name: &std::ffi::CString,
    flags: libc::c_int,
    mode: libc::mode_t,
    create: bool,
) -> Result<Option<File>, ControlError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    let create_flag = if create { libc::O_CREAT } else { 0 };
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            flags | create_flag | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        if !create && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(ControlError::new(
            "PRIVATE_PATH_OPEN",
            "cannot open private file",
        ));
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|_| {
        ControlError::new("PRIVATE_PATH_OPEN", "cannot inspect opened private file")
    })?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o777 != 0o600
    {
        return Err(ControlError::new(
            "PRIVATE_PATH_MODE",
            "opened private file is unsafe",
        ));
    }
    Ok(Some(file))
}

fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

#[cfg(unix)]
pub(crate) fn verify_private(path: &Path, directory: bool) -> Result<(), ControlError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| ControlError::new("PRIVATE_PATH_MISSING", "private path is missing"))?;
    if is_link(&metadata) {
        return Err(ControlError::new(
            "PRIVATE_PATH_LINK",
            "private path is a link",
        ));
    }
    if metadata.is_dir() != directory {
        return Err(ControlError::new(
            "PRIVATE_PATH_TYPE",
            "private path has wrong type",
        ));
    }
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != unsafe { libc::geteuid() } {
        return Err(ControlError::new(
            "PRIVATE_PATH_OWNER",
            "private path has wrong owner",
        ));
    }
    if directory && metadata.mode() & 0o777 != 0o700 {
        return Err(ControlError::new(
            "PRIVATE_PATH_MODE",
            "private directory has wrong mode",
        ));
    }
    if !directory && metadata.mode() & 0o777 != 0o600 {
        return Err(ControlError::new(
            "PRIVATE_PATH_MODE",
            "private file has wrong mode",
        ));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn replacement_after_parent_open_does_not_redirect_preference_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let old = root.join("private");
        let attacker = root.join("attacker");
        fs::create_dir(&old).unwrap();
        fs::create_dir(&attacker).unwrap();
        fs::set_permissions(&old, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&attacker, fs::Permissions::from_mode(0o700)).unwrap();
        let store = PreferenceStore::new(old.join("desktop.json"));
        let private = DesktopPreferences {
            revision: 1,
            ..DesktopPreferences::default()
        };
        store.save(&private).unwrap();
        let parent = open_preference_parent(store.path(), false)
            .unwrap()
            .unwrap();
        fs::rename(&old, root.join("moved")).unwrap();
        fs::write(attacker.join("desktop.json"), b"not owner preferences").unwrap();
        symlink(&attacker, &old).unwrap();
        assert_eq!(store.load_from_parent(&parent).unwrap().revision, 1);
        assert_eq!(store.load().unwrap_err().code, "PREFERENCES_PATH");
    }
}
