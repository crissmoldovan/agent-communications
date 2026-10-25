//! Every type that crosses IPC, in one place. `src/ipc.ts` mirrors each one; serde names them in camelCase, and every
//! input refuses a field it does not know.
//!
//! The types owned by a module with logic of its own are defined there and named here too, so a command's signature
//! can be read from this file: the call (`allowlist`), the folders (`paths`) and the products (`launchers`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub use crate::allowlist::{
    AccountName, ActivityChannel, ActivityKind, ActivityOutcome, ActivitySince, Acts, ApprovalId,
    Call, ConversationId, EndpointJudgeKind, FinishedApprovalState, PauseDays, QueueChannel,
    QueueItemId, QueueLimit, QueueState, RuleId, SessionKey, StartOfToday, UpdateLevel,
};
pub use crate::launchers::Product;
pub use crate::paths::{FolderOverrides, Folders};

/// What one CLI call came to, read from its output (`runner::parse_output`).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CliResult {
    /// An `ok: true` envelope, or bare JSON at exit 0. The exit code is kept: doctor's report comes with 78.
    Ok { exit: i32, data: Value },
    /// A change that waits for the person's approval: its id, the preview to show, and when it lapses.
    ApprovalPending {
        approval_id: String,
        preview: String,
        expires_at: Option<String>,
    },
    /// An error envelope, the events CLI's stderr, or one of the app's own `APP_*` failures.
    Failed {
        exit: i32,
        code: String,
        message: String,
        hint: Option<String>,
    },
    /// The installed version, from `--version`.
    Version { version: String },
}

/// What the app found of agent-communications on this machine.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    /// True when `<data>/launch/core` is there (DA12).
    pub installed: bool,
    /// Core's version, from `--version`; none when it could not be read.
    pub version: Option<String>,
    /// The products whose launcher is there; empty when nothing is installed.
    pub present: Vec<Product>,
    pub folders: Folders,
    /// Why the version could not be read, when it could not.
    pub problem: Option<String>,
}

/// A failure of the app's own, before or instead of a CLI call. The code is one of `APP_REFUSED`, `APP_NOT_INSTALLED`,
/// `APP_NO_NODE`, `APP_NOT_BUILT`, `APP_IO`, `APP_TIMEOUT` and `APP_UNSAFE_LAUNCHER`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        AppError {
            code: code.into(),
            message: message.into(),
        }
    }

    /// An argument or a call the allow-list does not take.
    pub fn refused(message: impl Into<String>) -> Self {
        Self::new("APP_REFUSED", message)
    }

    /// A launcher that is not there.
    pub fn not_installed(message: impl Into<String>) -> Self {
        Self::new("APP_NOT_INSTALLED", message)
    }

    /// Windows, with no Node to start a launcher with.
    pub fn no_node() -> Self {
        Self::new(
            "APP_NO_NODE",
            "no Node was found to start agent-communications with: the launcher names none, and node.exe is not on PATH",
        )
    }

    /// A command whose module is not built yet (Phase 2 of the plan replaces each).
    pub fn not_built(command: &str) -> Self {
        Self::new("APP_NOT_BUILT", format!("{command} is not built yet"))
    }

    /// Reading, writing or starting something failed.
    pub fn io(message: impl Into<String>) -> Self {
        Self::new("APP_IO", message)
    }

    /// A call that did not answer in time.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new("APP_TIMEOUT", message)
    }

    /// A launcher the app will not run: on a network share, or one another user owns or may change (`check_launcher`).
    pub fn unsafe_launcher(message: impl Into<String>) -> Self {
        Self::new("APP_UNSAFE_LAUNCHER", message)
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<AppError> for CliResult {
    fn from(error: AppError) -> Self {
        CliResult::Failed {
            exit: -1,
            code: error.code,
            message: error.message,
            hint: None,
        }
    }
}

/// What the terminal is opened with (DA6, DA10): a command the allow-list builds, never text from the CLI's output.
/// Implemented in Task 6 (`terminal.rs`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TerminalCommand {
    /// That channel's `approve <id>`, through its own launcher: core, gmail, slack, resend or whatsapp.
    Approve {
        product: Product,
        approval_id: ApprovalId,
    },
    /// A change the app prepared: its own pending approval is revoked first, then the change itself opens, without
    /// `--json`. Refused unless `call.prepares_change()`.
    Change { call: Call, revoke: ApprovalId },
    /// A sign-in, which only a terminal may take (DA5): gmail `inbox add|reauth`, slack `workspace add|reauth`, resend
    /// `account add`.
    SignIn {
        product: Product,
        account: AccountName,
        again: bool,
    },
    /// Laya's enablement, which only a terminal may take (E2 Task 11): the events service's `judge kind enable laya`.
    /// Its preview and its approval happen there; the app prepares nothing, records no approval and never approves. It
    /// is not a `change`: it takes no argument and no approval of the app's.
    EventsJudgeKindEnable {},
    /// Turning on Jev or a local model server, which only a terminal may take (0.27.1): the events service's `judge
    /// kind enable <kind>`, as Laya's Enable is. Its preview and its approval happen there; the app prepares nothing,
    /// records no approval and never approves. The kind is closed, and never Laya's.
    JudgeKindEnable { judge_kind: EndpointJudgeKind },
}

