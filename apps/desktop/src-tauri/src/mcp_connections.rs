//! MCP connections (0.35.0, single-server design §11): each place an app uses Agent Comms — Claude Code in every folder
//! or one project, another Claude profile, Codex, Claude Desktop, Cursor, Gemini, VS Code, or a snippet pasted by hand —
//! with its own name, parts, accounts and key, in the app. Core's `connection …`, word for word:
//!
//! - **Reads:** `connection list`, every connection with its parts, its entry and when it was last used; and
//!   `connection show <id>`, one, with the Agent Comms running for it now, part by part. Never a key, nor its hash.
//! - **Loosenings:** `connection add`, `connection change` that gives more, `connection migrate` and `connection migrate
//!   --undo` are prepared without an approval, and core answers with the preview; the person approves it in the app,
//!   where the same words go again with `--app-approval <id>` (the call's `appApproval`), only for the approval the app
//!   prepared for that very change (`connections::run_app_approval`), once — or in Terminal where nothing attests the
//!   app. A `connection change` that only takes away applies at once, and so does the narrowing half of one that also
//!   gives more (core narrows before it asks).
//! - **At once:** `connection rename`, `connection key replace` and `connection remove`, which give an agent nothing
//!   more. A Manual connection's new key comes back once, in its snippet; core refuses that to an agent, and the app runs
//!   as the person (`runner::command_for` clears the environment), so only the person's press asks for it. A remove
//!   whose entry shadows a wider one the agents in its folder would then use is a loosening (the security review's H1):
//!   core answers it with a preview, approved in the app as the loosenings are.
//!
//! Every value is closed or checked here before a word is built: a connection's id, its name by core's rule, an app of
//! core's list, each part a server's word (the platform pattern of an account name: core checks it against its
//! snapshot, D20) with an account's name and read-only, a folder written whole, and an app to migrate by its closed word.

use crate::allowlist::{AccountName, ApprovalId, Call, Shape, Words};
use crate::grammar;
use crate::ipc::AppError;
use crate::launchers::Product;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;

/// The first core with MCP connections (0.35.0): `connection list|show|add|change|rename|key replace|remove|migrate`.
/// An older one keeps Connections' table of apps by server, as 0.34.0 showed it (DA12).
pub const CONNECTIONS_VERSION: &str = "0.35.0";

/// The most characters a connection's name has (core's `CONNECTION_NAME_MAX`).
pub const CONNECTION_NAME_MAX: usize = 64;

/// The most parts one connection names: every declared server, with room for the channels a release may add.
pub const CONNECTION_PARTS_MAX: usize = 16;

/// The most bytes a folder is, as `--folder` and `--profile` take it.
pub const CONNECTION_FOLDER_MAX: usize = 1024;

static CONNECTION_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^cn_[0-9A-HJKMNP-TV-Z]{26}$").expect("a pattern"));
/// A part's word: the platform of an account name (`grammar.json`'s `name`), which every declared server's word is.
static PART_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9]{0,15}$").expect("a pattern"));
static CONTROL_OR_FORMAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}]").expect("a pattern"));
static WINDOWS_DRIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z]:\\").expect("a pattern"));

/// The quotation marks core refuses in a name (`connectionNameProblem`): a name that reads as a pin is a preview that
/// lies.
const QUOTES: [char; 7] = ['"', '\'', '`', '“', '”', '‘', '’'];

/// The brackets and ellipsis core refuses in a new name (`newConnectionNameProblem`, the 0.35.0 re-review's LOW 6): a
/// preview labels a connection `"Work" (Claude Code, every folder, cn_ABCD…)`, and a name must not imitate that.
const LABEL_MARKS: [char; 3] = ['(', ')', '…'];

