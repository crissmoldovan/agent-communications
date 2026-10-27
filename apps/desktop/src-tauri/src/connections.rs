//! Connections (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.3): which apps on this machine have which servers. The
//! app reads core's `channels`, and adds or takes away servers for one app: `mcp install --client <c> --server <s>` —
//! or, from core 0.34.0, `--server <a,b,c>`, several in one approval — a change the person approves in the app, and `mcp
//! uninstall --client <c> --server <s>`, a tightening core applies at once. It reads `update --check` (0.34.0), and
//! brings everything up to date with `update`, approved in the app. The app and each server are words of a closed
//! list, so nothing the window sends reaches core's arguments but those words.

use crate::allowlist::{ApprovalId, Call};
use crate::build_info;
use crate::ipc::{AppError, CliResult, TerminalCommand};
use crate::terminal::Prepared;
use serde::{Deserialize, Serialize};

/// The first core with `mcp uninstall` (0.32.0, plan Task E): an older one says "Needs 0.32.0 or later" (DA12).
pub const MCP_UNINSTALL_VERSION: &str = "0.32.0";

/// The first core whose `mcp install` takes the app's own approval, `--app-approval` (0.32.0): an older one keeps
/// Approve in Terminal.
pub const MCP_APP_APPROVAL_VERSION: &str = "0.32.0";

/// The first core that registers several servers with one app in one approval, `--server <a,b,c>` (0.34.0): an older
/// one is asked for each server on its own, as before.
pub const MCP_SEVERAL_VERSION: &str = "0.34.0";

/// The first core whose `update` takes the app's own approval, and whose `update --check` Connections reads to say which
/// entries start an older Agent Comms (0.34.0), in place of "behind core", which compared them with the core answering.
pub const UPDATE_APP_APPROVAL_VERSION: &str = "0.34.0";

impl Call {
    /// The approval this call answers in the app, and the change it was prepared for: `mcpInstallApproved` answers the
    /// `mcpInstall` of the same app and the same servers in the same order, `updateApproved` the `update` the app
    /// prepared (0.34.0), `eventsRuleApprove` the rule activation `eventsRuleEnable` came back with, for the same digest
    /// (0.33.0), `eventsCollectionApprove` the switching on `eventsEnableAll` came back with (0.34.0), and
    /// `eventsSubscriberApprove` the subscription `eventsSubscriberEnable` came back with (0.36.0); and a label change
    /// with `appApproval` the same change without it (0.34.0, `label`), as a taking change's is (0.35.0, `taking`).
    /// None for every other call.
    pub fn answers_app_approval(&self) -> Option<(&ApprovalId, Call)> {
        match self {
            Call::McpInstallApproved {
                client,
                server,
                approval_id,
            } => Some((
                approval_id,
                Call::McpInstall {
                    client: *client,
                    server: server.clone(),
                },
            )),
            Call::UpdateApproved { approval_id } => Some((approval_id, Call::Update {})),
            // A rule's activation the app prepared with `eventsRuleEnable`, for this very digest (0.33.0): what
            // `Prepared::record` keeps for it is the approval that may answer it.
            Call::EventsRuleApprove { approval_id, .. } => Some((approval_id, self.clone())),
            // Switching the event service on that Events → Service prepared with `eventsEnableAll`, for this very digest
            // (0.34.0): kept the same way.
            Call::EventsCollectionApprove { approval_id, .. } => Some((approval_id, self.clone())),
            // A subscription Events → Subscribers prepared with `eventsSubscriberEnable`, for this very digest (0.36.0):
            // kept the same way.
            Call::EventsSubscriberApprove { approval_id, .. } => Some((approval_id, self.clone())),
            // An account page's loosenings (0.34.0): each the very change the app prepared, word for word.
            Call::BehaviourAllowApproved {
                account,
                acts,
                conversation,
                approval_id,
            } => Some((
                approval_id,
                Call::BehaviourAllow {
                    account: account.clone(),
                    acts: acts.clone(),
                    conversation: conversation.clone(),
                },
            )),
            Call::BehaviourClearApproved {
                account,
                conversation,
                approval_id,
            } => Some((
                approval_id,
                Call::BehaviourClear {
                    account: account.clone(),
                    conversation: conversation.clone(),
                },
            )),
            Call::LabelStyleApproved {
                account,
                style,
                approval_id,
            } => Some((
                approval_id,
                Call::LabelStyle {
                    account: account.clone(),
                    style: *style,
                },
            )),
            // A label change (0.34.0, Your agents), a taking change or one of Search's loosenings (0.35.0): the same
            // change, without the approval the app prepared it for.
            _ => self
                .answers_label_approval()
                .or_else(|| self.answers_taking_approval())
                .or_else(|| self.answers_search_approval()),
        }
    }
}

/// Why the test build edits no app's settings: its core is the test profile's, but the client configs `mcp install`,
/// `mcp uninstall` and `update` write are the person's real ones (`~/.claude.json` and the rest), so a test could
/// register an unverified local build into their real apps, or take their real servers away.
const TEST_BUILD_REFUSAL: &str =
    "the test build does not change which apps have which servers, or bring them up to date: \
Connections only shows there, because changing it would edit your real apps' settings. Use your own Agent Comms for \
that";

impl Call {
    /// Whether the call writes a client's own config: adding a server to an app, taking one away, or an update, which
    /// registers servers again (0.34.0).
    pub fn edits_client_configs(&self) -> bool {
        matches!(
            self,
            Call::McpInstall { .. }
                | Call::McpInstallApproved { .. }
                | Call::McpUninstall { .. }
                | Call::Update {}
                | Call::UpdateApproved { .. }
        )
    }
}

/// Refuses, in the test build (an identifier ending in `.test`), every call that edits a client's config (0.32.0):
/// Connections only shows there, and a stray call cannot change the person's real apps either.
pub fn refuse_in_test_build(call: &Call, identifier: &str) -> Result<(), AppError> {
    if build_info::is_test(identifier) && call.edits_client_configs() {
        return Err(AppError::refused(TEST_BUILD_REFUSAL));
    }
    Ok(())
}

/// The same for a change opened in the terminal, which runs the same words there.
pub fn refuse_terminal_in_test_build(
    command: &TerminalCommand,
    identifier: &str,
) -> Result<(), AppError> {
    match command {
        TerminalCommand::Change { call, .. } => refuse_in_test_build(call, identifier),
        _ => Ok(()),
    }
}

