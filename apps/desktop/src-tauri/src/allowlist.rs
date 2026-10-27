//! The allow-list (DA4, plan "Global Constraints"): every call the app may make, each argument checked against core's
//! grammars before a word is built. A value that does not match never constructs, so the invoke that carried it fails
//! before anything runs. No call carries `--approval`, and none is `approve` (DA1, DA10). Three approvals are the
//! person's in the app (0.32.0, DA10's notes of 2026-10-26; 0.33.0): a judge's setup; adding a server to an app, whose
//! `mcpInstallApproved` answers only an approval the app prepared itself for that same install (`connections`); and a
//! rule's activation, whose `eventsRuleApprove` (`rule approve`) answers only the one the rule editor prepared with
//! `eventsRuleEnable`, for its digest (`rule_editor`); and since 0.34.0 switching the event service on, whose
//! `eventsCollectionApprove` (`collection approve`) answers only the one Events → Service prepared with
//! `eventsEnableAll`, for its digest. Since 0.34.0 the label's changes are too (`label`): a `labelWord`, `labelName`,
//! `labelRuleAdd` or `labelRuleRemove` with `appApproval` answers only the approval the app prepared for the same call
//! without it. Since 0.35.0 so are Search's three loosenings (`search`): a `searchOn`, `searchAccountsAdd` or
//! `searchModelSet` with `appApproval` answers only the approval the app prepared for the same call without it.

use crate::connections::{
    McpClient, McpServer, McpServers, MCP_APP_APPROVAL_VERSION, MCP_SEVERAL_VERSION,
    MCP_UNINSTALL_VERSION, UPDATE_APP_APPROVAL_VERSION,
};
use crate::grammar;
use crate::ipc::AppError;
use crate::label::{
    self, LabelIdentity, LabelKinds, LabelName, LabelWord, LABEL_APP_APPROVAL_VERSION,
};
use crate::launchers::Product;
use crate::rule_editor::{AnalyseProvider, Integration, RuleDocument, RuleVersion, TargetDocument};
use crate::search::{
    IndexBudget, ModelAddress, PersonId, PersonLabel, PersonLimit, QueryLimit, SearchAccounts,
    SearchChannel, SearchDirection, SearchHandle, SearchModel, SearchText, SEARCH_VERSION,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
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
checked_word!(
    /// An activity session's key: sixteen lowercase hex digits, as core makes it (0.29.0).
    SessionKey,
    grammar::session_key,
    "a session key"
);
checked_word!(
    /// A queue item's id: `qi_` and 26 of Crockford's letters, as the event service makes it (0.30.0).
    QueueItemId,
    grammar::queue_item_id,
    "a queue item id"
);
checked_word!(
    /// A rule's id, as the Queue screen filters by one (0.30.0): a word of letters, digits and `._:@-`.
    RuleId,
    grammar::rule_id,
    "a rule id"
);
checked_word!(
    /// A delivery's id (0.32.0, owner feedback §3.5): a word of letters, digits, `_` and `-`, as the event service's
    /// lowercase UUIDs are.
    DeliveryId,
    grammar::delivery_id,
    "a delivery id"
);
checked_word!(
    /// A lane's name (0.31.0, design 2026-10-25-routing §3.1): 1 to 40 lowercase letters, digits and `-`.
    LaneName,
    grammar::lane_name,
    "a lane name"
);
checked_word!(
    /// The agent window a lane is bound to (0.31.0, B1): a Claude Code session id (a lowercase UUID), or an activity
    /// session's key (sixteen lowercase hex digits).
    WindowId,
    grammar::window_id,
    "a window id"
);
checked_word!(
    /// An observed event's id (0.32.0, spec §3.6): 32 lowercase hex digits, as the event service derives it
    /// (`packages/events/src/identity/event-id.ts`).
    EventId,
    event_id,
    "an event id"
);
checked_word!(
    /// A message as core's `activity items` names one (0.32.0, spec §3.6): a Gmail message's id, or a Slack message's
    /// `<channel>/<ts>`. Neither has a comma, so a list of them is one `--ids` word.
    ItemId,
    item_id,
    "a message's id"
);

checked_word!(
    /// Where the last page of `messages list` ended, as the event service gave it in `next` (0.32.0):
    /// `<observedAt ms>:<eventId>`, the time in 2020 to 2099.
    MessagesCursor,
    messages_cursor,
    "a messages cursor"
);

/// A messages cursor: the 13 digits of a time in 2020 to 2099, in milliseconds, `:`, and an event id.
static MESSAGES_CURSOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^([1-9][0-9]{12}):[0-9a-f]{32}$").expect("a pattern"));

fn messages_cursor(value: &str) -> bool {
    grammar::plain(value)
        && MESSAGES_CURSOR
            .captures(value)
            .and_then(|parts| parts.get(1)?.as_str().parse::<u64>().ok())
            .is_some_and(|ms| EpochMs::try_from(ms).is_ok())
}

impl MessagesCursor {
    /// The time the cursor's page ended at.
    fn ms(&self) -> u64 {
        self.0
            .split(':')
            .next()
            .and_then(|ms| ms.parse().ok())
            .unwrap_or(0)
    }
}

/// Where a page of `messages list` ends (`--before`): a time, or the cursor the last page gave.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PageBefore {
    At(EpochMs),
    Cursor(MessagesCursor),
}

impl PageBefore {
    fn ms(&self) -> u64 {
        match self {
            PageBefore::At(ms) => u64::from(*ms),
            PageBefore::Cursor(cursor) => cursor.ms(),
        }
    }

    /// As `--before` takes it: the time, or the cursor as it came.
    fn word(&self) -> String {
        match self {
            PageBefore::At(ms) => u64::from(*ms).to_string(),
            PageBefore::Cursor(cursor) => cursor.as_str().to_string(),
        }
    }
}

/// An event id: 32 lowercase hex digits (D3's truncated SHA-256).
static EVENT_ID_PATTERN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[0-9a-f]{32}$").expect("a pattern"));

/// A Gmail message's id, as the activity log and a queue item's link carry one: 1 to 128 letters, digits, `_` and `-`.
static GMAIL_MESSAGE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[0-9A-Za-z_-]{1,128}$").expect("a pattern"));

/// A Slack message, as an event and `activity items` name one: the conversation's id (`C…`, `G…` or `D…`), `/`, and
/// its ts, seconds and six digits of microseconds.
static SLACK_ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[CDG][A-Z0-9]{2,31}/[0-9]{1,12}\.[0-9]{6}$").expect("a pattern")
});

fn event_id(value: &str) -> bool {
    grammar::plain(value) && EVENT_ID_PATTERN.is_match(value)
}

fn item_id(value: &str) -> bool {
    grammar::plain(value) && (GMAIL_MESSAGE_ID.is_match(value) || SLACK_ITEM.is_match(value))
}
checked_word!(
    /// A local model server's URL, for judge setup (0.32.0): plain HTTP to the literal `127.0.0.1` or `[::1]`, with
    /// its port. The event service checks it again.
    LoopbackUrl,
    grammar::loopback_url,
    "a local model server's URL on this machine: http://127.0.0.1:<port> or http://[::1]:<port>"
);
checked_word!(
    /// A local model's name, for judge setup (0.32.0): letters, digits and `._:/-`.
    LocalModel,
    grammar::local_model,
    "a local model's name"
);
checked_word!(
    /// A Linear team whose labels `integration show linear --team` lists (0.33.0): its key, or its id.
    LinearTeam,
    crate::rule_editor::linear_team,
    "a Linear team's key or id"
);
checked_word!(
    /// Where the event service finds the person's claude-stream relay (0.33.0, design §3.5): `default`, or the relay's
    /// home folder, whole and normal (`rule_editor::relay_home_setting`).
    RelayHomeSetting,
    crate::rule_editor::relay_home_setting,
    "the relay's home: default, or a whole folder"
);
checked_word!(
    /// A judge's id, as `judge show` names one (0.33.0): a letter or digit, then up to 127 letters, digits and `._:-`.
    JudgeId,
    crate::rule_editor::judge_id,
    "a judge id"
);
checked_word!(
    /// The fingerprint of a rule's activation, as `rule enable` binds it and its preview shows it (0.33.0): 64
    /// lowercase hex digits.
    Digest,
    crate::rule_editor::digest,
    "a digest"
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

/// How an agent's messages look in a Slack workspace (`label style <workspace> app|labelled`, 0.34.0's account page):
/// `app`, as the Agent Comms app with Slack's APP badge, a tightening applied at once; `labelled`, as the person, tagged
/// in the message's words, a loosening the person approves. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlackStyle {
    App,
    Labelled,
}

impl SlackStyle {
    pub fn word(self) -> &'static str {
        match self {
            SlackStyle::App => "app",
            SlackStyle::Labelled => "labelled",
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

/// The AI providers whose keys Jev uses (0.32.0, owner decision 2026-10-26): TypeSafe itself, and OpenRouter, which
/// serves TypeSafe's Jev. Closed: Settings → AI providers lists exactly these, and Jev's setup chooses one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    Typesafe,
    Openrouter,
}

impl AiProvider {
    pub const ALL: [AiProvider; 2] = [AiProvider::Typesafe, AiProvider::Openrouter];

    /// The provider as the events CLI names it.
    pub fn word(self) -> &'static str {
        match self {
            AiProvider::Typesafe => "typesafe",
            AiProvider::Openrouter => "openrouter",
        }
    }
}

/// The providers whose keys the event service keeps (0.33.0, design §3.3, §3.4): Jev's two, Anthropic, which Analyse may
/// run on, and Linear, whose personal API key Settings → Integrations connects. A key is set only through
/// `provider_key_set`, on stdin; a call names only which one to remove. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyProvider {
    Typesafe,
    Openrouter,
    Anthropic,
    Linear,
}

impl KeyProvider {
    pub const ALL: [KeyProvider; 4] = [
        KeyProvider::Typesafe,
        KeyProvider::Openrouter,
        KeyProvider::Anthropic,
        KeyProvider::Linear,
    ];

    /// The provider as the events CLI names it.
    pub fn word(self) -> &'static str {
        match self {
            KeyProvider::Typesafe => "typesafe",
            KeyProvider::Openrouter => "openrouter",
            KeyProvider::Anthropic => "anthropic",
            KeyProvider::Linear => "linear",
        }
    }

    /// Whether the event service has had this provider's key since 0.32.0: Jev's two did; Anthropic and Linear come in
    /// 0.33.0.
    fn since_judge_setup(self) -> bool {
        matches!(self, KeyProvider::Typesafe | KeyProvider::Openrouter)
    }
}

/// An approval that no longer waits, as `approvals list --state` takes it (design 2026-10-25-activity S5): approved,
/// used, failed, unknown, expired or revoked. Closed: core's `APPROVAL_STATES` less `pending` (Waiting's), `sending`
/// (a send in flight, for seconds) and `corrupt`. Approvals → Recent reads one list for each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FinishedApprovalState {
    Approved,
    Used,
    Failed,
    Unknown,
    Expired,
    Revoked,
}

impl FinishedApprovalState {
    pub const ALL: [FinishedApprovalState; 6] = [
        FinishedApprovalState::Approved,
        FinishedApprovalState::Used,
        FinishedApprovalState::Failed,
        FinishedApprovalState::Unknown,
        FinishedApprovalState::Expired,
        FinishedApprovalState::Revoked,
    ];

    /// The state as core names it.
    pub fn word(self) -> &'static str {
        match self {
            FinishedApprovalState::Approved => "approved",
            FinishedApprovalState::Used => "used",
            FinishedApprovalState::Failed => "failed",
            FinishedApprovalState::Unknown => "unknown",
            FinishedApprovalState::Expired => "expired",
            FinishedApprovalState::Revoked => "revoked",
        }
    }
}

/// What an activity line did, as `activity show --kind` takes it: core's `ACTIVITY_KINDS`. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Read,
    Write,
    Told,
    Approval,
}

impl ActivityKind {
    pub fn word(self) -> &'static str {
        match self {
            ActivityKind::Read => "read",
            ActivityKind::Write => "write",
            ActivityKind::Told => "told",
            ActivityKind::Approval => "approval",
        }
    }
}

/// How an activity line ended, as `activity show --outcome` takes it: core's `ACTIVITY_OUTCOMES`. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityOutcome {
    Ok,
    Refused,
    Failed,
}

impl ActivityOutcome {
    pub fn word(self) -> &'static str {
        match self {
            ActivityOutcome::Ok => "ok",
            ActivityOutcome::Refused => "refused",
            ActivityOutcome::Failed => "failed",
        }
    }
}

/// The channel an activity line is from, as `activity show --channel` takes it: core, the four channels this release
/// builds in (`channels.generated.ts`, `BuiltInChannel`), and `events`, the event service's delivery lines. Closed: a
/// channel word outside it is shown on a line, never passed on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityChannel {
    Core,
    Gmail,
    Slack,
    Resend,
    Whatsapp,
    Events,
}

impl ActivityChannel {
    pub fn word(self) -> &'static str {
        match self {
            ActivityChannel::Core => "core",
            ActivityChannel::Gmail => "gmail",
            ActivityChannel::Slack => "slack",
            ActivityChannel::Resend => "resend",
            ActivityChannel::Whatsapp => "whatsapp",
            ActivityChannel::Events => "events",
        }
    }
}

/// How far back the Activity screen reads (design 2026-10-25-activity §4.5): today, 7 days or 30 days; and the last 24
/// hours, which the Queue screen's lane picker reads recent agent windows over (0.31.0, design 2026-10-25-routing B1).
/// Closed: 24 hours, 7 and 30 days are core's spans; today is the start of the person's day, which only the window
/// knows the time zone of, so it arrives as a time Rust checks and writes itself. No text the window sends reaches
/// `--since`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ActivitySince {
    #[serde(rename = "today")]
    Today(StartOfToday),
    #[serde(rename = "24h")]
    Day,
    #[serde(rename = "7d")]
    SevenDays,
    #[serde(rename = "30d")]
    ThirtyDays,
}

impl ActivitySince {
    /// The range as `--since` takes it: an ISO time for today, a span for the others.
    pub fn word(self) -> String {
        match self {
            ActivitySince::Today(start) => iso_time(start.0),
            ActivitySince::Day => "24h".into(),
            ActivitySince::SevenDays => "7d".into(),
            ActivitySince::ThirtyDays => "30d".into(),
        }
    }
}

/// Which of the queue's items `queue list --state` reads (design 2026-10-25-action-queue §8): those waiting, those
/// marked done, those dismissed, or all of them. Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueState {
    Open,
    Done,
    Dismissed,
    All,
}

impl QueueState {
    pub const ALL: [QueueState; 4] = [
        QueueState::Open,
        QueueState::Done,
        QueueState::Dismissed,
        QueueState::All,
    ];

    /// The state as the event service names it.
    pub fn word(self) -> &'static str {
        match self {
            QueueState::Open => "open",
            QueueState::Done => "done",
            QueueState::Dismissed => "dismissed",
            QueueState::All => "all",
        }
    }
}

/// The channel a queue item came from, as `queue list --channel` takes it: the four channels the event service reads.
/// Closed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueChannel {
    Gmail,
    Slack,
    Resend,
    Whatsapp,
}

impl QueueChannel {
    pub const ALL: [QueueChannel; 4] = [
        QueueChannel::Gmail,
        QueueChannel::Slack,
        QueueChannel::Resend,
        QueueChannel::Whatsapp,
    ];

    pub fn word(self) -> &'static str {
        match self {
            QueueChannel::Gmail => "gmail",
            QueueChannel::Slack => "slack",
            QueueChannel::Resend => "resend",
            QueueChannel::Whatsapp => "whatsapp",
        }
    }
}

/// The most items one `queue list` reads.
pub const QUEUE_LIMIT_MAX: u64 = 200;

/// How many items `queue list --limit` reads: a whole number from 1 to `QUEUE_LIMIT_MAX`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct QueueLimit(u64);

impl TryFrom<u64> for QueueLimit {
    type Error = AppError;

    fn try_from(limit: u64) -> Result<Self, Self::Error> {
        if (1..=QUEUE_LIMIT_MAX).contains(&limit) {
            Ok(QueueLimit(limit))
        } else {
            Err(AppError::refused("a queue list reads 1 to 200 items"))
        }
    }
}

impl From<QueueLimit> for u64 {
    fn from(limit: QueueLimit) -> u64 {
        limit.0
    }
}

/// The most messages one `messages list` reads: the event service caps it there (plan, Task C).
pub const MESSAGES_LIMIT_MAX: u64 = 500;

/// How many messages `messages list --limit` reads: a whole number from 1 to `MESSAGES_LIMIT_MAX`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct MessagesLimit(u64);

impl TryFrom<u64> for MessagesLimit {
    type Error = AppError;

    fn try_from(limit: u64) -> Result<Self, Self::Error> {
        if (1..=MESSAGES_LIMIT_MAX).contains(&limit) {
            Ok(MessagesLimit(limit))
        } else {
            Err(AppError::refused("a messages list reads 1 to 500 messages"))
        }
    }
}

impl From<MessagesLimit> for u64 {
    fn from(limit: MessagesLimit) -> u64 {
        limit.0
    }
}

/// The first and the last millisecond a Messages time may be: 2020 to the end of 2099.
const EARLIEST_MS: u64 = 1_577_836_800_000;
const LATEST_MS: u64 = 4_102_444_800_000;

/// A moment as the Messages screen's reads take one (`--since`, `--before`): whole milliseconds since the epoch, in
/// 2020 to 2099. It is written as the number it is; no text the window sends reaches the words.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct EpochMs(u64);

impl TryFrom<u64> for EpochMs {
    type Error = AppError;

    fn try_from(ms: u64) -> Result<Self, Self::Error> {
        if (EARLIEST_MS..LATEST_MS).contains(&ms) {
            Ok(EpochMs(ms))
        } else {
            Err(AppError::refused(
                "a time is whole milliseconds since 1970, in 2020 to 2099",
            ))
        }
    }
}

