//! What the app opens outside itself, besides the terminal (DA7, DA15, DA16): `https://` links to the pages doctor fixes
//! send a person to, the events service's README at its Judges section (0.27.1), and a queue item's message in Gmail or
//! Slack on the web (0.30.0); and a writing profile in `<config>/compose/`, in the default editor. Both go through the
//! opener plugin from Rust: the capability file grants the webview none of its commands.

use crate::allowlist::{AccountName, Call, ConversationId};
use crate::ipc::{AppError, CliResult, ProfileOpened};
use crate::runner::{run, RunContext};
use regex::Regex;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// The hosts a link may go to, exactly: where doctor fixes, and the hints a failing check carries into one, send a person
/// to set a Slack app up (`api.slack.com/apps`), to take an app's access away (`myaccount.google.com`), or to make
/// Gmail's OAuth client (`console.cloud.google.com`). No other host of Slack's or Google's, and no subdomain (DA16).
pub const LINK_HOSTS: [&str; 3] = [
    "api.slack.com",
    "myaccount.google.com",
    "console.cloud.google.com",
];

/// The one page besides those the app opens (0.27.1): the events service's README at its Judges section, where the
/// Judges section's "How to set it up" sends a person to add a judge and its key at the terminal. Exactly this URL:
/// nothing else of GitHub's, and not this page another way.
pub const JUDGES_HELP: &str =
    "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges";

/// Where a person gets each AI provider's key (0.32.0), as Settings → AI providers links them: TypeSafe's console, named
/// by its quickstart (docs.typesafe.ai/introduction/quickstart), and OpenRouter's key settings, named by its Jev page
/// (openrouter.ai/docs/guides/community/jev); both read 2026-10-26. Exactly these, as `JUDGES_HELP` is.
pub const TYPESAFE_KEYS: &str = "https://console.typesafe.ai/keys";
pub const OPENROUTER_KEYS: &str = "https://openrouter.ai/settings/keys";

/// The longest link the app opens.
const LINK_LIMIT: usize = 2048;

/// What a link never holds as it is: a URL writes each of these, and anything outside printable ASCII, as `%XX`.
const NEVER_IN_A_LINK: &[u8] = b"\"<>\\`{}";

/// What every link the app opens is first: `https://`, then a host with no user, password or port, every label letters,
/// digits and inner hyphens, then, if anything, a path, a query or a fragment of printable ASCII with nothing a URL would
/// have encoded, and never Google's `/url` redirect, which would open anywhere. Its host, lowercased, or `None`.
fn checked_host(url: &str) -> Option<String> {
    if url.len() > LINK_LIMIT {
        return None;
    }
    let rest = url.strip_prefix("https://")?;
    if !rest
        .bytes()
        .all(|byte| (0x21..=0x7E).contains(&byte) && !NEVER_IN_A_LINK.contains(&byte))
    {
        return None;
    }
    let host = rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())].to_ascii_lowercase();
    let labelled = host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    });
    let after = &rest[host.len()..];
    let path = after[..after.find(['?', '#']).unwrap_or(after.len())].to_ascii_lowercase();
    let redirect = path == "/url" || path.starts_with("/url/");
    (labelled && !redirect).then_some(host)
}

/// Whether the app may open `url` for a doctor fix: `checked_host`'s link, on one of `LINK_HOSTS`. The UI checks the same
/// before it asks (`allowedLink`, `src/screens/Doctor.tsx`), and sends the link as its URL parser writes it. Besides
/// those, `JUDGES_HELP` exactly.
pub fn allowed_link(url: &str) -> bool {
    if url == JUDGES_HELP || url == TYPESAFE_KEYS || url == OPENROUTER_KEYS {
        return true;
    }
    checked_host(url).is_some_and(|host| LINK_HOSTS.contains(&host.as_str()))
}

/// A queue item's Gmail link, as the event service makes it (`queueItemLink`, in
/// `packages/events-daemon/src/domain/queue-target.ts`): `/mail/u/<n>/` or `/mail/?authuser=<the account's address,
/// percent-encoded>`, then `#all/<message id>`, the id as its `GMAIL_ID` takes one.
static GMAIL_QUEUE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^https://mail\.google\.com/mail/(?:u/[0-9]{1,2}/|\?authuser=((?:[A-Za-z0-9._~!*'()-]|%[0-9A-F]{2})+))#all/[0-9A-Za-z_-]{1,128}$",
    )
    .expect("a pattern")
});

