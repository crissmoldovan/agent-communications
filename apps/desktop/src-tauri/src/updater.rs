//! The app's own updater (desktop design DA8, DA15): tauri-plugin-updater with `requireSignedVersion`, finding
//! `desktop-v*` releases of this public repository through GitHub's API, with no token. Off in a copy built without the
//! updater key, which says so.
//!
//! GitHub's Latest release is the CLI's, so the app's are published with `--latest=false` and found here: the highest
//! complete `desktop-v<version>` release names the `latest.json` the plugin then reads, verifies and installs from.

use crate::ipc::{AppError, UpdaterState, UpdaterStatus};
use crate::window;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// True only in a copy built with the updater key: `build.rs` writes `AGENTCOMMS_DESKTOP_UPDATER`.
pub const UPDATER_ON: bool = flag_is_on(option_env!("AGENTCOMMS_DESKTOP_UPDATER"));

/// What Settings says when the updater is off.
pub const OFF_MESSAGE: &str =
    "Updates for this app are off: this copy was built without the updater key.";

/// The releases GitHub's API lists: the CLI's `v*` and the app's `desktop-v*`, the newest first.
pub const RELEASES_URL: &str =
    "https://api.github.com/repos/crissmoldovan/agent-communications/releases?per_page=30";

/// Where this repository serves a release's files: a manifest from anywhere else is not taken.
const DOWNLOADS: &str = "https://github.com/crissmoldovan/agent-communications/releases/download/";

/// The app's release tags: `desktop-v` and a version.
const TAG_PREFIX: &str = "desktop-v";

/// The event the window hears the updater on.
pub const EVENT: &str = "updater";

/// The first silent check waits a minute after launch; then one a day (DA8).
const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// How long GitHub's list may take, and how much of it is read.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LIST_LIMIT: u64 = 4 * 1024 * 1024;

/// How long the plugin's own requests may take: the manifest, then the download.
const PLUGIN_TIMEOUT: Duration = Duration::from_secs(120);

/// Who asks GitHub: its API refuses a request without a `User-Agent`. No token is sent, or built in.
const USER_AGENT: &str = "agentcomms-desktop-updater";

/// Whether `build.rs`'s word turns the updater on. A `const fn`, so `UPDATER_ON` is fixed when the app is built.
pub const fn flag_is_on(value: Option<&str>) -> bool {
    match value {
        Some(word) => {
            let word = word.as_bytes();
            word.len() == 2 && word[0] == b'o' && word[1] == b'n'
        }
        None => false,
    }
}

fn state(status: UpdaterStatus, version: Option<String>, message: Option<String>) -> UpdaterState {
    UpdaterState {
        on: UPDATER_ON,
        status,
        version,
        message,
    }
}

/// What the updater says when it is off.
pub fn off_state() -> UpdaterState {
    UpdaterState {
        on: false,
        status: UpdaterStatus::Off,
        version: None,
        message: Some(OFF_MESSAGE.into()),
    }
}

/// What it says before any check has spoken.
fn idle() -> UpdaterState {
    state(UpdaterStatus::Idle, None, None)
}

#[derive(Deserialize)]
struct Release {
    tag_name: Option<String>,
    draft: Option<bool>,
    prerelease: Option<bool>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// The `latest.json` of the highest complete desktop release: not a draft, not a prerelease, tagged
/// `desktop-v<major.minor.patch>` with no pre-release suffix, and carrying a `latest.json` that this repository serves
/// for that tag. None when there is none, or the list cannot be read.
pub fn pick_manifest_url(releases_json: &str) -> Option<String> {
    let releases: Vec<Release> = serde_json::from_str(releases_json).ok()?;
    releases
        .iter()
        .filter(|release| release.draft == Some(false) && release.prerelease == Some(false))
        .filter_map(|release| {
            let tag = release.tag_name.as_deref()?;
            let version = semver::Version::parse(tag.strip_prefix(TAG_PREFIX)?).ok()?;
            if !version.pre.is_empty() || !version.build.is_empty() {
                return None;
            }
            let manifest = format!("{DOWNLOADS}{tag}/latest.json");
            release
                .assets
                .iter()
                .any(|asset| asset.name == "latest.json" && asset.browser_download_url == manifest)
                .then_some((version, manifest))
        })
        .max_by(|(one, _), (other, _)| one.cmp(other))
        .map(|(_, manifest)| manifest)
}

/// Asks `get` for the releases list once, and picks the manifest from it. `get` is GitHub in the app and a stand-in in
/// tests: nothing here reaches the network on its own.
pub fn find_manifest(get: &dyn Fn(&str) -> Result<String, String>) -> Result<String, String> {
    let releases = get(RELEASES_URL)?;
    pick_manifest_url(&releases)
        .ok_or_else(|| "No release of this app has been published yet.".to_string())
}

/// GitHub's API, over HTTPS only, with a `User-Agent` and no token.
fn github_get(url: &str) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .https_only(true)
        .timeout_global(Some(LIST_TIMEOUT))
        .user_agent(USER_AGENT)
        .build()
        .into();
    let mut response = agent
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .call()
        .map_err(|error| format!("GitHub could not be asked for this app's releases: {error}."))?;
    response
        .body_mut()
        .with_config()
        .limit(LIST_LIMIT)
        .read_to_string()
        .map_err(|error| format!("GitHub's list of releases could not be read: {error}."))
}

