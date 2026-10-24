//! The event service the app runs (0.27.0 design D2, D4, D5, D6, D8; plan P1–P3, Task 2).
//!
//! The app starts `<data>/launch/events-daemon run` detached, through DA4's launcher and pins, with its output in a
//! capped log, and records what it started in its own settings folder (`event-service.json`). A watchdog asks
//! `agent-events status` every 15 seconds, and a pure decision, `decide`, chooses what to do: start, adopt, restart,
//! say it was stopped from outside, give up, restart on a new version, ask first, or nothing. Every side effect is
//! `apply`'s.

use crate::allowlist::{service_run, Call};
use crate::commands::context;
use crate::ipc::{AppError, CliResult, EventServiceState, EventServiceStatus};
use crate::launchers::{check_launcher, find_launcher, launcher_path, program_for, Product};
use crate::paths::{Folders, Platform};
use crate::runner::{command_for, run, RunContext};
use crate::{settings, window, AppState};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

/// The most the service's log holds, in bytes: a write that would pass it drops the older half first.
pub const LOG_CAP: u64 = 1_000_000;
/// How long the restarts wait, one after another: the first, the second, then every one after.
pub const RESTART_WAITS: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(30),
];
/// How many failed starts within `FAILURE_WINDOW` make the app stop trying.
pub const GIVE_UP_AFTER: usize = 5;
/// The window those failures are counted in.
pub const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// The record's file, in the app's settings folder.
pub const RECORD_FILE: &str = "event-service.json";

/// What the person answered when quitting, if they asked for it to be remembered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitAnswer {
    Keep,
    Stop,
}

/// What the app keeps about the service (`<app settings dir>/event-service.json`): whether it is wanted, the service it
/// knows of, the first-start answer, the quit answer, and the starts that failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ServiceRecord {
    /// The switch: on unless the person switched it off (D2).
    pub wanted: bool,
    /// The process the app started, while it knows of one.
    pub pid: Option<u32>,
    /// When the app started it, or adopted one a terminal started (ISO 8601).
    pub started_at: Option<String>,
    /// The installed version when it was started or adopted, from the launcher's `.current`.
    pub version: Option<String>,
    /// Whether the service the app knows of is the app's own; an adopted one is not.
    pub started_by_app: bool,
    /// Whether the first-start question (P1) is settled, by an answer or by a first start.
    pub first_start_answered: bool,
    pub quit_answer: Option<QuitAnswer>,
    /// When starts failed, within `FAILURE_WINDOW` of the newest (ISO 8601).
    pub recent_failures: Vec<String>,
}

impl Default for ServiceRecord {
    fn default() -> Self {
        ServiceRecord {
            wanted: true,
            pid: None,
            started_at: None,
            version: None,
            started_by_app: false,
            first_start_answered: false,
            quit_answer: None,
            recent_failures: Vec::new(),
        }
    }
}

/// What `agent-events status` said of the owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Running,
    NotRunning,
    /// It could not be asked, or its answer could not be read.
    Unknown,
}

/// How the app's own child ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChildExit {
    Code(i32),
    Signal(i32),
}

/// What became of the process the record names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Process {
    /// The record names no process.
    NoneRecorded,
    /// It runs: the app's own child, or the recorded PID, still `events-daemon run`.
    Alive,
    /// The app's own child ended, so how it ended is known.
    Exited(ChildExit),
    /// The recorded PID is no longer `events-daemon run`. It was started before the app last started, so it is not
    /// the app's child, and how it ended is not known: the clean-stop marker tells (P2).
    Gone,
}

/// `<state>/events/last-stop.json`: the PID of an owner that stopped cleanly, and when (P2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StopMarker {
    pub pid: u32,
    pub at: String,
}

/// What the watchdog saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    pub owner: Owner,
    pub process: Process,
    pub marker: Option<StopMarker>,
    /// Whether `<state>/events/events.sqlite` exists: the service has run on this Mac before (P1).
    pub database_exists: bool,
    /// Whether the events-daemon launcher is there to start.
    pub installed: bool,
    /// The version the launcher's `.current` names.
    pub installed_version: Option<String>,
}

/// What the watchdog does next.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Start,
    Adopt,
    Restart { after: Duration },
    MarkStoppedFromOutside,
    GiveUp,
    RestartForVersion,
    AskFirstStart,
    Nothing,
}

/// The heart of the supervisor: what to do, from what the app keeps and what it saw. Nothing is done while the switch
/// is off. Otherwise, by what became of the process the record names:
/// - **alive:** nothing, unless it is the app's own, answering, and the launcher now names another version (D5);
/// - **the app's child ended**, or **its recorded PID is gone:** another owner running is adopted (Review Focus 1); a
///   clean stop — exit 0, or a marker for that PID newer than its start (P2) — turns the switch off (D4); anything else
///   is a crash, restarted after 1 s, 5 s, then 30 s, until the fifth within ten minutes gives up;
/// - **none:** an adopted service that is no longer running turns the switch off, since it was never the app's (D4);
///   an owner running is adopted; after giving up, or with no launcher, nothing; a database from before with the
///   first-start question unsettled asks first (P1); otherwise the app starts one.
pub fn decide(record: &ServiceRecord, observed: &Observation, now: SystemTime) -> Action {
    if !record.wanted {
        return Action::Nothing;
    }
    let running = observed.owner == Owner::Running;
    match observed.process {
        Process::Alive => {
            if running
                && record.started_by_app
                && differs(
                    record.version.as_deref(),
                    observed.installed_version.as_deref(),
                )
            {
                Action::RestartForVersion
            } else {
                Action::Nothing
            }
        }
        Process::Exited(exit) => {
            if running {
                Action::Adopt
            } else if exit == ChildExit::Code(0) {
                Action::MarkStoppedFromOutside
            } else {
                crashed(record, now)
            }
        }
        Process::Gone => {
            if running {
                Action::Adopt
            } else if !record.started_by_app || stopped_cleanly(record, observed.marker.as_ref()) {
                Action::MarkStoppedFromOutside
            } else {
                crashed(record, now)
            }
        }
        Process::NoneRecorded => {
            if adopted(record) {
                return if observed.owner == Owner::NotRunning {
                    Action::MarkStoppedFromOutside
                } else {
                    Action::Nothing
                };
            }
            if running {
                Action::Adopt
            } else if given_up(record) || !observed.installed {
                Action::Nothing
            } else if observed.database_exists && !record.first_start_answered {
                Action::AskFirstStart
            } else {
                Action::Start
            }
        }
    }
}

/// Whether the service the record knows of is one a terminal started, which the app adopted.
fn adopted(record: &ServiceRecord) -> bool {
    record.started_at.is_some() && record.pid.is_none() && !record.started_by_app
}

/// Two versions, both known, that are not the same.
fn differs(running: Option<&str>, installed: Option<&str>) -> bool {
    matches!((running, installed), (Some(running), Some(installed)) if running != installed)
}

/// Whether the marker says the app's service stopped cleanly: for its PID, and newer than its start (P2).
fn stopped_cleanly(record: &ServiceRecord, marker: Option<&StopMarker>) -> bool {
    let (Some(marker), Some(pid), Some(started)) = (
        marker,
        record.pid,
        record.started_at.as_deref().and_then(parse_iso),
    ) else {
        return false;
    };
    marker.pid == pid && parse_iso(&marker.at).is_some_and(|at| at > started)
}

/// The failures the record keeps, as times; one it cannot read is dropped.
fn failure_times(record: &ServiceRecord) -> Vec<SystemTime> {
    record
        .recent_failures
        .iter()
        .filter_map(|text| parse_iso(text))
        .collect()
}

/// A crash: restarted after the wait its place among the failures of the last ten minutes gives, unless it is the
/// fifth (Review Focus 2).
fn crashed(record: &ServiceRecord, now: SystemTime) -> Action {
    let since = now.checked_sub(FAILURE_WINDOW);
    let before = failure_times(record)
        .into_iter()
        .filter(|at| since.is_none_or(|since| *at >= since))
        .count();
    if before + 1 >= GIVE_UP_AFTER {
        Action::GiveUp
    } else {
        Action::Restart {
            after: RESTART_WAITS[before.min(RESTART_WAITS.len() - 1)],
        }
    }
}

/// The failures with one more at `now`, keeping those within `FAILURE_WINDOW` of the newest, oldest first.
fn with_failure(record: &ServiceRecord, now: SystemTime) -> Vec<String> {
    let mut times = failure_times(record);
    times.push(now);
    let newest = times.iter().copied().max().unwrap_or(now);
    let since = newest.checked_sub(FAILURE_WINDOW);
    times.retain(|at| since.is_none_or(|since| *at >= since));
    times.sort();
    times.into_iter().map(iso).collect()
}

/// The record without the service it knew of.
fn forget(record: &ServiceRecord) -> ServiceRecord {
    ServiceRecord {
        pid: None,
        started_at: None,
        version: None,
        started_by_app: false,
        ..record.clone()
    }
}

/// The record after `action`, before any process is started or stopped (`Start` and `RestartForVersion` record their
/// process once it has started).
/// - **adopted:** no PID, not the app's, since now, on the installed version;
/// - **stopped from outside:** forgotten, and the switch off (D4);
/// - **a restart, or giving up:** forgotten, with a failure at `now`.
pub fn recorded(
    record: &ServiceRecord,
    action: Action,
    observed: &Observation,
    now: SystemTime,
) -> ServiceRecord {
    match action {
        Action::Nothing | Action::AskFirstStart | Action::Start | Action::RestartForVersion => {
            record.clone()
        }
        Action::Adopt => ServiceRecord {
            pid: None,
            started_at: Some(iso(now)),
            version: observed.installed_version.clone(),
            started_by_app: false,
            ..record.clone()
        },
        Action::MarkStoppedFromOutside => ServiceRecord {
            wanted: false,
            ..forget(record)
        },
        Action::Restart { .. } | Action::GiveUp => ServiceRecord {
            recent_failures: with_failure(record, now),
            ..forget(record)
        },
    }
}

/// Whether the app has stopped trying: `GIVE_UP_AFTER` failures within `FAILURE_WINDOW` of the newest. It is counted
/// from the newest, not from now, so giving up lasts until Try again clears them.
pub fn given_up(record: &ServiceRecord) -> bool {
    let times = failure_times(record);
    let Some(newest) = times.iter().copied().max() else {
        return false;
    };
    let since = newest.checked_sub(FAILURE_WINDOW);
    times
        .iter()
        .filter(|at| since.is_none_or(|since| **at >= since))
        .count()
        >= GIVE_UP_AFTER
}

/// The installed version, when the service the app knows of was started or adopted on another (D5).
pub fn newer_version(record: &ServiceRecord, observed: &Observation) -> Option<String> {
    let known = record.started_at.is_some();
    (known
        && differs(
            record.version.as_deref(),
            observed.installed_version.as_deref(),
        ))
    .then(|| observed.installed_version.clone())
    .flatten()
}

/// The date of `days` after 1970-01-01: year, month, day (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// The days from 1970-01-01 to a date (`days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = i64::from(month);
    let doy = (153 * if month > 2 { month - 3 } else { month + 9 } + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `time` as ISO 8601 in UTC, to the millisecond, as JavaScript's `toISOString` writes it. A time before 1970 is
/// written as 1970's first moment.
pub fn iso(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or(Duration::ZERO);
    let seconds = since.as_secs() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let rest = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_millis()
    )
}

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$")
        .expect("a pattern")
});

/// An ISO 8601 time in UTC, as `toISOString` writes it (its fraction optional), from 1970 on. Nothing else: no
/// offset, no leap second, no date that is not one.
pub fn parse_iso(text: &str) -> Option<SystemTime> {
    let parts = ISO.captures(text)?;
    let number = |index: usize| parts.get(index)?.as_str().parse::<u32>().ok();
    let (year, month, day) = (i64::from(number(1)?), number(2)?, number(3)?);
    let (hour, minute, second) = (number(4)?, number(5)?, number(6)?);
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let days = u64::try_from(days_from_civil(year, month, day)).ok()?;
    let nanos = match parts.get(7) {
        Some(fraction) => format!("{:0<9}", fraction.as_str()).parse::<u32>().ok()?,
        None => 0,
    };
    let seconds = days * 86_400 + u64::from(hour * 3600 + minute * 60 + second);
    Some(UNIX_EPOCH + Duration::new(seconds, nanos))
}

