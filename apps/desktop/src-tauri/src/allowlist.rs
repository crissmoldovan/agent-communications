//! The allow-list (DA4, plan "Global Constraints"): every call the app may make, each argument checked against core's
//! grammars before a word is built. A value that does not match never constructs, so the invoke that carried it fails
//! before anything runs. No call carries `--approval`, and none is `approve`: the app never approves (DA1, DA10).

use crate::grammar;
use crate::ipc::AppError;
use crate::launchers::Product;
use serde::{Deserialize, Serialize};
use std::time::Duration;

macro_rules! checked_word {
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

checked_word!(
    /// `ap_` and 26 of Crockford's letters.
    ApprovalId,
    grammar::approval_id,
    "an approval id"
);
checked_word!(
    /// An account's name, `organisation/platform[-qualifier]`, or a version-1 alias.
    AccountName,
    grammar::account_name,
    "an account name"
);
checked_word!(
    /// A Slack conversation or person, or an address or `@domain`.
    ConversationId,
    grammar::conversation,
    "a conversation"
);
checked_word!(
    /// `none`, or a comma list of acts without repeats.
    Acts,
    grammar::acts,
    "a list of acts"
);

/// How long `update --pause` holds update notices: the three lengths the CLI offers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub enum PauseDays {
    One,
    Seven,
    Fourteen,
}

impl PauseDays {
    pub fn days(self) -> u64 {
        match self {
            PauseDays::One => 1,
            PauseDays::Seven => 7,
            PauseDays::Fourteen => 14,
        }
    }
}

impl TryFrom<u64> for PauseDays {
    type Error = AppError;

    fn try_from(days: u64) -> Result<Self, Self::Error> {
        match days {
            1 => Ok(PauseDays::One),
            7 => Ok(PauseDays::Seven),
            14 => Ok(PauseDays::Fourteen),
            _ => Err(AppError::refused("a pause is 1, 7 or 14 days")),
        }
    }
}

impl From<PauseDays> for u64 {
    fn from(days: PauseDays) -> u64 {
        days.days()
    }
}

/// How often agent-communications updates itself here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum UpdateLevel {
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "every-14-days")]
    Every14Days,
    #[serde(rename = "never")]
    Never,
}

impl UpdateLevel {
    pub fn word(self) -> &'static str {
        match self {
            UpdateLevel::Auto => "auto",
            UpdateLevel::Every14Days => "every-14-days",
            UpdateLevel::Never => "never",
        }
    }
}

/// A judge kind whose judges name an endpoint, which the Judges section turns on (in the terminal) and off by name
/// (0.27.1): TypeSafe's hosted Jev, and a model server on this machine. Closed: nothing else is a kind here. Laya is not
/// one of them: its calls take no argument (`EventsJudgeModelStatus`, `EventsJudgeKindDisable`, and the terminal's
/// `EventsJudgeKindEnable`), so no word the webview sends ever names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EndpointJudgeKind {
    #[serde(rename = "typesafe")]
    Typesafe,
    #[serde(rename = "local-endpoint")]
    LocalEndpoint,
}

impl EndpointJudgeKind {
    #[cfg(test)]
    pub const ALL: [EndpointJudgeKind; 2] = [
        EndpointJudgeKind::Typesafe,
        EndpointJudgeKind::LocalEndpoint,
    ];

    /// The kind as the events CLI names it.
    pub fn word(self) -> &'static str {
        match self {
            EndpointJudgeKind::Typesafe => "typesafe",
            EndpointJudgeKind::LocalEndpoint => "local-endpoint",
        }
    }
}

/// Every call the app may make: the plan's allow-list table, row by row. A row without arguments is written `{}` so
/// that an unknown field is refused there too.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Call {
    /// Any launcher: `--version` alone, without `--json` or pins.
    Version { product: Product },
    /// Core `approvals list --state pending`: every channel's, from the one shared store.
    ApprovalsPending {},
    /// Core `approvals revoke <id>`.
    ApprovalRevoke { approval_id: ApprovalId },
    /// Core `update --status` (0.24.0).
    UpdateStatus {},
    /// Core `update --pause <1|7|14>`.
    UpdatePause { days: PauseDays },
    /// Core `update --resume`.
    UpdateResume {},
    /// Core `update --level <level>`: prepares a change.
    UpdateLevel { level: UpdateLevel },
    /// Core `update --rollback`: prepares a change.
    UpdateRollback {},
    /// Core `update --background-job on|off`: `on` prepares a change.
    UpdateBackgroundJob { on: bool },
    /// Core and Gmail `doctor`; Slack and Resend `doctor --offline`; WhatsApp `status`; the events service's `doctor`.
    Doctor { product: Product },
    /// Gmail `inbox list`, Slack `workspace list`, Resend `account list`.
    Accounts { product: Product },
    /// Core `label`.
    Label {},
    /// Core `behaviour` (0.22.0).
    Behaviour {},
    /// Core `behaviour allow <account> <acts> [--conversation <id>]` (0.22.0): prepares a change.
    BehaviourAllow {
        account: AccountName,
        acts: Acts,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
    },
    /// Core `behaviour clear <account> [--conversation <id>]` (0.22.0): prepares a change.
    BehaviourClear {
        account: AccountName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
    },
    /// Core `profile <account>` (0.22.0).
    ProfileView { account: AccountName },
    /// Core `profile init [<account>] [--conversation <id>]` (0.22.0).
    ProfileInit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<AccountName>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
    },
    /// Core `standing list` (0.23.0).
    StandingList {},
    /// Core `standing revoke <id>` (0.23.0).
    StandingRevoke { id: ApprovalId },
    /// Core `standing off` (0.23.0).
    StandingOff {},
    /// The events service's `status`.
    EventsStatus {},
    /// The events service's `pause`.
    EventsPause {},
    /// The events service's `resume`.
    EventsResume {},
    /// The events service's `rules list`.
    EventsRules {},
    /// The events service's `deliveries list`.
    EventsDeliveries {},
    /// The events service's `stop`: a clean stop of its owner, as the switch's off and Quit's Stop it run it (0.27.0
    /// D2). It takes no argument.
    EventsStop {},
    /// The events service's `judge model status` (E2): the Laya judge's state, bytes and reason codes, read-only. It
    /// takes no argument.
    EventsJudgeModelStatus {},
    /// The events service's `judge kind disable laya` (E2): a tightening, applied at once. It takes no argument: the
    /// kind is Laya's, and no other kind is disabled from the app.
    EventsJudgeKindDisable {},
    /// The events service's `judge kinds list` (0.27.1's Judges section): each kind's state, read-only. It takes no
    /// argument. The judge calls are named outside `EventsJudge…`, which E2's static boundary keeps for Laya's two.
    JudgeKindsList {},
    /// The events service's `judges list`: each judge's id, version, kind, provider and model, content-free and
    /// read-only. It takes no argument.
    JudgesList {},
    /// The events service's `judge kind disable <kind>` for Jev or a local model server: a tightening, applied at once,
    /// as Laya's disable is. The kind is closed; turning one on is the terminal's (`TerminalCommand::JudgeKindEnable`).
    JudgeKindDisable { judge_kind: EndpointJudgeKind },
}

