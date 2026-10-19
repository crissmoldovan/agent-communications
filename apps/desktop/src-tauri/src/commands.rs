//! The thirteen commands the webview may invoke, each granted as `allow-<name>` (`capabilities/default.json`), and
//! each declared to Tauri in `build.rs`. `installation` and `cli` work here, and so do the seven from
//! `open_in_terminal` to `set_login_item` (Task 6); the updater's and the deep link's say `APP_NOT_BUILT` until Task 7
//! replaces each body with one call into its module.

use crate::allowlist::{AccountName, Call, ConversationId};
use crate::ipc::{
    AppError, AppSettings, CliResult, DeepLinkTarget, Installation, ProfileOpened, TerminalCommand,
    TerminalOutcome, UpdaterState,
};
use crate::launchers::discover;
use crate::paths::FolderOverrides;
use crate::runner::{run, RunContext};
use crate::{links, login_item, settings, terminal, AppState};
use tauri::{AppHandle, State};

/// Every command, in the order `build.rs` declares them; a test checks the two and the capability file agree.
pub const NAMES: &[&str] = &[
    "installation",
    "cli",
    "open_in_terminal",
    "copy_text",
    "open_link",
    "open_profile",
    "get_settings",
    "set_folders",
    "set_login_item",
    "updater_state",
    "check_for_updates",
    "install_update",
    "take_deep_link",
];

/// This machine's run context, with Settings' folder overrides.
fn context(state: &State<'_, AppState>) -> RunContext {
    let overrides = state
        .overrides
        .lock()
        .map(|overrides| overrides.clone())
        .unwrap_or_else(|poisoned| poisoned.into_inner().clone());
    RunContext::current(&overrides)
}

/// Runs blocking work off the main thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| AppError::io(format!("the app's own work failed: {error}")))
}

/// What is installed here: nothing runs without `<data>/launch/core`.
#[tauri::command]
pub async fn installation(state: State<'_, AppState>) -> Result<Installation, AppError> {
    let ctx = context(&state);
    blocking(move || discover(&ctx)).await
}

/// One call from the allow-list. An argument the allow-list refuses never reaches here: the invoke fails first.
#[tauri::command]
pub async fn cli(call: Call, state: State<'_, AppState>) -> Result<CliResult, AppError> {
    let ctx = context(&state);
    blocking(move || run(&call, &ctx)).await
}

/// Opens the system terminal with an approve, change or sign-in command (DA6, DA10), or copies it and says why. A
/// change's own pending approval is revoked first.
#[tauri::command]
pub async fn open_in_terminal(
    command: TerminalCommand,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalOutcome, AppError> {
    let ctx = context(&state);
    blocking(move || terminal::open(&app, command, &ctx)).await?
}

/// Puts text on the clipboard: what the screen shows, and nothing hidden in it.
#[tauri::command]
pub fn copy_text(text: String, app: AppHandle) -> Result<(), AppError> {
    terminal::copy(&app, &text)
}

/// Opens an `https://` link to slack.com, google.com or a subdomain of either, that a doctor fix names.
#[tauri::command]
pub fn open_link(url: String, app: AppHandle) -> Result<(), AppError> {
    links::open_link(&app, &url)
}

/// Opens a writing profile in the default editor, after `profile init` makes it if it is missing; only a `.md` file
/// in `<config>/compose/` opens.
#[tauri::command]
pub async fn open_profile(
    account: Option<AccountName>,
    conversation: Option<ConversationId>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ProfileOpened, AppError> {
    let ctx = context(&state);
    blocking(move || links::open_profile(&app, &ctx, account, conversation)).await?
}

/// The app's settings and the folders they resolve to.
#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Result<AppSettings, AppError> {
    Ok(settings::current(&app, &state))
}

/// Keeps the folder overrides, each a full path or none, and uses them from the next call on.
#[tauri::command]
pub fn set_folders(
    folders: FolderOverrides,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSettings, AppError> {
    settings::set_folders(&app, &state, folders)
}

/// Starts the app at login, or stops it.
#[tauri::command]
pub fn set_login_item(
    on: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSettings, AppError> {
    login_item::set(&app, on)?;
    Ok(settings::current(&app, &state))
}

/// Where the app's own updater stands. Task 7.
#[tauri::command]
pub fn updater_state() -> Result<UpdaterState, AppError> {
    Err(AppError::not_built("updater_state"))
}

/// Looks for an update to the app. Task 7.
#[tauri::command]
pub fn check_for_updates() -> Result<UpdaterState, AppError> {
    Err(AppError::not_built("check_for_updates"))
}

/// Installs the update found, and restarts. Task 7.
#[tauri::command]
pub fn install_update() -> Result<(), AppError> {
    Err(AppError::not_built("install_update"))
}

/// The approval an `agentcomms://` link launched the app with, once. Task 7.
#[tauri::command]
pub fn take_deep_link() -> Result<Option<DeepLinkTarget>, AppError> {
    Err(AppError::not_built("take_deep_link"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The string literals of `const COMMANDS` in `build.rs`, in order.
    fn build_rs_commands() -> Vec<String> {
        let source = include_str!("../build.rs");
        let start = source
            .find("const COMMANDS")
            .expect("build.rs declares COMMANDS");
        let end = start + source[start..].find("];").expect("COMMANDS ends");
        regex::Regex::new(r#""([a-z_]+)""#)
            .expect("a pattern")
            .captures_iter(&source[start..end])
            .map(|capture| capture[1].to_string())
            .collect()
    }

    #[test]
    fn capabilities_grant_exactly_the_commands() {
        assert_eq!(NAMES.len(), 13);
        assert_eq!(build_rs_commands(), NAMES);
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("the capability file");
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        let mut granted: Vec<String> = capability["permissions"]
            .as_array()
            .expect("permissions")
            .iter()
            .map(|permission| permission.as_str().expect("a name").to_string())
            .collect();
        granted.sort();
        let mut expected: Vec<String> = [
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-start-dragging",
            "core:window:allow-internal-toggle-maximize",
        ]
        .iter()
        .map(|name| name.to_string())
        .chain(
            NAMES
                .iter()
                .map(|name| format!("allow-{}", name.replace('_', "-"))),
        )
        .collect();
        expected.sort();
        assert_eq!(granted, expected);
    }

    #[test]
    fn the_unbuilt_commands_say_so() {
        let refusal = updater_state().expect_err("not built");
        assert_eq!(refusal.code, "APP_NOT_BUILT");
        assert_eq!(
            take_deep_link().expect_err("not built").code,
            "APP_NOT_BUILT"
        );
    }
}