/// Opens the log to read and append, making it owner-only if it is new, and never through a link.
fn open_log(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

/// Appends `bytes` to the log at `path`, keeping it within `cap`: when the write would pass it, the older half goes
/// first, and the oldest line kept starts whole. A write larger than the cap keeps its newest `cap` bytes. The file is
/// changed in place, since the service writes to it too. With nothing to write it only trims.
pub fn append_capped(path: &Path, bytes: &[u8], cap: u64) -> io::Result<()> {
    let mut file = open_log(path)?;
    let length = file.metadata()?.len();
    let written = bytes.len() as u64;
    if length.saturating_add(written) <= cap {
        return file.write_all(bytes);
    }
    let newest = written.min(cap);
    let new = &bytes[(written - newest) as usize..];
    let old_kept = (cap / 2).saturating_sub(newest).min(length);
    let mut old = vec![0; old_kept as usize];
    file.seek(SeekFrom::Start(length - old_kept))?;
    file.read_exact(&mut old)?;
    if old_kept < length {
        match old.iter().position(|byte| *byte == b'\n') {
            Some(end) => {
                old.drain(..=end);
            }
            None => old.clear(),
        }
    }
    file.set_len(0)?;
    file.write_all(&old)?;
    file.write_all(new)
}

/// Whether a command line is `events-daemon run`: a word naming events-daemon — its launcher, `<data>/launch/
/// events-daemon`, or its runtime's CLI, `…/@agentcomms/events-daemon/dist/cli.mjs`, either of which has a part
/// `events-daemon` — followed by `run`.
pub fn is_service_command_line(args: &[String]) -> bool {
    args.windows(2).any(|pair| {
        pair[1] == "run"
            && pair[0]
                .split(['/', '\\'])
                .any(|part| part == "events-daemon")
    })
}

/// Whether the process `pid` is still `events-daemon run`, read from its command line (Review Focus 3). A PID that has
/// since gone to another program, one the app cannot read, the app itself, and PIDs 0 and 1 are not.
pub fn is_our_service(pid: u32) -> bool {
    if pid <= 1 || pid == std::process::id() {
        return false;
    }
    process_args(pid).is_some_and(|args| is_service_command_line(&args))
}

/// The words a process was started with: on macOS from the kernel (`KERN_PROCARGS2`), on Linux from `/proc`.
#[cfg(target_os = "macos")]
fn process_args(pid: u32) -> Option<Vec<String>> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut most: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
    // SAFETY: `name` names two levels, and `most` is a writable c_int whose size `size` gives.
    let answered = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            2,
            (&mut most as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if answered != 0 || most <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; most as usize];
    let mut size = buffer.len();
    let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    // SAFETY: `name` names three levels, and `buffer` is writable for the `size` bytes given; the kernel writes at most
    // that many and says how many it wrote.
    let answered = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if answered != 0 {
        return None;
    }
    buffer.truncate(size);
    procargs_words(&buffer)
}

#[cfg(target_os = "linux")]
fn process_args(pid: u32) -> Option<Vec<String>> {
    let mut text = Vec::new();
    File::open(format!("/proc/{pid}/cmdline"))
        .ok()?
        .take(256 * 1024)
        .read_to_end(&mut text)
        .ok()?;
    let words: Vec<String> = text
        .split(|byte| *byte == 0)
        .filter(|word| !word.is_empty())
        .map(|word| String::from_utf8_lossy(word).into_owned())
        .collect();
    (!words.is_empty()).then_some(words)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_args(_pid: u32) -> Option<Vec<String>> {
    None
}

/// The words in what `KERN_PROCARGS2` gives: the count, the program's path and the NULs after it, then the words.
#[cfg(any(target_os = "macos", test))]
fn procargs_words(buffer: &[u8]) -> Option<Vec<String>> {
    let count = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let rest = buffer.get(4..)?;
    let rest = &rest[rest.iter().position(|byte| *byte == 0)?..];
    let mut rest = &rest[rest.iter().position(|byte| *byte != 0)?..];
    let mut words = Vec::new();
    for _ in 0..count {
        let end = rest
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(rest.len());
        words.push(String::from_utf8_lossy(&rest[..end]).into_owned());
        rest = rest.get(end + 1..).unwrap_or_default();
    }
    Some(words)
}

static VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$").expect("a pattern")
});

/// The version a launcher pointer's first `current=` line names: `current=0.26.2-events-daemon` is `0.26.2`. A
/// runtime folder of another product's, or one that is not a version, is none.
pub fn current_version(pointer: &str) -> Option<String> {
    let folder = pointer
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .find_map(|line| line.strip_prefix("current="))?;
    let version = folder.strip_suffix("-events-daemon")?;
    VERSION.is_match(version).then(|| version.to_string())
}

/// The first `limit` bytes of `path`, as text.
fn read_small(path: &Path, limit: u64) -> Option<String> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(limit)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}

/// The version the events-daemon launcher starts, from `<data>/launch/events-daemon.current`.
pub fn installed_version(folders: &Folders, platform: Platform) -> Option<String> {
    let launcher = launcher_path(folders, platform, Product::EventsDaemon);
    current_version(&read_small(
        Path::new(&format!("{launcher}.current")),
        4096,
    )?)
}

/// `last-stop.json` as Task 1 writes it, `{"version":1,"pid":…,"at":"<ISO>"}`; anything else is no marker.
pub fn parse_marker(text: &str) -> Option<StopMarker> {
    #[derive(Deserialize)]
    struct MarkerFile {
        version: u64,
        pid: u64,
        at: String,
    }
    let file: MarkerFile = serde_json::from_str(text).ok()?;
    let pid = u32::try_from(file.pid).ok().filter(|pid| *pid > 0)?;
    (file.version == 1 && parse_iso(&file.at).is_some()).then_some(StopMarker { pid, at: file.at })
}

/// The record kept in `dir`: the default — wanted, nothing known — when there is none, or the app cannot read it.
pub fn load_record(dir: &Path) -> ServiceRecord {
    read_small(&dir.join(RECORD_FILE), 64 * 1024)
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Keeps `record` in `dir`, making the folder if it is missing: written beside its place, then moved there, so a reader
/// never sees half of it.
pub fn save_record(dir: &Path, record: &ServiceRecord) -> Result<(), AppError> {
    let failed = |error: io::Error| {
        AppError::io(format!(
            "the event service's record could not be saved in {}: {error}",
            dir.display()
        ))
    };
    fs::create_dir_all(dir).map_err(failed)?;
    let mut text = serde_json::to_string_pretty(record).map_err(|error| {
        AppError::io(format!(
            "the event service's record could not be written: {error}"
        ))
    })?;
    text.push('\n');
    let temporary = dir.join(format!("{RECORD_FILE}.{}.tmp", std::process::id()));
    fs::write(&temporary, text).map_err(failed)?;
    fs::rename(&temporary, dir.join(RECORD_FILE)).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        failed(error)
    })
}

// The supervisor: what `apply` does to processes and files, and the watchdog that runs it.

/// How often the watchdog asks `agent-events status` (plan, Global Constraints).
pub const WATCH_EVERY: Duration = Duration::from_secs(15);
/// How soon it looks again while a service it started is not answering yet, so the window sees it running, for the
/// first `SOON_FOR` after the start.
const SOON: Duration = Duration::from_secs(2);
const SOON_FOR: Duration = Duration::from_secs(60);
/// How long a stop waits for the service to go, after the CLI's stop and again after a signal.
pub const STOP_WAIT: Duration = Duration::from_secs(20);
/// The service's output, in `<state>/events`.
pub const LOG_FILE: &str = "service.log";
/// Task 1's clean-stop marker, in `<state>/events`.
pub const MARKER_FILE: &str = "last-stop.json";
/// The service's database, in `<state>/events`: the app only asks whether it exists (P1), and never opens it.
pub const DATABASE_FILE: &str = "events.sqlite";
/// How many of the log's last lines the window is shown when the app gives up.
pub const LOG_TAIL_LINES: usize = 20;
/// The event the window hears the state by, whenever it changes.
pub const CHANGED: &str = "event-service:changed";
/// The event that asks the window whether to keep the service running (P3).
pub const QUIT_REQUESTED: &str = "quit-requested";
/// Why there is no switch on Windows (B1-G).
pub const WINDOWS_LINE: &str = "The event service doesn't run on Windows yet.";

/// How long the watchdog waits to read the clean-stop marker again, when the app's service from an earlier run has
/// gone with no marker for it yet.
const MARKER_GRACE: Duration = Duration::from_secs(1);

/// The clean-stop marker in `events`, when there is one the app can read.
fn read_marker(events: &Path) -> Option<StopMarker> {
    read_small(&events.join(MARKER_FILE), 4096).and_then(|text| parse_marker(&text))
}

/// `<state>/events`: the service's own folder, where its log and its marker are too.
pub fn events_dir(folders: &Folders) -> PathBuf {
    PathBuf::from(&folders.state_dir).join("events")
}

/// `<state>/events`, made owner-only where it is missing, as the service makes it.
fn ensure_events_dir(folders: &Folders) -> io::Result<PathBuf> {
    let dir = events_dir(folders);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir)?;
    Ok(dir)
}

/// The last `lines` lines of the log, as plain text: from its last 64 KiB, with control characters replaced.
pub fn log_tail(path: &Path, lines: usize) -> Vec<String> {
    const READ: u64 = 64 * 1024;
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let start = file
        .metadata()
        .map(|metadata| metadata.len().saturating_sub(READ))
        .unwrap_or(0);
    let mut bytes = Vec::new();
    if file.seek(SeekFrom::Start(start)).is_err()
        || file.take(READ).read_to_end(&mut bytes).is_err()
    {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut all: Vec<&str> = text.split('\n').collect();
    if start > 0 && !all.is_empty() {
        all.remove(0);
    }
    let kept: Vec<String> = all
        .into_iter()
        .map(|line| {
            line.trim_end_matches('\r')
                .chars()
                .map(|c| {
                    if c.is_control() && c != '\t' {
                        '\u{FFFD}'
                    } else {
                        c
                    }
                })
                .collect::<String>()
        })
        .filter(|line| !line.trim().is_empty())
        .collect();
    kept[kept.len().saturating_sub(lines)..].to_vec()
}

/// What `agent-events status` said, read: `owner` is `running` or `not-running`; anything else is unknown.
fn owner_of(result: &CliResult) -> Owner {
    let CliResult::Ok { data, .. } = result else {
        return Owner::Unknown;
    };
    match data.get("owner").and_then(|owner| owner.as_str()) {
        Some("running") => Owner::Running,
        Some("not-running") => Owner::NotRunning,
        _ => Owner::Unknown,
    }
}

fn exit_of(status: ExitStatus) -> ChildExit {
    if let Some(code) = status.code() {
        return ChildExit::Code(code);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return ChildExit::Signal(signal);
        }
    }
    ChildExit::Code(-1)
}

