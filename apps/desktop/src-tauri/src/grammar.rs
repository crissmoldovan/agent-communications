//! The grammars every argument is checked against before a command is built (DA4), read from `grammar.json`, which
//! `src/grammar.ts` reads too. Each is core's own: an approval id (`ids.ts`), a version-1 alias (`config.ts`), an
//! account name (`name-grammar.ts`, its look-ahead written as a list of reserved words), and the two conversation
//! forms (`operations/label.ts`).

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
}

struct Grammar {
    approval_id: Regex,
    alias: Regex,
    name: Regex,
    reserved: Vec<String>,
    slack_conversation: Regex,
    mail_conversation: Regex,
    acts: Vec<String>,
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

#[cfg(test)]
mod tests {
    use super::*;

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
