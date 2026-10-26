//! The rule editor's documents and its approval (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.3): a rule the
//! person wrote in the app, and each target it needs, go to the events CLI on stdin (`rule create|update -`, `target
//! add|update -`, `rule analyse --draft -`), never in argv; each is checked here first — one JSON object of the shape its
//! command takes, with an id the app's grammar takes and a whole version — and refused otherwise. The activation `rule
//! enable` prepares is the app's own, recorded with its digest (`terminal::Prepared`), and only that one is approved in
//! the app (`rule approve`), once, after the person pressed Approve. The approval view the preview reads reaches the
//! window without its challenges: only the CLI ever answers one.

use crate::grammar;
use crate::ipc::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The most a rule document may be, in bytes of compact JSON: well past any rule the editor makes, and inside one pipe's
/// buffer, so handing it to the CLI never waits on it.
pub const RULE_DOCUMENT_LIMIT: usize = 48 * 1024;

/// The most a target document may be, in bytes of compact JSON.
pub const TARGET_DOCUMENT_LIMIT: usize = 16 * 1024;

/// The highest version the app names: far past any rule's, and well inside a JSON number's whole range.
pub const VERSION_LIMIT: u64 = 1_000_000;

/// The target kinds the editor makes or changes (design §3.4–§3.6): the dry-run log, the Queue, a Linear issue and an
/// agent session. A webhook or a stream is never one: its URL and signing secret are set at the terminal.
pub const TARGET_KINDS: [&str; 4] = ["dry-run", "queue", "linear", "session"];

fn whole_version(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|version| (1..=VERSION_LIMIT).contains(&version))
}

fn id_of<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|id| grammar::rule_id(id))
}

fn compact(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// A rule document, as the editor made it: one JSON object, its `ruleId` an id the app's grammar takes, its `version`
/// a whole number from 1, and at most `RULE_DOCUMENT_LIMIT` bytes. The event service checks the rest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
pub struct RuleDocument(Value);

impl TryFrom<Value> for RuleDocument {
    type Error = AppError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let Value::Object(map) = &value else {
            return Err(AppError::refused("a rule document is one JSON object"));
        };
        if id_of(map, "ruleId").is_none() {
            return Err(AppError::refused(
                "a rule document names its rule by an id the app takes",
            ));
        }
        if !whole_version(map.get("version")) {
            return Err(AppError::refused(
                "a rule document's version is a whole number from 1",
            ));
        }
        if compact(&value).len() > RULE_DOCUMENT_LIMIT {
            return Err(AppError::refused("a rule document is at most 48 KiB"));
        }
        Ok(RuleDocument(value))
    }
}

impl From<RuleDocument> for Value {
    fn from(document: RuleDocument) -> Value {
        document.0
    }
}

impl RuleDocument {
    /// The document as the CLI reads it on stdin: compact JSON.
    pub fn bytes(&self) -> Vec<u8> {
        compact(&self.0)
    }

    /// The rule's id, which the grammar took.
    pub fn rule_id(&self) -> &str {
        self.0.get("ruleId").and_then(Value::as_str).unwrap_or("")
    }
}

/// A target document, as the editor made it: one JSON object, its `targetId` an id the app takes, its `version` a whole
/// number from 1, its `kind` one of `TARGET_KINDS`, and at most `TARGET_DOCUMENT_LIMIT` bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
pub struct TargetDocument(Value);

impl TryFrom<Value> for TargetDocument {
    type Error = AppError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let Value::Object(map) = &value else {
            return Err(AppError::refused("a target document is one JSON object"));
        };
        if id_of(map, "targetId").is_none() {
            return Err(AppError::refused(
                "a target document names its target by an id the app takes",
            ));
        }
        if !whole_version(map.get("version")) {
            return Err(AppError::refused(
                "a target document's version is a whole number from 1",
            ));
        }
        let kind = map.get("kind").and_then(Value::as_str);
        if !kind.is_some_and(|kind| TARGET_KINDS.contains(&kind)) {
            return Err(AppError::refused(
                "the app makes a dry-run log, a Queue, a Linear issue or an agent session target, and no other",
            ));
        }
        if compact(&value).len() > TARGET_DOCUMENT_LIMIT {
            return Err(AppError::refused("a target document is at most 16 KiB"));
        }
        Ok(TargetDocument(value))
    }
}

impl From<TargetDocument> for Value {
    fn from(document: TargetDocument) -> Value {
        document.0
    }
}

impl TargetDocument {
    /// The document as the CLI reads it on stdin: compact JSON.
    pub fn bytes(&self) -> Vec<u8> {
        compact(&self.0)
    }
}

/// A rule's version, as `rule enable <rule> <version>` names it: a whole number from 1 to `VERSION_LIMIT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct RuleVersion(u64);

impl TryFrom<u64> for RuleVersion {
    type Error = AppError;

    fn try_from(version: u64) -> Result<Self, Self::Error> {
        if (1..=VERSION_LIMIT).contains(&version) {
            Ok(RuleVersion(version))
        } else {
            Err(AppError::refused(
                "a rule's version is a whole number from 1",
            ))
        }
    }
}