/// A queue item's Slack link, as the event service makes it: `/client/<team>/<channel>`, then, for a thread,
/// `/thread/<the same channel>-<ts>`, each id as its `SLACK_ID` takes one and the ts as its `SLACK_TS`.
static SLACK_QUEUE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^https://app\.slack\.com/client/[0-9A-Z]{1,32}/([0-9A-Z]{1,32})(?:/thread/([0-9A-Z]{1,32})-[0-9]+\.[0-9]{6})?$")
        .expect("a pattern")
});

/// Whether `url` is a queue item's link the app may open (0.30.0, design 2026-10-25-action-queue §8): exactly one of
/// the two shapes the event service makes, and nothing else on Gmail's or Slack's hosts — not Gmail's compose page,
/// not a workspace's own `<workspace>.slack.com`, not Slack's admin. A Gmail account is a percent-encoded address, with
/// its `@`; a thread is the link's own channel's. The UI checks the same before it offers one (`queueLink`,
/// `src/queue.ts`).
pub fn queue_link(url: &str) -> bool {
    if url.len() > LINK_LIMIT {
        return false;
    }
    if let Some(gmail) = GMAIL_QUEUE_LINK.captures(url) {
        return gmail
            .get(1)
            .is_none_or(|account| account.as_str().contains("%40"));
    }
    SLACK_QUEUE_LINK.captures(url).is_some_and(|slack| {
        slack.get(2).is_none_or(|thread| {
            Some(thread.as_str()) == slack.get(1).map(|channel| channel.as_str())
        })
    })
}

/// A Linear issue's address, as a Linear delivery keeps it (0.33.0, `linearIssueRecord` in
/// `packages/events-daemon/src/runtime/linear-dispatcher.ts`): `https://linear.app/<workspace>/issue/<TEAM-n>`, or
/// `https://linear.app/issue/<TEAM-n>`, with none of the title's words Linear appends. Nothing else of Linear's.
static LINEAR_ISSUE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^https://linear\.app/(?:[A-Za-z0-9_-]{1,64}/)?issue/[A-Za-z0-9_]{1,32}-[0-9]{1,10}$",
    )
    .expect("a pattern")
});

/// Whether `url` is a Linear issue's address a delivery recorded, which the app opens in the person's browser.
pub fn linear_issue_link(url: &str) -> bool {
    LINEAR_ISSUE_LINK.is_match(url)
}

/// Whether `open_link` opens `url`: a doctor fix's link, the Judges README, a queue item's link, or the Linear issue a
/// delivery added.
pub fn may_open(url: &str) -> bool {
    allowed_link(url) || queue_link(url) || linear_issue_link(url)
}