/// The updater's state, its update found, and whether a check or an install is under way.
pub struct Updates {
    state: Mutex<UpdaterState>,
    found: Mutex<Option<Update>>,
    busy: AtomicBool,
}

impl Default for Updates {
    fn default() -> Self {
        Updates {
            state: Mutex::new(if UPDATER_ON { idle() } else { off_state() }),
            found: Mutex::new(None),
            busy: AtomicBool::new(false),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Keeps `next` as the updater's state, and tells the window.
fn record(app: &AppHandle, updates: &Updates, next: &UpdaterState) {
    *lock(&updates.state) = next.clone();
    let _ = app.emit(EVENT, next);
}

/// Where the updater stands.
pub fn current(app: &AppHandle) -> UpdaterState {
    if !UPDATER_ON {
        return off_state();
    }
    app.try_state::<Updates>()
        .map(|updates| lock(&updates.state).clone())
        .unwrap_or_else(idle)
}

/// Finds the newest release's manifest, and asks the plugin whether it is newer than this copy.
async fn find_update(app: &AppHandle) -> Result<Option<Update>, String> {
    let manifest = tauri::async_runtime::spawn_blocking(|| find_manifest(&github_get))
        .await
        .map_err(|error| format!("The update check stopped: {error}."))??;
    let endpoint: Url = manifest
        .parse()
        .map_err(|_| "The release's update manifest has no usable address.".to_string())?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("The updater could not be set up: {error}."))?
        .timeout(PLUGIN_TIMEOUT)
        .build()
        .map_err(|error| format!("The updater could not be set up: {error}."))?
        .check()
        .await
        .map_err(|error| format!("Could not check for an update: {error}."))
}

/// Looks for an update. A check the person asked for says each step, as the `updater` event; a silent one speaks only
/// when it finds an update, and otherwise changes nothing. Off, it says so and asks nobody.
pub async fn check(app: &AppHandle, silent: bool) -> UpdaterState {
    if !UPDATER_ON {
        let off = off_state();
        if !silent {
            let _ = app.emit(EVENT, &off);
        }
        return off;
    }
    let Some(updates) = app.try_state::<Updates>() else {
        return idle();
    };
    // One check or install at a time: a second is told where the first stands.
    if updates.busy.swap(true, Ordering::SeqCst) {
        return current(app);
    }
    if !silent {
        record(app, &updates, &state(UpdaterStatus::Checking, None, None));
    }
    let next = match find_update(app).await {
        Ok(Some(update)) => {
            let next = state(UpdaterStatus::Available, Some(update.version.clone()), None);
            *lock(&updates.found) = Some(update);
            record(app, &updates, &next);
            next
        }
        Ok(None) => {
            let next = state(
                UpdaterStatus::None,
                None,
                Some("This is the latest version of Agent Comms.".into()),
            );
            if !silent {
                *lock(&updates.found) = None;
                record(app, &updates, &next);
            }
            next
        }
        Err(message) => {
            let next = state(UpdaterStatus::Error, None, Some(message));
            if !silent {
                record(app, &updates, &next);
            }
            next
        }
    };
    updates.busy.store(false, Ordering::SeqCst);
    next
}

/// Downloads the update found, verifies its signature and version, installs it, and restarts into it.
pub async fn install(app: &AppHandle) -> Result<(), AppError> {
    if !UPDATER_ON {
        return Err(AppError::refused(OFF_MESSAGE));
    }
    let updates = app
        .try_state::<Updates>()
        .ok_or_else(|| AppError::io("the updater has not started"))?;
    let Some(update) = lock(&updates.found).clone() else {
        return Err(AppError::refused(
            "No update has been found to install: check for updates first.",
        ));
    };
    if updates.busy.swap(true, Ordering::SeqCst) {
        return Err(AppError::refused(
            "The updater is busy checking or installing: try again in a moment.",
        ));
    }
    let version = Some(update.version.clone());
    record(
        app,
        &updates,
        &state(UpdaterStatus::Downloading, version.clone(), None),
    );
    // On Windows the installer the plugin starts closes the app itself; elsewhere the app restarts into the update.
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            record(app, &updates, &state(UpdaterStatus::Ready, version, None));
            window::QUITTING.store(true, Ordering::SeqCst);
            app.restart()
        }
        Err(error) => {
            let message = format!("The update could not be installed: {error}.");
            record(
                app,
                &updates,
                &state(UpdaterStatus::Error, version, Some(message.clone())),
            );
            updates.busy.store(false, Ordering::SeqCst);
            Err(AppError::io(message))
        }
    }
}

