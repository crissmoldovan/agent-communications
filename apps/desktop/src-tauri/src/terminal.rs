//! Opening the system terminal with a command the app built (desktop design DA6, DA10).
//!
//! The command is the located command: the launcher Rust found (on Windows, Node with the launcher as its first word),
//! the words this module or the allow-list built from checked values, and the four folder pins. There is no `--json`:
//! a person reads what it prints. It is never text taken from the CLI's output.
//!
//! It is the one line a shell reads (plan, Global Constraints): each word is quoted for the shell that reads it, a word
//! no quoting makes safe gives no line at all, and a line break or a format character never reaches one.
//! - **macOS:** Terminal, through `osascript`. `do script` takes the command as one AppleScript string: the line is
//!   quoted for a POSIX shell first, then escaped for AppleScript.
//! - **Linux:** the first of `x-terminal-emulator`, `gnome-terminal` and `konsole` on `PATH`, running `/bin/sh -c`
//!   with the line, then a prompt to close the window.
//! - **Windows:** cmd.exe reads the line, with each word as core quotes it for cmd.exe and PowerShell alike
//!   (`windows_word`), so nothing in it is anything cmd.exe acts on. Windows Terminal starts it when it is on `PATH` and
//!   the line is one it passes on unchanged; otherwise cmd.exe opens in a console of its own.
//! - **Anything else** — no terminal, one that would not start, or no safe line — puts the command on the clipboard
//!   instead, and the outcome says so: the line, or the words as JSON when there is no line.

use crate::allowlist::{ApprovalId, Call, Shape, Words};
use crate::ipc::{AppError, CliResult, CopyReason, TerminalCommand, TerminalOutcome};
use crate::launchers::{
    check_launcher, find_launcher, launcher_path, program_for, Product, Program,
};
use crate::paths::{Folders, Platform};
use crate::runner::{argv, child_env, run, RunContext};
use regex::Regex;
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

fn pattern(text: &str) -> Regex {
    Regex::new(text).expect("a pattern")
}

/// What a POSIX shell takes as it is (core's `posixShellWord`; JavaScript's `\w` is ASCII).
static POSIX_BARE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^[A-Za-z0-9_@%+=:,./-]+$"));

/// One word for a POSIX shell: as it is when nothing in it is special, otherwise in single quotes, inside which
/// nothing is special but the quote itself, written `'\''`. A word that starts with `=` or `~` is quoted too: zsh reads
/// `=ls` as the path of `ls`, and `~` as a home. A port of core's `posixShellWord` (`packages/core/src/command-line.ts`).
pub fn posix_word(word: &str) -> String {
    if POSIX_BARE.is_match(word) && !word.starts_with(['=', '~']) {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// A plain option, which no Windows reader does anything with.
static WINDOWS_OPTION: LazyLock<Regex> = LazyLock::new(|| pattern(r"^--?[A-Za-z][A-Za-z0-9-]*$"));
/// Ordinary characters, with `@` and `-` anywhere but first.
static WINDOWS_BARE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^[A-Za-z0-9_+=:./\\][A-Za-z0-9_@+=:./\\-]*$"));
/// What PowerShell may read as a number: core's look-ahead, `(?!\+?\.?\d)`, written as a match to refuse.
static NUMBER_LIKE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^\+?\.?[0-9]"));
/// What no quoting brings through: a double quote (curly ones too, for PowerShell), `$`, the backtick, `%`, `!`, and
/// any control, format, unassigned or private character, or a line or paragraph separator.
static WINDOWS_NEVER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r#"["$`%!\x{201C}-\x{201E}]|[\p{C}\p{Zl}\p{Zp}]"#));
/// cmd.exe's own syntax, which PowerShell passes to a `.cmd` script unquoted unless whitespace makes it quote it.
static CMD_SYNTAX: LazyLock<Regex> = LazyLock::new(|| pattern(r"[&|<>^()]"));
/// JavaScript's `\s`.
static JS_SPACE: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]",
    )
});

/// One word as cmd.exe, Windows PowerShell and PowerShell 7 all hand it to a program: as it is, in double quotes, or
/// `None` when no printing of it does. A port of core's `windowsShellWord` (`packages/core/src/command-line.ts`), whose
/// comment on `quoteCommand` says why each character is refused.
pub fn windows_word(word: &str) -> Option<String> {
    if WINDOWS_OPTION.is_match(word) || (WINDOWS_BARE.is_match(word) && !NUMBER_LIKE.is_match(word))
    {
        return Some(word.to_string());
    }
    if word.is_empty() || word.ends_with('\\') {
        return None;
    }
    if WINDOWS_NEVER.is_match(word) {
        return None;
    }
    if CMD_SYNTAX.is_match(word) && !JS_SPACE.is_match(word) {
        return None;
    }
    Some(format!("\"{word}\""))
}