/// Starts `<data>/launch/events-daemon run` with the pins, detached (plan, Global Constraints):
/// - in a process group of its own, so it outlives the app and a terminal's signals never reach it;
/// - stdin closed, stdout and stderr appended to `<state>/events/service.log`;
/// - the environment every call gets (`runner::command_for`), and its launcher checked as every call's is (DA16).
///
/// No shell, never `npx`, and never on Windows.
pub fn spawn_service(ctx: &RunContext) -> Result<Child, AppError> {
    if ctx.platform == Platform::Windows || cfg!(windows) {
        return Err(AppError::refused(WINDOWS_LINE));
    }
    let launcher =
        find_launcher(&ctx.folders, ctx.platform, Product::EventsDaemon).ok_or_else(|| {
            AppError::not_installed(format!(
                "there is no events-daemon launcher at {}",
                launcher_path(&ctx.folders, ctx.platform, Product::EventsDaemon)
            ))
        })?;
    check_launcher(&launcher, ctx.platform)?;
    let program = program_for(&launcher, ctx.platform, ctx.node.as_deref())?;
    let log_failed = |error: io::Error| {
        AppError::io(format!(
            "the event service's log in {} could not be opened: {error}",
            events_dir(&ctx.folders).display()
        ))
    };
    let events = ensure_events_dir(&ctx.folders).map_err(log_failed)?;
    let log = open_log(&events.join(LOG_FILE)).map_err(log_failed)?;
    let errors = log.try_clone().map_err(log_failed)?;
    let mut command = command_for(&service_run(), &program, &ctx.folders, false);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(errors));
    detach(&mut command);
    command.spawn().map_err(|error| {
        AppError::io(format!(
            "the events-daemon launcher could not be started: {error}"
        ))
    })
}

#[cfg(unix)]
fn detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn detach(_command: &mut Command) {}

/// The supervisor: the record, the app's own child, and what the window is told. `decide` chooses; this does it.
pub struct Supervisor {
    record: ServiceRecord,
    /// Where the record is kept; none keeps it in memory only.
    record_dir: Option<PathBuf>,
    platform: Platform,
    /// The service the app started in this run: its exit is known, since it is the app's child.
    child: Option<Child>,
    started: Option<Instant>,
    /// When a restart is due, while it waits (1 s, 5 s, then 30 s).
    restart_due: Option<SystemTime>,
    /// Set while a start is a restart, so it is counted.
    restarting: bool,
    restarts: u32,
    last_restart_at: Option<String>,
    stopped_from_outside_at: Option<String>,
    first_start_question: bool,
    /// What `status` last said, and the version installed then.
    owner: Owner,
    installed_version: Option<String>,
    full_disk_access: String,
}

impl Supervisor {
    pub fn new(record: ServiceRecord, record_dir: Option<PathBuf>, platform: Platform) -> Self {
        Supervisor {
            record,
            record_dir,
            platform,
            child: None,
            started: None,
            restart_due: None,
            restarting: false,
            restarts: 0,
            last_restart_at: None,
            stopped_from_outside_at: None,
            first_start_question: false,
            owner: Owner::Unknown,
            installed_version: None,
            full_disk_access: FULL_DISK_ACCESS_NOT_NEEDED.into(),
        }
    }

    pub fn record(&self) -> &ServiceRecord {
        &self.record
    }

    fn save(&self) {
        if let Some(dir) = &self.record_dir {
            let _ = save_record(dir, &self.record);
        }
    }

    /// A line of the app's own in the service's log, so the tail shown on giving up says what the app did.
    fn note(&self, ctx: &RunContext, now: SystemTime, line: &str) {
        if let Ok(events) = ensure_events_dir(&ctx.folders) {
            let _ = append_capped(
                &events.join(LOG_FILE),
                format!("[{}] {line}\n", iso(now)).as_bytes(),
                LOG_CAP,
            );
        }
    }

    /// Keeps the log within its cap, for what the service wrote since.
    fn trim_log(&self, ctx: &RunContext) {
        let log = events_dir(&ctx.folders).join(LOG_FILE);
        if fs::symlink_metadata(&log).is_ok_and(|metadata| metadata.is_file()) {
            let _ = append_capped(&log, &[], LOG_CAP);
        }
    }

    /// What became of the process the record names: the app's child is asked; a PID from an earlier run is read.
    fn process(&mut self) -> Process {
        if let Some(child) = &mut self.child {
            return match child.try_wait() {
                Ok(None) => Process::Alive,
                Ok(Some(status)) => Process::Exited(exit_of(status)),
                Err(_) => Process::Gone,
            };
        }
        match self.record.pid {
            Some(pid) if is_our_service(pid) => Process::Alive,
            Some(_) => Process::Gone,
            None => Process::NoneRecorded,
        }
    }

    fn owner_now(&mut self, ctx: &RunContext) -> Owner {
        self.owner = owner_of(&run(&Call::EventsStatus {}, ctx));
        self.owner
    }

    /// What the watchdog sees: the process, `agent-events status`, the marker, whether the database exists, and the
    /// launcher and its version. Nothing in the event database is opened.
    ///
    /// The service writes its marker after its control socket closes, so `status` can say it is not running while its
    /// process still is (Task 1). A recorded PID that is still `events-daemon run` is therefore alive, whatever
    /// `status` says, and `decide` waits for it. Once it is gone with no marker for it yet, the marker is read once
    /// more, after `MARKER_GRACE`, before it can count as a crash.
    fn observe(&mut self, ctx: &RunContext) -> Observation {
        let process = self.process();
        let owner = self.owner_now(ctx);
        let events = events_dir(&ctx.folders);
        let installed_version = installed_version(&ctx.folders, ctx.platform);
        self.installed_version = installed_version.clone();
        let mut marker = read_marker(&events);
        if process == Process::Gone && !stopped_cleanly(&self.record, marker.as_ref()) {
            thread::sleep(MARKER_GRACE);
            marker = read_marker(&events);
        }
        Observation {
            owner,
            process,
            marker,
            database_exists: fs::symlink_metadata(events.join(DATABASE_FILE)).is_ok(),
            installed: find_launcher(&ctx.folders, ctx.platform, Product::EventsDaemon).is_some(),
            installed_version,
        }
    }

    /// One look: observe, decide, apply. While a restart waits, nothing is asked until it is due.
    pub fn tick(&mut self, ctx: &RunContext, now: SystemTime) {
        if self.platform == Platform::Windows {
            return;
        }
        self.trim_log(ctx);
        if let Some(due) = self.restart_due {
            if now < due {
                return;
            }
            self.restart_due = None;
            self.restarting = true;
        }
        let observed = self.observe(ctx);
        let action = decide(&self.record, &observed, now);
        self.apply(ctx, action, &observed, now);
        self.restarting = false;
    }

    /// Does what `decide` chose.
    fn apply(&mut self, ctx: &RunContext, action: Action, observed: &Observation, now: SystemTime) {
        match action {
            Action::Nothing => {
                // Off, with a process of the app's that has since gone: forgotten.
                if !self.record.wanted
                    && matches!(observed.process, Process::Exited(_) | Process::Gone)
                {
                    self.child = None;
                    self.record = forget(&self.record);
                    self.save();
                }
            }
            Action::AskFirstStart => self.first_start_question = true,
            Action::Start => self.start(ctx, observed, now),
            Action::RestartForVersion => {
                self.note(
                    ctx,
                    now,
                    &format!(
                        "Agent Comms restarts the event service on {}.",
                        observed
                            .installed_version
                            .as_deref()
                            .unwrap_or("the version installed")
                    ),
                );
                self.stop(ctx);
                self.record = forget(&self.record);
                self.restarting = true;
                self.start(ctx, observed, now);
            }
            Action::Restart { after } => {
                self.note(
                    ctx,
                    now,
                    &format!(
                        "The event service stopped {}; Agent Comms starts it again in {} s.",
                        how(observed.process),
                        after.as_secs()
                    ),
                );
                self.child = None;
                self.record = recorded(&self.record, action, observed, now);
                self.restart_due = Some(now + after);
                self.save();
            }
            Action::GiveUp => {
                self.note(
                    ctx,
                    now,
                    &format!(
                        "The event service stopped {}. It stopped 5 times in 10 minutes, so Agent Comms stopped restarting it.",
                        how(observed.process)
                    ),
                );
                self.child = None;
                self.record = recorded(&self.record, action, observed, now);
                self.save();
            }
            Action::Adopt => {
                self.child = None;
                self.record = recorded(&self.record, action, observed, now);
                self.save();
            }
            Action::MarkStoppedFromOutside => {
                let at = observed
                    .marker
                    .as_ref()
                    .filter(|marker| Some(marker.pid) == self.record.pid)
                    .map(|marker| marker.at.clone())
                    .unwrap_or_else(|| iso(now));
                self.child = None;
                self.record = recorded(&self.record, action, observed, now);
                self.stopped_from_outside_at = Some(at);
                self.save();
            }
        }
    }

    /// Starts the service, and records it as the app's: its PID, when, and the version installed. A start that fails
    /// is a failed start, and is counted.
    fn start(&mut self, ctx: &RunContext, observed: &Observation, now: SystemTime) {
        let restart = std::mem::take(&mut self.restarting);
        self.first_start_question = false;
        match spawn_service(ctx) {
            Ok(child) => {
                let pid = child.id();
                self.record = ServiceRecord {
                    pid: Some(pid),
                    started_at: Some(iso(now)),
                    version: observed.installed_version.clone(),
                    started_by_app: true,
                    first_start_answered: true,
                    ..self.record.clone()
                };
                self.child = Some(child);
                self.started = Some(Instant::now());
                if restart {
                    self.restarts += 1;
                    self.last_restart_at = Some(iso(now));
                }
                self.note(
                    ctx,
                    now,
                    &format!("Agent Comms started the event service (process {pid})."),
                );
            }
            Err(error) => {
                self.note(
                    ctx,
                    now,
                    &format!(
                        "Agent Comms could not start the event service: {}",
                        error.message
                    ),
                );
                self.record = ServiceRecord {
                    recent_failures: with_failure(&self.record, now),
                    ..forget(&self.record)
                };
            }
        }
        self.save();
    }

    /// Stops the running service through `agent-events stop`, and waits for it to go. Only when that does not stop it
    /// is the recorded PID sent SIGTERM, and only once it is checked to be `events-daemon run` (Review Focus 3).
    fn stop(&mut self, ctx: &RunContext) {
        let asked = matches!(
            run(&Call::EventsStop {}, ctx),
            CliResult::Ok { exit: 0, .. }
        );
        if !(asked && self.wait_gone(ctx, STOP_WAIT)) && self.terminate() {
            self.wait_gone(ctx, STOP_WAIT);
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.try_wait();
        }
        self.owner_now(ctx);
    }

    /// Waits, at most `limit`, for the service to go: the app's own process to end, or, for an adopted one, `status` to
    /// say it no longer runs.
    fn wait_gone(&mut self, ctx: &RunContext, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        loop {
            let gone = match self.process() {
                Process::Alive => false,
                Process::NoneRecorded => self.owner_now(ctx) != Owner::Running,
                Process::Exited(_) | Process::Gone => true,
            };
            if gone {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(200));
        }
    }

    /// SIGTERM to the recorded PID, only while it is `events-daemon run`; whether one was sent.
    fn terminate(&self) -> bool {
        #[cfg(unix)]
        if let Some(pid) = self.record.pid.filter(|pid| is_our_service(*pid)) {
            if let Ok(pid) = libc::pid_t::try_from(pid) {
                // SAFETY: kill takes a PID and a signal and touches no memory; the PID was just checked to be the
                // service's.
                return unsafe { libc::kill(pid, libc::SIGTERM) } == 0;
            }
        }
        false
    }

    /// How long the watchdog sleeps: until a restart is due, a little while a start is not answering yet, else 15 s.
    pub fn next_wait(&mut self, now: SystemTime) -> Duration {
        if let Some(due) = self.restart_due {
            return due
                .duration_since(now)
                .unwrap_or(Duration::ZERO)
                .min(WATCH_EVERY);
        }
        let starting = self.owner != Owner::Running
            && self.started.is_some_and(|at| at.elapsed() < SOON_FOR)
            && self.process() == Process::Alive;
        if starting {
            SOON
        } else {
            WATCH_EVERY
        }
    }

    /// Whether a service the app started runs: what the quit question is asked about (P3).
    pub fn app_service_running(&mut self) -> bool {
        self.record.started_by_app && self.process() == Process::Alive
    }