/// What opening the terminal came to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalOutcome {
    /// A terminal opened, `via` that program. `revoked` says whether a change's own approval was revoked first.
    Opened { via: String, revoked: Option<bool> },
    /// No terminal could be opened: the command is on the clipboard instead.
    Copied {
        reason: CopyReason,
        revoked: Option<bool>,
    },
}

/// Why the command was copied rather than opened.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyReason {
    /// No terminal the app knows was found (Linux with none of its three, Windows without cmd.exe), or the one found
    /// would not start or take the command (macOS: Terminal refused osascript): the line is copied.
    NoTerminal,
    /// A word that cannot be written as one safe line — on Windows one cmd.exe would act on, anywhere a line break or
    /// a format character: its words are copied as JSON.
    NoSafeLine,
}

/// A writing profile opened in the default editor, after `profile init` made it if it was missing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileOpened {
    pub path: String,
    pub created: bool,
}

/// The app's settings, the folders they resolve to, and core's launcher there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub folders: FolderOverrides,
    pub resolved: Folders,
    /// `<data>/launch/core`, as the resolved data folder names it: the program every call starts.
    pub launcher: String,
    /// Why the app would not run it — it is not there, or `check_launcher` refuses it — or none.
    pub launcher_problem: Option<String>,
    /// Whether the app starts at login, or none when the system did not answer in time (`login_item`).
    pub login_item: Option<bool>,
    pub login_item_available: bool,
}

/// What an `agentcomms://approvals/<id>` link opens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkTarget {
    pub approval_id: String,
}

/// Where the app's own updater stands (DA8).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterState {
    pub on: bool,
    pub status: UpdaterStatus,
    pub version: Option<String>,
    pub message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdaterStatus {
    Off,
    Idle,
    Checking,
    Available,
    None,
    Downloading,
    Ready,
    Error,
}

/// Where the event service the app runs stands (0.27.0 D2, D4, D5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EventServiceStatus {
    /// It does not run here: Windows (B1-G).
    Unavailable,
    Stopped,
    /// Started, or about to be restarted, and not answering yet.
    Starting,
    Running,
    /// The switch was turned off, or Quit's Stop it answered, and the service has not stopped yet.
    Stopping,
    /// It stopped 5 times in 10 minutes, so the app stopped restarting it.
    GaveUp,
}