/// The silent checks: a minute after launch, then every 24 hours. Nothing starts when the updater is off.
pub fn start(app: &AppHandle) {
    if !UPDATER_ON {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            tauri::async_runtime::block_on(check(&app, true));
            std::thread::sleep(EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;

    const DOWNLOAD: &str =
        "https://github.com/crissmoldovan/agent-communications/releases/download";

    fn asset(tag: &str, name: &str) -> serde_json::Value {
        json!({ "name": name, "browser_download_url": format!("{DOWNLOAD}/{tag}/{name}") })
    }

    fn release(tag: &str, draft: bool, prerelease: bool, names: &[&str]) -> serde_json::Value {
        json!({
            "tag_name": tag,
            "draft": draft,
            "prerelease": prerelease,
            "assets": names.iter().map(|name| asset(tag, name)).collect::<Vec<_>>(),
        })
    }

    fn complete(tag: &str) -> serde_json::Value {
        release(
            tag,
            false,
            false,
            &[
                "Agent.Comms.app.tar.gz",
                "Agent.Comms.app.tar.gz.sig",
                "latest.json",
            ],
        )
    }

    #[test]
    fn picks_the_highest_complete_desktop_release() {
        let releases = json!([
            // The CLI's release is GitHub's Latest, and is never the app's, even with a latest.json.
            complete("v0.25.0"),
            release("desktop-v0.27.0", true, false, &["latest.json"]),
            release("desktop-v0.28.0", false, true, &["latest.json"]),
            complete("desktop-v0.26.0-rc.1"),
            release("desktop-v0.29.0", false, false, &["Agent.Comms.dmg"]),
            complete("desktop-v0.24.2"),
            // 0.24.10 is higher than 0.24.2: versions, not text, are compared.
            complete("desktop-v0.24.10"),
            complete("desktop-v0.9.0"),
            // Not a version, or a version written another way.
            complete("desktop-vnext"),
            complete("desktop-v0.30"),
            complete("desktop-v01.0.0"),
            complete("desktop-v1.0.0+build.5"),
            complete("desktop-0.31.0"),
        ]);
        assert_eq!(
            pick_manifest_url(&releases.to_string()).as_deref(),
            Some(format!("{DOWNLOAD}/desktop-v0.24.10/latest.json").as_str())
        );
    }

    #[test]
    fn a_manifest_this_repository_does_not_serve_for_that_tag_is_skipped() {
        let mut elsewhere = complete("desktop-v0.40.0");
        elsewhere["assets"][2]["browser_download_url"] =
            json!("https://example.com/desktop-v0.40.0/latest.json");
        let mut other_tag = complete("desktop-v0.41.0");
        other_tag["assets"][2]["browser_download_url"] =
            json!(format!("{DOWNLOAD}/desktop-v0.24.0/latest.json"));
        let releases = json!([elsewhere, other_tag, complete("desktop-v0.24.0")]);
        assert_eq!(
            pick_manifest_url(&releases.to_string()).as_deref(),
            Some(format!("{DOWNLOAD}/desktop-v0.24.0/latest.json").as_str())
        );
    }

    #[test]
    fn no_complete_release_or_an_unreadable_list_picks_nothing() {
        assert_eq!(pick_manifest_url("[]"), None);
        assert_eq!(pick_manifest_url("not json"), None);
        assert_eq!(
            pick_manifest_url(r#"{"message":"API rate limit exceeded"}"#),
            None
        );
        assert_eq!(
            pick_manifest_url(&json!([complete("v0.25.0")]).to_string()),
            None
        );
    }

    #[test]
    fn the_manifest_is_found_with_one_request_to_the_releases_list() {
        let asked = RefCell::new(Vec::new());
        let body = json!([complete("desktop-v0.24.0")]).to_string();
        let get = |url: &str| {
            asked.borrow_mut().push(url.to_string());
            Ok(body.clone())
        };
        assert_eq!(
            find_manifest(&get),
            Ok(format!("{DOWNLOAD}/desktop-v0.24.0/latest.json"))
        );
        assert_eq!(*asked.borrow(), [RELEASES_URL]);

        let failing = |_: &str| Err("offline".to_string());
        assert!(find_manifest(&failing).is_err());
        let empty = |_: &str| Ok("[]".to_string());
        assert!(find_manifest(&empty).is_err());
    }

    #[test]
    fn updater_is_off_without_the_key() {
        // `build.rs` always writes the word: `on` with `TAURI_SIGNING_PRIVATE_KEY`, `off` without.
        assert!(matches!(
            option_env!("AGENTCOMMS_DESKTOP_UPDATER"),
            Some("on") | Some("off")
        ));
        assert!(flag_is_on(Some("on")));
        for word in [
            None,
            Some("off"),
            Some(""),
            Some("ON"),
            Some("on "),
            Some("1"),
            Some("true"),
        ] {
            assert!(!flag_is_on(word), "{word:?}");
        }
        assert_eq!(
            serde_json::to_value(off_state()).expect("json"),
            json!({
                "on": false,
                "status": "off",
                "version": null,
                "message": "Updates for this app are off: this copy was built without the updater key."
            })
        );
        assert_eq!(off_state().status, UpdaterStatus::Off);
    }
}
