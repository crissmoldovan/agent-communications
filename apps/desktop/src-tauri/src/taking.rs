//! Taking messages (0.35.0, design 2026-10-26-taking-messages §5 and §9): who has each message, and each account's
//! settings, in the app.
//!
//! - **Who has each message:** core's `takes list --since <since>`, the person's read of every take record — each
//!   holder's folder and client, each line of its history, each note enveloped — refused inside an MCP server's process.
//! - **The person's overrides:** `takes release <account> <message>` (Take back), `takes give <account> <message>
//!   --window <id>` (Give to…) and `takes keep <account> <message>` (I'll handle it). Each moves only the person's own
//!   coordination, so the app applies it at once (DA10); core refuses each inside an MCP server's process and in an
//!   agent's shell, and the app's child has neither (`runner::command_for` clears its environment).
//! - **The settings:** `taking`, read; and one change, `taking <account> --require on|off | --acknowledge eyes|nothing |
//!   --unclaimed <minutes> | --notify on|off`. Letting sessions act without taking, a 👀 on taking, a longer wait and no
//!   reminder loosen (the last two since the security review of 0.35.0): they are prepared without an approval, core
//!   answers with its preview, and the person approves in the app, where the same words go again with
//!   `--app-approval <id>` (the call's `appApproval`), only for the approval the app prepared for that very change
//!   (`connections::run_app_approval`), once — or in Terminal where nothing attests the app. Core judges a wait by the
//!   one in force, so a shorter one applies at once all the same. Every other change applies at once, and is never sent
//!   the flag.
//!
//! The account is a checked name, the message an id of the grammar `activity items` already takes (a Gmail message's id,
//! a Slack `<channel>/<ts>`, or a Resend email's id, a UUID, which that grammar holds), the window a Claude Code session id
//! or an activity session key, and every setting a closed word or a number in core's range. Nothing else reaches a word.

use crate::allowlist::{ApprovalId, Call};
use crate::ipc::AppError;
use serde::{Deserialize, Serialize};

/// The first core that takes messages (0.35.0): `takes list|release|give|keep` and `taking`. An older one shows no take
/// and no setting, and says "Needs 0.35.0 or later" where a section would be (DA12).
pub const TAKING_VERSION: &str = "0.35.0";

/// What a take says to the sender (`--acknowledge`): a 👀 under a Slack message, made only under a standing approval the
/// person made at their terminal, or nothing. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TakingAcknowledge {
    Eyes,
    Nothing,
}

impl TakingAcknowledge {
    pub fn word(self) -> &'static str {
        match self {
            TakingAcknowledge::Eyes => "eyes",
            TakingAcknowledge::Nothing => "nothing",
        }
    }
}

/// The fewest and the most minutes a message may wait with nobody taking it before it counts (`MIN_UNCLAIMED_MINUTES`,
/// `MAX_UNCLAIMED_MINUTES` in core's `taking.ts`).
pub const UNCLAIMED_MINUTES: std::ops::RangeInclusive<u64> = 5..=240;

/// How long a message may wait with nobody taking it before it counts (`--unclaimed`): whole minutes, 5 to 240.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct UnclaimedMinutes(u64);

impl TryFrom<u64> for UnclaimedMinutes {
    type Error = AppError;

    fn try_from(minutes: u64) -> Result<Self, Self::Error> {
        if UNCLAIMED_MINUTES.contains(&minutes) {
            Ok(UnclaimedMinutes(minutes))
        } else {
            Err(AppError::refused(
                "a message nobody took counts after 5 to 240 whole minutes",
            ))
        }
    }
}

impl From<UnclaimedMinutes> for u64 {
    fn from(minutes: UnclaimedMinutes) -> u64 {
        minutes.0
    }
}

/// One change to an account's taking settings: exactly one setting, as core takes one change at a time. Closed: a
/// setting is one of these four, each with its one value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "setting",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum TakingSetting {
    /// `--require on|off`: whether a session must take a message before it acts on it. Off loosens.
    Require { on: bool },
    /// `--acknowledge eyes|nothing`: what a take says to the sender. Eyes loosens.
    Acknowledge { acknowledge: TakingAcknowledge },
    /// `--unclaimed <minutes>`: when a message nobody took counts. Longer loosens; shorter applies at once.
    Unclaimed { minutes: UnclaimedMinutes },
    /// `--notify on|off`: whether the person is reminded of one. Off loosens.
    Notify { on: bool },
}