/// The first release of the events service that ships phase E2's Laya calls (DA12): an older one says "Update
/// agent-communications to use this".
pub const LAYA_JUDGE_VERSION: &str = "0.25.0";

/// The first release of the events service with judges (Phase E, CHANGELOG 0.17.0): its `judge kinds list` answers the
/// typesafe and local-endpoint kinds and `judges list` the inventory, where 0.16.0 answered each with Phase E's typed
/// placeholder. An older one says "Update agent-communications to use this" (DA12).
pub const JUDGE_KINDS_VERSION: &str = "0.17.0";

/// How a call's output is read (`runner::parse_output`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Exactly one `{ ok, … }` envelope.
    Envelope,
    /// The events CLI's bare JSON, with its failures on stderr.
    Bare,
    /// `--version`'s one line.
    VersionLine,
}

/// A call as the words a launcher is given, and how to run and read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Words {
    pub product: Product,
    pub words: Vec<String>,
    pub shape: Shape,
    /// Whether the four folder pins follow the words (every call but `--version`).
    pub pins: bool,
    /// Whether `AGENT_COMMS_UPDATE_CHECK=off` is set: every call but doctor and `update --status`.
    pub quiet_updates: bool,
    pub timeout: Duration,
}

const TIMEOUT: Duration = Duration::from_secs(30);
const DOCTOR_TIMEOUT: Duration = Duration::from_secs(90);

fn core(words: &[&str]) -> Words {
    Words {
        product: Product::Core,
        words: words.iter().map(|word| word.to_string()).collect(),
        shape: Shape::Envelope,
        pins: true,
        quiet_updates: true,
        timeout: TIMEOUT,
    }
}

fn events(words: &[&str]) -> Words {
    Words {
        product: Product::EventsDaemon,
        shape: Shape::Bare,
        ..core(words)
    }
}

fn with(mut words: Words, more: impl IntoIterator<Item = String>) -> Words {
    words.words.extend(more);
    words
}

fn conversation(conversation: &Option<ConversationId>) -> Vec<String> {
    conversation
        .iter()
        .flat_map(|id| ["--conversation".to_string(), id.as_str().to_string()])
        .collect()
}

impl Call {
    /// The call's words, its launcher, how its output is read, and how long it may take. `accounts` refuses a product
    /// with no accounts of its own, and `profileInit` a conversation without its account.
    pub fn words(&self) -> Result<Words, AppError> {
        Ok(match self {
            Call::Version { product } => Words {
                product: *product,
                words: vec!["--version".into()],
                shape: Shape::VersionLine,
                pins: false,
                quiet_updates: true,
                timeout: TIMEOUT,
            },
            Call::ApprovalsPending {} => core(&["approvals", "list", "--state", "pending"]),
            Call::ApprovalRevoke { approval_id } => {
                core(&["approvals", "revoke", approval_id.as_str()])
            }
            Call::UpdateStatus {} => Words {
                quiet_updates: false,
                ..core(&["update", "--status"])
            },
            Call::UpdatePause { days } => {
                with(core(&["update", "--pause"]), [days.days().to_string()])
            }
            Call::UpdateResume {} => core(&["update", "--resume"]),
            Call::UpdateLevel { level } => core(&["update", "--level", level.word()]),
            Call::UpdateRollback {} => core(&["update", "--rollback"]),
            Call::UpdateBackgroundJob { on } => {
                core(&["update", "--background-job", if *on { "on" } else { "off" }])
            }
            Call::Doctor { product } => {
                let words: &[&str] = match product {
                    Product::Core | Product::Gmail | Product::EventsDaemon => &["doctor"],
                    Product::Slack | Product::Resend => &["doctor", "--offline"],
                    Product::Whatsapp => &["status"],
                };
                Words {
                    product: *product,
                    shape: if *product == Product::EventsDaemon {
                        Shape::Bare
                    } else {
                        Shape::Envelope
                    },
                    quiet_updates: false,
                    timeout: DOCTOR_TIMEOUT,
                    ..core(words)
                }
            }
            Call::Accounts { product } => {
                let words: &[&str] = match product {
                    Product::Gmail => &["inbox", "list"],
                    Product::Slack => &["workspace", "list"],
                    Product::Resend => &["account", "list"],
                    other => {
                        return Err(AppError::refused(format!(
                            "{} has no accounts to list",
                            other.name()
                        )))
                    }
                };
                Words {
                    product: *product,
                    ..core(words)
                }
            }
            Call::Label {} => core(&["label"]),
            Call::Behaviour {} => core(&["behaviour"]),
            Call::BehaviourAllow {
                account,
                acts,
                conversation: id,
            } => with(
                core(&["behaviour", "allow", account.as_str(), acts.as_str()]),
                conversation(id),
            ),
            Call::BehaviourClear {
                account,
                conversation: id,
            } => with(
                core(&["behaviour", "clear", account.as_str()]),
                conversation(id),
            ),
            Call::ProfileView { account } => core(&["profile", account.as_str()]),
            Call::ProfileInit {
                account,
                conversation: id,
            } => {
                if account.is_none() && id.is_some() {
                    return Err(AppError::refused(
                        "a conversation's profile belongs to an account: name the account too",
                    ));
                }
                with(
                    core(&["profile", "init"]),
                    account
                        .iter()
                        .map(|name| name.as_str().to_string())
                        .chain(conversation(id)),
                )
            }
            Call::StandingList {} => core(&["standing", "list"]),
            Call::StandingRevoke { id } => core(&["standing", "revoke", id.as_str()]),
            Call::StandingOff {} => core(&["standing", "off"]),
            Call::EventsStatus {} => events(&["status"]),
            Call::EventsPause {} => events(&["pause"]),
            Call::EventsResume {} => events(&["resume"]),
            Call::EventsRules {} => events(&["rules", "list"]),
            Call::EventsDeliveries {} => events(&["deliveries", "list"]),
            Call::EventsStop {} => events(&["stop"]),
            Call::EventsJudgeModelStatus { .. } => events(&["judge", "model", "status"]),
            Call::EventsJudgeKindDisable { .. } => events(&["judge", "kind", "disable", "laya"]),
            Call::JudgeKindsList {} => events(&["judge", "kinds", "list"]),
            Call::JudgesList {} => events(&["judges", "list"]),
            Call::JudgeKindDisable { judge_kind } => {
                events(&["judge", "kind", "disable", judge_kind.word()])
            }
        })
    }

