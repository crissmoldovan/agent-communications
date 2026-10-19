//! The app's own updater (desktop design DA8, DA15): tauri-plugin-updater with `requireSignedVersion`, finding
//! `desktop-v*` releases of this public repository through GitHub's API, with no token. Off in a copy built without the
//! updater key, which says so.
//!
//! GitHub's Latest release is the CLI's, so the app's are published with `--latest=false` and found here: the tags
//! `desktop-v<version>` are listed (`git/matching-refs`, which holds them all, however many CLI releases came since),
//! and the highest tag whose release is complete names the `latest.json` the plugin then reads, verifies and installs
//! from. Everything GitHub answers is read as untrusted: a tag is taken only as `desktop-v<major.minor.patch>`, and a
//! release only when it is that tag's, published, and carries a `latest.json` this repository serves for it.

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

/// Every tag that starts `desktop-v`, as GitHub's API lists them: one list, not paged by releases.
pub const TAGS_URL: &str =
    "https://api.github.com/repos/crissmoldovan/agent-communications/git/matching-refs/tags/desktop-v";

/// Where GitHub's API gives the release of one tag.
const RELEASE_BY_TAG: &str =
    "https://api.github.com/repos/crissmoldovan/agent-communications/releases/tags/";

/// The most releases one check asks for, highest tag first: a tag pushed before its release is published is passed
/// over for the one below it, and a run of such tags ends the search rather than ask GitHub about every one.
const RELEASES_ASKED: usize = 5;

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

/// The version a tag names, when it is `desktop-v<major.minor.patch>` with no pre-release or build part.
fn version_of(tag: &str) -> Option<semver::Version> {
    let version = semver::Version::parse(tag.strip_prefix(TAG_PREFIX)?).ok()?;
    (version.pre.is_empty() && version.build.is_empty()).then_some(version)
}

/// The desktop tags in what GitHub's `matching-refs` answered, highest version first: each `refs/tags/desktop-v…`
/// whose version is a plain one. Anything else in the answer — another kind of ref, a tag written another way, or an
/// answer that is not a list of refs — is left out.
pub fn tags_of(refs_json: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(refs)) = serde_json::from_str::<serde_json::Value>(refs_json)
    else {
        return vec![];
    };
    let mut tags: Vec<(semver::Version, String)> = refs
        .iter()
        .filter_map(|each| each.get("ref")?.as_str()?.strip_prefix("refs/tags/"))
        .filter_map(|tag| Some((version_of(tag)?, tag.to_string())))
        .collect();
    tags.sort_by(|(one, _), (other, _)| other.cmp(one));
    tags.dedup_by(|(one, _), (other, _)| one == other);
    tags.into_iter().map(|(_, tag)| tag).collect()
}

/// The `latest.json` a release names, when it is `tag`'s, published (not a draft, not a prerelease), and carries a
/// `latest.json` this repository serves for that tag. None otherwise, or when the answer is not a release.
pub fn manifest_of(release_json: &str, tag: &str) -> Option<String> {
    let release: Release = serde_json::from_str(release_json).ok()?;
    if release.tag_name.as_deref() != Some(tag)
        || release.draft != Some(false)
        || release.prerelease != Some(false)
        || version_of(tag).is_none()
    {
        return None;
    }
    let manifest = format!("{DOWNLOADS}{tag}/latest.json");
    release
        .assets
        .iter()
        .any(|asset| asset.name == "latest.json" && asset.browser_download_url == manifest)
        .then_some(manifest)
}