macro_rules! connection_word {
    ($(#[$meta:meta])* $name:ident, $check:path, $what:literal) => {
        $(#[$meta])*
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = AppError;

            fn try_from(value: String) -> Result<Self, Self::Error> {
                if $check(&value) {
                    Ok($name(value))
                } else {
                    Err(AppError::refused(concat!("that is not ", $what)))
                }
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }
    };
}

/// `cn_` and 26 of Crockford's letters, as core makes a connection's id.
pub fn connection_id(value: &str) -> bool {
    grammar::plain(value) && CONNECTION_ID.is_match(value)
}

/// A connection's name, by core's rule for a new one: 1 to 64 characters, no space at either end, no quotation mark,
/// bracket or ellipsis, and no control, format, bidi or invisible character; never starting with `-`, so it is never
/// read as an option. Only what the app asks core to add or rename passes through here: a name a connection has
/// already is read as core gives it.
pub fn connection_name(value: &str) -> bool {
    grammar::plain(value)
        && value.trim() == value
        && value.chars().count() <= CONNECTION_NAME_MAX
        && !value
            .chars()
            .any(|c| QUOTES.contains(&c) || LABEL_MARKS.contains(&c))
}

/// A part's word: a server's, as core's snapshot names it (`core`, `gmail`, `events` …).
pub fn part_word(value: &str) -> bool {
    PART_WORD.is_match(value)
}

/// A folder written whole, as `--folder` and `--profile` take it: absolute — `/…` here, or `C:\…` on Windows — with
/// no `.` or `..` step, no repeated or trailing separator, no control or format character, and at most 1,024 bytes.
pub fn connection_folder(value: &str) -> bool {
    if value.len() > CONNECTION_FOLDER_MAX || CONTROL_OR_FORMAT.is_match(value) {
        return false;
    }
    let steps = |rest: &str, separator: char| {
        !rest.is_empty()
            && rest
                .split(separator)
                .all(|step| !step.is_empty() && step != "." && step != "..")
    };
    if let Some(rest) = value.strip_prefix('/') {
        return steps(rest, '/');
    }
    WINDOWS_DRIVE.is_match(value) && !value.contains('/') && steps(&value[3..], '\\')
}

connection_word!(
    /// A connection's id: `cn_` and 26 of Crockford's letters.
    ConnectionId,
    connection_id,
    "a connection's id"
);
connection_word!(
    /// A connection's name, as the person gives it: it names the connection here and in Activity.
    ConnectionName,
    connection_name,
    "a name a connection can have"
);
connection_word!(
    /// A part's word: a declared server, which core checks against its snapshot.
    PartWord,
    part_word,
    "a part a connection can have"
);
connection_word!(
    /// A folder written whole: a project's, another Claude profile's or another Codex home's.
    ConnectionFolder,
    connection_folder,
    "a folder written whole"
);

/// The apps a connection is made for, as `connection add --app` takes them (core's `CONNECTION_APPS`). Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionApp {
    #[serde(rename = "claude-code")]
    ClaudeCode,
    #[serde(rename = "claude-desktop")]
    ClaudeDesktop,
    #[serde(rename = "codex")]
    Codex,
    #[serde(rename = "cursor")]
    Cursor,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "vscode")]
    Vscode,
    #[serde(rename = "manual")]
    Manual,
}

impl ConnectionApp {
    pub const ALL: [ConnectionApp; 7] = [
        ConnectionApp::ClaudeCode,
        ConnectionApp::ClaudeDesktop,
        ConnectionApp::Codex,
        ConnectionApp::Cursor,
        ConnectionApp::Gemini,
        ConnectionApp::Vscode,
        ConnectionApp::Manual,
    ];

    /// The app as core names it.
    pub fn word(self) -> &'static str {
        match self {
            ConnectionApp::ClaudeCode => "claude-code",
            ConnectionApp::ClaudeDesktop => "claude-desktop",
            ConnectionApp::Codex => "codex",
            ConnectionApp::Cursor => "cursor",
            ConnectionApp::Gemini => "gemini",
            ConnectionApp::Vscode => "vscode",
            ConnectionApp::Manual => "manual",
        }
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// One part of a connection: a server, the one account it is kept to (left out, every account), and read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionPart {
    pub server: PartWord,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<AccountName>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub read_only: bool,
}

impl ConnectionPart {
    /// The part as `--parts` names it: `gmail`, `gmail:cue/gmail`, `gmail:cue/gmail:read-only`, `gmail:read-only`.
    /// Neither a server's word nor an account's name has a colon or a comma in it.
    fn word(&self) -> String {
        let mut word = self.server.as_str().to_string();
        match (&self.account, self.read_only) {
            (Some(account), true) => {
                word.push(':');
                word.push_str(account.as_str());
                word.push_str(":read-only");
            }
            (Some(account), false) => {
                word.push(':');
                word.push_str(account.as_str());
            }
            (None, true) => word.push_str(":read-only"),
            (None, false) => {}
        }
        word
    }
}

/// Every part a connection has from now on: 1 to `CONNECTION_PARTS_MAX`, each server once, in the order given.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<ConnectionPart>", into = "Vec<ConnectionPart>")]
pub struct ConnectionParts(Vec<ConnectionPart>);

impl TryFrom<Vec<ConnectionPart>> for ConnectionParts {
    type Error = AppError;

    fn try_from(parts: Vec<ConnectionPart>) -> Result<Self, Self::Error> {
        let repeated = parts
            .iter()
            .enumerate()
            .any(|(index, part)| parts[..index].iter().any(|had| had.server == part.server));
        if parts.is_empty() || parts.len() > CONNECTION_PARTS_MAX || repeated {
            Err(AppError::refused(
                "a connection names 1 to 16 parts, each server once",
            ))
        } else {
            Ok(ConnectionParts(parts))
        }
    }
}

impl From<ConnectionParts> for Vec<ConnectionPart> {
    fn from(parts: ConnectionParts) -> Vec<ConnectionPart> {
        parts.0
    }
}