/// Opens `url` in the default browser, once `may_open` takes it.
pub fn open_link(app: &AppHandle, url: &str) -> Result<(), AppError> {
    if !may_open(url) {
        return Err(AppError::refused(
            "the app opens only https links to the pages doctor fixes name (api.slack.com, myaccount.google.com and console.cloud.google.com), the events service's README at its Judges section, where TypeSafe and OpenRouter give out API keys, a queue item's message as the event service links it, on mail.google.com or app.slack.com, and a Linear issue a delivery added, on linear.app",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| AppError::io(format!("the link could not be opened: {error}")))
}

/// The profile file `profile init` named, when it is one the app may open: an absolute path whose folder is
/// `<config>/compose/` itself, with a name ending in `.md`, that is a file there — not a link, and not a folder — and
/// whose real folder is the compose folder's. Anything else is refused, whatever the CLI said.
pub fn profile_file(config_dir: &str, reported: &str) -> Result<PathBuf, AppError> {
    let compose = Path::new(config_dir).join("compose");
    let refused = || {
        AppError::refused(format!(
            "{reported:?} is not a profile file in {}: the app opens only the .md files there",
            compose.display()
        ))
    };
    let path = Path::new(reported);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(refused());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(refused)?;
    let stem = name.strip_suffix(".md").ok_or_else(refused)?;
    if stem.is_empty() || path.parent() != Some(compose.as_path()) {
        return Err(refused());
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| refused())?;
    if !metadata.is_file() {
        return Err(refused());
    }
    let real_folder = fs::canonicalize(&compose).map_err(|_| refused())?;
    let real = fs::canonicalize(path).map_err(|_| refused())?;
    if real.parent() != Some(real_folder.as_path()) {
        return Err(refused());
    }
    Ok(path.to_path_buf())
}

/// What `profile init` answered: the file and whether it made it, or its failure, with the CLI's own code.
pub fn read_profile_init(result: CliResult) -> Result<ProfileOpened, AppError> {
    match result {
        CliResult::Ok { exit: 0, data } => {
            match (
                data.get("path").and_then(|path| path.as_str()),
                data.get("created").and_then(|created| created.as_bool()),
            ) {
                (Some(path), Some(created)) => Ok(ProfileOpened {
                    path: path.to_string(),
                    created,
                }),
                _ => Err(AppError::io("profile init named no file")),
            }
        }
        CliResult::Failed {
            code,
            message,
            hint,
            ..
        } => Err(AppError {
            code,
            message: match hint {
                Some(hint) => format!("{message} {hint}"),
                None => message,
            },
        }),
        other => Err(AppError::io(format!(
            "profile init answered with something else: {}",
            match other {
                CliResult::Ok { exit, .. } => format!("exit {exit}"),
                CliResult::ApprovalPending { .. } => "an approval".into(),
                CliResult::Version { .. } => "a version".into(),
                CliResult::Failed { .. } => "a failure".into(),
            }
        ))),
    }
}

/// Opens one writing profile in the default editor: `profile init` makes it if it is missing (`user.md` with no
/// account, the account's, or one conversation's) and says where it is; the app opens only that file, and only when
/// `profile_file` takes it. The CLI's code comes back when it refuses: an account that is not connected, say.
pub fn open_profile(
    app: &AppHandle,
    ctx: &RunContext,
    account: Option<AccountName>,
    conversation: Option<ConversationId>,
) -> Result<ProfileOpened, AppError> {
    let opened = read_profile_init(run(
        &Call::ProfileInit {
            account,
            conversation,
        },
        ctx,
    ))?;
    let path = profile_file(&ctx.folders.config_dir, &opened.path)?;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|error| AppError::io(format!("the profile could not be opened: {error}")))?;
    Ok(opened)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    #[test]
    fn links_allow_only_the_hosts_doctor_fixes_name() {
        for url in [
            "https://api.slack.com/apps",
            "https://api.slack.com/apps/A0123/oauth?x=1#scopes",
            "https://api.slack.com/apps/A0123/app-manifest",
            "https://console.cloud.google.com/apis/credentials?project=example",
            "https://myaccount.google.com/permissions",
            "https://myaccount.google.com/connections",
            "https://Console.Cloud.Google.com/",
            "https://API.SLACK.COM/apps",
        ] {
            assert!(allowed_link(url), "{url} was refused");
        }
        for url in [
            // Slack's and Google's other hosts: no doctor fix sends a person there (DA16, after review).
            "https://slack.com",
            "https://slack.com/",
            "https://app.slack.com/client",
            "https://example.slack.com/admin",
            "https://google.com/",
            "https://www.google.com/",
            "https://accounts.google.com/o/oauth2/v2/auth?scope=a%20b",
            "https://support.google.com/accounts",
            "https://evil.api.slack.com/apps",
            // Google's redirect opens anywhere, on whichever of its hosts serves it.
            "https://www.google.com/url?q=https://evil.example/",
            "https://console.cloud.google.com/url?q=https://evil.example/",
            "https://myaccount.google.com/url?q=https%3A%2F%2Fevil.example",
            "https://myaccount.google.com/url",
            "https://myaccount.google.com/URL?q=x",
            "https://myaccount.google.com/url/?q=x",
            "",
            "http://slack.com/",
            "HTTPS://slack.com/",
            "https:slack.com",
            "https:/slack.com",
            "ftp://slack.com/",
            "javascript:alert(1)//https://slack.com",
            "file:///etc/passwd",
            "https://slack.com.evil.example/",
            "https://evilslack.com/",
            "https://notgoogle.com/",
            "https://google.com.evil.example/",
            "https://slack.com@evil.example/",
            "https://user:pass@slack.com/",
            "https://evil.example\\@slack.com/",
            "https://evil.example\\.slack.com/",
            "https://evil.example#.slack.com",
            "https://evil.example?.slack.com",
            "https://evil.example/.slack.com",
            "https://slack.com:8443/",
            "https://slack.com:443/",
            "https://slack.com./",
            "https://.slack.com/",
            "https://a..slack.com/",
            "https://-a.slack.com/",
            "https://%73lack.com/",
            "https://[::1]/",
            "https://127.0.0.1/",
            "https://slack.com/ path",
            "https://slack.com/\npath",
            "https://slack.com/\u{202E}moc",
            "https://sl\u{e4}ck.com/",
            "https://slack.com/\"onclick",
            "https://slack.com/<script>",
            "https://xn--slck-loa.com/",
        ] {
            assert!(!allowed_link(url), "{url:?} was allowed");
        }
        let long = format!("https://slack.com/{}", "a".repeat(4096));
        assert!(!allowed_link(&long));
    }

    /// Settings → AI providers (0.32.0) opens the two pages where a person gets a key, exactly, and nothing else on
    /// either host: not TypeSafe's or OpenRouter's other pages, not the same page another way.
    #[test]
    fn links_allow_the_two_provider_key_pages_and_nothing_else_there() {
        assert_eq!(TYPESAFE_KEYS, "https://console.typesafe.ai/keys");
        assert_eq!(OPENROUTER_KEYS, "https://openrouter.ai/settings/keys");
        assert!(allowed_link(TYPESAFE_KEYS) && may_open(TYPESAFE_KEYS));
        assert!(allowed_link(OPENROUTER_KEYS) && may_open(OPENROUTER_KEYS));
        for url in [
            "https://console.typesafe.ai/",
            "https://console.typesafe.ai/keys/",
            "https://console.typesafe.ai/keys?x=1",
            "https://console.typesafe.ai/billing",
            "https://typesafe.ai/keys",
            "https://openrouter.ai/",
            "https://openrouter.ai/settings/keys/",
            "https://openrouter.ai/settings/credits",
            "https://openrouter.ai/keys",
            "http://openrouter.ai/settings/keys",
            "https://openrouter.ai.evil.example/settings/keys",
            "https://OpenRouter.ai/settings/keys",
        ] {
            assert!(!may_open(url), "{url} was allowed");
        }
    }

    /// The Judges section's "How to set it up" (0.27.1) opens one fixed page: the events service's README at its
    /// Judges section. Nothing else of GitHub's opens, not even the same page another way.
    #[test]
    fn links_allow_the_judges_readme_and_nothing_else_on_github() {
        assert_eq!(
            JUDGES_HELP,
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges"
        );
        assert!(allowed_link(JUDGES_HELP));
        for url in [
            "https://github.com/",
            "https://github.com/crissmoldovan/agent-communications",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges-x",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#Judges",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md?x=1#judges",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges/",
            "https://github.com/crissmoldovan/agent-communications/blob/dev/packages/events-daemon/README.md#judges",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/core/README.md#judges",
            "https://github.com/someone/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "https://GitHub.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "https://github.com.evil.example/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "https://gist.github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "https://github.com:443/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "http://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            " https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges ",
            "https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges\n",
            "https://github.com/login?return_to=/crissmoldovan/agent-communications",
        ] {
            assert!(!allowed_link(url), "{url:?} was allowed");
        }
    }

    /// A queue item's links as the event service makes them, and the near misses on the same hosts
    /// (`src/test/fixtures/queue-links.json`, which `src/test/queue.test.tsx` holds the TypeScript port to as well).
    const QUEUE_LINKS: &str = include_str!("../../src/test/fixtures/queue-links.json");

    fn queue_links() -> (Vec<(String, String)>, Vec<String>) {
        let fixture: serde_json::Value =
            serde_json::from_str(QUEUE_LINKS).expect("queue-links.json");
        let opens = fixture["opens"]
            .as_array()
            .expect("opens")
            .iter()
            .map(|link| {
                (
                    link["kind"].as_str().expect("a kind").to_string(),
                    link["url"].as_str().expect("a url").to_string(),
                )
            })
            .collect();
        let refused = fixture["refused"]
            .as_array()
            .expect("refused")
            .iter()
            .map(|url| url.as_str().expect("a url").to_string())
            .collect();
        (opens, refused)
    }

    /// A queue item's "Open in Gmail" and "Open in Slack" (0.30.0) open exactly the two shapes the event service makes
    /// (`queueItemLink`): Gmail's `/mail/u/<n>/#all/<id>` or `/mail/?authuser=<encoded address>#all/<id>`, and Slack's
    /// `/client/<team>/<channel>` with, if anything, `/thread/<channel>-<ts>`. A doctor fix still opens none of them.
    #[test]
    fn queue_links_open_exactly_the_shapes_the_event_service_makes() {
        let (opens, _) = queue_links();
        assert!(opens.len() >= 10);
        for (kind, url) in &opens {
            assert!(queue_link(url), "{kind}: {url} was refused");
            assert!(may_open(url), "{kind}: {url} would not open");
            assert!(!allowed_link(url), "{url} is a doctor fix's link");
        }
        // A Gmail link of every account number and every id the event service writes, and every Slack shape.
        for account in ["u/0/", "u/9/", "u/42/", "?authuser=someone%40example.com"] {
            for id in ["1", "18c2f0a1b2c3d4e5", "a-b_C", &"Z".repeat(128)] {
                let url = format!("https://mail.google.com/mail/{account}#all/{id}");
                assert!(queue_link(&url), "{url}");
            }
        }
        for thread in [
            "",
            "/thread/C0123ABCD-1792921860.000100",
            "/thread/C0123ABCD-0.000000",
        ] {
            let url = format!("https://app.slack.com/client/T0123ABCD/C0123ABCD{thread}");
            assert!(queue_link(&url), "{url}");
        }
    }

    /// Anything else on those hosts is refused: Gmail's compose page, a Slack workspace's own host, Slack's admin, and
    /// each real shape with anything added or taken away.
    /// A Linear issue a delivery added (0.33.0): exactly the address the event service keeps, and nothing else of
    /// Linear's — not its settings, its API, another host, a title's words or a query.
    #[test]
    fn linear_issue_links_open_exactly_the_address_a_delivery_keeps() {
        for url in [
            "https://linear.app/example/issue/CUE-1",
            "https://linear.app/issue/CUE-12",
            "https://linear.app/example-co/issue/OPS_2-1234567890",
        ] {
            assert!(may_open(url), "{url}");
        }
        for url in [
            "http://linear.app/example/issue/CUE-1",
            "https://linear.app/example/issue/CUE-1/pay-the-invoice",
            "https://linear.app/example/issue/CUE-1?x=1",
            "https://linear.app/example/issue/CUE-1#comment",
            "https://linear.app/settings/account/security",
            "https://api.linear.app/graphql",
            "https://linear.app.example/issue/CUE-1",
            "https://evil.example/linear.app/issue/CUE-1",
            "https://linear.app/example/issue/CUE",
            "https://linear.app/a/b/issue/CUE-1",
        ] {
            assert!(!may_open(url), "{url}");
        }
    }

    #[test]
    fn queue_links_refuse_everything_else_on_gmail_and_slack() {
        let (_, refused) = queue_links();
        assert!(refused.len() >= 40);
        for url in &refused {
            assert!(!queue_link(url), "{url:?} was allowed");
            // Opening takes it only when it is a doctor fix's own link.
            assert_eq!(may_open(url), allowed_link(url), "{url:?}");
        }
        for url in [
            "https://mail.google.com/mail/?view=cm&body=hello%20there&to=someone%40example.com",
            "https://example.slack.com/signout",
            "https://app.slack.com/admin",
        ] {
            assert!(
                refused.iter().any(|each| each == url),
                "{url} is in the fixture"
            );
            assert!(!may_open(url), "{url} would open");
        }
        let long = format!(
            "https://app.slack.com/client/T0123ABCD/C0123ABCD/thread/C0123ABCD-{}.000100",
            "1".repeat(4096)
        );
        assert!(!queue_link(&long));
        // Opening still takes what it took before: the doctor fixes' hosts and the Judges README.
        for url in [
            "https://api.slack.com/apps",
            "https://myaccount.google.com/permissions",
            "https://console.cloud.google.com/apis/credentials",
            JUDGES_HELP,
        ] {
            assert!(may_open(url), "{url}");
            assert!(!queue_link(url), "{url}");
        }
    }

    #[test]
    fn profile_init_is_read_for_its_path() {
        use serde_json::json;
        assert_eq!(
            read_profile_init(CliResult::Ok {
                exit: 0,
                data: json!({ "path": "/example/config/compose/user.md", "created": true })
            }),
            Ok(ProfileOpened {
                path: "/example/config/compose/user.md".into(),
                created: true
            })
        );
        for data in [
            json!({}),
            json!({ "path": 1, "created": true }),
            json!({ "path": "/x.md" }),
        ] {
            let error = read_profile_init(CliResult::Ok {
                exit: 0,
                data: data.clone(),
            })
            .expect_err("no file");
            assert_eq!(error.code, "APP_IO", "{data}");
        }
        // The CLI's own refusal comes back with its code, and its hint after its message.
        assert_eq!(
            read_profile_init(CliResult::Failed {
                exit: 66,
                code: "NOT_FOUND".into(),
                message: "no account called \"example/x\"".into(),
                hint: Some("Known accounts: example/gmail.".into()),
            }),
            Err(AppError {
                code: "NOT_FOUND".into(),
                message: "no account called \"example/x\" Known accounts: example/gmail.".into()
            })
        );
        assert_eq!(
            read_profile_init(CliResult::Version {
                version: "0.22.0".into()
            })
            .expect_err("not an answer")
            .code,
            "APP_IO"
        );
    }

    /// A config folder with a compose folder holding `user.md`, and the files around it a profile path must not reach.
    fn config() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("a folder");
        let compose = dir.path().join("compose");
        fs::create_dir_all(compose.join("sub")).expect("compose");
        fs::write(compose.join("user.md"), "# Me\n").expect("user.md");
        fs::write(compose.join("inbox-example__gmail.md"), "").expect("an inbox's");
        fs::write(compose.join("notes.txt"), "").expect("not markdown");
        fs::write(compose.join("sub").join("deep.md"), "").expect("deeper");
        fs::create_dir_all(compose.join("folder.md")).expect("a folder named .md");
        fs::create_dir_all(dir.path().join("composer")).expect("a neighbour");
        fs::write(dir.path().join("composer").join("user.md"), "").expect("neighbour's");
        fs::write(dir.path().join("secret.md"), "").expect("outside");
        let config = dir.path().to_string_lossy().into_owned();
        (dir, config)
    }

    #[test]
    fn profile_paths_outside_compose_are_refused() {
        let (dir, config) = config();
        let compose = dir.path().join("compose");
        let at = |path: &Path| path.to_string_lossy().into_owned();
        for inside in ["user.md", "inbox-example__gmail.md"] {
            let path = compose.join(inside);
            let opened = profile_file(&config, &at(&path)).expect("inside compose");
            assert_eq!(opened, path, "{inside}");
        }
        let refused = [
            at(&compose.join("..").join("secret.md")),
            at(&dir.path().join("secret.md")),
            at(&dir.path().join("composer").join("user.md")),
            at(&compose.join("notes.txt")),
            at(&compose.join("sub").join("deep.md")),
            at(&compose.join("folder.md")),
            at(&compose.join("missing.md")),
            at(&compose.join(".md")),
            at(&compose),
            "compose/user.md".to_string(),
            "user.md".to_string(),
            String::new(),
        ];
        for path in refused {
            let error = profile_file(&config, &path).expect_err(&path);
            assert_eq!(error.code, "APP_REFUSED", "{path}");
        }
        // A link inside compose that leads out of it is not opened.
        #[cfg(unix)]
        {
            let link = compose.join("link.md");
            std::os::unix::fs::symlink(dir.path().join("secret.md"), &link).expect("a link");
            assert_eq!(
                profile_file(&config, &at(&link)).expect_err("a link").code,
                "APP_REFUSED"
            );
        }
    }
}