/// The event service as the app runs it, from its supervisor (`event_service`): returned by its commands and carried
/// by `event-service:changed`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventServiceState {
    /// False on Windows.
    pub available: bool,
    /// The switch.
    pub wanted: bool,
    pub status: EventServiceStatus,
    /// `"app"` or `"terminal"`, while it runs.
    pub started_by: Option<String>,
    /// When the running one was started, or adopted (ISO 8601).
    pub since: Option<String>,
    /// The running one's version, from the launcher's `.current` when it was started.
    pub version: Option<String>,
    /// The version installed now, when it differs from the running one's (D5).
    pub newer_version: Option<String>,
    pub restarts: u32,
    pub last_restart_at: Option<String>,
    /// When a clean stop the app did not ask for turned the switch off (D4).
    pub stopped_from_outside_at: Option<String>,
    /// The last 20 lines of `service.log`, only when it gave up.
    pub log_tail: Vec<String>,
    /// Whether the first start waits for the person's answer (P1).
    pub first_start_question: bool,
    /// `"granted"`, `"missing"` or `"not-needed"` (D6).
    pub full_disk_access: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::ID;

    #[test]
    fn the_event_service_state_crosses_in_camel_case() {
        let state = EventServiceState {
            available: true,
            wanted: true,
            status: EventServiceStatus::GaveUp,
            started_by: Some("app".into()),
            since: Some("2026-10-25T11:00:00.000Z".into()),
            version: Some("0.26.2".into()),
            newer_version: Some("0.27.0".into()),
            restarts: 4,
            last_restart_at: Some("2026-10-25T11:58:00.000Z".into()),
            stopped_from_outside_at: None,
            log_tail: vec!["the runtime could not start".into()],
            first_start_question: false,
            full_disk_access: "not-needed".into(),
        };
        assert_eq!(
            serde_json::to_value(state).expect("json"),
            json!({
                "available": true,
                "wanted": true,
                "status": "gaveUp",
                "startedBy": "app",
                "since": "2026-10-25T11:00:00.000Z",
                "version": "0.26.2",
                "newerVersion": "0.27.0",
                "restarts": 4,
                "lastRestartAt": "2026-10-25T11:58:00.000Z",
                "stoppedFromOutsideAt": null,
                "logTail": ["the runtime could not start"],
                "firstStartQuestion": false,
                "fullDiskAccess": "not-needed"
            })
        );
        let statuses: Vec<serde_json::Value> = [
            EventServiceStatus::Unavailable,
            EventServiceStatus::Stopped,
            EventServiceStatus::Starting,
            EventServiceStatus::Running,
            EventServiceStatus::Stopping,
            EventServiceStatus::GaveUp,
        ]
        .into_iter()
        .map(|status| serde_json::to_value(status).expect("json"))
        .collect();
        assert_eq!(
            statuses,
            [
                json!("unavailable"),
                json!("stopped"),
                json!("starting"),
                json!("running"),
                json!("stopping"),
                json!("gaveUp")
            ]
        );
    }
    use serde_json::json;

    #[test]
    fn terminal_commands_are_tagged_by_kind_and_refuse_the_unknown() {
        let approve: TerminalCommand = serde_json::from_value(
            json!({ "kind": "approve", "product": "slack", "approvalId": ID }),
        )
        .expect("approve");
        assert!(matches!(
            approve,
            TerminalCommand::Approve {
                product: Product::Slack,
                ..
            }
        ));
        let change: TerminalCommand = serde_json::from_value(json!({
            "kind": "change",
            "call": { "kind": "updateLevel", "level": "never" },
            "revoke": ID
        }))
        .expect("change");
        assert!(matches!(change, TerminalCommand::Change { .. }));
        let sign_in: TerminalCommand = serde_json::from_value(json!({
            "kind": "signIn", "product": "gmail", "account": "example/gmail", "again": false
        }))
        .expect("signIn");
        assert!(matches!(
            sign_in,
            TerminalCommand::SignIn { again: false, .. }
        ));
        let judge_kind: TerminalCommand = serde_json::from_value(
            json!({ "kind": "judgeKindEnable", "judgeKind": "local-endpoint" }),
        )
        .expect("judgeKindEnable");
        assert_eq!(
            judge_kind,
            TerminalCommand::JudgeKindEnable {
                judge_kind: crate::allowlist::EndpointJudgeKind::LocalEndpoint
            }
        );
        for bad in [
            json!({ "kind": "judgeKindEnable", "judgeKind": "laya" }),
            json!({ "kind": "judgeKindEnable", "judgeKind": "anything" }),
            json!({ "kind": "approve", "product": "slack", "approvalId": "ap_x" }),
            json!({ "kind": "approve", "product": "slack", "approvalId": ID, "code": "ABCD" }),
            json!({ "kind": "change", "call": { "kind": "send" }, "revoke": ID }),
            json!({ "kind": "signIn", "product": "gmail", "account": "-x", "again": false }),
            json!({ "kind": "shell", "line": "rm -rf /" }),
        ] {
            assert!(
                serde_json::from_value::<TerminalCommand>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn outcomes_settings_and_updater_state_cross_in_camel_case() {
        assert_eq!(
            serde_json::to_value(TerminalOutcome::Opened {
                via: "Terminal".into(),
                revoked: Some(true)
            })
            .expect("json"),
            json!({ "outcome": "opened", "via": "Terminal", "revoked": true })
        );
        assert_eq!(
            serde_json::to_value(TerminalOutcome::Copied {
                reason: CopyReason::NoSafeLine,
                revoked: None
            })
            .expect("json"),
            json!({ "outcome": "copied", "reason": "noSafeLine", "revoked": null })
        );
        assert_eq!(
            serde_json::to_value(UpdaterState {
                on: false,
                status: UpdaterStatus::Off,
                version: None,
                message: Some("m".into())
            })
            .expect("json"),
            json!({ "on": false, "status": "off", "version": null, "message": "m" })
        );
        assert_eq!(
            serde_json::to_value(UpdaterStatus::None).expect("json"),
            json!("none")
        );
        assert_eq!(
            serde_json::to_value(DeepLinkTarget {
                approval_id: ID.into()
            })
            .expect("json"),
            json!({ "approvalId": ID })
        );
        assert_eq!(
            serde_json::to_value(ProfileOpened {
                path: "/x/compose/user.md".into(),
                created: true
            })
            .expect("json"),
            json!({ "path": "/x/compose/user.md", "created": true })
        );
        let folders = Folders {
            config_dir: "/c".into(),
            state_dir: "/s".into(),
            data_dir: "/d".into(),
            secrets_dir: "/x".into(),
        };
        let settings = |login_item| AppSettings {
            folders: FolderOverrides {
                config_dir: Some("/c".into()),
                state_dir: None,
                data_dir: None,
            },
            resolved: folders.clone(),
            launcher: "/d/launch/core".into(),
            launcher_problem: Some("there is no launcher here".into()),
            login_item,
            login_item_available: true,
        };
        assert_eq!(
            serde_json::to_value(settings(Some(false))).expect("json"),
            json!({
                "folders": { "configDir": "/c", "stateDir": null, "dataDir": null },
                "resolved": { "configDir": "/c", "stateDir": "/s", "dataDir": "/d", "secretsDir": "/x" },
                "launcher": "/d/launch/core",
                "launcherProblem": "there is no launcher here",
                "loginItem": false,
                "loginItemAvailable": true
            })
        );
        // The system did not answer in time: the window is told so, not told "off".
        assert_eq!(
            serde_json::to_value(settings(None)).expect("json")["loginItem"],
            serde_json::Value::Null
        );
        assert_eq!(
            serde_json::to_value(Installation {
                installed: true,
                version: Some("0.24.0".into()),
                present: vec![Product::Core, Product::EventsDaemon],
                folders,
                problem: None,
            })
            .expect("json"),
            json!({
                "installed": true,
                "version": "0.24.0",
                "present": ["core", "events-daemon"],
                "folders": { "configDir": "/c", "stateDir": "/s", "dataDir": "/d", "secretsDir": "/x" },
                "problem": null
            })
        );
        assert_eq!(
            serde_json::to_value(AppError::not_built("copy_text")).expect("json")["code"],
            json!("APP_NOT_BUILT")
        );
        // Folder overrides from the UI: missing is unset, and nothing else is taken.
        let overrides: FolderOverrides =
            serde_json::from_value(json!({ "configDir": "/c" })).expect("overrides");
        assert_eq!(
            overrides,
            FolderOverrides {
                config_dir: Some("/c".into()),
                state_dir: None,
                data_dir: None
            }
        );
        assert!(serde_json::from_value::<FolderOverrides>(json!({ "secretsDir": "/x" })).is_err());
    }
}
