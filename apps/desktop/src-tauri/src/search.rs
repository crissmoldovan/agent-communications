//! Search on this machine (0.35.0, design 2026-10-26-local-search §8): core's `search …`, the person's own commands,
//! in the app. What each person asked, found by words and by meaning, from what Agent Comms already had in
//! hand; their people; and the settings. None of it is an MCP tool (S13): only the person reads what Search keeps, at a
//! terminal or here.
//!
//! - **Reads:** `status` (content-free), `query`, `people`, `person` and `show`. A search's words are free text, passed
//!   as one word after `--`, so no option is read past them however they start (`runner::argv` puts `--json` and the
//!   pins before it).
//! - **Upkeep:** `index` and `rebuild`, each for a budget of seconds the call's timeout outlasts.
//! - **The person's own data:** `link`, `unlink` and `label`, which core applies at once.
//! - **Loosenings:** `on`, `accounts add` and `model set` are prepared without an approval, and core answers with the
//!   preview; the person approves it in the app, and the same words go again with `--app-approval <id>` (the call's
//!   `appApproval`), only for the approval the app prepared for that very change (`connections::run_app_approval`),
//!   once. Where nothing attests the app, the prepared change opens in Terminal instead (`TerminalCommand::Change`).
//! - **Tightenings:** `off`, `accounts remove`, `model none` and `delete --all --confirm` apply at once, and never carry
//!   the app's approval.
//!
//! Every value is closed or checked here before a word is built (`grammar`): a person's id, a handle, the model server's
//! address on this machine, one of the reviewed models, Gmail or Slack, a direction, and numbers in core's ranges.

use crate::allowlist::{AccountName, ApprovalId, Call, EpochMs, Shape, Words};
use crate::grammar;
use crate::ipc::AppError;
use crate::launchers::Product;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The first core with Search on this machine (0.35.0): an older one says "Needs 0.35.0 or later" (DA12).
pub const SEARCH_VERSION: &str = "0.35.0";

macro_rules! search_word {
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

search_word!(
    /// A person's id: `p_` and 26 of Crockford's letters, as `search people` lists them.
    PersonId,
    grammar::person_id,
    "a person's id"
);
search_word!(
    /// A handle: `email:<address>` or `slack:<team>/<user>`, as `search people` lists them.
    SearchHandle,
    grammar::search_handle,
    "a handle"
);
search_word!(
    /// A search's words: 1 to 500 characters, with no control, line break, bidi or invisible character.
    SearchText,
    grammar::search_query,
    "words to search for"
);
search_word!(
    /// The name a person gives someone: 1 to 80 characters, as `search label` takes it.
    PersonLabel,
    grammar::person_label,
    "a name for a person"
);
search_word!(
    /// Search's local model server: `http://127.0.0.1:<port>` or `http://[::1]:<port>`.
    ModelAddress,
    grammar::search_model_address,
    "a model server's address on this machine: http://127.0.0.1:<port> or http://[::1]:<port>"
);

/// A model of the reviewed list (S9), by the name Ollama lists it under (`search/models.ts`). Closed: a model off the
/// list, or a cloud one, is never named.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SearchModel {
    #[serde(rename = "qwen3-embedding:0.6b")]
    Qwen,
    #[serde(rename = "embeddinggemma:latest")]
    Gemma,
    #[serde(rename = "bge-m3:latest")]
    Bge,
}

impl SearchModel {
    pub fn word(self) -> &'static str {
        match self {
            SearchModel::Qwen => "qwen3-embedding:0.6b",
            SearchModel::Gemma => "embeddinggemma:latest",
            SearchModel::Bge => "bge-m3:latest",
        }
    }
}

/// The channels Search keeps (S2): Gmail and Slack. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchChannel {
    Gmail,
    Slack,
}

impl SearchChannel {
    pub fn word(self) -> &'static str {
        match self {
            SearchChannel::Gmail => "gmail",
            SearchChannel::Slack => "slack",
        }
    }
}