impl ConnectionParts {
    /// `--parts`'s one word: each part's, joined with commas.
    pub fn word(&self) -> String {
        self.0
            .iter()
            .map(ConnectionPart::word)
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// A read: `connection list` reads each app's config for its entry, and `show` the gateways' status files.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Preparing a change: it may read the release's document for a runtime it would install, or every app's config.
const PREPARE_TIMEOUT: Duration = Duration::from_secs(90);
/// A change applied at once that runs an app's own command line: replacing a key, or taking an entry out.
const ENTRY_TIMEOUT: Duration = Duration::from_secs(90);
/// An addition or a change the person approved in the app: it may fetch and verify runtimes, register the entry and
/// prove it starts.
const APPROVED_TIMEOUT: Duration = Duration::from_secs(300);
/// A migration the person approved: every app's entries moved, each gateway started and checked.
const MIGRATE_TIMEOUT: Duration = Duration::from_secs(600);

fn core(words: Vec<String>, timeout: Duration) -> Words {
    Words {
        product: Product::Core,
        words,
        shape: Shape::Envelope,
        pins: true,
        quiet_updates: true,
        timeout,
    }
}

fn literal(words: &[&str]) -> Vec<String> {
    words.iter().map(|word| word.to_string()).collect()
}

/// The words, then `--app-approval <id>` when the person approved the change in the app; and the timeout for each.
fn approved(
    mut words: Vec<String>,
    app_approval: &Option<ApprovalId>,
    prepare: Duration,
    apply: Duration,
) -> Words {
    match app_approval {
        Some(id) => {
            words.extend(["--app-approval".to_string(), id.as_str().to_string()]);
            core(words, apply)
        }
        None => core(words, prepare),
    }
}

impl Call {
    /// Whether this is one of the MCP connections' calls.
    pub fn is_connection(&self) -> bool {
        matches!(
            self,
            Call::ConnectionList {}
                | Call::ConnectionShow { .. }
                | Call::ConnectionAdd { .. }
                | Call::ConnectionChange { .. }
                | Call::ConnectionRename { .. }
                | Call::ConnectionKeyReplace { .. }
                | Call::ConnectionRemove { .. }
                | Call::ConnectionMigrate { .. }
                | Call::ConnectionMigrateUndo { .. }
        )
    }

    /// Whether this connection call changes something: every one but the two reads.
    pub fn changes_connection(&self) -> bool {
        self.is_connection()
            && !matches!(self, Call::ConnectionList {} | Call::ConnectionShow { .. })
    }

    /// A connection call's words: core's `connection …`, its timeout, and nothing else. A folder is for Claude Code's
    /// one project only, and another profile for Claude Code and Codex only, as core takes them. Any other call is
    /// refused here.
    pub fn connection_words(&self) -> Result<Words, AppError> {
        Ok(match self {
            Call::ConnectionList {} => core(literal(&["connection", "list"]), READ_TIMEOUT),
            Call::ConnectionShow { connection_id } => core(
                literal(&["connection", "show", connection_id.as_str()]),
                READ_TIMEOUT,
            ),
            Call::ConnectionAdd {
                app,
                name,
                parts,
                folder,
                profile,
                app_approval,
            } => {
                if folder.is_some() && *app != ConnectionApp::ClaudeCode {
                    return Err(AppError::refused(
                        "one project folder is for Claude Code only",
                    ));
                }
                if profile.is_some()
                    && !matches!(app, ConnectionApp::ClaudeCode | ConnectionApp::Codex)
                {
                    return Err(AppError::refused(
                        "another profile is for Claude Code and Codex only",
                    ));
                }
                let mut words = literal(&[
                    "connection",
                    "add",
                    "--app",
                    app.word(),
                    "--name",
                    name.as_str(),
                ]);
                words.extend(["--parts".to_string(), parts.word()]);
                if let Some(folder) = folder {
                    words.extend(["--folder".to_string(), folder.as_str().to_string()]);
                }
                if let Some(profile) = profile {
                    words.extend(["--profile".to_string(), profile.as_str().to_string()]);
                }
                approved(words, app_approval, PREPARE_TIMEOUT, APPROVED_TIMEOUT)
            }
            Call::ConnectionChange {
                connection_id,
                parts,
                app_approval,
            } => approved(
                vec![
                    "connection".into(),
                    "change".into(),
                    connection_id.as_str().to_string(),
                    "--parts".into(),
                    parts.word(),
                ],
                app_approval,
                PREPARE_TIMEOUT,
                APPROVED_TIMEOUT,
            ),
            Call::ConnectionRename {
                connection_id,
                name,
            } => core(
                literal(&[
                    "connection",
                    "rename",
                    connection_id.as_str(),
                    name.as_str(),
                ]),
                READ_TIMEOUT,
            ),
            Call::ConnectionKeyReplace { connection_id } => core(
                literal(&["connection", "key", "replace", connection_id.as_str()]),
                ENTRY_TIMEOUT,
            ),
            Call::ConnectionRemove {
                connection_id,
                app_approval,
            } => approved(
                literal(&["connection", "remove", connection_id.as_str()]),
                app_approval,
                ENTRY_TIMEOUT,
                ENTRY_TIMEOUT,
            ),
            Call::ConnectionMigrate {
                client,
                app_approval,
            } => {
                let mut words = literal(&["connection", "migrate"]);
                if let Some(client) = client {
                    words.extend(["--client".to_string(), client.word().to_string()]);
                }
                approved(words, app_approval, PREPARE_TIMEOUT, MIGRATE_TIMEOUT)
            }
            Call::ConnectionMigrateUndo {
                connection_id,
                app_approval,
            } => approved(
                literal(&["connection", "migrate", "--undo", connection_id.as_str()]),
                app_approval,
                PREPARE_TIMEOUT,
                APPROVED_TIMEOUT,
            ),
            _ => {
                return Err(AppError::refused(
                    "that is not one of the MCP connections' calls",
                ))
            }
        })
    }

    /// Whether this connection call is one the app prepares, and core may answer with its preview: an addition, a
    /// change of parts, a migration and its undo, and a removal (core asks for one only where it widens what agents in
    /// the connection's folder reach) — each without the app's approval.
    pub fn prepares_connection_change(&self) -> bool {
        matches!(
            self,
            Call::ConnectionAdd {
                app_approval: None,
                ..
            } | Call::ConnectionChange {
                app_approval: None,
                ..
            } | Call::ConnectionRemove {
                app_approval: None,
                ..
            } | Call::ConnectionMigrate {
                app_approval: None,
                ..
            } | Call::ConnectionMigrateUndo {
                app_approval: None,
                ..
            }
        )
    }

    /// A connection change the person approved in the app, and the change it answers: the same call without its
    /// `appApproval`, which is what the app prepared and `terminal::Prepared` recorded. None for every other call.
    pub fn answers_connection_approval(&self) -> Option<(&ApprovalId, Call)> {
        match self {
            Call::ConnectionAdd {
                app,
                name,
                parts,
                folder,
                profile,
                app_approval: Some(id),
            } => Some((
                id,
                Call::ConnectionAdd {
                    app: *app,
                    name: name.clone(),
                    parts: parts.clone(),
                    folder: folder.clone(),
                    profile: profile.clone(),
                    app_approval: None,
                },
            )),
            Call::ConnectionChange {
                connection_id,
                parts,
                app_approval: Some(id),
            } => Some((
                id,
                Call::ConnectionChange {
                    connection_id: connection_id.clone(),
                    parts: parts.clone(),
                    app_approval: None,
                },
            )),
            Call::ConnectionRemove {
                connection_id,
                app_approval: Some(id),
            } => Some((
                id,
                Call::ConnectionRemove {
                    connection_id: connection_id.clone(),
                    app_approval: None,
                },
            )),
            Call::ConnectionMigrate {
                client,
                app_approval: Some(id),
            } => Some((
                id,
                Call::ConnectionMigrate {
                    client: *client,
                    app_approval: None,
                },
            )),
            Call::ConnectionMigrateUndo {
                connection_id,
                app_approval: Some(id),
            } => Some((
                id,
                Call::ConnectionMigrateUndo {
                    connection_id: connection_id.clone(),
                    app_approval: None,
                },
            )),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::{samples, ID};
    use crate::connections::{refuse_in_test_build, run_app_approval};
    use crate::ipc::{CliResult, TerminalCommand};
    use crate::terminal::{command_words, Prepared};
    use serde_json::{json, Value};

    const CONNECTION: &str = "cn_MBGB9NHBQB0BVZYCAD95GDM2M4";
    const OTHER: &str = "cn_R41RFQ49Z2T0B7V24RB3C5W58Q";

    fn call(value: Value) -> Call {
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    fn refused(value: Value) {
        assert!(
            serde_json::from_value::<Call>(value.clone()).is_err(),
            "{value} should be refused"
        );
    }

    /// Core's words for `value`, with its launcher, its envelope, the four pins and the update check quiet.
    fn words(value: Value) -> Vec<String> {
        let built = call(value.clone()).words().expect("it builds");
        assert_eq!(built.product, Product::Core, "{value}");
        assert_eq!(built.shape, Shape::Envelope, "{value}");
        assert!(built.pins, "{value}");
        assert!(built.quiet_updates, "{value}");
        built.words
    }

    fn timeout(value: Value) -> Duration {
        call(value).words().expect("it builds").timeout
    }

    fn add() -> Value {
        json!({
            "kind": "connectionAdd",
            "app": "claude-code",
            "name": "Work — Claude Code",
            "parts": [
                { "server": "core" },
                { "server": "gmail", "account": "cue/gmail", "readOnly": true },
                { "server": "slack" },
                { "server": "events" }
            ]
        })
    }

    #[test]
    fn connection_calls_build_exactly_cores_words() {
        assert_eq!(
            words(json!({ "kind": "connectionList" })),
            ["connection", "list"]
        );
        assert_eq!(
            words(json!({ "kind": "connectionShow", "connectionId": CONNECTION })),
            ["connection", "show", CONNECTION]
        );
        assert_eq!(
            words(add()),
            [
                "connection",
                "add",
                "--app",
                "claude-code",
                "--name",
                "Work — Claude Code",
                "--parts",
                "core,gmail:cue/gmail:read-only,slack,events"
            ]
        );
        assert_eq!(
            words(json!({
                "kind": "connectionAdd",
                "app": "claude-code",
                "name": "Acme site",
                "parts": [{ "server": "core" }, { "server": "slack", "account": "acme/slack" }],
                "folder": "/example/home/work/acme-site",
                "profile": "/example/home/.claude-client"
            })),
            [
                "connection",
                "add",
                "--app",
                "claude-code",
                "--name",
                "Acme site",
                "--parts",
                "core,slack:acme/slack",
                "--folder",
                "/example/home/work/acme-site",
                "--profile",
                "/example/home/.claude-client"
            ]
        );
        assert_eq!(
            words(json!({
                "kind": "connectionAdd",
                "app": "codex",
                "name": "Reviews",
                "parts": [{ "server": "gmail", "readOnly": true }],
                "profile": "C:\\Work\\example\\.codex-reviews"
            })),
            [
                "connection",
                "add",
                "--app",
                "codex",
                "--name",
                "Reviews",
                "--parts",
                "gmail:read-only",
                "--profile",
                "C:\\Work\\example\\.codex-reviews"
            ]
        );
        assert_eq!(
            words(json!({
                "kind": "connectionChange",
                "connectionId": CONNECTION,
                "parts": [{ "server": "core" }, { "server": "whatsapp" }]
            })),
            [
                "connection",
                "change",
                CONNECTION,
                "--parts",
                "core,whatsapp"
            ]
        );
        assert_eq!(
            words(
                json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": "Personal — Claude Desktop" })
            ),
            [
                "connection",
                "rename",
                CONNECTION,
                "Personal — Claude Desktop"
            ]
        );
        assert_eq!(
            words(json!({ "kind": "connectionKeyReplace", "connectionId": CONNECTION })),
            ["connection", "key", "replace", CONNECTION]
        );
        assert_eq!(
            words(json!({ "kind": "connectionRemove", "connectionId": CONNECTION })),
            ["connection", "remove", CONNECTION]
        );
        assert_eq!(
            words(
                json!({ "kind": "connectionRemove", "connectionId": CONNECTION, "appApproval": ID })
            ),
            ["connection", "remove", CONNECTION, "--app-approval", ID]
        );
        assert_eq!(
            words(json!({ "kind": "connectionMigrate" })),
            ["connection", "migrate"]
        );
        assert_eq!(
            words(json!({ "kind": "connectionMigrate", "client": "codex" })),
            ["connection", "migrate", "--client", "codex"]
        );
        assert_eq!(
            words(json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION })),
            ["connection", "migrate", "--undo", CONNECTION]
        );
        // Each app by core's word, Manual among them.
        for app in ConnectionApp::ALL {
            let value = json!({
                "kind": "connectionAdd",
                "app": app.word(),
                "name": "Raycast",
                "parts": [{ "server": "core" }]
            });
            assert_eq!(
                words(value.clone()),
                [
                    "connection",
                    "add",
                    "--app",
                    app.word(),
                    "--name",
                    "Raycast",
                    "--parts",
                    "core"
                ]
            );
            assert_eq!(
                serde_json::to_value(call(value.clone())).expect("json"),
                value
            );
        }
    }

    #[test]
    fn a_change_approved_in_the_app_is_the_same_words_then_the_app_approval() {
        let mut approved_add = add();
        approved_add["appApproval"] = json!(ID);
        let mut expected: Vec<String> = words(add());
        expected.extend(["--app-approval".to_string(), ID.to_string()]);
        assert_eq!(words(approved_add.clone()), expected);
        for (value, base) in [
            (
                json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": [{ "server": "core" }, { "server": "gmail" }], "appApproval": ID }),
                vec!["connection", "change", CONNECTION, "--parts", "core,gmail"],
            ),
            (
                json!({ "kind": "connectionMigrate", "client": "claude-code", "appApproval": ID }),
                vec!["connection", "migrate", "--client", "claude-code"],
            ),
            (
                json!({ "kind": "connectionMigrate", "appApproval": ID }),
                vec!["connection", "migrate"],
            ),
            (
                json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION, "appApproval": ID }),
                vec!["connection", "migrate", "--undo", CONNECTION],
            ),
        ] {
            let mut expected: Vec<String> = base.iter().map(|word| word.to_string()).collect();
            expected.extend(["--app-approval".to_string(), ID.to_string()]);
            assert_eq!(words(value.clone()), expected, "{value}");
            assert_eq!(
                serde_json::to_value(call(value.clone())).expect("json"),
                value
            );
        }
        // Never `--approval`, and never `approve`.
        for word in words(approved_add) {
            assert!(word != "--approval" && word != "approve", "{word}");
        }
    }

    #[test]
    fn each_call_has_room_for_what_it_does() {
        assert_eq!(
            timeout(json!({ "kind": "connectionList" })),
            Duration::from_secs(30)
        );
        assert_eq!(
            timeout(json!({ "kind": "connectionShow", "connectionId": CONNECTION })),
            Duration::from_secs(30)
        );
        assert_eq!(timeout(add()), Duration::from_secs(90));
        let mut approved_add = add();
        approved_add["appApproval"] = json!(ID);
        assert_eq!(timeout(approved_add), Duration::from_secs(300));
        assert_eq!(
            timeout(
                json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": [{ "server": "core" }], "appApproval": ID })
            ),
            Duration::from_secs(300)
        );
        assert_eq!(
            timeout(
                json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": "Work" })
            ),
            Duration::from_secs(30)
        );
        assert_eq!(
            timeout(json!({ "kind": "connectionKeyReplace", "connectionId": CONNECTION })),
            Duration::from_secs(90)
        );
        assert_eq!(
            timeout(json!({ "kind": "connectionRemove", "connectionId": CONNECTION })),
            Duration::from_secs(90)
        );
        assert_eq!(
            timeout(
                json!({ "kind": "connectionRemove", "connectionId": CONNECTION, "appApproval": ID })
            ),
            Duration::from_secs(90)
        );
        assert_eq!(
            timeout(json!({ "kind": "connectionMigrate" })),
            Duration::from_secs(90)
        );
        assert_eq!(
            timeout(json!({ "kind": "connectionMigrate", "appApproval": ID })),
            Duration::from_secs(600)
        );
        assert_eq!(
            timeout(
                json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION, "appApproval": ID })
            ),
            Duration::from_secs(300)
        );
    }

    #[test]
    fn connection_calls_refuse_every_word_outside_their_shapes() {
        // Ids: `cn_` and 26 of Crockford's letters, nothing else.
        for id in [
            "",
            "cn_",
            "cn_MBGB9NHBQB0BVZYCAD95GDM2M",
            "cn_MBGB9NHBQB0BVZYCAD95GDM2M44",
            "cn_mbgb9nhbqb0bvzycad95gdm2m4",
            "cn_MBGB9NHBQB0BVZYCAD95GDM2MI",
            "ap_0123456789ABCDEFGHJKMNPQRS",
            "-cn_MBGB9NHBQB0BVZYCAD95GDM2M4",
            "cn_MBGB9NHBQB0BVZYCAD95GDM2M4 --json",
            "../cn_MBGB9NHBQB0BVZYCAD95GDM2M4",
        ] {
            for kind in [
                "connectionShow",
                "connectionKeyReplace",
                "connectionRemove",
                "connectionMigrateUndo",
            ] {
                refused(json!({ "kind": kind, "connectionId": id }));
            }
            refused(json!({ "kind": "connectionRename", "connectionId": id, "name": "Work" }));
            refused(
                json!({ "kind": "connectionChange", "connectionId": id, "parts": [{ "server": "core" }] }),
            );
        }
        // Names: core's rule, and never an option.
        for name in [
            "",
            " Work",
            "Work ",
            "-Work",
            "--app",
            "Work\nClaude",
            "Work\tClaude",
            "Work \"Claude\"",
            "Work ‘Claude’",
            "Work `x`",
            "Work\u{202E}edualC",
            "Work\u{200B}",
            "x".repeat(65).as_str(),
            // A name that imitates the label a preview gives it (0.35.0 re-review, LOW 6): no brackets, no ellipsis.
            "Everywhere) (Claude Code, every folder, cn_0MCZ…",
            "Work (Claude Code",
            "Work)",
            "Work…",
        ] {
            refused(
                json!({ "kind": "connectionAdd", "app": "manual", "name": name, "parts": [{ "server": "core" }] }),
            );
            refused(
                json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": name }),
            );
        }
        assert!(connection_name(&"x".repeat(64)));
        assert!(connection_name("Acme site — Claude Code"));
        // Apps: core's seven, by their exact words; `json` prints and is no connection.
        for app in [
            "",
            "json",
            "Claude-Code",
            "claude_code",
            "windsurf",
            "manual ",
        ] {
            refused(
                json!({ "kind": "connectionAdd", "app": app, "name": "Work", "parts": [{ "server": "core" }] }),
            );
        }
        // Parts: 1 to 16, each server once, each a word of the platform pattern with an account's name and read-only.
        for parts in [
            json!([]),
            json!("core,gmail"),
            json!([{ "server": "core" }, { "server": "core" }]),
            json!([{ "server": "" }]),
            json!([{ "server": "Gmail" }]),
            json!([{ "server": "gmail-mcp" }]),
            json!([{ "server": "gmail:cue/gmail" }]),
            json!([{ "server": "gmail,slack" }]),
            json!([{ "server": "--parts" }]),
            json!([{ "server": "gmail", "account": "cue/gmail,slack" }]),
            json!([{ "server": "gmail", "account": "cue:gmail" }]),
            json!([{ "server": "gmail", "account": "-cue/gmail" }]),
            json!([{ "server": "gmail", "readOnly": "yes" }]),
            json!([{ "server": "gmail", "pin": "cue/gmail" }]),
            json!([{ "server": "gmail", "accounts": ["cue/gmail"] }]),
            json!((0..17)
                .map(|n| json!({ "server": format!("part{n}") }))
                .collect::<Vec<_>>()),
        ] {
            refused(
                json!({ "kind": "connectionAdd", "app": "claude-code", "name": "Work", "parts": parts.clone() }),
            );
            refused(
                json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": parts }),
            );
        }
        refused(json!({ "kind": "connectionAdd", "app": "claude-code", "name": "Work" }));
        refused(json!({ "kind": "connectionChange", "connectionId": CONNECTION }));
        // Folders: written whole, absolute, no step back, nothing hidden in them.
        for folder in [
            "",
            "work/acme",
            "~/work/acme",
            "/",
            "/example/home/work/",
            "/example//home",
            "/example/home/../etc",
            "/example/./home",
            "/example/home\n/x",
            "/example/\u{202E}home",
            "C:",
            "C:\\",
            "C:\\Work\\example\\",
            "C:\\Work\\..\\x",
            "C:\\Work/example",
            "\\\\server\\share",
            "-x",
            format!("/{}", "a".repeat(1024)).as_str(),
        ] {
            refused(json!({
                "kind": "connectionAdd", "app": "claude-code", "name": "Work",
                "parts": [{ "server": "core" }], "folder": folder
            }));
            refused(json!({
                "kind": "connectionAdd", "app": "codex", "name": "Work",
                "parts": [{ "server": "core" }], "profile": folder
            }));
        }
        assert!(connection_folder("/example/home/work/acme-site"));
        assert!(connection_folder("/example/home/My Projects/site"));
        assert!(connection_folder("D:\\work\\acme-site"));
        // One project is Claude Code's alone; another profile is Claude Code's and Codex's.
        for app in [
            "claude-desktop",
            "codex",
            "cursor",
            "gemini",
            "vscode",
            "manual",
        ] {
            let refusal = call(json!({
                "kind": "connectionAdd", "app": app, "name": "Work",
                "parts": [{ "server": "core" }], "folder": "/example/home/work/acme"
            }))
            .words()
            .expect_err("a folder is Claude Code's");
            assert_eq!(refusal.code, "APP_REFUSED", "{app}");
        }
        for app in ["claude-desktop", "cursor", "gemini", "vscode", "manual"] {
            let refusal = call(json!({
                "kind": "connectionAdd", "app": app, "name": "Work",
                "parts": [{ "server": "core" }], "profile": "/example/home/.other"
            }))
            .words()
            .expect_err("a profile is Claude Code's or Codex's");
            assert_eq!(refusal.code, "APP_REFUSED", "{app}");
        }
        // Migrate: an app of core's six, by its word, or none.
        for client in ["", "json", "manual", "Codex", "codex --force"] {
            refused(json!({ "kind": "connectionMigrate", "client": client }));
        }
        // Nothing else rides along: no launcher, no --no-verify, no force, no approval, no key.
        for (field, value) in [
            ("launcher", json!("npx")),
            ("noVerify", json!(true)),
            ("force", json!(true)),
            ("approval", json!(ID)),
            ("approvalId", json!(ID)),
            ("key", json!("ack_x")),
            ("app", json!("Raycast")),
        ] {
            let mut with =
                json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": "Work" });
            with[field] = value.clone();
            refused(with);
            let mut with = json!({ "kind": "connectionRemove", "connectionId": CONNECTION });
            with[field] = value.clone();
            refused(with);
            if field != "app" {
                let mut with = add();
                with[field] = value;
                refused(with);
            }
        }
        refused(json!({ "kind": "connectionList", "connectionId": CONNECTION }));
        refused(json!({ "kind": "connectionShow" }));
        refused(
            json!({ "kind": "connectionKeyReplace", "connectionId": CONNECTION, "appApproval": ID }),
        );
        refused(
            json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": "Work", "appApproval": ID }),
        );
        refused(
            json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION, "client": "codex" }),
        );
        refused(json!({ "kind": "connectionMigrate", "appApproval": "ap_short" }));
        refused(json!({ "kind": "connectionRevoke", "connectionId": CONNECTION }));
    }

    #[test]
    fn only_a_loosening_without_the_app_approval_prepares_and_opens_in_the_terminal() {
        let revoke = ApprovalId::try_from(ID.to_string()).expect("an id");
        let preparing = [
            add(),
            json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": [{ "server": "core" }] }),
            json!({ "kind": "connectionMigrate" }),
            json!({ "kind": "connectionMigrate", "client": "cursor" }),
            json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION }),
            // At once where it narrows; prepared where its entry shadows a wider one (the security review's H1).
            json!({ "kind": "connectionRemove", "connectionId": CONNECTION }),
        ];
        for value in preparing {
            let prepared = call(value.clone());
            assert!(prepared.prepares_change(), "{value}");
            assert!(prepared.answers_app_approval().is_none(), "{value}");
            // In Terminal the change itself opens, as the allow-list builds it, without the app's approval.
            let (product, line) = command_words(&TerminalCommand::Change {
                call: prepared.clone(),
                revoke: revoke.clone(),
            })
            .expect("words");
            assert_eq!(product, Product::Core);
            assert_eq!(line, words(value.clone()), "{value}");
            // Approved in the app, it answers that very change, and is never one to open in Terminal.
            let mut approved = value.clone();
            approved["appApproval"] = json!(ID);
            let approved = call(approved);
            assert!(!approved.prepares_change(), "{value}");
            let (id, answered) = approved.answers_app_approval().expect("it answers one");
            assert_eq!(id.as_str(), ID);
            assert_eq!(answered, prepared, "{value}");
            assert!(command_words(&TerminalCommand::Change {
                call: approved,
                revoke: revoke.clone()
            })
            .is_err());
        }
        // The reads and the changes that apply at once prepare nothing, answer nothing, and never open as a change.
        for value in [
            json!({ "kind": "connectionList" }),
            json!({ "kind": "connectionShow", "connectionId": CONNECTION }),
            json!({ "kind": "connectionRename", "connectionId": CONNECTION, "name": "Work" }),
            json!({ "kind": "connectionKeyReplace", "connectionId": CONNECTION }),
        ] {
            let at_once = call(value.clone());
            assert!(!at_once.prepares_change(), "{value}");
            assert!(at_once.answers_app_approval().is_none(), "{value}");
            assert!(
                command_words(&TerminalCommand::Change {
                    call: at_once,
                    revoke: revoke.clone()
                })
                .is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn the_app_approves_only_the_connection_change_it_prepared_word_for_word() {
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            CliResult::Ok {
                exit: 0,
                data: json!({ "connection": { "id": CONNECTION } }),
            }
        };
        let prepared = |value: Value| {
            let record = Prepared::default();
            record.record(
                &call(value),
                &CliResult::ApprovalPending {
                    approval_id: ID.to_string(),
                    preview: "Add the connection \"Work — Claude Code\" for Claude Code".into(),
                    expires_at: None,
                },
            );
            record
        };
        let with_approval = |mut value: Value| {
            value["appApproval"] = json!(ID);
            call(value)
        };
        // Another name, another app, other parts, another folder, another connection or a migration: refused, and
        // nothing runs.
        let mut other_name = add();
        other_name["name"] = json!("Work");
        let mut other_app = add();
        other_app["app"] = json!("codex");
        let mut other_parts = add();
        other_parts["parts"] =
            json!([{ "server": "core" }, { "server": "gmail", "account": "cue/gmail" }]);
        let mut with_folder = add();
        with_folder["folder"] = json!("/example/home/work/acme");
        for other in [
            other_name,
            other_app,
            other_parts,
            with_folder,
            json!({ "kind": "connectionMigrate" }),
        ] {
            let refusal = run_app_approval(&prepared(add()), &with_approval(other.clone()), ok)
                .expect_err("another change");
            assert_eq!(refusal.code, "APP_REFUSED", "{other}");
        }
        let change = json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": [{ "server": "core" }, { "server": "slack" }] });
        let other_connection = json!({ "kind": "connectionChange", "connectionId": OTHER, "parts": [{ "server": "core" }, { "server": "slack" }] });
        assert!(run_app_approval(
            &prepared(change.clone()),
            &with_approval(other_connection),
            ok
        )
        .is_err());
        // Nothing prepared — an addition an agent prepared over MCP is one the app never recorded.
        assert!(run_app_approval(&Prepared::default(), &with_approval(add()), ok).is_err());
        assert_eq!(ran.get(), 0);
        // The very change prepared: it runs once, and never twice.
        for value in [
            add(),
            change,
            json!({ "kind": "connectionMigrate", "client": "codex" }),
            json!({ "kind": "connectionMigrateUndo", "connectionId": CONNECTION }),
        ] {
            let before = ran.get();
            let record = prepared(value.clone());
            assert!(
                run_app_approval(&record, &with_approval(value.clone()), ok).is_ok(),
                "{value}"
            );
            assert!(
                run_app_approval(&record, &with_approval(value.clone()), ok).is_err(),
                "never twice"
            );
            assert_eq!(ran.get(), before + 1, "{value}");
        }
        // A change of parts that came back applied, only narrowing, is never recorded: nothing answers it.
        let record = Prepared::default();
        let narrowing = json!({ "kind": "connectionChange", "connectionId": CONNECTION, "parts": [{ "server": "core" }] });
        record.record(
            &call(narrowing.clone()),
            &CliResult::Ok {
                exit: 0,
                data: json!({ "appliedAtOnce": ["Slack taken out"] }),
            },
        );
        assert!(run_app_approval(&record, &with_approval(narrowing), ok).is_err());
        // The changes that apply at once are never recorded either, so no approval rides on them.
        let record = Prepared::default();
        record.record(
            &call(json!({ "kind": "connectionKeyReplace", "connectionId": CONNECTION })),
            &CliResult::ApprovalPending {
                approval_id: ID.to_string(),
                preview: String::new(),
                expires_at: None,
            },
        );
        assert!(run_app_approval(&record, &with_approval(add()), ok).is_err());
    }

    #[test]
    fn every_connection_call_needs_0_35_0_and_none_runs_in_the_test_build() {
        assert_eq!(CONNECTIONS_VERSION, "0.35.0");
        const TEST: &str = "com.cueplusplus.agentcomms.test";
        const RELEASE: &str = "com.cueplusplus.agentcomms";
        let mut seen = 0;
        for (sample, value) in samples() {
            if !sample.is_connection() {
                assert!(sample.connection_words().is_err(), "{value}");
                continue;
            }
            seen += 1;
            assert_eq!(sample.needs(), Some(CONNECTIONS_VERSION), "{value}");
            assert_eq!(
                sample.words().expect("it builds"),
                sample.connection_words().expect("it builds"),
                "{value}"
            );
            // The test build's core is the test profile's, and its connections' entries would be the person's real
            // apps': it only shows, and reads.
            let read = matches!(
                sample,
                Call::ConnectionList {} | Call::ConnectionShow { .. }
            );
            assert_eq!(sample.changes_connection(), !read, "{value}");
            assert_eq!(refuse_in_test_build(&sample, TEST).is_ok(), read, "{value}");
            assert!(refuse_in_test_build(&sample, RELEASE).is_ok(), "{value}");
        }
        assert_eq!(seen, 16);
    }
}