impl From<EpochMs> for u64 {
    fn from(ms: EpochMs) -> u64 {
        ms.0
    }
}

/// The most messages one `activity items --ids` names.
pub const ITEM_IDS_MAX: usize = 50;

/// The messages `activity items --ids` reads: 1 to `ITEM_IDS_MAX` ids, none twice, written as one comma list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "Vec<ItemId>", into = "Vec<ItemId>")]
pub struct ItemIds(Vec<ItemId>);

impl TryFrom<Vec<ItemId>> for ItemIds {
    type Error = AppError;

    fn try_from(ids: Vec<ItemId>) -> Result<Self, Self::Error> {
        let repeated = ids
            .iter()
            .enumerate()
            .any(|(index, id)| ids[..index].contains(id));
        if ids.is_empty() || ids.len() > ITEM_IDS_MAX || repeated {
            Err(AppError::refused(
                "an activity read names 1 to 50 messages, each once",
            ))
        } else {
            Ok(ItemIds(ids))
        }
    }
}

impl From<ItemIds> for Vec<ItemId> {
    fn from(ids: ItemIds) -> Vec<ItemId> {
        ids.0
    }
}

impl ItemIds {
    /// The ids as `--ids` takes them: one comma list.
    fn word(&self) -> String {
        self.0
            .iter()
            .map(ItemId::as_str)
            .collect::<Vec<_>>()
            .join(",")
    }
}

/// The first and the last second a start of today may be: 2020 to the end of 2099.
const EARLIEST_TODAY: u64 = 1_577_836_800;
const LATEST_TODAY: u64 = 4_102_444_800;

/// When the person's today began, in whole seconds since the epoch, as the window's clock and time zone have it: a
/// whole minute (every zone's midnight is one), in 2020 to 2099.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct StartOfToday(u64);

impl TryFrom<u64> for StartOfToday {
    type Error = AppError;

    fn try_from(seconds: u64) -> Result<Self, Self::Error> {
        if seconds.is_multiple_of(60) && (EARLIEST_TODAY..LATEST_TODAY).contains(&seconds) {
            Ok(StartOfToday(seconds))
        } else {
            Err(AppError::refused(
                "the start of today is a whole minute, in seconds since 1970",
            ))
        }
    }
}

impl From<StartOfToday> for u64 {
    fn from(start: StartOfToday) -> u64 {
        start.0
    }
}