/// Runs `call` through `run`. A call that answers an approval in the app (`answers_app_approval`) runs only when
/// `prepared` recorded that approval for the very change it answers, and takes it, once: the webview cannot have the
/// app approve an approval an agent prepared, or one prepared for another install. When the run did not come back
/// applied, the record is put back, so the preview's Cancel can still revoke it.
pub fn run_app_approval(
    prepared: &Prepared,
    call: &Call,
    run: impl FnOnce() -> CliResult,
) -> Result<CliResult, AppError> {
    let Some((id, answered)) = call.answers_app_approval() else {
        return Ok(run());
    };
    prepared.take_for(id, &answered)?;
    let result = run();
    if !matches!(result, CliResult::Ok { .. }) {
        prepared.restore(id, answered);
    }
    Ok(result)
}

/// An app a server is registered with, as `mcp install --client` names it: core's `CLIENTS` less `json`, which prints
/// an entry instead of registering one. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpClient {
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
}

impl McpClient {
    pub const ALL: [McpClient; 6] = [
        McpClient::ClaudeCode,
        McpClient::ClaudeDesktop,
        McpClient::Codex,
        McpClient::Cursor,
        McpClient::Gemini,
        McpClient::Vscode,
    ];

    /// The app as core names it.
    pub fn word(self) -> &'static str {
        match self {
            McpClient::ClaudeCode => "claude-code",
            McpClient::ClaudeDesktop => "claude-desktop",
            McpClient::Codex => "codex",
            McpClient::Cursor => "cursor",
            McpClient::Gemini => "gemini",
            McpClient::Vscode => "vscode",
        }
    }
}

/// A server core registers, as `mcp install --server` names it: core's own, the four channels this release builds in,
/// and the event service's `events`. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpServer {
    Core,
    Gmail,
    Slack,
    Resend,
    Whatsapp,
    Events,
}

impl McpServer {
    pub const ALL: [McpServer; 6] = [
        McpServer::Core,
        McpServer::Gmail,
        McpServer::Slack,
        McpServer::Resend,
        McpServer::Whatsapp,
        McpServer::Events,
    ];

    /// The server as core names it.
    pub fn word(self) -> &'static str {
        match self {
            McpServer::Core => "core",
            McpServer::Gmail => "gmail",
            McpServer::Slack => "slack",
            McpServer::Resend => "resend",
            McpServer::Whatsapp => "whatsapp",
            McpServer::Events => "events",
        }
    }

    /// Its place in core's order.
    fn place(self) -> usize {
        McpServer::ALL
            .iter()
            .position(|each| *each == self)
            .unwrap_or(McpServer::ALL.len())
    }
}

/// The servers one `mcp install` registers with one app: one, as every core takes it, or several (0.34.0), which
/// core registers in one approval, in the order given, stopping at the first that fails. One is written on its own
/// (`"gmail"`), several as a list (`["core", "gmail", "events"]`), so each install has exactly one shape for the
/// app's record of what it prepared to match.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpServers {
    One(McpServer),
    Several(ServerList),
}

/// Two servers or more, in core's order, each once. Closed: every one is an `McpServer`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<McpServer>", into = "Vec<McpServer>")]
pub struct ServerList(Vec<McpServer>);

impl TryFrom<Vec<McpServer>> for ServerList {
    type Error = String;

    fn try_from(list: Vec<McpServer>) -> Result<Self, String> {
        if list.len() < 2 {
            return Err("a list names two servers or more: one is named on its own".into());
        }
        if !list
            .windows(2)
            .all(|pair| pair[0].place() < pair[1].place())
        {
            return Err("the servers are listed in core's order, each once".into());
        }
        Ok(ServerList(list))
    }
}

impl From<ServerList> for Vec<McpServer> {
    fn from(list: ServerList) -> Self {
        list.0
    }
}

impl McpServers {
    /// `--server`'s word: the one server, or the list joined with commas, as core 0.34.0 takes it.
    pub fn word(&self) -> String {
        match self {
            McpServers::One(server) => server.word().to_string(),
            McpServers::Several(list) => list
                .0
                .iter()
                .map(|server| server.word())
                .collect::<Vec<_>>()
                .join(","),
        }
    }