impl TakingSetting {
    /// Whether the change can let sessions do more, or the person hear less, so core may answer it with a preview the
    /// person approves first (core's `classifyChange`): letting sessions act without taking, a 👀 on taking, no
    /// reminder, and a change of the wait — a longer one loosens, a shorter one core applies at once, judged by the wait
    /// in force (security review of 0.35.0). Requiring a take, saying nothing and a reminder apply at once.
    pub fn can_loosen(self) -> bool {
        matches!(
            self,
            TakingSetting::Require { on: false }
                | TakingSetting::Acknowledge {
                    acknowledge: TakingAcknowledge::Eyes
                }
                | TakingSetting::Unclaimed { .. }
                | TakingSetting::Notify { on: false }
        )
    }

    /// The option and its word, as `taking <account>` takes them.
    pub fn words(self) -> [String; 2] {
        let on_off = |on: bool| if on { "on" } else { "off" }.to_string();
        match self {
            TakingSetting::Require { on } => ["--require".into(), on_off(on)],
            TakingSetting::Acknowledge { acknowledge } => {
                ["--acknowledge".into(), acknowledge.word().into()]
            }
            TakingSetting::Unclaimed { minutes } => {
                ["--unclaimed".into(), u64::from(minutes).to_string()]
            }
            TakingSetting::Notify { on } => ["--notify".into(), on_off(on)],
        }
    }
}

/// The words of `taking <account> <option> <word> [--app-approval <id>]`, refused when the app's approval rides on a
/// change that applies at once: a tightening takes none, and core refuses one that is sent it.
pub fn change_words(
    account: &str,
    setting: TakingSetting,
    app_approval: &Option<ApprovalId>,
) -> Result<Vec<String>, AppError> {
    if app_approval.is_some() && !setting.can_loosen() {
        return Err(AppError::refused(
            "this change applies at once: it takes no approval",
        ));
    }
    let mut words = vec!["taking".to_string(), account.to_string()];
    words.extend(setting.words());
    words.extend(
        app_approval
            .iter()
            .flat_map(|id| ["--app-approval".to_string(), id.as_str().to_string()]),
    );
    Ok(words)
}

