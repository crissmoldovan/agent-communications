//! What the app opens outside itself, besides the terminal (DA7, DA15): `https://` links to slack.com or google.com
//! that a doctor fix names, and a writing profile in `<config>/compose/`, in the default editor. Both go through the
//! opener plugin from Rust: the capability file grants the webview none of its commands.

use crate::allowlist::{AccountName, Call, ConversationId};
use crate::ipc::{AppError, CliResult, ProfileOpened};
use crate::runner::{run, RunContext};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// The domains a link may go to, or a subdomain of: where doctor fixes send a person to sign in or set an app up.
pub const LINK_DOMAINS: [&str; 2] = ["slack.com", "google.com"];

/// The longest link the app opens.
const LINK_LIMIT: usize = 2048;

/// What a link never holds as it is: a URL writes each of these, and anything outside printable ASCII, as `%XX`.
const NEVER_IN_A_LINK: &[u8] = b"\"<>\\`{}";

/// Whether the app may open `url`: `https://`, then a host that is slack.com, google.com or a subdomain of either —
/// with no user, password or port, and every label letters, digits and inner hyphens — then, if anything, a path, a
/// query or a fragment of printable ASCII with nothing a URL would have encoded. The UI checks the same before it
/// asks (`allowedLink`, `src/screens/Doctor.tsx`), and sends the link as its URL parser writes it.
pub fn allowed_link(url: &str) -> bool {
    if url.len() > LINK_LIMIT {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    if !rest
        .bytes()
        .all(|byte| (0x21..=0x7E).contains(&byte) && !NEVER_IN_A_LINK.contains(&byte))
    {
        return false;
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
    labelled
        && LINK_DOMAINS
            .iter()
            .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
}

/// Opens `url` in the default browser, once `allowed_link` takes it.
pub fn open_link(app: &AppHandle, url: &str) -> Result<(), AppError> {
    if !allowed_link(url) {
        return Err(AppError::refused(
            "the app opens only https links to slack.com, google.com or a subdomain of either",
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
    fn links_allow_only_https_slack_and_google() {
        for url in [
            "https://slack.com",
            "https://slack.com/",
            "https://api.slack.com/apps",
            "https://api.slack.com/apps/A0123/oauth?x=1#scopes",
            "https://example.slack.com/admin",
            "https://google.com/",
            "https://console.cloud.google.com/apis/credentials?project=example",
            "https://myaccount.google.com/permissions",
            "https://accounts.google.com/o/oauth2/v2/auth?scope=a%20b",
            "https://Console.Cloud.Google.com/",
        ] {
            assert!(allowed_link(url), "{url} was refused");
        }
        for url in [
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