    /// Whether it names more than one server, which needs core 0.34.0 (`MCP_SEVERAL_VERSION`).
    pub fn several(&self) -> bool {
        matches!(self, McpServers::Several(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::{Call, Shape};
    use crate::ipc::TerminalCommand;
    use crate::launchers::Product;
    use crate::terminal::command_words;
    use serde_json::json;
    use std::time::Duration;

    fn call(value: serde_json::Value) -> Call {
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    fn refused(value: serde_json::Value) {
        assert!(
            serde_json::from_value::<Call>(value.clone()).is_err(),
            "{value} was accepted"
        );
    }

    #[test]
    fn connection_calls_build_exactly_their_words() {
        let channels = call(json!({ "kind": "channels" })).words().expect("words");
        assert_eq!(channels.product, Product::Core);
        assert_eq!(channels.words, ["channels"]);
        assert_eq!(channels.shape, Shape::Envelope);
        assert!(channels.pins);
        assert!(channels.quiet_updates);
        assert_eq!(channels.timeout, Duration::from_secs(30));
        for client in McpClient::ALL {
            for server in McpServer::ALL {
                let value = json!({ "kind": "mcpInstall", "client": client.word(), "server": server.word() });
                let install = call(value.clone()).words().expect("words");
                assert_eq!(install.product, Product::Core, "{value}");
                assert_eq!(
                    install.words,
                    [
                        "mcp",
                        "install",
                        "--client",
                        client.word(),
                        "--server",
                        server.word()
                    ],
                    "{value}"
                );
                assert_eq!(install.shape, Shape::Envelope);
                assert!(install.pins);
                // A first install may read the release's document and verify it before it shows its preview.
                assert_eq!(install.timeout, Duration::from_secs(90), "{value}");
                // The call goes back to the JSON it came from, so the UI and Rust read one shape.
                assert_eq!(
                    serde_json::to_value(call(value.clone())).expect("json"),
                    value
                );

                let value = json!({ "kind": "mcpUninstall", "client": client.word(), "server": server.word() });
                let uninstall = call(value.clone()).words().expect("words");
                assert_eq!(uninstall.product, Product::Core, "{value}");
                assert_eq!(
                    uninstall.words,
                    [
                        "mcp",
                        "uninstall",
                        "--client",
                        client.word(),
                        "--server",
                        server.word()
                    ],
                    "{value}"
                );
                assert_eq!(uninstall.shape, Shape::Envelope);
                assert!(uninstall.pins);
                assert_eq!(uninstall.timeout, Duration::from_secs(30), "{value}");
                assert_eq!(
                    serde_json::to_value(call(value.clone())).expect("json"),
                    value
                );
            }
        }
    }

    #[test]
    fn connection_calls_refuse_any_other_app_server_or_field() {
        for kind in ["mcpInstall", "mcpUninstall"] {
            // An app: only the six core registers with, by their exact words. `json` prints; it registers nothing.
            for bad in [
                "",
                "json",
                "Claude-Code",
                "claude_code",
                "claudecode",
                "claude-code ",
                "--all",
                "-x",
                "vs-code",
                "windsurf",
            ] {
                refused(json!({ "kind": kind, "client": bad, "server": "gmail" }));
            }
            // A server: core, the four channels and the event service's, by their exact words.
            for bad in [
                "",
                "agentcomms",
                "Gmail",
                "gmail-mcp",
                "events-daemon",
                "laya",
                "gmail --read-only",
                "--server",
            ] {
                refused(json!({ "kind": kind, "client": "claude-code", "server": bad }));
            }
            refused(json!({ "kind": kind, "client": "claude-code" }));
            refused(json!({ "kind": kind, "server": "gmail" }));
            refused(json!({ "kind": kind, "client": 1, "server": "gmail" }));
            // Nothing else rides along: no name, account, scope, launcher, force or approval.
            for (field, value) in [
                ("name", json!("gmail")),
                ("account", json!("example/gmail")),
                ("inbox", json!("example/gmail")),
                ("scope", json!("project")),
                ("launcher", json!("npx")),
                ("force", json!(true)),
                ("print", json!(true)),
                ("noVerify", json!(true)),
                ("approval", json!(crate::allowlist::ID)),
                ("approvalId", json!(crate::allowlist::ID)),
            ] {
                let mut value_with =
                    json!({ "kind": kind, "client": "claude-code", "server": "gmail" });
                value_with[field] = value;
                refused(value_with);
            }
        }
        refused(json!({ "kind": "channels", "json": true }));
        refused(json!({ "kind": "channels", "server": "gmail" }));
        refused(json!({ "kind": "mcpPrune" }));
        refused(json!({ "kind": "mcp", "client": "claude-code", "server": "gmail" }));
    }

    #[test]
    fn only_adding_a_server_prepares_a_change_and_only_it_opens_in_the_terminal() {
        let install = call(json!({ "kind": "mcpInstall", "client": "codex", "server": "slack" }));
        assert!(install.prepares_change());
        // Its change opens in the terminal as the allow-list builds it: core's own words, nothing added.
        assert_eq!(
            command_words(&TerminalCommand::Change {
                call: install,
                revoke: crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
                    .expect("an id"),
            })
            .expect("words"),
            (
                Product::Core,
                ["mcp", "install", "--client", "codex", "--server", "slack"]
                    .iter()
                    .map(|word| word.to_string())
                    .collect::<Vec<_>>()
            )
        );
        // Reading and taking away prepare nothing, and neither opens as a change.
        for value in [
            json!({ "kind": "channels" }),
            json!({ "kind": "mcpUninstall", "client": "codex", "server": "slack" }),
        ] {
            let call = call(value.clone());
            assert!(!call.prepares_change(), "{value}");
            let refusal = command_words(&TerminalCommand::Change {
                call,
                revoke: crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
                    .expect("an id"),
            })
            .expect_err("not a change the app prepares");
            assert_eq!(refusal.code, "APP_REFUSED", "{value}");
        }
    }

    #[test]
    fn taking_a_server_away_needs_the_core_that_has_mcp_uninstall() {
        assert_eq!(MCP_UNINSTALL_VERSION, "0.32.0");
        assert_eq!(
            call(json!({ "kind": "mcpUninstall", "client": "cursor", "server": "core" })).needs(),
            Some("0.32.0")
        );
        // `channels` and `mcp install` are much older than any core the app supports.
        assert_eq!(call(json!({ "kind": "channels" })).needs(), None);
        assert_eq!(
            call(json!({ "kind": "mcpInstall", "client": "cursor", "server": "core" })).needs(),
            None
        );
    }

    #[test]
    fn the_lists_are_cores_clients_less_json_and_its_servers() {
        assert_eq!(
            McpClient::ALL.map(McpClient::word),
            [
                "claude-code",
                "claude-desktop",
                "codex",
                "cursor",
                "gemini",
                "vscode"
            ]
        );
        assert_eq!(
            McpServer::ALL.map(McpServer::word),
            ["core", "gmail", "slack", "resend", "whatsapp", "events"]
        );
        for client in McpClient::ALL {
            assert_eq!(
                serde_json::to_value(client).expect("json"),
                json!(client.word())
            );
        }
        for server in McpServer::ALL {
            assert_eq!(
                serde_json::to_value(server).expect("json"),
                json!(server.word())
            );
        }
    }

    /// A recorded `mcp install` change, as `cli` records it when core answers it waiting for approval `ID`.
    fn prepared_install(client: &str, server: &str) -> crate::terminal::Prepared {
        let prepared = crate::terminal::Prepared::default();
        prepared.record(
            &call(json!({ "kind": "mcpInstall", "client": client, "server": server })),
            &crate::ipc::CliResult::ApprovalPending {
                approval_id: crate::allowlist::ID.into(),
                preview: "p".into(),
                expires_at: None,
            },
        );
        prepared
    }

    fn approved(client: &str, server: &str) -> Call {
        call(json!({
            "kind": "mcpInstallApproved",
            "client": client,
            "server": server,
            "approvalId": crate::allowlist::ID
        }))
    }

    #[test]
    fn approving_an_install_in_the_app_builds_cores_words_with_the_app_approval() {
        let words = approved("claude-code", "gmail").words().expect("words");
        assert_eq!(words.product, Product::Core);
        assert_eq!(
            words.words,
            [
                "mcp",
                "install",
                "--client",
                "claude-code",
                "--server",
                "gmail",
                "--app-approval",
                crate::allowlist::ID
            ]
        );
        assert_eq!(words.shape, Shape::Envelope);
        assert!(words.pins);
        // It registers, fetches a runtime when one is needed, and proves the server starts: given room.
        assert_eq!(words.timeout, Duration::from_secs(300));
        // It answers an approval the app prepared, and prepares none; it opens no terminal; it needs core 0.32.0.
        let call = approved("claude-code", "gmail");
        assert!(!call.prepares_change());
        assert_eq!(call.needs(), Some("0.32.0"));
        assert!(command_words(&TerminalCommand::Change {
            call: call.clone(),
            revoke: crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
                .expect("an id"),
        })
        .is_err());
        // Never `--approval`, and never `approve`.
        for word in &words.words {
            assert!(word != "--approval" && word != "approve", "{word}");
        }
        assert_eq!(
            serde_json::to_value(&call).expect("json"),
            json!({
                "kind": "mcpInstallApproved",
                "client": "claude-code",
                "server": "gmail",
                "approvalId": crate::allowlist::ID
            })
        );
    }

    #[test]
    fn approving_an_install_in_the_app_refuses_any_other_word_or_field() {
        for bad in [
            "",
            "ap_",
            "ap_0123456789abcdefghjkmnpqrs",
            "--approval",
            "ap_0123456789ABCDEFGHJKMNPQRS --json",
        ] {
            refused(
                json!({ "kind": "mcpInstallApproved", "client": "cursor", "server": "gmail", "approvalId": bad }),
            );
        }
        refused(json!({ "kind": "mcpInstallApproved", "client": "cursor", "server": "gmail" }));
        refused(
            json!({ "kind": "mcpInstallApproved", "client": "json", "server": "gmail", "approvalId": crate::allowlist::ID }),
        );
        refused(
            json!({ "kind": "mcpInstallApproved", "client": "cursor", "server": "laya", "approvalId": crate::allowlist::ID }),
        );
        refused(json!({
            "kind": "mcpInstallApproved",
            "client": "cursor",
            "server": "gmail",
            "approvalId": crate::allowlist::ID,
            "force": true
        }));
    }

    #[test]
    fn the_app_approves_only_the_approval_it_prepared_for_that_same_install() {
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "applied": true }),
            }
        };
        // Nothing prepared: refused, and nothing runs.
        let refusal = run_app_approval(
            &crate::terminal::Prepared::default(),
            &approved("claude-code", "gmail"),
            ok,
        )
        .expect_err("not prepared");
        assert_eq!(refusal.code, "APP_REFUSED");
        assert_eq!(ran.get(), 0);
        // Prepared for another install, or another app: refused, and nothing runs.
        for (client, server) in [("claude-code", "slack"), ("cursor", "gmail")] {
            let refusal = run_app_approval(
                &prepared_install("claude-code", "gmail"),
                &approved(client, server),
                ok,
            )
            .expect_err("another install");
            assert_eq!(refusal.code, "APP_REFUSED", "{client} {server}");
        }
        assert_eq!(ran.get(), 0);
        // The install the app prepared: it runs once, and its approval is the app's no longer.
        let prepared = prepared_install("claude-code", "gmail");
        let result =
            run_app_approval(&prepared, &approved("claude-code", "gmail"), ok).expect("it runs");
        assert!(matches!(result, crate::ipc::CliResult::Ok { exit: 0, .. }));
        assert_eq!(ran.get(), 1);
        assert!(run_app_approval(&prepared, &approved("claude-code", "gmail"), ok).is_err());
        assert_eq!(ran.get(), 1, "never twice");
        // A run that did not apply keeps the approval the app's, so Cancel can still revoke it.
        let prepared = prepared_install("claude-code", "gmail");
        let failed = run_app_approval(&prepared, &approved("claude-code", "gmail"), || {
            crate::ipc::CliResult::Failed {
                exit: -1,
                code: "APP_TIMEOUT".into(),
                message: "m".into(),
                hint: None,
            }
        })
        .expect("it ran");
        assert!(matches!(failed, crate::ipc::CliResult::Failed { .. }));
        let id = crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
            .expect("an id");
        assert!(prepared.take(&id).is_ok(), "kept for its revoke");
        // Any other call runs as it is.
        let other = run_app_approval(
            &crate::terminal::Prepared::default(),
            &call(json!({ "kind": "channels" })),
            ok,
        )
        .expect("a read");
        assert!(matches!(other, crate::ipc::CliResult::Ok { .. }));
    }

