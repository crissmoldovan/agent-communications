//! Runs one allowed call through its launcher, with no shell, and reads what it printed (DA4).
//!
//! The process gets the allow-list's words and nothing else: the launcher (or, on Windows, Node with the launcher as
//! its first word), the call's words, `--json` and the four folder pins. stdin is closed, so nothing can prompt — but
//! for a provider's key (0.32.0) and a document the rule editor wrote (0.33.0), which are written to it and it is closed
//! after them; a call is killed at its timeout; stdout is capped at 8 MiB; and stdout is parsed, never logged.

use crate::allowlist::{Call, Shape, Words};
use crate::grammar;
use crate::ipc::{AppError, CliResult};
use crate::launchers::{
    check_launcher, find_launcher, launcher_path, program_for, windows_node, Product, Program,
};
use crate::paths::{resolve_folders, FolderOverrides, Folders, PathEnv, Platform};
use regex::Regex;
use serde_json::Value;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};

/// The most stdout one call may print; more is unreadable.
pub const STDOUT_CAP: usize = 8 * 1024 * 1024;
/// How much stderr is kept; the rest is read and dropped, so the process never blocks on it.
const STDERR_KEPT: usize = 64 * 1024;
/// How much of stderr a failure shows, in characters.
const STDERR_SHOWN: usize = 2000;
/// How often a running call is looked at.
const POLL: Duration = Duration::from_millis(10);

/// Where and how calls run: the folders they pin, the platform, and on Windows the Node that starts launchers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunContext {
    pub folders: Folders,
    pub platform: Platform,
    pub node: Option<String>,
}

impl RunContext {
    /// This machine's: the folders from the environment and Settings' overrides, and on Windows the Node core's
    /// launcher names, or `node.exe` on PATH.
    pub fn current(overrides: &FolderOverrides) -> Self {
        let folders = resolve_folders(&PathEnv::from_process().with_overrides(overrides));
        let platform = Platform::current();
        let node = if platform == Platform::Windows {
            let core =
                std::fs::read_to_string(launcher_path(&folders, platform, Product::Core)).ok();
            windows_node(core.as_deref(), &std::env::var("PATH").unwrap_or_default())
        } else {
            None
        };
        RunContext {
            folders,
            platform,
            node,
        }
    }
}

/// The whole command line, program first: the program, its leading words, the call's words, `--json` when asked
/// for, then the pins when the call takes them. The terminal shows the same line without `--json` (Task 6).
pub fn argv(words: &Words, program: &Program, folders: &Folders, json: bool) -> Vec<String> {
    let mut line = vec![program.program.clone()];
    line.extend(program.leading.iter().cloned());
    line.extend(words.words.iter().cloned());
    if json {
        line.push("--json".into());
    }
    if words.pins {
        line.extend(folders.pins());
    }
    line
}

/// The variables a child of the app may have from the app's own environment, by name: where home, the temporary
/// folder and the programs are, the language, who the user is, and Windows' own (case does not matter there). Upper
/// case; `LC_` and `XDG_` take every name they start.
const ENV_KEPT: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "PATH",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "TERM",
    // Linux: where the keyring and gnome-terminal's server are reached.
    "DBUS_SESSION_BUS_ADDRESS",
];
const ENV_KEPT_PREFIXES: &[&str] = &["LC_", "XDG_"];
/// A terminal opens a window, so on Linux it needs the display too.
const ENV_KEPT_FOR_A_TERMINAL: &[&str] = &["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"];
/// Never passed on, even when a name above would take it: an agent's or CI's marker, which would make the CLI act for
/// an agent or switch updates off; what loads code into Node or any program; and `AGENT_COMMS_*`, whose folders the pins
/// name instead.
const ENV_NEVER: &[&str] = &["CI", "CLAUDECODE", "CODEX_HOME"];
const ENV_NEVER_PREFIXES: &[&str] = &["AGENT_", "NODE_", "LD_", "DYLD_", "GIO_"];

/// What a child gets of `vars`, the app's environment: only the names `ENV_KEPT` allows (and, for a terminal, the
/// display's), never one `ENV_NEVER` names or any with `_AGENT` in it. Names are compared without case on Windows.
pub fn child_env(
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    windows: bool,
    terminal: bool,
) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(name, _)| {
            let Some(name) = name.to_str() else {
                return false;
            };
            let name = if windows {
                name.to_ascii_uppercase()
            } else {
                name.to_string()
            };
            let kept = ENV_KEPT.contains(&name.as_str())
                || ENV_KEPT_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
                || (terminal && ENV_KEPT_FOR_A_TERMINAL.contains(&name.as_str()));
            let never = ENV_NEVER.contains(&name.as_str())
                || ENV_NEVER_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
                || name.contains("_AGENT");
            kept && !never
        })
        .collect()
}

/// The process to start: `argv`'s line handed to the operating system as words, with `NO_COLOR=1`, and
/// `AGENT_COMMS_UPDATE_CHECK=off` unless the call is doctor or `update --status`. stdin is closed and both outputs are
/// read; on Windows no console window opens. Its environment is `child_env` of the app's.
pub fn command_for(words: &Words, program: &Program, folders: &Folders, json: bool) -> Command {
    command_with_env(words, program, folders, json, std::env::vars_os())
}