/// The words as a JSON array that runs nothing pasted into either Windows shell: a port of core's `commandAsJson`
/// (`packages/core/src/command-line.ts`). Printable ASCII only; `"`, `%`, `!`, `$` and the backtick, and everything
/// else outside it, are `\u` escapes of their UTF-16 code units, as JavaScript writes them; a backslash is doubled.
pub fn json_words(words: &[String]) -> String {
    let word = |text: &str| {
        let mut json = String::from("\"");
        for unit in text.encode_utf16() {
            match unit {
                0x5C => json.push_str("\\\\"),
                0x20..=0x7E if !matches!(unit as u8, b'"' | b'%' | b'!' | b'$' | b'`') => {
                    json.push(char::from(unit as u8))
                }
                _ => json.push_str(&format!("\\u{unit:04x}")),
            }
        }
        json.push('"');
        json
    };
    format!(
        "[{}]",
        words
            .iter()
            .map(|each| word(each))
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// What never goes into a line on any platform: a control character (a line break ends a command, or starts the next
/// one, wherever it is), a format character (a right-to-left override shows a line other than the one that runs), or a
/// line or paragraph separator.
static NEVER_IN_A_LINE: LazyLock<Regex> = LazyLock::new(|| pattern(r"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]"));

/// The words as one line for the platform's shell — POSIX quoting on macOS and Linux, `windows_word`'s on Windows,
/// where cmd.exe reads it and its program may be quoted too — or `None` when there is no safe one.
pub fn line(words: &[String], platform: Platform) -> Option<String> {
    if words.is_empty() || words.iter().any(|word| NEVER_IN_A_LINE.is_match(word)) {
        return None;
    }
    let printed: Option<Vec<String>> = match platform {
        Platform::Windows => words.iter().map(|word| windows_word(word)).collect(),
        Platform::MacOs | Platform::Linux => {
            Some(words.iter().map(|word| posix_word(word)).collect())
        }
    };
    printed.map(|printed| printed.join(" "))
}

/// What to do with a command: start a terminal with it, or copy it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Start `program` with `args`, and no shell of the app's own.
    Spawn {
        program: String,
        args: Vec<String>,
        /// Windows: the arguments are written into the command line exactly as they are (`raw_arg`), since cmd.exe
        /// does not read the C runtime's quoting.
        raw: bool,
        /// Windows: the program gets a console window of its own (`CREATE_NEW_CONSOLE`).
        new_console: bool,
        /// Whether the program ends once the terminal has the command (osascript), so its exit says whether it did.
        wait: bool,
        /// The terminal, as the outcome names it.
        via: &'static str,
    },
    /// Put `text` on the clipboard, and say why.
    Copy { text: String, reason: CopyReason },
}

/// Where macOS keeps `osascript`.
pub const OSASCRIPT: &str = "/usr/bin/osascript";

/// The Linux terminals tried, in order, each with the flag after which it takes a program and its words.
const LINUX_TERMINALS: [(&str, &str); 3] = [
    ("x-terminal-emulator", "-e"),
    ("gnome-terminal", "--"),
    ("konsole", "-e"),
];

/// What a Linux terminal's shell runs after the line, so its window stays until the person has read it.
const HOLD: &str = "printf '\\n%s\\n' 'Done. Press Enter to close this window.'; read -r _";

/// Whether Windows Terminal passes the line to cmd.exe as it is. It splits its own command line at `;`, takes a
/// backslash before a quote as an escape, and quotes again any word with a space after splitting the rest: a line with
/// no `;`, no `"` and no final backslash is one word to it, which it hands on in the same quotes.
fn windows_terminal_keeps(line: &str) -> bool {
    !line.contains([';', '"']) && !line.ends_with('\\')
}

/// What opening `words` comes to on `platform`, with `found` saying where a program is (`None` when it is not there).
pub fn plan(platform: Platform, words: &[String], found: &dyn Fn(&str) -> Option<String>) -> Plan {
    let Some(text) = line(words, platform) else {
        return Plan::Copy {
            text: json_words(words),
            reason: CopyReason::NoSafeLine,
        };
    };
    let owned = |args: &[&str]| args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    match platform {
        Platform::MacOs => Plan::Spawn {
            program: OSASCRIPT.into(),
            args: owned(&[
                "-e",
                "tell application \"Terminal\"",
                "-e",
                "activate",
                "-e",
                &format!("do script {}", applescript_string(&text)),
                "-e",
                "end tell",
            ]),
            raw: false,
            new_console: false,
            wait: true,
            via: "Terminal",
        },
        Platform::Linux => {
            for (name, flag) in LINUX_TERMINALS {
                if let Some(program) = found(name) {
                    return Plan::Spawn {
                        program,
                        args: owned(&[flag, "/bin/sh", "-c", &format!("{text}; {HOLD}")]),
                        raw: false,
                        new_console: false,
                        wait: false,
                        via: name,
                    };
                }
            }
            Plan::Copy {
                text,
                reason: CopyReason::NoTerminal,
            }
        }
        Platform::Windows => {
            // `/s /k "<line>"`: cmd.exe takes off the outer quotes and runs the rest as it is, then keeps the window.
            let quoted = format!("\"{text}\"");
            if windows_terminal_keeps(&text) {
                if let Some(program) = found("wt.exe") {
                    return Plan::Spawn {
                        program,
                        args: owned(&["-w", "new", "cmd", "/s", "/k", &quoted]),
                        raw: true,
                        new_console: false,
                        wait: false,
                        via: "Windows Terminal",
                    };
                }
            }
            match found("cmd.exe") {
                Some(program) => Plan::Spawn {
                    program,
                    args: owned(&["/s", "/k", &quoted]),
                    raw: true,
                    new_console: true,
                    wait: false,
                    via: "Command Prompt",
                },
                None => Plan::Copy {
                    text,
                    reason: CopyReason::NoTerminal,
                },
            }
        }
    }
}

/// `text` as an AppleScript string literal: in double quotes, with a backslash and a double quote escaped, and the
/// three escapes AppleScript has for a tab and line breaks (a line never holds one; `line` refuses them).
pub fn applescript_string(text: &str) -> String {
    let mut quoted = String::from("\"");
    for c in text.chars() {
        match c {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            other => quoted.push(other),
        }
    }
    quoted.push('"');
    quoted
}

/// The product whose launcher opens `command`, and the words after it, before the pins:
/// - **Approve:** that channel's `approve <id>`, through its own launcher; the events service approves nothing.
/// - **Change:** the change itself, as the allow-list builds it; refused unless the call prepares a change.
/// - **Sign in:** gmail `inbox add|reauth <account>`, slack `workspace add|reauth <account>`, resend
///   `account add <account>`; a Resend account has no sign-in again, and no other product has a sign-in.
/// - **Laya's Enable:** the events service's `judge kind enable laya`, and nothing else: the terminal shows its preview
///   and takes its approval (E2 Task 11).
/// - **Turning on Jev or a local model server:** the events service's `judge kind enable typesafe|local-endpoint`, the
///   kind from its closed enum, as Laya's Enable (0.27.1).
/// - **Binding a lane:** the events service's `lane bind <lane> --window <id>` (0.31.0, design 2026-10-25-routing B1):
///   the person runs it; the app never binds (DA10). The lane and the window each come from a closed grammar.
pub fn command_words(command: &TerminalCommand) -> Result<(Product, Vec<String>), AppError> {
    Ok(match command {
        TerminalCommand::Approve {
            product,
            approval_id,
        } => {
            if *product == Product::EventsDaemon {
                return Err(AppError::refused(
                    "the events service has no approvals of its own to approve",
                ));
            }
            (
                *product,
                vec!["approve".into(), approval_id.as_str().to_string()],
            )
        }
        TerminalCommand::Change { call, .. } => {
            if !call.prepares_change() {
                return Err(AppError::refused(
                    "only a change the app prepared opens in the terminal",
                ));
            }
            let built = call.words()?;
            (built.product, built.words)
        }
        TerminalCommand::SignIn {
            product,
            account,
            again,
        } => {
            let verb: [&str; 2] =
                match (product, again) {
                    (Product::Gmail, false) => ["inbox", "add"],
                    (Product::Gmail, true) => ["inbox", "reauth"],
                    (Product::Slack, false) => ["workspace", "add"],
                    (Product::Slack, true) => ["workspace", "reauth"],
                    (Product::Resend, false) => ["account", "add"],
                    (Product::Resend, true) => return Err(AppError::refused(
                        "a Resend account has no sign-in again: its key is added with account add",
                    )),
                    (other, _) => {
                        return Err(AppError::refused(format!(
                            "{} has no sign-in",
                            other.name()
                        )))
                    }
                };
            (
                *product,
                vec![
                    verb[0].to_string(),
                    verb[1].to_string(),
                    account.as_str().to_string(),
                ],
            )
        }
        TerminalCommand::EventsJudgeKindEnable { .. } => (
            Product::EventsDaemon,
            ["judge", "kind", "enable", "laya"]
                .iter()
                .map(|word| word.to_string())
                .collect(),
        ),
        TerminalCommand::JudgeKindEnable { judge_kind } => (
            Product::EventsDaemon,
            vec![
                "judge".to_string(),
                "kind".to_string(),
                "enable".to_string(),
                judge_kind.word().to_string(),
            ],
        ),
        TerminalCommand::LaneBind { lane, window } => (
            Product::EventsDaemon,
            vec![
                "lane".to_string(),
                "bind".to_string(),
                lane.as_str().to_string(),
                "--window".to_string(),
                window.as_str().to_string(),
            ],
        ),
    })
}

/// The located line: the launcher's program and leading words, `words`, and the four pins. There is no `--json`: a
/// person reads what it prints.
pub fn located_line(
    product: Product,
    words: &[String],
    program: &Program,
    folders: &Folders,
) -> Vec<String> {
    let words = Words {
        product,
        words: words.to_vec(),
        shape: Shape::Envelope,
        pins: true,
        quiet_updates: true,
        timeout: Duration::from_secs(30),
    };
    argv(&words, program, folders, false)
}

/// The located command for `command` (`command_words`), through the launcher this installation has for it.
pub fn argv_for(command: &TerminalCommand, ctx: &RunContext) -> Result<Vec<String>, AppError> {
    let (product, words) = command_words(command)?;
    if ctx.platform == Platform::Windows && ctx.node.is_none() {
        return Err(AppError::no_node());
    }
    let launcher = find_launcher(&ctx.folders, ctx.platform, product).ok_or_else(|| {
        AppError::not_installed(format!(
            "there is no {} launcher at {}",
            product.name(),
            launcher_path(&ctx.folders, ctx.platform, product)
        ))
    })?;
    check_launcher(&launcher, ctx.platform)?;
    let program = program_for(&launcher, ctx.platform, ctx.node.as_deref())?;
    Ok(located_line(product, &words, &program, &ctx.folders))
}

/// The approvals the app's own previews wait on (DA10; DA16, after review): each id a change the app prepared came back
/// with, `APPROVAL_PENDING`, and that change. Opening a change in the terminal names the id it revokes first; only an id
/// recorded here for an equal call is taken, and only once, so the webview cannot have the app revoke an approval that
/// is not that preview's. A preview left without Approve or Cancel is revoked through `revoke_preview`.
#[derive(Debug, Default)]
pub struct Prepared(Mutex<HashMap<String, Call>>);

impl Prepared {
    fn map(&self) -> MutexGuard<'_, HashMap<String, Call>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records what `call` came to, when it is a change the app prepares and it came back waiting for approval.
    pub fn record(&self, call: &Call, result: &CliResult) {
        if !call.prepares_change() {
            return;
        }
        if let CliResult::ApprovalPending { approval_id, .. } = result {
            self.map().insert(approval_id.clone(), call.clone());
        }
    }

    /// Takes `id` for opening `call`: refused unless it was recorded for an equal call. Taken once.
    pub fn take_for(&self, id: &ApprovalId, call: &Call) -> Result<(), AppError> {
        let mut map = self.map();
        if map.get(id.as_str()) == Some(call) {
            map.remove(id.as_str());
            return Ok(());
        }
        Err(AppError::refused(
            "that approval is not the one the app prepared for this change: prepare the change again",
        ))
    }

    /// Takes `id` whatever change it was for, giving the change back: refused unless it was recorded.
    pub fn take(&self, id: &ApprovalId) -> Result<Call, AppError> {
        self.map().remove(id.as_str()).ok_or_else(|| {
            AppError::refused("that approval is not one a preview of the app is waiting on")
        })
    }

    /// Puts back what `take` took, when the revoke it was for did not happen.
    pub fn restore(&self, id: &ApprovalId, call: Call) {
        self.map().insert(id.as_str().to_string(), call);
    }

    /// Forgets `id`: it was revoked some other way.
    pub fn forget(&self, id: &str) {
        self.map().remove(id);
    }
}

/// Revokes a preview's own pending approval, when the preview is left without Approve or Cancel, or is cancelled: only
/// an id `Prepared` recorded, through core's `approvals revoke`, whose answer is given back. When the revoke did not
/// happen the record is kept, so the person can try again.
pub fn revoke_preview_with(
    prepared: &Prepared,
    id: &ApprovalId,
    revoke: impl FnOnce(&ApprovalId) -> CliResult,
) -> Result<CliResult, AppError> {
    let call = prepared.take(id)?;
    let result = revoke(id);
    if !matches!(result, CliResult::Ok { exit: 0, .. }) {
        prepared.restore(id, call);
    }
    Ok(result)
}

/// What opening the terminal does to the machine, so the tests can stand in for it: the revoke, finding a program,
/// starting it, and the clipboard.
pub trait Effects {
    /// Revokes the app's own pending approval; true when core says it is revoked.
    fn revoke(&self, approval: &ApprovalId, ctx: &RunContext) -> bool;
    /// Where `program` is, when it is there.
    fn found(&self, program: &str) -> Option<String>;
    /// Starts a planned terminal; an error when it did not start, or (osascript) ended in failure.
    fn spawn(&self, plan: &Plan) -> Result<(), String>;
    /// Puts `text` on the clipboard.
    fn copy(&self, text: &str) -> Result<(), AppError>;
}

/// Opens `command` through `effects`: the command is built (or refused) first; a change's approval must be the one
/// `prepared` recorded for that change; it is revoked next, and the result recorded; then the terminal opens either
/// way (DA10). A terminal that does not start is one there is not, so the command is copied instead, and every copy
/// says why.
pub fn open_with(
    command: TerminalCommand,
    ctx: &RunContext,
    effects: &dyn Effects,
    prepared: &Prepared,
) -> Result<TerminalOutcome, AppError> {
    let words = argv_for(&command, ctx)?;
    if let TerminalCommand::Change { call, revoke } = &command {
        prepared.take_for(revoke, call)?;
    }
    let revoked = match &command {
        TerminalCommand::Change { revoke, .. } => Some(effects.revoke(revoke, ctx)),
        TerminalCommand::Approve { .. }
        | TerminalCommand::SignIn { .. }
        | TerminalCommand::JudgeKindEnable { .. }
        | TerminalCommand::LaneBind { .. }
        | TerminalCommand::EventsJudgeKindEnable { .. } => None,
    };
    let planned = plan(ctx.platform, &words, &|name| effects.found(name));
    let (text, reason) = match &planned {
        Plan::Spawn { via, .. } => match effects.spawn(&planned) {
            Ok(()) => {
                return Ok(TerminalOutcome::Opened {
                    via: via.to_string(),
                    revoked,
                })
            }
            Err(_) => (
                line(&words, ctx.platform).unwrap_or_else(|| json_words(&words)),
                CopyReason::NoTerminal,
            ),
        },
        Plan::Copy { text, reason } => (text.clone(), *reason),
    };
    effects.copy(&text)?;
    Ok(TerminalOutcome::Copied { reason, revoked })
}

/// This machine's effects: core's `approvals revoke`, `PATH`, the processes, and the clipboard.
struct System<'a> {
    app: &'a AppHandle,
}

impl Effects for System<'_> {
    fn revoke(&self, approval: &ApprovalId, ctx: &RunContext) -> bool {
        matches!(
            run(
                &Call::ApprovalRevoke {
                    approval_id: approval.clone()
                },
                ctx
            ),
            CliResult::Ok { exit: 0, .. }
        )
    }

    fn found(&self, program: &str) -> Option<String> {
        locate(program)
    }

    fn spawn(&self, plan: &Plan) -> Result<(), String> {
        spawn(plan)
    }

    fn copy(&self, text: &str) -> Result<(), AppError> {
        copy(self.app, text)
    }
}

/// Opens the system terminal with `command` (DA6, DA10), or copies it and says why.
pub fn open(
    app: &AppHandle,
    command: TerminalCommand,
    ctx: &RunContext,
    prepared: &Prepared,
) -> Result<TerminalOutcome, AppError> {
    open_with(command, ctx, &System { app }, prepared)
}

