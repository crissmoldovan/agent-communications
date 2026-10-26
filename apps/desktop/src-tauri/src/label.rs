//! Your agents (0.34.0, spec 2026-10-26-desktop-0340 §3 B1): the label every agent message carries, changed in the app.
//! Core's `label word <word>`, `label name <name>` and `label rule add|remove <account> [--conversation <id>] [--kinds
//! <kind,…>] --as agent|me`. A loosening — a new word or name, an exception that sends messages as the person with no
//! tag, or one taken away that kept the tag — is prepared without an approval, and core answers with its preview; the
//! person then approves it in the app, and the same words go again with `--app-approval <id>` (the call's
//! `appApproval`), only for the approval the app prepared for that very change (`connections::run_app_approval`), once.
//! A tightening applies at once, and is never sent the flag: core refuses one that is (exit 64).
//!
//! Every value is closed or checked here before a word is built: the word is one of core's seven, the name holds none
//! of the characters core refuses in one, and the kinds are core's act kinds, each once.

use crate::allowlist::{ApprovalId, Call};
use crate::grammar;
use crate::ipc::AppError;
use serde::{Deserialize, Serialize};

/// The first core whose `label` changes take the app's own approval, `--app-approval` (0.34.0): an older one shows the
/// label read-only, with the line that asks for an update (DA12).
pub const LABEL_APP_APPROVAL_VERSION: &str = "0.34.0";

/// The word after the person's name, as core lists them (`AGENT_LABEL_WORDS`). Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LabelWord {
    #[serde(rename = "agent")]
    Agent,
    #[serde(rename = "assistant")]
    Assistant,
    #[serde(rename = "twin")]
    Twin,
    #[serde(rename = "minion")]
    Minion,
    #[serde(rename = "bot")]
    Bot,
    #[serde(rename = "fake")]
    Fake,
    #[serde(rename = "AI")]
    Ai,
}

impl LabelWord {
    /// The word as core takes it.
    pub fn word(self) -> &'static str {
        match self {
            LabelWord::Agent => "agent",
            LabelWord::Assistant => "assistant",
            LabelWord::Twin => "twin",
            LabelWord::Minion => "minion",
            LabelWord::Bot => "bot",
            LabelWord::Fake => "fake",
            LabelWord::Ai => "AI",
        }
    }
}

/// Who a kind of message appears to come from, as `--as` takes it: the agent, tagged, or the person, with no tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelIdentity {
    Agent,
    Me,
}

impl LabelIdentity {
    pub fn word(self) -> &'static str {
        match self {
            LabelIdentity::Agent => "agent",
            LabelIdentity::Me => "me",
        }
    }
}

/// The longest name the label takes: a Slack `username`'s 80 characters, core's `NAME_SETTING_LIMIT`.
const NAME_LIMIT: usize = 80;

/// What core refuses in a name (`FORBIDDEN_NAME_CHARACTERS`), so nobody can fake a second tag with one.
const FORBIDDEN_IN_NAME: &[char] = &['(', ')', '<', '>', '"', '@', ',', ';', ':', '\\'];

/// The kinds of message a label rule names, as core's `ACT_KINDS` lists them.
const KINDS: &[&str] = &["post", "reply", "reaction", "edit", "file", "send"];

/// A name as `label name` takes it: plain text, no space at either end, none of core's forbidden characters, and at
/// most 80 characters. Core checks it again, with the rest of its rules.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct LabelName(String);

impl LabelName {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn label_name(value: &str) -> bool {
    grammar::plain(value)
        && value.trim() == value
        && value.chars().count() <= NAME_LIMIT
        && !value.chars().any(|c| FORBIDDEN_IN_NAME.contains(&c))
}

impl TryFrom<String> for LabelName {
    type Error = AppError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if label_name(&value) {
            Ok(LabelName(value))
        } else {
            Err(AppError::refused("that is not a name the label can carry"))
        }
    }
}

impl From<LabelName> for String {
    fn from(value: LabelName) -> String {
        value.0
    }
}

/// The kinds a rule is for, as `--kinds` takes them: a comma list of core's act kinds, each once, never empty.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct LabelKinds(String);

impl LabelKinds {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn label_kinds(value: &str) -> bool {
    if !grammar::plain(value) {
        return false;
    }
    let listed: Vec<&str> = value.split(',').collect();
    listed.iter().all(|kind| KINDS.contains(kind))
        && listed
            .iter()
            .enumerate()
            .all(|(index, kind)| !listed[..index].contains(kind))
}

impl TryFrom<String> for LabelKinds {
    type Error = AppError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        if label_kinds(&value) {
            Ok(LabelKinds(value))
        } else {
            Err(AppError::refused("that is not a list of kinds of message"))
        }
    }
}