    /// The state the window is shown.
    pub fn state(&mut self, ctx: &RunContext) -> EventServiceState {
        if self.platform == Platform::Windows {
            return unavailable();
        }
        let process = self.process();
        let running = self.owner == Owner::Running;
        let status = if running {
            EventServiceStatus::Running
        } else if process == Process::Alive || self.restart_due.is_some() {
            EventServiceStatus::Starting
        } else if self.record.wanted && given_up(&self.record) {
            EventServiceStatus::GaveUp
        } else {
            EventServiceStatus::Stopped
        };
        let ours = self.record.started_by_app && process == Process::Alive;
        let known = self.record.started_at.is_some();
        EventServiceState {
            available: true,
            wanted: self.record.wanted,
            status,
            started_by: running.then(|| if ours { "app" } else { "terminal" }.to_string()),
            since: running.then(|| self.record.started_at.clone()).flatten(),
            version: running.then(|| self.record.version.clone()).flatten(),
            newer_version: (running
                && known
                && differs(
                    self.record.version.as_deref(),
                    self.installed_version.as_deref(),
                ))
            .then(|| self.installed_version.clone())
            .flatten(),
            restarts: self.restarts,
            last_restart_at: self.last_restart_at.clone(),
            stopped_from_outside_at: self.stopped_from_outside_at.clone(),
            log_tail: if status == EventServiceStatus::GaveUp {
                log_tail(&events_dir(&ctx.folders).join(LOG_FILE), LOG_TAIL_LINES)
            } else {
                Vec::new()
            },
            first_start_question: self.first_start_question,
            full_disk_access: self.full_disk_access.clone(),
        }
    }

    /// The switch. On: wanted, with its failures cleared, and a service the app knew of that is no longer there
    /// forgotten, so it starts one, or adopts one running — also after an adopted one went, or a stop from outside
    /// (D4). Off: whatever runs is stopped through `agent-events stop`. Either is the first-start question's answer.
    pub fn set_wanted(&mut self, ctx: &RunContext, on: bool, now: SystemTime) {
        self.restart_due = None;
        self.restarting = false;
        self.first_start_question = false;
        self.record.first_start_answered = true;
        if on {
            self.record.wanted = true;
            self.record.recent_failures.clear();
            self.stopped_from_outside_at = None;
            let mut observed = self.observe(ctx);
            if observed.owner != Owner::Running && observed.process != Process::Alive {
                self.child = None;
                self.record = forget(&self.record);
                observed.process = Process::NoneRecorded;
            }
            let action = decide(&self.record, &observed, now);
            self.apply(ctx, action, &observed, now);
        } else {
            self.record.wanted = false;
            let observed = self.observe(ctx);
            if observed.owner == Owner::Running || observed.process == Process::Alive {
                self.stop(ctx);
            }
            self.child = None;
            self.record = forget(&self.record);
        }
        self.save();
    }

    /// Try again, after giving up: the switch on again, with the failures forgotten.
    pub fn retry(&mut self, ctx: &RunContext, now: SystemTime) {
        self.set_wanted(ctx, true, now);
    }

    /// Restart to use it (D5): whatever runs is stopped, then the app starts the version installed now, as its own.
    pub fn restart(&mut self, ctx: &RunContext, now: SystemTime) {
        self.restart_due = None;
        self.first_start_question = false;
        self.record.wanted = true;
        self.record.first_start_answered = true;
        self.record.recent_failures.clear();
        let observed = self.observe(ctx);
        if observed.owner == Owner::Running || observed.process == Process::Alive {
            self.stop(ctx);
        }
        self.child = None;
        self.record = forget(&self.record);
        self.restarting = true;
        let observed = self.observe(ctx);
        let action = decide(&self.record, &observed, now);
        self.apply(ctx, action, &observed, now);
        self.restarting = false;
        self.save();
    }

    /// The first-start question's answer (P1): Start starts it, Not now leaves the switch off.
    pub fn answer_first_start(&mut self, ctx: &RunContext, start: bool, now: SystemTime) {
        self.set_wanted(ctx, start, now);
    }

    /// Keeps the quit question's answer, for Remember my answer.
    pub fn remember_quit(&mut self, answer: QuitAnswer) {
        self.record.quit_answer = Some(answer);
        self.save();
    }

    /// Quit's Stop it: a service the app started is stopped, and forgotten, so its clean stop is not one from outside.
    /// The switch stays on, so the app starts it again when it next runs (D2).
    pub fn stop_for_quit(&mut self, ctx: &RunContext) {
        if self.app_service_running() {
            self.stop(ctx);
            self.record = forget(&self.record);
            self.save();
        }
    }
}

/// How a crash ended, for the log.
fn how(process: Process) -> String {
    match process {
        Process::Exited(ChildExit::Code(code)) => format!("with exit code {code}"),
        Process::Exited(ChildExit::Signal(signal)) => format!("on signal {signal}"),
        _ => "without a clean stop".into(),
    }
}

/// The state on Windows, where the service does not run (B1-G).
pub fn unavailable() -> EventServiceState {
    EventServiceState {
        available: false,
        wanted: false,
        status: EventServiceStatus::Unavailable,
        started_by: None,
        since: None,
        version: None,
        newer_version: None,
        restarts: 0,
        last_restart_at: None,
        stopped_from_outside_at: None,
        log_tail: Vec::new(),
        first_start_question: false,
        full_disk_access: FULL_DISK_ACCESS_NOT_NEEDED.into(),
    }
}

/// `full_disk_access` when no WhatsApp account needs it, or off macOS (D6).
pub const FULL_DISK_ACCESS_NOT_NEEDED: &str = "not-needed";

// The app's side: the supervisor in Tauri's state, its watchdog thread, the commands' work, and Quit.

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Wakes the watchdog early, after a command.
#[derive(Default)]
struct Wake {
    woken: Mutex<bool>,
    signal: Condvar,
}

impl Wake {
    fn notify(&self) {
        *lock(&self.woken) = true;
        self.signal.notify_all();
    }

    fn wait(&self, timeout: Duration) {
        let woken = lock(&self.woken);
        let (mut woken, _) = self
            .signal
            .wait_timeout_while(woken, timeout, |woken| !*woken)
            .unwrap_or_else(PoisonError::into_inner);
        *woken = false;
    }
}

/// What the main thread may read without waiting for the supervisor: the last state, and what Quit needs.
#[derive(Default)]
struct Shown {
    state: Option<EventServiceState>,
    app_service_running: bool,
    quit_answer: Option<QuitAnswer>,
}

/// The event service as the app holds it. The supervisor is none on Windows, where nothing is ever started.
#[derive(Default)]
pub struct EventService {
    supervisor: Mutex<Option<Supervisor>>,
    shown: Mutex<Shown>,
    wake: Wake,
    /// Set once Quit asks, or stops the service to quit: a second Quit adds nothing.
    asking: AtomicBool,
}

/// Starts the supervisor, in `setup`: loads the record, and starts the watchdog, which looks at once and then every
/// 15 seconds. Wanted by default (D2), so a first launch, or a launch at login, starts the service. Nothing on Windows.
pub fn start(app: &AppHandle) {
    if Platform::current() == Platform::Windows {
        return;
    }
    let Some(service) = app.try_state::<EventService>() else {
        return;
    };
    let dir = settings::settings_dir(app).ok();
    let record = dir.as_deref().map(load_record).unwrap_or_default();
    *lock(&service.supervisor) = Some(Supervisor::new(record, dir, Platform::current()));
    let app = app.clone();
    let _ = thread::Builder::new()
        .name("event-service".into())
        .spawn(move || loop {
            let wait = with_supervisor(&app, |supervisor, ctx| {
                supervisor.tick(ctx, SystemTime::now());
                supervisor.next_wait(SystemTime::now())
            })
            .map_or(WATCH_EVERY, |(wait, _)| wait);
            match app.try_state::<EventService>() {
                Some(service) => service.wake.wait(wait),
                None => thread::sleep(wait),
            }
        });
}

/// Runs `work` on the supervisor, then tells the window the state when it changed. Never from the main thread: the
/// supervisor runs the events CLI.
fn with_supervisor<T>(
    app: &AppHandle,
    work: impl FnOnce(&mut Supervisor, &RunContext) -> T,
) -> Option<(T, EventServiceState)> {
    let service = app.try_state::<EventService>()?;
    let ctx = context(&app.state::<AppState>());
    let mut held = lock(&service.supervisor);
    let supervisor = held.as_mut()?;
    let answer = work(supervisor, &ctx);
    let state = supervisor.state(&ctx);
    let running = supervisor.app_service_running();
    let quit_answer = supervisor.record().quit_answer;
    drop(held);
    let changed = {
        let mut shown = lock(&service.shown);
        shown.app_service_running = running;
        shown.quit_answer = quit_answer;
        let changed = shown.state.as_ref() != Some(&state);
        shown.state = Some(state.clone());
        changed
    };
    if changed {
        let _ = app.emit(CHANGED, &state);
    }
    Some((answer, state))
}

/// A command's work, and the state after it; the watchdog is woken to look again.
fn command(app: &AppHandle, work: impl FnOnce(&mut Supervisor, &RunContext)) -> EventServiceState {
    let Some((_, state)) = with_supervisor(app, work) else {
        return unavailable();
    };
    if let Some(service) = app.try_state::<EventService>() {
        service.wake.notify();
    }
    state
}

/// `event_service_state`: read only, so the watchdog is not woken.
pub fn current(app: &AppHandle) -> EventServiceState {
    with_supervisor(app, |_, _| {}).map_or_else(unavailable, |(_, state)| state)
}

/// `set_event_service`.
pub fn set_wanted(app: &AppHandle, on: bool) -> EventServiceState {
    command(app, |supervisor, ctx| {
        supervisor.set_wanted(ctx, on, SystemTime::now())
    })
}

/// `event_service_retry`.
pub fn retry(app: &AppHandle) -> EventServiceState {
    command(app, |supervisor, ctx| {
        supervisor.retry(ctx, SystemTime::now())
    })
}

/// `restart_event_service`.
pub fn restart(app: &AppHandle) -> EventServiceState {
    command(app, |supervisor, ctx| {
        supervisor.restart(ctx, SystemTime::now())
    })
}

/// `answer_first_start`.
pub fn answer_first_start(app: &AppHandle, start: bool) -> EventServiceState {
    command(app, |supervisor, ctx| {
        supervisor.answer_first_start(ctx, start, SystemTime::now())
    })
}

/// The pane of System Settings that gives Full Disk Access (D6).
pub const FULL_DISK_ACCESS_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

/// `open_full_disk_access`: System Settings at Full Disk Access, on macOS; the address is the app's own, never one
/// from the window.
pub fn open_full_disk_access(app: &AppHandle) -> Result<(), AppError> {
    if Platform::current() != Platform::MacOs {
        return Err(AppError::refused(
            "Full Disk Access is a macOS setting: nothing needs it here",
        ));
    }
    app.opener()
        .open_url(FULL_DISK_ACCESS_PANE, None::<&str>)
        .map_err(|error| AppError::io(format!("System Settings could not be opened: {error}")))
}

/// What a Quit comes to (P3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuitRoute {
    /// The app quits, and leaves the service as it is: nothing of the app's runs, or Keep running was remembered.
    Quit,
    /// The window is shown and asks "Keep the event service running?"; `answer_quit` quits.
    Ask,
    /// Stop it was remembered: the service the app started is stopped, then the app quits.
    StopThenQuit,
}

/// Whether Quit asks: only while a service the app started runs, and no answer is remembered (P3).
pub fn quit_route(app_service_running: bool, answer: Option<QuitAnswer>) -> QuitRoute {
    match (app_service_running, answer) {
        (false, _) | (true, Some(QuitAnswer::Keep)) => QuitRoute::Quit,
        (true, Some(QuitAnswer::Stop)) => QuitRoute::StopThenQuit,
        (true, None) => QuitRoute::Ask,
    }
}

/// Whether this Quit is the first to ask: a second while the question is open asks nothing more.
fn first_to_ask(asking: &AtomicBool) -> bool {
    !asking.swap(true, Ordering::SeqCst)
}