    /// Whether the call may come back `APPROVAL_PENDING` with a change the app prepared, to be opened in the terminal
    /// (DA10): the five change shapes, and only those.
    pub fn prepares_change(&self) -> bool {
        matches!(
            self,
            Call::UpdateLevel { .. }
                | Call::UpdateRollback {}
                | Call::UpdateBackgroundJob { on: true }
                | Call::BehaviourAllow { .. }
                | Call::BehaviourClear { .. }
        )
    }

    /// The CLI version the call needs (DA12), when it needs a later one than any the app supports.
    pub fn needs(&self) -> Option<&'static str> {
        match self {
            Call::Behaviour {}
            | Call::BehaviourAllow { .. }
            | Call::BehaviourClear { .. }
            | Call::ProfileView { .. }
            | Call::ProfileInit { .. } => Some("0.22.0"),
            Call::StandingList {} | Call::StandingRevoke { .. } | Call::StandingOff {} => {
                Some("0.23.0")
            }
            Call::UpdateStatus {} => Some("0.24.0"),
            Call::EventsJudgeModelStatus { .. } | Call::EventsJudgeKindDisable { .. } => {
                Some(LAYA_JUDGE_VERSION)
            }
            Call::JudgeKindsList {} | Call::JudgesList {} | Call::JudgeKindDisable { .. } => {
                Some(JUDGE_KINDS_VERSION)
            }
            _ => None,
        }
    }
}

/// The event service itself, as the app starts it (0.27.0 D2): `<data>/launch/events-daemon run` with the pins, and
/// without `--json`, since it prints nothing to read. It is no `Call`: the window cannot ask for it, and `runner::run`
/// would stop it at its timeout. Only `event_service` starts it, detached.
pub fn service_run() -> Words {
    events(&["run"])
}

/// One of every call the allow-list knows, with the JSON the UI sends for it: the rows of the plan's table.
#[cfg(test)]
pub(crate) fn samples() -> Vec<(Call, serde_json::Value)> {
    use serde_json::json;
    let values = [
        json!({ "kind": "version", "product": "core" }),
        json!({ "kind": "version", "product": "events-daemon" }),
        json!({ "kind": "approvalsPending" }),
        json!({ "kind": "approvalRevoke", "approvalId": ID }),
        json!({ "kind": "updateStatus" }),
        json!({ "kind": "updatePause", "days": 1 }),
        json!({ "kind": "updatePause", "days": 7 }),
        json!({ "kind": "updatePause", "days": 14 }),
        json!({ "kind": "updateResume" }),
        json!({ "kind": "updateLevel", "level": "auto" }),
        json!({ "kind": "updateLevel", "level": "every-14-days" }),
        json!({ "kind": "updateLevel", "level": "never" }),
        json!({ "kind": "updateRollback" }),
        json!({ "kind": "updateBackgroundJob", "on": true }),
        json!({ "kind": "updateBackgroundJob", "on": false }),
        json!({ "kind": "doctor", "product": "core" }),
        json!({ "kind": "doctor", "product": "gmail" }),
        json!({ "kind": "doctor", "product": "slack" }),
        json!({ "kind": "doctor", "product": "resend" }),
        json!({ "kind": "doctor", "product": "whatsapp" }),
        json!({ "kind": "doctor", "product": "events-daemon" }),
        json!({ "kind": "accounts", "product": "gmail" }),
        json!({ "kind": "accounts", "product": "slack" }),
        json!({ "kind": "accounts", "product": "resend" }),
        json!({ "kind": "label" }),
        json!({ "kind": "behaviour" }),
        json!({ "kind": "behaviourAllow", "account": "example/slack", "acts": "reply,reaction" }),
        json!({ "kind": "behaviourAllow", "account": "example/gmail", "acts": "none", "conversation": "@example.com" }),
        json!({ "kind": "behaviourClear", "account": "example/slack" }),
        json!({ "kind": "behaviourClear", "account": "example/slack", "conversation": "C0123ABCD" }),
        json!({ "kind": "profileView", "account": "example/gmail-work" }),
        json!({ "kind": "profileInit" }),
        json!({ "kind": "profileInit", "account": "example/gmail", "conversation": "someone@example.com" }),
        json!({ "kind": "standingList" }),
        json!({ "kind": "standingRevoke", "id": ID }),
        json!({ "kind": "standingOff" }),
        json!({ "kind": "eventsStatus" }),
        json!({ "kind": "eventsPause" }),
        json!({ "kind": "eventsResume" }),
        json!({ "kind": "eventsRules" }),
        json!({ "kind": "eventsDeliveries" }),
        json!({ "kind": "eventsStop" }),
        json!({ "kind": "eventsJudgeModelStatus" }),
        json!({ "kind": "eventsJudgeKindDisable" }),
        json!({ "kind": "judgeKindsList" }),
        json!({ "kind": "judgesList" }),
        json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe" }),
        json!({ "kind": "judgeKindDisable", "judgeKind": "local-endpoint" }),
    ];
    values
        .into_iter()
        .map(|value| {
            let call = serde_json::from_value(value.clone())
                .unwrap_or_else(|error| panic!("{value} is a call: {error}"));
            (call, value)
        })
        .collect()
}

