//! The grammars every argument is checked against before a command is built (DA4), read from `grammar.json`, which
//! `src/grammar.ts` reads too. Each is core's own: an approval id (`ids.ts`), a version-1 alias (`config.ts`), an
//! account name (`name-grammar.ts`, its look-ahead written as a list of reserved words), the two conversation forms
//! (`operations/label.ts`), and an activity session's key (`activity.ts`). Two are the event service's (0.30.0, design
//! 2026-10-25-action-queue §8): a queue item's id, and a rule's id as the Queue screen filters by one. Two are its
//! lanes' (0.31.0, design 2026-10-25-routing §3.1 and B1): a lane's name, and the id of the agent window bound to one.
//! One is a delivery's (0.32.0, owner feedback §3.5): its id, as the Deliveries screen opens, retries or drops one.
//! Two are judge setup's (0.32.0, owner decision 2026-10-26): a local model server's URL on this machine, and its
//! model's name, as `judge setup local-endpoint` takes them. Five are workflows' (0.36.0, plan 2026-10-27-workflows-0360
//! I7): a run's id, a project's id, a step's id, an outcome's word, and a catalogue example a workflow is tried on; a
//! subscriber's id is a rule id's grammar.

use regex::Regex;
use serde::Deserialize;
use std::sync::LazyLock;

/// The longest value, in characters, any argument may be.
pub const LIMIT: usize = 320;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    limit: usize,
    approval_id: String,
    alias: String,
    name: String,
    reserved: Vec<String>,
    slack_conversation: String,
    mail_conversation: String,
    acts: Vec<String>,
    session_key: String,
    queue_item_id: String,
    rule_id: String,
    lane_name: String,
    window_id: String,
    delivery_id: String,
    loopback_url: String,
    local_model: String,
    run_id: String,
    project_id: String,
    step_id: String,
    outcome_word: String,
    catalogue_example: String,
}

struct Grammar {
    approval_id: Regex,
    alias: Regex,
    name: Regex,
    reserved: Vec<String>,
    slack_conversation: Regex,
    mail_conversation: Regex,
    acts: Vec<String>,
    session_key: Regex,
    queue_item_id: Regex,
    rule_id: Regex,
    lane_name: Regex,
    window_id: Regex,
    delivery_id: Regex,
    loopback_url: Regex,
    local_model: Regex,
    run_id: Regex,
    project_id: Regex,
    step_id: Regex,
    outcome_word: Regex,
    catalogue_example: Regex,
}

static GRAMMAR: LazyLock<Grammar> = LazyLock::new(|| {
    let source: Source =
        serde_json::from_str(include_str!("../../grammar.json")).expect("grammar.json is valid");
    assert_eq!(source.limit, LIMIT, "grammar.json's limit is the app's");
    let pattern = |text: &str| Regex::new(text).expect("grammar.json's patterns compile");
    Grammar {
        approval_id: pattern(&source.approval_id),
        alias: pattern(&source.alias),
        name: pattern(&source.name),
        reserved: source.reserved,
        slack_conversation: pattern(&source.slack_conversation),
        mail_conversation: pattern(&source.mail_conversation),
        acts: source.acts,
        session_key: pattern(&source.session_key),
        queue_item_id: pattern(&source.queue_item_id),
        rule_id: pattern(&source.rule_id),
        lane_name: pattern(&source.lane_name),
        window_id: pattern(&source.window_id),
        delivery_id: pattern(&source.delivery_id),
        loopback_url: pattern(&source.loopback_url),
        local_model: pattern(&source.local_model),
        run_id: pattern(&source.run_id),
        project_id: pattern(&source.project_id),
        step_id: pattern(&source.step_id),
        outcome_word: pattern(&source.outcome_word),
        catalogue_example: pattern(&source.catalogue_example),
    }
});

/// The rule every value meets first: not empty, not starting with `-` (so it is never read as an option), no control
/// or format character (no escape sequences, no bidi overrides, no zero-width text), and at most `LIMIT` characters.
pub fn plain(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && value.chars().count() <= LIMIT
        && !CONTROL_OR_FORMAT.is_match(value)
}

