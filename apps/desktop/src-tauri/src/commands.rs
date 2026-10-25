//! The twenty-one commands the webview may invoke, each granted as `allow-<name>` (`capabilities/default.json`), and
//! each declared to Tauri in `build.rs`. Every one is built: each body is one call into its module.

use crate::allowlist::{AccountName, ApprovalId, Call, ConversationId};
use crate::ipc::{
    AppError, AppSettings, CliResult, DeepLinkTarget, EventServiceState, Installation,
    ProfileOpened, TerminalCommand, TerminalOutcome, UpdaterState,
};
use crate::launchers::discover;
use crate::paths::FolderOverrides;
use crate::runner::{run, RunContext};
use crate::{
    deeplink, event_service, links, login_item, settings, terminal, tray, updater, AppState,
};
use tauri::{AppHandle, Manager, State};

/// Every command, in the order `build.rs` declares them; a test checks the two and the capability file agree.
pub const NAMES: &[&str] = &[
    "installation",
    "cli",
    "open_in_terminal",
    "revoke_preview",
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
    "event_service_state",
    "set_event_service",
    "event_service_retry",
    "restart_event_service",
    "answer_first_start",
    "open_full_disk_access",
    "answer_quit",
];

/// This machine's run context, with Settings' folder overrides.
pub(crate) fn context(state: &State<'_, AppState>) -> RunContext {
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

/// One call from the allow-list. An argument the allow-list refuses never reaches here: the invoke fails first. The
/// approvals waiting, when the window reads them, are counted in the tray too; a change the app prepared that came
/// back waiting is recorded, with its approval, for `open_in_terminal` and `revoke_preview`.
#[tauri::command]
pub async fn cli(
    call: Call,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<CliResult, AppError> {
    let ctx = context(&state);
    let counts = matches!(call, Call::ApprovalsPending {});
    let asked = call.clone();
    let result = blocking(move || run(&call, &ctx)).await?;
    state.prepared.record(&asked, &result);
    if let (Call::ApprovalRevoke { approval_id }, CliResult::Ok { exit: 0, .. }) = (&asked, &result)
    {
        state.prepared.forget(approval_id.as_str());
    }
    if let (true, CliResult::Ok { data, .. }) = (counts, &result) {
        if let Some(n) = tray::pending_count(data) {
            tray::set_count(&app, n);
        }
    }
    Ok(result)
}

/// Opens the system terminal with an approve, change or sign-in command (DA6, DA10), or copies it and says why. A
/// change's own pending approval — only the one the app recorded for that change — is revoked first.
#[tauri::command]
pub async fn open_in_terminal(
    command: TerminalCommand,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TerminalOutcome, AppError> {
    let ctx = context(&state);
    let prepared = state.prepared.clone();
    blocking(move || terminal::open(&app, command, &ctx, &prepared)).await?
}

/// Revokes the pending approval of a preview the app prepared, when the preview is cancelled or left behind (DA16):
/// only an approval `cli` recorded for one of the app's own changes. Core's answer is given back as it is.
#[tauri::command]
pub async fn revoke_preview(
    approval_id: ApprovalId,
    state: State<'_, AppState>,
) -> Result<CliResult, AppError> {
    let ctx = context(&state);
    let prepared = state.prepared.clone();
    blocking(move || {
        terminal::revoke_preview_with(&prepared, &approval_id, |id| {
            run(
                &Call::ApprovalRevoke {
                    approval_id: id.clone(),
                },
                &ctx,
            )
        })
    })
    .await?
}

/// Puts text on the clipboard: what the screen shows, and nothing hidden in it.
#[tauri::command]
pub fn copy_text(text: String, app: AppHandle) -> Result<(), AppError> {
    terminal::copy(&app, &text)
}

/// Opens an `https://` link a doctor fix names, to api.slack.com, myaccount.google.com or console.cloud.google.com; the
/// events service's README at its Judges section; or a queue item's message, exactly as the event service links it on
/// mail.google.com or app.slack.com (0.30.0). `links::may_open` decides.
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

/// The app's settings and the folders they resolve to. Off the main thread: asking the system about the login item
/// can wait (`login_item::SYSTEM_ANSWER_TIMEOUT`), and on the main thread that froze the whole window.
#[tauri::command]
pub async fn get_settings(app: AppHandle) -> Result<AppSettings, AppError> {
    blocking(move || settings::current(&app, &app.state::<AppState>())).await
}

/// Keeps the folder overrides, each a full path or none, and uses them from the next call on.
#[tauri::command]
pub async fn set_folders(
    folders: FolderOverrides,
    app: AppHandle,
) -> Result<AppSettings, AppError> {
    blocking(move || settings::set_folders(&app, &app.state::<AppState>(), folders)).await?
}

/// Starts the app at login, or stops it; off the main thread, as `get_settings`.
#[tauri::command]
pub async fn set_login_item(on: bool, app: AppHandle) -> Result<AppSettings, AppError> {
    blocking(move || {
        login_item::set(&app, on)?;
        Ok(settings::current(&app, &app.state::<AppState>()))
    })
    .await?
}

/// Where the app's own updater stands: off, with why, in a copy built without the updater key (DA8).
#[tauri::command]
pub fn updater_state(app: AppHandle) -> Result<UpdaterState, AppError> {
    Ok(updater::current(&app))
}

/// Looks for an update to the app, and says what it found.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<UpdaterState, AppError> {
    Ok(updater::check(&app, false).await)
}

/// Installs the update found, verified, and restarts into it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), AppError> {
    updater::install(&app).await
}

/// The approval an `agentcomms://` link launched the app with, once.
#[tauri::command]
pub fn take_deep_link(app: AppHandle) -> Result<Option<DeepLinkTarget>, AppError> {
    Ok(deeplink::take(&app))
}

/// Where the event service the app runs stands (0.27.0 D2). Off the main thread, as every event-service command is:
/// each takes the supervisor's lock, which its watchdog holds while it runs the events CLI.
#[tauri::command]
pub async fn event_service_state(app: AppHandle) -> Result<EventServiceState, AppError> {
    blocking(move || event_service::current(&app)).await
}

/// The switch: on has the watchdog start the service, or adopt one running, even when it was already on; off has it
/// stop it through the events CLI's `stop`. Recorded and answered at once, with the service starting (0.27.1).
#[tauri::command]
pub async fn set_event_service(on: bool, app: AppHandle) -> Result<EventServiceState, AppError> {
    blocking(move || event_service::set_wanted(&app, on)).await
}

/// Try again, after the app gave up restarting the service: answered at once, with the service starting.
#[tauri::command]
pub async fn event_service_retry(app: AppHandle) -> Result<EventServiceState, AppError> {
    blocking(move || event_service::retry(&app)).await
}

/// Restart to use it: the watchdog stops the service that runs, and starts the version installed now (D5). Answered at
/// once, with the service starting.
#[tauri::command]
pub async fn restart_event_service(app: AppHandle) -> Result<EventServiceState, AppError> {
    blocking(move || event_service::restart(&app)).await
}

/// The first-start question's answer (P1): Start, or Not now, which leaves the switch off. Kept and answered at once;
/// the watchdog starts the service.
#[tauri::command]
pub async fn answer_first_start(
    start: bool,
    app: AppHandle,
) -> Result<EventServiceState, AppError> {
    blocking(move || event_service::answer_first_start(&app, start)).await
}

/// Opens System Settings at Full Disk Access (D6), on macOS.
#[tauri::command]
pub async fn open_full_disk_access(app: AppHandle) -> Result<(), AppError> {
    blocking(move || event_service::open_full_disk_access(&app)).await?
}

/// The quit question's answer (P3): kept when Remember my answer is set, the service stopped on Stop it, then the app
/// quits.
#[tauri::command]
pub async fn answer_quit(keep: bool, remember: bool, app: AppHandle) -> Result<(), AppError> {
    blocking(move || event_service::answer_quit(&app, keep, remember)).await?
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
        assert_eq!(NAMES.len(), 21);
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
    fn every_command_is_built() {
        let source = include_str!("commands.rs");
        let commands = &source[..source.find("#[cfg(test)]").expect("the tests")];
        assert!(
            !commands.contains("not_built("),
            "a command still says it is not built"
        );
        assert_eq!(commands.matches("#[tauri::command]").count(), NAMES.len());
    }

    /// A command Tauri runs synchronously runs on the main thread, so one that waits freezes the whole window: asking
    /// macOS about the login item did, on a Mac whose login-items service had stopped answering (2026-10-24).
    #[test]
    fn the_commands_that_ask_the_system_about_the_login_item_are_not_run_on_the_main_thread() {
        let source = include_str!("commands.rs");
        let commands = &source[..source.find("#[cfg(test)]").expect("the tests")];
        // Each command's own code, from its `#[tauri::command]` to the next, without the comments: the next
        // command's doc comment comes before its attribute.
        let blocks: Vec<String> = commands
            .split("#[tauri::command]")
            .skip(1)
            .map(|block| {
                block
                    .lines()
                    .filter(|line| !line.trim_start().starts_with("//"))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .collect();
        assert_eq!(blocks.len(), NAMES.len());
        let mut event_service = 0;
        for block in blocks {
            if block.contains("event_service::") {
                event_service += 1;
                assert!(
                    block.trim_start().starts_with("pub async fn ") && block.contains("blocking("),
                    "an event-service command waits for the supervisor, so it is async and off the main thread:\n{block}"
                );
            }
            if block.contains("settings::") || block.contains("login_item::") {
                assert!(
                    block.trim_start().starts_with("pub async fn "),
                    "a command that reaches the settings or the login item must be async:\n{block}"
                );
                assert!(
                    block.contains("blocking("),
                    "and do its work off the main thread:\n{block}"
                );
            }
        }
        assert_eq!(event_service, 7, "the event service's seven commands");
    }
}