/// The events daemon's half of the Laya contract (E2 Task 11): `judge-desktop-contract.test.ts` runs each of these
/// words through the events CLI against the real owner.
#[cfg(test)]
const DESKTOP_CONTRACT: &str = include_str!(
    "../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json"
);

/// The words the daemon's contract names for `call` (`eventsJudgeModelStatus`, `eventsJudgeKindDisable`, or the
/// terminal's `eventsJudgeKindEnable`), and whether it gives them `--json`.
#[cfg(test)]
pub(crate) fn desktop_contract_words(call: &str) -> (Vec<String>, bool) {
    let contract: serde_json::Value =
        serde_json::from_str(DESKTOP_CONTRACT).expect("the daemon's contract");
    let entry = contract["calls"]
        .as_array()
        .expect("its calls")
        .iter()
        .find(|entry| entry["call"] == call)
        .unwrap_or_else(|| panic!("the daemon's contract names {call}"));
    let words = entry["words"]
        .as_array()
        .expect("its words")
        .iter()
        .map(|word| word.as_str().expect("a word").to_string())
        .collect();
    (words, entry["json"] == serde_json::Value::Bool(true))
}

/// The events daemon's half of the Judges section's contract (0.27.1): `judge-desktop-judges-contract.test.ts` runs
/// each of these words through the events CLI against the real owner. Laya's stay in `DESKTOP_CONTRACT`.
#[cfg(test)]
const DESKTOP_JUDGES_CONTRACT: &str = include_str!(
    "../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json"
);

/// The words the daemon's judges contract names for `call` (`judgeKindsList`, `judgesList`, `judgeKindDisable`, or the
/// terminal's `judgeKindEnable`) and, for the last two, `judge_kind`; and whether it gives them `--json`.
#[cfg(test)]
pub(crate) fn desktop_judges_contract_words(
    call: &str,
    judge_kind: Option<&str>,
) -> (Vec<String>, bool) {
    let contract: serde_json::Value =
        serde_json::from_str(DESKTOP_JUDGES_CONTRACT).expect("the daemon's judges contract");
    let entry = contract["calls"]
        .as_array()
        .expect("its calls")
        .iter()
        .find(|entry| entry["call"] == call && entry["judgeKind"].as_str() == judge_kind)
        .unwrap_or_else(|| panic!("the daemon's judges contract names {call} {judge_kind:?}"));
    let words = entry["words"]
        .as_array()
        .expect("its words")
        .iter()
        .map(|word| word.as_str().expect("a word").to_string())
        .collect();
    (words, entry["json"] == serde_json::Value::Bool(true))
}