/// `command_for`, with the environment it filters named.
pub(crate) fn command_with_env(
    words: &Words,
    program: &Program,
    folders: &Folders,
    json: bool,
    vars: impl IntoIterator<Item = (OsString, OsString)>,
) -> Command {
    let line = argv(words, program, folders, json);
    let mut command = Command::new(&line[0]);
    command.args(&line[1..]);
    command.env_clear();
    command.envs(child_env(vars, cfg!(windows), false));
    command.env("NO_COLOR", "1");
    if words.quiet_updates {
        command.env("AGENT_COMMS_UPDATE_CHECK", "off");
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs `call`, or says why it was not run, with the document it hands the CLI on stdin when it hands one (0.33.0).
/// Never panics.
pub fn run(call: &Call, ctx: &RunContext) -> CliResult {
    match call.words() {
        Ok(words) => match call.input() {
            Some(document) => run_inner(&words, ctx, STDOUT_CAP, Some(Input::Document(document))),
            None => run_words(&words, ctx),
        },
        Err(refused) => refused.into(),
    }
}

/// Runs already-built words, as `run` does.
pub fn run_words(words: &Words, ctx: &RunContext) -> CliResult {
    run_with(words, ctx, STDOUT_CAP)
}

/// Runs `words` with `input` on its stdin, then a newline, then stdin closed (0.32.0): the one way a secret — an AI
/// provider's key, from Settings → AI providers — reaches a launcher. It is never a word of the command line or of its
/// environment, and nothing here logs or keeps it.
pub fn run_with_input(words: &Words, ctx: &RunContext, input: &[u8]) -> CliResult {
    run_inner(words, ctx, STDOUT_CAP, Some(Input::Secret(input)))
}

/// What a call writes to the launcher's stdin.
enum Input<'a> {
    /// A provider's key: a few bytes, written before anything else into the empty pipe, so the write never waits, and
    /// never copied, so the one copy the app holds is the one that is overwritten.
    Secret(&'a [u8]),
    /// A document the rule editor wrote (0.33.0): up to tens of KiB, written from a thread of its own, so a document
    /// past the pipe's buffer never holds the watchdog below while the CLI starts.
    Document(Vec<u8>),
}

/// `run_words`, with the stdout cap named.
pub(crate) fn run_with(words: &Words, ctx: &RunContext, cap: usize) -> CliResult {
    run_inner(words, ctx, cap, None)
}

/// Runs `words`, with `input` written to stdin when there is any, and stdin closed otherwise.
fn run_inner(words: &Words, ctx: &RunContext, cap: usize, input: Option<Input<'_>>) -> CliResult {
    // Windows starts every launcher with Node: without one, nothing is looked for or started.
    if ctx.platform == Platform::Windows && ctx.node.is_none() {
        return AppError::no_node().into();
    }
    let name = words.product.name();
    let Some(launcher) = find_launcher(&ctx.folders, ctx.platform, words.product) else {
        let path = launcher_path(&ctx.folders, ctx.platform, words.product);
        return AppError::not_installed(format!("there is no {name} launcher at {path}")).into();
    };
    if let Err(refused) = check_launcher(&launcher, ctx.platform) {
        return refused.into();
    }
    let program = match program_for(&launcher, ctx.platform, ctx.node.as_deref()) {
        Ok(program) => program,
        Err(error) => return error.into(),
    };
    let json = words.shape != Shape::VersionLine;
    let mut command = command_for(words, &program, &ctx.folders, json);
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return AppError::io(format!("the {name} launcher could not be started: {error}"))
                .into()
        }
    };
    let mut document_writer = None;
    match input {
        Some(Input::Secret(input)) => {
            // At most a few KiB, into an empty pipe: the write never waits on the child. Dropping the handle closes
            // stdin, so the CLI reads to its end.
            let handed = child.stdin.take().is_some_and(|mut stdin| {
                stdin.write_all(input).is_ok()
                    && stdin.write_all(b"\n").is_ok()
                    && stdin.flush().is_ok()
            });
            if !handed {
                let _ = child.kill();
                let _ = child.wait();
                return AppError::io(format!("the {name} launcher could not be given its input"))
                    .into();
            }
        }
        Some(Input::Document(document)) => {
            let Some(mut stdin) = child.stdin.take() else {
                let _ = child.kill();
                let _ = child.wait();
                return AppError::io(format!("the {name} launcher could not be given its input"))
                    .into();
            };
            // The thread ends when the CLI has read it all, or has gone; its handle is dropped either way, which
            // closes stdin.
            document_writer = Some(thread::spawn(move || {
                stdin.write_all(&document).is_ok()
                    && stdin.write_all(b"\n").is_ok()
                    && stdin.flush().is_ok()
            }));
        }
        None => {}
    }
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return AppError::io("the launcher's output could not be read").into();
    };
    let (stdout_sender, stdout_receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = stdout_sender.send(read_capped(stdout, cap));
    });
    let (stderr_sender, stderr_receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = stderr_sender.send(read_stderr(stderr));
    });

    let deadline = Instant::now() + words.timeout;
    let timed_out = || -> CliResult {
        AppError::timeout(format!(
            "the {name} launcher did not answer within {} seconds, so it was stopped",
            words.timeout.as_secs_f32()
        ))
        .into()
    };
    let mut output: Option<io::Result<Option<Vec<u8>>>> = None;
    let status = loop {
        if output.is_none() {
            if let Ok(read) = stdout_receiver.try_recv() {
                output = Some(read);
            }
        }
        if matches!(output, Some(Ok(None))) {
            let _ = child.kill();
            let _ = child.wait();
            return unreadable(-1, &format!("more than {cap} bytes"), b"");
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return AppError::io(format!("the {name} launcher could not be watched: {error}"))
                    .into();
            }
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return timed_out();
        }
        thread::sleep(POLL);
    };
    let exit = status.code().unwrap_or(-1);
    // A CLI that answered without reading its whole document did not read the document it was given.
    if let Some(writer) = document_writer {
        if !writer.join().unwrap_or(false) && exit == 0 {
            return AppError::io(format!("the {name} launcher could not be given its input"))
                .into();
        }
    }
    let output = match output {
        Some(read) => read,
        // The process has ended; its stdout closes with it, unless something it started still holds it open.
        None => {
            match stdout_receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(read) => read,
                Err(_) => return timed_out(),
            }
        }
    };
    let stderr = stderr_receiver
        .recv_timeout(Duration::from_millis(500))
        .unwrap_or_default();
    match output {
        Ok(Some(stdout)) => parse_output(words.shape, exit, &stdout, &stderr),
        Ok(None) => unreadable(exit, &format!("more than {cap} bytes"), &stderr),
        Err(error) => AppError::io(format!(
            "the {name} launcher's output could not be read: {error}"
        ))
        .into(),
    }
}