impl From<LabelKinds> for String {
    fn from(value: LabelKinds) -> String {
        value.0
    }
}

/// `--app-approval <id>`, when the call carries the person's approval in the app.
pub fn app_approval_words(app_approval: &Option<ApprovalId>) -> Vec<String> {
    app_approval
        .iter()
        .flat_map(|id| ["--app-approval".to_string(), id.as_str().to_string()])
        .collect()
}

/// A rule's options after its account: `--conversation`, `--kinds`, `--as`, then the app's approval if it has one.
pub fn rule_words(
    conversation: Option<&str>,
    kinds: &Option<LabelKinds>,
    identity: LabelIdentity,
    app_approval: &Option<ApprovalId>,
) -> Vec<String> {
    let mut words = Vec::new();
    if let Some(conversation) = conversation {
        words.extend(["--conversation".to_string(), conversation.to_string()]);
    }
    if let Some(kinds) = kinds {
        words.extend(["--kinds".to_string(), kinds.as_str().to_string()]);
    }
    words.extend(["--as".to_string(), identity.word().to_string()]);
    words.extend(app_approval_words(app_approval));
    words
}

impl Call {
    /// A label change the person approved in the app, and the change it answers: the same call without its
    /// `appApproval`, which is what the app prepared and `terminal::Prepared` recorded. None for every other call.
    pub fn answers_label_approval(&self) -> Option<(&ApprovalId, Call)> {
        match self {
            Call::LabelWord {
                word,
                app_approval: Some(id),
            } => Some((
                id,
                Call::LabelWord {
                    word: *word,
                    app_approval: None,
                },
            )),
            Call::LabelName {
                name,
                app_approval: Some(id),
            } => Some((
                id,
                Call::LabelName {
                    name: name.clone(),
                    app_approval: None,
                },
            )),
            Call::LabelRuleAdd {
                account,
                conversation,
                kinds,
                identity,
                app_approval: Some(id),
            } => Some((
                id,
                Call::LabelRuleAdd {
                    account: account.clone(),
                    conversation: conversation.clone(),
                    kinds: kinds.clone(),
                    identity: *identity,
                    app_approval: None,
                },
            )),
            Call::LabelRuleRemove {
                account,
                conversation,
                kinds,
                identity,
                app_approval: Some(id),
            } => Some((
                id,
                Call::LabelRuleRemove {
                    account: account.clone(),
                    conversation: conversation.clone(),
                    kinds: kinds.clone(),
                    identity: *identity,
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
    use crate::allowlist::ID;
    use crate::connections::run_app_approval;
    use crate::ipc::CliResult;
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

    fn words(value: Value) -> Vec<String> {
        let built = call(value.clone()).words().expect("it builds");
        assert_eq!(built.product, Product::Core, "{value}");
        assert!(built.pins, "{value}");
        built.words
    }

    #[test]
    fn label_changes_build_cores_words_with_the_app_approval_only_when_given() {
        assert_eq!(
            words(json!({ "kind": "labelWord", "word": "assistant" })),
            ["label", "word", "assistant"]
        );
        assert_eq!(
            words(json!({ "kind": "labelWord", "word": "AI", "appApproval": ID })),
            ["label", "word", "AI", "--app-approval", ID]
        );
        assert_eq!(
            words(json!({ "kind": "labelName", "name": "Jo Example" })),
            ["label", "name", "Jo Example"]
        );
        assert_eq!(
            words(json!({ "kind": "labelName", "name": "Jo Example", "appApproval": ID })),
            ["label", "name", "Jo Example", "--app-approval", ID]
        );
        assert_eq!(
            words(
                json!({ "kind": "labelRuleAdd", "account": "example/slack", "kinds": "reaction", "as": "me" })
            ),
            [
                "label",
                "rule",
                "add",
                "example/slack",
                "--kinds",
                "reaction",
                "--as",
                "me"
            ]
        );
        assert_eq!(
            words(json!({
                "kind": "labelRuleAdd",
                "account": "example/gmail",
                "conversation": "@example.com",
                "as": "me",
                "appApproval": ID
            })),
            [
                "label",
                "rule",
                "add",
                "example/gmail",
                "--conversation",
                "@example.com",
                "--as",
                "me",
                "--app-approval",
                ID
            ]
        );
        assert_eq!(
            words(json!({ "kind": "labelRuleRemove", "account": "example/slack", "as": "me" })),
            ["label", "rule", "remove", "example/slack", "--as", "me"]
        );
        assert_eq!(
            words(json!({
                "kind": "labelRuleRemove",
                "account": "example/slack",
                "conversation": "C0123ABCD",
                "kinds": "reply,reaction",
                "as": "agent",
                "appApproval": ID
            })),
            [
                "label",
                "rule",
                "remove",
                "example/slack",
                "--conversation",
                "C0123ABCD",
                "--kinds",
                "reply,reaction",
                "--as",
                "agent",
                "--app-approval",
                ID
            ]
        );
    }

    #[test]
    fn label_changes_refuse_what_core_would_not_take() {
        for word in ["Agent", "ai", "robot", "", "agent "] {
            refused(json!({ "kind": "labelWord", "word": word }));
        }
        for name in [
            "",
            " Jo",
            "Jo ",
            "Jo (agent)",
            "Jo <jo@example.com>",
            "Jo, Example",
            "Jo: Example",
            "Jo; Example",
            "\"Jo\"",
            "Jo\\Example",
            "-Jo",
            "Jo\u{202e}",
            "Jo\nExample",
        ] {
            refused(json!({ "kind": "labelName", "name": name }));
        }
        refused(json!({ "kind": "labelName", "name": "J".repeat(81) }));
        assert!(serde_json::from_value::<Call>(
            json!({ "kind": "labelName", "name": "J".repeat(80) })
        )
        .is_ok());
        for kinds in [
            "",
            "none",
            "delete",
            "reply,reply",
            "reply, reaction",
            "-reply",
            "reply,",
        ] {
            refused(
                json!({ "kind": "labelRuleAdd", "account": "example/slack", "kinds": kinds, "as": "me" }),
            );
        }
        refused(json!({ "kind": "labelRuleAdd", "account": "example/slack", "as": "you" }));
        refused(json!({ "kind": "labelRuleAdd", "account": "example/slack" }));
        refused(json!({ "kind": "labelRuleAdd", "account": "Example/Slack", "as": "me" }));
        refused(
            json!({ "kind": "labelRuleRemove", "account": "example/slack", "conversation": "#general", "as": "me" }),
        );
        refused(json!({ "kind": "labelWord", "word": "twin", "appApproval": "ap_short" }));
        refused(json!({ "kind": "labelWord", "word": "twin", "approval": ID }));
    }

    #[test]
    fn label_changes_prepare_only_without_the_app_approval_and_need_0_34_0() {
        let prepare = call(json!({ "kind": "labelWord", "word": "twin" }));
        let approve = call(json!({ "kind": "labelWord", "word": "twin", "appApproval": ID }));
        assert!(prepare.prepares_change());
        assert!(!approve.prepares_change());
        assert_eq!(prepare.needs(), Some(LABEL_APP_APPROVAL_VERSION));
        assert_eq!(approve.needs(), Some(LABEL_APP_APPROVAL_VERSION));
        // What it answers is the change the app prepared: the same words, without the approval.
        let (id, answered) = approve.answers_app_approval().expect("it answers one");
        assert_eq!(id.as_str(), ID);
        assert_eq!(answered, prepare);
        assert!(prepare.answers_app_approval().is_none());
        // The terminal opens only the prepared change, never one that carries the app's approval.
        assert!(command_words(&crate::ipc::TerminalCommand::Change {
            call: prepare.clone(),
            revoke: ApprovalId::try_from(ID.to_string()).expect("an id"),
        })
        .is_ok());
        assert!(command_words(&crate::ipc::TerminalCommand::Change {
            call: approve.clone(),
            revoke: ApprovalId::try_from(ID.to_string()).expect("an id"),
        })
        .is_err());
    }

    #[test]
    fn a_label_change_is_approved_in_the_app_only_for_the_change_the_app_prepared() {
        let ok = || CliResult::Ok {
            exit: 0,
            data: json!({ "change": "addRule", "changed": true }),
        };
        let pending = CliResult::ApprovalPending {
            approval_id: ID.into(),
            preview: "Send reaction from example/slack as you, with no label".into(),
            expires_at: None,
        };
        let add = json!({ "kind": "labelRuleAdd", "account": "example/slack", "kinds": "reaction", "as": "me" });
        let mut approved = add.clone();
        approved["appApproval"] = json!(ID);
        // Nothing prepared: refused, and nothing runs.
        let prepared = Prepared::default();
        assert!(
            run_app_approval(&prepared, &call(approved.clone()), || panic!(
                "it must not run"
            ))
            .is_err()
        );
        // Prepared for another rule: refused.
        let mut other = add.clone();
        other["kinds"] = json!("reply");
        prepared.record(&call(other), &pending);
        assert!(
            run_app_approval(&prepared, &call(approved.clone()), || panic!(
                "it must not run"
            ))
            .is_err()
        );
        // Prepared for this one: it runs, once.
        let prepared = Prepared::default();
        prepared.record(&call(add.clone()), &pending);
        assert!(matches!(
            run_app_approval(&prepared, &call(approved.clone()), ok).expect("it runs"),
            CliResult::Ok { .. }
        ));
        assert!(run_app_approval(&prepared, &call(approved), ok).is_err());
    }
}
