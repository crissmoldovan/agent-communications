//! The grammars every argument is checked against before a command is built (DA4), read from `grammar.json`, which
//! `src/grammar.ts` reads too. Each is core's own: an approval id (`ids.ts`), a version-1 alias (`config.ts`), an
//! account name (`name-grammar.ts`, its look-ahead written as a list of reserved words), the two conversation forms
//! (`operations/label.ts`), and an activity session's key (`activity.ts`). Two are the event service's (0.30.0, design
//! 2026-10-25-action-queue §8): a queue item's id, and a rule's id as the Queue screen filters by one.

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

#[cfg(test)]
mod tests {
    use super::*;

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