impl From<RuleVersion> for u64 {
    fn from(version: RuleVersion) -> u64 {
        version.0
    }
}

/// An integration Settings → Integrations shows (design §3.4, §3.5): Linear, and the agent sessions claude-stream runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Integration {
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "agent-sessions")]
    AgentSessions,
}

impl Integration {
    pub const ALL: [Integration; 2] = [Integration::Linear, Integration::AgentSessions];

    /// The integration as the events CLI names it.
    pub fn word(self) -> &'static str {
        match self {
            Integration::Linear => "linear",
            Integration::AgentSessions => "agent-sessions",
        }
    }
}

/// The provider Analyse's model runs on (design §3.3, `rule analyse --provider`): OpenRouter or Anthropic, each with the
/// person's own key. Closed; with none named, the event service picks one that has a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnalyseProvider {
    Openrouter,
    Anthropic,
}

impl AnalyseProvider {
    pub const ALL: [AnalyseProvider; 2] = [AnalyseProvider::Openrouter, AnalyseProvider::Anthropic];

    /// The provider as `rule analyse --provider` takes it.
    pub fn word(self) -> &'static str {
        match self {
            AnalyseProvider::Openrouter => "openrouter",
            AnalyseProvider::Anthropic => "anthropic",
        }
    }
}

/// Where the event service finds the person's claude-stream relay, as `integration set agent-sessions --relay-home`
/// takes it (design §3.5): `default` — claude-stream's own home, then the Pilot app's — or the relay's home folder,
/// written whole: absolute, with no `.` or `..` step, no repeated or trailing `/`, no control or format character, and
/// at most 1,024 bytes, as the event service checks it again. The folder is a setting; the token in it is never read
/// here.
pub fn relay_home_setting(value: &str) -> bool {
    if value == "default" {
        return true;
    }
    value.len() <= 1024
        && value.starts_with('/')
        && value != "/"
        && !value.ends_with('/')
        && !value.contains("//")
        && !value
            .chars()
            .any(|character| character.is_control() || is_format(character))
        && value[1..]
            .split('/')
            .all(|step| step != "." && step != "..")
}

/// Unicode's format characters (Cf): bidi controls, zero-width text, the BOM.
fn is_format(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

/// A Linear team, as `integration show linear --team` takes one (design §3.4, `linear-target.ts`): its key — 1 to 32
/// letters, digits and `_` — or its id, a lowercase UUID.
pub fn linear_team(value: &str) -> bool {
    let key = !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    let id = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        });
    key || id
}

/// Whether `value` is a digest as the event service makes them: 64 lowercase hex digits.
pub fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// What `rule enable` came back with that the app may approve: the approval's id and the digest it binds, each as the
/// grammar takes it, or nothing.
pub fn prepared_activation(data: &Value) -> Option<(String, String)> {
    let approval = data.get("approvalId")?.as_str()?;
    let digest_of = data.get("binding")?.get("digest")?.as_str()?;
    (grammar::approval_id(approval) && digest(digest_of))
        .then(|| (approval.to_string(), digest_of.to_string()))
}

