//! The event service the app runs (0.27.0 design D2, D4, D5, D6, D8; plan P1–P3, Task 2).
//!
//! The app starts `<data>/launch/events-daemon run` detached, through DA4's launcher and pins, with its output in a
//! capped log, and records what it started in its own settings folder (`event-service.json`). A watchdog asks
//! `agent-events status` every 15 seconds, and a pure decision, `decide`, chooses what to do: start, adopt, restart,
//! say it was stopped from outside, give up, restart on a new version, ask first, or nothing. Every side effect is
//! `apply`'s.

use crate::ipc::AppError;
use crate::launchers::{launcher_path, Product};
use crate::paths::{Folders, Platform};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
}