    /// A rule's activation the rule editor prepared (0.33.0): `rule enable`'s answer is recorded, with its digest, as
    /// the one `eventsRuleApprove` that may answer it; another digest, another approval, one an agent prepared, or the
    /// same press twice is refused before anything runs. A run that did not apply keeps it for Cancel's revoke.
    #[test]
    fn the_app_approves_only_the_rule_activation_it_prepared_for_that_digest() {
        use crate::allowlist::{DIGEST, ID};
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approved": true }),
            }
        };
        let enable =
            call(json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": 3 }));
        let prepared_rule = || {
            let prepared = crate::terminal::Prepared::default();
            prepared.record(
                &enable,
                &crate::ipc::CliResult::Ok {
                    exit: 0,
                    data: json!({ "approvalId": ID, "binding": { "digest": DIGEST }, "status": "pending" }),
                },
            );
            prepared
        };
        let approve = |digest: &str| {
            call(json!({ "kind": "eventsRuleApprove", "approvalId": ID, "digest": digest }))
        };
        // Nothing prepared — an approval an agent prepared at the event service is one the app never recorded.
        let refusal = run_app_approval(&crate::terminal::Prepared::default(), &approve(DIGEST), ok)
            .expect_err("not prepared");
        assert_eq!(refusal.code, "APP_REFUSED");
        // Another digest than the one `rule enable` bound.
        let other = "a".repeat(64);
        assert!(run_app_approval(&prepared_rule(), &approve(&other), ok).is_err());
        assert_eq!(ran.get(), 0);
        // An answer that is not a prepared activation records nothing.
        let unread = crate::terminal::Prepared::default();
        unread.record(
            &enable,
            &crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approvalId": ID, "binding": {} }),
            },
        );
        assert!(run_app_approval(&unread, &approve(DIGEST), ok).is_err());
        // The one it prepared: it runs once.
        let prepared = prepared_rule();
        assert!(matches!(
            run_app_approval(&prepared, &approve(DIGEST), ok).expect("it runs"),
            crate::ipc::CliResult::Ok { exit: 0, .. }
        ));
        assert_eq!(ran.get(), 1);
        assert!(run_app_approval(&prepared, &approve(DIGEST), ok).is_err());
        assert_eq!(ran.get(), 1, "never twice");
        // Not applied: kept, so the preview's Cancel can revoke it.
        let prepared = prepared_rule();
        let failed = run_app_approval(&prepared, &approve(DIGEST), || {
            crate::ipc::CliResult::Failed {
                exit: 66,
                code: "APPROVAL_VOID".into(),
                message: "m".into(),
                hint: None,
            }
        })
        .expect("it ran");
        assert!(matches!(failed, crate::ipc::CliResult::Failed { .. }));
        let id = crate::allowlist::ApprovalId::try_from(ID.to_string()).expect("an id");
        let revoked =
            crate::terminal::revoke_preview_with(&prepared, &id, |_| crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "state": "revoked" }),
            })
            .expect("Cancel revokes the app's own");
        assert!(matches!(revoked, crate::ipc::CliResult::Ok { .. }));
        assert!(prepared.take(&id).is_err(), "and it is gone");
        // A rule activation is never opened in the terminal as a change, and never approves an install.
        assert!(!enable.prepares_change());
        assert!(run_app_approval(&prepared_rule(), &approved("claude-code", "gmail"), ok).is_err());
    }

    /// Several servers in one install (0.34.0): a list of two or more, in core's order, each once, written as one
    /// comma list after `--server`; one server keeps its own shape and words, and needs no newer core.
    #[test]
    fn several_servers_go_to_core_as_one_comma_list_and_need_0_34() {
        let several = call(
            json!({ "kind": "mcpInstall", "client": "codex", "server": ["core", "gmail", "events"] }),
        );
        let words = several.words().expect("words");
        assert_eq!(
            words.words,
            [
                "mcp",
                "install",
                "--client",
                "codex",
                "--server",
                "core,gmail,events"
            ]
        );
        assert_eq!(words.timeout, Duration::from_secs(90));
        assert!(several.prepares_change());
        assert_eq!(several.needs(), Some(MCP_SEVERAL_VERSION));
        assert_eq!(MCP_SEVERAL_VERSION, "0.34.0");
        let one = call(json!({ "kind": "mcpInstall", "client": "codex", "server": "gmail" }));
        assert_eq!(one.needs(), None);
        assert_eq!(
            one.words().expect("words").words,
            ["mcp", "install", "--client", "codex", "--server", "gmail"]
        );
        // Each goes back to the JSON it came from: one server as a word, several as a list.
        for value in [
            json!({ "kind": "mcpInstall", "client": "codex", "server": "gmail" }),
            json!({ "kind": "mcpInstall", "client": "codex", "server": ["core", "slack"] }),
            json!({ "kind": "mcpInstall", "client": "cursor", "server": ["core", "gmail", "slack", "resend", "whatsapp", "events"] }),
        ] {
            assert_eq!(
                serde_json::to_value(call(value.clone())).expect("json"),
                value
            );
        }
        // Approved in the app: the same list, then the app's approval; it needs 0.34.0 too.
        let approved = call(json!({
            "kind": "mcpInstallApproved",
            "client": "codex",
            "server": ["core", "gmail", "events"],
            "approvalId": crate::allowlist::ID
        }));
        assert_eq!(
            approved.words().expect("words").words,
            [
                "mcp",
                "install",
                "--client",
                "codex",
                "--server",
                "core,gmail,events",
                "--app-approval",
                crate::allowlist::ID
            ]
        );
        assert_eq!(approved.needs(), Some(MCP_SEVERAL_VERSION));
        // A list of one, an empty one, one out of core's order or with a server twice, or a word that is not a server:
        // refused before anything runs. A comma list is never one word the window may send.
        for bad in [
            json!([]),
            json!(["gmail"]),
            json!(["gmail", "core"]),
            json!(["core", "core"]),
            json!(["core", "gmail", "gmail"]),
            json!(["core", "laya"]),
            json!(["core", "Gmail"]),
            json!("core,gmail"),
            json!(["core,gmail", "events"]),
            json!([["core"], "gmail"]),
            json!({ "core": true }),
        ] {
            refused(json!({ "kind": "mcpInstall", "client": "codex", "server": bad.clone() }));
            refused(json!({
                "kind": "mcpInstallApproved",
                "client": "codex",
                "server": bad,
                "approvalId": crate::allowlist::ID
            }));
        }
        // Opened in the terminal, it is core's own words, the list included.
        assert_eq!(
            command_words(&TerminalCommand::Change {
                call: several,
                revoke: crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
                    .expect("an id"),
            })
            .expect("words")
            .1,
            [
                "mcp",
                "install",
                "--client",
                "codex",
                "--server",
                "core,gmail,events"
            ]
        );
    }

    /// The app answers only the approval it prepared for that very list, in that order: not one server of it, not
    /// another order, and not the list for another app.
    #[test]
    fn the_app_approves_a_list_only_for_the_list_it_prepared() {
        let prepared = crate::terminal::Prepared::default();
        prepared.record(
            &call(json!({ "kind": "mcpInstall", "client": "codex", "server": ["core", "gmail", "events"] })),
            &crate::ipc::CliResult::ApprovalPending {
                approval_id: crate::allowlist::ID.into(),
                preview: "p".into(),
                expires_at: None,
            },
        );
        let answer = |client: &str, server: serde_json::Value| {
            call(json!({
                "kind": "mcpInstallApproved",
                "client": client,
                "server": server,
                "approvalId": crate::allowlist::ID
            }))
        };
        let ok = || crate::ipc::CliResult::Ok {
            exit: 0,
            data: json!({ "servers": ["core", "gmail", "events"] }),
        };
        for (client, server) in [
            ("codex", json!("gmail")),
            ("codex", json!(["core", "gmail"])),
            ("codex", json!(["core", "events"])),
            ("cursor", json!(["core", "gmail", "events"])),
        ] {
            assert!(
                run_app_approval(&prepared, &answer(client, server.clone()), ok).is_err(),
                "{client} {server}"
            );
        }
        assert!(run_app_approval(
            &prepared,
            &answer("codex", json!(["core", "gmail", "events"])),
            ok
        )
        .is_ok());
        assert!(run_app_approval(
            &prepared,
            &answer("codex", json!(["core", "gmail", "events"])),
            ok
        )
        .is_err());
    }

    /// Bring everything up to date (0.34.0): `update --check` read, `update` prepared, and `update --app-approval <id>`
    /// only for the update the app prepared, once; none of them before core 0.34.0, and the two that change refused in
    /// the test build, whose core would register the person's real apps again.
    #[test]
    fn update_calls_read_prepare_and_answer_only_the_update_the_app_prepared() {
        assert_eq!(UPDATE_APP_APPROVAL_VERSION, "0.34.0");
        let check = call(json!({ "kind": "updateCheck" }));
        let words = check.words().expect("words");
        assert_eq!(words.product, Product::Core);
        assert_eq!(words.words, ["update", "--check"]);
        assert_eq!(words.shape, Shape::Envelope);
        assert!(words.pins && words.quiet_updates);
        assert_eq!(words.timeout, Duration::from_secs(90));
        assert!(!check.prepares_change());
        let update = call(json!({ "kind": "update" }));
        assert_eq!(update.words().expect("words").words, ["update"]);
        assert_eq!(
            update.words().expect("words").timeout,
            Duration::from_secs(90)
        );
        assert!(update.prepares_change());
        let answered =
            call(json!({ "kind": "updateApproved", "approvalId": crate::allowlist::ID }));
        let words = answered.words().expect("words");
        assert_eq!(
            words.words,
            ["update", "--app-approval", crate::allowlist::ID]
        );
        assert_eq!(words.timeout, Duration::from_secs(600));
        assert!(!answered.prepares_change());
        for each in [&check, &update, &answered] {
            assert_eq!(each.needs(), Some("0.34.0"), "{each:?}");
        }
        // Nothing else rides along: no --check beside the approval, no --no-verify, no other approval.
        for value in [
            json!({ "kind": "updateCheck", "json": true }),
            json!({ "kind": "update", "noVerify": true }),
            json!({ "kind": "update", "approvalId": crate::allowlist::ID }),
            json!({ "kind": "updateApproved" }),
            json!({ "kind": "updateApproved", "approvalId": "ap_short" }),
            json!({ "kind": "updateApproved", "approvalId": crate::allowlist::ID, "check": true }),
        ] {
            refused(value);
        }
        // `update` opens in the terminal as itself.
        assert_eq!(
            command_words(&TerminalCommand::Change {
                call: update.clone(),
                revoke: crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
                    .expect("an id"),
            })
            .expect("words")
            .1,
            ["update"]
        );
        // Answered in the app only for the update the app prepared, once; never an install's approval.
        let ok = || crate::ipc::CliResult::Ok {
            exit: 0,
            data: json!({ "status": "updated", "ok": true }),
        };
        assert!(run_app_approval(&crate::terminal::Prepared::default(), &answered, ok).is_err());
        assert!(run_app_approval(&prepared_install("codex", "gmail"), &answered, ok).is_err());
        let prepared = crate::terminal::Prepared::default();
        prepared.record(
            &update,
            &crate::ipc::CliResult::ApprovalPending {
                approval_id: crate::allowlist::ID.into(),
                preview: "p".into(),
                expires_at: None,
            },
        );
        assert!(run_app_approval(&prepared, &approved("codex", "gmail"), ok).is_err());
        assert!(run_app_approval(&prepared, &answered, ok).is_ok());
        assert!(
            run_app_approval(&prepared, &answered, ok).is_err(),
            "never twice"
        );
        // The test build reads, and changes nothing.
        const TEST: &str = "com.cueplusplus.agentcomms.test";
        assert!(refuse_in_test_build(&check, TEST).is_ok());
        for each in [&update, &answered] {
            assert_eq!(
                refuse_in_test_build(each, TEST).expect_err("refused").code,
                "APP_REFUSED"
            );
            assert!(refuse_in_test_build(each, "com.cueplusplus.agentcomms").is_ok());
        }
    }

    /// Switching the event service on that Events → Service prepared (0.34.0 design B4): `enable-all`'s answer is
    /// recorded, with its digest, as the one `eventsCollectionApprove` that may answer it; another digest, nothing
    /// prepared, a rule's activation, or the same press twice is refused before anything runs. A run that did not apply
    /// keeps it for the preview's Cancel.
    #[test]
    fn the_app_switches_on_only_the_enable_all_it_prepared_for_that_digest() {
        use crate::allowlist::{DIGEST, ID};
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approved": true, "approvedBy": "desktop-app" }),
            }
        };
        let prepared_switch = || {
            let prepared = crate::terminal::Prepared::default();
            prepared.record(
                &call(json!({ "kind": "eventsEnableAll" })),
                &crate::ipc::CliResult::Ok {
                    exit: 0,
                    data: json!({
                        "intentId": "intent-1",
                        "approvalId": ID,
                        "binding": { "digest": DIGEST, "activationKind": "enable-all" },
                        "kind": "enable-all",
                        "status": "pending"
                    }),
                },
            );
            prepared
        };
        let approve = |digest: &str| {
            call(json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": digest }))
        };
        // Nothing prepared: an enable-all an agent prepared is one the app never recorded.
        assert_eq!(
            run_app_approval(&crate::terminal::Prepared::default(), &approve(DIGEST), ok)
                .expect_err("not prepared")
                .code,
            "APP_REFUSED"
        );
        // Another digest than the one `enable-all` bound.
        assert!(run_app_approval(&prepared_switch(), &approve(&"a".repeat(64)), ok).is_err());
        // A rule's activation is not switching on, and switching on is not a rule's activation.
        let rule = crate::terminal::Prepared::default();
        rule.record(
            &call(json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": 3 })),
            &crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approvalId": ID, "binding": { "digest": DIGEST } }),
            },
        );
        assert!(run_app_approval(&rule, &approve(DIGEST), ok).is_err());
        let rule_approve =
            call(json!({ "kind": "eventsRuleApprove", "approvalId": ID, "digest": DIGEST }));
        assert!(run_app_approval(&prepared_switch(), &rule_approve, ok).is_err());
        assert_eq!(ran.get(), 0);
        // The one it prepared: it runs once.
        let prepared = prepared_switch();
        assert!(matches!(
            run_app_approval(&prepared, &approve(DIGEST), ok).expect("it runs"),
            crate::ipc::CliResult::Ok { exit: 0, .. }
        ));
        assert_eq!(ran.get(), 1);
        assert!(run_app_approval(&prepared, &approve(DIGEST), ok).is_err());
        assert_eq!(ran.get(), 1, "never twice");
        // Not applied: kept, so the preview's Cancel can revoke it.
        let prepared = prepared_switch();
        let failed = run_app_approval(&prepared, &approve(DIGEST), || {
            crate::ipc::CliResult::Failed {
                exit: 10,
                code: "CLI_FAILED".into(),
                message: "nothing on this platform attests that the Agent Comms app started this"
                    .into(),
                hint: None,
            }
        })
        .expect("it ran");
        assert!(matches!(failed, crate::ipc::CliResult::Failed { .. }));
        let id = crate::allowlist::ApprovalId::try_from(ID.to_string()).expect("an id");
        assert!(prepared.take(&id).is_ok(), "kept for Cancel");
    }

    /// In the test build, Connections only shows (0.32.0): the test profile's core would edit the person's real client
    /// configs, so no call that does, and no change opened in a terminal that does, runs there.
    #[test]
    fn the_test_build_never_edits_the_real_apps_settings() {
        const TEST: &str = "com.cueplusplus.agentcomms.test";
        const RELEASE: &str = "com.cueplusplus.agentcomms";
        let id = || {
            crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string()).expect("an id")
        };
        for value in [
            json!({ "kind": "mcpInstall", "client": "claude-code", "server": "gmail" }),
            json!({ "kind": "mcpUninstall", "client": "cursor", "server": "events" }),
            json!({
                "kind": "mcpInstallApproved",
                "client": "claude-code",
                "server": "gmail",
                "approvalId": crate::allowlist::ID
            }),
        ] {
            let edits = call(value.clone());
            let refusal =
                refuse_in_test_build(&edits, TEST).expect_err("refused in the test build");
            assert_eq!(refusal.code, "APP_REFUSED", "{value}");
            assert!(
                refusal.message.contains("test build"),
                "{}",
                refusal.message
            );
            assert!(refusal.message.contains("real apps"), "{}", refusal.message);
            assert!(refuse_in_test_build(&edits, RELEASE).is_ok(), "{value}");
            // Nor as a change opened in the terminal, which runs the same words.
            let change = TerminalCommand::Change {
                call: edits,
                revoke: id(),
            };
            assert_eq!(
                refuse_terminal_in_test_build(&change, TEST)
                    .expect_err("refused in the test build")
                    .code,
                "APP_REFUSED"
            );
            assert!(refuse_terminal_in_test_build(&change, RELEASE).is_ok());
        }
        // Reads, and every other call and command, are the test build's as they are a release's.
        for value in [
            json!({ "kind": "channels" }),
            json!({ "kind": "approvalsPending" }),
            json!({ "kind": "updateRollback" }),
        ] {
            assert!(
                refuse_in_test_build(&call(value.clone()), TEST).is_ok(),
                "{value}"
            );
        }
        assert!(refuse_terminal_in_test_build(
            &TerminalCommand::Change {
                call: call(json!({ "kind": "updateRollback" })),
                revoke: id(),
            },
            TEST
        )
        .is_ok());
        // Both doors are guarded: the call, and the terminal.
        let source = include_str!("commands.rs");
        let code = &source[..source.find("#[cfg(test)]").expect("the tests")];
        assert!(
            code.contains("connections::refuse_in_test_build(&call, &app.config().identifier)?;")
        );
        assert!(code.contains(
            "connections::refuse_terminal_in_test_build(&command, &app.config().identifier)?;"
        ));
    }

    /// A recorded account change (0.34.0), as `cli` records it when core answers it waiting for approval `ID`.
    fn prepared_change(value: serde_json::Value) -> crate::terminal::Prepared {
        let prepared = crate::terminal::Prepared::default();
        prepared.record(
            &call(value),
            &crate::ipc::CliResult::ApprovalPending {
                approval_id: crate::allowlist::ID.into(),
                preview: "p".into(),
                expires_at: None,
            },
        );
        prepared
    }

    #[test]
    fn an_account_change_approved_in_the_app_builds_cores_words_with_the_app_approval() {
        let id = crate::allowlist::ID;
        for (value, expected) in [
            (
                json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post,reply", "approvalId": id }),
                vec![
                    "behaviour",
                    "allow",
                    "example/slack",
                    "post,reply",
                    "--app-approval",
                    id,
                ],
            ),
            (
                json!({ "kind": "behaviourAllowApproved", "account": "example/gmail", "acts": "reply", "conversation": "@example.com", "approvalId": id }),
                vec![
                    "behaviour",
                    "allow",
                    "example/gmail",
                    "reply",
                    "--conversation",
                    "@example.com",
                    "--app-approval",
                    id,
                ],
            ),
            (
                json!({ "kind": "behaviourClearApproved", "account": "example/slack", "approvalId": id }),
                vec!["behaviour", "clear", "example/slack", "--app-approval", id],
            ),
            (
                json!({ "kind": "behaviourClearApproved", "account": "example/slack", "conversation": "C0123ABCD", "approvalId": id }),
                vec![
                    "behaviour",
                    "clear",
                    "example/slack",
                    "--conversation",
                    "C0123ABCD",
                    "--app-approval",
                    id,
                ],
            ),
            (
                json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": id }),
                vec![
                    "label",
                    "style",
                    "example/slack",
                    "labelled",
                    "--app-approval",
                    id,
                ],
            ),
        ] {
            let approved = call(value.clone());
            let words = approved.words().expect("words");
            assert_eq!(words.product, Product::Core, "{value}");
            assert_eq!(words.words, expected, "{value}");
            assert_eq!(words.shape, Shape::Envelope, "{value}");
            assert!(words.pins, "{value}");
            // It answers an approval the app prepared, prepares none, opens no terminal, and needs core 0.34.0.
            assert!(!approved.prepares_change(), "{value}");
            assert_eq!(approved.needs(), Some("0.34.0"), "{value}");
            assert!(approved.answers_app_approval().is_some(), "{value}");
            assert!(command_words(&TerminalCommand::Change {
                call: approved.clone(),
                revoke: crate::allowlist::ApprovalId::try_from(id.to_string()).expect("an id"),
            })
            .is_err());
            assert_eq!(serde_json::to_value(&approved).expect("json"), value);
        }
        // The app's style applies at once: never approved.
        let refusal = call(
            json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "app", "approvalId": id }),
        )
        .words()
        .expect_err("a tightening takes no approval");
        assert_eq!(refusal.code, "APP_REFUSED");
        // No approval, a bad one, a style that is none, or a field more: refused before anything runs.
        refused(
            json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post" }),
        );
        refused(
            json!({ "kind": "behaviourClearApproved", "account": "example/slack", "approvalId": "ap_" }),
        );
        refused(json!({ "kind": "labelStyle", "account": "example/slack", "style": "bot" }));
        refused(
            json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": id, "force": true }),
        );
    }

    #[test]
    fn a_slack_style_prepares_only_labelled_and_only_it_opens_in_the_terminal() {
        let labelled =
            call(json!({ "kind": "labelStyle", "account": "example/slack", "style": "labelled" }));
        let app = call(json!({ "kind": "labelStyle", "account": "example/slack", "style": "app" }));
        assert!(labelled.prepares_change());
        assert!(!app.prepares_change());
        assert_eq!(labelled.needs(), None);
        let revoke = crate::allowlist::ApprovalId::try_from(crate::allowlist::ID.to_string())
            .expect("an id");
        assert_eq!(
            command_words(&TerminalCommand::Change {
                call: labelled,
                revoke: revoke.clone(),
            })
            .expect("words"),
            (
                Product::Core,
                ["label", "style", "example/slack", "labelled"]
                    .iter()
                    .map(|word| word.to_string())
                    .collect::<Vec<_>>()
            )
        );
        assert!(command_words(&TerminalCommand::Change { call: app, revoke }).is_err());
    }

    #[test]
    fn the_app_approves_only_the_account_change_it_prepared_word_for_word() {
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "changed": true }),
            }
        };
        let id = crate::allowlist::ID;
        let allow =
            json!({ "kind": "behaviourAllow", "account": "example/slack", "acts": "post,reply" });
        // Other acts, another account, another place, or a removal: refused, and nothing runs.
        for other in [
            json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post,reply,file", "approvalId": id }),
            json!({ "kind": "behaviourAllowApproved", "account": "example/slack-two", "acts": "post,reply", "approvalId": id }),
            json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post,reply", "conversation": "C0123ABCD", "approvalId": id }),
            json!({ "kind": "behaviourClearApproved", "account": "example/slack", "approvalId": id }),
            json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": id }),
        ] {
            let refusal =
                run_app_approval(&prepared_change(allow.clone()), &call(other.clone()), ok)
                    .expect_err("another change");
            assert_eq!(refusal.code, "APP_REFUSED", "{other}");
        }
        assert_eq!(ran.get(), 0);
        // The very change prepared: it runs once.
        for (prepared, approved) in [
            (
                allow.clone(),
                json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post,reply", "approvalId": id }),
            ),
            (
                json!({ "kind": "behaviourClear", "account": "example/gmail", "conversation": "@example.com" }),
                json!({ "kind": "behaviourClearApproved", "account": "example/gmail", "conversation": "@example.com", "approvalId": id }),
            ),
            (
                json!({ "kind": "labelStyle", "account": "example/slack", "style": "labelled" }),
                json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": id }),
            ),
        ] {
            let before = ran.get();
            let record = prepared_change(prepared);
            assert!(
                run_app_approval(&record, &call(approved.clone()), ok).is_ok(),
                "{approved}"
            );
            assert!(
                run_app_approval(&record, &call(approved.clone()), ok).is_err(),
                "never twice"
            );
            assert_eq!(ran.get(), before + 1, "{approved}");
        }
        // The app's style is never recorded, since it applies at once: nothing answers it.
        let app = prepared_change(
            json!({ "kind": "labelStyle", "account": "example/slack", "style": "app" }),
        );
        assert!(run_app_approval(
            &app,
            &call(json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": id })),
            ok
        )
        .is_err());
    }

    /// A subscription Events → Subscribers prepared (0.36.0, spec W29): `subscriber enable`'s answer is recorded, with
    /// its digest, as the one `eventsSubscriberApprove` that may answer it; another digest, one an agent prepared, a
    /// rule's activation, or the same press twice is refused before anything runs.
    #[test]
    fn the_app_approves_only_the_subscription_it_prepared_for_that_digest() {
        use crate::allowlist::{DIGEST, ID};
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approved": true }),
            }
        };
        let enable = call(
            json!({ "kind": "eventsSubscriberEnable", "subscriberId": "events-dashboard", "version": 2 }),
        );
        let prepared_subscription = || {
            let prepared = crate::terminal::Prepared::default();
            prepared.record(
                &enable,
                &crate::ipc::CliResult::Ok {
                    exit: 0,
                    data: json!({
                        "approvalId": ID,
                        "binding": { "digest": DIGEST, "activationKind": "subscription" },
                        "kind": "subscription",
                        "status": "pending"
                    }),
                },
            );
            prepared
        };
        let approve = |digest: &str| {
            call(json!({ "kind": "eventsSubscriberApprove", "approvalId": ID, "digest": digest }))
        };
        // Nothing prepared: a subscription an agent prepared is one the app never recorded.
        assert_eq!(
            run_app_approval(&crate::terminal::Prepared::default(), &approve(DIGEST), ok)
                .expect_err("not prepared")
                .code,
            "APP_REFUSED"
        );
        assert!(run_app_approval(&prepared_subscription(), &approve(&"a".repeat(64)), ok).is_err());
        // A rule's activation is not a subscription, and a subscription is not a rule's activation.
        let rule = crate::terminal::Prepared::default();
        rule.record(
            &call(json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": 3 })),
            &crate::ipc::CliResult::Ok {
                exit: 0,
                data: json!({ "approvalId": ID, "binding": { "digest": DIGEST } }),
            },
        );
        assert!(run_app_approval(&rule, &approve(DIGEST), ok).is_err());
        let rule_approve =
            call(json!({ "kind": "eventsRuleApprove", "approvalId": ID, "digest": DIGEST }));
        assert!(run_app_approval(&prepared_subscription(), &rule_approve, ok).is_err());
        assert_eq!(ran.get(), 0);
        // The one it prepared: it runs once.
        let prepared = prepared_subscription();
        assert!(matches!(
            run_app_approval(&prepared, &approve(DIGEST), ok).expect("it runs"),
            crate::ipc::CliResult::Ok { exit: 0, .. }
        ));
        assert_eq!(ran.get(), 1);
        assert!(run_app_approval(&prepared, &approve(DIGEST), ok).is_err());
        assert_eq!(ran.get(), 1, "never twice");
        // A subscription is never opened in the terminal as a change.
        assert!(!enable.prepares_change());
    }
}