/// Everything `reader` gives, or `None` once it gives more than `cap` bytes.
pub fn read_capped(reader: impl Read, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut buffer = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut buffer)?;
    Ok((buffer.len() <= cap).then_some(buffer))
}

/// The first `STDERR_KEPT` bytes of stderr; the rest is read and dropped.
fn read_stderr(mut reader: impl Read) -> Vec<u8> {
    let mut kept = Vec::new();
    let _ = (&mut reader)
        .take(STDERR_KEPT as u64)
        .read_to_end(&mut kept);
    let _ = io::copy(&mut reader, &mut io::sink());
    kept
}

/// stderr as text, trimmed and cut to `STDERR_SHOWN` characters.
fn excerpt(stderr: &[u8]) -> String {
    String::from_utf8_lossy(stderr)
        .trim()
        .chars()
        .take(STDERR_SHOWN)
        .collect()
}

fn unreadable(exit: i32, why: &str, stderr: &[u8]) -> CliResult {
    let shown = excerpt(stderr);
    CliResult::Failed {
        exit,
        code: "APP_UNREADABLE_OUTPUT".into(),
        message: format!(
            "agent-communications answered with output the app could not read ({why})"
        ),
        hint: (!shown.is_empty()).then_some(shown),
    }
}

static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$").expect("a pattern")
});

/// What a call's output says, read in its shape:
/// - **envelope:** exactly one JSON value. `ok: true` is `Ok`, keeping the exit code; `APPROVAL_PENDING` with an id
///   and a preview is `ApprovalPending`; any other error is `Failed`. The pre-0.24 doctor pair — its report, then a
///   `CONFIG` error — reads as its first envelope.
/// - **bare:** one JSON value at exit 0 is `Ok`; a non-zero exit is `Failed` (`CLI_FAILED`) with stderr's text.
/// - **version line:** one version, alone on its line.
///
/// Anything else is `Failed` (`APP_UNREADABLE_OUTPUT`).
pub fn parse_output(shape: Shape, exit: i32, stdout: &[u8], stderr: &[u8]) -> CliResult {
    match shape {
        Shape::VersionLine => {
            if exit != 0 {
                return cli_failed(exit, stderr, "--version");
            }
            let text = String::from_utf8_lossy(stdout);
            let line = text.trim_end_matches(['\n', '\r']);
            if line.contains(['\n', '\r']) || !VERSION.is_match(line) {
                return unreadable(exit, "no version", stderr);
            }
            CliResult::Version {
                version: line.to_string(),
            }
        }
        Shape::Bare => {
            if exit != 0 {
                return cli_failed(exit, stderr, "the events service's command");
            }
            match values(stdout).as_deref() {
                Some([value]) => CliResult::Ok {
                    exit,
                    data: value.clone(),
                },
                _ => unreadable(exit, "not one JSON value", stderr),
            }
        }
        Shape::Envelope => match values(stdout).as_deref() {
            Some([value]) => envelope(value, exit, stderr),
            Some([report, error]) if is_ok(report) && error_code(error) == Some("CONFIG") => {
                envelope(report, exit, stderr)
            }
            _ => unreadable(exit, "not one envelope", stderr),
        },
    }
}

/// Every JSON value in `stdout`, or `None` when any of it is not JSON.
fn values(stdout: &[u8]) -> Option<Vec<Value>> {
    serde_json::Deserializer::from_slice(stdout)
        .into_iter::<Value>()
        .collect::<Result<Vec<_>, _>>()
        .ok()
}

fn is_ok(value: &Value) -> bool {
    value.get("ok") == Some(&Value::Bool(true))
}