/// Where `program` is: on Windows `cmd.exe` is `%SystemRoot%\System32\cmd.exe`; anything else is looked for in each
/// absolute folder of `PATH`, in order, as a file (one that can be run, on macOS and Linux). A relative folder is
/// skipped, so nothing is ever started from the app's working folder.
pub fn locate(program: &str) -> Option<String> {
    if cfg!(windows) && program == "cmd.exe" {
        let root = std::env::var("SystemRoot")
            .ok()
            .filter(|root| !root.is_empty())
            .unwrap_or_else(|| "C:\\Windows".into());
        let path = Path::new(&root).join("System32").join("cmd.exe");
        return path.is_file().then(|| path.to_string_lossy().into_owned());
    }
    let folders = std::env::var_os("PATH")?;
    std::env::split_paths(&folders)
        .filter(|folder| folder.is_absolute())
        .map(|folder| folder.join(program))
        .find(|candidate| runnable(candidate))
        .map(|found| found.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

/// On Windows, `wt.exe` is an app execution alias: a reparse point that reading its metadata through may not follow.
#[cfg(not(unix))]
fn runnable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
        || std::fs::symlink_metadata(path).is_ok_and(|metadata| !metadata.is_dir())
}

/// How long osascript may take to hand Terminal the command: the first time, macOS asks the person whether the app
/// may control Terminal, and osascript waits for their answer.
const OSASCRIPT_WAIT: Duration = Duration::from_secs(120);

/// Starts a planned terminal. A terminal lives as long as its window, so it is waited for on a thread of its own and
/// never lingers as a zombie; osascript ends once Terminal has the command, and its exit says whether it did. On macOS
/// and Linux the terminal gets none of the app's standard streams; on Windows they are left as they are, so a new
/// console gives cmd.exe its own. The terminal gets `child_env` of the app's environment, with the display's: an agent's
/// marker, `NODE_OPTIONS` or `AGENT_COMMS_*` never reaches the shell it starts.
pub fn spawn(plan: &Plan) -> Result<(), String> {
    spawn_with_env(plan, std::env::vars_os())
}

/// `spawn`, with the environment it filters named.
pub(crate) fn spawn_with_env(
    plan: &Plan,
    vars: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
) -> Result<(), String> {
    let Plan::Spawn {
        program,
        args,
        raw,
        new_console,
        wait,
        ..
    } = plan
    else {
        return Err("there is nothing to start".into());
    };
    let mut command = Command::new(program);
    command.env_clear();
    command.envs(child_env(vars, cfg!(windows), true));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        if *raw {
            for arg in args {
                command.raw_arg(arg);
            }
        } else {
            command.args(args);
        }
        if *new_console {
            command.creation_flags(CREATE_NEW_CONSOLE);
        }
    }
    #[cfg(not(windows))]
    {
        use std::process::Stdio;
        let _ = (raw, new_console);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("{program} could not be started: {error}"))?;
    if !*wait {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return Ok(());
    }
    let deadline = Instant::now() + OSASCRIPT_WAIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => return Err(format!("{program} ended with {status}")),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} did not finish"));
            }
            Err(error) => return Err(format!("{program} could not be watched: {error}")),
        }
    }
}

/// The most text Copy takes.
pub const COPY_LIMIT: usize = 64 * 1024;

/// What copied text may not hold: a control character but a line break or a tab (a carriage return or an escape
/// sequence pastes as something other than what was shown), or a format character (a right-to-left override shows
/// text other than what pastes). Line breaks and tabs stay, after review too (DA16): a doctor fix is often several
/// lines, and Copy gives exactly the text the screen shows.
static NEVER_COPIED: LazyLock<Regex> = LazyLock::new(|| pattern(r"[\p{Cf}]|[^\P{Cc}\n\t]"));

/// Whether `text` is something Copy takes: at most `COPY_LIMIT` bytes, and nothing `NEVER_COPIED` names.
pub fn copyable(text: &str) -> bool {
    text.len() <= COPY_LIMIT && !NEVER_COPIED.is_match(text)
}