/// What a search looks through: what people asked (`in`), what was sent (`out`), or both. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchDirection {
    In,
    Out,
    Any,
}

impl SearchDirection {
    pub fn word(self) -> &'static str {
        match self {
            SearchDirection::In => "in",
            SearchDirection::Out => "out",
            SearchDirection::Any => "any",
        }
    }
}

/// The most accounts one search names.
pub const SEARCH_ACCOUNTS_MAX: usize = 20;

/// The accounts a search is narrowed to: 1 to `SEARCH_ACCOUNTS_MAX` names, none twice, each its own `--account`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<AccountName>", into = "Vec<AccountName>")]
pub struct SearchAccounts(Vec<AccountName>);

impl TryFrom<Vec<AccountName>> for SearchAccounts {
    type Error = AppError;

    fn try_from(names: Vec<AccountName>) -> Result<Self, Self::Error> {
        let repeated = names
            .iter()
            .enumerate()
            .any(|(index, name)| names[..index].contains(name));
        if names.is_empty() || names.len() > SEARCH_ACCOUNTS_MAX || repeated {
            Err(AppError::refused(
                "a search names 1 to 20 accounts, each once",
            ))
        } else {
            Ok(SearchAccounts(names))
        }
    }
}

impl From<SearchAccounts> for Vec<AccountName> {
    fn from(names: SearchAccounts) -> Vec<AccountName> {
        names.0
    }
}

