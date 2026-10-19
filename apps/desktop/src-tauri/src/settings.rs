//! The app's own settings (DA12): the folders Settings name in place of `AGENT_COMMS_CONFIG_DIR`,
//! `AGENT_COMMS_STATE_DIR` and `AGENT_COMMS_DATA_DIR`, which an app started from the Dock or the Start menu cannot see.
//!
//! They are kept in `<app_config_dir>/settings.json` as `{ "folders": FolderOverrides }`, and loaded into `AppState`
//! when the app starts. Every folder is a full path for the platform, or none; a file the app cannot read is no
//! override, and a folder in it that is not a full path is dropped. The login item is not kept here: the system keeps
//! it (`login_item`).

use crate::ipc::{AppError, AppSettings};
use crate::login_item;
use crate::paths::{resolve_folders, FolderOverrides, PathEnv, Platform};
use crate::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, MutexGuard};
use tauri::{AppHandle, Manager};

/// The settings file's name, in the app's config folder.
pub const FILE: &str = "settings.json";

/// The longest folder Settings take, in characters.
const FOLDER_LIMIT: usize = 4096;

/// What a folder never holds: a control or format character, or a line or paragraph separator.
static NEVER_IN_A_FOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]").expect("a pattern"));

/// The settings file. Fields a later version adds are skipped; the folders refuse any they do not know.
#[derive(Default, Serialize, Deserialize)]
struct SettingsFile {
    #[serde(default)]
    folders: FolderOverrides,
}

/// Whether `path` is a full path on `platform`: from `/` on macOS and Linux; on Windows from a drive's root (`C:\`
/// or `C:/`), or a share (`\\server\share`). A drive with no root (`C:x`), a root with no drive (`\x`) and Windows'
/// device and verbatim forms (`\\.\`, `\\?\`) are not.
pub fn is_absolute(path: &str, platform: Platform) -> bool {
    match platform {
        Platform::MacOs | Platform::Linux => path.starts_with('/'),
        Platform::Windows => {
            let bytes = path.as_bytes();
            let drive = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/');
            let share = path.strip_prefix("\\\\").is_some_and(|rest| {
                let mut parts = rest.split(['\\', '/']);
                matches!(
                    (parts.next(), parts.next()),
                    (Some(server), Some(share))
                        if !server.is_empty() && !share.is_empty() && server != "?" && server != "."
                )
            });
            drive || share
        }
    }
}

/// One folder as Settings keep it: none when it is unset or only spaces, the folder when it is a full path with
/// nothing hidden in it, and refused otherwise.
fn folder(
    name: &str,
    value: Option<String>,
    platform: Platform,
) -> Result<Option<String>, AppError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        return Ok(None);
    }
    if value.chars().count() > FOLDER_LIMIT
        || NEVER_IN_A_FOLDER.is_match(&value)
        || !is_absolute(&value, platform)
    {
        let full = match platform {
            Platform::Windows => {
                "from a drive, such as C:\\, or a share, such as \\\\server\\share"
            }
            Platform::MacOs | Platform::Linux => "from /",
        };
        return Err(AppError::refused(format!(
            "the {name} folder must be a full path, {full}, with no hidden characters"
        )));
    }
    Ok(Some(value))
}

/// The folders Settings were given, as they are kept: each a full path for `platform`, or none.
pub fn validate(folders: FolderOverrides, platform: Platform) -> Result<FolderOverrides, AppError> {
    Ok(FolderOverrides {
        config_dir: folder("config", folders.config_dir, platform)?,
        state_dir: folder("state", folders.state_dir, platform)?,
        data_dir: folder("data", folders.data_dir, platform)?,
    })
}

/// The folders kept in `dir`: none when there is no file or the app cannot read it, and each one that is not a full
/// path for `platform` dropped.
pub fn load(dir: &Path, platform: Platform) -> FolderOverrides {
    let Ok(text) = fs::read_to_string(dir.join(FILE)) else {
        return FolderOverrides::default();
    };
    let Ok(file) = serde_json::from_str::<SettingsFile>(&text) else {
        return FolderOverrides::default();
    };
    let keep = |name: &str, value: Option<String>| folder(name, value, platform).ok().flatten();
    FolderOverrides {
        config_dir: keep("config", file.folders.config_dir),
        state_dir: keep("state", file.folders.state_dir),
        data_dir: keep("data", file.folders.data_dir),
    }
}

/// Keeps `folders` in `dir`, making the folder if it is missing. The file is written beside its place, then moved
/// there, so a reader never sees half of it.
pub fn save(dir: &Path, folders: &FolderOverrides) -> Result<(), AppError> {
    let failed = |error: std::io::Error| {
        AppError::io(format!(
            "the settings could not be saved in {}: {error}",
            dir.display()
        ))
    };
    fs::create_dir_all(dir).map_err(failed)?;
    let mut text = serde_json::to_string_pretty(&SettingsFile {
        folders: folders.clone(),
    })
    .map_err(|error| AppError::io(format!("the settings could not be written: {error}")))?;
    text.push('\n');
    let temporary = dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    fs::write(&temporary, text).map_err(failed)?;
    fs::rename(&temporary, dir.join(FILE)).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        failed(error)
    })
}

/// The app's config folder, where `settings.json` lives.
pub fn settings_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path().app_config_dir().map_err(|error| {
        AppError::io(format!(
            "the app's settings folder could not be found: {error}"
        ))
    })
}