fn error_code(value: &Value) -> Option<&str> {
    if value.get("ok") != Some(&Value::Bool(false)) {
        return None;
    }
    value.get("error")?.get("code")?.as_str()
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

fn envelope(value: &Value, exit: i32, stderr: &[u8]) -> CliResult {
    if is_ok(value) {
        return CliResult::Ok {
            exit,
            data: value.get("data").cloned().unwrap_or(Value::Null),
        };
    }
    let (Some(code), Some(error)) = (error_code(value), value.get("error")) else {
        return unreadable(exit, "not an envelope", stderr);
    };
    let Some(message) = text(error, "message") else {
        return unreadable(exit, "an error with no message", stderr);
    };
    if code == "APPROVAL_PENDING" {
        if let Some(details) = error.get("details") {
            if let (Some(approval_id), Some(preview)) =
                (text(details, "approvalId"), text(details, "preview"))
            {
                // The id is handed to a terminal later: one the grammar refuses is not one the app reads.
                if !grammar::approval_id(&approval_id) {
                    return unreadable(exit, "an approval id the app does not recognise", stderr);
                }
                return CliResult::ApprovalPending {
                    approval_id,
                    preview,
                    expires_at: text(details, "expiresAt"),
                };
            }
        }
    }
    CliResult::Failed {
        exit,
        code: code.to_string(),
        message,
        hint: text(error, "hint"),
    }
}

fn cli_failed(exit: i32, stderr: &[u8], what: &str) -> CliResult {
    let shown = excerpt(stderr);
    CliResult::Failed {
        exit,
        code: "CLI_FAILED".into(),
        message: if shown.is_empty() {
            format!("{what} ended with exit {exit} and said nothing")
        } else {
            shown
        },
        hint: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // `Words` and the clock are used only by the Unix-only tests that start a real launcher.
    #[cfg_attr(windows, allow(unused_imports))]
    use crate::allowlist::{samples, Call, Shape, Words, ID};
    use crate::launchers::{Product, Program};
    use crate::paths::{Folders, Platform};
    use serde_json::json;
    use std::ffi::OsString;
    #[cfg_attr(windows, allow(unused_imports))]
    use std::time::{Duration, Instant};

    fn envelope(shape: Shape, exit: i32, stdout: &str) -> CliResult {
        parse_output(shape, exit, stdout.as_bytes(), b"")
    }

    fn failed_code(result: &CliResult) -> &str {
        match result {
            CliResult::Failed { code, .. } => code,
            other => panic!("not a failure: {other:?}"),
        }
    }

    fn example_folders() -> Folders {
        Folders {
            config_dir: "/home/example/.config/agent-communications".into(),
            state_dir: "/home/example/.config/agent-communications/state".into(),
            data_dir: "/home/example/.local/share/agent-communications".into(),
            secrets_dir: "/home/example/.config/agent-communications/secrets".into(),
        }
    }

    #[test]
    fn an_ok_envelope_keeps_its_exit_code() {
        assert_eq!(
            envelope(
                Shape::Envelope,
                0,
                "{\"ok\":true,\"schemaVersion\":1,\"data\":[{\"id\":\"x\"}]}\n"
            ),
            CliResult::Ok {
                exit: 0,
                data: json!([{ "id": "x" }])
            }
        );
        // Doctor's report when a check fails: an ok envelope, and exit 78, both kept.
        assert_eq!(
            envelope(
                Shape::Envelope,
                78,
                "{\"ok\":true,\"schemaVersion\":1,\"data\":{\"ok\":false,\"checks\":[]}}\n"
            ),
            CliResult::Ok {
                exit: 78,
                data: json!({ "ok": false, "checks": [] })
            }
        );
    }

    #[test]
    fn approval_pending_carries_id_preview_and_expiry() {
        let stdout = json!({
            "ok": false,
            "schemaVersion": 1,
            "error": {
                "code": "APPROVAL_PENDING",
                "message": "this change needs approval first: updates never",
                "hint": "run the approve command",
                "details": {
                    "approvalId": ID,
                    "policy": "chat",
                    "preview": "Updates: every-14-days → never\n<untrusted-content>x</untrusted-content>",
                    "expiresAt": "2026-10-19T12:00:00.000Z",
                    "approval": {}
                }
            }
        })
        .to_string();
        assert_eq!(
            envelope(Shape::Envelope, 10, &stdout),
            CliResult::ApprovalPending {
                approval_id: ID.into(),
                preview: "Updates: every-14-days → never\n<untrusted-content>x</untrusted-content>"
                    .into(),
                expires_at: Some("2026-10-19T12:00:00.000Z".into()),
            }
        );
        // An id the grammar refuses is not one the app will hand to a terminal: the output is unreadable.
        let forged = stdout.replace(ID, "ap_; rm -rf ~");
        assert_eq!(
            failed_code(&envelope(Shape::Envelope, 10, &forged)),
            "APP_UNREADABLE_OUTPUT"
        );
        // No expiry is no expiry.
        let bare = json!({"ok":false,"error":{"code":"APPROVAL_PENDING","message":"m","details":{"approvalId":ID,"preview":"p"}}});
        assert_eq!(
            envelope(Shape::Envelope, 10, &bare.to_string()),
            CliResult::ApprovalPending {
                approval_id: ID.into(),
                preview: "p".into(),
                expires_at: None
            }
        );
    }

    #[test]
    fn an_error_envelope_is_failed_with_code_and_hint() {
        let stdout = json!({"ok":false,"schemaVersion":1,"error":{"code":"NOT_FOUND","message":"no approval ap_x","hint":"List them with approvals list."}});
        assert_eq!(
            envelope(Shape::Envelope, 66, &stdout.to_string()),
            CliResult::Failed {
                exit: 66,
                code: "NOT_FOUND".into(),
                message: "no approval ap_x".into(),
                hint: Some("List them with approvals list.".into()),
            }
        );
        let without_hint = json!({"ok":false,"error":{"code":"USAGE","message":"usage: label"}});
        assert_eq!(
            envelope(Shape::Envelope, 64, &without_hint.to_string()),
            CliResult::Failed {
                exit: 64,
                code: "USAGE".into(),
                message: "usage: label".into(),
                hint: None
            }
        );
        // An APPROVAL_PENDING without the id and preview it promises is just a failure.
        let incomplete = json!({"ok":false,"error":{"code":"APPROVAL_PENDING","message":"m"}});
        assert_eq!(
            failed_code(&envelope(Shape::Envelope, 10, &incomplete.to_string())),
            "APPROVAL_PENDING"
        );
        // Not an envelope at all.
        for stdout in [
            "",
            "Approvals: none\n",
            "{\"ok\":\"yes\"}",
            "[1,2]",
            "{\"ok\":false}",
            "{\"ok\":true,\"data\":1",
        ] {
            assert_eq!(
                failed_code(&envelope(Shape::Envelope, 0, stdout)),
                "APP_UNREADABLE_OUTPUT",
                "{stdout:?}"
            );
        }
    }

    #[test]
    fn two_envelopes_are_unreadable_except_the_legacy_doctor_pair() {
        let ok = json!({"ok":true,"schemaVersion":1,"data":{"ok":false,"checks":[]}}).to_string();
        let config = json!({"ok":false,"schemaVersion":1,"error":{"code":"CONFIG","message":"doctor found problems"}}).to_string();
        // Before 0.24, a failing doctor printed its report and then this error: the report is what it said.
        assert_eq!(
            envelope(Shape::Envelope, 78, &format!("{ok}\n{config}\n")),
            CliResult::Ok {
                exit: 78,
                data: json!({ "ok": false, "checks": [] })
            }
        );
        // Any other pair is two answers to one question.
        let other = json!({"ok":false,"error":{"code":"NOT_FOUND","message":"x"}}).to_string();
        for stdout in [
            format!("{ok}\n{ok}\n"),
            format!("{ok}\n{other}\n"),
            format!("{config}\n{ok}\n"),
            format!("{ok}\n{config}\n{config}\n"),
        ] {
            assert_eq!(
                failed_code(&envelope(Shape::Envelope, 78, &stdout)),
                "APP_UNREADABLE_OUTPUT",
                "{stdout}"
            );
        }
    }

    #[test]
    fn bare_json_is_ok_at_zero_and_failed_with_stderr_otherwise() {
        assert_eq!(
            parse_output(
                Shape::Bare,
                0,
                b"{\"switch\":\"enabled\",\"paused\":false}\n",
                b""
            ),
            CliResult::Ok {
                exit: 0,
                data: json!({ "switch": "enabled", "paused": false })
            }
        );
        // The events CLI's failures come as text on stderr, kept to 2000 characters.
        let long = format!("the events service is not running\n{}", "é".repeat(3000));
        match parse_output(Shape::Bare, 69, b"", long.as_bytes()) {
            CliResult::Failed {
                exit,
                code,
                message,
                hint,
            } => {
                assert_eq!(exit, 69);
                assert_eq!(code, "CLI_FAILED");
                assert!(message.starts_with("the events service is not running"));
                assert_eq!(message.chars().count(), 2000);
                assert_eq!(hint, None);
            }
            other => panic!("{other:?}"),
        }
        // A failure with nothing on stderr still says what happened.
        match parse_output(Shape::Bare, 3, b"{}", b"") {
            CliResult::Failed { code, message, .. } => {
                assert_eq!(code, "CLI_FAILED");
                assert!(message.contains('3'), "{message}");
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            failed_code(&parse_output(Shape::Bare, 0, b"not json", b"")),
            "APP_UNREADABLE_OUTPUT"
        );
        assert_eq!(
            failed_code(&parse_output(Shape::Bare, 0, b"{}{}", b"")),
            "APP_UNREADABLE_OUTPUT"
        );
    }

    #[test]
    fn a_version_line_is_a_version() {
        for (stdout, version) in [
            ("0.21.0\n", "0.21.0"),
            ("0.24.0-feat-desktop\r\n", "0.24.0-feat-desktop"),
            ("1.2.3", "1.2.3"),
        ] {
            assert_eq!(
                parse_output(Shape::VersionLine, 0, stdout.as_bytes(), b""),
                CliResult::Version {
                    version: version.into()
                }
            );
        }
        for stdout in [
            "",
            "agent-communications 0.21.0\n",
            "0.21\n",
            "0.21.0\n0.22.0\n",
            "{\"ok\":true}",
        ] {
            assert_eq!(
                failed_code(&parse_output(Shape::VersionLine, 0, stdout.as_bytes(), b"")),
                "APP_UNREADABLE_OUTPUT",
                "{stdout:?}"
            );
        }
        assert_eq!(
            failed_code(&parse_output(Shape::VersionLine, 1, b"0.21.0\n", b"boom")),
            "CLI_FAILED"
        );
    }

    #[test]
    fn quiet_updates_is_off_only_for_doctor_and_update_status() {
        let program = Program {
            program: "/home/example/launch/core".into(),
            leading: vec![],
        };
        for (call, value) in samples() {
            let Ok(words) = call.words() else { continue };
            let loud = matches!(call, Call::Doctor { .. } | Call::UpdateStatus {});
            assert_eq!(words.quiet_updates, !loud, "{value}");
            let command = command_for(&words, &program, &example_folders(), true);
            let envs: Vec<(String, Option<String>)> = command
                .get_envs()
                .map(|(key, value)| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.map(|v| v.to_string_lossy().into_owned()),
                    )
                })
                .collect();
            assert!(
                envs.contains(&("NO_COLOR".into(), Some("1".into()))),
                "{value}"
            );
            assert_eq!(
                envs.contains(&("AGENT_COMMS_UPDATE_CHECK".into(), Some("off".into()))),
                !loud,
                "{value}"
            );
        }
    }

    #[test]
    fn the_command_has_no_shell_and_ends_with_the_pins() {
        let folders = example_folders();
        let words = Call::ApprovalRevoke {
            approval_id: ID.to_string().try_into().expect("an id"),
        }
        .words()
        .expect("words");
        // POSIX: the launcher is the program; nothing reads the words but it.
        let posix = Program {
            program: "/home/example/.local/share/agent-communications/launch/core".into(),
            leading: vec![],
        };
        let command = command_for(&words, &posix, &folders, true);
        assert_eq!(command.get_program(), posix.program.as_str());
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let mut expected = vec![
            "approvals".to_string(),
            "revoke".into(),
            ID.into(),
            "--json".into(),
        ];
        expected.extend(folders.pins());
        assert_eq!(args, expected);
        // Windows: node runs the launcher as its first word.
        let windows = Program {
            program: r"C:\Program Files\nodejs\node.exe".into(),
            leading: vec![
                r"C:\Users\example\AppData\Local\agent-communications\launch\core".into(),
            ],
        };
        let command = command_for(&words, &windows, &folders, true);
        assert_eq!(command.get_program(), windows.program.as_str());
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args[0], windows.leading[0]);
        assert_eq!(&args[1..], expected.as_slice());
        // No shell anywhere: the program is the launcher or node, never sh, cmd or powershell.
        for (call, _) in samples() {
            let Ok(words) = call.words() else { continue };
            let line = argv(&words, &posix, &folders, words.shape != Shape::VersionLine);
            assert_eq!(line[0], posix.program);
            for shell in [
                "sh",
                "bash",
                "zsh",
                "cmd",
                "cmd.exe",
                "powershell",
                "pwsh",
                "-c",
                "/c",
            ] {
                assert!(!line.iter().any(|word| word == shell), "{line:?}");
            }
        }
        // Without --json, as the terminal shows it, the pins still end the line.
        let plain = argv(&words, &posix, &folders, false);
        assert!(!plain.contains(&"--json".to_string()));
        assert!(plain.ends_with(&folders.pins()));
    }

    #[test]
    fn output_over_the_cap_is_unreadable() {
        let exact = vec![b'x'; 64];
        assert_eq!(
            read_capped(&exact[..], 64).expect("read"),
            Some(exact.clone())
        );
        let over = [b'x'; 65];
        assert_eq!(read_capped(&over[..], 64).expect("read"), None);
        assert_eq!(STDOUT_CAP, 8 * 1024 * 1024);
        #[cfg(unix)]
        {
            let (dir, folders) = fake_installation("#!/bin/sh\nyes x | head -c 4096\n");
            let words = Call::Label {}.words().expect("words");
            let result = run_with(&words, &context(folders), 1024);
            assert_eq!(failed_code(&result), "APP_UNREADABLE_OUTPUT", "{result:?}");
            drop(dir);
        }
    }

    #[cfg(unix)]
    fn fake_installation(core: &str) -> (tempfile::TempDir, Folders) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("a folder");
        let launch = dir.path().join("launch");
        std::fs::create_dir_all(&launch).expect("launch");
        let path = launch.join("core");
        std::fs::write(&path, core).expect("a launcher");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
        let data = dir.path().to_string_lossy().into_owned();
        let folders = Folders {
            config_dir: format!("{data}/config"),
            state_dir: format!("{data}/state"),
            data_dir: data.clone(),
            secrets_dir: format!("{data}/secrets"),
        };
        (dir, folders)
    }

    #[cfg(unix)]
    fn context(folders: Folders) -> RunContext {
        RunContext {
            folders,
            platform: Platform::current(),
            node: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_a_fake_launcher_and_reads_its_envelope() {
        let (dir, folders) = fake_installation(
            "#!/bin/sh\nhere=$(dirname \"$0\")\nprintf '%s\\n' \"$@\" > \"$here/argv\"\nprintf '%s %s\\n' \"$NO_COLOR\" \"$AGENT_COMMS_UPDATE_CHECK\" > \"$here/env\"\nprintf '{\"ok\":true,\"schemaVersion\":1,\"data\":[]}\\n'\n",
        );
        let result = run(&Call::ApprovalsPending {}, &context(folders.clone()));
        assert_eq!(
            result,
            CliResult::Ok {
                exit: 0,
                data: json!([])
            }
        );
        let argv = std::fs::read_to_string(dir.path().join("launch").join("argv")).expect("argv");
        let mut expected = vec![
            "approvals".to_string(),
            "list".into(),
            "--state".into(),
            "pending".into(),
            "--json".into(),
        ];
        expected.extend(folders.pins());
        assert_eq!(argv.lines().collect::<Vec<_>>(), expected);
        let env = std::fs::read_to_string(dir.path().join("launch").join("env")).expect("env");
        assert_eq!(env, "1 off\n");
        // The version, asked of the same launcher, takes no pins and no --json.
        let (_dir, folders) =
            fake_installation("#!/bin/sh\nprintf '%s\\n' \"$#\" >&2\nprintf '0.24.0\\n'\n");
        assert_eq!(
            run(
                &Call::Version {
                    product: Product::Core
                },
                &context(folders)
            ),
            CliResult::Version {
                version: "0.24.0".into()
            }
        );
    }

    /// A document the rule editor wrote reaches the events launcher on stdin, whole, and never in argv (0.33.0): one
    /// larger than a pipe's buffer too, while the launcher waits before it reads, and its answer is read as the events
    /// CLI's bare JSON.
    #[cfg(unix)]
    #[test]
    fn a_document_reaches_the_launcher_on_stdin_whole_and_never_in_argv() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, folders) = fake_installation("#!/bin/sh\nexit 1\n");
        let launcher = dir.path().join("launch").join("events-daemon");
        std::fs::write(
            &launcher,
            "#!/bin/sh\nhere=$(dirname \"$0\")\nprintf '%s\\n' \"$@\" > \"$here/argv\"\nsleep 0.2\ncat > \"$here/stdin\"\nprintf '{\"objectId\":\"invoices\",\"version\":3}\\n'\n",
        )
        .expect("a launcher");
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
        // Past macOS's 16 KiB pipe buffer, inside the editor's 48 KiB.
        let long = "x".repeat(40 * 1024);
        let document = json!({ "ruleId": "invoices", "version": 3, "note": long });
        let call: Call =
            serde_json::from_value(json!({ "kind": "eventsRuleUpdate", "document": document }))
                .expect("a call");
        let result = run(&call, &context(folders.clone()));
        assert_eq!(
            result,
            CliResult::Ok {
                exit: 0,
                data: json!({ "objectId": "invoices", "version": 3 })
            }
        );
        let given = std::fs::read(dir.path().join("launch").join("stdin")).expect("stdin");
        let mut expected = serde_json::to_vec(&document).expect("json");
        expected.push(b'\n');
        assert_eq!(given, expected);
        let argv = std::fs::read_to_string(dir.path().join("launch").join("argv")).expect("argv");
        let mut words = vec![
            "rule".to_string(),
            "update".into(),
            "-".into(),
            "--json".into(),
        ];
        words.extend(folders.pins());
        assert_eq!(argv.lines().collect::<Vec<_>>(), words);
        assert!(!argv.contains("xxxx"), "the document is never a word");
    }

    /// An environment an agent's terminal, CI and a hostile login could leave the app with.
    fn hostile_env() -> Vec<(OsString, OsString)> {
        [
            ("HOME", "/example/home"),
            ("PATH", "/usr/bin:/bin"),
            ("LANG", "en_GB.UTF-8"),
            ("LC_ALL", "en_GB.UTF-8"),
            ("XDG_RUNTIME_DIR", "/run/user/501"),
            ("TMPDIR", "/example/tmp"),
            ("USER", "example"),
            ("DISPLAY", ":0"),
            ("CLAUDECODE", "1"),
            ("CODEX_HOME", "/example/codex"),
            ("CI", "true"),
            ("CURSOR_AGENT", "1"),
            ("XDG_AGENT_HINT", "x"),
            ("NODE_OPTIONS", "--require /example/evil.js"),
            ("NODE_PATH", "/example/evil"),
            ("AGENT_COMMS_CONFIG_DIR", "/example/elsewhere"),
            ("AGENT_COMMS_UPDATE_CHECK", "on"),
            ("LD_PRELOAD", "/example/evil.so"),
            ("DYLD_INSERT_LIBRARIES", "/example/evil.dylib"),
            ("GIO_MODULE_DIR", "/example/evil"),
            ("GITHUB_TOKEN", "never-this"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect()
    }

    #[cfg_attr(windows, allow(dead_code))]
    const NEVER: &[&str] = &[
        "CLAUDECODE",
        "CODEX_HOME",
        "CI",
        "CURSOR_AGENT",
        "XDG_AGENT_HINT",
        "NODE_OPTIONS",
        "NODE_PATH",
        "AGENT_COMMS_CONFIG_DIR",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "GIO_MODULE_DIR",
        "GITHUB_TOKEN",
    ];

    #[test]
    fn a_child_gets_only_the_allowed_variables() {
        let names = |kept: Vec<(OsString, OsString)>| -> Vec<String> {
            kept.into_iter()
                .map(|(name, _)| name.to_string_lossy().into_owned())
                .collect()
        };
        assert_eq!(
            names(child_env(hostile_env(), false, false)),
            [
                "HOME",
                "PATH",
                "LANG",
                "LC_ALL",
                "XDG_RUNTIME_DIR",
                "TMPDIR",
                "USER"
            ]
        );
        // A terminal opens a window: it gets the display too, and nothing else more.
        assert_eq!(
            names(child_env(hostile_env(), false, true)),
            [
                "HOME",
                "PATH",
                "LANG",
                "LC_ALL",
                "XDG_RUNTIME_DIR",
                "TMPDIR",
                "USER",
                "DISPLAY"
            ]
        );
        // Windows names its variables in any case, and they are read so; POSIX names are exact.
        let windows: Vec<(OsString, OsString)> = [
            ("Path", "C:\\Windows"),
            ("SystemRoot", "C:\\Windows"),
            ("UserProfile", "C:\\Users\\example"),
            ("Node_Options", "--require x"),
            ("ClaudeCode", "1"),
            ("Agent_Comms_Data_Dir", "C:\\x"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        assert_eq!(
            names(child_env(windows.clone(), true, false)),
            ["Path", "SystemRoot", "UserProfile"]
        );
        assert!(names(child_env(windows, false, false)).is_empty());
    }

    /// The child itself: what a launcher sees of an environment like that is only what `child_env` keeps, and the
    /// app's own two.
    #[cfg(unix)]
    #[test]
    fn a_hostile_variable_never_reaches_the_launcher() {
        let (dir, folders) = fake_installation(
            "#!/bin/sh\nenv > \"$(dirname \"$0\")/env\"\nprintf '{\"ok\":true,\"schemaVersion\":1,\"data\":[]}\\n'\n",
        );
        let words = Call::Label {}.words().expect("words");
        let program = Program {
            program: dir
                .path()
                .join("launch")
                .join("core")
                .to_string_lossy()
                .into_owned(),
            leading: vec![],
        };
        let mut env = hostile_env();
        // The child needs a real PATH for `dirname`.
        env.retain(|(name, _)| name != "PATH");
        env.push(("PATH".into(), "/usr/bin:/bin".into()));
        let output = command_with_env(&words, &program, &folders, true, env)
            .output()
            .expect("ran");
        assert!(output.status.success(), "{output:?}");
        let seen = std::fs::read_to_string(dir.path().join("launch").join("env")).expect("env");
        let names: Vec<&str> = seen
            .lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name))
            .collect();
        for never in NEVER {
            assert!(
                !names.contains(never),
                "{never} reached the launcher: {names:?}"
            );
        }
        for kept in [
            "HOME",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "USER",
            "NO_COLOR",
            "AGENT_COMMS_UPDATE_CHECK",
        ] {
            assert!(names.contains(&kept), "{kept} did not: {names:?}");
        }
        assert!(seen.contains("AGENT_COMMS_UPDATE_CHECK=off\n"), "{seen}");
        assert!(!names.contains(&"DISPLAY"), "a CLI call opens no window");
    }

    #[cfg(unix)]
    #[test]
    fn a_launcher_that_hangs_is_killed_at_its_timeout() {
        let (_dir, folders) = fake_installation("#!/bin/sh\nexec sleep 30\n");
        let words = Words {
            timeout: Duration::from_millis(300),
            ..Call::Label {}.words().expect("words")
        };
        let started = Instant::now();
        let result = run_words(&words, &context(folders));
        assert_eq!(failed_code(&result), "APP_TIMEOUT", "{result:?}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_missing_launcher_is_not_installed() {
        let folders = Folders {
            data_dir: "/nonexistent/agent-communications-test".into(),
            ..example_folders()
        };
        let result = run(
            &Call::Label {},
            &RunContext {
                folders,
                platform: Platform::Linux,
                node: None,
            },
        );
        assert_eq!(failed_code(&result), "APP_NOT_INSTALLED");
        let refused = run(
            &Call::Accounts {
                product: Product::Core,
            },
            &RunContext {
                folders: example_folders(),
                platform: Platform::Linux,
                node: None,
            },
        );
        assert_eq!(failed_code(&refused), "APP_REFUSED");
    }

    #[test]
    fn a_result_crosses_ipc_tagged_by_status() {
        assert_eq!(
            serde_json::to_value(CliResult::ApprovalPending {
                approval_id: ID.into(),
                preview: "p".into(),
                expires_at: None
            })
            .expect("json"),
            json!({ "status": "approvalPending", "approvalId": ID, "preview": "p", "expiresAt": null })
        );
        assert_eq!(
            serde_json::to_value(CliResult::Failed {
                exit: 1,
                code: "X".into(),
                message: "m".into(),
                hint: None
            })
            .expect("json"),
            json!({ "status": "failed", "exit": 1, "code": "X", "message": "m", "hint": null })
        );
        assert_eq!(
            serde_json::to_value(CliResult::Version {
                version: "0.21.0".into()
            })
            .expect("json"),
            json!({ "status": "version", "version": "0.21.0" })
        );
        assert_eq!(
            serde_json::to_value(CliResult::Ok {
                exit: 0,
                data: json!(null)
            })
            .expect("json"),
            json!({ "status": "ok", "exit": 0, "data": null })
        );
    }
}