/// Quit, from the tray, the app menu (Cmd+Q) or an exit the app did not start itself. Called on the main thread, so it
/// waits for nothing: it reads what the supervisor last published. On `Ask` the window is shown and brought forward,
/// and the first such Quit sends `quit-requested`; a second, while it asks, only brings the window forward again, and
/// never quits past the question (Review Focus 5). On `StopThenQuit` a thread of its own stops the service, then quits.
/// On `Quit` the caller quits.
pub fn on_quit(app: &AppHandle) -> QuitRoute {
    let Some(service) = app.try_state::<EventService>() else {
        return QuitRoute::Quit;
    };
    let route = {
        let shown = lock(&service.shown);
        quit_route(shown.app_service_running, shown.quit_answer)
    };
    match route {
        QuitRoute::Quit => {}
        QuitRoute::Ask => {
            window::show(app);
            if first_to_ask(&service.asking) {
                let _ = app.emit(QUIT_REQUESTED, ());
            }
        }
        QuitRoute::StopThenQuit => {
            if first_to_ask(&service.asking) {
                let app = app.clone();
                thread::spawn(move || {
                    with_supervisor(&app, |supervisor, ctx| supervisor.stop_for_quit(ctx));
                    quit(&app);
                });
            }
        }
    }
    route
}