impl Call {
    /// The approval a `takingChange` with `appApproval` answers in the app, and the change it was prepared for: the same
    /// account and setting, without the approval (0.35.0). None for every other call.
    pub fn answers_taking_approval(&self) -> Option<(&ApprovalId, Call)> {
        match self {
            Call::TakingChange {
                account,
                change,
                app_approval: Some(id),
            } => Some((
                id,
                Call::TakingChange {
                    account: account.clone(),
                    change: *change,
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
    use crate::allowlist::{Shape, ID, SESSION};
    use crate::connections::run_app_approval;
    use crate::ipc::{CliResult, TerminalCommand};
    use crate::launchers::Product;
    use crate::terminal::{command_words, Prepared};
    use serde_json::{json, Value};

    fn call(value: Value) -> Call {
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    fn refused(value: Value) {
        assert!(
            serde_json::from_value::<Call>(value.clone()).is_err(),
            "{value} should be refused"
        );
    }

    /// Core's words for `value`: core's launcher, its envelope, the four pins, and the update check quiet.
    fn words(value: Value) -> Vec<String> {
        let built = call(value.clone()).words().expect("it builds");
        assert_eq!(built.product, Product::Core, "{value}");
        assert_eq!(built.shape, Shape::Envelope, "{value}");
        assert!(built.pins, "{value}");
        assert!(built.quiet_updates, "{value}");
        built.words
    }

    const GMAIL_MESSAGE: &str = "18c2f0a1b2c3d4e5";
    const SLACK_MESSAGE: &str = "C0123ABCD/1792886400.000100";
    const RESEND_EMAIL: &str = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    const CLAUDE_SESSION: &str = "0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70";

    #[test]
    fn takes_calls_build_exactly_cores_words() {
        assert_eq!(
            words(json!({ "kind": "takesList", "since": "30d" })),
            ["takes", "list", "--since", "30d"]
        );
        assert_eq!(
            words(json!({ "kind": "takesList", "since": "24h" })),
            ["takes", "list", "--since", "24h"]
        );
        for message in [GMAIL_MESSAGE, SLACK_MESSAGE, RESEND_EMAIL] {
            assert_eq!(
                words(
                    json!({ "kind": "takesRelease", "account": "example/slack", "message": message })
                ),
                ["takes", "release", "example/slack", message]
            );
            assert_eq!(
                words(
                    json!({ "kind": "takesKeep", "account": "example/gmail", "message": message })
                ),
                ["takes", "keep", "example/gmail", message]
            );
        }
        for window in [SESSION, CLAUDE_SESSION] {
            assert_eq!(
                words(json!({
                    "kind": "takesGive",
                    "account": "example/slack",
                    "message": SLACK_MESSAGE,
                    "window": window
                })),
                [
                    "takes",
                    "give",
                    "example/slack",
                    SLACK_MESSAGE,
                    "--window",
                    window
                ]
            );
        }
        assert_eq!(words(json!({ "kind": "taking" })), ["taking"]);
    }

    #[test]
    fn taking_changes_build_one_option_and_the_app_approval_only_on_a_loosening() {
        let account = "example/slack";
        for (change, option, word) in [
            (
                json!({ "setting": "require", "on": true }),
                "--require",
                "on",
            ),
            (
                json!({ "setting": "require", "on": false }),
                "--require",
                "off",
            ),
            (
                json!({ "setting": "acknowledge", "acknowledge": "eyes" }),
                "--acknowledge",
                "eyes",
            ),
            (
                json!({ "setting": "acknowledge", "acknowledge": "nothing" }),
                "--acknowledge",
                "nothing",
            ),
            (
                json!({ "setting": "unclaimed", "minutes": 5 }),
                "--unclaimed",
                "5",
            ),
            (
                json!({ "setting": "unclaimed", "minutes": 240 }),
                "--unclaimed",
                "240",
            ),
            (json!({ "setting": "notify", "on": true }), "--notify", "on"),
            (
                json!({ "setting": "notify", "on": false }),
                "--notify",
                "off",
            ),
        ] {
            let value = json!({ "kind": "takingChange", "account": account, "change": change });
            assert_eq!(words(value.clone()), ["taking", account, option, word]);
            assert_eq!(
                serde_json::to_value(call(value.clone())).expect("json"),
                value
            );
        }
        // A loosening, approved in the app: the same words, then the app's approval.
        assert_eq!(
            words(json!({
                "kind": "takingChange",
                "account": account,
                "change": { "setting": "require", "on": false },
                "appApproval": ID
            })),
            ["taking", account, "--require", "off", "--app-approval", ID]
        );
        assert_eq!(
            words(json!({
                "kind": "takingChange",
                "account": account,
                "change": { "setting": "acknowledge", "acknowledge": "eyes" },
                "appApproval": ID
            })),
            [
                "taking",
                account,
                "--acknowledge",
                "eyes",
                "--app-approval",
                ID
            ]
        );
        // No reminder, and a change of the wait — a longer one loosens (security review of 0.35.0) — approved in the app.
        assert_eq!(
            words(json!({
                "kind": "takingChange",
                "account": account,
                "change": { "setting": "notify", "on": false },
                "appApproval": ID
            })),
            ["taking", account, "--notify", "off", "--app-approval", ID]
        );
        assert_eq!(
            words(json!({
                "kind": "takingChange",
                "account": account,
                "change": { "setting": "unclaimed", "minutes": 240 },
                "appApproval": ID
            })),
            [
                "taking",
                account,
                "--unclaimed",
                "240",
                "--app-approval",
                ID
            ]
        );
        // A tightening applies at once, and is never sent the app's approval.
        for change in [
            json!({ "setting": "require", "on": true }),
            json!({ "setting": "acknowledge", "acknowledge": "nothing" }),
            json!({ "setting": "notify", "on": true }),
        ] {
            let refusal = call(json!({ "kind": "takingChange", "account": account, "change": change, "appApproval": ID }))
                .words()
                .expect_err("a tightening takes no approval");
            assert_eq!(refusal.code, "APP_REFUSED", "{change}");
        }
    }

    #[test]
    fn takes_and_taking_calls_refuse_every_word_outside_their_shapes() {
        // Ranges: only the closed ones; never a free time.
        for since in [
            json!("1d"),
            json!("2026-10-25"),
            json!(1_792_886_400_000_u64),
            json!(null),
        ] {
            refused(json!({ "kind": "takesList", "since": since }));
        }
        refused(json!({ "kind": "takesList" }));
        refused(json!({ "kind": "takesList", "since": "30d", "state": "taken" }));
        // Accounts and messages: checked names and ids, never an option or a path.
        for account in [
            "",
            "-x",
            "Example/slack",
            "example/slack --json",
            "../slack",
        ] {
            refused(
                json!({ "kind": "takesRelease", "account": account, "message": GMAIL_MESSAGE }),
            );
            refused(
                json!({ "kind": "takingChange", "account": account, "change": { "setting": "notify", "on": true } }),
            );
        }
        for message in [
            "",
            "-18c2f0a1",
            "--window",
            "C0123ABCD/1792886400",
            "C0123ABCD/1792886400.000100/x",
            "a b",
            "18c2f0a1\n",
            "x".repeat(129).as_str(),
        ] {
            refused(
                json!({ "kind": "takesRelease", "account": "example/slack", "message": message }),
            );
            refused(json!({ "kind": "takesKeep", "account": "example/slack", "message": message }));
            refused(
                json!({ "kind": "takesGive", "account": "example/slack", "message": message, "window": SESSION }),
            );
        }
        // Windows: a session key or a Claude Code session id, nothing else.
        for window in [
            "",
            "-3f9a1c2e7b4d5a60",
            "3F9A1C2E7B4D5A60",
            "3f9a1c2e7b4d5a6",
            "lane:david",
            "me",
        ] {
            refused(
                json!({ "kind": "takesGive", "account": "example/slack", "message": SLACK_MESSAGE, "window": window }),
            );
        }
        refused(
            json!({ "kind": "takesGive", "account": "example/slack", "message": SLACK_MESSAGE }),
        );
        refused(
            json!({ "kind": "takesKeep", "account": "example/slack", "message": SLACK_MESSAGE, "window": SESSION }),
        );
        // No session ever rides along: taking names none (T2).
        refused(
            json!({ "kind": "takesRelease", "account": "example/slack", "message": SLACK_MESSAGE, "session": SESSION }),
        );
        refused(json!({ "kind": "taking", "account": "example/slack" }));
        // Settings: one, closed, in range.
        for change in [
            json!({}),
            json!({ "setting": "require" }),
            json!({ "setting": "require", "on": "off" }),
            json!({ "setting": "acknowledge", "acknowledge": "thumbsup" }),
            json!({ "setting": "unclaimed", "minutes": 4 }),
            json!({ "setting": "unclaimed", "minutes": 241 }),
            json!({ "setting": "unclaimed", "minutes": 15.5 }),
            json!({ "setting": "notify", "on": true, "minutes": 15 }),
            json!({ "setting": "required", "on": true }),
            json!({ "setting": "require", "on": true, "acknowledge": "eyes" }),
        ] {
            refused(
                json!({ "kind": "takingChange", "account": "example/slack", "change": change }),
            );
        }
        refused(json!({ "kind": "takingChange", "account": "example/slack" }));
        refused(json!({
            "kind": "takingChange",
            "account": "example/slack",
            "change": { "setting": "require", "on": false },
            "appApproval": "ap_short"
        }));
        refused(json!({
            "kind": "takingChange",
            "account": "example/slack",
            "change": { "setting": "require", "on": false },
            "approval": ID
        }));
    }

    #[test]
    fn only_a_loosening_without_the_app_approval_prepares_and_opens_in_the_terminal() {
        let revoke = ApprovalId::try_from(ID.to_string()).expect("an id");
        for (change, prepares) in [
            (json!({ "setting": "require", "on": false }), true),
            (
                json!({ "setting": "acknowledge", "acknowledge": "eyes" }),
                true,
            ),
            (json!({ "setting": "require", "on": true }), false),
            (
                json!({ "setting": "acknowledge", "acknowledge": "nothing" }),
                false,
            ),
            (json!({ "setting": "unclaimed", "minutes": 30 }), true),
            (json!({ "setting": "notify", "on": false }), true),
            (json!({ "setting": "notify", "on": true }), false),
        ] {
            let prepared = call(
                json!({ "kind": "takingChange", "account": "example/slack", "change": change }),
            );
            assert_eq!(prepared.prepares_change(), prepares, "{change}");
            assert_eq!(
                command_words(&TerminalCommand::Change {
                    call: prepared.clone(),
                    revoke: revoke.clone(),
                })
                .is_ok(),
                prepares,
                "{change}"
            );
            assert!(prepared.answers_app_approval().is_none(), "{change}");
        }
        // In Terminal the change itself opens, without the app's approval.
        let off = call(json!({
            "kind": "takingChange",
            "account": "example/gmail",
            "change": { "setting": "require", "on": false }
        }));
        assert_eq!(
            command_words(&TerminalCommand::Change {
                call: off,
                revoke: revoke.clone()
            })
            .expect("words"),
            (
                Product::Core,
                ["taking", "example/gmail", "--require", "off"]
                    .iter()
                    .map(|word| word.to_string())
                    .collect::<Vec<_>>()
            )
        );
        // The approved one answers the change the app prepared, and is never one to open in Terminal.
        let approved = call(json!({
            "kind": "takingChange",
            "account": "example/gmail",
            "change": { "setting": "require", "on": false },
            "appApproval": ID
        }));
        assert!(!approved.prepares_change());
        let (id, answered) = approved.answers_app_approval().expect("it answers one");
        assert_eq!(id.as_str(), ID);
        assert_eq!(
            answered,
            call(json!({
                "kind": "takingChange",
                "account": "example/gmail",
                "change": { "setting": "require", "on": false }
            }))
        );
        assert!(command_words(&TerminalCommand::Change {
            call: approved,
            revoke
        })
        .is_err());
        // Nothing else of taking prepares a change: the person's overrides and the reads apply, or read, at once.
        for value in [
            json!({ "kind": "takesList", "since": "30d" }),
            json!({ "kind": "takesRelease", "account": "example/slack", "message": SLACK_MESSAGE }),
            json!({ "kind": "takesGive", "account": "example/slack", "message": SLACK_MESSAGE, "window": SESSION }),
            json!({ "kind": "takesKeep", "account": "example/slack", "message": SLACK_MESSAGE }),
            json!({ "kind": "taking" }),
        ] {
            assert!(!call(value.clone()).prepares_change(), "{value}");
            assert!(
                call(value.clone()).answers_app_approval().is_none(),
                "{value}"
            );
        }
    }

    #[test]
    fn every_taking_call_needs_0_35_0() {
        for value in [
            json!({ "kind": "takesList", "since": "30d" }),
            json!({ "kind": "takesRelease", "account": "example/slack", "message": SLACK_MESSAGE }),
            json!({ "kind": "takesGive", "account": "example/slack", "message": SLACK_MESSAGE, "window": SESSION }),
            json!({ "kind": "takesKeep", "account": "example/slack", "message": SLACK_MESSAGE }),
            json!({ "kind": "taking" }),
            json!({ "kind": "takingChange", "account": "example/slack", "change": { "setting": "notify", "on": true } }),
            json!({
                "kind": "takingChange",
                "account": "example/slack",
                "change": { "setting": "require", "on": false },
                "appApproval": ID
            }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some(TAKING_VERSION), "{value}");
        }
        assert_eq!(TAKING_VERSION, "0.35.0");
    }

    #[test]
    fn the_app_approves_only_the_taking_change_it_prepared_word_for_word() {
        use std::cell::Cell;
        let ran = Cell::new(0);
        let ok = || {
            ran.set(ran.get() + 1);
            CliResult::Ok {
                exit: 0,
                data: json!({ "changed": true }),
            }
        };
        let off = json!({
            "kind": "takingChange",
            "account": "example/slack",
            "change": { "setting": "require", "on": false }
        });
        let prepared = || {
            let record = Prepared::default();
            record.record(
                &call(off.clone()),
                &CliResult::ApprovalPending {
                    approval_id: ID.to_string(),
                    preview:
                        "Let sessions act on messages in example/slack without taking them first"
                            .into(),
                    expires_at: None,
                },
            );
            record
        };
        // Another account, or another setting: refused, and nothing runs.
        for other in [
            json!({ "kind": "takingChange", "account": "example/slack-two", "change": { "setting": "require", "on": false }, "appApproval": ID }),
            json!({ "kind": "takingChange", "account": "example/slack", "change": { "setting": "acknowledge", "acknowledge": "eyes" }, "appApproval": ID }),
        ] {
            let refusal = run_app_approval(&prepared(), &call(other.clone()), ok)
                .expect_err("another change");
            assert_eq!(refusal.code, "APP_REFUSED", "{other}");
        }
        assert_eq!(ran.get(), 0);
        // The very change prepared: it runs once, and never twice.
        let approved = call(json!({
            "kind": "takingChange",
            "account": "example/slack",
            "change": { "setting": "require", "on": false },
            "appApproval": ID
        }));
        let record = prepared();
        assert!(run_app_approval(&record, &approved, ok).is_ok());
        assert!(
            run_app_approval(&record, &approved, ok).is_err(),
            "never twice"
        );
        assert_eq!(ran.get(), 1);
        // A tightening came back applied, not waiting: it is never recorded, so nothing answers it.
        let on = json!({
            "kind": "takingChange",
            "account": "example/slack",
            "change": { "setting": "require", "on": true }
        });
        let record = Prepared::default();
        record.record(
            &call(on),
            &CliResult::ApprovalPending {
                approval_id: ID.to_string(),
                preview: String::new(),
                expires_at: None,
            },
        );
        assert!(run_app_approval(&record, &approved, ok).is_err());
        assert_eq!(ran.get(), 1);
    }
}
