//! The grammars every argument is checked against before a command is built (DA4), read from `grammar.json`, which
//! `src/grammar.ts` reads too. Each is core's own: an approval id (`ids.ts`), a version-1 alias (`config.ts`), an
//! account name (`name-grammar.ts`, its look-ahead written as a list of reserved words), the two conversation forms
//! (`operations/label.ts`), and an activity session's key (`activity.ts`). Two are the event service's (0.30.0, design
//! 2026-10-25-action-queue §8): a queue item's id, and a rule's id as the Queue screen filters by one. Two are its
//! lanes' (0.31.0, design 2026-10-25-routing §3.1 and B1): a lane's name, and the id of the agent window bound to one.
//! Two are judge setup's (0.32.0, owner decision 2026-10-26): a local model server's URL on this machine, and its
//! model's name, as `judge setup local-endpoint` takes them.

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
    loopback_url: String,
    local_model: String,
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
    loopback_url: Regex,
    local_model: Regex,
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
        loopback_url: pattern(&source.loopback_url),
        local_model: pattern(&source.local_model),
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

#[cfg(test)]
mod tests {
    use super::*;

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
