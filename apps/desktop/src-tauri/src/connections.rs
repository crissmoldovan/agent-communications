//! Connections (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.3): which apps on this machine have which servers. The
//! app reads core's `channels`, and adds or takes away one server for one app: `mcp install --client <c> --server <s>`,
//! a change the person approves in Terminal (DA10), and `mcp uninstall --client <c> --server <s>`, a tightening core
//! applies at once. The app and the server are each one word of a closed list, so nothing the window sends reaches
//! core's arguments but those words.

use serde::{Deserialize, Serialize};

/// The first core with `mcp uninstall` (0.32.0, plan Task E): an older one says "Needs 0.32.0 or later" (DA12).
pub const MCP_UNINSTALL_VERSION: &str = "0.32.0";

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
}