/// Unicode's Cc (control) and Cf (format) characters, as `src/grammar.ts` names them: `[\p{Cc}\p{Cf}]`.
static CONTROL_OR_FORMAT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{Cc}\p{Cf}]").expect("a pattern"));

/// `ap_` and 26 of Crockford's letters, as core makes them.
pub fn approval_id(value: &str) -> bool {
    plain(value) && GRAMMAR.approval_id.is_match(value)
}

/// An account: `organisation/platform[-qualifier]`, its organisation not a word Windows reserves, or a version-1 alias.
pub fn account_name(value: &str) -> bool {
    if !plain(value) {
        return false;
    }
    if GRAMMAR.alias.is_match(value) {
        return true;
    }
    GRAMMAR.name.captures(value).is_some_and(|parts| {
        let organisation = parts.get(1).map_or("", |part| part.as_str());
        !GRAMMAR.reserved.iter().any(|word| word == organisation)
    })
}

/// A Slack channel, DM or person (`C…`, `G…`, `D…`, `U…`, `W…`), or an address or `@domain`.
pub fn conversation(value: &str) -> bool {
    plain(value)
        && (GRAMMAR.slack_conversation.is_match(value) || GRAMMAR.mail_conversation.is_match(value))
}

/// `none`, or a comma list of known acts, each at most once.
pub fn acts(value: &str) -> bool {
    if !plain(value) {
        return false;
    }
    if value == "none" {
        return true;
    }
    let listed: Vec<&str> = value.split(',').collect();
    listed
        .iter()
        .all(|act| GRAMMAR.acts.iter().any(|known| known == act))
        && listed
            .iter()
            .enumerate()
            .all(|(index, act)| !listed[..index].contains(act))
}

/// An activity session's key, as core makes it: sixteen lowercase hex digits (`activity.ts`, `SESSION_KEY`).
pub fn session_key(value: &str) -> bool {
    plain(value) && GRAMMAR.session_key.is_match(value)
}

/// A queue item's id, as the event service makes it: `qi_` and 26 of Crockford's letters (design 2026-10-25-action-queue
/// §8).
pub fn queue_item_id(value: &str) -> bool {
    plain(value) && GRAMMAR.queue_item_id.is_match(value)
}

/// A rule's id, as the Queue screen filters by one: a letter or digit, then up to 127 letters, digits, `.`, `_`, `:`,
/// `@` or `-`. The event service takes any non-empty text for an id; a rule whose id is outside this is shown, and is
/// never offered as a filter.
pub fn rule_id(value: &str) -> bool {
    plain(value) && GRAMMAR.rule_id.is_match(value)
}

/// A lane's name, as the event service takes one (design 2026-10-25-routing §3.1): 1 to 40 lowercase letters, digits
/// and `-`. A name that starts with `-` is refused with every other value that does, so it is never read as an option.
pub fn lane_name(value: &str) -> bool {
    plain(value) && GRAMMAR.lane_name.is_match(value)
}

/// The agent window a lane is bound to, as `lane bind --window` takes it (B1): a Claude Code session id, a lowercase
/// UUID; or an activity session's key, sixteen lowercase hex digits, as core makes it.
pub fn window_id(value: &str) -> bool {
    plain(value) && GRAMMAR.window_id.is_match(value)
}

/// A delivery's id, as the Deliveries screen names one (0.32.0): a letter or digit, then up to 127 letters, digits,
/// `_` or `-`. The event service makes each a lowercase UUID; a delivery whose id is outside this is shown, and is never
/// named in a call.
pub fn delivery_id(value: &str) -> bool {
    plain(value) && GRAMMAR.delivery_id.is_match(value)
}