/// A well-formed approval id, for the tests: `ap_` and 26 of Crockford's letters.
#[cfg(test)]
pub(crate) const ID: &str = "ap_0123456789ABCDEFGHJKMNPQRS";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launchers::Product;
    use serde_json::json;
    use std::time::Duration;

    fn call(value: serde_json::Value) -> Call {
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    /// One row of the plan's table: the call, its product, its words, its shape, whether it takes the pins, whether
    /// it quiets the update check, and its timeout.
    type Row = (
        serde_json::Value,
        Product,
        &'static [&'static str],
        Shape,
        bool,
        bool,
        Duration,
    );

    fn refused(value: serde_json::Value) {
        assert!(
            serde_json::from_value::<Call>(value.clone()).is_err(),
            "{value} was accepted"
        );
    }

    #[test]
    fn every_call_builds_its_documented_words() {
        use Product::*;
        use Shape::*;
        let thirty = Duration::from_secs(30);
        let ninety = Duration::from_secs(90);
        let rows: Vec<Row> = vec![
            (
                json!({"kind":"version","product":"core"}),
                Core,
                &["--version"],
                VersionLine,
                false,
                true,
                thirty,
            ),
            (
                json!({"kind":"version","product":"events-daemon"}),
                EventsDaemon,
                &["--version"],
                VersionLine,
                false,
                true,
                thirty,
            ),
            (
                json!({"kind":"version","product":"whatsapp"}),
                Whatsapp,
                &["--version"],
                VersionLine,
                false,
                true,
                thirty,
            ),
            (
                json!({"kind":"approvalsPending"}),
                Core,
                &["approvals", "list", "--state", "pending"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"approvalRevoke","approvalId":ID}),
                Core,
                &["approvals", "revoke", ID],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateStatus"}),
                Core,
                &["update", "--status"],
                Envelope,
                true,
                false,
                thirty,
            ),
            (
                json!({"kind":"updatePause","days":7}),
                Core,
                &["update", "--pause", "7"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updatePause","days":14}),
                Core,
                &["update", "--pause", "14"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateResume"}),
                Core,
                &["update", "--resume"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateLevel","level":"every-14-days"}),
                Core,
                &["update", "--level", "every-14-days"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateRollback"}),
                Core,
                &["update", "--rollback"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateBackgroundJob","on":true}),
                Core,
                &["update", "--background-job", "on"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"updateBackgroundJob","on":false}),
                Core,
                &["update", "--background-job", "off"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"doctor","product":"core"}),
                Core,
                &["doctor"],
                Envelope,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"doctor","product":"gmail"}),
                Gmail,
                &["doctor"],
                Envelope,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"doctor","product":"slack"}),
                Slack,
                &["doctor", "--offline"],
                Envelope,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"doctor","product":"resend"}),
                Resend,
                &["doctor", "--offline"],
                Envelope,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"doctor","product":"whatsapp"}),
                Whatsapp,
                &["status"],
                Envelope,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"doctor","product":"events-daemon"}),
                EventsDaemon,
                &["doctor"],
                Bare,
                true,
                false,
                ninety,
            ),
            (
                json!({"kind":"accounts","product":"gmail"}),
                Gmail,
                &["inbox", "list"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"accounts","product":"slack"}),
                Slack,
                &["workspace", "list"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"accounts","product":"resend"}),
                Resend,
                &["account", "list"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"label"}),
                Core,
                &["label"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"behaviour"}),
                Core,
                &["behaviour"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"behaviourAllow","account":"example/slack","acts":"reply,reaction"}),
                Core,
                &["behaviour", "allow", "example/slack", "reply,reaction"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"behaviourAllow","account":"example/gmail","acts":"none","conversation":"@example.com"}),
                Core,
                &[
                    "behaviour",
                    "allow",
                    "example/gmail",
                    "none",
                    "--conversation",
                    "@example.com",
                ],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"behaviourClear","account":"example/slack"}),
                Core,
                &["behaviour", "clear", "example/slack"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"behaviourClear","account":"example/slack","conversation":"C0123ABCD"}),
                Core,
                &[
                    "behaviour",
                    "clear",
                    "example/slack",
                    "--conversation",
                    "C0123ABCD",
                ],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"profileView","account":"work"}),
                Core,
                &["profile", "work"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"profileInit"}),
                Core,
                &["profile", "init"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"profileInit","account":"example/gmail"}),
                Core,
                &["profile", "init", "example/gmail"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"profileInit","account":"example/gmail","conversation":"someone@example.com"}),
                Core,
                &[
                    "profile",
                    "init",
                    "example/gmail",
                    "--conversation",
                    "someone@example.com",
                ],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"standingList"}),
                Core,
                &["standing", "list"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"standingRevoke","id":ID}),
                Core,
                &["standing", "revoke", ID],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"standingOff"}),
                Core,
                &["standing", "off"],
                Envelope,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsStatus"}),
                EventsDaemon,
                &["status"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsPause"}),
                EventsDaemon,
                &["pause"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsResume"}),
                EventsDaemon,
                &["resume"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsRules"}),
                EventsDaemon,
                &["rules", "list"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsDeliveries"}),
                EventsDaemon,
                &["deliveries", "list"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsStop"}),
                EventsDaemon,
                &["stop"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsJudgeModelStatus"}),
                EventsDaemon,
                &["judge", "model", "status"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"eventsJudgeKindDisable"}),
                EventsDaemon,
                &["judge", "kind", "disable", "laya"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"judgeKindsList"}),
                EventsDaemon,
                &["judge", "kinds", "list"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"judgesList"}),
                EventsDaemon,
                &["judges", "list"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"judgeKindDisable","judgeKind":"typesafe"}),
                EventsDaemon,
                &["judge", "kind", "disable", "typesafe"],
                Bare,
                true,
                true,
                thirty,
            ),
            (
                json!({"kind":"judgeKindDisable","judgeKind":"local-endpoint"}),
                EventsDaemon,
                &["judge", "kind", "disable", "local-endpoint"],
                Bare,
                true,
                true,
                thirty,
            ),
        ];
        for (value, product, expected, shape, pins, quiet, timeout) in rows {
            let words = call(value.clone())
                .words()
                .unwrap_or_else(|error| panic!("{value}: {error}"));
            assert_eq!(words.product, product, "{value}");
            assert_eq!(words.words, expected, "{value}");
            assert_eq!(words.shape, shape, "{value}");
            assert_eq!(words.pins, pins, "{value}");
            assert_eq!(words.quiet_updates, quiet, "{value}");
            assert_eq!(words.timeout, timeout, "{value}");
        }
        // Every sample builds, and every kind has a row above.
        for (call, value) in samples() {
            let refused_product = matches!(call, Call::Accounts { product } if !matches!(product, Gmail | Slack | Resend));
            assert_eq!(call.words().is_ok(), !refused_product, "{value}");
        }
        // A call goes back to the JSON it came from, so the UI and Rust read one shape.
        for (call, value) in samples() {
            assert_eq!(serde_json::to_value(&call).expect("json"), value);
        }
    }

    #[test]
    fn no_call_carries_approval_and_version_takes_no_pins() {
        for (call, value) in samples() {
            let Ok(words) = call.words() else { continue };
            for word in &words.words {
                assert!(
                    !word.starts_with("--approval") && word != "approve" && word != "--yes",
                    "{value} carries {word}"
                );
            }
            if matches!(call, Call::Version { .. }) {
                assert_eq!(words.words, ["--version"]);
                assert!(!words.pins);
                assert_eq!(words.shape, Shape::VersionLine);
            }
        }
    }

    #[test]
    fn refuses_every_argument_that_does_not_match() {
        // Approval ids: the grammar's letters only, exactly 26 of them, after `ap_`.
        for bad in [
            "",
            "ap_",
            "ap_0123456789ABCDEFGHJKMNPQR",
            "ap_0123456789ABCDEFGHJKMNPQRSTV",
            "ap_0123456789ABCDEFGHIKMNPQRS",
            "ap_0123456789abcdefghjkmnpqrs",
            "AP_0123456789ABCDEFGHJKMNPQRS",
            "-ap_0123456789ABCDEFGHJKMNPQRS",
            "ap_0123456789ABCDEFGHJKMNPQRS\n",
            "ap_0123456789ABCDEFGHJKMNPQRS --json",
        ] {
            refused(json!({ "kind": "approvalRevoke", "approvalId": bad }));
            refused(json!({ "kind": "standingRevoke", "id": bad }));
        }
        refused(json!({ "kind": "approvalRevoke", "approvalId": 7 }));
        refused(json!({ "kind": "approvalRevoke" }));
        // Account names: an organisation/platform name, or a version-1 alias; nothing else.
        for bad in [
            "",
            "-x",
            "--json",
            "Example/gmail",
            "example/gmail/x",
            "example//gmail",
            "con/gmail",
            "lpt1/slack",
            "example/gmail-",
            "../gmail",
            "example/gmail\u{0007}",
            "example/\u{202e}gmail",
            "a b",
            "x".repeat(33).as_str(),
        ] {
            refused(json!({ "kind": "behaviourAllow", "account": bad, "acts": "reply" }));
            refused(json!({ "kind": "profileView", "account": bad }));
        }
        // Conversations: a Slack id or an address, as core reads them.
        for bad in [
            "",
            "-C0123",
            "c0123ABCD",
            "C0",
            "someone@",
            "some one@example.com",
            "a@b@c",
            "<someone@example.com>",
            "someone@example.com\r\nBcc: x@example.com",
            "@",
        ] {
            refused(
                json!({ "kind": "behaviourClear", "account": "example/slack", "conversation": bad }),
            );
        }
        let long = format!("{}@example.com", "a".repeat(320));
        refused(
            json!({ "kind": "behaviourClear", "account": "example/gmail", "conversation": long }),
        );
        // Acts: `none`, or a list of known acts without repeats.
        for bad in [
            "",
            "none,reply",
            "reply,reply",
            "reply,",
            ",reply",
            "reply, reaction",
            "Reply",
            "approve",
            "all",
            "-reply",
        ] {
            refused(json!({ "kind": "behaviourAllow", "account": "example/slack", "acts": bad }));
        }
        // Days and levels: only what the CLI offers.
        for days in [
            json!(0),
            json!(2),
            json!(30),
            json!(-7),
            json!(7.5),
            json!("7"),
        ] {
            refused(json!({ "kind": "updatePause", "days": days }));
        }
        for level in ["sometimes", "Auto", "every-7-days", ""] {
            refused(json!({ "kind": "updateLevel", "level": level }));
        }
        refused(json!({ "kind": "updateBackgroundJob", "on": "on" }));
        // An unknown kind, an unknown field, a missing kind: nothing the allow-list did not name.
        refused(json!({ "kind": "send" }));
        refused(json!({ "kind": "approve", "approvalId": ID }));
        refused(json!({ "kind": "approvalsPending", "state": "approved" }));
        refused(json!({ "kind": "label", "args": ["word", "twin"] }));
        refused(json!({ "kind": "updateRollback", "approval": ID }));
        refused(json!({ "kind": "doctor", "product": "core", "offline": false }));
        refused(json!({ "kind": "doctor", "product": "agentcomms" }));
        refused(json!({ "kind": "version", "product": "npm" }));
        refused(json!({ "approvalId": ID }));
        // A conversation needs the account it belongs to.
        assert_eq!(
            call(json!({ "kind": "profileInit", "conversation": "C0123ABCD" }))
                .words()
                .expect_err("a conversation alone")
                .code,
            "APP_REFUSED"
        );
    }

    #[test]
    fn doctor_and_accounts_refuse_unlisted_products() {
        for product in ["core", "whatsapp", "events-daemon"] {
            let refusal = call(json!({ "kind": "accounts", "product": product }))
                .words()
                .expect_err("not an accounts product");
            assert_eq!(refusal.code, "APP_REFUSED");
        }
        for product in ["gmail", "slack", "resend"] {
            assert!(call(json!({ "kind": "accounts", "product": product }))
                .words()
                .is_ok());
        }
        // Doctor lists every product; any other word is not a product at all.
        for product in Product::ALL {
            assert!(Call::Doctor { product }.words().is_ok());
        }
        refused(json!({ "kind": "doctor", "product": "gmail-mcp" }));
        refused(json!({ "kind": "accounts", "product": "whatsapp-web" }));
    }

    #[test]
    fn only_the_five_change_shapes_prepare() {
        let preparing: Vec<serde_json::Value> = samples()
            .into_iter()
            .filter(|(call, _)| call.prepares_change())
            .map(|(_, value)| value)
            .collect();
        assert_eq!(
            preparing,
            vec![
                json!({ "kind": "updateLevel", "level": "auto" }),
                json!({ "kind": "updateLevel", "level": "every-14-days" }),
                json!({ "kind": "updateLevel", "level": "never" }),
                json!({ "kind": "updateRollback" }),
                json!({ "kind": "updateBackgroundJob", "on": true }),
                json!({ "kind": "behaviourAllow", "account": "example/slack", "acts": "reply,reaction" }),
                json!({ "kind": "behaviourAllow", "account": "example/gmail", "acts": "none", "conversation": "@example.com" }),
                json!({ "kind": "behaviourClear", "account": "example/slack" }),
                json!({ "kind": "behaviourClear", "account": "example/slack", "conversation": "C0123ABCD" }),
            ]
        );
    }

    #[test]
    fn laya_calls_build_exactly_the_launcher_words_json_and_pins() {
        let folders = crate::paths::Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        };
        let launcher = "/home/example/.local/share/agent-communications/launch/events-daemon";
        let program = crate::launchers::Program {
            program: launcher.into(),
            leading: vec![],
        };
        for (value, name, words) in [
            (
                json!({ "kind": "eventsJudgeModelStatus" }),
                "eventsJudgeModelStatus",
                &["judge", "model", "status"][..],
            ),
            (
                json!({ "kind": "eventsJudgeKindDisable" }),
                "eventsJudgeKindDisable",
                &["judge", "kind", "disable", "laya"][..],
            ),
        ] {
            let built = call(value.clone()).words().expect("words");
            assert_eq!(built.product, Product::EventsDaemon, "{value}");
            assert_eq!(built.words, words, "{value}");
            assert_eq!(built.shape, Shape::Bare, "{value}");
            assert!(built.pins, "{value}");
            assert_eq!(built.timeout, Duration::from_secs(30), "{value}");
            // The whole line: the launcher, the words, `--json`, then the four pins, and nothing else.
            let mut expected = vec![launcher.to_string()];
            expected.extend(words.iter().map(|word| word.to_string()));
            expected.push("--json".into());
            expected.extend(folders.pins());
            assert_eq!(
                crate::runner::argv(&built, &program, &folders, true),
                expected
            );
            // The words are the ones the events daemon's contract runs through its CLI.
            assert_eq!(
                desktop_contract_words(name),
                (built.words.clone(), true),
                "{name}"
            );
        }
    }

    #[test]
    fn events_stop_takes_no_argument_and_the_service_runs_only_from_rust() {
        let stop = call(json!({ "kind": "eventsStop" }))
            .words()
            .expect("words");
        assert_eq!(stop.product, Product::EventsDaemon);
        assert_eq!(stop.words, ["stop"]);
        assert_eq!(stop.shape, Shape::Bare);
        assert!(stop.pins);
        assert!(!call(json!({ "kind": "eventsStop" })).prepares_change());
        assert_eq!(call(json!({ "kind": "eventsStop" })).needs(), None);
        for bad in [
            json!({ "kind": "eventsStop", "force": true }),
            json!({ "kind": "eventsStop", "pid": 4242 }),
            json!({ "kind": "eventsStop", "args": ["--signal"] }),
            // The service itself is started by the app alone: the window has no call for it.
            json!({ "kind": "eventsRun" }),
            json!({ "kind": "run" }),
        ] {
            refused(bad);
        }
        // `run`: the launcher, `run`, then the four pins, without `--json`; the same pins and launcher as every call.
        let run = service_run();
        assert_eq!(run.product, Product::EventsDaemon);
        assert_eq!(run.words, ["run"]);
        assert!(run.pins);
        assert!(run.quiet_updates);
        let folders = crate::paths::Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        };
        let launcher = "/home/example/.local/share/agent-communications/launch/events-daemon";
        let program = crate::launchers::Program {
            program: launcher.into(),
            leading: vec![],
        };
        let mut expected = vec![launcher.to_string(), "run".into()];
        expected.extend(folders.pins());
        assert_eq!(
            crate::runner::argv(&run, &program, &folders, false),
            expected
        );
    }

    #[test]
    fn laya_calls_take_no_argument_and_refuse_any_other_kind_or_word() {
        for bad in [
            json!({ "kind": "eventsJudgeKindDisable", "judge": "typesafe" }),
            json!({ "kind": "eventsJudgeKindDisable", "judgeKind": "laya" }),
            json!({ "kind": "eventsJudgeKindDisable", "kindName": "local-endpoint" }),
            json!({ "kind": "eventsJudgeKindDisable", "args": ["laya"] }),
            json!({ "kind": "eventsJudgeKindDisable", "words": ["--force"] }),
            json!({ "kind": "eventsJudgeKindDisable", "approval": ID }),
            json!({ "kind": "eventsJudgeModelStatus", "product": "core" }),
            json!({ "kind": "eventsJudgeModelStatus", "manifestId": "laya-en-onnx-v1" }),
            json!({ "kind": "eventsJudgeModelStatus", "json": false }),
            // Enabling is the terminal's, and removing the model files the CLI's and MCP's: neither is a call.
            json!({ "kind": "eventsJudgeKindEnable" }),
            json!({ "kind": "eventsJudgeModelRemove" }),
        ] {
            refused(bad);
        }
    }

    #[test]
    fn laya_calls_prepare_no_change() {
        for value in [
            json!({ "kind": "eventsJudgeModelStatus" }),
            json!({ "kind": "eventsJudgeKindDisable" }),
        ] {
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
    }

    #[test]
    fn laya_calls_need_the_release_that_ships_e2() {
        for value in [
            json!({ "kind": "eventsJudgeModelStatus" }),
            json!({ "kind": "eventsJudgeKindDisable" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.25.0"), "{value}");
        }
        assert!(!crate::version::at_least("0.24.0", LAYA_JUDGE_VERSION));
        assert!(crate::version::at_least("0.25.0", LAYA_JUDGE_VERSION));
    }

    #[test]
    fn each_gated_call_names_the_version_it_needs() {
        assert_eq!(Call::UpdateStatus {}.needs(), Some("0.24.0"));
        assert_eq!(Call::Behaviour {}.needs(), Some("0.22.0"));
        assert_eq!(Call::StandingOff {}.needs(), Some("0.23.0"));
        assert_eq!(Call::Label {}.needs(), None);
        assert_eq!(Call::ApprovalsPending {}.needs(), None);
    }

    /// The Judges section's calls (0.27.1): the events service's two reads, and the disable of a kind whose judges
    /// name an endpoint. Each is the launcher, its words, `--json` and the four pins, and its words are the ones the
    /// events daemon's judges contract runs through its CLI.
    #[test]
    fn judge_calls_build_exactly_the_launcher_words_json_and_pins() {
        let folders = crate::paths::Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        };
        let launcher = "/home/example/.local/share/agent-communications/launch/events-daemon";
        let program = crate::launchers::Program {
            program: launcher.into(),
            leading: vec![],
        };
        for (value, name, kind, words) in [
            (
                json!({ "kind": "judgeKindsList" }),
                "judgeKindsList",
                None,
                &["judge", "kinds", "list"][..],
            ),
            (
                json!({ "kind": "judgesList" }),
                "judgesList",
                None,
                &["judges", "list"][..],
            ),
            (
                json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe" }),
                "judgeKindDisable",
                Some("typesafe"),
                &["judge", "kind", "disable", "typesafe"][..],
            ),
            (
                json!({ "kind": "judgeKindDisable", "judgeKind": "local-endpoint" }),
                "judgeKindDisable",
                Some("local-endpoint"),
                &["judge", "kind", "disable", "local-endpoint"][..],
            ),
        ] {
            let built = call(value.clone()).words().expect("words");
            assert_eq!(built.product, Product::EventsDaemon, "{value}");
            assert_eq!(built.words, words, "{value}");
            assert_eq!(built.shape, Shape::Bare, "{value}");
            assert!(built.pins, "{value}");
            assert!(built.quiet_updates, "{value}");
            assert_eq!(built.timeout, Duration::from_secs(30), "{value}");
            let mut expected = vec![launcher.to_string()];
            expected.extend(words.iter().map(|word| word.to_string()));
            expected.push("--json".into());
            expected.extend(folders.pins());
            assert_eq!(
                crate::runner::argv(&built, &program, &folders, true),
                expected
            );
            assert_eq!(
                desktop_judges_contract_words(name, kind),
                (built.words.clone(), true),
                "{value}"
            );
            // A judge call never names Laya, which keeps its own zero-argument calls, and never approves.
            assert!(!built.words.iter().any(|word| word == "laya"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
    }

    /// The kind is a closed enum: TypeSafe's hosted Jev or a local model server, by its exact word. A free string,
    /// Laya, another spelling, a missing kind and any other field are refused before a word is built.
    #[test]
    fn judge_calls_refuse_a_free_kind_laya_and_any_other_field() {
        for kind in [
            json!("laya"),
            json!("Typesafe"),
            json!("TYPESAFE"),
            json!("typesafe "),
            json!(" typesafe"),
            json!("local_endpoint"),
            json!("localEndpoint"),
            json!("local"),
            json!("jev"),
            json!(""),
            json!("--json"),
            json!("typesafe --approval ap_0123456789ABCDEFGHJKMNPQRS"),
            json!("typesafe\nlaya"),
            json!(7),
            json!(null),
            json!(true),
            json!(["typesafe"]),
            json!({ "kind": "typesafe" }),
        ] {
            refused(json!({ "kind": "judgeKindDisable", "judgeKind": kind }));
        }
        for bad in [
            json!({ "kind": "judgeKindDisable" }),
            json!({ "kind": "judgeKindDisable", "kindName": "typesafe" }),
            json!({ "kind": "judgeKindDisable", "judge": "typesafe" }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe", "approval": ID }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe", "approvalId": ID }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe", "words": ["--force"] }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe", "json": false }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe", "judgeKinds": ["laya"] }),
            json!({ "kind": "judgeKindsList", "judgeKind": "typesafe" }),
            json!({ "kind": "judgeKindsList", "args": ["--all"] }),
            json!({ "kind": "judgesList", "judgeId": "jev" }),
            json!({ "kind": "judgesList", "judgeKind": "typesafe" }),
            json!({ "kind": "judgesList", "product": "core" }),
            // Turning a kind on is the terminal's, and a judge, its key and a model are the CLI's and MCP's.
            json!({ "kind": "judgeKindEnable", "judgeKind": "typesafe" }),
            json!({ "kind": "judgeKindEnable", "judgeKind": "local-endpoint" }),
            json!({ "kind": "judgeAdd" }),
            json!({ "kind": "judgeRemove", "judgeId": "jev" }),
            json!({ "kind": "judgeKeySet", "judgeId": "jev" }),
            json!({ "kind": "judgeTest", "judgeId": "jev" }),
        ] {
            refused(bad);
        }
    }

    /// Laya's two calls stay as Task 11 made them beside the judge calls: no argument, Laya's words, and no kind of
    /// another's. The judge calls are new variants, never a looser Laya call.
    #[test]
    fn laya_calls_are_unchanged_beside_the_judge_calls() {
        assert_eq!(
            call(json!({ "kind": "eventsJudgeKindDisable" }))
                .words()
                .expect("words")
                .words,
            ["judge", "kind", "disable", "laya"]
        );
        assert_eq!(
            call(json!({ "kind": "eventsJudgeModelStatus" }))
                .words()
                .expect("words")
                .words,
            ["judge", "model", "status"]
        );
        for kind in ["typesafe", "local-endpoint", "laya"] {
            refused(json!({ "kind": "eventsJudgeKindDisable", "judgeKind": kind }));
            refused(json!({ "kind": "eventsJudgeModelStatus", "judgeKind": kind }));
        }
        // Built from the webview's JSON, never as a Rust literal, so this crate still builds when E2's mutants give
        // Laya's disable a field (`e2-t11-rust-disable-takes-a-kind`).
        assert_eq!(
            serde_json::to_value(call(json!({ "kind": "eventsJudgeKindDisable" }))).expect("json"),
            json!({ "kind": "eventsJudgeKindDisable" })
        );
        assert_eq!(
            serde_json::to_value(Call::JudgeKindDisable {
                judge_kind: EndpointJudgeKind::LocalEndpoint
            })
            .expect("json"),
            json!({ "kind": "judgeKindDisable", "judgeKind": "local-endpoint" })
        );
    }

    /// The judge calls need the first events service with judges (Phase E, 0.17.0): before it, `judge kinds list`
    /// and `judges list` answered only Phase E's typed placeholder. Laya's still need 0.25.0.
    #[test]
    fn judge_calls_need_the_release_that_ships_judges() {
        for value in [
            json!({ "kind": "judgeKindsList" }),
            json!({ "kind": "judgesList" }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe" }),
            json!({ "kind": "judgeKindDisable", "judgeKind": "local-endpoint" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.17.0"), "{value}");
        }
        assert_eq!(JUDGE_KINDS_VERSION, "0.17.0");
        assert!(!crate::version::at_least("0.16.0", JUDGE_KINDS_VERSION));
        assert!(crate::version::at_least("0.17.0", JUDGE_KINDS_VERSION));
        assert!(crate::version::at_least("0.27.1", JUDGE_KINDS_VERSION));
        assert_eq!(
            call(json!({ "kind": "eventsJudgeKindDisable" })).needs(),
            Some(LAYA_JUDGE_VERSION)
        );
    }

    #[test]
    fn endpoint_judge_kinds_are_exactly_typesafe_and_local_endpoint() {
        assert_eq!(EndpointJudgeKind::Typesafe.word(), "typesafe");
        assert_eq!(EndpointJudgeKind::LocalEndpoint.word(), "local-endpoint");
        for kind in EndpointJudgeKind::ALL {
            assert_eq!(
                serde_json::to_value(kind).expect("json"),
                json!(kind.word())
            );
            assert_eq!(
                serde_json::from_value::<EndpointJudgeKind>(json!(kind.word())).expect("a kind"),
                kind
            );
        }
        assert!(serde_json::from_value::<EndpointJudgeKind>(json!("laya")).is_err());
    }
}