/// Lists the desktop tags, then asks for the release of each, highest first, up to `RELEASES_ASKED`, and takes the
/// first complete one's manifest. `get` is GitHub in the app and a stand-in in tests: nothing here reaches the network
/// on its own. A release that cannot be fetched — a tag pushed before its release is out — is passed over.
pub fn find_manifest(get: &dyn Fn(&str) -> Result<String, String>) -> Result<String, String> {
    let tags = tags_of(&get(TAGS_URL)?);
    tags.iter()
        .take(RELEASES_ASKED)
        .find_map(|tag| {
            let release = get(&format!("{RELEASE_BY_TAG}{tag}")).ok()?;
            manifest_of(&release, tag)
        })
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
        .map_err(|error| {
            format!("GitHub could not be asked about this app's releases: {error}.")
        })?;
    response
        .body_mut()
        .with_config()
        .limit(LIST_LIMIT)
        .read_to_string()
        .map_err(|error| {
            format!("GitHub's answer about this app's releases could not be read: {error}.")
        })
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
    fn a_release_names_its_manifest_only_when_it_is_that_tags_and_complete() {
        let tag = "desktop-v0.24.10";
        assert_eq!(
            manifest_of(&complete(tag).to_string(), tag).as_deref(),
            Some(format!("{DOWNLOAD}/{tag}/latest.json").as_str())
        );
        for (release, asked) in [
            // A draft, a prerelease, or one with no latest.json.
            (release(tag, true, false, &["latest.json"]), tag),
            (release(tag, false, true, &["latest.json"]), tag),
            (release(tag, false, false, &["Agent.Comms.dmg"]), tag),
            // Another tag's release, or the CLI's, even with a latest.json.
            (complete("desktop-v0.24.9"), tag),
            (complete("v0.25.0"), "v0.25.0"),
            // A tag written another way than a plain version.
            (complete("desktop-v0.26.0-rc.1"), "desktop-v0.26.0-rc.1"),
            (complete("desktop-v1.0.0+build.5"), "desktop-v1.0.0+build.5"),
            (complete("desktop-vnext"), "desktop-vnext"),
        ] {
            assert_eq!(manifest_of(&release.to_string(), asked), None, "{release}");
        }
        // A manifest this repository does not serve for that tag.
        let mut elsewhere = complete(tag);
        elsewhere["assets"][2]["browser_download_url"] =
            json!("https://example.com/desktop-v0.24.10/latest.json");
        assert_eq!(manifest_of(&elsewhere.to_string(), tag), None);
        let mut other_tag = complete(tag);
        other_tag["assets"][2]["browser_download_url"] =
            json!(format!("{DOWNLOAD}/desktop-v0.24.0/latest.json"));
        assert_eq!(manifest_of(&other_tag.to_string(), tag), None);
        // A release that names another tag, whatever address its manifest has.
        let mut renamed = complete(tag);
        renamed["tag_name"] = json!("desktop-v0.24.9");
        assert_eq!(manifest_of(&renamed.to_string(), tag), None);
        // An answer that is not a release.
        for body in ["", "not json", "[]", r#"{"message":"Not Found"}"#] {
            assert_eq!(manifest_of(body, tag), None, "{body:?}");
        }
    }

    #[test]
    fn tags_are_compared_as_versions_not_as_text() {
        assert_eq!(
            tags_of(&refs(&[
                "desktop-v0.9.0",
                "desktop-v0.24.2",
                "desktop-v0.24.10",
                "desktop-v1.0.0"
            ])),
            [
                "desktop-v1.0.0",
                "desktop-v0.24.10",
                "desktop-v0.24.2",
                "desktop-v0.9.0"
            ]
        );
    }

    /// A GitHub that answers each address from `pages`, records every address asked, and says 404 for the rest.
    fn github<'a>(
        pages: &'a [(String, String)],
        asked: &'a RefCell<Vec<String>>,
    ) -> impl Fn(&str) -> Result<String, String> + 'a {
        move |url: &str| {
            asked.borrow_mut().push(url.to_string());
            pages
                .iter()
                .find(|(at, _)| at == url)
                .map(|(_, body)| body.clone())
                .ok_or_else(|| format!("404 for {url}"))
        }
    }

    fn refs(tags: &[&str]) -> String {
        json!(tags
            .iter()
            .map(|tag| json!({
                "ref": format!("refs/tags/{tag}"),
                "object": { "sha": "0123456789abcdef0123456789abcdef01234567", "type": "commit" }
            }))
            .collect::<Vec<_>>())
        .to_string()
    }

    fn release_at(tag: &str) -> String {
        format!(
            "https://api.github.com/repos/crissmoldovan/agent-communications/releases/tags/{tag}"
        )
    }

    #[test]
    fn a_desktop_release_is_found_however_many_cli_releases_came_after_it() {
        // Thirty CLI releases, newest first, fill the first page of the releases list: the app's is not on it.
        let cli: Vec<serde_json::Value> = (0..30)
            .map(|n| complete(&format!("v0.{}.0", 60 - n)))
            .collect();
        let mut tags: Vec<String> = (0..35).map(|n| format!("desktop-v0.{n}.0")).collect();
        tags.push("desktop-v0.24.10".into());
        let tag_refs: Vec<&str> = tags.iter().map(String::as_str).collect();
        let pages = vec![
            (
                "https://api.github.com/repos/crissmoldovan/agent-communications/releases?per_page=30".to_string(),
                json!(cli).to_string(),
            ),
            (TAGS_URL.to_string(), refs(&tag_refs)),
            (release_at("desktop-v0.34.0"), complete("desktop-v0.34.0").to_string()),
        ];
        let asked = RefCell::new(Vec::new());
        assert_eq!(
            find_manifest(&github(&pages, &asked)),
            Ok(format!("{DOWNLOAD}/desktop-v0.34.0/latest.json"))
        );
        // The tags first, then the highest one's release, and nothing else.
        assert_eq!(
            *asked.borrow(),
            [TAGS_URL.to_string(), release_at("desktop-v0.34.0")]
        );
    }

    #[test]
    fn a_tag_with_no_complete_release_yet_is_passed_over_for_the_one_below() {
        let pages = vec![
            (
                TAGS_URL.to_string(),
                refs(&[
                    "desktop-v0.24.0",
                    "desktop-v0.25.0",
                    "desktop-v0.26.0",
                    "desktop-v0.27.0",
                ]),
            ),
            // 0.27.0's tag is pushed and its release not made yet (404); 0.26.0's is a draft or a prerelease, which an
            // anonymous read should never see, and is not taken if it does; 0.25.0's names a manifest elsewhere.
            (
                release_at("desktop-v0.26.0"),
                release("desktop-v0.26.0", true, false, &["latest.json"]).to_string(),
            ),
            (release_at("desktop-v0.25.0"), {
                let mut elsewhere = complete("desktop-v0.25.0");
                elsewhere["assets"][2]["browser_download_url"] =
                    json!("https://example.com/desktop-v0.25.0/latest.json");
                elsewhere.to_string()
            }),
            (
                release_at("desktop-v0.24.0"),
                complete("desktop-v0.24.0").to_string(),
            ),
        ];
        let asked = RefCell::new(Vec::new());
        assert_eq!(
            find_manifest(&github(&pages, &asked)),
            Ok(format!("{DOWNLOAD}/desktop-v0.24.0/latest.json"))
        );
        assert_eq!(asked.borrow().len(), 5);
        // A release for another tag than the one asked for is not that tag's.
        let pages = vec![
            (TAGS_URL.to_string(), refs(&["desktop-v0.30.0"])),
            (
                release_at("desktop-v0.30.0"),
                complete("desktop-v0.29.0").to_string(),
            ),
        ];
        assert!(find_manifest(&github(&pages, &RefCell::new(Vec::new()))).is_err());
    }

    #[test]
    fn the_tags_are_read_as_untrusted_and_only_a_few_releases_are_asked_for() {
        // What is not a desktop-v<major.minor.patch> tag is never asked about.
        let hostile = json!([
            { "ref": "refs/tags/desktop-v9.0.0-rc.1" },
            { "ref": "refs/tags/desktop-v9.0.0+build.1" },
            { "ref": "refs/tags/desktop-v09.0.0" },
            { "ref": "refs/tags/desktop-v9.0" },
            { "ref": "refs/tags/desktop-v9.0.0/../../x" },
            { "ref": "refs/heads/desktop-v9.0.0" },
            { "ref": "refs/tags/v9.0.0" },
            { "ref": 7 },
            { "no": "ref" },
            "refs/tags/desktop-v9.0.0",
            { "ref": "refs/tags/desktop-v0.24.0" }
        ])
        .to_string();
        assert_eq!(tags_of(&hostile), vec!["desktop-v0.24.0".to_string()]);
        for body in [
            "",
            "not json",
            "{}",
            r#"{"message":"Not Found"}"#,
            "[]",
            "null",
        ] {
            assert!(tags_of(body).is_empty(), "{body:?}");
        }
        // Many tags with no release: a few are asked about, then the search stops.
        let many: Vec<String> = (0..40).map(|n| format!("desktop-v1.{n}.0")).collect();
        let tag_refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let pages = vec![(TAGS_URL.to_string(), refs(&tag_refs))];
        let asked = RefCell::new(Vec::new());
        assert!(find_manifest(&github(&pages, &asked)).is_err());
        assert_eq!(asked.borrow().len(), 1 + RELEASES_ASKED);
        // The tags cannot be read: said so, and nothing else is asked.
        let asked = RefCell::new(Vec::new());
        let failing = |url: &str| {
            asked.borrow_mut().push(url.to_string());
            Err::<String, String>("offline".into())
        };
        assert!(find_manifest(&failing).is_err());
        assert_eq!(asked.borrow().len(), 1);
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