/// A local model server's URL, as `judge setup local-endpoint --url` takes it (0.32.0): plain HTTP to the literal
/// `127.0.0.1` or `[::1]`, a port from 1 to 65535, and no path but `/` or `/v1/systemone`. A hostname, `localhost`
/// included, HTTPS, another address, a user, a query or a fragment is refused; the event service checks it again.
pub fn loopback_url(value: &str) -> bool {
    plain(value)
        && GRAMMAR
            .loopback_url
            .captures(value)
            .and_then(|parts| parts.get(1))
            .and_then(|port| port.as_str().parse::<u32>().ok())
            .is_some_and(|port| (1..=65_535).contains(&port))
}

/// A local model's name, as `judge setup local-endpoint --model` takes it: a letter or digit, then up to 127 letters,
/// digits, `.`, `_`, `:`, `/` or `-`.
pub fn local_model(value: &str) -> bool {
    plain(value) && GRAMMAR.local_model.is_match(value)
}

/// A workflow run's id, as the event service makes it (0.36.0, spec §4.3): `wfr_` and 26 lowercase letters of
/// Crockford's base 32, `0123456789abcdefghjkmnpqrstvwxyz`. A relay turn's `run_` id is never one.
pub fn run_id(value: &str) -> bool {
    plain(value) && GRAMMAR.run_id.is_match(value)
}

/// A project's id, as `project show|remove` names one (0.36.0): 1 to 64 lowercase letters, digits and `-`, never
/// starting with `-`.
pub fn project_id(value: &str) -> bool {
    plain(value) && GRAMMAR.project_id.is_match(value)
}

/// A step's id in a workflow's flow (0.36.0, spec §4.1): a lowercase letter, then up to 31 lowercase letters, digits
/// and `-`.
pub fn step_id(value: &str) -> bool {
    plain(value) && GRAMMAR.step_id.is_match(value)
}

/// An outcome's word, as `workflow test --outcome <step>=<word>` takes it (0.36.0): a lowercase letter, then up to 31
/// lowercase letters and `-`.
pub fn outcome_word(value: &str) -> bool {
    plain(value) && GRAMMAR.outcome_word.is_match(value)
}

/// A catalogue example a workflow is tried on, as `workflow test` takes it: `type@version:index`, the type an event
/// type's dotted words, the version a whole number from 1 and the index one from 0, each at most nine digits.
pub fn catalogue_example(value: &str) -> bool {
    plain(value) && GRAMMAR.catalogue_example.is_match(value)
}