/// `seconds` since the epoch as the ISO time core reads (`activitySince`): `YYYY-MM-DDTHH:MM:SS.000Z`, in UTC.
fn iso_time(seconds: u64) -> String {
    let (year, month, day) = civil_date(seconds / 86_400);
    let rest = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// The Gregorian date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`, for days on or after the epoch).
fn civil_date(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    (year, month, day)
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
    /// Core `approvals list --state <state>` for a state that no longer waits (0.29.0's Approvals → Recent, design
    /// 2026-10-25-activity S5): read-only, and only the finished states.
    ApprovalsFinished { state: FinishedApprovalState },
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
    /// Core `behaviour allow <account> <acts> [--conversation <id>] --app-approval <id>` (0.34.0's account page): the
    /// person approved, in the app, the loosening the app prepared with an equal `BehaviourAllow`. Only an approval
    /// `cli` recorded for that very change is answered (`connections::run_app_approval`), once.
    BehaviourAllowApproved {
        account: AccountName,
        acts: Acts,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
        approval_id: ApprovalId,
    },
    /// Core `behaviour clear <account> [--conversation <id>] --app-approval <id>` (0.34.0): as `BehaviourAllowApproved`,
    /// for a removal the app prepared with an equal `BehaviourClear` whose fallback lets agents do more.
    BehaviourClearApproved {
        account: AccountName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
        approval_id: ApprovalId,
    },
    /// Core `label style <workspace> app|labelled` (0.34.0's account page; the command is 0.20.0's): `labelled`
    /// prepares a change, and `app`, a tightening, applies at once.
    LabelStyle {
        account: AccountName,
        style: SlackStyle,
    },
    /// Core `label style <workspace> labelled --app-approval <id>` (0.34.0): the person approved, in the app, the
    /// `labelled` the app prepared with an equal `LabelStyle`. `app` is refused here: a tightening takes no approval.
    LabelStyleApproved {
        account: AccountName,
        style: SlackStyle,
        approval_id: ApprovalId,
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
    /// Core `activity sessions --since <since>` (0.29.0): every agent session with activity in the range, newest
    /// first. Read-only.
    ActivitySessions { since: ActivitySince },
    /// Core `activity show <session> [--kind <kind>] [--channel <channel>] [--account <name>] [--outcome <outcome>]
    /// --since <since>` (0.29.0): one session's timeline. Read-only; every argument is a closed word or a checked one.
    ActivityShow {
        session: SessionKey,
        since: ActivitySince,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activity_kind: Option<ActivityKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<ActivityChannel>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        account: Option<AccountName>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outcome: Option<ActivityOutcome>,
    },
    /// The events service's `queue list --state <state> [--rule <id>] [--channel <channel>] [--since <since>] [--limit
    /// <n>]` (0.30.0, design 2026-10-25-action-queue §8): the queue's items, newest first, with what each says. A read,
    /// of content the person reads (Q1); every argument is a closed word or a checked one, and `since` is the Activity
    /// screen's closed range.
    QueueList {
        state: QueueState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rule: Option<RuleId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<QueueChannel>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<ActivitySince>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<QueueLimit>,
    },
    /// The events service's `queue counts` (0.30.0): how many items are open, done and dismissed, and each rule's open
    /// count. Content-free and read-only. It takes no argument.
    QueueCounts {},
    /// The events service's `queue done <item>` (0.30.0): marks one item done. It changes only the person's own list
    /// and takes nothing away from anyone, so the app applies it itself (DA10).
    QueueDone { item_id: QueueItemId },
    /// The events service's `queue dismiss <item>` (0.30.0): marks one item dismissed, as Done is applied (DA10).
    QueueDismiss { item_id: QueueItemId },
    /// The events service's `queue reopen <item>` (0.30.0): puts a done or dismissed item back among the open ones.
    QueueReopen { item_id: QueueItemId },
    /// The events service's `queue clear` (0.30.0): purges the done and dismissed items now, rather than at their
    /// retention. It takes no argument; the screen asks first.
    QueueClear {},
    /// The events service's `lane list` (0.31.0, design 2026-10-25-routing §3.7 and B1): each lane, its rules and
    /// channels, its open count, and the window bound to it. Content-free and read-only. It takes no argument.
    LaneList {},
    /// The events service's `lane unbind <lane>` (0.31.0, B1): ends a lane's binding. It takes a window's reading away
    /// and gives nothing, a tightening, so the app applies it itself (DA10); the screen asks first. Binding is never a
    /// call: the person binds at a terminal (`TerminalCommand::LaneBind`), so no agent can bind itself.
    LaneUnbind { lane: LaneName },
    /// The events service's `rule show <rule>` (0.32.0, owner feedback §3.4): each version of one rule, its document,
    /// its times, its sentence in parts and its counts of the last 7 days. Content-free and read-only. The rules
    /// calls are named outside `EventsJudge…`, which E2's static boundary keeps for Laya's two.
    EventsRuleShow { rule_id: RuleId },
    /// The events service's `rule disable <rule>` (0.32.0): turns a rule off at once. It takes away and gives nothing,
    /// a tightening, so the app applies it itself (DA10). Turning one on is never a call: the person approves it.
    EventsRuleDisable { rule_id: RuleId },
    /// The events service's `rule remove <rule>` (0.32.0): removes a rule at once, a tightening, as disable is. The
    /// screen asks first.
    EventsRuleRemove { rule_id: RuleId },
    /// The events service's `delivery show <delivery>` (0.32.0, §3.5): one delivery, its decision, its event's ids and
    /// times, and its target's kind and host. The person's read, refused inside an MCP server's process.
    EventsDeliveryShow { delivery_id: DeliveryId },
    /// The events service's `dryrun show <delivery>` (0.32.0, §3.5): one dry-run log entry, the would-be record as
    /// data. The person's read (D7, "at the terminal or in the app"); the screen shows each field a sender wrote as
    /// outside text.
    EventsDryrunShow { delivery_id: DeliveryId },
    /// The events service's `delivery retry <delivery>`: tries a delivery that will try again now, rather than at its
    /// next try. It sends nothing a rule did not already pass on, so the app applies it itself (DA10).
    EventsDeliveryRetry { delivery_id: DeliveryId },
    /// The events service's `delivery drop <delivery>`: stops a delivery that waits to be tried or will try again (its
    /// 0.32.0; one being sent is refused), or deletes a failed one's kept message. A tightening, applied at once; the
    /// screen asks first.
    EventsDeliveryDrop { delivery_id: DeliveryId },
    /// The events service's `provider list` (0.32.0): whether TypeSafe and OpenRouter each have a key, and never a key.
    /// Read-only; it takes no argument.
    ProviderList {},
    /// The events service's `provider key remove <provider>` (0.32.0): takes the person's key away, and the copy its
    /// Jev judges hold. Setting a key is never a call: the key goes to `provider_key_set`, which hands it to the CLI on
    /// stdin, so no word of it is ever a `Call`'s.
    ProviderKeyRemove { provider: KeyProvider },
    /// The events service's `judge setup typesafe --provider <provider>`, or `judge setup local-endpoint --url <url>
    /// [--model <name>]` (0.32.0, owner decision 2026-10-26): the person's own setup, which turns the kind on and
    /// approves its enablements as their act. Jev names its provider, whose stored key it uses; a local model server
    /// names its loopback URL. No other combination builds.
    JudgeSetup {
        judge_kind: EndpointJudgeKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<AiProvider>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<LoopbackUrl>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<LocalModel>,
    },
    /// Core `channels` (0.32.0's Connections, spec 2026-10-26-owner-feedback-0320 §3.3): every declared server, where it
    /// is installed, each client entry that starts it, and the client configs core could not read. Read-only, and it
    /// never returns an entry's `env`. It takes no argument.
    Channels {},
    /// Core `mcp install --client <client> --server <server>` (0.32.0's Connections): registers one server with one app,
    /// or from core 0.34.0 several, `--server <a,b,c>`, in one approval (`McpServers`). It prepares a change: core
    /// answers with its preview, and the person approves it (DA10). Every word is closed (`connections`), and nothing
    /// else rides along.
    McpInstall {
        client: McpClient,
        server: McpServers,
    },
    /// Core `mcp uninstall --client <client> --server <server>` (0.32.0): takes one server away from one app. It gives an
    /// agent nothing, a tightening, which core applies at once.
    McpUninstall {
        client: McpClient,
        server: McpServer,
    },
    /// Core `mcp install --client <client> --server <server> --app-approval <id>` (0.32.0, spec §3.3 and §5 question 3):
    /// the person approved, in the app, the install the app prepared with `McpInstall` — core approves that change
    /// through the app channel and applies it. Only an approval `cli` recorded for an equal `McpInstall` is answered
    /// (`connections::run_app_approval`), once.
    McpInstallApproved {
        client: McpClient,
        server: McpServers,
        approval_id: ApprovalId,
    },
    /// Core `update --check` (0.34.0's Connections): what is behind npm's latest release on this machine — each entry,
    /// runtime and global package — by the yardstick `update` itself uses. A read; it takes no argument.
    UpdateCheck {},
    /// Core `update` (0.34.0's Bring everything up to date): prepares a change, whose preview the person approves in
    /// the app (`UpdateApproved`), or in Terminal where nothing attests the app. It takes no argument.
    Update {},
    /// Core `update --app-approval <id>` (0.34.0): the person approved, in the app, the update the app prepared with
    /// `Update`. Only an approval `cli` recorded for it is answered (`connections::run_app_approval`), once.
    UpdateApproved { approval_id: ApprovalId },
    /// The events service's `messages list --since <ms> [--before <ms|cursor>] [--limit <n>]` (0.32.0, spec §3.6): the
    /// events it observed in the window, newest first, with each rule's decision, each delivery and the queue item. The
    /// person's read, refused inside an MCP server; every argument is a checked number or the cursor the last page
    /// gave, and a page ends after its window starts.
    EventsMessagesList {
        since: EpochMs,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        before: Option<PageBefore>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<MessagesLimit>,
    },
    /// The events service's `message show <eventId>` (0.32.0): one event's entry, with its queue item's full history.
    EventsMessageShow { event_id: EventId },
    /// The events service's `targets list` (0.33.0's rule editor): every target version's id, version and digest, so a
    /// changed target is given the next version. Content-free and read-only.
    EventsTargetsList {},
    /// The events service's `target add -` (0.33.0): a new target the rule editor needs, its document on stdin. A
    /// target version is inert until a rule the person approves names it.
    EventsTargetAdd { document: TargetDocument },
    /// The events service's `target update -` (0.33.0): a target's next version, its document on stdin, as `target
    /// add` takes one.
    EventsTargetUpdate { document: TargetDocument },
    /// The events service's `rule create -` (0.33.0, design §3.1): a new rule the person wrote in the app, its document
    /// on stdin. A version is inert until the person approves it.
    EventsRuleCreate { document: RuleDocument },
    /// The events service's `rule update -` (0.33.0): a rule's next version, its document on stdin. The version that
    /// runs keeps running until the person approves this one.
    EventsRuleUpdate { document: RuleDocument },
    /// The events service's `rule enable <rule> <version>` (0.33.0): prepares that version's activation, the D2
    /// approval the person answers in the app. Rust records the approval it comes back with, and its digest, as the
    /// app's own (`terminal::Prepared`): only that one `eventsRuleApprove` answers, and the preview's Cancel revokes.
    EventsRuleEnable {
        rule_id: RuleId,
        version: RuleVersion,
    },
    /// The events service's `approval view <approval> --digest <digest>` (0.33.0): the activation's own preview, for
    /// the review the person reads. Its challenges are taken out before the window sees it (`rule_editor`).
    EventsApprovalView {
        approval_id: ApprovalId,
        digest: Digest,
    },
    /// The events service's `rule approve <approval> --digest <digest>` (0.33.0, design §3.1): the person pressed
    /// Approve in the app, after the preview of exactly this digest. Only an approval `eventsRuleEnable` recorded for
    /// this digest is answered (`connections::run_app_approval`), once; the CLI refuses an agent and, on macOS, a
    /// process the app did not start.
    EventsRuleApprove {
        approval_id: ApprovalId,
        digest: Digest,
    },
    /// The events service's `enable-all` (0.34.0 design B4, Events → Service → Switch on…): prepares the standing
    /// approval that starts collection, and approves nothing. Rust records the approval it comes back with, and its
    /// digest, as the app's own (`terminal::Prepared`): only that one `eventsCollectionApprove` answers it, `approve
    /// <approval-id>` opens for it at a terminal, and the preview's Cancel revokes it. It takes no argument.
    EventsEnableAll {},
    /// The events service's `collection approve <approval> --digest <digest>` (0.34.0 design B4): the person pressed
    /// Approve in the app, after the preview of exactly this digest, and the event service switches collection on. Only
    /// an approval `eventsEnableAll` recorded for this digest is answered (`connections::run_app_approval`), once; the
    /// CLI refuses an agent and, on macOS, a process the app did not start.
    EventsCollectionApprove {
        approval_id: ApprovalId,
        digest: Digest,
    },
    /// The events service's `disable-all` (0.34.0 design B4, Events → Service → Switch off): switches collection off at
    /// once. It takes away and gives nothing, a tightening, so the app applies it itself (DA10), once the person
    /// confirms; its answer's `said` is what it did, in plain words. It takes no argument.
    EventsDisableAll {},
    /// The events service's `rule analyse <rule> [--draft -] [--provider <openrouter|anthropic>]` (0.33.0, design
    /// §3.3): suggestions for a rule, or for the unsaved draft on stdin, its model on the provider the person picked.
    /// The person's read, refused inside an MCP server and to an agent's shell; it applies nothing.
    EventsRuleAnalyse {
        rule_id: RuleId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        draft: Option<RuleDocument>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<AnalyseProvider>,
    },
    /// The events service's `integration show <linear|agent-sessions> [--team <team>]` (0.33.0, design §3.4, §3.5):
    /// whether Linear is connected, the workspace and teams its key sees, and with a team that team's labels; or the
    /// relay the agent-session target reaches and how it answers. Never a key or a token. Only Linear takes a team.
    IntegrationShow {
        integration: Integration,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        team: Option<LinearTeam>,
    },
    /// The events service's `integration set agent-sessions --relay-home <default|folder>` (0.33.0, design §3.5): where
    /// the agent-session target finds the person's relay, the person's own setting (refused to an agent and, on macOS,
    /// to a process the app did not start). The token in that folder is never a call's.
    IntegrationSetAgentSessions { relay_home: RelayHomeSetting },
    /// The events service's `judge show <judge> [--version <n>]` (0.33.0): one judge version's exact canonical document,
    /// its digest and whether it is live, which the rule editor embeds in a rule as the event service will approve it.
    /// Configuration only — a judge's key is a separate secret, never in it — and read-only.
    JudgeShow {
        judge_id: JudgeId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<RuleVersion>,
    },
    /// The events service's `session-queue list` (0.33.0, design §3.5): the matches waiting for a busy agent session,
    /// oldest first — ids and times, content-free. The person's read, refused inside an MCP server. No argument.
    SessionQueueList {},
    /// The events service's `session-queue drop <delivery>` (0.33.0): drops one waiting match — its delivery is
    /// cancelled and what it held purged — a tightening the app applies itself (DA10), once the person confirms.
    SessionQueueDrop { delivery_id: DeliveryId },
    /// Core's `activity items --since <ms> [--ids <id,…>]` (0.32.0, spec §3.6): every activity line that names a
    /// message, grouped by the message's id. The person's read, like `activity show`; the ids are checked ones.
    ActivityItems {
        since: EpochMs,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ids: Option<ItemIds>,
    },
    /// Core `label word <word> [--app-approval <id>]` (0.34.0's Your agents, `label`): the word after the person's
    /// name. Without `appApproval` it prepares a change — a new word loosens, and core answers with its preview; with
    /// it, the person approved in the app the change the app prepared (`connections::run_app_approval`), once.
    LabelWord {
        word: LabelWord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `label name <name> [--app-approval <id>]` (0.34.0): the person's name, for where a channel has none of its
    /// own. Prepared and approved as `labelWord` is.
    LabelName {
        name: LabelName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `label rule add <account> [--conversation <id>] [--kinds <kind,…>] --as agent|me [--app-approval <id>]`
    /// (0.34.0): an exception to the tag. `--as me` loosens and is prepared, then approved in the app; `--as agent`
    /// applies at once, and is never given the app's approval.
    LabelRuleAdd {
        account: AccountName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kinds: Option<LabelKinds>,
        #[serde(rename = "as")]
        identity: LabelIdentity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `label rule remove <account> [--conversation <id>] [--kinds <kind,…>] --as agent|me [--app-approval <id>]`
    /// (0.34.0): an exception taken away, as it is listed. Taking away a `me` rule applies at once; an `agent` rule is
    /// prepared, then approved in the app.
    LabelRuleRemove {
        account: AccountName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation: Option<ConversationId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        kinds: Option<LabelKinds>,
        #[serde(rename = "as")]
        identity: LabelIdentity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `search status` (0.35.0, design 2026-10-26-local-search §8, `search`): on or off, the accounts, what is
    /// kept by count and size and for how long, the local model's state, backups and disk encryption. Content-free.
    SearchStatus {},
    /// Core `search query [--person <id>] [--account <name>]… [--channel gmail|slack] [--since <ms>] [--until <ms>]
    /// [--direction in|out|any] [--limit <n>] -- <words>` (0.35.0): what people asked, by words and by meaning, on this
    /// machine. The person's read, refused inside an MCP server and to an agent's shell (S13); the words go last, after
    /// `--`.
    SearchQuery {
        text: SearchText,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        person: Option<PersonId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        accounts: Option<SearchAccounts>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        channel: Option<SearchChannel>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<EpochMs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until: Option<EpochMs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<SearchDirection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<QueryLimit>,
    },
    /// Core `search people [--since <ms>]` (0.35.0, S5): every person a message is kept from, their handles, the latest
    /// name they gave, how many messages and when they last wrote. The person's read.
    SearchPeople {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<EpochMs>,
    },
    /// Core `search person <id> [--since <ms>] [--limit <n>]` (0.35.0): what one person sent, newest first, a line each.
    SearchPerson {
        person_id: PersonId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        since: Option<EpochMs>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        limit: Option<PersonLimit>,
    },
    /// Core `search show <sourceId>` (0.35.0): one kept message in full, and the replies sent to it.
    SearchShow { source_id: ItemId },
    /// Core `search index [--budget <seconds>]` (0.35.0, S10): keeps what agents read since the last run, makes missing
    /// vectors for the budget, and deletes what is past Activity's days. Upkeep, refused to an agent.
    SearchIndex {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget: Option<IndexBudget>,
    },
    /// Core `search rebuild [--budget <seconds>]` (0.35.0): every vector made again from the kept text; the old ones
    /// serve meanwhile.
    SearchRebuild {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        budget: Option<IndexBudget>,
    },
    /// Core `search link <person> <person>` (0.35.0, S5): the second person is the first. Only the person joins people;
    /// it is their own data, applied at once.
    SearchLink {
        person_id: PersonId,
        other_id: PersonId,
    },
    /// Core `search unlink <handle>` (0.35.0): an address or a Slack user becomes a person of its own again.
    SearchUnlink { handle: SearchHandle },
    /// Core `search label <person> -- <name>` (0.35.0): the name the person knows someone by.
    SearchLabel {
        person_id: PersonId,
        label: PersonLabel,
    },
    /// Core `search on [--app-approval <id>]` (0.35.0, S1): a loosening. Without `appApproval` it is prepared, and core
    /// answers with its preview; with it, the person approved in the app the change the app prepared, once.
    SearchOn {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `search off` (0.35.0): a tightening, applied at once. What is kept stays until its days pass.
    SearchOff {},
    /// Core `search accounts add <account> [--app-approval <id>]` (0.35.0): a loosening, prepared and approved as
    /// `searchOn` is.
    SearchAccountsAdd {
        account: AccountName,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `search accounts remove <account>` (0.35.0): a tightening, applied at once; what is kept of it is deleted.
    SearchAccountsRemove { account: AccountName },
    /// Core `search model set <address> <model> [--app-approval <id>]` (0.35.0, S9): meaning too, with a model of the
    /// reviewed list that Ollama runs at this machine's loopback address. A loosening, prepared and approved as `searchOn`
    /// is.
    SearchModelSet {
        address: ModelAddress,
        model: SearchModel,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        app_approval: Option<ApprovalId>,
    },
    /// Core `search model none` (0.35.0): words only, applied at once; every vector is dropped.
    SearchModelNone {},
    /// Core `search delete --all --confirm` (0.35.0, §7): everything Search keeps, and its key, deleted at once, once
    /// the person confirms in the app. It takes no argument.
    SearchDeleteAll {},
}

/// The first release of the events service that ships phase E2's Laya calls (DA12): an older one says "Update
/// agent-communications to use this".
pub const LAYA_JUDGE_VERSION: &str = "0.25.0";

/// The first release of the events service with judges (Phase E, CHANGELOG 0.17.0): its `judge kinds list` answers the
/// typesafe and local-endpoint kinds and `judges list` the inventory, where 0.16.0 answered each with Phase E's typed
/// placeholder. An older one says "Update agent-communications to use this" (DA12).
pub const JUDGE_KINDS_VERSION: &str = "0.17.0";

/// The first release of core with the activity log (design 2026-10-25-activity): its `activity sessions` and
/// `activity show`. An older one says "Needs 0.29.0 or later" (DA12).
pub const ACTIVITY_VERSION: &str = "0.29.0";

/// The first release of the events service with the action queue (design 2026-10-25-action-queue): its `queue list`,
/// `counts`, `done`, `dismiss`, `reopen` and `clear`. An older one says "Needs 0.30.0 or later" (DA12).
pub const QUEUE_VERSION: &str = "0.30.0";

/// The first release of the events service with lanes (design 2026-10-25-routing): its `lane list`, `lane unbind` and
/// `lane bind`. An older one says "Needs 0.31.0 or later" (DA12).
pub const LANES_VERSION: &str = "0.31.0";

/// The first release of the events service whose `delivery show` exists and whose `dryrun show --json` answers the app
/// (owner feedback 0.32.0, §3.5). An older one says "Needs 0.32.0 or later" (DA12).
pub const DELIVERY_DETAIL_VERSION: &str = "0.32.0";

/// The first release of the events service with judge setup and AI provider keys (owner decision 2026-10-26): its
/// `judge setup`, `provider list` and `provider key set|remove`. An older one keeps Turn on in Terminal (DA12).
pub const JUDGE_SETUP_VERSION: &str = "0.32.0";

/// The first release of the events service with the rule editor's calls (design 2026-10-26-rules-that-act-0330):
/// documents on stdin, `rule approve`, `rule analyse`, `integration show|set`, and the Anthropic and Linear keys. An older
/// one keeps the rule's page as it was, and says "Needs 0.33.0 or later" (DA12).
pub const RULE_EDITOR_VERSION: &str = "0.33.0";

/// The first release of the events service whose switch the app turns (0.34.0 design B4): `collection approve`, which
/// the app answers its own `enable-all` with, and `disable-all` that says what it did. Preparing `enable-all` needs only
/// `RULE_EDITOR_VERSION`, whose approval view and terminal `approve` an older one still has: there Switch on… is
/// approved in Terminal, and Switch off is not offered.
pub const COLLECTION_SWITCH_VERSION: &str = "0.34.0";

/// The first release with the Messages screen's reads (spec 2026-10-26-owner-feedback-0320 §3.6): the events service's
/// `messages list` and `message show`, and core's `activity items`. An older one says "Needs 0.32.0 or later" (DA12).
pub const MESSAGES_VERSION: &str = "0.32.0";

/// The first core whose `behaviour allow|clear` and `label style` take the app's own approval, `--app-approval` (0.34.0,
/// spec 2026-10-26-desktop-0340 §B2): an older one keeps Approve in Terminal for each loosening.
pub const ACCOUNT_APP_APPROVAL_VERSION: &str = "0.34.0";

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
/// An install the person approved in the app: it may fetch a runtime and start the server to prove it (0.32.0).
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
/// An update the person approved in the app (0.34.0): it may fetch and verify a runtime for every server, register
/// entries again and prove each starts, so it has the longest of any call.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(600);
const DOCTOR_TIMEOUT: Duration = Duration::from_secs(90);
/// Judge setup prepares, approves and claims up to two enablements, so it has longer than a read.
const SETUP_TIMEOUT: Duration = Duration::from_secs(60);

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

/// `--app-approval <id>`: the person's press in the app, answering the approval the app prepared (0.34.0).
fn app_approval(id: &ApprovalId) -> [String; 2] {
    ["--app-approval".to_string(), id.as_str().to_string()]
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
            Call::ApprovalsFinished { state } => {
                core(&["approvals", "list", "--state", state.word()])
            }
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
            Call::BehaviourAllowApproved {
                account,
                acts,
                conversation: id,
                approval_id,
            } => with(
                core(&["behaviour", "allow", account.as_str(), acts.as_str()]),
                conversation(id)
                    .into_iter()
                    .chain(app_approval(approval_id)),
            ),
            Call::BehaviourClearApproved {
                account,
                conversation: id,
                approval_id,
            } => with(
                core(&["behaviour", "clear", account.as_str()]),
                conversation(id)
                    .into_iter()
                    .chain(app_approval(approval_id)),
            ),
            Call::LabelStyle { account, style } => {
                core(&["label", "style", account.as_str(), style.word()])
            }
            Call::LabelStyleApproved {
                account,
                style,
                approval_id,
            } => {
                if *style != SlackStyle::Labelled {
                    return Err(AppError::refused(
                        "the app's style applies at once: it takes no approval",
                    ));
                }
                with(
                    core(&["label", "style", account.as_str(), style.word()]),
                    app_approval(approval_id),
                )
            }
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
            Call::ActivitySessions { since } => {
                with(core(&["activity", "sessions", "--since"]), [since.word()])
            }
            Call::ActivityShow {
                session,
                since,
                activity_kind,
                channel,
                account,
                outcome,
            } => {
                let option = |flag: &str, value: Option<&str>| {
                    value
                        .map(|value| [flag.to_string(), value.to_string()])
                        .into_iter()
                        .flatten()
                };
                with(
                    core(&["activity", "show", session.as_str()]),
                    option("--kind", activity_kind.map(ActivityKind::word))
                        .chain(option("--channel", channel.map(ActivityChannel::word)))
                        .chain(option(
                            "--account",
                            account.as_ref().map(AccountName::as_str),
                        ))
                        .chain(option("--outcome", outcome.map(ActivityOutcome::word)))
                        .chain(["--since".to_string(), since.word()]),
                )
            }
            Call::QueueList {
                state,
                rule,
                channel,
                since,
                limit,
            } => {
                let option = |flag: &str, value: Option<String>| {
                    value
                        .map(|value| [flag.to_string(), value])
                        .into_iter()
                        .flatten()
                };
                with(
                    events(&["queue", "list", "--state", state.word()]),
                    option("--rule", rule.as_ref().map(|id| id.as_str().to_string()))
                        .chain(option(
                            "--channel",
                            channel.map(|channel| channel.word().to_string()),
                        ))
                        .chain(option("--since", since.map(ActivitySince::word)))
                        .chain(option(
                            "--limit",
                            limit.map(|limit| u64::from(limit).to_string()),
                        )),
                )
            }
            Call::QueueCounts {} => events(&["queue", "counts"]),
            Call::QueueDone { item_id } => events(&["queue", "done", item_id.as_str()]),
            Call::QueueDismiss { item_id } => events(&["queue", "dismiss", item_id.as_str()]),
            Call::QueueReopen { item_id } => events(&["queue", "reopen", item_id.as_str()]),
            Call::QueueClear {} => events(&["queue", "clear"]),
            Call::LaneList {} => events(&["lane", "list"]),
            Call::LaneUnbind { lane } => events(&["lane", "unbind", lane.as_str()]),
            Call::EventsRuleShow { rule_id } => events(&["rule", "show", rule_id.as_str()]),
            Call::EventsRuleDisable { rule_id } => events(&["rule", "disable", rule_id.as_str()]),
            Call::EventsRuleRemove { rule_id } => events(&["rule", "remove", rule_id.as_str()]),
            Call::EventsDeliveryShow { delivery_id } => {
                events(&["delivery", "show", delivery_id.as_str()])
            }
            Call::EventsDryrunShow { delivery_id } => {
                events(&["dryrun", "show", delivery_id.as_str()])
            }
            Call::EventsDeliveryRetry { delivery_id } => {
                events(&["delivery", "retry", delivery_id.as_str()])
            }
            Call::EventsDeliveryDrop { delivery_id } => {
                events(&["delivery", "drop", delivery_id.as_str()])
            }
            Call::ProviderList {} => events(&["provider", "list"]),
            Call::ProviderKeyRemove { provider } => {
                events(&["provider", "key", "remove", provider.word()])
            }
            Call::JudgeSetup {
                judge_kind,
                provider,
                url,
                model,
            } => {
                let words = match judge_kind {
                    EndpointJudgeKind::Typesafe => {
                        if url.is_some() || model.is_some() {
                            return Err(AppError::refused(
                                "Jev's setup takes its provider, not a URL or a model",
                            ));
                        }
                        let Some(provider) = provider else {
                            return Err(AppError::refused("Jev's setup names its provider"));
                        };
                        events(&["judge", "setup", "typesafe", "--provider", provider.word()])
                    }
                    EndpointJudgeKind::LocalEndpoint => {
                        if provider.is_some() {
                            return Err(AppError::refused(
                                "a local model server's setup takes its URL, not a provider",
                            ));
                        }
                        let Some(url) = url else {
                            return Err(AppError::refused(
                                "a local model server's setup names its URL",
                            ));
                        };
                        with(
                            events(&["judge", "setup", "local-endpoint", "--url", url.as_str()]),
                            model.iter().flat_map(|name| {
                                ["--model".to_string(), name.as_str().to_string()]
                            }),
                        )
                    }
                };
                Words {
                    timeout: SETUP_TIMEOUT,
                    ..words
                }
            }
            Call::Channels {} => core(&["channels"]),
            // A first install may read the release's document and verify it before it shows its preview.
            Call::McpInstall { client, server } => Words {
                timeout: DOCTOR_TIMEOUT,
                ..with(
                    core(&["mcp", "install", "--client", client.word(), "--server"]),
                    [server.word()],
                )
            },
            Call::McpUninstall { client, server } => core(&[
                "mcp",
                "uninstall",
                "--client",
                client.word(),
                "--server",
                server.word(),
            ]),
            // It registers, fetches a runtime when one is needed, and proves the server starts.
            Call::McpInstallApproved {
                client,
                server,
                approval_id,
            } => Words {
                timeout: INSTALL_TIMEOUT,
                ..with(
                    core(&["mcp", "install", "--client", client.word(), "--server"]),
                    [
                        server.word(),
                        "--app-approval".to_string(),
                        approval_id.as_str().to_string(),
                    ],
                )
            },
            // It reads npm's registry and verifies the latest release before it answers.
            Call::UpdateCheck {} => Words {
                timeout: DOCTOR_TIMEOUT,
                ..core(&["update", "--check"])
            },
            // Its preview is planned as `--check` reads, from the registry and the verified release.
            Call::Update {} => Words {
                timeout: DOCTOR_TIMEOUT,
                ..core(&["update"])
            },
            // It fetches and verifies every runtime behind, registers entries again and switches launchers.
            Call::UpdateApproved { approval_id } => Words {
                timeout: UPDATE_TIMEOUT,
                ..core(&["update", "--app-approval", approval_id.as_str()])
            },
            Call::EventsMessagesList {
                since,
                before,
                limit,
            } => {
                if before
                    .as_ref()
                    .is_some_and(|before| before.ms() <= u64::from(*since))
                {
                    return Err(AppError::refused(
                        "a page of messages ends after its window starts",
                    ));
                }
                let option = |flag: &str, value: Option<String>| {
                    value
                        .map(|value| [flag.to_string(), value])
                        .into_iter()
                        .flatten()
                };
                with(
                    events(&["messages", "list", "--since"]),
                    std::iter::once(u64::from(*since).to_string())
                        .chain(option("--before", before.as_ref().map(PageBefore::word)))
                        .chain(option(
                            "--limit",
                            limit.map(|limit| u64::from(limit).to_string()),
                        )),
                )
            }
            Call::EventsMessageShow { event_id } => events(&["message", "show", event_id.as_str()]),
            Call::ActivityItems { since, ids } => with(
                core(&["activity", "items", "--since"]),
                std::iter::once(u64::from(*since).to_string())
                    .chain(ids.iter().flat_map(|ids| ["--ids".to_string(), ids.word()])),
            ),
            Call::EventsTargetsList {} => events(&["targets", "list"]),
            Call::EventsTargetAdd { .. } => events(&["target", "add", "-"]),
            Call::EventsTargetUpdate { .. } => events(&["target", "update", "-"]),
            Call::EventsRuleCreate { .. } => events(&["rule", "create", "-"]),
            Call::EventsRuleUpdate { .. } => events(&["rule", "update", "-"]),
            Call::EventsRuleEnable { rule_id, version } => with(
                events(&["rule", "enable", rule_id.as_str()]),
                [u64::from(*version).to_string()],
            ),
            Call::EventsApprovalView {
                approval_id,
                digest,
            } => events(&[
                "approval",
                "view",
                approval_id.as_str(),
                "--digest",
                digest.as_str(),
            ]),
            // It approves, and completes the activation: as long as judge setup's.
            Call::EventsRuleApprove {
                approval_id,
                digest,
            } => Words {
                timeout: SETUP_TIMEOUT,
                ..events(&[
                    "rule",
                    "approve",
                    approval_id.as_str(),
                    "--digest",
                    digest.as_str(),
                ])
            },
            Call::EventsEnableAll {} => events(&["enable-all"]),
            // It approves, and completes switching on: as long as a rule's approval.
            Call::EventsCollectionApprove {
                approval_id,
                digest,
            } => Words {
                timeout: SETUP_TIMEOUT,
                ..events(&[
                    "collection",
                    "approve",
                    approval_id.as_str(),
                    "--digest",
                    digest.as_str(),
                ])
            },
            Call::EventsDisableAll {} => events(&["disable-all"]),
            // A model may write some of its suggestions: as long as a doctor's.
            Call::EventsRuleAnalyse {
                rule_id,
                draft,
                provider,
            } => Words {
                timeout: DOCTOR_TIMEOUT,
                ..with(
                    events(&["rule", "analyse", rule_id.as_str()]),
                    draft
                        .iter()
                        .flat_map(|_| ["--draft".to_string(), "-".to_string()])
                        .chain(provider.iter().flat_map(|provider| {
                            ["--provider".to_string(), provider.word().to_string()]
                        })),
                )
            },
            Call::IntegrationShow { integration, team } => {
                if team.is_some() && *integration != Integration::Linear {
                    return Err(AppError::refused(
                        "only Linear's integration lists a team's labels",
                    ));
                }
                with(
                    events(&["integration", "show", integration.word()]),
                    team.iter()
                        .flat_map(|team| ["--team".to_string(), team.as_str().to_string()]),
                )
            }
            Call::IntegrationSetAgentSessions { relay_home } => events(&[
                "integration",
                "set",
                "agent-sessions",
                "--relay-home",
                relay_home.as_str(),
            ]),
            Call::JudgeShow { judge_id, version } => {
                let mut words = events(&["judge", "show", judge_id.as_str()]);
                if let Some(version) = version {
                    words = with(
                        words,
                        ["--version".to_owned(), u64::from(*version).to_string()],
                    );
                }
                words
            }
            Call::SessionQueueList {} => events(&["session-queue", "list"]),
            Call::SessionQueueDrop { delivery_id } => {
                events(&["session-queue", "drop", delivery_id.as_str()])
            }
            Call::LabelWord { word, app_approval } => with(
                core(&["label", "word", word.word()]),
                label::app_approval_words(app_approval),
            ),
            Call::LabelName { name, app_approval } => with(
                core(&["label", "name", name.as_str()]),
                label::app_approval_words(app_approval),
            ),
            Call::LabelRuleAdd {
                account,
                conversation,
                kinds,
                identity,
                app_approval,
            } => with(
                core(&["label", "rule", "add", account.as_str()]),
                label::rule_words(
                    conversation.as_ref().map(ConversationId::as_str),
                    kinds,
                    *identity,
                    app_approval,
                ),
            ),
            Call::LabelRuleRemove {
                account,
                conversation,
                kinds,
                identity,
                app_approval,
            } => with(
                core(&["label", "rule", "remove", account.as_str()]),
                label::rule_words(
                    conversation.as_ref().map(ConversationId::as_str),
                    kinds,
                    *identity,
                    app_approval,
                ),
            ),
            // Search on this machine (0.35.0): its own module builds core's `search …` words.
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
            | Call::SearchDeleteAll {} => return self.search_words(),
        })
    }

    /// The document the call hands the CLI on stdin (0.33.0), compact JSON: a target or a rule the editor wrote, or the
    /// draft Analyse reads. None for every other call, whose stdin stays closed.
    pub fn input(&self) -> Option<Vec<u8>> {
        match self {
            Call::EventsTargetAdd { document } | Call::EventsTargetUpdate { document } => {
                Some(document.bytes())
            }
            Call::EventsRuleCreate { document } | Call::EventsRuleUpdate { document } => {
                Some(document.bytes())
            }
            Call::EventsRuleAnalyse {
                draft: Some(draft), ..
            } => Some(draft.bytes()),
            _ => None,
        }
    }

    /// Whether the call may come back `APPROVAL_PENDING` with a change the app prepared, to be opened in the terminal
    /// (DA10): the six change shapes, `update` (0.34.0), the label's four changes without the app's approval (0.34.0),
    /// a Slack style of `labelled` (0.34.0's account page; `app` applies at once), and Search's three loosenings
    /// without the app's approval (0.35.0), and only those.
    pub fn prepares_change(&self) -> bool {
        matches!(
            self,
            Call::UpdateLevel { .. }
                | Call::UpdateRollback {}
                | Call::UpdateBackgroundJob { on: true }
                | Call::McpInstall { .. }
                | Call::Update {}
                | Call::BehaviourAllow { .. }
                | Call::BehaviourClear { .. }
                | Call::LabelWord {
                    app_approval: None,
                    ..
                }
                | Call::LabelName {
                    app_approval: None,
                    ..
                }
                | Call::LabelRuleAdd {
                    app_approval: None,
                    ..
                }
                | Call::LabelRuleRemove {
                    app_approval: None,
                    ..
                }
                | Call::LabelStyle {
                    style: SlackStyle::Labelled,
                    ..
                }
        ) || self.prepares_search_change()
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
            Call::ActivitySessions { .. } | Call::ActivityShow { .. } => Some(ACTIVITY_VERSION),
            Call::QueueList { .. }
            | Call::QueueCounts {}
            | Call::QueueDone { .. }
            | Call::QueueDismiss { .. }
            | Call::QueueReopen { .. }
            | Call::QueueClear {} => Some(QUEUE_VERSION),
            Call::LaneList {} | Call::LaneUnbind { .. } => Some(LANES_VERSION),
            Call::EventsDeliveryShow { .. } | Call::EventsDryrunShow { .. } => {
                Some(DELIVERY_DETAIL_VERSION)
            }
            Call::ProviderKeyRemove { provider } if !provider.since_judge_setup() => {
                Some(RULE_EDITOR_VERSION)
            }
            Call::ProviderList {} | Call::ProviderKeyRemove { .. } | Call::JudgeSetup { .. } => {
                Some(JUDGE_SETUP_VERSION)
            }
            Call::McpUninstall { .. } => Some(MCP_UNINSTALL_VERSION),
            Call::McpInstall { server, .. } | Call::McpInstallApproved { server, .. }
                if server.several() =>
            {
                Some(MCP_SEVERAL_VERSION)
            }
            Call::McpInstallApproved { .. } => Some(MCP_APP_APPROVAL_VERSION),
            Call::UpdateCheck {} | Call::Update {} | Call::UpdateApproved { .. } => {
                Some(UPDATE_APP_APPROVAL_VERSION)
            }
            Call::BehaviourAllowApproved { .. }
            | Call::BehaviourClearApproved { .. }
            | Call::LabelStyleApproved { .. } => Some(ACCOUNT_APP_APPROVAL_VERSION),
            Call::EventsMessagesList { .. }
            | Call::EventsMessageShow { .. }
            | Call::ActivityItems { .. } => Some(MESSAGES_VERSION),
            Call::EventsTargetsList {}
            | Call::EventsTargetAdd { .. }
            | Call::EventsTargetUpdate { .. }
            | Call::EventsRuleCreate { .. }
            | Call::EventsRuleUpdate { .. }
            | Call::EventsRuleEnable { .. }
            | Call::EventsApprovalView { .. }
            | Call::EventsRuleApprove { .. }
            | Call::EventsRuleAnalyse { .. }
            | Call::IntegrationShow { .. }
            | Call::IntegrationSetAgentSessions { .. }
            | Call::JudgeShow { .. }
            | Call::SessionQueueList {}
            | Call::SessionQueueDrop { .. }
            | Call::EventsEnableAll {} => Some(RULE_EDITOR_VERSION),
            Call::EventsCollectionApprove { .. } | Call::EventsDisableAll {} => {
                Some(COLLECTION_SWITCH_VERSION)
            }
            Call::LabelWord { .. }
            | Call::LabelName { .. }
            | Call::LabelRuleAdd { .. }
            | Call::LabelRuleRemove { .. } => Some(LABEL_APP_APPROVAL_VERSION),
            call if call.is_search() => Some(SEARCH_VERSION),
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

/// The events service's `provider key set <provider>` (0.32.0, owner decision 2026-10-26; Anthropic and Linear since
/// 0.33.0): the one command whose input is a secret. It is no `Call`, so no word the window sends can carry a key:
/// `provider_key_set` builds these words and hands the key to the CLI on stdin (`runner::run_with_input`), never in argv.
pub fn provider_key_set(provider: KeyProvider) -> Words {
    events(&["provider", "key", "set", provider.word()])
}

/// One of every call the allow-list knows, with the JSON the UI sends for it: the rows of the plan's table.
#[cfg(test)]
pub(crate) fn samples() -> Vec<(Call, serde_json::Value)> {
    use serde_json::json;
    let values = [
        json!({ "kind": "version", "product": "core" }),
        json!({ "kind": "version", "product": "events-daemon" }),
        json!({ "kind": "approvalsPending" }),
        json!({ "kind": "approvalsFinished", "state": "approved" }),
        json!({ "kind": "approvalsFinished", "state": "used" }),
        json!({ "kind": "approvalsFinished", "state": "failed" }),
        json!({ "kind": "approvalsFinished", "state": "unknown" }),
        json!({ "kind": "approvalsFinished", "state": "expired" }),
        json!({ "kind": "approvalsFinished", "state": "revoked" }),
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
        json!({ "kind": "behaviourAllowApproved", "account": "example/slack", "acts": "post,reply", "approvalId": ID }),
        json!({ "kind": "behaviourAllowApproved", "account": "example/gmail", "acts": "reply", "conversation": "@example.com", "approvalId": ID }),
        json!({ "kind": "behaviourClearApproved", "account": "example/slack", "approvalId": ID }),
        json!({ "kind": "behaviourClearApproved", "account": "example/gmail", "conversation": "@example.com", "approvalId": ID }),
        json!({ "kind": "labelStyle", "account": "example/slack", "style": "app" }),
        json!({ "kind": "labelStyle", "account": "example/slack", "style": "labelled" }),
        json!({ "kind": "labelStyleApproved", "account": "example/slack", "style": "labelled", "approvalId": ID }),
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
        json!({ "kind": "activitySessions", "since": "7d" }),
        json!({ "kind": "activitySessions", "since": "30d" }),
        json!({ "kind": "activitySessions", "since": { "today": TODAY } }),
        json!({ "kind": "activitySessions", "since": "24h" }),
        json!({ "kind": "activityShow", "session": SESSION, "since": "7d" }),
        json!({
            "kind": "activityShow",
            "session": SESSION,
            "since": { "today": TODAY },
            "activityKind": "read",
            "channel": "gmail",
            "account": "example/gmail",
            "outcome": "refused"
        }),
        json!({ "kind": "queueList", "state": "open" }),
        json!({ "kind": "queueList", "state": "done" }),
        json!({ "kind": "queueList", "state": "dismissed" }),
        json!({ "kind": "queueList", "state": "all" }),
        json!({
            "kind": "queueList",
            "state": "open",
            "rule": "rule-1",
            "channel": "slack",
            "since": "7d",
            "limit": 100
        }),
        json!({ "kind": "queueCounts" }),
        json!({ "kind": "queueDone", "itemId": QUEUE_ITEM }),
        json!({ "kind": "queueDismiss", "itemId": QUEUE_ITEM }),
        json!({ "kind": "queueReopen", "itemId": QUEUE_ITEM }),
        json!({ "kind": "queueClear" }),
        json!({ "kind": "laneList" }),
        json!({ "kind": "laneUnbind", "lane": "david" }),
        json!({ "kind": "eventsRuleShow", "ruleId": "mail-subject" }),
        json!({ "kind": "eventsRuleDisable", "ruleId": "mail-subject" }),
        json!({ "kind": "eventsRuleRemove", "ruleId": "mail-subject" }),
        json!({ "kind": "eventsDeliveryShow", "deliveryId": DELIVERY }),
        json!({ "kind": "eventsDryrunShow", "deliveryId": DELIVERY }),
        json!({ "kind": "eventsDeliveryRetry", "deliveryId": DELIVERY }),
        json!({ "kind": "eventsDeliveryDrop", "deliveryId": DELIVERY }),
        json!({ "kind": "providerList" }),
        json!({ "kind": "providerKeyRemove", "provider": "typesafe" }),
        json!({ "kind": "providerKeyRemove", "provider": "openrouter" }),
        json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "typesafe" }),
        json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter" }),
        json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint", "url": "http://127.0.0.1:11434" }),
        json!({
            "kind": "judgeSetup",
            "judgeKind": "local-endpoint",
            "url": "http://[::1]:8080",
            "model": "nimble"
        }),
        json!({ "kind": "channels" }),
        json!({ "kind": "mcpInstall", "client": "claude-code", "server": "gmail" }),
        json!({ "kind": "mcpUninstall", "client": "cursor", "server": "events" }),
        json!({ "kind": "mcpInstallApproved", "client": "claude-code", "server": "gmail", "approvalId": ID }),
        json!({ "kind": "mcpInstall", "client": "codex", "server": ["core", "gmail", "events"] }),
        json!({ "kind": "mcpInstallApproved", "client": "codex", "server": ["core", "gmail", "events"], "approvalId": ID }),
        json!({ "kind": "updateCheck" }),
        json!({ "kind": "update" }),
        json!({ "kind": "updateApproved", "approvalId": ID }),
        json!({ "kind": "eventsMessagesList", "since": SINCE_MS }),
        json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": BEFORE_MS, "limit": 100 }),
        json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": "1792972800000:0123456789abcdef0123456789abcdef" }),
        json!({ "kind": "eventsMessageShow", "eventId": EVENT_ID }),
        json!({ "kind": "activityItems", "since": SINCE_MS }),
        json!({ "kind": "activityItems", "since": SINCE_MS, "ids": ["18c2f0a1b2c3d4e5", "C0123ABCD/1792886400.000100"] }),
        json!({ "kind": "providerKeyRemove", "provider": "anthropic" }),
        json!({ "kind": "providerKeyRemove", "provider": "linear" }),
        json!({ "kind": "eventsTargetsList" }),
        json!({ "kind": "eventsTargetAdd", "document": TARGET_DOCUMENT.clone() }),
        json!({ "kind": "eventsTargetUpdate", "document": TARGET_DOCUMENT.clone() }),
        json!({ "kind": "eventsRuleCreate", "document": RULE_DOCUMENT.clone() }),
        json!({ "kind": "eventsRuleUpdate", "document": RULE_DOCUMENT.clone() }),
        json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": 3 }),
        json!({ "kind": "eventsApprovalView", "approvalId": ID, "digest": DIGEST }),
        json!({ "kind": "eventsRuleApprove", "approvalId": ID, "digest": DIGEST }),
        json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices" }),
        json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "draft": RULE_DOCUMENT.clone() }),
        json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "provider": "anthropic" }),
        json!({
            "kind": "eventsRuleAnalyse",
            "ruleId": "invoices",
            "draft": RULE_DOCUMENT.clone(),
            "provider": "openrouter"
        }),
        json!({ "kind": "integrationShow", "integration": "linear" }),
        json!({ "kind": "integrationShow", "integration": "agent-sessions" }),
        json!({ "kind": "integrationShow", "integration": "linear", "team": "CUE" }),
        json!({ "kind": "integrationSetAgentSessions", "relayHome": "default" }),
        json!({ "kind": "integrationSetAgentSessions", "relayHome": "/example/home/.local/state/agent-relay" }),
        json!({ "kind": "sessionQueueList" }),
        json!({ "kind": "sessionQueueDrop", "deliveryId": DELIVERY }),
        json!({ "kind": "judgeShow", "judgeId": "jev" }),
        json!({ "kind": "judgeShow", "judgeId": "local-model", "version": 2 }),
        json!({ "kind": "labelWord", "word": "assistant" }),
        json!({ "kind": "labelWord", "word": "AI", "appApproval": ID }),
        json!({ "kind": "labelName", "name": "Jo Example" }),
        json!({ "kind": "labelName", "name": "Jo Example", "appApproval": ID }),
        json!({ "kind": "labelRuleAdd", "account": "example/slack", "kinds": "reaction", "as": "me" }),
        json!({ "kind": "labelRuleAdd", "account": "example/gmail", "conversation": "@example.com", "as": "me", "appApproval": ID }),
        json!({ "kind": "labelRuleRemove", "account": "example/slack", "as": "me" }),
        json!({ "kind": "labelRuleRemove", "account": "example/slack", "conversation": "C0123ABCD", "kinds": "reply,reaction", "as": "agent", "appApproval": ID }),
        json!({ "kind": "eventsEnableAll" }),
        json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": DIGEST }),
        json!({ "kind": "eventsDisableAll" }),
        json!({ "kind": "searchStatus" }),
        json!({ "kind": "searchQuery", "text": "invoices" }),
        json!({
            "kind": "searchQuery",
            "text": "-what did David ask?",
            "person": "p_K19FVJ41QS08HPWN3XC3RQ2K7B",
            "accounts": ["acme/gmail", "acme/slack"],
            "channel": "gmail",
            "since": SINCE_MS,
            "until": BEFORE_MS,
            "direction": "any",
            "limit": 50
        }),
        json!({ "kind": "searchPeople" }),
        json!({ "kind": "searchPeople", "since": SINCE_MS }),
        json!({ "kind": "searchPerson", "personId": "p_K19FVJ41QS08HPWN3XC3RQ2K7B" }),
        json!({ "kind": "searchPerson", "personId": "p_K19FVJ41QS08HPWN3XC3RQ2K7B", "since": SINCE_MS, "limit": 50 }),
        json!({ "kind": "searchShow", "sourceId": "18c2f0a1b2c3d4e5" }),
        json!({ "kind": "searchIndex" }),
        json!({ "kind": "searchIndex", "budget": 20 }),
        json!({ "kind": "searchRebuild", "budget": 20 }),
        json!({ "kind": "searchLink", "personId": "p_K19FVJ41QS08HPWN3XC3RQ2K7B", "otherId": "p_8GE1HWF42A0071A07VARPJWX1D" }),
        json!({ "kind": "searchUnlink", "handle": "slack:T0ACME/U0DAVID" }),
        json!({ "kind": "searchLabel", "personId": "p_K19FVJ41QS08HPWN3XC3RQ2K7B", "label": "David Park" }),
        json!({ "kind": "searchOn" }),
        json!({ "kind": "searchOn", "appApproval": ID }),
        json!({ "kind": "searchOff" }),
        json!({ "kind": "searchAccountsAdd", "account": "acme/slack" }),
        json!({ "kind": "searchAccountsAdd", "account": "acme/slack", "appApproval": ID }),
        json!({ "kind": "searchAccountsRemove", "account": "acme/gmail" }),
        json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434", "model": "qwen3-embedding:0.6b" }),
        json!({ "kind": "searchModelSet", "address": "http://[::1]:11434", "model": "bge-m3:latest", "appApproval": ID }),
        json!({ "kind": "searchModelNone" }),
        json!({ "kind": "searchDeleteAll" }),
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

/// A well-formed digest, for the tests: 64 lowercase hex digits.
#[cfg(test)]
pub(crate) const DIGEST: &str = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";

/// A rule document as the editor makes one, for the tests: made up, nobody's.
#[cfg(test)]
pub(crate) static RULE_DOCUMENT: LazyLock<serde_json::Value> = LazyLock::new(|| {
    serde_json::json!({
        "ruleId": "invoices",
        "version": 3,
        "condition": { "path": "/subject", "op": "contains", "value": "invoice", "caseSensitive": false },
        "targets": [{ "targetId": "invoices-log", "version": 1, "kind": "dry-run", "retentionMs": 86400000 }]
    })
});

/// A target document as the editor makes one, for the tests.
#[cfg(test)]
pub(crate) static TARGET_DOCUMENT: LazyLock<serde_json::Value> = LazyLock::new(
    || serde_json::json!({ "targetId": "invoices-log", "version": 2, "kind": "dry-run", "retentionMs": 43200000 }),
);

/// A well-formed activity session key, for the tests.
#[cfg(test)]
pub(crate) const SESSION: &str = "3f9a1c2e7b4d5a60";

/// A well-formed queue item id, for the tests: `qi_` and 26 of Crockford's letters.
#[cfg(test)]
pub(crate) const QUEUE_ITEM: &str = "qi_01J9Z8QF0000000000000000AB";

/// A well-formed delivery id, for the tests: a lowercase UUID, as the event service makes one.
#[cfg(test)]
pub(crate) const DELIVERY: &str = "0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70";

/// The start of 2026-10-25 in UTC, as seconds since the epoch: a today, for the tests.
#[cfg(test)]
pub(crate) const TODAY: u64 = 1_792_886_400;

/// A well-formed event id, for the tests: 32 lowercase hex digits, as the event service makes them.
#[cfg(test)]
pub(crate) const EVENT_ID: &str = "0123456789abcdef0123456789abcdef";

/// The start of 2026-10-25 in UTC, and of the next day, as milliseconds: a window for the Messages screen's tests.
#[cfg(test)]
pub(crate) const SINCE_MS: u64 = 1_792_886_400_000;
#[cfg(test)]
pub(crate) const BEFORE_MS: u64 = 1_792_972_800_000;

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
            for (index, word) in words.words.iter().enumerate() {
                // `rule approve` (0.33.0) is the person's press in the app, and answers only the activation the app
                // prepared, for its digest (`connections::run_app_approval`); `approve`, the typed approval at a
                // terminal, is never a call.
                let rule_approve = matches!(call, Call::EventsRuleApprove { .. })
                    && index == 1
                    && words.words[0] == "rule";
                // `collection approve` (0.34.0) is the same press, for switching on: it answers only the `enable-all`
                // the app prepared, for its digest.
                let collection_approve = matches!(call, Call::EventsCollectionApprove { .. })
                    && index == 1
                    && words.words[0] == "collection";
                assert!(
                    !word.starts_with("--approval")
                        && (word != "approve" || rule_approve || collection_approve)
                        && word != "--yes",
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
    fn only_the_seven_change_shapes_prepare() {
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
                json!({ "kind": "labelStyle", "account": "example/slack", "style": "labelled" }),
                json!({ "kind": "mcpInstall", "client": "claude-code", "server": "gmail" }),
                json!({ "kind": "mcpInstall", "client": "codex", "server": ["core", "gmail", "events"] }),
                json!({ "kind": "update" }),
                json!({ "kind": "labelWord", "word": "assistant" }),
                json!({ "kind": "labelName", "name": "Jo Example" }),
                json!({ "kind": "labelRuleAdd", "account": "example/slack", "kinds": "reaction", "as": "me" }),
                json!({ "kind": "labelRuleRemove", "account": "example/slack", "as": "me" }),
                json!({ "kind": "searchOn" }),
                json!({ "kind": "searchAccountsAdd", "account": "acme/slack" }),
                json!({ "kind": "searchModelSet", "address": "http://127.0.0.1:11434", "model": "qwen3-embedding:0.6b" }),
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

    /// The whole line a call runs: the launcher, its words, `--json`, then the four pins, and nothing else.
    fn whole_line(value: serde_json::Value) -> Vec<String> {
        let folders = crate::paths::Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        };
        let program = crate::launchers::Program {
            program: "/home/example/.local/share/agent-communications/launch/core".into(),
            leading: vec![],
        };
        let built = call(value.clone()).words().expect("words");
        assert_eq!(built.product, Product::Core, "{value}");
        assert_eq!(built.shape, Shape::Envelope, "{value}");
        assert!(built.pins, "{value}");
        assert!(built.quiet_updates, "{value}");
        assert_eq!(built.timeout, Duration::from_secs(30), "{value}");
        let line = crate::runner::argv(&built, &program, &folders, true);
        let mut tail = vec!["--json".to_string()];
        tail.extend(folders.pins());
        assert!(line.ends_with(&tail), "{value}: {line:?}");
        assert_eq!(line[0], program.program, "{value}");
        line[1..line.len() - tail.len()].to_vec()
    }

    /// Approvals → Recent (S5): `approvals list --state <state>` for each finished state, and only those.
    #[test]
    fn finished_approvals_list_each_finished_state_and_no_other() {
        for state in FinishedApprovalState::ALL {
            let word = state.word();
            assert_eq!(
                whole_line(json!({ "kind": "approvalsFinished", "state": word })),
                ["approvals", "list", "--state", word]
            );
            assert_eq!(
                serde_json::to_value(state).expect("json"),
                json!(word),
                "{word}"
            );
        }
        assert_eq!(
            FinishedApprovalState::ALL.map(FinishedApprovalState::word),
            ["approved", "used", "failed", "unknown", "expired", "revoked"]
        );
        // Waiting's state is Waiting's call; a send in flight, a corrupt record and any other word are no state here.
        for state in [
            json!("pending"),
            json!("sending"),
            json!("corrupt"),
            json!("answered"),
            json!("Used"),
            json!("used "),
            json!("used --json"),
            json!(""),
            json!(null),
            json!(["used"]),
            json!(7),
        ] {
            refused(json!({ "kind": "approvalsFinished", "state": state }));
        }
        refused(json!({ "kind": "approvalsFinished" }));
        refused(json!({ "kind": "approvalsFinished", "state": "used", "inbox": "example/gmail" }));
        refused(json!({ "kind": "approvalsFinished", "state": "used", "approvalId": ID }));
        // Pending stays a call of its own, without a state.
        refused(json!({ "kind": "approvalsPending", "state": "pending" }));
        for state in FinishedApprovalState::ALL {
            let call = Call::ApprovalsFinished { state };
            assert_eq!(call.needs(), None, "{state:?}");
            assert!(!call.prepares_change(), "{state:?}");
        }
    }

    /// The activity calls (0.29.0): `activity sessions` and `activity show`, each with `--since` from the closed range,
    /// and `show`'s filters each a closed word, or an account name the grammar checks.
    #[test]
    fn activity_calls_build_exactly_their_words() {
        assert_eq!(
            whole_line(json!({ "kind": "activitySessions", "since": "7d" })),
            ["activity", "sessions", "--since", "7d"]
        );
        assert_eq!(
            whole_line(json!({ "kind": "activitySessions", "since": "30d" })),
            ["activity", "sessions", "--since", "30d"]
        );
        assert_eq!(
            whole_line(json!({ "kind": "activitySessions", "since": { "today": TODAY } })),
            [
                "activity",
                "sessions",
                "--since",
                "2026-10-25T00:00:00.000Z"
            ]
        );
        assert_eq!(
            whole_line(json!({ "kind": "activityShow", "session": SESSION, "since": "7d" })),
            ["activity", "show", SESSION, "--since", "7d"]
        );
        assert_eq!(
            whole_line(json!({
                "kind": "activityShow",
                "session": SESSION,
                "since": { "today": 1_792_882_800u64 },
                "activityKind": "approval",
                "channel": "whatsapp",
                "account": "example/gmail-work",
                "outcome": "failed"
            })),
            [
                "activity",
                "show",
                SESSION,
                "--kind",
                "approval",
                "--channel",
                "whatsapp",
                "--account",
                "example/gmail-work",
                "--outcome",
                "failed",
                "--since",
                "2026-10-24T23:00:00.000Z"
            ]
        );
        for (field, value, flag) in [
            ("activityKind", "told", "--kind"),
            ("channel", "core", "--channel"),
            ("channel", "events", "--channel"),
            ("account", "work", "--account"),
            ("outcome", "ok", "--outcome"),
        ] {
            let mut given = json!({ "kind": "activityShow", "session": SESSION, "since": "30d" });
            given[field] = json!(value);
            assert_eq!(
                whole_line(given),
                ["activity", "show", SESSION, flag, value, "--since", "30d"],
                "{field}"
            );
        }
        for value in [
            json!({ "kind": "activitySessions", "since": "7d" }),
            json!({ "kind": "activityShow", "session": SESSION, "since": "7d" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.29.0"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(ACTIVITY_VERSION, "0.29.0");
        assert!(!crate::version::at_least("0.28.0", ACTIVITY_VERSION));
        assert!(crate::version::at_least("0.29.0", ACTIVITY_VERSION));
        assert!(crate::version::at_least(
            "0.29.0-feat-0.29",
            ACTIVITY_VERSION
        ));
    }

    /// Nothing the window sends reaches the activity commands' words unchecked: the key matches core's exactly, every
    /// filter is a closed word, the account is a name, and the range is 7 or 30 days or a whole-minute start of today.
    #[test]
    fn activity_calls_refuse_every_word_outside_their_shapes() {
        for session in [
            json!(""),
            json!("3f9a1c2e7b4d5a6"),
            json!("3f9a1c2e7b4d5a600"),
            json!("3F9A1C2E7B4D5A60"),
            json!("3f9a1c2e7b4d5a6g"),
            json!("-f9a1c2e7b4d5a60"),
            json!("3f9a1c2e7b4d5a60 --json"),
            json!("3f9a1c2e7b4d5a60\n"),
            json!("../../etc/passwd"),
            json!(7),
            json!(null),
        ] {
            refused(json!({ "kind": "activityShow", "session": session, "since": "7d" }));
        }
        for since in [
            json!("today"),
            json!("1d"),
            json!("7"),
            json!("12h"),
            json!("365d"),
            json!("2026-10-25T00:00:00.000Z"),
            json!("7d --kind read"),
            json!({ "today": 1_792_886_401u64 }),
            json!({ "today": 1_792_886_430u64 }),
            json!({ "today": 0 }),
            json!({ "today": 1_577_836_740u64 }),
            json!({ "today": 4_102_444_800u64 }),
            json!({ "today": -60 }),
            json!({ "today": "1792886400" }),
            json!({ "today": 1_792_886_400.5 }),
            json!({ "today": 1_792_886_400u64, "zone": "Europe/London" }),
            json!({ "yesterday": 1_792_886_400u64 }),
            json!(null),
            json!(7),
        ] {
            refused(json!({ "kind": "activitySessions", "since": since }));
            refused(json!({ "kind": "activityShow", "session": SESSION, "since": since }));
        }
        // `since` is never left out: the range is always the screen's.
        refused(json!({ "kind": "activitySessions" }));
        refused(json!({ "kind": "activityShow", "session": SESSION }));
        refused(json!({ "kind": "activityShow", "since": "7d" }));
        for (field, value) in [
            ("activityKind", json!("Read")),
            ("activityKind", json!("send")),
            ("activityKind", json!("read,write")),
            ("activityKind", json!("")),
            ("channel", json!("teams")),
            ("channel", json!("events-daemon")),
            ("channel", json!("Gmail")),
            ("channel", json!("gmail --json")),
            ("account", json!("Example/gmail")),
            ("account", json!("-x")),
            ("account", json!("example/gmail --outcome ok")),
            ("account", json!("in_01EXAMPLE0000000000000000")),
            ("outcome", json!("success")),
            ("outcome", json!("OK")),
            ("kind", json!("read")),
            ("since", json!("forever")),
            ("limit", json!(5)),
            ("mine", json!(true)),
            ("approval", json!(ID)),
            ("args", json!(["--all"])),
        ] {
            let mut given = json!({ "kind": "activityShow", "session": SESSION, "since": "7d" });
            if field == "kind" {
                // The filter is `activityKind`: a second `kind` is no field of a call.
                let text = format!(
                    r#"{{"kind":"activityShow","session":"{SESSION}","since":"7d","kind":{value}}}"#
                );
                assert!(serde_json::from_str::<Call>(&text).is_err(), "{text}");
                continue;
            }
            given[field] = value;
            refused(given);
        }
        refused(json!({ "kind": "activitySessions", "since": "7d", "session": SESSION }));
        refused(json!({ "kind": "activitySessions", "since": "7d", "channel": "gmail" }));
        // `mine` and the settings are no call of the app's: the app reads, and never changes what is recorded.
        for kind in [
            "activityMine",
            "activitySettings",
            "activityRecord",
            "activityRetention",
        ] {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "since": "7d" }));
        }
    }

    /// The whole line an events call runs: the events launcher, its words, `--json`, then the four pins, and nothing
    /// else; and the words alone, back.
    fn events_line(value: serde_json::Value) -> Vec<String> {
        let folders = crate::paths::Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        };
        let program = crate::launchers::Program {
            program: "/home/example/.local/share/agent-communications/launch/events-daemon".into(),
            leading: vec![],
        };
        let built = call(value.clone()).words().expect("words");
        assert_eq!(built.product, Product::EventsDaemon, "{value}");
        assert_eq!(built.shape, Shape::Bare, "{value}");
        assert!(built.pins, "{value}");
        assert!(built.quiet_updates, "{value}");
        assert_eq!(built.timeout, Duration::from_secs(30), "{value}");
        let line = crate::runner::argv(&built, &program, &folders, true);
        let mut tail = vec!["--json".to_string()];
        tail.extend(folders.pins());
        assert!(line.ends_with(&tail), "{value}: {line:?}");
        assert_eq!(line[0], program.program, "{value}");
        line[1..line.len() - tail.len()].to_vec()
    }

    /// The queue's calls (0.30.0, design 2026-10-25-action-queue §8): the two reads and the four changes the app applies
    /// itself, each the events launcher, its words, `--json` and the pins, and nothing else.
    #[test]
    fn queue_calls_build_exactly_their_words() {
        for state in QueueState::ALL {
            let word = state.word();
            assert_eq!(
                events_line(json!({ "kind": "queueList", "state": word })),
                ["queue", "list", "--state", word]
            );
            assert_eq!(serde_json::to_value(state).expect("json"), json!(word));
        }
        assert_eq!(
            QueueState::ALL.map(QueueState::word),
            ["open", "done", "dismissed", "all"]
        );
        assert_eq!(
            events_line(json!({
                "kind": "queueList",
                "state": "open",
                "rule": "rule-1",
                "channel": "slack",
                "since": "7d",
                "limit": 100
            })),
            [
                "queue",
                "list",
                "--state",
                "open",
                "--rule",
                "rule-1",
                "--channel",
                "slack",
                "--since",
                "7d",
                "--limit",
                "100"
            ]
        );
        assert_eq!(
            events_line(
                json!({ "kind": "queueList", "state": "done", "since": { "today": TODAY } })
            ),
            [
                "queue",
                "list",
                "--state",
                "done",
                "--since",
                "2026-10-25T00:00:00.000Z"
            ]
        );
        for channel in QueueChannel::ALL {
            assert_eq!(
                events_line(
                    json!({ "kind": "queueList", "state": "all", "channel": channel.word() })
                ),
                [
                    "queue",
                    "list",
                    "--state",
                    "all",
                    "--channel",
                    channel.word()
                ]
            );
        }
        assert_eq!(
            QueueChannel::ALL.map(QueueChannel::word),
            ["gmail", "slack", "resend", "whatsapp"]
        );
        for (limit, word) in [(1u64, "1"), (50, "50"), (200, "200")] {
            assert_eq!(
                events_line(json!({ "kind": "queueList", "state": "open", "limit": limit })),
                ["queue", "list", "--state", "open", "--limit", word]
            );
        }
        assert_eq!(
            events_line(json!({ "kind": "queueCounts" })),
            ["queue", "counts"]
        );
        for (kind, verb) in [
            ("queueDone", "done"),
            ("queueDismiss", "dismiss"),
            ("queueReopen", "reopen"),
        ] {
            assert_eq!(
                events_line(json!({ "kind": kind, "itemId": QUEUE_ITEM })),
                ["queue", verb, QUEUE_ITEM]
            );
        }
        assert_eq!(
            events_line(json!({ "kind": "queueClear" })),
            ["queue", "clear"]
        );
        // Every one needs the first events service with the queue, and none prepares a change: the reads change
        // nothing, and done, dismiss, reopen and clear change only the person's own list, which the app applies (DA10).
        for value in [
            json!({ "kind": "queueList", "state": "open" }),
            json!({ "kind": "queueCounts" }),
            json!({ "kind": "queueDone", "itemId": QUEUE_ITEM }),
            json!({ "kind": "queueDismiss", "itemId": QUEUE_ITEM }),
            json!({ "kind": "queueReopen", "itemId": QUEUE_ITEM }),
            json!({ "kind": "queueClear" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.30.0"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(QUEUE_VERSION, "0.30.0");
        assert!(!crate::version::at_least("0.29.0", QUEUE_VERSION));
        assert!(!crate::version::at_least("0.29.9", QUEUE_VERSION));
        assert!(crate::version::at_least("0.30.0", QUEUE_VERSION));
        assert!(crate::version::at_least("0.30.0-feat-0.30", QUEUE_VERSION));
    }

    /// Nothing the window sends reaches the queue's words unchecked: the item id matches the event service's exactly,
    /// the state, channel and range are closed words, the rule a checked id, the limit 1 to 200, and no call takes a
    /// field it does not name.
    #[test]
    fn queue_calls_refuse_bad_ids_enums_and_extra_fields() {
        for item in [
            json!(""),
            json!("qi_"),
            json!("qi_01J9Z8QF0000000000000000A"),
            json!("qi_01J9Z8QF0000000000000000ABC"),
            json!("qi_01J9Z8QF0000000000000000AI"),
            json!("qi_01J9Z8QF0000000000000000AL"),
            json!("qi_01J9Z8QF0000000000000000AO"),
            json!("qi_01J9Z8QF0000000000000000AU"),
            json!("qi_01j9z8qf0000000000000000ab"),
            json!("QI_01J9Z8QF0000000000000000AB"),
            json!("ap_0123456789ABCDEFGHJKMNPQRS"),
            json!("-qi_01J9Z8QF0000000000000000A"),
            json!("qi_01J9Z8QF0000000000000000AB --json"),
            json!("qi_01J9Z8QF0000000000000000AB\n"),
            json!(" qi_01J9Z8QF0000000000000000AB"),
            json!("../qi_01J9Z8QF0000000000000000"),
            json!("--all"),
            json!(7),
            json!(null),
            json!(["qi_01J9Z8QF0000000000000000AB"]),
            json!({ "id": "qi_01J9Z8QF0000000000000000AB" }),
        ] {
            for kind in ["queueDone", "queueDismiss", "queueReopen"] {
                refused(json!({ "kind": kind, "itemId": item }));
            }
        }
        for kind in ["queueDone", "queueDismiss", "queueReopen"] {
            // The item is never left out, and is named `itemId`, nothing else.
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "id": QUEUE_ITEM }));
            refused(json!({ "kind": kind, "item": QUEUE_ITEM }));
            for (field, value) in [
                ("state", json!("done")),
                ("approval", json!(ID)),
                ("approvalId", json!(ID)),
                ("args", json!(["--all"])),
                ("json", json!(false)),
                ("force", json!(true)),
                ("rule", json!("rule-1")),
            ] {
                let mut given = json!({ "kind": kind, "itemId": QUEUE_ITEM });
                given[field] = value;
                refused(given);
            }
        }
        for state in [
            json!("pending"),
            json!("closed"),
            json!("expired"),
            json!("Open"),
            json!("OPEN"),
            json!("open "),
            json!("open --json"),
            json!("open,done"),
            json!(""),
            json!(null),
            json!(7),
            json!(["open"]),
        ] {
            refused(json!({ "kind": "queueList", "state": state }));
        }
        // The state is always said: the screen asks for one tab's items.
        refused(json!({ "kind": "queueList" }));
        // A filter left out, or given as null, is no filter: the words carry none.
        assert_eq!(
            events_line(
                json!({ "kind": "queueList", "state": "open", "channel": null, "limit": null })
            ),
            ["queue", "list", "--state", "open"]
        );
        for (field, value) in [
            ("channel", json!("events")),
            ("channel", json!("core")),
            ("channel", json!("Gmail")),
            ("channel", json!("teams")),
            ("channel", json!("gmail --json")),
            ("channel", json!("")),
            ("rule", json!("")),
            ("rule", json!("-r")),
            ("rule", json!("--json")),
            ("rule", json!("rule 1")),
            ("rule", json!("rule-1 --state all")),
            ("rule", json!("rule\n")),
            ("rule", json!("rule\u{202e}")),
            ("rule", json!("r".repeat(129))),
            ("rule", json!(7)),
            ("rule", json!(["rule-1"])),
            ("since", json!("1d")),
            ("since", json!("today")),
            ("since", json!("365d")),
            ("since", json!("2026-10-25T00:00:00.000Z")),
            ("since", json!("7d --limit 5")),
            ("since", json!({ "today": 1_792_886_401u64 })),
            ("since", json!({ "today": 0 })),
            ("since", json!(7)),
            ("limit", json!(0)),
            ("limit", json!(201)),
            ("limit", json!(-1)),
            ("limit", json!(1.5)),
            ("limit", json!("100")),
            ("account", json!("example/gmail")),
            ("itemId", json!(QUEUE_ITEM)),
            ("show", json!(true)),
            ("content", json!(false)),
            ("approval", json!(ID)),
            ("args", json!(["--all"])),
        ] {
            let mut given = json!({ "kind": "queueList", "state": "open" });
            given[field] = value;
            refused(given);
        }
        for kind in ["queueCounts", "queueClear"] {
            for (field, value) in [
                ("state", json!("done")),
                ("itemId", json!(QUEUE_ITEM)),
                ("rule", json!("rule-1")),
                ("approval", json!(ID)),
                ("args", json!(["--all"])),
                ("force", json!(true)),
            ] {
                let mut given = json!({ "kind": kind });
                given[field] = value;
                refused(given);
            }
        }
        // What the queue's CLI has besides, the app never calls: `show` reads one item it already listed, `items` is
        // the agents' content-free list, and nothing approves, deletes or reads an item another way.
        for kind in [
            "queueShow",
            "queueItems",
            "queueApprove",
            "queueDelete",
            "queueRead",
            "queueOpen",
            "queuePurge",
            "queue",
        ] {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "itemId": QUEUE_ITEM }));
        }
        assert_eq!(
            QueueLimit::try_from(0).expect_err("none").code,
            "APP_REFUSED"
        );
        assert_eq!(
            QueueLimit::try_from(QUEUE_LIMIT_MAX).map(u64::from).ok(),
            Some(200)
        );
    }

    /// The lanes' calls (0.31.0, design 2026-10-25-routing B1): `lane list`, a read, and `lane unbind <lane>`, a
    /// tightening the app applies itself; each the events launcher, its words, `--json` and the pins, and nothing else.
    /// The picker's read of recent agent windows is core's `activity sessions` over the last 24 hours.
    #[test]
    fn lane_calls_build_exactly_their_words() {
        assert_eq!(events_line(json!({ "kind": "laneList" })), ["lane", "list"]);
        let longest = "x".repeat(40);
        for lane in ["david", "billing", "a", "lane-2", longest.as_str()] {
            assert_eq!(
                events_line(json!({ "kind": "laneUnbind", "lane": lane })),
                ["lane", "unbind", lane]
            );
        }
        for value in [
            json!({ "kind": "laneList" }),
            json!({ "kind": "laneUnbind", "lane": "david" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.31.0"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(LANES_VERSION, "0.31.0");
        assert!(!crate::version::at_least("0.30.0", LANES_VERSION));
        assert!(!crate::version::at_least("0.30.9", LANES_VERSION));
        assert!(crate::version::at_least("0.31.0", LANES_VERSION));
        assert!(crate::version::at_least("0.31.0-feat-0.31", LANES_VERSION));
        assert_eq!(
            whole_line(json!({ "kind": "activitySessions", "since": "24h" })),
            ["activity", "sessions", "--since", "24h"]
        );
        assert_eq!(ActivitySince::Day.word(), "24h");
        assert_eq!(
            serde_json::to_value(ActivitySince::Day).expect("json"),
            json!("24h")
        );
    }

    /// Nothing the window sends reaches a lane's words unchecked: the name is 1 to 40 of `[a-z0-9-]`, no call takes a
    /// field it does not name, and nothing binds, reads a lane's items or asks who a window is: binding is the person's,
    /// at a terminal.
    #[test]
    fn lane_calls_refuse_bad_names_and_extra_fields() {
        for lane in [
            json!(""),
            json!("-david"),
            json!("--json"),
            json!("David"),
            json!("david_slack"),
            json!("david.slack"),
            json!("david slack"),
            json!("david --window 3f9a1c2e7b4d5a60"),
            json!("david\n"),
            json!("david\u{202e}"),
            json!("david\u{200b}"),
            json!("x".repeat(41)),
            json!("../david"),
            json!(7),
            json!(null),
            json!(["david"]),
            json!({ "name": "david" }),
        ] {
            refused(json!({ "kind": "laneUnbind", "lane": lane }));
        }
        // The lane is never left out, and is named `lane`, nothing else.
        refused(json!({ "kind": "laneUnbind" }));
        refused(json!({ "kind": "laneUnbind", "name": "david" }));
        for (field, value) in [
            ("window", json!(SESSION)),
            ("approval", json!(ID)),
            ("approvalId", json!(ID)),
            ("args", json!(["--all"])),
            ("json", json!(false)),
            ("force", json!(true)),
            ("all", json!(true)),
        ] {
            let mut given = json!({ "kind": "laneUnbind", "lane": "david" });
            given[field] = value.clone();
            refused(given);
            let mut list = json!({ "kind": "laneList" });
            list[field] = value;
            refused(list);
        }
        refused(json!({ "kind": "laneList", "lane": "david" }));
        for kind in [
            "laneBind",
            "laneItem",
            "laneWatch",
            "laneWait",
            "laneWhoami",
            "lane",
            "lanes",
        ] {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "lane": "david" }));
            refused(json!({ "kind": kind, "lane": "david", "window": SESSION }));
        }
    }

    /// The rules' and deliveries' calls (0.32.0, owner feedback §3.4 and §3.5): `rule show`, `rule disable` and `rule
    /// remove` for one rule, and `delivery show`, `dryrun show`, `delivery retry` and `delivery drop` for one delivery;
    /// each the events launcher, its words, `--json` and the pins, and nothing else.
    #[test]
    fn rule_and_delivery_calls_build_exactly_their_words() {
        let longest_rule = "r".repeat(128);
        for rule in [
            "mail-subject",
            "invoices",
            "rule_example",
            "team:rule@1",
            "rule.v2",
            "r",
            longest_rule.as_str(),
        ] {
            for (kind, verb) in [
                ("eventsRuleShow", "show"),
                ("eventsRuleDisable", "disable"),
                ("eventsRuleRemove", "remove"),
            ] {
                assert_eq!(
                    events_line(json!({ "kind": kind, "ruleId": rule })),
                    ["rule", verb, rule]
                );
            }
        }
        let longest_delivery = "d".repeat(128);
        for delivery in [DELIVERY, "dlv_example_1", "D", longest_delivery.as_str()] {
            for (kind, noun, verb) in [
                ("eventsDeliveryShow", "delivery", "show"),
                ("eventsDryrunShow", "dryrun", "show"),
                ("eventsDeliveryRetry", "delivery", "retry"),
                ("eventsDeliveryDrop", "delivery", "drop"),
            ] {
                assert_eq!(
                    events_line(json!({ "kind": kind, "deliveryId": delivery })),
                    [noun, verb, delivery]
                );
            }
        }
        // `delivery show` and `dryrun show --json` from the app are 0.32.0's; the rest are as old as the event service.
        // None prepares a change: Turn off and Remove are tightenings, and Try now and Stop trying act on one delivery,
        // each applied by the app itself (DA10).
        for (value, needs) in [
            (
                json!({ "kind": "eventsRuleShow", "ruleId": "mail-subject" }),
                None,
            ),
            (
                json!({ "kind": "eventsRuleDisable", "ruleId": "mail-subject" }),
                None,
            ),
            (
                json!({ "kind": "eventsRuleRemove", "ruleId": "mail-subject" }),
                None,
            ),
            (
                json!({ "kind": "eventsDeliveryShow", "deliveryId": DELIVERY }),
                Some("0.32.0"),
            ),
            (
                json!({ "kind": "eventsDryrunShow", "deliveryId": DELIVERY }),
                Some("0.32.0"),
            ),
            (
                json!({ "kind": "eventsDeliveryRetry", "deliveryId": DELIVERY }),
                None,
            ),
            (
                json!({ "kind": "eventsDeliveryDrop", "deliveryId": DELIVERY }),
                None,
            ),
        ] {
            assert_eq!(call(value.clone()).needs(), needs, "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(DELIVERY_DETAIL_VERSION, "0.32.0");
        assert!(!crate::version::at_least("0.31.0", DELIVERY_DETAIL_VERSION));
        assert!(!crate::version::at_least("0.31.9", DELIVERY_DETAIL_VERSION));
        assert!(crate::version::at_least("0.32.0", DELIVERY_DETAIL_VERSION));
        assert!(crate::version::at_least(
            "0.32.0-feat-0.32",
            DELIVERY_DETAIL_VERSION
        ));
    }

    /// Nothing the window sends reaches a rule's or a delivery's words unchecked: each id is a word of the grammar's,
    /// never an option or two words; and each call names exactly its fields. Since 0.33.0 the rule editor creates and
    /// updates a rule, but only from one document on stdin, at most `RULE_DOCUMENT_LIMIT` bytes, with no field beside
    /// it; it prepares an activation, and switching it on stays the person's approval. Nothing tests a rule or lists
    /// the dry-run log.
    #[test]
    fn rule_and_delivery_calls_refuse_bad_ids_and_extra_fields() {
        let rule_kinds = ["eventsRuleShow", "eventsRuleDisable", "eventsRuleRemove"];
        let delivery_kinds = [
            "eventsDeliveryShow",
            "eventsDryrunShow",
            "eventsDeliveryRetry",
            "eventsDeliveryDrop",
        ];
        for rule in [
            json!(""),
            json!("-r"),
            json!("--json"),
            json!("--all"),
            json!("rule 1"),
            json!("mail-subject --json"),
            json!("mail-subject\n"),
            json!("mail-subject\u{202e}"),
            json!("mail-subject\u{200b}"),
            json!(" mail-subject"),
            json!("../mail-subject"),
            json!("mail/subject"),
            json!("_rule"),
            json!(".rule"),
            json!("r".repeat(129)),
            json!(7),
            json!(null),
            json!(["mail-subject"]),
            json!({ "id": "mail-subject" }),
        ] {
            for kind in rule_kinds {
                refused(json!({ "kind": kind, "ruleId": rule }));
            }
        }
        for delivery in [
            json!(""),
            json!("-d"),
            json!("--json"),
            json!("--all"),
            json!("_dlv"),
            json!("dlv 1"),
            json!("dlv.1"),
            json!("dlv:1"),
            json!("dlv@1"),
            json!("dlv/1"),
            json!("../dlv"),
            json!("dlv_1 --json"),
            json!("dlv_1\n"),
            json!("dlv_1\u{202e}"),
            json!("dlv_1\u{200b}"),
            json!(" dlv_1"),
            json!("d".repeat(129)),
            json!(7),
            json!(null),
            json!([DELIVERY]),
            json!({ "id": DELIVERY }),
        ] {
            for kind in delivery_kinds {
                refused(json!({ "kind": kind, "deliveryId": delivery }));
            }
        }
        // Each id is never left out, and is named exactly: `ruleId` for a rule, `deliveryId` for a delivery.
        for kind in rule_kinds {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "rule": "mail-subject" }));
            refused(json!({ "kind": kind, "id": "mail-subject" }));
            refused(json!({ "kind": kind, "deliveryId": DELIVERY }));
        }
        for kind in delivery_kinds {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "delivery": DELIVERY }));
            refused(json!({ "kind": kind, "id": DELIVERY }));
            refused(json!({ "kind": kind, "ruleId": "mail-subject" }));
        }
        for (field, value) in [
            ("version", json!(2)),
            ("approval", json!(ID)),
            ("approvalId", json!(ID)),
            ("args", json!(["--all"])),
            ("json", json!(false)),
            ("force", json!(true)),
            ("all", json!(true)),
        ] {
            for kind in rule_kinds {
                let mut given = json!({ "kind": kind, "ruleId": "mail-subject" });
                given[field] = value.clone();
                refused(given);
            }
            for kind in delivery_kinds {
                let mut given = json!({ "kind": kind, "deliveryId": DELIVERY });
                given[field] = value.clone();
                refused(given);
            }
        }
        // Since 0.33.0 the rule editor prepares an activation with `eventsRuleEnable`, which takes a rule and its version
        // and nothing else; switching it on stays the person's press (`eventsRuleApprove`).
        refused(json!({ "kind": "eventsRuleEnable" }));
        refused(json!({ "kind": "eventsRuleEnable", "ruleId": "mail-subject" }));
        refused(
            json!({ "kind": "eventsRuleEnable", "ruleId": "mail-subject", "version": 2, "deliveryId": DELIVERY }),
        );
        // Creating and updating a rule take its one document, and nothing beside it: a document within the cap is taken,
        // one past it is refused, as is any other field — an id, a version or an argument — next to it.
        let limit = crate::rule_editor::RULE_DOCUMENT_LIMIT;
        let padded = |padding: usize| {
            let mut document = RULE_DOCUMENT.clone();
            document["padding"] = json!("");
            let base = serde_json::to_vec(&document).expect("json").len();
            document["padding"] = json!("x".repeat(padding.saturating_sub(base)));
            document
        };
        for kind in ["eventsRuleCreate", "eventsRuleUpdate"] {
            let at_cap = padded(limit);
            assert_eq!(serde_json::to_vec(&at_cap).expect("json").len(), limit);
            assert!(
                serde_json::from_value::<Call>(json!({ "kind": kind, "document": at_cap })).is_ok(),
                "{kind} takes a document of exactly the cap"
            );
            refused(json!({ "kind": kind, "document": padded(limit + 1) }));
            refused(json!({ "kind": kind, "document": padded(limit * 4) }));
            for (field, value) in [
                ("ruleId", json!("mail-subject")),
                ("version", json!(2)),
                ("approvalId", json!(ID)),
                ("args", json!(["--force"])),
                ("json", json!(false)),
                ("deliveryId", json!(DELIVERY)),
            ] {
                let mut given = json!({ "kind": kind, "document": RULE_DOCUMENT.clone() });
                given[field] = value;
                refused(given);
            }
        }
        for kind in [
            "eventsRuleTest",
            "eventsRuleTestRetained",
            "eventsDryrunList",
            "eventsDeliveryList",
            "eventsDeliveries2",
            "ruleShow",
            "deliveryShow",
            "dryrunShow",
        ] {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "ruleId": "mail-subject" }));
            refused(json!({ "kind": kind, "ruleId": "mail-subject", "version": 2 }));
            refused(json!({ "kind": kind, "deliveryId": DELIVERY }));
        }
    }

    /// Judge setup and AI provider keys (0.32.0, owner decision 2026-10-26): the provider list and a key's removal, each
    /// the events launcher, its words, `--json` and the pins; and Jev's or a local model server's setup, with its
    /// longer timeout. Each needs 0.32.0, and none prepares a change: the person's setup is applied by the CLI itself.
    #[test]
    fn setup_calls_build_exactly_their_words() {
        assert_eq!(
            events_line(json!({ "kind": "providerList" })),
            ["provider", "list"]
        );
        for provider in AiProvider::ALL {
            assert_eq!(
                events_line(json!({ "kind": "providerKeyRemove", "provider": provider.word() })),
                ["provider", "key", "remove", provider.word()]
            );
        }
        let setup = |value: serde_json::Value| {
            let built = call(value.clone()).words().expect("words");
            assert_eq!(built.product, Product::EventsDaemon, "{value}");
            assert_eq!(built.shape, Shape::Bare, "{value}");
            assert!(built.pins && built.quiet_updates, "{value}");
            assert_eq!(built.timeout, Duration::from_secs(60), "{value}");
            built.words
        };
        assert_eq!(
            setup(
                json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter" })
            ),
            ["judge", "setup", "typesafe", "--provider", "openrouter"]
        );
        assert_eq!(
            setup(json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "typesafe" })),
            ["judge", "setup", "typesafe", "--provider", "typesafe"]
        );
        assert_eq!(
            setup(
                json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint", "url": "http://127.0.0.1:11434" })
            ),
            [
                "judge",
                "setup",
                "local-endpoint",
                "--url",
                "http://127.0.0.1:11434"
            ]
        );
        assert_eq!(
            setup(json!({
                "kind": "judgeSetup",
                "judgeKind": "local-endpoint",
                "url": "http://[::1]:8080",
                "model": "nimble"
            })),
            [
                "judge",
                "setup",
                "local-endpoint",
                "--url",
                "http://[::1]:8080",
                "--model",
                "nimble"
            ]
        );
        for value in [
            json!({ "kind": "providerList" }),
            json!({ "kind": "providerKeyRemove", "provider": "openrouter" }),
            json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter" }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.32.0"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(JUDGE_SETUP_VERSION, "0.32.0");
        assert!(!crate::version::at_least("0.31.0", JUDGE_SETUP_VERSION));
        assert!(crate::version::at_least(
            "0.32.0-feat-0.32-judges",
            JUDGE_SETUP_VERSION
        ));
    }

    /// No key is ever a call's: there is no `providerKeySet` call, and no setup call takes a key, a free word, Laya, a
    /// URL that is not on this machine, or a provider and a URL together.
    #[test]
    fn setup_calls_refuse_a_key_laya_a_remote_url_and_mixed_shapes() {
        for kind in ["providerKeySet", "providerKey", "providerKeyAdd"] {
            refused(json!({ "kind": kind, "provider": "openrouter" }));
            refused(json!({ "kind": kind, "provider": "openrouter", "key": "fake-key" }));
        }
        for (field, value) in [
            ("key", json!("fake-key")),
            ("apiKey", json!("fake-key")),
            ("hidden", json!("fake-key")),
            ("stdin", json!("fake-key")),
        ] {
            let mut setup =
                json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter" });
            setup[field] = value.clone();
            refused(setup);
            let mut remove = json!({ "kind": "providerKeyRemove", "provider": "openrouter" });
            remove[field] = value.clone();
            refused(remove);
            let mut list = json!({ "kind": "providerList" });
            list[field] = value;
            refused(list);
        }
        for provider in [
            json!("someone-else"),
            json!("TypeSafe"),
            json!(""),
            json!(1),
            json!(["typesafe"]),
        ] {
            refused(json!({ "kind": "providerKeyRemove", "provider": provider.clone() }));
            refused(json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": provider }));
        }
        refused(json!({ "kind": "providerKeyRemove", "provider": null }));
        refused(json!({ "kind": "providerKeyRemove" }));
        refused(json!({ "kind": "judgeSetup", "judgeKind": "laya" }));
        refused(json!({ "kind": "judgeSetup", "judgeKind": "laya", "provider": "typesafe" }));
        for url in [
            "http://192.168.1.20:11434",
            "http://localhost:11434",
            "https://127.0.0.1:11434",
            "http://127.0.0.1",
            "http://127.0.0.1:11434/api/generate",
            "http://127.0.0.1:11434 --model x",
            "-http://127.0.0.1:11434",
        ] {
            refused(json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint", "url": url }));
        }
        refused(json!({
            "kind": "judgeSetup",
            "judgeKind": "local-endpoint",
            "url": "http://127.0.0.1:11434",
            "model": "--json"
        }));
        // Shapes that deserialise, but name the wrong words for their kind, build nothing.
        for value in [
            json!({ "kind": "judgeSetup", "judgeKind": "typesafe" }),
            json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter", "url": "http://127.0.0.1:11434" }),
            json!({ "kind": "judgeSetup", "judgeKind": "typesafe", "provider": "openrouter", "model": "nimble" }),
            json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint" }),
            json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint", "url": "http://127.0.0.1:11434", "provider": "typesafe" }),
            json!({ "kind": "judgeSetup", "judgeKind": "local-endpoint", "model": "nimble" }),
        ] {
            assert_eq!(
                call(value.clone()).words().expect_err("refused").code,
                "APP_REFUSED",
                "{value}"
            );
        }
    }

    /// The rule editor's calls (0.33.0, design 2026-10-26-rules-that-act-0330 §3.1–§3.5): each the events launcher, its
    /// words, `--json` and the pins; a document only ever on stdin, as compact JSON, and never a word of the command;
    /// each needs 0.33.0, and none prepares a change the terminal opens.
    #[test]
    fn rule_editor_calls_build_exactly_their_words_and_hand_documents_on_stdin() {
        let line = |value: serde_json::Value| events_line(value);
        assert_eq!(
            line(json!({ "kind": "eventsTargetsList" })),
            ["targets", "list"]
        );
        for (kind, words) in [
            ("eventsTargetAdd", ["target", "add", "-"]),
            ("eventsTargetUpdate", ["target", "update", "-"]),
        ] {
            let value = json!({ "kind": kind, "document": TARGET_DOCUMENT.clone() });
            assert_eq!(line(value.clone()), words);
            let input = call(value).input().expect("a document on stdin");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&input).expect("json"),
                *TARGET_DOCUMENT
            );
            assert!(!input.contains(&b'\n'), "compact JSON, one line");
        }
        for (kind, words) in [
            ("eventsRuleCreate", ["rule", "create", "-"]),
            ("eventsRuleUpdate", ["rule", "update", "-"]),
        ] {
            let value = json!({ "kind": kind, "document": RULE_DOCUMENT.clone() });
            assert_eq!(line(value.clone()), words);
            let built = call(value.clone()).words().expect("words");
            // Not a word of the document is in argv.
            assert!(
                built.words.iter().all(|word| !word.contains("invoice")),
                "{value}"
            );
            let input = call(value).input().expect("a document on stdin");
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&input).expect("json"),
                *RULE_DOCUMENT
            );
        }
        assert_eq!(
            line(json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": 3 })),
            ["rule", "enable", "invoices", "3"]
        );
        assert_eq!(
            line(json!({ "kind": "eventsApprovalView", "approvalId": ID, "digest": DIGEST })),
            ["approval", "view", ID, "--digest", DIGEST]
        );
        let approve =
            call(json!({ "kind": "eventsRuleApprove", "approvalId": ID, "digest": DIGEST }));
        assert_eq!(
            approve.words().expect("words").words,
            ["rule", "approve", ID, "--digest", DIGEST]
        );
        assert_eq!(
            approve.words().expect("words").timeout,
            Duration::from_secs(60)
        );
        let analyse = call(json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices" }))
            .words()
            .expect("words");
        assert_eq!(analyse.words, ["rule", "analyse", "invoices"]);
        assert_eq!(analyse.shape, Shape::Bare);
        assert!(analyse.pins && analyse.quiet_updates);
        assert_eq!(analyse.timeout, Duration::from_secs(90));
        let draft = json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "draft": RULE_DOCUMENT.clone() });
        assert_eq!(
            call(draft.clone()).words().expect("words").words,
            ["rule", "analyse", "invoices", "--draft", "-"]
        );
        assert!(call(draft).input().is_some());
        assert_eq!(
            call(json!({
                "kind": "eventsRuleAnalyse",
                "ruleId": "invoices",
                "draft": RULE_DOCUMENT.clone(),
                "provider": "anthropic"
            }))
            .words()
            .expect("words")
            .words,
            [
                "rule",
                "analyse",
                "invoices",
                "--draft",
                "-",
                "--provider",
                "anthropic"
            ]
        );
        assert!(
            call(json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices" }))
                .input()
                .is_none()
        );
        for integration in ["linear", "agent-sessions"] {
            assert_eq!(
                line(json!({ "kind": "integrationShow", "integration": integration })),
                ["integration", "show", integration]
            );
        }
        for home in ["default", "/example/home/.local/state/agent-relay"] {
            assert_eq!(
                line(json!({ "kind": "integrationSetAgentSessions", "relayHome": home })),
                ["integration", "set", "agent-sessions", "--relay-home", home]
            );
        }
        for provider in ["anthropic", "linear"] {
            let value = json!({ "kind": "providerKeyRemove", "provider": provider });
            assert_eq!(line(value.clone()), ["provider", "key", "remove", provider]);
            assert_eq!(call(value).needs(), Some("0.33.0"), "{provider}");
        }
        assert_eq!(
            provider_key_set(KeyProvider::Linear).words,
            ["provider", "key", "set", "linear"]
        );
        // Every editor call needs 0.33.0; none prepares a change; only the four with a document read stdin.
        let editor = [
            "eventsTargetsList",
            "eventsTargetAdd",
            "eventsTargetUpdate",
            "eventsRuleCreate",
            "eventsRuleUpdate",
            "eventsRuleEnable",
            "eventsApprovalView",
            "eventsRuleApprove",
            "eventsRuleAnalyse",
            "integrationShow",
            "integrationSetAgentSessions",
            "sessionQueueList",
            "sessionQueueDrop",
            "judgeShow",
        ];
        let mut seen = 0;
        for (sample, value) in samples() {
            let kind = value["kind"].as_str().unwrap_or("");
            if !editor.contains(&kind) {
                assert!(sample.input().is_none(), "{value} reads no stdin");
                continue;
            }
            seen += 1;
            assert_eq!(sample.needs(), Some(RULE_EDITOR_VERSION), "{value}");
            assert!(!sample.prepares_change(), "{value}");
        }
        assert_eq!(seen, 21);
        assert_eq!(
            line(json!({ "kind": "judgeShow", "judgeId": "jev" })),
            ["judge", "show", "jev"]
        );
        assert_eq!(
            line(json!({ "kind": "judgeShow", "judgeId": "local-model", "version": 2 })),
            ["judge", "show", "local-model", "--version", "2"]
        );
        assert_eq!(
            line(json!({ "kind": "sessionQueueList" })),
            ["session-queue", "list"]
        );
        assert_eq!(
            line(json!({ "kind": "sessionQueueDrop", "deliveryId": DELIVERY })),
            ["session-queue", "drop", DELIVERY]
        );
        assert_eq!(
            line(json!({ "kind": "integrationShow", "integration": "linear", "team": "CUE" })),
            ["integration", "show", "linear", "--team", "CUE"]
        );
        assert_eq!(
            call(
                json!({ "kind": "integrationShow", "integration": "agent-sessions", "team": "CUE" })
            )
            .words()
            .expect_err("refused")
            .code,
            "APP_REFUSED"
        );
        assert_eq!(RULE_EDITOR_VERSION, "0.33.0");
        assert!(!crate::version::at_least("0.32.0", RULE_EDITOR_VERSION));
        assert!(crate::version::at_least(
            "0.33.0-feat-0.33-editors",
            RULE_EDITOR_VERSION
        ));
    }

    /// Nothing the window sends reaches the CLI but those words and a checked document: a document of another shape, a
    /// free word, a home that is a folder, a version that is not whole, an extra field — each refused before anything
    /// runs.
    #[test]
    fn rule_editor_calls_refuse_bad_documents_words_and_extra_fields() {
        for kind in ["eventsRuleCreate", "eventsRuleUpdate"] {
            for document in [
                json!(null),
                json!("{\"ruleId\":\"invoices\"}"),
                json!({ "ruleId": "invoices" }),
                json!({ "ruleId": "--json", "version": 1 }),
                json!({ "ruleId": "invoices", "version": 0 }),
            ] {
                refused(json!({ "kind": kind, "document": document }));
            }
            refused(json!({ "kind": kind }));
            refused(
                json!({ "kind": kind, "document": RULE_DOCUMENT.clone(), "ruleId": "invoices" }),
            );
        }
        for kind in ["eventsTargetAdd", "eventsTargetUpdate"] {
            refused(
                json!({ "kind": kind, "document": { "targetId": "hook", "version": 1, "kind": "webhook" } }),
            );
            refused(json!({ "kind": kind, "document": RULE_DOCUMENT.clone() }));
            refused(
                json!({ "kind": kind, "document": TARGET_DOCUMENT.clone(), "secret": "fake-secret" }),
            );
        }
        for version in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("3"),
            json!(1_000_001),
        ] {
            refused(
                json!({ "kind": "eventsRuleEnable", "ruleId": "invoices", "version": version }),
            );
        }
        refused(json!({ "kind": "eventsRuleEnable", "ruleId": "-invoices", "version": 1 }));
        for kind in ["eventsApprovalView", "eventsRuleApprove"] {
            refused(json!({ "kind": kind, "approvalId": ID }));
            refused(json!({ "kind": kind, "approvalId": ID, "digest": DIGEST.to_uppercase() }));
            refused(json!({ "kind": kind, "approvalId": ID, "digest": &DIGEST[1..] }));
            refused(json!({ "kind": kind, "approvalId": "ap_short", "digest": DIGEST }));
            refused(
                json!({ "kind": kind, "approvalId": ID, "digest": DIGEST, "challenge": "fake-challenge" }),
            );
            refused(
                json!({ "kind": kind, "approvalId": ID, "digest": DIGEST, "answer": "fake-challenge" }),
            );
        }
        refused(
            json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "draft": "rule invoices" }),
        );
        for provider in ["typesafe", "linear", "OpenRouter", "", "--json"] {
            refused(
                json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "provider": provider }),
            );
        }
        refused(json!({ "kind": "eventsRuleAnalyse", "ruleId": "invoices", "model": "claude" }));
        refused(json!({ "kind": "eventsRuleAnalyse" }));
        for integration in ["Linear", "github", "", "agent_sessions"] {
            refused(json!({ "kind": "integrationShow", "integration": integration }));
        }
        for home in [
            "~/.local/state/agent-relay",
            "pilot",
            "",
            "--json",
            "/example/../etc",
            "/example/home/",
        ] {
            refused(json!({ "kind": "integrationSetAgentSessions", "relayHome": home }));
        }
        for team in ["", "--json", "CUE OPS", "CUE-1"] {
            refused(json!({ "kind": "integrationShow", "integration": "linear", "team": team }));
        }
        refused(json!({ "kind": "integrationSetAgentSessions" }));
        refused(json!({ "kind": "sessionQueueList", "deliveryId": DELIVERY }));
        refused(json!({ "kind": "sessionQueueDrop" }));
        refused(json!({ "kind": "judgeShow" }));
        for judge in ["", "--json", "-jev", ".jev", "a b", "x/y", "jev\u{202e}"] {
            refused(json!({ "kind": "judgeShow", "judgeId": judge }));
        }
        refused(json!({ "kind": "judgeShow", "judgeId": "j".repeat(129) }));
        assert!(serde_json::from_value::<Call>(
            json!({ "kind": "judgeShow", "judgeId": "j".repeat(128) })
        )
        .is_ok());
        for version in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!("1"),
            json!(1_000_001),
        ] {
            refused(json!({ "kind": "judgeShow", "judgeId": "jev", "version": version }));
        }
        refused(json!({ "kind": "judgeShow", "judgeId": "jev", "document": {} }));
        for delivery in ["", "--json", "a b", "x/y"] {
            refused(json!({ "kind": "sessionQueueDrop", "deliveryId": delivery }));
        }
        refused(json!({ "kind": "integrationSetAgentSessions", "home": "pilot" }));
        refused(
            json!({ "kind": "integrationSetAgentSessions", "relayHome": "default", "token": "fake-token" }),
        );
        refused(json!({ "kind": "integrationShow", "integration": "linear", "key": "fake-key" }));
        refused(json!({ "kind": "eventsTargetsList", "targetId": "x" }));
        // No call sets a key, a rule text, or answers a challenge.
        for kind in [
            "integrationSetLinear",
            "providerKeySet",
            "ruleTextParse",
            "eventsApprove",
            "eventsRuleApproveAt",
        ] {
            refused(json!({ "kind": kind }));
        }
    }

    /// Events → Service's switch (0.34.0 design B4): `enable-all` prepares switching on, `collection approve <approval>
    /// --digest <digest>` is the person's press in the app, and `disable-all` switches off at once. Each is the events
    /// service's launcher, its words, `--json` and the pins; none prepares a core change; switching on and off need the
    /// event service that has them, and preparing needs only the one with the approval view. Nothing else rides along.
    #[test]
    fn collection_switch_calls_build_exactly_their_words_and_refuse_anything_else() {
        let words = |value: serde_json::Value| call(value).words().expect("words");
        let prepare = words(json!({ "kind": "eventsEnableAll" }));
        assert_eq!(prepare.product, Product::EventsDaemon);
        assert_eq!(prepare.words, ["enable-all"]);
        assert_eq!(prepare.shape, Shape::Bare);
        assert!(prepare.pins && prepare.quiet_updates);
        assert_eq!(prepare.timeout, Duration::from_secs(30));
        let approve =
            words(json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": DIGEST }));
        assert_eq!(approve.product, Product::EventsDaemon);
        assert_eq!(
            approve.words,
            ["collection", "approve", ID, "--digest", DIGEST]
        );
        assert_eq!(approve.shape, Shape::Bare);
        assert_eq!(approve.timeout, Duration::from_secs(60));
        let off = words(json!({ "kind": "eventsDisableAll" }));
        assert_eq!(off.words, ["disable-all"]);
        assert_eq!(off.shape, Shape::Bare);
        assert_eq!(
            call(json!({ "kind": "eventsEnableAll" })).needs(),
            Some(RULE_EDITOR_VERSION)
        );
        for value in [
            json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": DIGEST }),
            json!({ "kind": "eventsDisableAll" }),
        ] {
            assert_eq!(
                call(value.clone()).needs(),
                Some(COLLECTION_SWITCH_VERSION),
                "{value}"
            );
            assert!(!call(value).prepares_change());
        }
        assert!(!call(json!({ "kind": "eventsEnableAll" })).prepares_change());
        assert_eq!(COLLECTION_SWITCH_VERSION, "0.34.0");
        assert!(!crate::version::at_least(
            "0.33.0",
            COLLECTION_SWITCH_VERSION
        ));
        assert!(crate::version::at_least(
            "0.34.0-feat-0.34-ui-events",
            COLLECTION_SWITCH_VERSION
        ));
        // The approval and its digest are checked words; no challenge, answer, rule or extra field is taken.
        refused(json!({ "kind": "eventsCollectionApprove", "approvalId": ID }));
        refused(json!({ "kind": "eventsCollectionApprove", "digest": DIGEST }));
        refused(
            json!({ "kind": "eventsCollectionApprove", "approvalId": "ap_short", "digest": DIGEST }),
        );
        refused(
            json!({ "kind": "eventsCollectionApprove", "approvalId": "--json", "digest": DIGEST }),
        );
        refused(
            json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": DIGEST.to_uppercase() }),
        );
        refused(
            json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": &DIGEST[1..] }),
        );
        refused(
            json!({ "kind": "eventsCollectionApprove", "approvalId": ID, "digest": DIGEST, "challenge": "fake-challenge" }),
        );
        refused(json!({ "kind": "eventsEnableAll", "approvalId": ID }));
        refused(json!({ "kind": "eventsEnableAll", "ruleId": "invoices" }));
        refused(json!({ "kind": "eventsDisableAll", "force": true }));
        refused(json!({ "kind": "eventsCollectionEnable" }));
    }

    /// The Messages screen's calls (0.32.0, spec §3.6): the events service's `messages list` and `message show`, and
    /// core's `activity items`, each read for the same window. Each is its launcher, its words, `--json` and the pins,
    /// and nothing else; none prepares a change, and each needs the release that ships it.
    #[test]
    fn messages_calls_build_exactly_their_words() {
        let since = SINCE_MS.to_string();
        let before = BEFORE_MS.to_string();
        assert_eq!(
            events_line(json!({ "kind": "eventsMessagesList", "since": SINCE_MS })),
            ["messages", "list", "--since", since.as_str()]
        );
        assert_eq!(
            events_line(json!({
                "kind": "eventsMessagesList",
                "since": SINCE_MS,
                "before": BEFORE_MS,
                "limit": 100
            })),
            [
                "messages",
                "list",
                "--since",
                since.as_str(),
                "--before",
                before.as_str(),
                "--limit",
                "100"
            ]
        );
        // The next page, by the cursor the last one gave: `<observedAt ms>:<eventId>`, passed on as it came.
        let cursor = format!("{BEFORE_MS}:{EVENT_ID}");
        assert_eq!(
            events_line(
                json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": cursor })
            ),
            [
                "messages",
                "list",
                "--since",
                since.as_str(),
                "--before",
                cursor.as_str()
            ]
        );
        assert_eq!(
            serde_json::to_value(call(
                json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": cursor })
            ))
            .expect("json"),
            json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": cursor })
        );
        for (limit, word) in [(1u64, "1"), (100, "100"), (500, "500")] {
            assert_eq!(
                events_line(
                    json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "limit": limit })
                ),
                [
                    "messages",
                    "list",
                    "--since",
                    since.as_str(),
                    "--limit",
                    word
                ]
            );
        }
        // The earliest and the latest a time may be: 2020, and the last millisecond before 2100.
        for at in [1_577_836_800_000u64, 4_102_444_799_999] {
            let word = at.to_string();
            assert_eq!(
                events_line(json!({ "kind": "eventsMessagesList", "since": at })),
                ["messages", "list", "--since", word.as_str()]
            );
        }
        assert_eq!(
            events_line(json!({ "kind": "eventsMessageShow", "eventId": EVENT_ID })),
            ["message", "show", EVENT_ID]
        );
        assert_eq!(
            whole_line(json!({ "kind": "activityItems", "since": SINCE_MS })),
            ["activity", "items", "--since", since.as_str()]
        );
        assert_eq!(
            whole_line(json!({
                "kind": "activityItems",
                "since": SINCE_MS,
                "ids": ["18c2f0a1b2c3d4e5", "C0123ABCD/1792886400.000100"]
            })),
            [
                "activity",
                "items",
                "--since",
                since.as_str(),
                "--ids",
                "18c2f0a1b2c3d4e5,C0123ABCD/1792886400.000100"
            ]
        );
        let fifty: Vec<String> = (0..50).map(|n| format!("18c2f0a1b2c3{n:04}")).collect();
        let line = whole_line(json!({ "kind": "activityItems", "since": SINCE_MS, "ids": fifty }));
        assert_eq!(line[4], "--ids");
        assert_eq!(line[5], fifty.join(","));
        // A field left out, or given as null, is no option: the words carry none.
        assert_eq!(
            events_line(
                json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": null, "limit": null })
            ),
            ["messages", "list", "--since", since.as_str()]
        );
        assert_eq!(
            whole_line(json!({ "kind": "activityItems", "since": SINCE_MS, "ids": null })),
            ["activity", "items", "--since", since.as_str()]
        );
        for value in [
            json!({ "kind": "eventsMessagesList", "since": SINCE_MS }),
            json!({ "kind": "eventsMessageShow", "eventId": EVENT_ID }),
            json!({ "kind": "activityItems", "since": SINCE_MS }),
        ] {
            assert_eq!(call(value.clone()).needs(), Some("0.32.0"), "{value}");
            assert!(!call(value.clone()).prepares_change(), "{value}");
        }
        assert_eq!(MESSAGES_VERSION, "0.32.0");
        assert!(!crate::version::at_least("0.31.0", MESSAGES_VERSION));
        assert!(!crate::version::at_least("0.31.9", MESSAGES_VERSION));
        assert!(crate::version::at_least("0.32.0", MESSAGES_VERSION));
        assert!(crate::version::at_least(
            "0.32.0-feat-0.32",
            MESSAGES_VERSION
        ));
    }

    /// Nothing the window sends reaches the Messages calls' words unchecked: each time is a whole number of milliseconds
    /// in 2020 to 2099, `before` after `since`, the limit 1 to 500, the event id the event service's 32 lowercase hex
    /// digits, each item id a Gmail message's or a Slack `<channel>/<ts>`, at most fifty and none twice; and no call
    /// takes a field it does not name.
    #[test]
    fn messages_calls_refuse_bad_numbers_ids_and_extra_fields() {
        for since in [
            json!(0),
            json!(-1),
            json!(1.5),
            json!(1_577_836_799_999u64),
            json!(4_102_444_800_000u64),
            json!(u64::MAX),
            json!("1792886400000"),
            json!("30d"),
            json!(null),
            json!([SINCE_MS]),
            json!({ "ms": SINCE_MS }),
        ] {
            refused(json!({ "kind": "eventsMessagesList", "since": since }));
            refused(json!({ "kind": "activityItems", "since": since }));
            // `before` is optional, so a null one is no option (above); any other of these is refused.
            if !since.is_null() {
                refused(
                    json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": since }),
                );
            }
        }
        // The window is always said: the two reads cover the same one.
        refused(json!({ "kind": "eventsMessagesList" }));
        refused(json!({ "kind": "activityItems" }));
        refused(json!({ "kind": "activityItems", "ids": ["18c2f0a1b2c3d4e5"] }));
        // A page ends after the window starts, by a time or by a cursor.
        for before in [
            json!(SINCE_MS),
            json!(SINCE_MS - 1),
            json!(format!("{SINCE_MS}:{EVENT_ID}")),
            json!(format!("{}:{EVENT_ID}", SINCE_MS - 1)),
        ] {
            assert!(
                call(json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": before }))
                    .words()
                    .is_err(),
                "before {before}"
            );
        }
        // A cursor is exactly the event service's: whole milliseconds in 2020 to 2099, `:`, and an event id.
        for cursor in [
            format!("{BEFORE_MS}:"),
            format!(":{EVENT_ID}"),
            format!("{BEFORE_MS}:{}", EVENT_ID.to_uppercase()),
            format!("{BEFORE_MS}:{}", &EVENT_ID[1..]),
            format!("{BEFORE_MS}:{EVENT_ID}0"),
            format!("{BEFORE_MS}:{EVENT_ID}:x"),
            format!("{BEFORE_MS}-{EVENT_ID}"),
            format!("{BEFORE_MS} :{EVENT_ID}"),
            format!("-{BEFORE_MS}:{EVENT_ID}"),
            format!("{BEFORE_MS}:{EVENT_ID}\n"),
            format!("{BEFORE_MS}:{EVENT_ID} --limit 5"),
            format!("0{BEFORE_MS}:{EVENT_ID}"),
            format!("4102444800000:{EVENT_ID}"),
            format!("1577836799999:{EVENT_ID}"),
            "next".to_string(),
            String::new(),
        ] {
            refused(json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "before": cursor }));
        }
        for limit in [
            json!(0),
            json!(501),
            json!(-1),
            json!(1.5),
            json!("100"),
            json!([100]),
        ] {
            refused(json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "limit": limit }));
        }
        let long_hex = "a".repeat(33);
        for event in [
            json!(""),
            json!("0123456789abcdef0123456789abcde"),
            json!(long_hex),
            json!("0123456789ABCDEF0123456789ABCDEF"),
            json!("0123456789abcdef0123456789abcdeg"),
            json!("-123456789abcdef0123456789abcdef"),
            json!("0123456789abcdef0123456789abcdef\n"),
            json!(" 0123456789abcdef0123456789abcdef"),
            json!("0123456789abcdef0123456789abcdef --json"),
            json!("qi_01J9Z8QF0000000000000000AB"),
            json!("../0123456789abcdef0123456789ab"),
            json!(7),
            json!(null),
            json!([EVENT_ID]),
            json!({ "id": EVENT_ID }),
        ] {
            refused(json!({ "kind": "eventsMessageShow", "eventId": event }));
        }
        // The event is never left out, and is named `eventId`, nothing else.
        refused(json!({ "kind": "eventsMessageShow" }));
        refused(json!({ "kind": "eventsMessageShow", "id": EVENT_ID }));
        refused(json!({ "kind": "eventsMessageShow", "event": EVENT_ID }));
        let long_id = "a".repeat(129);
        for id in [
            json!(""),
            json!("-18c2f0a1b2c3d4e5"),
            json!("--json"),
            json!("18c2f0a1b2c3d4e5,18c2f0a1b2c3d4e6"),
            json!("18c2 f0a1"),
            json!("18c2f0a1b2c3d4e5\n"),
            json!("18c2f0a1b2c3d4e5\u{202e}"),
            json!("18c2f0a1/../x"),
            json!(long_id),
            json!("C0123ABCD/1792886400"),
            json!("C0123ABCD/1792886400.00010"),
            json!("c0123abcd/1792886400.000100"),
            json!("X0123ABCD/1792886400.000100"),
            json!("C0123ABCD/1792886400.000100/x"),
            json!("C0123ABCD/"),
            json!(7),
            json!(null),
            json!(["18c2f0a1b2c3d4e5"]),
        ] {
            refused(json!({ "kind": "activityItems", "since": SINCE_MS, "ids": [id] }));
        }
        let fifty_one: Vec<String> = (0..51).map(|n| format!("18c2f0a1b2c3{n:04}")).collect();
        for ids in [
            json!([]),
            json!(fifty_one),
            json!(["18c2f0a1b2c3d4e5", "18c2f0a1b2c3d4e5"]),
            json!("18c2f0a1b2c3d4e5"),
            json!("18c2f0a1b2c3d4e5,C0123ABCD/1792886400.000100"),
            json!(7),
        ] {
            refused(json!({ "kind": "activityItems", "since": SINCE_MS, "ids": ids }));
        }
        for (field, value) in [
            ("approval", json!(ID)),
            ("approvalId", json!(ID)),
            ("args", json!(["--all"])),
            ("json", json!(false)),
            ("session", json!(SESSION)),
            ("channel", json!("gmail")),
            ("account", json!("example/gmail")),
            ("cursor", json!("next")),
            ("all", json!(true)),
            ("content", json!(true)),
        ] {
            for base in [
                json!({ "kind": "eventsMessagesList", "since": SINCE_MS }),
                json!({ "kind": "eventsMessageShow", "eventId": EVENT_ID }),
                json!({ "kind": "activityItems", "since": SINCE_MS }),
            ] {
                let mut given = base;
                given[field] = value.clone();
                refused(given);
            }
        }
        refused(json!({ "kind": "eventsMessageShow", "eventId": EVENT_ID, "since": SINCE_MS }));
        refused(json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "eventId": EVENT_ID }));
        refused(
            json!({ "kind": "eventsMessagesList", "since": SINCE_MS, "ids": ["18c2f0a1b2c3d4e5"] }),
        );
        refused(json!({ "kind": "activityItems", "since": SINCE_MS, "before": BEFORE_MS }));
        refused(json!({ "kind": "activityItems", "since": SINCE_MS, "limit": 100 }));
        // What the two services have besides, the app never calls from here.
        for kind in [
            "eventsMessages",
            "eventsMessage",
            "eventsMessagesShow",
            "eventsMessageList",
            "messagesList",
            "messageShow",
            "activityItem",
            "activityItemsAll",
        ] {
            refused(json!({ "kind": kind }));
            refused(json!({ "kind": kind, "since": SINCE_MS }));
            refused(json!({ "kind": kind, "eventId": EVENT_ID }));
        }
        assert_eq!(
            MessagesLimit::try_from(0).expect_err("none").code,
            "APP_REFUSED"
        );
        assert_eq!(
            MessagesLimit::try_from(MESSAGES_LIMIT_MAX)
                .map(u64::from)
                .ok(),
            Some(500)
        );
    }

    /// Today's start is written as core reads an ISO time, in UTC, for any day from 2020 to 2099.
    #[test]
    fn the_start_of_today_is_written_as_an_iso_time() {
        for (seconds, iso) in [
            (1_577_836_800u64, "2020-01-01T00:00:00.000Z"),
            (1_792_886_400, "2026-10-25T00:00:00.000Z"),
            (1_792_882_800, "2026-10-24T23:00:00.000Z"),
            (1_835_440_440, "2028-02-29T12:34:00.000Z"),
            (4_102_444_740, "2099-12-31T23:59:00.000Z"),
        ] {
            let since: ActivitySince =
                serde_json::from_value(json!({ "today": seconds })).expect("a start of today");
            assert_eq!(since.word(), iso, "{seconds}");
            assert_eq!(
                serde_json::to_value(since).expect("json"),
                json!({ "today": seconds })
            );
        }
        assert_eq!(ActivitySince::SevenDays.word(), "7d");
        assert_eq!(ActivitySince::ThirtyDays.word(), "30d");
        assert_eq!(
            serde_json::to_value(ActivitySince::SevenDays).expect("json"),
            json!("7d")
        );
        // Every day of a leap year and its neighbours: the date the window would write, day after day.
        let mut seconds = 1_704_067_200u64; // 2024-01-01
        let mut expected = (2024u64, 1u64, 1u64);
        let lengths = |year: u64| {
            let leap =
                year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
            [
                31,
                if leap { 29 } else { 28 },
                31,
                30,
                31,
                30,
                31,
                31,
                30,
                31,
                30,
                31,
            ]
        };
        for _ in 0..(366 + 365 + 365) {
            assert_eq!(civil_date(seconds / 86_400), expected, "{seconds}");
            seconds += 86_400;
            let (year, month, day) = expected;
            expected = if day < lengths(year)[(month - 1) as usize] {
                (year, month, day + 1)
            } else if month < 12 {
                (year, month + 1, 1)
            } else {
                (year + 1, 1, 1)
            };
        }
    }
}