/// Puts `text` on the clipboard (Copy, and every terminal fallback).
pub fn copy(app: &AppHandle, text: &str) -> Result<(), AppError> {
    if !copyable(text) {
        return Err(AppError::refused(
            "that text is too long to copy, or holds a character that would paste as something other than what is shown",
        ));
    }
    app.clipboard()
        .write_text(text)
        .map_err(|error| AppError::io(format!("the clipboard could not be written: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::{Call, UpdateLevel, ID};
    use crate::launchers::{launcher_path, Product};
    use crate::paths::Folders;
    use std::cell::RefCell;
    use std::fs;
    use std::path::Path;

    fn strings(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| word.to_string()).collect()
    }

    fn id() -> ApprovalId {
        ApprovalId::try_from(ID.to_string()).expect("an id")
    }

    fn account(name: &str) -> crate::allowlist::AccountName {
        crate::allowlist::AccountName::try_from(name.to_string()).expect("an account")
    }

    /// Core's `UNSAFE_ON_WINDOWS` (`packages/core/test/cli.test.ts`): words no quoting makes safe in both Windows
    /// shells.
    const UNSAFE_ON_WINDOWS: &[&str] = &[
        "$x&whoami&",
        "$(calc)",
        "$HOME\\outgoing",
        "a\"b",
        "say \u{201C}hi\u{201D}",
        "50%",
        "%USERPROFILE%\\outgoing",
        "--%",
        "!x!",
        "a`b",
        "line\nbreak",
        "tab\there",
        "right\u{202E}left",
        "",
        "C:\\Profiles\\First Last\\",
        "a&b",
        "a&whoami&",
        "x|y",
        "a^b",
        "(a)",
        "a<b>",
    ];

    /// The hostile words the app's own lines are held to: quotes, expansions, separators, cmd.exe's syntax, a line
    /// break.
    const HOSTILE: &[&str] = &[
        "it's",
        "say \"hi\"",
        "$(id)",
        "`id`",
        "a;b",
        "a & b",
        "a | b",
        "50%",
        "a ^ b",
        "$HOME",
        "~/x",
        "*",
        "a\\b",
        "two  spaces",
        "",
    ];

    #[test]
    fn posix_and_windows_words_match_core_on_its_cases() {
        // POSIX (core's "quoted for a POSIX shell everywhere but Windows").
        let posix = |words: &[&str]| {
            words
                .iter()
                .map(|word| posix_word(word))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(
            posix(&["example", "update", "--auto", "off"]),
            "example update --auto off"
        );
        assert_eq!(
            posix(&[
                "example",
                "attach",
                "roots",
                "add",
                "/srv/First Last/outgoing"
            ]),
            "example attach roots add '/srv/First Last/outgoing'"
        );
        assert_eq!(
            posix(&[
                "it's",
                "$HOME",
                "~/outgoing",
                "C:\\Profiles\\outgoing",
                "a,b",
                "@name",
                ""
            ]),
            "'it'\\''s' '$HOME' '~/outgoing' 'C:\\Profiles\\outgoing' a,b @name ''"
        );
        for word in UNSAFE_ON_WINDOWS {
            let quoted = if ["50%", "--%"].contains(word) {
                word.to_string()
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            };
            assert_eq!(posix_word(word), quoted, "{word:?}");
        }
        assert_eq!(
            posix(&["/opt/node js/bin/node", "cli.mjs"]),
            "'/opt/node js/bin/node' cli.mjs"
        );
        // zsh reads a word that starts with `=` as a command's path (`=ls` is `/bin/ls`), and `~` as a home: both are
        // quoted, as core quotes them. An `=` further in is nothing to either shell.
        assert_eq!(
            posix(&["claude", "=ls", "=", "~", "~root", "--name=x", "a=b"]),
            "claude '=ls' '=' '~' '~root' --name=x a=b"
        );

        // Windows (core's "one cmd.exe and PowerShell both read alike").
        let win = |words: &[&str]| {
            words
                .iter()
                .map(|word| windows_word(word).unwrap_or_else(|| panic!("{word:?} has a form")))
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(
            win(&[
                "example",
                "attach",
                "roots",
                "add",
                "C:\\Profiles\\First Last\\outgoing"
            ]),
            "example attach roots add \"C:\\Profiles\\First Last\\outgoing\""
        );
        let bare = [
            "C:\\Profiles\\outgoing",
            "\\outgoing",
            "C:outgoing",
            "C:\\Profiles\\",
            "acme/gmail",
            "pkg@1.2.3",
            "--force",
            "-x",
        ];
        assert_eq!(win(&bare), bare.join(" "));
        for word in [
            "@name",
            "a,b",
            "~/outgoing",
            " outgoing ",
            "a & b",
            "x | y",
            "a ^ b",
            "a;b",
            "(a b)",
            "a <b>",
            "#a",
            "{a}",
            "it's",
            "it\u{2019}s here",
            "caf\u{e9}",
            "a \u{2014} b",
            "1kb",
            "0x10",
            ".5",
            "-name.x",
            "--name=x",
            "C:\\Profiles\\First Last\\x",
        ] {
            assert_eq!(windows_word(word), Some(format!("\"{word}\"")), "{word:?}");
        }
        for word in UNSAFE_ON_WINDOWS {
            assert_eq!(windows_word(word), None, "{word:?}");
        }

        // The words as JSON (core's `commandAsJson`).
        assert_eq!(
            json_words(&strings(&[
                "agent-gmail",
                "mcp",
                "install",
                "--name",
                "$x&whoami&",
                "--force"
            ])),
            "[\"agent-gmail\",\"mcp\",\"install\",\"--name\",\"\\u0024x&whoami&\",\"--force\"]"
        );
        let mut words = strings(&["example"]);
        words.extend(strings(UNSAFE_ON_WINDOWS));
        words.extend(strings(&[
            "a\"&calc&\"b",
            "na\u{ef}ve",
            "\u{1F600}",
            "\u{2028}",
            "it's",
        ]));
        let json = json_words(&words);
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&json).expect("JSON"),
            words
        );
        assert!(json.starts_with("[\"example\","));
        assert!(json.chars().all(|c| (' '..='~').contains(&c)), "{json}");
        assert!(!json.contains(['%', '!', '$', '`']), "{json}");
        // A character outside the BMP is two UTF-16 escapes, as JavaScript writes it.
        assert_eq!(json_words(&strings(&["\u{1F600}"])), "[\"\\ud83d\\ude00\"]");
    }

    #[test]
    fn a_line_break_or_a_format_character_never_makes_a_line() {
        for platform in [Platform::MacOs, Platform::Linux, Platform::Windows] {
            for word in [
                "line\nbreak",
                "carriage\rreturn",
                "tab\there",
                "right\u{202E}left",
                "\u{2028}",
                "nul\0",
            ] {
                assert_eq!(
                    line(
                        &strings(&["/example/launch/core", "approve", word]),
                        platform
                    ),
                    None,
                    "{platform:?} {word:?}"
                );
            }
            assert_eq!(line(&[], platform), None);
        }
        // Everything else has a POSIX line; on Windows only what cmd.exe reads as written.
        for word in HOSTILE {
            assert!(line(&strings(&["/x/core", word]), Platform::Linux).is_some());
        }
        assert_eq!(
            line(
                &strings(&["/x/core", "$(id)", "`id`", "a;b"]),
                Platform::MacOs
            ),
            Some("/x/core '$(id)' '`id`' 'a;b'".into())
        );
        for word in [
            "$(touch x)",
            "`id`",
            "50%",
            "a&b",
            "x|y",
            "a^b",
            "say \"hi\"",
            "!x!",
        ] {
            assert_eq!(
                line(&strings(&["C:\\x\\node.exe", word]), Platform::Windows),
                None,
                "{word:?}"
            );
        }
    }

    /// The POSIX line, read by `/bin/sh`, hands the program exactly the words: nothing is expanded, split or run.
    #[cfg(unix)]
    #[test]
    fn the_posix_line_gives_sh_back_every_hostile_word() {
        let dir = tempfile::tempdir().expect("a folder");
        let marker = dir.path().join("ran");
        let program = dir.path().join("print args");
        fs::write(
            &program,
            "#!/bin/sh\nfor word in \"$@\"; do printf '[%s]\\n' \"$word\"; done\n",
        )
        .expect("a script");
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).expect("executable");
        }
        let mut words = vec![program.to_string_lossy().into_owned()];
        words.extend(strings(HOSTILE));
        words.push(format!("$(touch {})", marker.display()));
        words.push(format!("`touch {}`", marker.display()));
        words.push(format!("; touch {}", marker.display()));
        let text = line(&words, Platform::Linux).expect("a line");
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&text)
            .output()
            .expect("sh ran");
        assert!(output.status.success(), "{output:?}");
        let printed: Vec<String> = String::from_utf8(output.stdout)
            .expect("text")
            .lines()
            .map(|each| {
                let word = each
                    .strip_prefix('[')
                    .and_then(|rest| rest.strip_suffix(']'));
                word.expect("one bracketed word a line").to_string()
            })
            .collect();
        assert_eq!(printed, words[1..].to_vec());
        assert!(!marker.exists(), "a word was run");
    }

    /// The same line, read by zsh as it comes (`-f`: no startup files, its default options, EQUALS among them), hands
    /// the program exactly the words too. Skipped where there is no `/bin/zsh`.
    #[cfg(unix)]
    #[test]
    fn the_posix_line_gives_zsh_back_every_hostile_word() {
        if !Path::new("/bin/zsh").exists() {
            eprintln!("skipped: there is no /bin/zsh here");
            return;
        }
        let dir = tempfile::tempdir().expect("a folder");
        let marker = dir.path().join("ran");
        let program = dir.path().join("print args");
        fs::write(
            &program,
            "#!/bin/sh\nfor word in \"$@\"; do printf '[%s]\\n' \"$word\"; done\n",
        )
        .expect("a script");
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).expect("executable");
        }
        let mut words = vec![program.to_string_lossy().into_owned()];
        words.extend(strings(HOSTILE));
        words.extend(strings(&[
            "=ls", "=", "~", "~root", "--name=x", "a=b", "?", "[a]", "{a,b}", "#x", "^x", "!x",
            "%1",
        ]));
        words.push(format!("$(touch {})", marker.display()));
        let text = line(&words, Platform::MacOs).expect("a line");
        let output = std::process::Command::new("/bin/zsh")
            .args(["-f", "-c", &text])
            .output()
            .expect("zsh ran");
        assert!(output.status.success(), "{output:?}");
        let printed: Vec<String> = String::from_utf8(output.stdout)
            .expect("text")
            .lines()
            .map(|each| {
                let word = each
                    .strip_prefix('[')
                    .and_then(|rest| rest.strip_suffix(']'));
                word.expect("one bracketed word a line").to_string()
            })
            .collect();
        assert_eq!(printed, words[1..].to_vec());
        assert!(!marker.exists(), "a word was run");
    }

    /// The terminal itself: started with an environment an agent's terminal could leave the app with, it sees only
    /// what `child_env` keeps for a terminal.
    #[cfg(unix)]
    #[test]
    fn a_hostile_variable_never_reaches_the_terminal() {
        let dir = tempfile::tempdir().expect("a folder");
        let seen = dir.path().join("env");
        let plan = Plan::Spawn {
            program: "/bin/sh".into(),
            args: strings(&["-c", &format!("env > '{}'", seen.display())]),
            raw: false,
            new_console: false,
            wait: true,
            via: "Terminal",
        };
        let env: Vec<(std::ffi::OsString, std::ffi::OsString)> = [
            ("HOME", "/example/home"),
            ("PATH", "/usr/bin:/bin"),
            ("DISPLAY", ":0"),
            ("TERM", "xterm-256color"),
            ("CLAUDECODE", "1"),
            ("CI", "true"),
            ("NODE_OPTIONS", "--require /example/evil.js"),
            ("AGENT_COMMS_STATE_DIR", "/example/elsewhere"),
            ("DYLD_INSERT_LIBRARIES", "/example/evil.dylib"),
            ("LD_PRELOAD", "/example/evil.so"),
            ("SOME_AGENT_MARKER", "1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.into(), value.into()))
        .collect();
        spawn_with_env(&plan, env).expect("started and ended");
        let text = fs::read_to_string(&seen).expect("env");
        let names: Vec<&str> = text
            .lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name))
            .collect();
        for kept in ["HOME", "PATH", "DISPLAY", "TERM"] {
            assert!(names.contains(&kept), "{kept} did not reach it: {names:?}");
        }
        for never in [
            "CLAUDECODE",
            "CI",
            "NODE_OPTIONS",
            "AGENT_COMMS_STATE_DIR",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
            "SOME_AGENT_MARKER",
        ] {
            assert!(
                !names.contains(&never),
                "{never} reached the terminal: {names:?}"
            );
        }
    }

    fn found_none(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn macos_uses_terminal_through_osascript_with_the_line_escaped() {
        let words = strings(&[
            "/Users/example/First \"Q\" Last\\x/.local/share/agent-communications/launch/core",
            "approve",
            ID,
        ]);
        let expected_line = format!(
            "'/Users/example/First \"Q\" Last\\x/.local/share/agent-communications/launch/core' approve {ID}"
        );
        assert_eq!(line(&words, Platform::MacOs), Some(expected_line.clone()));
        let script = format!(
            "do script \"'/Users/example/First \\\"Q\\\" Last\\\\x/.local/share/agent-communications/launch/core' approve {ID}\""
        );
        assert_eq!(
            plan(Platform::MacOs, &words, &found_none),
            Plan::Spawn {
                program: "/usr/bin/osascript".into(),
                args: strings(&[
                    "-e",
                    "tell application \"Terminal\"",
                    "-e",
                    "activate",
                    "-e",
                    &script,
                    "-e",
                    "end tell"
                ]),
                raw: false,
                new_console: false,
                wait: true,
                via: "Terminal",
            }
        );
        assert_eq!(applescript_string("a\\b\"c"), "\"a\\\\b\\\"c\"");
        // A word that cannot be one line is copied as JSON, and never typed into Terminal.
        let broken = strings(&["/x/core", "approve", "a\nb"]);
        assert_eq!(
            plan(Platform::MacOs, &broken, &found_none),
            Plan::Copy {
                text: json_words(&broken),
                reason: CopyReason::NoSafeLine
            }
        );
    }

    /// AppleScript reads the escaped string back as the line, quotes, backslashes and all.
    #[cfg(target_os = "macos")]
    #[test]
    fn applescript_reads_the_escaped_line_back() {
        let mut words = strings(&["/Users/example/First \"Q\" Last\\x/launch/core"]);
        words.extend(strings(&HOSTILE[..HOSTILE.len() - 1]));
        let text = line(&words, Platform::MacOs).expect("a line");
        let output = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!("return {}", applescript_string(&text)))
            .output()
            .expect("osascript ran");
        assert!(output.status.success(), "{output:?}");
        assert_eq!(
            String::from_utf8(output.stdout)
                .expect("text")
                .trim_end_matches('\n'),
            text
        );
    }

    #[test]
    fn linux_tries_the_three_terminals_in_order() {
        let words = strings(&[
            "/home/example/.local/share/agent-communications/launch/core",
            "approve",
            ID,
        ]);
        let text = line(&words, Platform::Linux).expect("a line");
        let hold = format!(
            "{text}; printf '\\n%s\\n' 'Done. Press Enter to close this window.'; read -r _"
        );
        let cases: [(&[&str], &str, &str, &str); 3] = [
            (
                &["x-terminal-emulator", "gnome-terminal", "konsole"],
                "x-terminal-emulator",
                "-e",
                "x-terminal-emulator",
            ),
            (
                &["gnome-terminal", "konsole"],
                "gnome-terminal",
                "--",
                "gnome-terminal",
            ),
            (&["konsole"], "konsole", "-e", "konsole"),
        ];
        for (present, program, flag, via) in cases {
            let asked = RefCell::new(Vec::new());
            let found = |name: &str| {
                asked.borrow_mut().push(name.to_string());
                present.contains(&name).then(|| format!("/usr/bin/{name}"))
            };
            assert_eq!(
                plan(Platform::Linux, &words, &found),
                Plan::Spawn {
                    program: format!("/usr/bin/{program}"),
                    args: strings(&[flag, "/bin/sh", "-c", &hold]),
                    raw: false,
                    new_console: false,
                    wait: false,
                    via,
                }
            );
            let order = ["x-terminal-emulator", "gnome-terminal", "konsole"];
            let tried = order
                .iter()
                .position(|name| name == &program)
                .expect("one of them");
            assert_eq!(*asked.borrow(), strings(&order[..=tried]));
        }
    }

    #[test]
    fn linux_with_no_terminal_app_copies_the_command() {
        let words = strings(&[
            "/home/example/.local/share/agent-communications/launch/core",
            "approve",
            ID,
        ]);
        assert_eq!(
            plan(Platform::Linux, &words, &found_none),
            Plan::Copy {
                text: line(&words, Platform::Linux).expect("a line"),
                reason: CopyReason::NoTerminal
            }
        );
        // Through `open_with`, on this host, with no terminal found and any spawn failing: the clipboard gets the
        // line, and the outcome says so.
        let (_dir, ctx) = installation(&[Product::Core]);
        let effects = Fake::new(false);
        let command = TerminalCommand::Approve {
            product: Product::Core,
            approval_id: id(),
        };
        let words = argv_for(&command, &ctx).expect("words");
        let outcome = open_with(command, &ctx, &effects, &Prepared::default()).expect("an outcome");
        assert_eq!(
            outcome,
            TerminalOutcome::Copied {
                reason: CopyReason::NoTerminal,
                revoked: None
            }
        );
        assert_eq!(effects.log.borrow().last(), Some(&"copy".to_string()));
        assert_eq!(
            effects.copied.borrow().clone(),
            Some(line(&words, ctx.platform).expect("a line"))
        );
    }

    #[test]
    fn windows_prefers_wt_then_cmd_and_avoids_wt_for_a_semicolon() {
        let cmd = "C:\\Windows\\System32\\cmd.exe";
        let wt = "C:\\example\\home\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
        let both = |name: &str| match name {
            "wt.exe" => Some(wt.to_string()),
            "cmd.exe" => Some(cmd.to_string()),
            _ => None,
        };
        let only_cmd = |name: &str| (name == "cmd.exe").then(|| cmd.to_string());
        let plain = strings(&[
            "C:\\nodejs\\node.exe",
            "C:\\example\\home\\AppData\\Local\\agent-communications\\launch\\core",
            "approve",
            ID,
        ]);
        let text = line(&plain, Platform::Windows).expect("a line");
        assert_eq!(
            text,
            format!("C:\\nodejs\\node.exe C:\\example\\home\\AppData\\Local\\agent-communications\\launch\\core approve {ID}")
        );
        assert_eq!(
            plan(Platform::Windows, &plain, &both),
            Plan::Spawn {
                program: wt.into(),
                args: strings(&["-w", "new", "cmd", "/s", "/k", &format!("\"{text}\"")]),
                raw: true,
                new_console: false,
                wait: false,
                via: "Windows Terminal",
            }
        );
        let by_cmd = |text: &str| Plan::Spawn {
            program: cmd.into(),
            args: strings(&["/s", "/k", &format!("\"{text}\"")]),
            raw: true,
            new_console: true,
            wait: false,
            via: "Command Prompt",
        };
        assert_eq!(plan(Platform::Windows, &plain, &only_cmd), by_cmd(&text));
        // A `;` is Windows Terminal's own separator, and a quoted word is one it would quote again: both go to cmd.exe.
        let semicolon = strings(&["C:\\nodejs\\node.exe", "C:\\x\\core", "behaviour", "a;b"]);
        let semicolon_line = line(&semicolon, Platform::Windows).expect("a line");
        assert_eq!(
            semicolon_line,
            "C:\\nodejs\\node.exe C:\\x\\core behaviour \"a;b\""
        );
        assert_eq!(
            plan(Platform::Windows, &semicolon, &both),
            by_cmd(&semicolon_line)
        );
        let spaced = strings(&[
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\x\\core",
            "--config-dir",
            "C:\\example\\First Last\\AppData\\Roaming\\agent-communications",
        ]);
        let spaced_line = line(&spaced, Platform::Windows).expect("a line");
        assert_eq!(
            spaced_line,
            "\"C:\\Program Files\\nodejs\\node.exe\" C:\\x\\core --config-dir \"C:\\example\\First Last\\AppData\\Roaming\\agent-communications\""
        );
        assert_eq!(
            plan(Platform::Windows, &spaced, &both),
            by_cmd(&spaced_line)
        );
        // cmd.exe hands the program the line inside the outer quotes, which the C runtime splits back into the words.
        assert_eq!(crt_split(&spaced_line), spaced);
        // With neither, the line is copied.
        assert_eq!(
            plan(Platform::Windows, &plain, &found_none),
            Plan::Copy {
                text,
                reason: CopyReason::NoTerminal
            }
        );
    }

    /// How a program built with the C runtime splits its command line (core's `windowsArgv`, in `cli.test.ts`).
    fn crt_split(line: &str) -> Vec<String> {
        let chars: Vec<char> = line.chars().collect();
        let mut words = Vec::new();
        let mut word: Option<String> = None;
        let mut quoted = false;
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                let mut run = 0;
                while chars.get(i + run) == Some(&'\\') {
                    run += 1;
                }
                if chars.get(i + run) == Some(&'"') {
                    let w = word.get_or_insert_with(String::new);
                    w.push_str(&"\\".repeat(run / 2));
                    i += run;
                    if run % 2 == 1 {
                        w.push('"');
                    } else {
                        quoted = !quoted;
                    }
                } else {
                    word.get_or_insert_with(String::new)
                        .push_str(&"\\".repeat(run));
                    i += run - 1;
                }
            } else if c == '"' {
                word.get_or_insert_with(String::new);
                quoted = !quoted;
            } else if (c == ' ' || c == '\t') && !quoted {
                if let Some(done) = word.take() {
                    words.push(done);
                }
            } else {
                word.get_or_insert_with(String::new).push(c);
            }
            i += 1;
        }
        if let Some(done) = word {
            words.push(done);
        }
        words
    }

    /// Windows itself: cmd.exe reads the line as the app hands it (`/s /c "<line>"`, written into the command line as it
    /// is), and Node — the program a launcher runs with there — gets back exactly the words, while nothing cmd.exe
    /// could act on in them runs. Only on Windows; skipped where there is no node.exe on PATH.
    #[cfg(windows)]
    #[test]
    fn cmd_hands_node_back_exactly_the_words_of_the_windows_line() {
        use std::os::windows::process::CommandExt;
        let Some(node) = locate("node.exe") else {
            eprintln!("skipped: there is no node.exe on PATH");
            return;
        };
        let cmd = locate("cmd.exe").expect("cmd.exe");
        let dir = tempfile::tempdir().expect("a folder");
        let marker = dir.path().join("ran");
        let script = dir.path().join("print args.js");
        // Every word as JSON, with anything outside ASCII escaped, so the console's code page cannot change it.
        fs::write(
            &script,
            "process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\\u007f-\\uffff]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')))",
        )
        .expect("a script");
        let mut words = vec![node, script.to_string_lossy().into_owned()];
        words.extend(strings(&[
            "approve",
            "C:\\Profiles\\First Last\\x",
            "C:\\Profiles\\outgoing",
            "acme/gmail",
            "--force",
            "a;b",
            "a & b",
            "x | y",
            "a ^ b",
            "(a b)",
            "a <b>",
            "it's",
            "it\u{2019}s here",
            "caf\u{e9}",
            "a \u{2014} b",
            "@name",
            "a,b",
            "~/outgoing",
            " outgoing ",
            "--name=x",
            "-name.x",
            "1kb",
            "0x10",
            ".5",
            "#a",
            "{a}",
        ]));
        words.push(format!("x & echo ran > {}", marker.display()));
        let text = line(&words, Platform::Windows).expect("a line");
        let output = Command::new(&cmd)
            .raw_arg("/s")
            .raw_arg("/c")
            .raw_arg(format!("\"{text}\""))
            .output()
            .expect("cmd.exe ran");
        assert!(output.status.success(), "{output:?}");
        let printed: Vec<String> = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)));
        assert_eq!(printed, words[2..].to_vec(), "{text}");
        assert!(!marker.exists(), "cmd.exe ran a word: {text}");
    }

    /// And a word no quoting brings through gives no line, so cmd.exe is never handed one (Windows only).
    #[cfg(windows)]
    #[test]
    fn cmd_is_never_handed_a_word_it_would_act_on() {
        for word in UNSAFE_ON_WINDOWS {
            assert_eq!(
                line(
                    &strings(&["C:\\x\\node.exe", "C:\\x\\core", word]),
                    Platform::Windows
                ),
                None,
                "{word:?}"
            );
        }
    }

    #[test]
    fn windows_with_an_unsafe_word_copies_json() {
        for word in [
            "50%",
            "$x&whoami&",
            "a&b",
            "say \"hi\"",
            "line\nbreak",
            "!x!",
            "",
        ] {
            let words = strings(&["C:\\nodejs\\node.exe", "C:\\x\\core", "approve", word]);
            assert_eq!(
                plan(Platform::Windows, &words, &|_| Some(
                    "C:\\Windows\\System32\\cmd.exe".into()
                )),
                Plan::Copy {
                    text: json_words(&words),
                    reason: CopyReason::NoSafeLine
                },
                "{word:?}"
            );
        }
    }

    /// What the tests stand in for: the revoke, the terminal and the clipboard, recorded in order.
    struct Fake {
        log: RefCell<Vec<String>>,
        revoke_ok: bool,
        spawn_ok: bool,
        spawned: RefCell<Option<Plan>>,
        copied: RefCell<Option<String>>,
    }

    impl Fake {
        fn new(spawn_ok: bool) -> Self {
            Fake {
                log: RefCell::new(Vec::new()),
                revoke_ok: true,
                spawn_ok,
                spawned: RefCell::new(None),
                copied: RefCell::new(None),
            }
        }
    }

    impl Effects for Fake {
        fn revoke(&self, approval: &ApprovalId, _ctx: &RunContext) -> bool {
            self.log
                .borrow_mut()
                .push(format!("revoke {}", approval.as_str()));
            self.revoke_ok
        }

        fn found(&self, program: &str) -> Option<String> {
            // Every terminal is there when the spawn is to work; none when it is not.
            self.spawn_ok.then(|| format!("/usr/bin/{program}"))
        }

        fn spawn(&self, plan: &Plan) -> Result<(), String> {
            self.log.borrow_mut().push("spawn".into());
            *self.spawned.borrow_mut() = Some(plan.clone());
            if self.spawn_ok {
                Ok(())
            } else {
                Err("no terminal".into())
            }
        }

        fn copy(&self, text: &str) -> Result<(), AppError> {
            self.log.borrow_mut().push("copy".into());
            *self.copied.borrow_mut() = Some(text.to_string());
            Ok(())
        }
    }

    /// A fresh installation with these products' launchers, on this host.
    fn installation(products: &[Product]) -> (tempfile::TempDir, RunContext) {
        let dir = tempfile::tempdir().expect("a folder");
        let data = dir.path().to_string_lossy().into_owned();
        let folders = Folders {
            config_dir: format!("{data}-config"),
            state_dir: format!("{data}-state"),
            data_dir: data,
            secrets_dir: format!("{}-secrets", dir.path().display()),
        };
        let platform = Platform::current();
        for product in products {
            let path = launcher_path(&folders, platform, *product);
            fs::create_dir_all(Path::new(&path).parent().expect("launch")).expect("launch");
            fs::write(&path, "#!/bin/sh\nexit 0\n").expect("a launcher");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("executable");
            }
        }
        let node = (platform == Platform::Windows).then(|| "C:\\example\\node.exe".to_string());
        (
            dir,
            RunContext {
                folders,
                platform,
                node,
            },
        )
    }

    /// The program and leading words a launcher starts with here.
    fn program(ctx: &RunContext, product: Product) -> Vec<String> {
        let path = launcher_path(&ctx.folders, ctx.platform, product);
        match &ctx.node {
            Some(node) => vec![node.clone(), path],
            None => vec![path],
        }
    }

    fn located(ctx: &RunContext, product: Product, words: &[&str]) -> Vec<String> {
        let mut argv = program(ctx, product);
        argv.extend(strings(words));
        argv.extend(ctx.folders.pins());
        argv
    }

    #[test]
    fn approve_builds_the_channel_launcher_with_pins() {
        let channels = [
            Product::Core,
            Product::Gmail,
            Product::Slack,
            Product::Resend,
            Product::Whatsapp,
        ];
        let (_dir, ctx) = installation(&Product::ALL);
        for product in channels {
            let command = TerminalCommand::Approve {
                product,
                approval_id: id(),
            };
            assert_eq!(
                argv_for(&command, &ctx).expect("words"),
                located(&ctx, product, &["approve", ID]),
                "{product:?}"
            );
        }
        // The events service approves nothing.
        let refused = argv_for(
            &TerminalCommand::Approve {
                product: Product::EventsDaemon,
                approval_id: id(),
            },
            &ctx,
        )
        .expect_err("refused");
        assert_eq!(refused.code, "APP_REFUSED");
        // A channel that is not installed is said to be so.
        let (_dir, bare) = installation(&[Product::Core]);
        let missing = argv_for(
            &TerminalCommand::Approve {
                product: Product::Slack,
                approval_id: id(),
            },
            &bare,
        )
        .expect_err("not installed");
        assert_eq!(missing.code, "APP_NOT_INSTALLED");
        // The line never carries --json.
        assert!(!located(&ctx, Product::Core, &["approve", ID]).contains(&"--json".to_string()));
    }

    #[test]
    fn change_refuses_a_call_that_prepares_nothing() {
        let (_dir, ctx) = installation(&[Product::Core]);
        for call in [
            Call::ApprovalsPending {},
            Call::UpdateBackgroundJob { on: false },
            Call::ApprovalRevoke { approval_id: id() },
            Call::StandingOff {},
            Call::EventsPause {},
        ] {
            let effects = Fake::new(true);
            // Even with its approval recorded as if it had prepared one.
            let prepared = Prepared::default();
            prepared.map().insert(ID.into(), call.clone());
            let refused = open_with(
                TerminalCommand::Change {
                    call: call.clone(),
                    revoke: id(),
                },
                &ctx,
                &effects,
                &prepared,
            )
            .expect_err("refused");
            assert_eq!(refused.code, "APP_REFUSED", "{call:?}");
            assert!(effects.log.borrow().is_empty(), "nothing ran for {call:?}");
        }
    }

    #[test]
    fn change_revokes_first_then_opens() {
        let (_dir, ctx) = installation(&[Product::Core]);
        let command = TerminalCommand::Change {
            call: Call::UpdateLevel {
                level: UpdateLevel::Never,
            },
            revoke: id(),
        };
        let words = argv_for(&command, &ctx).expect("words");
        assert_eq!(
            words,
            located(&ctx, Product::Core, &["update", "--level", "never"])
        );
        let effects = Fake::new(true);
        let outcome = open_with(command.clone(), &ctx, &effects, &prepared_for(&command))
            .expect("an outcome");
        assert!(
            matches!(
                outcome,
                TerminalOutcome::Opened {
                    revoked: Some(true),
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(
            *effects.log.borrow(),
            strings(&[&format!("revoke {ID}"), "spawn"])
        );
        assert_eq!(
            effects.spawned.borrow().clone().expect("a plan"),
            plan(ctx.platform, &words, &|name| effects.found(name))
        );
        // A revoke that fails is said to have failed, and the terminal opens anyway (DA10).
        let effects = Fake {
            revoke_ok: false,
            ..Fake::new(true)
        };
        let outcome = open_with(command.clone(), &ctx, &effects, &prepared_for(&command))
            .expect("an outcome");
        assert!(
            matches!(
                outcome,
                TerminalOutcome::Opened {
                    revoked: Some(false),
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(
            *effects.log.borrow(),
            strings(&[&format!("revoke {ID}"), "spawn"])
        );
        // Where no terminal opens, the change is copied, after the revoke too.
        let effects = Fake::new(false);
        let outcome = open_with(command.clone(), &ctx, &effects, &prepared_for(&command))
            .expect("an outcome");
        assert!(
            matches!(
                outcome,
                TerminalOutcome::Copied {
                    revoked: Some(true),
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(effects.log.borrow().first(), Some(&format!("revoke {ID}")));
        assert_eq!(effects.log.borrow().last(), Some(&"copy".to_string()));
        // Each of the five change shapes is one the terminal takes.
        for call in [
            Call::UpdateLevel {
                level: UpdateLevel::Auto,
            },
            Call::UpdateRollback {},
            Call::UpdateBackgroundJob { on: true },
            Call::BehaviourAllow {
                account: account("example/slack"),
                acts: crate::allowlist::Acts::try_from("reply".to_string()).expect("acts"),
                conversation: None,
            },
            Call::BehaviourClear {
                account: account("example/slack"),
                conversation: None,
            },
        ] {
            let built = call.words().expect("words");
            let mut expected = program(&ctx, Product::Core);
            expected.extend(built.words.clone());
            expected.extend(ctx.folders.pins());
            assert_eq!(
                argv_for(&TerminalCommand::Change { call, revoke: id() }, &ctx).expect("words"),
                expected
            );
        }
    }

    /// The record `cli` keeps once `command`'s change came back waiting for approval `ID`.
    fn prepared_for(command: &TerminalCommand) -> Prepared {
        let TerminalCommand::Change { call, revoke } = command else {
            panic!("not a change: {command:?}")
        };
        let prepared = Prepared::default();
        prepared.record(
            call,
            &CliResult::ApprovalPending {
                approval_id: revoke.as_str().into(),
                preview: "p".into(),
                expires_at: None,
            },
        );
        prepared
    }

    #[test]
    fn a_change_opens_only_with_the_approval_the_app_prepared_for_it() {
        let (_dir, ctx) = installation(&[Product::Core]);
        let never = Call::UpdateLevel {
            level: UpdateLevel::Never,
        };
        let change = TerminalCommand::Change {
            call: never.clone(),
            revoke: id(),
        };
        // Nothing recorded: refused, and nothing is revoked or opened.
        let effects = Fake::new(true);
        let refused =
            open_with(change.clone(), &ctx, &effects, &Prepared::default()).expect_err("refused");
        assert_eq!(refused.code, "APP_REFUSED");
        assert!(
            effects.log.borrow().is_empty(),
            "{:?}",
            effects.log.borrow()
        );
        // Recorded for another change (an approval that is some other preview's): refused the same.
        let prepared = Prepared::default();
        let pending = CliResult::ApprovalPending {
            approval_id: ID.into(),
            preview: "p".into(),
            expires_at: None,
        };
        prepared.record(
            &Call::UpdateLevel {
                level: UpdateLevel::Auto,
            },
            &pending,
        );
        let effects = Fake::new(true);
        assert_eq!(
            open_with(change.clone(), &ctx, &effects, &prepared)
                .expect_err("refused")
                .code,
            "APP_REFUSED"
        );
        assert!(effects.log.borrow().is_empty());
        // Only a change the app prepares is recorded, and only when it came back waiting.
        let prepared = Prepared::default();
        prepared.record(&Call::ApprovalsPending {}, &pending);
        prepared.record(
            &never,
            &CliResult::Ok {
                exit: 0,
                data: serde_json::Value::Null,
            },
        );
        assert!(prepared.map().is_empty());
        // Recorded for this change: it opens, once; the same approval a second time is refused.
        prepared.record(&never, &pending);
        let effects = Fake::new(true);
        assert!(open_with(change.clone(), &ctx, &effects, &prepared).is_ok());
        assert_eq!(
            *effects.log.borrow(),
            strings(&[&format!("revoke {ID}"), "spawn"])
        );
        let again = Fake::new(true);
        assert_eq!(
            open_with(change, &ctx, &again, &prepared)
                .expect_err("used")
                .code,
            "APP_REFUSED"
        );
        assert!(again.log.borrow().is_empty());
    }

    #[test]
    fn an_abandoned_preview_revokes_only_its_own_approval() {
        let pending = CliResult::ApprovalPending {
            approval_id: ID.into(),
            preview: "p".into(),
            expires_at: None,
        };
        let ok = || CliResult::Ok {
            exit: 0,
            data: serde_json::json!({ "approvalId": ID, "state": "revoked" }),
        };
        // Not recorded: refused, and core is never asked.
        let asked = RefCell::new(0);
        let refused = revoke_preview_with(&Prepared::default(), &id(), |_| {
            *asked.borrow_mut() += 1;
            ok()
        })
        .expect_err("refused");
        assert_eq!(refused.code, "APP_REFUSED");
        assert_eq!(*asked.borrow(), 0);
        // Recorded: revoked once, and then gone.
        let prepared = Prepared::default();
        prepared.record(&Call::UpdateRollback {}, &pending);
        assert_eq!(revoke_preview_with(&prepared, &id(), |_| ok()), Ok(ok()));
        assert!(revoke_preview_with(&prepared, &id(), |_| ok()).is_err());
        // A revoke that failed keeps the record, so the person can try again; and its failure comes back as it was.
        prepared.record(&Call::UpdateRollback {}, &pending);
        let failed = CliResult::Failed {
            exit: 75,
            code: "TRANSIENT".into(),
            message: "the approvals store is busy".into(),
            hint: None,
        };
        assert_eq!(
            revoke_preview_with(&prepared, &id(), |_| failed.clone()),
            Ok(failed)
        );
        assert_eq!(revoke_preview_with(&prepared, &id(), |_| ok()), Ok(ok()));
    }

    #[test]
    fn sign_in_builds_each_channel_and_refuses_resend_again() {
        let (_dir, ctx) = installation(&Product::ALL);
        let sign_in = |product, again| TerminalCommand::SignIn {
            product,
            account: account("example/gmail"),
            again,
        };
        for (product, again, words) in [
            (Product::Gmail, false, ["inbox", "add"]),
            (Product::Gmail, true, ["inbox", "reauth"]),
            (Product::Slack, false, ["workspace", "add"]),
            (Product::Slack, true, ["workspace", "reauth"]),
            (Product::Resend, false, ["account", "add"]),
        ] {
            assert_eq!(
                argv_for(&sign_in(product, again), &ctx).expect("words"),
                located(&ctx, product, &[words[0], words[1], "example/gmail"]),
                "{product:?} {again}"
            );
        }
        for (product, again) in [
            (Product::Resend, true),
            (Product::Core, false),
            (Product::Whatsapp, false),
            (Product::EventsDaemon, false),
        ] {
            assert_eq!(
                argv_for(&sign_in(product, again), &ctx)
                    .expect_err("refused")
                    .code,
                "APP_REFUSED",
                "{product:?} {again}"
            );
        }
    }

    #[test]
    fn copy_takes_text_as_shown_and_nothing_hidden() {
        for shown in [
            "",
            "C:\\nodejs\\node.exe C:\\x\\core approve ap_X",
            "a fix\non two lines\twith a tab",
            "caf\u{e9} \u{1F600}",
        ] {
            assert!(copyable(shown), "{shown:?}");
        }
        for hidden in [
            "a\rb",
            "clear\u{1b}[2J",
            "right\u{202E}left",
            "zero\u{200B}width",
            "nul\0",
            "del\u{7f}",
        ] {
            assert!(!copyable(hidden), "{hidden:?}");
        }
        assert!(copyable(&"a".repeat(COPY_LIMIT)));
        assert!(!copyable(&"a".repeat(COPY_LIMIT + 1)));
    }

    /// Laya's Enable (E2 Task 11): the events service's own launcher, `judge kind enable laya` and the pins, the words
    /// the daemon's contract runs through its CLI. Nothing is revoked first, and the terminal opens once.
    #[test]
    fn laya_enable_opens_the_events_launcher_with_the_pins_and_revokes_nothing() {
        let (_dir, ctx) = installation(&[Product::Core, Product::EventsDaemon]);
        let command = TerminalCommand::EventsJudgeKindEnable {};
        let words = argv_for(&command, &ctx).expect("words");
        assert_eq!(
            words,
            located(
                &ctx,
                Product::EventsDaemon,
                &["judge", "kind", "enable", "laya"]
            )
        );
        assert_eq!(
            crate::allowlist::desktop_contract_words("eventsJudgeKindEnable"),
            (strings(&["judge", "kind", "enable", "laya"]), false)
        );
        let effects = Fake::new(true);
        let outcome =
            open_with(command.clone(), &ctx, &effects, &Prepared::default()).expect("an outcome");
        assert!(
            matches!(outcome, TerminalOutcome::Opened { revoked: None, .. }),
            "{outcome:?}"
        );
        assert_eq!(*effects.log.borrow(), strings(&["spawn"]));
        assert_eq!(
            effects.spawned.borrow().clone().expect("a plan"),
            plan(ctx.platform, &words, &|name| effects.found(name))
        );
        // Without the events service's launcher there is nothing to open.
        let (_dir, bare) = installation(&[Product::Core]);
        assert_eq!(
            argv_for(&command, &bare).expect_err("not installed").code,
            "APP_NOT_INSTALLED"
        );
        // The webview's shape for it, exactly (`ipc.ts`); and it takes no argument: no kind, no approval, no word.
        assert_eq!(
            serde_json::from_value::<TerminalCommand>(
                serde_json::json!({ "kind": "eventsJudgeKindEnable" })
            )
            .expect("Enable's shape"),
            command
        );
        for bad in [
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "judge": "typesafe" }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "approval": ID }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "approvalId": ID }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "json": true }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "words": ["--approval", ID] }),
        ] {
            assert!(
                serde_json::from_value::<TerminalCommand>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }

    /// The Enable line on each platform, as its shell reads it: the launcher (on Windows, Node and the launcher), then
    /// `judge kind enable laya`, then the pins, with neither `--json` nor `--approval` anywhere in it.
    #[test]
    fn laya_enable_line_has_no_json_or_approval_on_macos_linux_and_windows() {
        let (product, words) =
            command_words(&TerminalCommand::EventsJudgeKindEnable {}).expect("words");
        assert_eq!(product, Product::EventsDaemon);
        assert_eq!(words, strings(&["judge", "kind", "enable", "laya"]));
        let posix = |home: &str| Folders {
            config_dir: format!("{home}/.config/agent-communications"),
            state_dir: format!("{home}/.config/agent-communications/state"),
            data_dir: format!("{home}/.local/share/agent-communications"),
            secrets_dir: format!("{home}/.config/agent-communications/secrets"),
        };
        let windows = Folders {
            config_dir: r"C:\Users\example\AppData\Roaming\agent-communications".into(),
            state_dir: r"C:\Users\example\AppData\Roaming\agent-communications\state".into(),
            data_dir: r"C:\Users\example\AppData\Local\agent-communications".into(),
            secrets_dir: r"C:\Users\example\AppData\Roaming\agent-communications\secrets".into(),
        };
        let cases = [
            (
                Platform::MacOs,
                posix("/Users/example"),
                vec!["/Users/example/.local/share/agent-communications/launch/events-daemon"],
                "/Users/example/.local/share/agent-communications/launch/events-daemon judge kind enable laya --config-dir /Users/example/.config/agent-communications --state-dir /Users/example/.config/agent-communications/state --data-dir /Users/example/.local/share/agent-communications --secrets-dir /Users/example/.config/agent-communications/secrets",
            ),
            (
                Platform::Linux,
                posix("/home/example"),
                vec!["/home/example/.local/share/agent-communications/launch/events-daemon"],
                "/home/example/.local/share/agent-communications/launch/events-daemon judge kind enable laya --config-dir /home/example/.config/agent-communications --state-dir /home/example/.config/agent-communications/state --data-dir /home/example/.local/share/agent-communications --secrets-dir /home/example/.config/agent-communications/secrets",
            ),
            (
                Platform::Windows,
                windows.clone(),
                vec![
                    r"C:\Program Files\nodejs\node.exe",
                    r"C:\Users\example\AppData\Local\agent-communications\launch\events-daemon",
                ],
                r#""C:\Program Files\nodejs\node.exe" C:\Users\example\AppData\Local\agent-communications\launch\events-daemon judge kind enable laya --config-dir C:\Users\example\AppData\Roaming\agent-communications --state-dir C:\Users\example\AppData\Roaming\agent-communications\state --data-dir C:\Users\example\AppData\Local\agent-communications --secrets-dir C:\Users\example\AppData\Roaming\agent-communications\secrets"#,
            ),
        ];
        for (platform, folders, program, expected) in cases {
            let program = crate::launchers::Program {
                program: program[0].to_string(),
                leading: program[1..].iter().map(|word| word.to_string()).collect(),
            };
            let argv = located_line(product, &words, &program, &folders);
            let mut whole = vec![program.program.clone()];
            whole.extend(program.leading.clone());
            whole.extend(strings(&["judge", "kind", "enable", "laya"]));
            whole.extend(folders.pins());
            assert_eq!(argv, whole, "{platform:?}");
            let text = line(&argv, platform).expect("a line");
            assert_eq!(text, expected, "{platform:?}");
            assert!(
                !text.contains("--json")
                    && !text.contains("--approval")
                    && !text.contains(" approve "),
                "{platform:?}: {text}"
            );
            let found = |name: &str| Some(format!("/usr/bin/{name}"));
            let Plan::Spawn { args, .. } = plan(platform, &argv, &found) else {
                panic!("{platform:?}: no terminal was planned");
            };
            assert!(
                args.iter().any(|arg| arg.contains(&text)),
                "{platform:?}: {args:?}"
            );
        }
    }

    /// Turning on Jev or a local model server (0.27.1): the events service's own launcher, `judge kind enable <kind>`
    /// and the pins, the words the daemon's judges contract runs through its CLI. As Laya's Enable: nothing is revoked
    /// first, nothing is prepared or recorded, and the terminal opens once.
    #[test]
    fn judge_kind_enable_opens_the_events_launcher_with_its_kind_and_revokes_nothing() {
        let (_dir, ctx) = installation(&[Product::Core, Product::EventsDaemon]);
        for (kind, word) in [
            (crate::allowlist::EndpointJudgeKind::Typesafe, "typesafe"),
            (
                crate::allowlist::EndpointJudgeKind::LocalEndpoint,
                "local-endpoint",
            ),
        ] {
            let command = TerminalCommand::JudgeKindEnable { judge_kind: kind };
            let words = argv_for(&command, &ctx).expect("words");
            assert_eq!(
                words,
                located(
                    &ctx,
                    Product::EventsDaemon,
                    &["judge", "kind", "enable", word]
                )
            );
            assert_eq!(
                crate::allowlist::desktop_judges_contract_words("judgeKindEnable", Some(word)),
                (strings(&["judge", "kind", "enable", word]), false)
            );
            let effects = Fake::new(true);
            let prepared = Prepared::default();
            let outcome =
                open_with(command.clone(), &ctx, &effects, &prepared).expect("an outcome");
            assert!(
                matches!(outcome, TerminalOutcome::Opened { revoked: None, .. }),
                "{outcome:?}"
            );
            assert_eq!(*effects.log.borrow(), strings(&["spawn"]));
            assert_eq!(
                effects.spawned.borrow().clone().expect("a plan"),
                plan(ctx.platform, &words, &|name| effects.found(name))
            );
            assert!(prepared.map().is_empty(), "{word}: nothing was recorded");
            // The webview's shape for it, exactly (`ipc.ts`).
            assert_eq!(
                serde_json::from_value::<TerminalCommand>(
                    serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": word })
                )
                .expect("its shape"),
                command
            );
            // Without the events service's launcher there is nothing to open.
            let (_bare_dir, bare) = installation(&[Product::Core]);
            assert_eq!(
                argv_for(&command, &bare).expect_err("not installed").code,
                "APP_NOT_INSTALLED"
            );
        }
    }

    /// The kind is a closed enum: Laya, a free string or another spelling is refused, and so is any other field. Laya's
    /// own Enable still takes no argument, so it never takes another kind.
    #[test]
    fn judge_kind_enable_refuses_a_free_kind_laya_and_any_other_field() {
        for kind in [
            serde_json::json!("laya"),
            serde_json::json!("Typesafe"),
            serde_json::json!("typesafe "),
            serde_json::json!("local_endpoint"),
            serde_json::json!("jev"),
            serde_json::json!(""),
            serde_json::json!("--json"),
            serde_json::json!("typesafe; rm -rf ~"),
            serde_json::json!(7),
            serde_json::json!(null),
            serde_json::json!(["typesafe"]),
        ] {
            let bad = serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": kind });
            assert!(
                serde_json::from_value::<TerminalCommand>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        for bad in [
            serde_json::json!({ "kind": "judgeKindEnable" }),
            serde_json::json!({ "kind": "judgeKindEnable", "judge": "typesafe" }),
            serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": "typesafe", "approval": ID }),
            serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": "typesafe", "approvalId": ID }),
            serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": "typesafe", "json": true }),
            serde_json::json!({ "kind": "judgeKindEnable", "judgeKind": "typesafe", "words": ["--approval", ID] }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "judgeKind": "typesafe" }),
            serde_json::json!({ "kind": "eventsJudgeKindEnable", "judgeKind": "laya" }),
            // Turning a kind off is a call, not a terminal line.
            serde_json::json!({ "kind": "judgeKindDisable", "judgeKind": "typesafe" }),
        ] {
            assert!(
                serde_json::from_value::<TerminalCommand>(bad.clone()).is_err(),
                "{bad}"
            );
        }
        // Laya's Enable is as it was: its own words, and no kind.
        assert_eq!(
            command_words(&TerminalCommand::EventsJudgeKindEnable {}).expect("words"),
            (
                Product::EventsDaemon,
                strings(&["judge", "kind", "enable", "laya"])
            )
        );
    }

    /// The Enable line for Jev and a local model server on each platform, as its shell reads it: the launcher (on
    /// Windows, Node and the launcher), `judge kind enable <kind>`, then the pins, with neither `--json` nor
    /// `--approval` anywhere in it.
    #[test]
    fn judge_kind_enable_line_has_no_json_or_approval_on_macos_linux_and_windows() {
        let posix = |home: &str| Folders {
            config_dir: format!("{home}/.config/agent-communications"),
            state_dir: format!("{home}/.config/agent-communications/state"),
            data_dir: format!("{home}/.local/share/agent-communications"),
            secrets_dir: format!("{home}/.config/agent-communications/secrets"),
        };
        let windows = Folders {
            config_dir: r"C:\Users\example\AppData\Roaming\agent-communications".into(),
            state_dir: r"C:\Users\example\AppData\Roaming\agent-communications\state".into(),
            data_dir: r"C:\Users\example\AppData\Local\agent-communications".into(),
            secrets_dir: r"C:\Users\example\AppData\Roaming\agent-communications\secrets".into(),
        };
        for (kind, word) in [
            (crate::allowlist::EndpointJudgeKind::Typesafe, "typesafe"),
            (
                crate::allowlist::EndpointJudgeKind::LocalEndpoint,
                "local-endpoint",
            ),
        ] {
            let (product, words) =
                command_words(&TerminalCommand::JudgeKindEnable { judge_kind: kind })
                    .expect("words");
            assert_eq!(product, Product::EventsDaemon);
            assert_eq!(words, strings(&["judge", "kind", "enable", word]));
            let cases = [
                (
                    Platform::MacOs,
                    posix("/Users/example"),
                    vec!["/Users/example/.local/share/agent-communications/launch/events-daemon"],
                    format!(
                        "/Users/example/.local/share/agent-communications/launch/events-daemon judge kind enable {word} --config-dir /Users/example/.config/agent-communications --state-dir /Users/example/.config/agent-communications/state --data-dir /Users/example/.local/share/agent-communications --secrets-dir /Users/example/.config/agent-communications/secrets"
                    ),
                ),
                (
                    Platform::Linux,
                    posix("/home/example"),
                    vec!["/home/example/.local/share/agent-communications/launch/events-daemon"],
                    format!(
                        "/home/example/.local/share/agent-communications/launch/events-daemon judge kind enable {word} --config-dir /home/example/.config/agent-communications --state-dir /home/example/.config/agent-communications/state --data-dir /home/example/.local/share/agent-communications --secrets-dir /home/example/.config/agent-communications/secrets"
                    ),
                ),
                (
                    Platform::Windows,
                    windows.clone(),
                    vec![
                        r"C:\Program Files\nodejs\node.exe",
                        r"C:\Users\example\AppData\Local\agent-communications\launch\events-daemon",
                    ],
                    format!(
                        r#""C:\Program Files\nodejs\node.exe" C:\Users\example\AppData\Local\agent-communications\launch\events-daemon judge kind enable {word} --config-dir C:\Users\example\AppData\Roaming\agent-communications --state-dir C:\Users\example\AppData\Roaming\agent-communications\state --data-dir C:\Users\example\AppData\Local\agent-communications --secrets-dir C:\Users\example\AppData\Roaming\agent-communications\secrets"#
                    ),
                ),
            ];
            for (platform, folders, program, expected) in cases {
                let program = crate::launchers::Program {
                    program: program[0].to_string(),
                    leading: program[1..].iter().map(|word| word.to_string()).collect(),
                };
                let argv = located_line(product, &words, &program, &folders);
                let text = line(&argv, platform).expect("a line");
                assert_eq!(text, expected, "{platform:?}");
                assert!(
                    !text.contains("--json")
                        && !text.contains("--approval")
                        && !text.contains(" approve ")
                        && !text.contains(" laya"),
                    "{platform:?}: {text}"
                );
            }
        }
    }

    #[test]
    fn windows_without_node_cannot_open_a_launcher() {
        let (_dir, ctx) = installation(&[Product::Core]);
        let refused = argv_for(
            &TerminalCommand::Approve {
                product: Product::Core,
                approval_id: id(),
            },
            &RunContext {
                platform: Platform::Windows,
                node: None,
                ..ctx
            },
        )
        .expect_err("no node");
        assert_eq!(refused.code, "APP_NO_NODE");
    }

    /// A lane's Bind in Terminal (0.31.0, design 2026-10-25-routing B1): the events service's own launcher, `lane bind
    /// <lane> --window <id>` and the pins. The person runs it: nothing is revoked first, nothing is recorded, and the
    /// terminal opens once.
    #[test]
    fn lane_bind_opens_the_events_launcher_with_the_pins_and_revokes_nothing() {
        let (_dir, ctx) = installation(&[Product::Core, Product::EventsDaemon]);
        let command: TerminalCommand = serde_json::from_value(serde_json::json!({
            "kind": "laneBind", "lane": "david", "window": "3f9a1c2e7b4d5a60"
        }))
        .expect("Bind's shape");
        let words = argv_for(&command, &ctx).expect("words");
        assert_eq!(
            words,
            located(
                &ctx,
                Product::EventsDaemon,
                &["lane", "bind", "david", "--window", "3f9a1c2e7b4d5a60"]
            )
        );
        let effects = Fake::new(true);
        let prepared = Prepared::default();
        let outcome = open_with(command.clone(), &ctx, &effects, &prepared).expect("an outcome");
        assert!(
            matches!(outcome, TerminalOutcome::Opened { revoked: None, .. }),
            "{outcome:?}"
        );
        assert_eq!(*effects.log.borrow(), strings(&["spawn"]));
        assert!(prepared.map().is_empty());
        // The person confirms the bind by typing the lane's name at that terminal (the event service's gate): the
        // app's line never answers it. The lane is named once, and nothing skips, answers or quiets the question.
        assert_eq!(words.iter().filter(|word| *word == "david").count(), 1);
        for answer in [
            "--yes",
            "-y",
            "--confirm",
            "--force",
            "--json",
            "--approval",
        ] {
            assert!(
                !words.iter().any(|word| word == answer),
                "{answer}: {words:?}"
            );
        }
        // A Claude Code session id binds the same way.
        let by_session: TerminalCommand = serde_json::from_value(serde_json::json!({
            "kind": "laneBind", "lane": "billing", "window": "0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90"
        }))
        .expect("Bind's shape");
        assert_eq!(
            command_words(&by_session).expect("words"),
            (
                Product::EventsDaemon,
                strings(&[
                    "lane",
                    "bind",
                    "billing",
                    "--window",
                    "0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90"
                ])
            )
        );
        // Without the events service's launcher there is nothing to open.
        let (_dir, bare) = installation(&[Product::Core]);
        assert_eq!(
            argv_for(&command, &bare).expect_err("not installed").code,
            "APP_NOT_INSTALLED"
        );
    }

    /// No free text reaches the bind line: the lane is 1 to 40 of `[a-z0-9-]`, the window a lowercase UUID or an
    /// activity key, and the command takes no other field — no approval, no `--json`, no words of its own.
    #[test]
    fn lane_bind_refuses_a_bad_lane_a_bad_window_and_any_other_field() {
        let refused = |value: serde_json::Value| {
            assert!(
                serde_json::from_value::<TerminalCommand>(value.clone()).is_err(),
                "{value}"
            );
        };
        for lane in [
            serde_json::json!(""),
            serde_json::json!("-david"),
            serde_json::json!("--json"),
            serde_json::json!("David"),
            serde_json::json!("david_slack"),
            serde_json::json!("david slack"),
            serde_json::json!("david; rm -rf ~"),
            serde_json::json!("david$(id)"),
            serde_json::json!("david`id`"),
            serde_json::json!("david\n"),
            serde_json::json!("david\u{202e}"),
            serde_json::json!("x".repeat(41)),
            serde_json::json!(7),
            serde_json::json!(null),
            serde_json::json!(["david"]),
        ] {
            refused(
                serde_json::json!({ "kind": "laneBind", "lane": lane, "window": "3f9a1c2e7b4d5a60" }),
            );
        }
        for window in [
            serde_json::json!(""),
            serde_json::json!("3f9a1c2e7b4d5a6"),
            serde_json::json!("3F9A1C2E7B4D5A60"),
            serde_json::json!("-f9a1c2e7b4d5a60"),
            serde_json::json!("3f9a1c2e7b4d5a60 --json"),
            serde_json::json!("3f9a1c2e7b4d5a60\n"),
            serde_json::json!("0F8B5C3E-2D41-4A7E-9C11-5B2E8D7F6A90"),
            serde_json::json!("0f8b5c3e2d414a7e9c115b2e8d7f6a90"),
            serde_json::json!("~/work/acme-site"),
            serde_json::json!(4100),
            serde_json::json!(null),
        ] {
            refused(serde_json::json!({ "kind": "laneBind", "lane": "david", "window": window }));
        }
        refused(serde_json::json!({ "kind": "laneBind", "lane": "david" }));
        refused(serde_json::json!({ "kind": "laneBind", "window": "3f9a1c2e7b4d5a60" }));
        for (field, value) in [
            ("approval", serde_json::json!(ID)),
            ("approvalId", serde_json::json!(ID)),
            ("revoke", serde_json::json!(ID)),
            ("json", serde_json::json!(true)),
            ("words", serde_json::json!(["--yes"])),
            ("session", serde_json::json!("3f9a1c2e7b4d5a60")),
        ] {
            let mut given = serde_json::json!({ "kind": "laneBind", "lane": "david", "window": "3f9a1c2e7b4d5a60" });
            given[field] = value;
            refused(given);
        }
        // Unbinding is a call the app applies itself, never a terminal command; nothing else about a lane is one.
        for kind in ["laneUnbind", "laneList", "laneWhoami", "laneItem"] {
            refused(serde_json::json!({ "kind": kind, "lane": "david" }));
        }
    }

    /// The bind line on each platform, as its shell reads it: the launcher (on Windows, Node and the launcher), then
    /// `lane bind <lane> --window <id>`, then the pins, with neither `--json` nor `--approval` anywhere in it. On
    /// Windows a key that starts with a digit is quoted, as core quotes such a word for cmd.exe and PowerShell.
    #[test]
    fn lane_bind_line_has_no_json_or_approval_on_macos_linux_and_windows() {
        let command: TerminalCommand = serde_json::from_value(serde_json::json!({
            "kind": "laneBind", "lane": "david", "window": "3f9a1c2e7b4d5a60"
        }))
        .expect("Bind's shape");
        let (product, words) = command_words(&command).expect("words");
        assert_eq!(product, Product::EventsDaemon);
        let posix = |home: &str| Folders {
            config_dir: format!("{home}/.config/agent-communications"),
            state_dir: format!("{home}/.config/agent-communications/state"),
            data_dir: format!("{home}/.local/share/agent-communications"),
            secrets_dir: format!("{home}/.config/agent-communications/secrets"),
        };
        let windows = Folders {
            config_dir: r"C:\Users\example\AppData\Roaming\agent-communications".into(),
            state_dir: r"C:\Users\example\AppData\Roaming\agent-communications\state".into(),
            data_dir: r"C:\Users\example\AppData\Local\agent-communications".into(),
            secrets_dir: r"C:\Users\example\AppData\Roaming\agent-communications\secrets".into(),
        };
        let cases = [
            (
                Platform::MacOs,
                posix("/home/example"),
                vec!["/home/example/.local/share/agent-communications/launch/events-daemon"],
                "/home/example/.local/share/agent-communications/launch/events-daemon lane bind david --window 3f9a1c2e7b4d5a60 --config-dir /home/example/.config/agent-communications --state-dir /home/example/.config/agent-communications/state --data-dir /home/example/.local/share/agent-communications --secrets-dir /home/example/.config/agent-communications/secrets",
            ),
            (
                Platform::Linux,
                posix("/home/example"),
                vec!["/home/example/.local/share/agent-communications/launch/events-daemon"],
                "/home/example/.local/share/agent-communications/launch/events-daemon lane bind david --window 3f9a1c2e7b4d5a60 --config-dir /home/example/.config/agent-communications --state-dir /home/example/.config/agent-communications/state --data-dir /home/example/.local/share/agent-communications --secrets-dir /home/example/.config/agent-communications/secrets",
            ),
            (
                Platform::Windows,
                windows,
                vec![
                    r"C:\Program Files\nodejs\node.exe",
                    r"C:\Users\example\AppData\Local\agent-communications\launch\events-daemon",
                ],
                r#""C:\Program Files\nodejs\node.exe" C:\Users\example\AppData\Local\agent-communications\launch\events-daemon lane bind david --window "3f9a1c2e7b4d5a60" --config-dir C:\Users\example\AppData\Roaming\agent-communications --state-dir C:\Users\example\AppData\Roaming\agent-communications\state --data-dir C:\Users\example\AppData\Local\agent-communications --secrets-dir C:\Users\example\AppData\Roaming\agent-communications\secrets"#,
            ),
        ];
        for (platform, folders, program, expected) in cases {
            let program = crate::launchers::Program {
                program: program[0].to_string(),
                leading: program[1..].iter().map(|word| word.to_string()).collect(),
            };
            let argv = located_line(product, &words, &program, &folders);
            let text = line(&argv, platform).expect("a line");
            assert_eq!(text, expected, "{platform:?}");
            assert!(
                !text.contains("--json")
                    && !text.contains("--approval")
                    && !text.contains(" approve "),
                "{platform:?}: {text}"
            );
        }
    }
}