/// A subscriber's id (0.36.0, plan I7): a rule id's grammar, a letter or digit, then up to 127 letters, digits and
/// `._:@-`.
pub fn subscriber_id(value: &str) -> bool {
    rule_id(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Workflows' words (0.36.0, plan I7): a run, a project, a step, an outcome, a catalogue example and a subscriber;
    /// each refuses an option, a second word, a capital where none is taken, and anything past its length.
    #[test]
    fn workflow_ids_and_words_are_the_plans_grammars() {
        let run = "wfr_0123456789abcdefghjkmnpqrs";
        for good in [
            run,
            "wfr_zzzzzzzzzzzzzzzzzzzzzzzzzz",
            "wfr_00000000000000000000000000",
        ] {
            assert!(run_id(good), "{good}");
        }
        for bad in [
            "",
            "wfr_",
            "wfr_0123456789abcdefghjkmnpqr",
            "wfr_0123456789abcdefghjkmnpqrst",
            "WFR_0123456789abcdefghjkmnpqrs",
            "wfr_0123456789ABCDEFGHJKMNPQRS",
            "wfr_0123456789abcdefghijkmnpqr",
            "wfr_0123456789abcdefghjklmnpqr",
            "wfr_0123456789abcdefghjkmnopqr",
            "wfr_0123456789abcdefghjkmnpqru",
            "run_0123456789abcdefghjkmnpqrs",
            "-wfr_0123456789abcdefghjkmnpqr",
            "wfr_0123456789abcdefghjkmnpqrs\n",
            "wfr_0123456789abcdefghjkmnpqrs --interrupt",
        ] {
            assert!(!run_id(bad), "{bad:?}");
        }
        let longest_project = "p".repeat(64);
        for good in [
            "acme-site",
            "a",
            "0",
            "billing-tool-2",
            longest_project.as_str(),
        ] {
            assert!(project_id(good), "{good}");
        }
        let too_long_project = "p".repeat(65);
        for bad in [
            "",
            "-acme",
            "--json",
            "Acme",
            "acme_site",
            "acme.site",
            "acme/site",
            "../acme",
            "acme site",
            "acme\n",
            "acme\u{202e}",
            too_long_project.as_str(),
        ] {
            assert!(!project_id(bad), "{bad:?}");
        }
        let longest_step = format!("s{}", "x".repeat(31));
        for good in [
            "route",
            "find-session",
            "issue",
            "s2",
            longest_step.as_str(),
        ] {
            assert!(step_id(good), "{good}");
        }
        let too_long_step = format!("s{}", "x".repeat(32));
        for bad in [
            "",
            "Run",
            "2route",
            "-route",
            "route_1",
            "route.1",
            "route=busy",
            "route busy",
            "route\n",
            too_long_step.as_str(),
        ] {
            assert!(!step_id(bad), "{bad:?}");
        }
        for good in [
            "busy",
            "left-in-queue",
            "needs-the-person",
            "timed-out",
            "yes",
        ] {
            assert!(outcome_word(good), "{good}");
        }
        for bad in [
            "",
            "Busy",
            "busy2",
            "-busy",
            "busy=idle",
            "busy idle",
            "busy\n",
            "b".repeat(33).as_str(),
        ] {
            assert!(!outcome_word(bad), "{bad:?}");
        }
        for good in [
            "gmail.message.received@1:0",
            "slack.message.posted@2:3",
            "whatsapp.message.received@1:12",
        ] {
            assert!(catalogue_example(good), "{good}");
        }
        for bad in [
            "",
            "gmail@1:0",
            "gmail.message.received",
            "gmail.message.received@0:0",
            "gmail.message.received@1:-1",
            "gmail.message.received@1:01",
            "gmail.message.received@1",
            "Gmail.message.received@1:0",
            "-gmail.message.received@1:0",
            "gmail.message.received@1:0 --json",
            "gmail.message.received@1234567890:0",
        ] {
            assert!(!catalogue_example(bad), "{bad:?}");
        }
        for good in ["events-dashboard", "crm_hook", "team:sub@1", "s"] {
            assert!(subscriber_id(good), "{good}");
        }
        for bad in ["", "-sub", "--json", "sub 1", "sub/1", "_sub"] {
            assert!(!subscriber_id(bad), "{bad:?}");
        }
    }

    /// Judge setup's two words (0.32.0): a URL on this machine, and a model's name; nothing else passes.
    #[test]
    fn a_local_model_server_is_on_this_machine_with_a_port() {
        for good in [
            "http://127.0.0.1:11434",
            "http://127.0.0.1:11434/",
            "http://127.0.0.1:11434/v1/systemone",
            "http://[::1]:8080",
            "http://127.0.0.1:65535",
        ] {
            assert!(loopback_url(good), "{good}");
        }
        for bad in [
            "",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:011434",
            "http://localhost:11434",
            "https://127.0.0.1:11434",
            "http://192.168.1.20:11434",
            "http://8.8.8.8:11434",
            "http://[::2]:11434",
            "http://127.0.0.1:11434/api/generate",
            "http://127.0.0.1:11434/?q=1",
            "http://127.0.0.1:11434#x",
            "http://user@127.0.0.1:11434",
            "http://127.0.0.1:11434\n",
            "http://127.0.0.1:11434 --json",
            "-http://127.0.0.1:11434",
        ] {
            assert!(!loopback_url(bad), "{bad:?}");
        }
        for good in ["nimble", "clef-flash", "llama3.2:3b", "org/model_v1"] {
            assert!(local_model(good), "{good}");
        }
        for bad in [
            "",
            "-nimble",
            "nim ble",
            "nimble\n",
            "--json",
            "../x",
            "m".repeat(129).as_str(),
        ] {
            assert!(!local_model(bad), "{bad:?}");
        }
    }

    #[test]
    fn queue_item_ids_are_qi_and_26_of_crockford_s_letters() {
        for good in [
            "qi_0123456789ABCDEFGHJKMNPQRS",
            "qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ",
            "qi_00000000000000000000000000",
        ] {
            assert!(queue_item_id(good), "{good}");
        }
        for bad in [
            "",
            "qi_",
            "qi_0123456789ABCDEFGHJKMNPQR",
            "qi_0123456789ABCDEFGHJKMNPQRST",
            "qi_0123456789ABCDEFGHIJKMNPQR",
            "qi_0123456789ABCDEFGHJKLMNPQR",
            "qi_0123456789ABCDEFGHJKMNOPQR",
            "qi_0123456789ABCDEFGHJKMNPQRU",
            "qi_0123456789abcdefghjkmnpqrs",
            "QI_0123456789ABCDEFGHJKMNPQRS",
            "ap_0123456789ABCDEFGHJKMNPQRS",
            "-qi_0123456789ABCDEFGHJKMNPQR",
            "qi_0123456789ABCDEFGHJKMNPQRS\n",
            "qi_0123456789ABCDEFGHJKMNPQRS --json",
            " qi_0123456789ABCDEFGHJKMNPQRS",
        ] {
            assert!(!queue_item_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn delivery_ids_are_a_word_of_letters_digits_underscores_and_hyphens() {
        let longest = "d".repeat(128);
        for good in [
            "0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70",
            "dlv_example_1",
            "D",
            "7",
            longest.as_str(),
        ] {
            assert!(delivery_id(good), "{good}");
        }
        let too_long = "d".repeat(129);
        for bad in [
            "",
            "-dlv",
            "--json",
            "_dlv",
            "dlv.1",
            "dlv:1",
            "dlv@1",
            "dlv/1",
            "../dlv",
            "dlv 1",
            "dlv_1 --json",
            "dlv_1\n",
            "dlv_1\u{202e}",
            "dlv_1\u{200b}",
            " dlv_1",
            too_long.as_str(),
        ] {
            assert!(!delivery_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn rule_ids_are_a_word_of_letters_digits_and_a_few_marks() {
        for good in [
            "rule-1",
            "mail-asks",
            "David_on_Slack",
            "rule.v2",
            "team:rule@1",
            "r",
            "r".repeat(128).as_str(),
        ] {
            assert!(rule_id(good), "{good}");
        }
        for bad in [
            "",
            "-rule",
            "--json",
            ".rule",
            "_rule",
            "rule 1",
            "rule/1",
            "rule\\1",
            "rule\n",
            "rule\u{202e}",
            "rule\u{200b}",
            "r\u{e9}gle",
            "rule;rm",
            "rule$(x)",
            "r".repeat(129).as_str(),
        ] {
            assert!(!rule_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn lane_names_are_one_to_forty_lowercase_letters_digits_and_hyphens() {
        for good in [
            "david",
            "billing",
            "david-on-slack",
            "a",
            "0",
            "lane-2",
            "x".repeat(40).as_str(),
        ] {
            assert!(lane_name(good), "{good}");
        }
        for bad in [
            "",
            "-david",
            "--json",
            "David",
            "DAVID",
            "david_slack",
            "david.slack",
            "david slack",
            "david/slack",
            "david\\slack",
            "david\n",
            "david\u{202e}",
            "david\u{200b}",
            "d\u{e9}vid",
            "david;rm",
            "david$(x)",
            "david --window 3f9a1c2e7b4d5a60",
            "x".repeat(41).as_str(),
        ] {
            assert!(!lane_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn window_ids_are_a_lowercase_uuid_or_an_activity_key() {
        for good in [
            "3f9a1c2e7b4d5a60",
            "0000000000000000",
            "0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(window_id(good), "{good}");
        }
        for bad in [
            "",
            "3f9a1c2e7b4d5a6",
            "3f9a1c2e7b4d5a600",
            "3F9A1C2E7B4D5A60",
            "0F8B5C3E-2D41-4A7E-9C11-5B2E8D7F6A90",
            "0f8b5c3e2d414a7e9c115b2e8d7f6a90",
            "{0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90}",
            "0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a9",
            "0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90 --json",
            "-f9a1c2e7b4d5a60",
            "3f9a1c2e7b4d5a60\n",
            "3f9a1c2e7b4d5a6g",
            "../3f9a1c2e7b4d5",
            "david",
        ] {
            assert!(!window_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn session_keys_are_sixteen_lowercase_hex_digits() {
        for good in ["3f9a1c2e7b4d5a60", "0000000000000000", "ffffffffffffffff"] {
            assert!(session_key(good), "{good}");
        }
        for bad in [
            "",
            "3f9a1c2e7b4d5a6",
            "3f9a1c2e7b4d5a600",
            "3F9A1C2E7B4D5A60",
            "3f9a1c2e7b4d5a6g",
            "-f9a1c2e7b4d5a60",
            "3f9a1c2e 7b4d5a6",
            "3f9a1c2e7b4d5a60\n",
            "3f9a1c2e7b4d5a60 --json",
            "../3f9a1c2e7b4d5",
        ] {
            assert!(!session_key(bad), "{bad}");
        }
    }

    #[test]
    fn approval_ids_are_core_s() {
        assert!(approval_id("ap_0123456789ABCDEFGHJKMNPQRS"));
        assert!(approval_id("ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        for bad in [
            "ap_0123456789ABCDEFGHJKMNPQRI",
            "ap_0123456789ABCDEFGHJKMNPQRSU",
            "ap_",
            "pl_0123456789ABCDEFGHJKMNPQRS",
        ] {
            assert!(!approval_id(bad), "{bad}");
        }
    }

    #[test]
    fn account_names_are_names_or_aliases() {
        // `work-` is an alias core accepts: its grammar lets one end in a hyphen.
        for good in [
            "example/gmail",
            "example/gmail-work",
            "a/b",
            "cons/slack",
            "work",
            "my-inbox-2",
            "x1",
            "work-",
        ] {
            assert!(account_name(good), "{good}");
        }
        for bad in [
            "con/gmail",
            "NUL/gmail",
            "nul/slack",
            "com1/gmail",
            "-work",
            "Work",
            "example/Gmail",
            "example/1gmail",
            "example/gmail-",
            "example/gmail--x",
        ] {
            assert!(!account_name(bad), "{bad}");
        }
    }

    #[test]
    fn conversations_are_slack_ids_or_addresses() {
        for good in [
            "C0123ABCD",
            "G01",
            "D0ABC",
            "U012AB",
            "W012AB",
            "someone@example.com",
            "@example.com",
            "first.last+tag@example.co.uk",
        ] {
            assert!(conversation(good), "{good}");
        }
        for bad in [
            "c0123",
            "X0123",
            "C0",
            "someone",
            "someone@",
            "a@b@c",
            "a b@example.com",
            "<a@example.com>",
            "a,b@example.com",
            "\"a\"@example.com",
        ] {
            assert!(!conversation(bad), "{bad}");
        }
    }

    #[test]
    fn acts_are_none_or_a_list_without_repeats() {
        for good in [
            "none",
            "post",
            "reply,reaction",
            "post,reply,reaction,edit,delete,file,send",
        ] {
            assert!(acts(good), "{good}");
        }
        for bad in [
            "",
            "none,post",
            "post,post",
            "post,",
            "Post",
            "approve",
            "post reply",
            "all",
        ] {
            assert!(!acts(bad), "{bad}");
        }
    }

    #[test]
    fn every_value_is_refused_empty_dashed_controlled_or_long() {
        assert!(plain("example/gmail"));
        assert!(!plain(""));
        assert!(!plain("-x"));
        assert!(!plain("x\u{0000}"));
        assert!(!plain("x\u{001b}[31m"));
        assert!(!plain("x\u{007f}"));
        assert!(!plain("x\u{202e}y"));
        assert!(!plain("x\u{200b}y"));
        assert!(!plain("x\u{feff}"));
        assert!(plain(&"é".repeat(LIMIT)));
        assert!(!plain(&"é".repeat(LIMIT + 1)));
        assert_eq!(LIMIT, 320);
    }
}