/// Quits: from here on a close closes.
pub fn quit(app: &AppHandle) {
    window::QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// `answer_quit`: keeps the answer when asked to, stops a service the app started on Stop it, then quits (P3).
pub fn answer_quit(app: &AppHandle, keep: bool, remember: bool) -> Result<(), AppError> {
    let answer = if keep {
        QuitAnswer::Keep
    } else {
        QuitAnswer::Stop
    };
    with_supervisor(app, |supervisor, ctx| {
        if remember {
            supervisor.remember_quit(answer);
        }
        if !keep {
            supervisor.stop_for_quit(ctx);
        }
    });
    quit(app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    /// 2026-10-25T12:00:00.000Z.
    fn now() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_792_929_600)
    }

    const STARTED: &str = "2026-10-25T11:00:00.000Z";
    const PID: u32 = 4242;

    fn fresh() -> ServiceRecord {
        ServiceRecord::default()
    }

    /// A service the app started an hour ago.
    fn app_started() -> ServiceRecord {
        ServiceRecord {
            pid: Some(PID),
            started_at: Some(STARTED.into()),
            version: Some("0.26.2".into()),
            started_by_app: true,
            first_start_answered: true,
            ..fresh()
        }
    }

    /// A service a terminal started, which the app adopted an hour ago.
    fn adopted() -> ServiceRecord {
        ServiceRecord {
            pid: None,
            started_at: Some(STARTED.into()),
            version: Some("0.26.2".into()),
            started_by_app: false,
            ..fresh()
        }
    }

    fn seen(owner: Owner, process: Process) -> Observation {
        Observation {
            owner,
            process,
            marker: None,
            database_exists: false,
            installed: true,
            installed_version: Some("0.26.2".into()),
        }
    }

    fn failures(times: &[&str]) -> Vec<String> {
        times.iter().map(|time| time.to_string()).collect()
    }

    use Action::*;
    use Owner::*;

    #[test]
    fn wanted_and_not_running_on_a_fresh_mac_starts() {
        assert!(fresh().wanted, "wanted by default (D2)");
        assert_eq!(
            decide(&fresh(), &seen(NotRunning, Process::NoneRecorded), now()),
            Start
        );
        // A status that could not be read is no reason to wait: a service that cannot start says why, then gives up.
        assert_eq!(
            decide(&fresh(), &seen(Unknown, Process::NoneRecorded), now()),
            Start
        );
        // Without the events-daemon launcher there is nothing to start.
        let absent = Observation {
            installed: false,
            installed_version: None,
            ..seen(NotRunning, Process::NoneRecorded)
        };
        assert_eq!(decide(&fresh(), &absent, now()), Nothing);
    }

    #[test]
    fn wanted_with_an_existing_database_and_no_answer_asks_first() {
        let before = Observation {
            database_exists: true,
            ..seen(NotRunning, Process::NoneRecorded)
        };
        assert_eq!(decide(&fresh(), &before, now()), AskFirstStart);
        // Answered once, never asked again.
        let answered = ServiceRecord {
            first_start_answered: true,
            ..fresh()
        };
        assert_eq!(decide(&answered, &before, now()), Start);
        // Not now leaves the switch off.
        let not_now = ServiceRecord {
            wanted: false,
            first_start_answered: true,
            ..fresh()
        };
        assert_eq!(decide(&not_now, &before, now()), Nothing);
        // A service already running is adopted, not asked about.
        let running = Observation {
            owner: Running,
            ..before.clone()
        };
        assert_eq!(decide(&fresh(), &running, now()), Adopt);
        // Asking changes nothing in the record.
        assert_eq!(recorded(&fresh(), AskFirstStart, &before, now()), fresh());
    }

    #[test]
    fn child_exit_zero_is_stopped_from_outside_and_turns_the_switch_off() {
        let stopped = seen(NotRunning, Process::Exited(ChildExit::Code(0)));
        let action = decide(&app_started(), &stopped, now());
        assert_eq!(action, MarkStoppedFromOutside);
        let after = recorded(&app_started(), action, &stopped, now());
        assert!(!after.wanted, "the switch turns off (D4)");
        assert_eq!(after.pid, None);
        assert_eq!(after.started_at, None);
        assert!(!after.started_by_app);
        assert!(after.recent_failures.is_empty(), "a stop is not a failure");
        // Off, nothing starts.
        assert_eq!(
            decide(&after, &seen(NotRunning, Process::NoneRecorded), now()),
            Nothing
        );
    }

    #[test]
    fn child_signal_or_nonzero_restarts_after_1s_then_5s_then_30s() {
        let mut record = app_started();
        let mut waits = Vec::new();
        for exit in [
            ChildExit::Signal(9),
            ChildExit::Code(1),
            ChildExit::Code(70),
            ChildExit::Signal(11),
        ] {
            let crashed = seen(NotRunning, Process::Exited(exit));
            let action = decide(&record, &crashed, now());
            let Restart { after } = action else {
                panic!("{exit:?} came to {action:?}")
            };
            waits.push(after.as_secs());
            let after = recorded(&record, action, &crashed, now());
            assert!(after.wanted, "a crash keeps the switch on");
            assert_eq!(after.pid, None, "the crashed one is forgotten");
            // Restarted: the app's own again.
            record = ServiceRecord {
                pid: Some(PID),
                started_at: Some(STARTED.into()),
                started_by_app: true,
                ..after
            };
        }
        assert_eq!(waits, [1, 5, 30, 30]);
        assert_eq!(record.recent_failures.len(), 4);
    }

    #[test]
    fn five_failures_in_ten_minutes_give_up() {
        // A service that dies at once, five times a minute apart (Review Focus 2): 1 s, 5 s, 30 s, 30 s, then no more.
        let mut record = app_started();
        let mut actions = Vec::new();
        for minute in 0..5u64 {
            let at = now() + Duration::from_secs(60 * minute);
            let crashed = seen(NotRunning, Process::Exited(ChildExit::Code(1)));
            let action = decide(&record, &crashed, at);
            actions.push(action);
            record = ServiceRecord {
                pid: Some(PID),
                started_at: Some(iso(at)),
                started_by_app: true,
                ..recorded(&record, action, &crashed, at)
            };
        }
        let second = Duration::from_secs;
        assert_eq!(
            actions,
            [
                Restart { after: second(1) },
                Restart { after: second(5) },
                Restart { after: second(30) },
                Restart { after: second(30) },
                GiveUp
            ]
        );
        // Given up: the switch stays on, and nothing starts, on the next tick or an hour later, until Try again.
        let gave_up = ServiceRecord {
            pid: None,
            started_at: None,
            started_by_app: false,
            ..record
        };
        assert!(gave_up.wanted);
        assert_eq!(gave_up.recent_failures.len(), 5);
        assert!(given_up(&gave_up));
        for later in [Duration::ZERO, Duration::from_secs(3600)] {
            assert_eq!(
                decide(
                    &gave_up,
                    &seen(NotRunning, Process::NoneRecorded),
                    now() + Duration::from_secs(300) + later
                ),
                Nothing
            );
        }
        // Four failures in the last ten minutes, and a fifth: that is five.
        let four = ServiceRecord {
            recent_failures: failures(&[
                "2026-10-25T11:51:00.000Z",
                "2026-10-25T11:53:00.000Z",
                "2026-10-25T11:55:00.000Z",
                "2026-10-25T11:58:00.000Z",
            ]),
            ..app_started()
        };
        let crashed = seen(NotRunning, Process::Exited(ChildExit::Code(1)));
        assert_eq!(decide(&four, &crashed, now()), GiveUp);
        assert!(!given_up(&four));
        let after = recorded(&four, GiveUp, &crashed, now());
        assert!(given_up(&after));
        assert_eq!(after.pid, None);
        // Failures spread over more than ten minutes are not five within ten: two count, so it waits 30 s.
        let spread = ServiceRecord {
            recent_failures: failures(&[
                "2026-10-25T11:30:00.000Z",
                "2026-10-25T11:45:00.000Z",
                "2026-10-25T11:52:00.000Z",
                "2026-10-25T11:58:00.000Z",
            ]),
            ..app_started()
        };
        assert_eq!(
            decide(&spread, &crashed, now()),
            Restart { after: second(30) }
        );
        // And only the ones within ten minutes of the newest are kept.
        assert_eq!(
            recorded(&spread, Restart { after: second(30) }, &crashed, now()).recent_failures,
            failures(&[
                "2026-10-25T11:52:00.000Z",
                "2026-10-25T11:58:00.000Z",
                "2026-10-25T12:00:00.000Z",
            ])
        );
    }

    #[test]
    fn an_app_started_service_gone_with_a_newer_marker_for_its_pid_was_stopped() {
        let gone = |marker: StopMarker| Observation {
            marker: Some(marker),
            ..seen(NotRunning, Process::Gone)
        };
        let stopped = gone(StopMarker {
            pid: PID,
            at: "2026-10-25T11:30:00.000Z".into(),
        });
        let action = decide(&app_started(), &stopped, now());
        assert_eq!(action, MarkStoppedFromOutside);
        assert!(!recorded(&app_started(), action, &stopped, now()).wanted);
        // A marker from before this start, or for another PID, says nothing about this one: it crashed.
        for marker in [
            StopMarker {
                pid: PID,
                at: "2026-10-25T10:59:59.999Z".into(),
            },
            StopMarker {
                pid: PID,
                at: STARTED.into(),
            },
            StopMarker {
                pid: PID + 1,
                at: "2026-10-25T11:30:00.000Z".into(),
            },
            StopMarker {
                pid: PID,
                at: "not a time".into(),
            },
        ] {
            assert_eq!(
                decide(&app_started(), &gone(marker.clone()), now()),
                Restart {
                    after: Duration::from_secs(1)
                },
                "{marker:?}"
            );
        }
    }

    #[test]
    fn an_app_started_service_gone_with_no_marker_crashed_and_restarts() {
        let gone = seen(NotRunning, Process::Gone);
        let action = decide(&app_started(), &gone, now());
        assert_eq!(
            action,
            Restart {
                after: Duration::from_secs(1)
            }
        );
        let after = recorded(&app_started(), action, &gone, now());
        assert!(after.wanted);
        assert_eq!(after.pid, None);
        assert_eq!(
            after.recent_failures,
            failures(&["2026-10-25T12:00:00.000Z"])
        );
        // A status that could not be read does not hide a crash.
        assert_eq!(
            decide(&app_started(), &seen(Unknown, Process::Gone), now()),
            Restart {
                after: Duration::from_secs(1)
            }
        );
        // Still there: nothing, whether it answers yet or not.
        assert_eq!(
            decide(&app_started(), &seen(Running, Process::Alive), now()),
            Nothing
        );
        assert_eq!(
            decide(&app_started(), &seen(NotRunning, Process::Alive), now()),
            Nothing
        );
    }

    /// Task 1's service closes its control socket before it writes its marker and ends, so for a moment `status` says
    /// it is not running while its process still is: nothing is judged until the PID is gone.
    #[test]
    fn status_not_running_while_the_pid_is_still_ours_and_no_marker_is_nothing_yet() {
        for owner in [NotRunning, Unknown] {
            assert_eq!(
                decide(&app_started(), &seen(owner, Process::Alive), now()),
                Nothing,
                "{owner:?}"
            );
        }
        // Gone, with its marker: stopped. Gone without one: a crash.
        let marker = StopMarker {
            pid: PID,
            at: "2026-10-25T11:59:59.000Z".into(),
        };
        let stopped = Observation {
            marker: Some(marker),
            ..seen(NotRunning, Process::Gone)
        };
        assert_eq!(
            decide(&app_started(), &stopped, now()),
            MarkStoppedFromOutside
        );
        assert_eq!(
            decide(&app_started(), &seen(NotRunning, Process::Gone), now()),
            Restart {
                after: Duration::from_secs(1)
            }
        );
    }

    #[test]
    fn a_terminal_started_service_that_goes_away_is_not_restarted() {
        assert_eq!(
            decide(&adopted(), &seen(Running, Process::NoneRecorded), now()),
            Nothing
        );
        let went = seen(NotRunning, Process::NoneRecorded);
        let action = decide(&adopted(), &went, now());
        assert_eq!(action, MarkStoppedFromOutside);
        let after = recorded(&adopted(), action, &went, now());
        assert!(!after.wanted, "the Events screen offers Start (D4)");
        assert_eq!(after.started_at, None);
        assert!(after.recent_failures.is_empty());
        assert_eq!(decide(&after, &went, now()), Nothing);
        // A status that could not be read is not a stop.
        assert_eq!(
            decide(&adopted(), &seen(Unknown, Process::NoneRecorded), now()),
            Nothing
        );
    }

    #[test]
    fn already_running_owner_when_starting_is_adopted() {
        // The app's start was refused because a terminal's `agent-events run` owns the database (Review Focus 1).
        let refused = seen(Running, Process::Exited(ChildExit::Code(78)));
        let action = decide(&app_started(), &refused, now());
        assert_eq!(action, Adopt);
        let after = recorded(&app_started(), action, &refused, now());
        assert!(after.wanted);
        assert_eq!(after.pid, None);
        assert!(!after.started_by_app);
        assert_eq!(
            after.started_at.as_deref(),
            Some("2026-10-25T12:00:00.000Z")
        );
        assert_eq!(after.version.as_deref(), Some("0.26.2"));
        assert!(
            after.recent_failures.is_empty(),
            "a refusal because one runs is not a failure"
        );
        // Then: adopted and running, and nothing more, tick after tick: no restart loop.
        for _ in 0..3 {
            assert_eq!(
                decide(&after, &seen(Running, Process::NoneRecorded), now()),
                Nothing
            );
        }
        // Nothing of the app's, and an owner running: adopted too, whatever the record's PID now is.
        assert_eq!(
            decide(&fresh(), &seen(Running, Process::NoneRecorded), now()),
            Adopt
        );
        assert_eq!(
            decide(&app_started(), &seen(Running, Process::Gone), now()),
            Adopt
        );
    }

    #[test]
    fn an_installed_version_newer_than_the_running_one_restarts_an_app_started_service() {
        let newer = Observation {
            installed_version: Some("0.27.0".into()),
            ..seen(Running, Process::Alive)
        };
        assert_eq!(decide(&app_started(), &newer, now()), RestartForVersion);
        assert_eq!(
            newer_version(&app_started(), &newer).as_deref(),
            Some("0.27.0")
        );
        // The same version: nothing.
        assert_eq!(
            decide(&app_started(), &seen(Running, Process::Alive), now()),
            Nothing
        );
        assert_eq!(
            newer_version(&app_started(), &seen(Running, Process::Alive)),
            None
        );
        // One that is not answering yet is left to start first; an unknown installed version is no reason.
        let starting = Observation {
            owner: NotRunning,
            ..newer.clone()
        };
        assert_eq!(decide(&app_started(), &starting, now()), Nothing);
        let unknown = Observation {
            installed_version: None,
            ..newer.clone()
        };
        assert_eq!(decide(&app_started(), &unknown, now()), Nothing);
    }

    #[test]
    fn an_installed_version_newer_than_the_running_one_only_reports_on_an_adopted_one() {
        let newer = Observation {
            installed_version: Some("0.27.0".into()),
            ..seen(Running, Process::NoneRecorded)
        };
        assert_eq!(decide(&adopted(), &newer, now()), Nothing);
        assert_eq!(newer_version(&adopted(), &newer).as_deref(), Some("0.27.0"));
        assert_eq!(
            newer_version(&adopted(), &seen(Running, Process::NoneRecorded)),
            None
        );
    }

    #[test]
    fn not_wanted_does_nothing() {
        let off = ServiceRecord {
            wanted: false,
            ..app_started()
        };
        let processes = [
            Process::NoneRecorded,
            Process::Alive,
            Process::Exited(ChildExit::Code(0)),
            Process::Exited(ChildExit::Code(1)),
            Process::Exited(ChildExit::Signal(9)),
            Process::Gone,
        ];
        for record in [
            off.clone(),
            ServiceRecord {
                wanted: false,
                ..fresh()
            },
        ] {
            for owner in [Running, NotRunning, Unknown] {
                for process in processes {
                    for database_exists in [false, true] {
                        let observed = Observation {
                            database_exists,
                            installed_version: Some("0.27.0".into()),
                            ..seen(owner, process)
                        };
                        assert_eq!(
                            decide(&record, &observed, now()),
                            Nothing,
                            "{owner:?} {process:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn append_capped_keeps_the_newest_bytes_under_one_megabyte() {
        let dir = tempfile::tempdir().expect("a folder");
        // 1.2 MB in one write: at most 1 MB is left, and it ends with the newest bytes.
        let log = dir.path().join("one.log");
        let big: Vec<u8> = (0..1_200_000u32).map(|i| b'a' + (i % 26) as u8).collect();
        append_capped(&log, &big, LOG_CAP).expect("written");
        let kept = fs::read(&log).expect("read");
        assert!(kept.len() as u64 <= LOG_CAP, "{}", kept.len());
        assert!(!kept.is_empty());
        assert!(big.ends_with(&kept));
        // 1.2 MB a line at a time: never over, the newest line last, and the oldest kept line whole.
        let lines = dir.path().join("lines.log");
        let line = |n: usize| format!("line {n:06} {}\n", "x".repeat(88));
        for n in 0..12_000 {
            append_capped(&lines, line(n).as_bytes(), LOG_CAP).expect("written");
            if n % 1000 == 999 {
                let size = fs::metadata(&lines).expect("there").len();
                assert!(size <= LOG_CAP, "{size} after line {n}");
            }
        }
        let kept = fs::read_to_string(&lines).expect("read");
        assert!(kept.len() as u64 <= LOG_CAP);
        assert!(kept.ends_with(&line(11_999)));
        assert!(kept.starts_with("line "), "the oldest line kept is whole");
        assert!(
            kept.len() as u64 >= LOG_CAP / 2 - 200,
            "only the older half is dropped: {}",
            kept.len()
        );
        // Under the cap, nothing is dropped.
        let small = dir.path().join("small.log");
        append_capped(&small, b"one\n", LOG_CAP).expect("written");
        append_capped(&small, b"two\n", LOG_CAP).expect("written");
        assert_eq!(fs::read(&small).expect("read"), b"one\ntwo\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&small).expect("there").permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{mode:o}");
        }
    }

    fn words(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn is_our_service_refuses_a_reused_pid() {
        // The command line decides: `events-daemon`, by its launcher or its runtime's CLI, then `run`.
        assert!(is_service_command_line(&words(&[
            "/opt/homebrew/bin/node",
            "/home/example/.local/share/agent-communications/runtime/0.26.2-events-daemon/node_modules/@agentcomms/events-daemon/dist/cli.mjs",
            "run",
            "--config-dir",
            "/home/example/.config/agent-communications",
        ])));
        assert!(is_service_command_line(&words(&[
            "/bin/sh",
            "/home/example/.local/share/agent-communications/launch/events-daemon",
            "run",
        ])));
        for other in [
            &["/bin/sleep", "30"][..],
            &[
                "node",
                "/x/node_modules/@agentcomms/events-daemon/dist/cli.mjs",
                "status",
            ],
            &["vim", "run"],
            &["node", "/x/cli.mjs", "run", "events-daemon"],
            &["/x/not-events-daemon", "run"],
            &["/x/events-daemon"],
            &[],
        ] {
            assert!(!is_service_command_line(&words(other)), "{other:?}");
        }
        // A live process that is another program — what a reused PID is — is never ours to adopt or stop.
        #[cfg(unix)]
        {
            let mut sleep = std::process::Command::new("/bin/sleep")
                .arg("30")
                .spawn()
                .expect("sleep started");
            std::thread::sleep(Duration::from_millis(200));
            let pid = sleep.id();
            assert!(!is_our_service(pid));
            let _ = sleep.kill();
            let _ = sleep.wait();
            assert!(!is_our_service(pid), "nor once it is gone");
        }
        assert!(!is_our_service(std::process::id()), "the app itself");
        assert!(!is_our_service(0));
        assert!(!is_our_service(1));
    }

    /// A process that is `events-daemon run`: a fake launcher, started as the app starts the real one, is ours.
    #[cfg(unix)]
    #[test]
    fn is_our_service_takes_a_live_events_daemon_run() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("a folder");
        let launch = dir.path().join("launch");
        fs::create_dir_all(&launch).expect("launch");
        let launcher = launch.join("events-daemon");
        fs::write(&launcher, "#!/bin/sh\nwhile :; do sleep 1; done\n").expect("a launcher");
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).expect("runnable");
        let mut service = std::process::Command::new(&launcher)
            .arg("run")
            .spawn()
            .expect("started");
        let pid = service.id();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !is_our_service(pid) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let seen = is_our_service(pid);
        let _ = service.kill();
        let _ = service.wait();
        assert!(seen, "a live events-daemon run is ours");
        assert!(!is_our_service(pid), "and, once gone, no longer");
    }

    #[test]
    fn the_kernels_process_arguments_are_read_word_by_word() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend_from_slice(b"/opt/homebrew/bin/node\0\0\0\0");
        buffer
            .extend_from_slice(b"/opt/homebrew/bin/node\0/x/launch/events-daemon\0run\0HOME=/x\0");
        assert_eq!(
            procargs_words(&buffer),
            Some(words(&[
                "/opt/homebrew/bin/node",
                "/x/launch/events-daemon",
                "run"
            ]))
        );
        assert_eq!(procargs_words(&[]), None);
        assert_eq!(procargs_words(&(-1i32).to_ne_bytes()), None);
    }

    #[test]
    fn current_version_reads_the_launchers_current_file() {
        let pointer = "# The runtime the stable launcher beside this file starts, written by agent-communications. Do not edit.\ncurrent=0.26.2-events-daemon\nprevious=0.26.1-events-daemon\n";
        assert_eq!(current_version(pointer).as_deref(), Some("0.26.2"));
        assert_eq!(
            current_version("current=0.27.0-feat-0.27-events-daemon\r\n").as_deref(),
            Some("0.27.0-feat-0.27")
        );
        for bad in [
            "",
            "current=\n",
            "current=0.26.2-gmail\n",
            "previous=0.26.2-events-daemon\n",
            "current=../0.26.2-events-daemon\n",
            "current=0.26-events-daemon\n",
            "current=-events-daemon\n",
        ] {
            assert_eq!(current_version(bad), None, "{bad:?}");
        }
        // Read from the file beside the launcher.
        let dir = tempfile::tempdir().expect("a folder");
        let data = dir.path().to_string_lossy().into_owned();
        let folders = Folders {
            config_dir: format!("{data}/config"),
            state_dir: format!("{data}/state"),
            data_dir: data.clone(),
            secrets_dir: format!("{data}/secrets"),
        };
        let platform = Platform::current();
        assert_eq!(installed_version(&folders, platform), None);
        fs::create_dir_all(dir.path().join("launch")).expect("launch");
        fs::write(
            dir.path().join("launch").join("events-daemon.current"),
            pointer,
        )
        .expect("a pointer");
        assert_eq!(
            installed_version(&folders, platform).as_deref(),
            Some("0.26.2")
        );
    }

    #[test]
    fn the_record_round_trips() {
        let dir = tempfile::tempdir().expect("a folder");
        let folder = dir.path().join("nested");
        assert_eq!(load_record(&folder), ServiceRecord::default());
        let record = ServiceRecord {
            wanted: false,
            pid: Some(PID),
            started_at: Some(STARTED.into()),
            version: Some("0.26.2".into()),
            started_by_app: true,
            first_start_answered: true,
            quit_answer: Some(QuitAnswer::Stop),
            recent_failures: failures(&["2026-10-25T11:58:00.000Z"]),
        };
        save_record(&folder, &record).expect("saved");
        assert_eq!(load_record(&folder), record);
        let written: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(folder.join(RECORD_FILE)).expect("written"))
                .expect("JSON");
        assert_eq!(
            written,
            json!({
                "wanted": false,
                "pid": PID,
                "startedAt": STARTED,
                "version": "0.26.2",
                "startedByApp": true,
                "firstStartAnswered": true,
                "quitAnswer": "stop",
                "recentFailures": ["2026-10-25T11:58:00.000Z"]
            })
        );
        // Saved again: replaced, with nothing left beside it.
        save_record(&folder, &ServiceRecord::default()).expect("saved");
        assert_eq!(load_record(&folder), ServiceRecord::default());
        let names: Vec<String> = fs::read_dir(&folder)
            .expect("listed")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, [RECORD_FILE]);
        // A file the app cannot read is the default; a field a later version adds is skipped, a missing one defaulted.
        for text in ["not json", "[]", "{\"wanted\":\"yes\"}", "{\"pid\":-1}"] {
            fs::write(folder.join(RECORD_FILE), text).expect("written");
            assert_eq!(load_record(&folder), ServiceRecord::default(), "{text}");
        }
        fs::write(
            folder.join(RECORD_FILE),
            "{\"firstStartAnswered\":true,\"later\":1}",
        )
        .expect("written");
        assert_eq!(
            load_record(&folder),
            ServiceRecord {
                first_start_answered: true,
                ..ServiceRecord::default()
            }
        );
    }

    #[test]
    fn times_are_written_and_read_as_javascript_writes_them() {
        assert_eq!(iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(now()), "2026-10-25T12:00:00.000Z");
        let leap = UNIX_EPOCH + Duration::from_millis(951_868_799_999);
        assert_eq!(iso(leap), "2000-02-29T23:59:59.999Z");
        for time in [UNIX_EPOCH, now(), leap] {
            assert_eq!(parse_iso(&iso(time)), Some(time));
        }
        assert_eq!(
            parse_iso("2026-10-25T12:00:00Z"),
            Some(now()),
            "seconds alone"
        );
        assert_eq!(
            parse_iso("2026-10-25T12:00:00.5Z"),
            Some(now() + Duration::from_millis(500))
        );
        for bad in [
            "",
            "2026-10-25",
            "2026-10-25T12:00:00",
            "2026-10-25T12:00:00+01:00",
            "2026-13-01T00:00:00.000Z",
            "2026-02-30T00:00:00.000Z",
            "2026-10-25T24:00:00.000Z",
            "2026-10-25T12:00:00.000ZZ",
            " 2026-10-25T12:00:00.000Z",
            "1969-12-31T23:59:59.000Z",
        ] {
            assert_eq!(parse_iso(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_clean_stop_marker_is_read_as_task_1_writes_it() {
        assert_eq!(
            parse_marker("{\"version\":1,\"pid\":4242,\"at\":\"2026-10-25T11:30:00.000Z\"}\n"),
            Some(StopMarker {
                pid: 4242,
                at: "2026-10-25T11:30:00.000Z".into()
            })
        );
        for bad in [
            "",
            "not json",
            "{\"version\":2,\"pid\":4242,\"at\":\"2026-10-25T11:30:00.000Z\"}",
            "{\"version\":1,\"pid\":0,\"at\":\"2026-10-25T11:30:00.000Z\"}",
            "{\"version\":1,\"pid\":-4,\"at\":\"2026-10-25T11:30:00.000Z\"}",
            "{\"version\":1,\"pid\":\"4242\",\"at\":\"2026-10-25T11:30:00.000Z\"}",
            "{\"version\":1,\"pid\":4242,\"at\":\"yesterday\"}",
            "{\"version\":1,\"pid\":4242}",
        ] {
            assert_eq!(parse_marker(bad), None, "{bad:?}");
        }
    }

    /// A stand-in for `<data>/launch/events-daemon`, in a temporary installation: `status` reads a file, `stop` asks
    /// the running one to stop through another, and `run` runs until it is asked — or crashes, or is refused as a
    /// second owner, when told to. It writes what it was given beside itself. No real service is ever started.
    #[cfg(unix)]
    const FAKE_SERVICE: &str = r#"#!/bin/sh
here=$(dirname "$0")
case $1 in
  status)
    if [ -f "$here/running" ]; then printf '{"owner":"running","enabled":false,"paused":false}\n'
    else printf '{"owner":"not-running"}\n'; fi
    exit 0 ;;
  stop)
    printf '%s\n' "$@" > "$here/stop-argv"
    if [ -f "$here/running" ]; then : > "$here/stop"; printf '{"stopping":true}\n'; exit 0; fi
    printf 'the local event service is not running\n' >&2
    exit 69 ;;
  run)
    printf '%s\n' "$@" > "$here/run-argv"
    if [ -f "$here/crash" ]; then printf 'the runtime could not start: boom\n' >&2; exit 1; fi
    if [ -f "$here/refuse" ]; then printf 'another local event service owner is already running\n' >&2; exit 78; fi
    trap 'rm -f "$here/running"; exit 0' TERM
    : > "$here/running"
    printf 'the service runs\n'
    while [ ! -f "$here/stop" ]; do sleep 0.1; done
    rm -f "$here/stop" "$here/running"
    exit 0 ;;
esac
exit 64
"#;

    #[cfg(unix)]
    struct Fake {
        dir: tempfile::TempDir,
        ctx: RunContext,
        app: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl Fake {
        fn new() -> Fake {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().expect("a folder");
            let launch = dir.path().join("launch");
            fs::create_dir_all(&launch).expect("launch");
            let launcher = launch.join("events-daemon");
            fs::write(&launcher, FAKE_SERVICE).expect("a launcher");
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).expect("runnable");
            fs::write(
                launch.join("events-daemon.current"),
                "current=0.26.2-events-daemon\n",
            )
            .expect("a pointer");
            let data = dir.path().to_string_lossy().into_owned();
            let ctx = RunContext {
                folders: Folders {
                    config_dir: format!("{data}/config"),
                    state_dir: format!("{data}/state"),
                    data_dir: data.clone(),
                    secrets_dir: format!("{data}/secrets"),
                },
                platform: Platform::current(),
                node: None,
            };
            let app = dir.path().join("app");
            Fake { dir, ctx, app }
        }

        fn path(&self, name: &str) -> std::path::PathBuf {
            self.dir.path().join("launch").join(name)
        }

        fn mark(&self, name: &str) {
            fs::write(self.path(name), "").expect("a mark");
        }

        fn unmark(&self, name: &str) {
            let _ = fs::remove_file(self.path(name));
        }

        fn has(&self, name: &str) -> bool {
            self.path(name).exists()
        }

        fn log(&self) -> String {
            fs::read_to_string(events_dir(&self.ctx.folders).join(LOG_FILE)).unwrap_or_default()
        }

        fn supervisor(&self, record: ServiceRecord) -> Supervisor {
            Supervisor::new(record, Some(self.app.clone()), Platform::current())
        }

        /// Stops whatever the test left running.
        fn finish(&self, supervisor: &mut Supervisor) {
            self.mark("stop");
            if let Some(mut child) = supervisor.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    #[cfg(unix)]
    fn eventually(what: &str, mut check: impl FnMut() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        while !check() {
            assert!(std::time::Instant::now() < deadline, "{what}, in time");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_service_starts_detached_with_the_pins_and_the_switch_stops_it_through_the_cli() {
        use std::os::unix::fs::PermissionsExt;
        let fake = Fake::new();
        let mut supervisor = fake.supervisor(ServiceRecord::default());
        supervisor.tick(&fake.ctx, SystemTime::now());
        let pid = supervisor.record().pid.expect("started");
        assert!(supervisor.record().started_by_app);
        assert!(supervisor.record().first_start_answered);
        assert_eq!(supervisor.record().version.as_deref(), Some("0.26.2"));
        // Its own process group, so it outlives the app and a terminal's signals never reach it.
        // SAFETY: getpgid takes a PID and touches no memory.
        assert_eq!(
            unsafe { libc::getpgid(pid as libc::pid_t) },
            pid as libc::pid_t
        );
        let events = events_dir(&fake.ctx.folders);
        let mode = fs::metadata(&events).expect("made").permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{mode:o}");
        eventually("it runs", || fake.has("running"));
        // `run`, then the four pins, and nothing else: no `--json`, no shell.
        let mut expected = vec!["run".to_string()];
        expected.extend(fake.ctx.folders.pins());
        let argv = fs::read_to_string(fake.path("run-argv")).expect("its words");
        assert_eq!(argv.lines().collect::<Vec<_>>(), expected);
        // Its output, and the app's own line, in the log.
        eventually("its output is in the log", || {
            fake.log().contains("the service runs\n")
        });
        assert!(fake.log().contains(&format!(
            "Agent Comms started the event service (process {pid})."
        )));
        supervisor.tick(&fake.ctx, SystemTime::now());
        let state = supervisor.state(&fake.ctx);
        assert_eq!(state.status, EventServiceStatus::Running);
        assert_eq!(state.started_by.as_deref(), Some("app"));
        assert_eq!(state.version.as_deref(), Some("0.26.2"));
        assert_eq!(state.since, supervisor.record().started_at);
        assert_eq!(state.newer_version, None);
        assert!(supervisor.app_service_running());
        assert_eq!(load_record(&fake.app).pid, Some(pid), "kept");
        // Off: through `agent-events stop`, and it is gone, and forgotten.
        supervisor.set_wanted(&fake.ctx, false, SystemTime::now());
        let stop = fs::read_to_string(fake.path("stop-argv")).expect("stop was asked");
        assert_eq!(stop.lines().take(2).collect::<Vec<_>>(), ["stop", "--json"]);
        assert!(!fake.has("running"));
        assert!(supervisor.child.is_none());
        let state = supervisor.state(&fake.ctx);
        assert_eq!(state.status, EventServiceStatus::Stopped);
        assert!(!state.wanted);
        assert_eq!(state.stopped_from_outside_at, None, "the app's own stop");
        let kept = load_record(&fake.app);
        assert!(!kept.wanted);
        assert_eq!(kept.pid, None);
        // Off, the watchdog starts nothing.
        fake.unmark("run-argv");
        supervisor.tick(&fake.ctx, SystemTime::now());
        assert!(!fake.has("run-argv"));
        fake.finish(&mut supervisor);
    }

    #[cfg(unix)]
    #[test]
    fn a_crash_is_restarted_after_its_wait_and_a_start_refused_for_another_owner_is_adopted() {
        let fake = Fake::new();
        let mut supervisor = fake.supervisor(ServiceRecord::default());
        fake.mark("crash");
        let start = SystemTime::now();
        supervisor.tick(&fake.ctx, start);
        eventually("it crashes", || {
            matches!(supervisor.process(), Process::Exited(ChildExit::Code(1)))
        });
        supervisor.tick(&fake.ctx, start);
        assert_eq!(supervisor.record().recent_failures.len(), 1);
        assert_eq!(supervisor.record().pid, None);
        assert_eq!(
            supervisor.state(&fake.ctx).status,
            EventServiceStatus::Starting
        );
        assert_eq!(supervisor.next_wait(start), Duration::from_secs(1));
        // Not before its wait is over.
        fake.unmark("run-argv");
        supervisor.tick(&fake.ctx, start + Duration::from_millis(500));
        assert!(!fake.has("run-argv"));
        // Due: started again, and counted. Now a terminal's owner holds the database, so this one is refused…
        fake.unmark("crash");
        fake.mark("refuse");
        supervisor.tick(&fake.ctx, start + Duration::from_secs(2));
        assert!(supervisor.record().pid.is_some());
        assert_eq!(supervisor.state(&fake.ctx).restarts, 1);
        assert!(supervisor.state(&fake.ctx).last_restart_at.is_some());
        eventually("it is refused", || {
            matches!(supervisor.process(), Process::Exited(ChildExit::Code(78)))
        });
        // …and the one running is adopted: no restart, and no failure (Review Focus 1).
        fake.mark("running");
        supervisor.tick(&fake.ctx, start + Duration::from_secs(3));
        assert!(!supervisor.record().started_by_app);
        assert_eq!(supervisor.record().pid, None);
        assert_eq!(supervisor.record().recent_failures.len(), 1);
        let state = supervisor.state(&fake.ctx);
        assert_eq!(state.status, EventServiceStatus::Running);
        assert_eq!(state.started_by.as_deref(), Some("terminal"));
        assert!(!supervisor.app_service_running());
        fake.unmark("run-argv");
        for later in 4..7 {
            supervisor.tick(&fake.ctx, start + Duration::from_secs(later));
        }
        assert!(!fake.has("run-argv"), "an adopted service is left alone");
        // The terminal's service goes: not restarted, the switch off, and said so (D4).
        fake.unmark("running");
        supervisor.tick(&fake.ctx, start + Duration::from_secs(8));
        assert!(!supervisor.record().wanted);
        let state = supervisor.state(&fake.ctx);
        assert_eq!(state.status, EventServiceStatus::Stopped);
        assert!(state.stopped_from_outside_at.is_some());
        assert!(!fake.has("run-argv"));
        // The switch on again starts the app's own, at once.
        fake.unmark("refuse");
        supervisor.set_wanted(&fake.ctx, true, SystemTime::now());
        assert!(supervisor.record().started_by_app);
        assert!(supervisor.record().recent_failures.is_empty());
        assert_eq!(supervisor.state(&fake.ctx).stopped_from_outside_at, None);
        eventually("it runs", || fake.has("running"));
        supervisor.set_wanted(&fake.ctx, false, SystemTime::now());
        fake.finish(&mut supervisor);
    }

    #[cfg(unix)]
    #[test]
    fn five_quick_deaths_give_up_and_show_the_log_tail_until_try_again() {
        let fake = Fake::new();
        let mut supervisor = fake.supervisor(ServiceRecord::default());
        fake.mark("crash");
        let mut at = SystemTime::now();
        for _ in 0..5 {
            supervisor.tick(&fake.ctx, at);
            eventually("it crashes", || {
                matches!(supervisor.process(), Process::Exited(_))
            });
            supervisor.tick(&fake.ctx, at);
            at += Duration::from_secs(31);
        }
        let state = supervisor.state(&fake.ctx);
        assert_eq!(state.status, EventServiceStatus::GaveUp);
        assert!(state.wanted);
        assert_eq!(state.restarts, 4);
        assert!(state.log_tail.len() <= LOG_TAIL_LINES);
        assert!(state.log_tail.iter().any(|line| line.contains("boom")));
        assert!(state
            .log_tail
            .last()
            .is_some_and(|line| line.ends_with("so Agent Comms stopped restarting it.")));
        // No more tries, an hour later either.
        fake.unmark("run-argv");
        supervisor.tick(&fake.ctx, at + Duration::from_secs(3600));
        assert!(!fake.has("run-argv"));
        // Try again: it starts.
        fake.unmark("crash");
        supervisor.retry(&fake.ctx, SystemTime::now());
        assert!(supervisor.record().recent_failures.is_empty());
        eventually("it runs", || fake.has("running"));
        assert!(supervisor.state(&fake.ctx).log_tail.is_empty());
        supervisor.set_wanted(&fake.ctx, false, SystemTime::now());
        fake.finish(&mut supervisor);
    }

    #[cfg(unix)]
    #[test]
    fn a_recorded_pid_that_is_another_program_is_never_signalled() {
        let fake = Fake::new();
        let mut other = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("sleep started");
        std::thread::sleep(Duration::from_millis(200));
        let now = SystemTime::now();
        let record = ServiceRecord {
            pid: Some(other.id()),
            started_at: Some(iso(now - Duration::from_secs(60))),
            version: Some("0.26.2".into()),
            started_by_app: true,
            first_start_answered: true,
            ..ServiceRecord::default()
        };
        // Switched off: the CLI finds nothing running, and the PID, another program now, is sent nothing.
        let mut off = fake.supervisor(record.clone());
        off.set_wanted(&fake.ctx, false, now);
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            other.try_wait().expect("asked").is_none(),
            "the other program still runs"
        );
        // Watched: the app's service is gone, not adopted, and the other program is still left alone.
        let mut watched = Supervisor::new(record, None, Platform::current());
        fake.mark("crash");
        watched.tick(&fake.ctx, now);
        assert_eq!(watched.record().pid, None);
        assert_eq!(watched.record().recent_failures.len(), 1);
        assert!(watched.restart_due.is_some());
        assert!(other.try_wait().expect("asked").is_none());
        let _ = other.kill();
        let _ = other.wait();
        fake.finish(&mut watched);
        fake.finish(&mut off);
    }

    #[cfg(unix)]
    #[test]
    fn a_marker_newer_than_the_start_for_its_pid_is_a_stop_from_outside() {
        let fake = Fake::new();
        let mut ended = std::process::Command::new("true").spawn().expect("started");
        let pid = ended.id();
        let _ = ended.wait();
        let started = SystemTime::now() - Duration::from_secs(60);
        let record = ServiceRecord {
            pid: Some(pid),
            started_at: Some(iso(started)),
            version: Some("0.26.2".into()),
            started_by_app: true,
            first_start_answered: true,
            ..ServiceRecord::default()
        };
        let events = events_dir(&fake.ctx.folders);
        fs::create_dir_all(&events).expect("events");
        let at = iso(started + Duration::from_secs(30));
        fs::write(
            events.join(MARKER_FILE),
            format!("{{\"version\":1,\"pid\":{pid},\"at\":\"{at}\"}}\n"),
        )
        .expect("a marker");
        let mut supervisor = fake.supervisor(record.clone());
        supervisor.tick(&fake.ctx, SystemTime::now());
        assert!(!supervisor.record().wanted);
        assert_eq!(
            supervisor
                .state(&fake.ctx)
                .stopped_from_outside_at
                .as_deref(),
            Some(at.as_str())
        );
        assert!(!fake.has("run-argv"), "a stop is not restarted");
        fake.finish(&mut supervisor);
        // A marker written just after the PID is seen gone is still read: once more, a moment later (Task 1).
        fs::remove_file(events.join(MARKER_FILE)).expect("removed");
        let late = events.join(MARKER_FILE);
        let text = format!("{{\"version\":1,\"pid\":{pid},\"at\":\"{at}\"}}\n");
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            fs::write(late, text).expect("a marker");
        });
        let mut read_again = fake.supervisor(record.clone());
        read_again.tick(&fake.ctx, SystemTime::now());
        writer.join().expect("written");
        assert!(!read_again.record().wanted, "read again, and stopped");
        assert!(!fake.has("run-argv"));
        fake.finish(&mut read_again);
        // With none, even after that wait, it crashed: restarted after its wait.
        fs::remove_file(events.join(MARKER_FILE)).expect("removed");
        let mut crashed = fake.supervisor(record);
        crashed.tick(&fake.ctx, SystemTime::now());
        assert!(crashed.record().wanted);
        assert_eq!(crashed.record().recent_failures.len(), 1);
        assert!(crashed.restart_due.is_some());
        fake.finish(&mut crashed);
    }

    #[test]
    fn quit_asks_only_while_a_service_the_app_started_runs_and_no_answer_is_kept() {
        assert_eq!(quit_route(false, None), QuitRoute::Quit);
        assert_eq!(quit_route(false, Some(QuitAnswer::Stop)), QuitRoute::Quit);
        assert_eq!(quit_route(false, Some(QuitAnswer::Keep)), QuitRoute::Quit);
        assert_eq!(quit_route(true, None), QuitRoute::Ask);
        assert_eq!(quit_route(true, Some(QuitAnswer::Keep)), QuitRoute::Quit);
        assert_eq!(
            quit_route(true, Some(QuitAnswer::Stop)),
            QuitRoute::StopThenQuit
        );
        // Quit pressed twice: the question is asked once (Review Focus 5).
        let asking = AtomicBool::new(false);
        assert!(first_to_ask(&asking));
        assert!(!first_to_ask(&asking));
        assert!(!first_to_ask(&asking));
    }

    /// A service a terminal started is not the app's to ask about; one the app started is, until it stops.
    #[cfg(unix)]
    #[test]
    fn the_quit_question_is_about_the_apps_own_service_and_stop_it_stops_that_one() {
        let fake = Fake::new();
        let mut supervisor = fake.supervisor(ServiceRecord::default());
        assert!(!supervisor.app_service_running());
        supervisor.tick(&fake.ctx, SystemTime::now());
        eventually("it runs", || fake.has("running"));
        assert!(supervisor.app_service_running());
        supervisor.remember_quit(QuitAnswer::Stop);
        assert_eq!(load_record(&fake.app).quit_answer, Some(QuitAnswer::Stop));
        supervisor.stop_for_quit(&fake.ctx);
        assert!(fake.has("stop-argv"), "through agent-events stop");
        assert!(!fake.has("running"));
        assert!(!supervisor.app_service_running());
        // Stopped by the app, and forgotten: the switch stays on, so the next run starts it again, and the marker of
        // this clean stop is not taken for one from outside.
        let kept = load_record(&fake.app);
        assert!(kept.wanted);
        assert_eq!(kept.pid, None);
        assert_eq!(kept.started_at, None);
        // A terminal's service: nothing of the app's runs, so Quit does not ask.
        fake.mark("running");
        let mut adopted = fake.supervisor(ServiceRecord::default());
        adopted.tick(&fake.ctx, SystemTime::now());
        assert_eq!(
            adopted.state(&fake.ctx).started_by.as_deref(),
            Some("terminal")
        );
        assert!(!adopted.app_service_running());
        fake.unmark("running");
        fake.finish(&mut supervisor);
        fake.finish(&mut adopted);
    }

    #[test]
    fn windows_never_starts_the_service() {
        let windows = RunContext {
            folders: Folders {
                config_dir: r"C:\Users\example\AppData\Roaming\agent-communications".into(),
                state_dir: r"C:\Users\example\AppData\Local\agent-communications\state".into(),
                data_dir: r"C:\Users\example\AppData\Local\agent-communications".into(),
                secrets_dir: r"C:\Users\example\AppData\Local\agent-communications\secrets".into(),
            },
            platform: Platform::Windows,
            node: Some(r"C:\node\node.exe".into()),
        };
        let refused = spawn_service(&windows).expect_err("never on Windows");
        assert_eq!(refused.code, "APP_REFUSED");
        assert_eq!(refused.message, WINDOWS_LINE);
        let mut supervisor = Supervisor::new(ServiceRecord::default(), None, Platform::Windows);
        supervisor.tick(&windows, now());
        assert_eq!(supervisor.record().pid, None);
        let state = supervisor.state(&windows);
        assert_eq!(state, unavailable());
        assert!(!state.available);
        assert_eq!(state.status, EventServiceStatus::Unavailable);
    }
}