fn overrides(state: &AppState) -> MutexGuard<'_, FolderOverrides> {
    state
        .overrides
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Loads the kept folders into `AppState`, when the app starts.
pub fn load_into_state(app: &AppHandle) {
    if let Ok(dir) = settings_dir(app) {
        let folders = load(&dir, Platform::current());
        *overrides(&app.state::<AppState>()) = folders;
    }
}

/// The settings now: the folders Settings name, the four they resolve to with this process's environment, and the
/// login item.
pub fn current(app: &AppHandle, state: &AppState) -> AppSettings {
    let folders = overrides(state).clone();
    AppSettings {
        resolved: resolve_folders(&PathEnv::from_process().with_overrides(&folders)),
        folders,
        login_item: login_item::enabled(app),
        login_item_available: login_item::available(),
    }
}

/// Keeps the folders Settings were given, once each is a full path, and uses them from the next call on.
pub fn set_folders(
    app: &AppHandle,
    state: &AppState,
    folders: FolderOverrides,
) -> Result<AppSettings, AppError> {
    let folders = validate(folders, Platform::current())?;
    save(&settings_dir(app)?, &folders)?;
    *overrides(state) = folders;
    Ok(current(app, state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn overrides(config: Option<&str>, state: Option<&str>, data: Option<&str>) -> FolderOverrides {
        FolderOverrides {
            config_dir: config.map(str::to_string),
            state_dir: state.map(str::to_string),
            data_dir: data.map(str::to_string),
        }
    }

    #[test]
    fn folders_must_be_absolute_and_round_trip_through_settings_json() {
        // Absolute folders are kept; an empty one, or one of only spaces, is no override.
        let posix = overrides(
            Some("/example/home/config"),
            Some(""),
            Some("/example/home/data dir"),
        );
        assert_eq!(
            validate(posix, Platform::Linux).expect("valid"),
            overrides(
                Some("/example/home/config"),
                None,
                Some("/example/home/data dir")
            )
        );
        assert_eq!(
            validate(overrides(None, Some("   "), None), Platform::MacOs).expect("valid"),
            FolderOverrides::default()
        );
        let windows = overrides(
            Some("C:\\example\\home\\config"),
            Some("\\\\server\\share\\state"),
            Some("D:/example/data"),
        );
        assert_eq!(
            validate(windows.clone(), Platform::Windows).expect("valid"),
            windows
        );
        // Anything relative, or anything else a folder is not, is refused.
        for (platform, folder) in [
            (Platform::Linux, "relative/x"),
            (Platform::Linux, "./x"),
            (Platform::Linux, "~/x"),
            (Platform::MacOs, "x"),
            (Platform::MacOs, "-x"),
            (Platform::Linux, "C:\\example\\home"),
            (Platform::Linux, "/example/line\nbreak"),
            (Platform::MacOs, "/example/\u{202E}tfel"),
            (Platform::Linux, "/example/nul\0"),
            (Platform::Windows, "C:example"),
            (Platform::Windows, "\\example"),
            (Platform::Windows, "/example/home"),
            (Platform::Windows, "example\\home"),
            (Platform::Windows, "\\\\server"),
            (Platform::Windows, "C:\\example\\tab\there"),
        ] {
            for field in 0..3 {
                let mut given = FolderOverrides::default();
                let slot = match field {
                    0 => &mut given.config_dir,
                    1 => &mut given.state_dir,
                    _ => &mut given.data_dir,
                };
                *slot = Some(folder.to_string());
                let refused = validate(given, platform).expect_err(folder);
                assert_eq!(refused.code, "APP_REFUSED", "{platform:?} {folder:?}");
            }
        }
        let long = format!("/{}", "a".repeat(5000));
        assert!(validate(overrides(Some(&long), None, None), Platform::Linux).is_err());

        // Saved, then loaded: the same folders, in `{ "folders": … }`.
        let dir = tempfile::tempdir().expect("a folder");
        let settings = dir.path().join("nested").join("app");
        let saved = overrides(
            Some("/example/home/config"),
            None,
            Some("/example/home/data"),
        );
        save(&settings, &saved).expect("saved");
        assert_eq!(load(&settings, Platform::Linux), saved);
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(settings.join(FILE)).expect("written"))
                .expect("JSON");
        assert_eq!(
            written,
            serde_json::json!({
                "folders": { "configDir": "/example/home/config", "stateDir": null, "dataDir": "/example/home/data" }
            })
        );
        // Saving again replaces it, and leaves nothing beside it.
        save(&settings, &FolderOverrides::default()).expect("saved");
        assert_eq!(load(&settings, Platform::Linux), FolderOverrides::default());
        let names: Vec<String> = fs::read_dir(&settings)
            .expect("listed")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec![FILE.to_string()]);

        // No file, or one the app cannot read, is no override; a folder that is not absolute is dropped.
        let empty = tempfile::tempdir().expect("a folder");
        assert_eq!(
            load(empty.path(), Platform::Linux),
            FolderOverrides::default()
        );
        for text in [
            "not json",
            "[]",
            "{\"folders\":{\"secretsDir\":\"/x\"}}",
            "{\"folders\":{\"configDir\":7}}",
        ] {
            fs::write(empty.path().join(FILE), text).expect("written");
            assert_eq!(
                load(empty.path(), Platform::Linux),
                FolderOverrides::default(),
                "{text}"
            );
        }
        fs::write(
            empty.path().join(FILE),
            "{\"folders\":{\"configDir\":\"relative\",\"dataDir\":\"/example/data\"},\"later\":true}",
        )
        .expect("written");
        assert_eq!(
            load(empty.path(), Platform::Linux),
            overrides(None, None, Some("/example/data"))
        );
    }
}