/// The approval view as the window may read it: every challenge the view issued taken out — the view's own and each
/// pending selector's — so that nothing but the CLI, at the person's press, ever answers one.
pub fn without_challenges(mut data: Value) -> Value {
    if let Some(challenge) = data.get_mut("challenge").and_then(Value::as_object_mut) {
        challenge.remove("challenge");
    }
    for list in ["pendingTargetSelectors", "pendingRuleJudgeTestSelectors"] {
        if let Some(selectors) = data.get_mut(list).and_then(Value::as_array_mut) {
            for selector in selectors.iter_mut().filter_map(Value::as_object_mut) {
                selector.remove("challenge");
            }
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn rule(version: u64) -> Value {
        json!({
            "ruleId": "invoices",
            "version": version,
            "condition": { "path": "/subject", "op": "contains", "value": "invoice", "caseSensitive": false },
            "targets": [{ "targetId": "invoices-log", "version": 1, "kind": "dry-run", "retentionMs": 86400000 }]
        })
    }

    #[test]
    fn a_rule_document_is_one_object_with_an_id_and_a_whole_version() {
        let document = RuleDocument::try_from(rule(3)).expect("a rule");
        assert_eq!(document.rule_id(), "invoices");
        assert_eq!(
            serde_json::from_slice::<Value>(&document.bytes()).expect("json"),
            rule(3)
        );
        for bad in [
            json!([rule(1)]),
            json!("invoices"),
            json!(null),
            json!({ "version": 1 }),
            json!({ "ruleId": "", "version": 1 }),
            json!({ "ruleId": "-invoices", "version": 1 }),
            json!({ "ruleId": "in voices", "version": 1 }),
            json!({ "ruleId": "invoices\u{202e}", "version": 1 }),
            json!({ "ruleId": "invoices", "version": 0 }),
            json!({ "ruleId": "invoices", "version": 1.5 }),
            json!({ "ruleId": "invoices", "version": -1 }),
            json!({ "ruleId": "invoices", "version": "1" }),
            json!({ "ruleId": "invoices", "version": 1_000_001 }),
            json!({ "ruleId": "invoices" }),
            json!({ "ruleId": "invoices", "version": 1, "padding": "x".repeat(RULE_DOCUMENT_LIMIT) }),
        ] {
            assert!(RuleDocument::try_from(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_target_document_is_one_the_editor_makes() {
        for kind in TARGET_KINDS {
            let value = json!({ "targetId": "invoices-log", "version": 2, "kind": kind });
            assert!(TargetDocument::try_from(value).is_ok(), "{kind}");
        }
        for bad in [
            json!({ "targetId": "hook", "version": 1, "kind": "webhook", "url": { "kind": "plain", "url": "https://hooks.example" } }),
            json!({ "targetId": "stream", "version": 1, "kind": "sse" }),
            json!({ "targetId": "log", "version": 1 }),
            json!({ "targetId": "log", "version": 1, "kind": "Dry-run" }),
            json!({ "targetId": "log", "kind": "dry-run" }),
            json!({ "targetId": "--json", "version": 1, "kind": "dry-run" }),
            json!({ "version": 1, "kind": "dry-run" }),
            json!({ "targetId": "log", "version": 1, "kind": "dry-run", "padding": "x".repeat(TARGET_DOCUMENT_LIMIT) }),
            json!(["dry-run"]),
        ] {
            assert!(TargetDocument::try_from(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_digest_is_64_lowercase_hex_digits() {
        assert!(digest(&"0f".repeat(32)));
        for bad in [
            "",
            "0f",
            &"0F".repeat(32),
            &"0g".repeat(32),
            &"0f".repeat(33),
            &format!("-{}", "0".repeat(63)),
        ] {
            assert!(!digest(bad), "{bad}");
        }
    }

    #[test]
    fn a_prepared_activation_is_read_only_when_its_id_and_digest_are_well_formed() {
        let id = crate::allowlist::ID;
        let good = json!({ "approvalId": id, "binding": { "digest": "ab".repeat(32) }, "status": "pending" });
        assert_eq!(
            prepared_activation(&good),
            Some((id.to_string(), "ab".repeat(32)))
        );
        for bad in [
            json!({ "approvalId": "ap_short", "binding": { "digest": "ab".repeat(32) } }),
            json!({ "approvalId": id, "binding": { "digest": "AB".repeat(32) } }),
            json!({ "approvalId": id }),
            json!({ "binding": { "digest": "ab".repeat(32) } }),
            json!([]),
        ] {
            assert_eq!(prepared_activation(&bad), None, "{bad}");
        }
    }

    #[test]
    fn a_linear_team_is_its_key_or_its_id() {
        for good in ["CUE", "ops_2", "0b1c2d3e-0000-4000-8000-00000000c0e1"] {
            assert!(linear_team(good), "{good}");
        }
        for bad in [
            "",
            "--json",
            "CUE OPS",
            "CUE-1",
            &"A".repeat(33),
            "0B1C2D3E-0000-4000-8000-00000000C0E1",
            "0b1c2d3e00000-4000-8000-00000000c0e1",
        ] {
            assert!(!linear_team(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_relay_home_is_default_or_a_whole_normal_folder() {
        for good in [
            "default",
            "/example/home/.local/state/agent-relay",
            "/example/home/Library/Application Support/com.cueplusplus.claude-stream.pilot/relay-home",
        ] {
            assert!(relay_home_setting(good), "{good}");
        }
        let long = format!("/{}", "a".repeat(1024));
        for bad in [
            "",
            "/",
            "Default",
            "~/.local/state/agent-relay",
            "relative/home",
            "--json",
            "/example/home/",
            "/example//home",
            "/example/home/../etc",
            "/example/./home",
            "/example/home\n",
            "/example/home\u{202e}",
            long.as_str(),
        ] {
            assert!(!relay_home_setting(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_approval_view_reaches_the_window_without_a_challenge() {
        let view = json!({
            "kind": "READY",
            "approvalId": crate::allowlist::ID,
            "digest": "ab".repeat(32),
            // An author may name a mapping field `challenge`: the preview is left as it is.
            "preview": { "kind": "rule", "rule": { "mapping": { "challenge": { "$path": "/subject" } } } },
            "pendingTargetSelectors": [{ "targetId": "t", "challenge": "fake-challenge-1" }],
            "pendingRuleJudgeTestSelectors": [{ "judgeId": "j", "challenge": "fake-challenge-2" }],
            "challenge": { "approvalId": crate::allowlist::ID, "challenge": "fake-challenge-0", "expiresAt": 1 }
        });
        let shown = without_challenges(view);
        let text = shown.to_string();
        assert!(!text.contains("fake-challenge"), "{text}");
        assert_eq!(shown["challenge"]["expiresAt"], 1);
        assert_eq!(
            shown["preview"]["rule"]["mapping"]["challenge"]["$path"],
            "/subject"
        );
        assert_eq!(shown["pendingTargetSelectors"][0]["targetId"], "t");
    }
}