macro_rules! bounded {
    ($(#[$meta:meta])* $name:ident, $min:expr, $max:expr, $what:literal) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
        #[serde(try_from = "u64", into = "u64")]
        pub struct $name(u64);

        impl TryFrom<u64> for $name {
            type Error = AppError;

            fn try_from(value: u64) -> Result<Self, Self::Error> {
                if ($min..=$max).contains(&value) {
                    Ok($name(value))
                } else {
                    Err(AppError::refused($what))
                }
            }
        }

        impl From<$name> for u64 {
            fn from(value: $name) -> u64 {
                value.0
            }
        }
    };
}

bounded!(
    /// How many hits one search shows: 1 to 50, core's `MAX_SEARCH_LIMIT`.
    QueryLimit,
    1,
    50,
    "a search shows 1 to 50 messages"
);
bounded!(
    /// How many of a person's messages one read shows: 1 to 200.
    PersonLimit,
    1,
    200,
    "a person's messages are read 1 to 200 at a time"
);
bounded!(
    /// How long one index run may make vectors, in seconds: 0 to 120 from the app (core takes up to 600).
    IndexBudget,
    0,
    120,
    "an index run lasts 0 to 120 seconds"
);

/// A read's timeout: status asks the model server for its list, and the indexer may hold the lock a moment.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// A search indexes for up to two seconds, then asks the local model for the question's vector, which may load it.
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
/// Delete everything waits up to 15 seconds for a run to stop, then removes the folder and the key.
const DELETE_TIMEOUT: Duration = Duration::from_secs(60);
/// What an index run is given beyond its budget: taking the inbox, pruning, and the wait for the lock.
const INDEX_MARGIN: u64 = 30;
/// Core's own budget when none is given.
const DEFAULT_BUDGET: u64 = 30;

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

fn option(words: &mut Vec<String>, flag: &str, value: Option<String>) {
    if let Some(value) = value {
        words.extend([flag.to_string(), value]);
    }
}

fn ms(value: &Option<EpochMs>) -> Option<String> {
    value.map(|ms| u64::from(ms).to_string())
}

fn with_app_approval(mut words: Vec<String>, app_approval: &Option<ApprovalId>) -> Vec<String> {
    if let Some(id) = app_approval {
        words.extend(["--app-approval".to_string(), id.as_str().to_string()]);
    }
    words
}

fn index_words(sub: &str, budget: &Option<IndexBudget>) -> Words {
    let mut words = literal(&["search", sub]);
    option(
        &mut words,
        "--budget",
        budget.map(|seconds| u64::from(seconds).to_string()),
    );
    let seconds = budget.map(u64::from).unwrap_or(DEFAULT_BUDGET);
    core(words, Duration::from_secs(seconds + INDEX_MARGIN))
}

impl Call {
    /// Whether this is one of Search's calls.
    pub fn is_search(&self) -> bool {
        matches!(
            self,
            Call::SearchStatus {}
                | Call::SearchQuery { .. }
                | Call::SearchPeople { .. }
                | Call::SearchPerson { .. }
                | Call::SearchShow { .. }
                | Call::SearchIndex { .. }
                | Call::SearchRebuild { .. }
                | Call::SearchLink { .. }
                | Call::SearchUnlink { .. }
                | Call::SearchLabel { .. }
                | Call::SearchOn { .. }
                | Call::SearchOff {}
                | Call::SearchAccountsAdd { .. }
                | Call::SearchAccountsRemove { .. }
                | Call::SearchModelSet { .. }
                | Call::SearchModelNone {}
                | Call::SearchDeleteAll {}
        )
    }

    /// A Search call's words: core's `search …`, its timeout, and nothing else. Any other call is refused here.
    pub fn search_words(&self) -> Result<Words, AppError> {
        Ok(match self {
            Call::SearchStatus {} => core(literal(&["search", "status"]), READ_TIMEOUT),
            Call::SearchQuery {
                text,
                person,
                accounts,
                channel,
                since,
                until,
                direction,
                limit,
            } => {
                if let (Some(since), Some(until)) = (since, until) {
                    if u64::from(*until) <= u64::from(*since) {
                        return Err(AppError::refused("a search's window ends after it starts"));
                    }
                }
                let mut words = literal(&["search", "query"]);
                option(
                    &mut words,
                    "--person",
                    person.as_ref().map(|id| id.as_str().to_string()),
                );
                for account in accounts.iter().flat_map(|names| names.0.iter()) {
                    words.extend(["--account".to_string(), account.as_str().to_string()]);
                }
                option(
                    &mut words,
                    "--channel",
                    channel.map(|channel| channel.word().to_string()),
                );
                option(&mut words, "--since", ms(since));
                option(&mut words, "--until", ms(until));
                option(
                    &mut words,
                    "--direction",
                    direction.map(|direction| direction.word().to_string()),
                );
                option(
                    &mut words,
                    "--limit",
                    limit.map(|limit| u64::from(limit).to_string()),
                );
                // The words last, after `--`: no option is read past it, so words that start with `-` stay words.
                words.extend(["--".to_string(), text.as_str().to_string()]);
                core(words, QUERY_TIMEOUT)
            }
            Call::SearchPeople { since } => {
                let mut words = literal(&["search", "people"]);
                option(&mut words, "--since", ms(since));
                core(words, READ_TIMEOUT)
            }
            Call::SearchPerson {
                person_id,
                since,
                limit,
            } => {
                let mut words = literal(&["search", "person", person_id.as_str()]);
                option(&mut words, "--since", ms(since));
                option(
                    &mut words,
                    "--limit",
                    limit.map(|limit| u64::from(limit).to_string()),
                );
                core(words, READ_TIMEOUT)
            }
            Call::SearchShow { source_id } => core(
                literal(&["search", "show", source_id.as_str()]),
                READ_TIMEOUT,
            ),
            Call::SearchIndex { budget } => index_words("index", budget),
            Call::SearchRebuild { budget } => index_words("rebuild", budget),
            Call::SearchLink {
                person_id,
                other_id,
            } => {
                if person_id == other_id {
                    return Err(AppError::refused(
                        "a person is already the same person as themselves",
                    ));
                }
                core(
                    literal(&["search", "link", person_id.as_str(), other_id.as_str()]),
                    READ_TIMEOUT,
                )
            }
            Call::SearchUnlink { handle } => core(
                literal(&["search", "unlink", handle.as_str()]),
                READ_TIMEOUT,
            ),
            Call::SearchLabel { person_id, label } => core(
                literal(&["search", "label", person_id.as_str(), "--", label.as_str()]),
                READ_TIMEOUT,
            ),
            Call::SearchOn { app_approval } => core(
                with_app_approval(literal(&["search", "on"]), app_approval),
                READ_TIMEOUT,
            ),
            Call::SearchOff {} => core(literal(&["search", "off"]), READ_TIMEOUT),
            Call::SearchAccountsAdd {
                account,
                app_approval,
            } => core(
                with_app_approval(
                    literal(&["search", "accounts", "add", account.as_str()]),
                    app_approval,
                ),
                READ_TIMEOUT,
            ),
            Call::SearchAccountsRemove { account } => core(
                literal(&["search", "accounts", "remove", account.as_str()]),
                READ_TIMEOUT,
            ),
            Call::SearchModelSet {
                address,
                model,
                app_approval,
            } => core(
                with_app_approval(
                    literal(&["search", "model", "set", address.as_str(), model.word()]),
                    app_approval,
                ),
                READ_TIMEOUT,
            ),
            Call::SearchModelNone {} => core(literal(&["search", "model", "none"]), READ_TIMEOUT),
            Call::SearchDeleteAll {} => core(
                literal(&["search", "delete", "--all", "--confirm"]),
                DELETE_TIMEOUT,
            ),
            _ => return Err(AppError::refused("that is not one of Search's calls")),
        })
    }

    /// Whether this Search call is a loosening the app prepares, and core answers with its preview: `on`, an account
    /// added, a model set — each without the app's approval.
    pub fn prepares_search_change(&self) -> bool {
        matches!(
            self,
            Call::SearchOn { app_approval: None }
                | Call::SearchAccountsAdd {
                    app_approval: None,
                    ..
                }
                | Call::SearchModelSet {
                    app_approval: None,
                    ..
                }
        )
    }

    /// A Search loosening the person approved in the app, and the change it answers: the same call without its
    /// `appApproval`, which is what the app prepared and `terminal::Prepared` recorded. None for every other call.
    pub fn answers_search_approval(&self) -> Option<(&ApprovalId, Call)> {
        match self {
            Call::SearchOn {
                app_approval: Some(id),
            } => Some((id, Call::SearchOn { app_approval: None })),
            Call::SearchAccountsAdd {
                account,
                app_approval: Some(id),
            } => Some((
                id,
                Call::SearchAccountsAdd {
                    account: account.clone(),
                    app_approval: None,
                },
            )),
            Call::SearchModelSet {
                address,
                model,
                app_approval: Some(id),
            } => Some((
                id,
                Call::SearchModelSet {
                    address: address.clone(),
                    model: *model,
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
    use crate::allowlist::{samples, ID, SINCE_MS};
    use crate::connections::run_app_approval;
    use crate::ipc::{CliResult, TerminalCommand};
    use crate::paths::Folders;
    use crate::terminal::{command_words, Prepared};
    use serde_json::{json, Value};

    const PERSON: &str = "p_K19FVJ41QS08HPWN3XC3RQ2K7B";
    const OTHER: &str = "p_8GE1HWF42A0071A07VARPJWX1D";

    fn call(value: Value) -> Call {
        serde_json::from_value(value.clone()).unwrap_or_else(|error| panic!("{value}: {error}"))
    }

    fn refused(value: Value) {
        assert!(
            serde_json::from_value::<Call>(value.clone()).is_err(),
            "{value} should be refused"
        );
    }

    fn built(value: Value) -> Words {
        let words = call(value.clone())
            .words()
            .unwrap_or_else(|error| panic!("{value}: {error}"));
        assert_eq!(words.product, Product::Core, "{value}");
        assert_eq!(words.shape, Shape::Envelope, "{value}");
        assert!(words.pins, "{value}");
        assert!(words.quiet_updates, "{value}");
        words
    }

    fn words(value: Value) -> Vec<String> {
        built(value).words
    }

    #[test]
    fn search_calls_build_core_s_words() {
        assert_eq!(
            words(json!({ "kind": "searchStatus" })),
            ["search", "status"]
        );
        assert_eq!(
            words(json!({ "kind": "searchQuery", "text": "invoices" })),
            ["search", "query", "--", "invoices"]
        );
        assert_eq!(
            words(json!({
                "kind": "searchQuery",
                "text": "-draft what did David ask?",
                "person": PERSON,
                "accounts": ["acme/gmail", "acme/slack"],
                "channel": "slack",
                "since": SINCE_MS,
                "until": SINCE_MS + 86_400_000,
                "direction": "any",
                "limit": 50
            })),
            [
                "search",
                "query",
                "--person",
                PERSON,
                "--account",
                "acme/gmail",
                "--account",
                "acme/slack",
                "--channel",
                "slack",
                "--since",
                "1792886400000",
                "--until",
                "1792972800000",
                "--direction",
                "any",
                "--limit",
                "50",
                "--",
                "-draft what did David ask?"
            ]
        );
        assert_eq!(
            words(json!({ "kind": "searchPeople" })),
            ["search", "people"]
        );
        assert_eq!(
            words(json!({ "kind": "searchPeople", "since": SINCE_MS })),
            ["search", "people", "--since", "1792886400000"]
        );
        assert_eq!(
            words(
                json!({ "kind": "searchPerson", "personId": PERSON, "since": SINCE_MS, "limit": 50 })
            ),
            [
                "search",
                "person",
                PERSON,
                "--since",
                "1792886400000",
                "--limit",
                "50"
            ]
        );
        assert_eq!(
            words(json!({ "kind": "searchShow", "sourceId": "C0EXAMPLE2/1792915200.000200" })),
            ["search", "show", "C0EXAMPLE2/1792915200.000200"]
        );
        assert_eq!(
            words(json!({ "kind": "searchIndex", "budget": 20 })),
            ["search", "index", "--budget", "20"]
        );
        assert_eq!(
            words(json!({ "kind": "searchRebuild" })),
            ["search", "rebuild"]
        );
        assert_eq!(
            words(json!({ "kind": "searchLink", "personId": PERSON, "otherId": OTHER })),
            ["search", "link", PERSON, OTHER]
        );
        assert_eq!(
            words(json!({ "kind": "searchUnlink", "handle": "slack:T0ACME/U0DAVID" })),
            ["search", "unlink", "slack:T0ACME/U0DAVID"]
        );
        assert_eq!(
            words(json!({ "kind": "searchLabel", "personId": PERSON, "label": "David Park" })),
            ["search", "label", PERSON, "--", "David Park"]
        );
        assert_eq!(words(json!({ "kind": "searchOn" })), ["search", "on"]);
        assert_eq!(
            words(json!({ "kind": "searchOn", "appApproval": ID })),
            ["search", "on", "--app-approval", ID]
        );
        assert_eq!(words(json!({ "kind": "searchOff" })), ["search", "off"]);
        assert_eq!(
            words(json!({ "kind": "searchAccountsAdd", "account": "acme/slack" })),
            ["search", "accounts", "add", "acme/slack"]
        );
        assert_eq!(
            words(
                json!({ "kind": "searchAccountsAdd", "account": "acme/slack", "appApproval": ID })
            ),
            [
                "search",
                "accounts",
                "add",
                "acme/slack",
                "--app-approval",
                ID
            ]
        );
        assert_eq!(
            words(json!({ "kind": "searchAccountsRemove", "account": "acme/gmail" })),
            ["search", "accounts", "remove", "acme/gmail"]
        );
        assert_eq!(
            words(
                json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434", "model": "qwen3-embedding:0.6b" })
            ),
            [
                "search",
                "model",
                "set",
                "http://127.0.0.1:11434",
                "qwen3-embedding:0.6b"
            ]
        );
        assert_eq!(
            words(json!({
                "kind": "searchModelSet",
                "address": "http://[::1]:8080",
                "model": "bge-m3:latest",
                "appApproval": ID
            })),
            [
                "search",
                "model",
                "set",
                "http://[::1]:8080",
                "bge-m3:latest",
                "--app-approval",
                ID
            ]
        );
        assert_eq!(
            words(json!({ "kind": "searchModelNone" })),
            ["search", "model", "none"]
        );
        assert_eq!(
            words(json!({ "kind": "searchDeleteAll" })),
            ["search", "delete", "--all", "--confirm"]
        );
    }

    #[test]
    fn a_search_s_words_go_after_the_options_json_and_pins() {
        let folders = Folders {
            config_dir: "/example/home/.config/agent-communications".into(),
            state_dir: "/example/home/.config/agent-communications/state".into(),
            data_dir: "/example/home/.local/share/agent-communications".into(),
            secrets_dir: "/example/home/.config/agent-communications/secrets".into(),
        };
        let program = crate::launchers::Program {
            program: "/example/home/.local/share/agent-communications/launch/core".into(),
            leading: vec![],
        };
        let query = built(json!({ "kind": "searchQuery", "text": "--json", "limit": 5 }));
        let mut expected = vec![
            program.program.clone(),
            "search".into(),
            "query".into(),
            "--limit".into(),
            "5".into(),
            "--json".into(),
        ];
        expected.extend(folders.pins());
        expected.extend(["--".into(), "--json".into()]);
        assert_eq!(
            crate::runner::argv(&query, &program, &folders, true),
            expected
        );
        // The label too; and a call with no `--` keeps `--json` and the pins at the end.
        let label = built(json!({ "kind": "searchLabel", "personId": PERSON, "label": "-dash" }));
        let line = crate::runner::argv(&label, &program, &folders, true);
        assert_eq!(&line[line.len() - 2..], ["--", "-dash"]);
        let status = built(json!({ "kind": "searchStatus" }));
        assert!(crate::runner::argv(&status, &program, &folders, true).ends_with(&folders.pins()));
    }

    #[test]
    fn search_calls_have_timeouts_their_work_outlasts() {
        assert_eq!(
            built(json!({ "kind": "searchStatus" })).timeout,
            Duration::from_secs(30)
        );
        assert_eq!(
            built(json!({ "kind": "searchQuery", "text": "x" })).timeout,
            Duration::from_secs(60)
        );
        assert_eq!(
            built(json!({ "kind": "searchIndex", "budget": 20 })).timeout,
            Duration::from_secs(50)
        );
        assert_eq!(
            built(json!({ "kind": "searchIndex" })).timeout,
            Duration::from_secs(60)
        );
        assert_eq!(
            built(json!({ "kind": "searchRebuild", "budget": 120 })).timeout,
            Duration::from_secs(150)
        );
        assert_eq!(
            built(json!({ "kind": "searchDeleteAll" })).timeout,
            Duration::from_secs(60)
        );
    }

    #[test]
    fn search_calls_refuse_what_core_would_not_take() {
        // A search's words: control, bidi and invisible characters, and more than 500.
        for text in [
            "",
            "   ",
            "invoice\nBcc",
            "invoice\tx",
            "x\u{202e}y",
            "x\u{200b}y",
            "x\u{2028}y",
            "x\u{1b}[31m",
        ] {
            refused(json!({ "kind": "searchQuery", "text": text }));
        }
        refused(json!({ "kind": "searchQuery", "text": "é".repeat(501) }));
        assert!(serde_json::from_value::<Call>(
            json!({ "kind": "searchQuery", "text": "é".repeat(500) })
        )
        .is_ok());
        // Its filters: a person's id, accounts each once, Gmail or Slack, a direction, the limit, the times.
        for (field, value) in [
            ("person", json!("p_short")),
            ("person", json!("david")),
            ("accounts", json!([])),
            ("accounts", json!(["acme/gmail", "acme/gmail"])),
            ("accounts", json!(["Acme/Gmail"])),
            ("accounts", json!("acme/gmail")),
            ("channel", json!("whatsapp")),
            ("channel", json!("resend")),
            ("direction", json!("both")),
            ("limit", json!(0)),
            ("limit", json!(51)),
            ("since", json!(0)),
            ("until", json!("7d")),
        ] {
            let mut value_json = json!({ "kind": "searchQuery", "text": "invoices" });
            value_json[field] = value;
            refused(value_json);
        }
        let many: Vec<String> = (0..21).map(|n| format!("acme/gmail-n{n}")).collect();
        refused(json!({ "kind": "searchQuery", "text": "x", "accounts": many }));
        assert_eq!(
            call(
                json!({ "kind": "searchQuery", "text": "x", "since": SINCE_MS, "until": SINCE_MS })
            )
            .words()
            .expect_err("a window that ends where it starts")
            .code,
            "APP_REFUSED"
        );
        refused(json!({ "kind": "searchQuery", "text": "x", "args": ["--json"] }));
        refused(json!({ "kind": "searchQuery" }));
        // A person, a handle, a label, a message's id.
        refused(json!({ "kind": "searchPerson", "personId": "p_0123456789abcdefghjkmnpqrs" }));
        refused(json!({ "kind": "searchPerson", "personId": PERSON, "limit": 201 }));
        refused(json!({ "kind": "searchUnlink", "handle": "david@example.com" }));
        refused(json!({ "kind": "searchUnlink", "handle": "email:david@example.com --json" }));
        refused(json!({ "kind": "searchLabel", "personId": PERSON, "label": " David" }));
        refused(json!({ "kind": "searchLabel", "personId": PERSON, "label": "D".repeat(81) }));
        refused(json!({ "kind": "searchLabel", "personId": PERSON, "label": "Da\u{202e}vid" }));
        refused(json!({ "kind": "searchShow", "sourceId": "../x" }));
        refused(json!({ "kind": "searchShow", "sourceId": "-x" }));
        assert_eq!(
            call(json!({ "kind": "searchLink", "personId": PERSON, "otherId": PERSON }))
                .words()
                .expect_err("one person")
                .code,
            "APP_REFUSED"
        );
        // Upkeep's budget, from the app.
        refused(json!({ "kind": "searchIndex", "budget": 121 }));
        refused(json!({ "kind": "searchRebuild", "budget": -1 }));
        // The model: on this machine, from the reviewed list, never a cloud one, never another name.
        for address in [
            "http://localhost:11434",
            "https://127.0.0.1:11434",
            "http://10.0.0.2:11434",
            "http://127.0.0.1:11434/v1/systemone",
            "http://127.0.0.1",
        ] {
            refused(
                json!({ "kind": "searchModelSet", "address": address, "model": "qwen3-embedding:0.6b" }),
            );
        }
        for model in [
            "qwen3-embedding",
            "nomic-embed-text",
            "gpt-oss:120b-cloud",
            "bge-m3",
            "",
        ] {
            refused(
                json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434", "model": model }),
            );
        }
        refused(json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434" }));
        // Accounts by name; a tightening never carries the app's approval, and nothing carries `--approval`.
        refused(json!({ "kind": "searchAccountsAdd", "account": "Acme/Gmail" }));
        refused(
            json!({ "kind": "searchAccountsRemove", "account": "acme/gmail", "appApproval": ID }),
        );
        refused(json!({ "kind": "searchOff", "appApproval": ID }));
        refused(json!({ "kind": "searchModelNone", "appApproval": ID }));
        refused(json!({ "kind": "searchDeleteAll", "appApproval": ID }));
        refused(json!({ "kind": "searchOn", "approval": ID }));
        refused(json!({ "kind": "searchOn", "appApproval": "ap_short" }));
        // Delete everything takes nothing: `--all --confirm` are the call's own.
        refused(json!({ "kind": "searchDeleteAll", "all": true }));
        // No agent search: nothing here is a call an MCP tool could stand for, and there is no `searchAgents`.
        refused(json!({ "kind": "searchSessions", "on": true }));
    }

    #[test]
    fn search_s_loosenings_prepare_and_are_approved_in_the_app_only_for_the_change_prepared() {
        for (prepare, approve) in [
            (
                json!({ "kind": "searchOn" }),
                json!({ "kind": "searchOn", "appApproval": ID }),
            ),
            (
                json!({ "kind": "searchAccountsAdd", "account": "acme/slack" }),
                json!({ "kind": "searchAccountsAdd", "account": "acme/slack", "appApproval": ID }),
            ),
            (
                json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434", "model": "embeddinggemma:latest" }),
                json!({
                    "kind": "searchModelSet",
                    "address": "http://127.0.0.1:11434",
                    "model": "embeddinggemma:latest",
                    "appApproval": ID
                }),
            ),
        ] {
            let prepare = call(prepare);
            let approve = call(approve);
            assert!(prepare.prepares_change(), "{prepare:?}");
            assert!(!approve.prepares_change(), "{approve:?}");
            assert_eq!(prepare.needs(), Some(SEARCH_VERSION));
            assert_eq!(approve.needs(), Some(SEARCH_VERSION));
            let (id, answered) = approve.answers_app_approval().expect("it answers one");
            assert_eq!(id.as_str(), ID);
            assert_eq!(answered, prepare);
            assert!(prepare.answers_app_approval().is_none());
            // The terminal opens only the prepared change, never one that carries the app's approval.
            let revoke = ApprovalId::try_from(ID.to_string()).expect("an id");
            assert!(command_words(&TerminalCommand::Change {
                call: prepare.clone(),
                revoke: revoke.clone(),
            })
            .is_ok());
            assert!(command_words(&TerminalCommand::Change {
                call: approve.clone(),
                revoke,
            })
            .is_err());
        }
        // Nothing else of Search prepares, answers an approval, or opens in the terminal.
        for (sample, value) in samples() {
            if !sample.is_search() {
                continue;
            }
            assert_eq!(sample.needs(), Some(SEARCH_VERSION), "{value}");
            let loosening = matches!(
                value["kind"].as_str(),
                Some("searchOn" | "searchAccountsAdd" | "searchModelSet")
            ) && value.get("appApproval").is_none();
            assert_eq!(sample.prepares_change(), loosening, "{value}");
        }
        let ok = || CliResult::Ok {
            exit: 0,
            data: json!({ "changed": true, "on": true }),
        };
        let pending = CliResult::ApprovalPending {
            approval_id: ID.into(),
            preview: "Keep the words of new messages agents read in acme/slack on this machine"
                .into(),
            expires_at: None,
        };
        let add = json!({ "kind": "searchAccountsAdd", "account": "acme/slack" });
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
        // Prepared for another account: refused.
        prepared.record(
            &call(json!({ "kind": "searchAccountsAdd", "account": "acme/gmail" })),
            &pending,
        );
        assert!(
            run_app_approval(&prepared, &call(approved.clone()), || panic!(
                "it must not run"
            ))
            .is_err()
        );
        // Prepared for this one: it runs, once.
        let prepared = Prepared::default();
        prepared.record(&call(add), &pending);
        assert!(matches!(
            run_app_approval(&prepared, &call(approved.clone()), ok).expect("it runs"),
            CliResult::Ok { .. }
        ));
        assert!(run_app_approval(&prepared, &call(approved), ok).is_err());
    }

    #[test]
    fn search_calls_need_0_35_0() {
        assert!(!crate::version::at_least("0.34.0", SEARCH_VERSION));
        assert!(crate::version::at_least("0.35.0", SEARCH_VERSION));
        assert!(crate::version::at_least(
            "0.35.0-feat-0.35-search-app",
            SEARCH_VERSION
        ));
        let mut seen = 0;
        for (sample, value) in samples() {
            if value["kind"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("search"))
            {
                seen += 1;
                assert!(sample.is_search(), "{value}");
                assert!(sample.input().is_none(), "{value} reads no stdin");
            } else {
                assert!(!sample.is_search(), "{value}");
                assert!(sample.search_words().is_err(), "{value}");
            }
        }
        assert_eq!(seen, 24);
    }
}
