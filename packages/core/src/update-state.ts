import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type UpdateLevel, updateLevelOf } from './config.ts';
import type { Core } from './core.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';
import { isBehind, isPrerelease, isVersion } from './versions.ts';

/**
 * The daily update check, as every server and command reads it (design 2026-09-28, and 2026-10-16 for the notice that
 * replaced its stop): one file per machine, `update-check.json` in the state directory, saying when the registry was
 * last asked, the latest release it named, whether this machine's registrations were behind it, any "not now" with when
 * it runs out, and when a command last said so.
 *
 * This is the reader, and it has **no network code at all**: it reads and writes that file, and says what it means.
 * Asking the registry is the checker's (`update-check.ts`), which every server and command but WhatsApp's also
 * imports. WhatsApp's package promises it reaches no network — `packages/whatsapp/test/no-network.test.ts` holds it to
 * that — so it imports only this, and learns of an update once any other server or command on the machine has asked.
 */

/** The file, in the state directory: one per machine, shared by every server and command on it. */
export const UPDATE_CHECK_FILE = 'update-check.json';

/**
 * The switch that turns the whole thing off for one process — no check, no notice — whatever the setting says. Every
 * test harness and every script here that runs a command or a server sets it, so no test and no verify step asks the
 * real registry.
 */
export const UPDATE_CHECK_ENV: 'AGENT_COMMS_UPDATE_CHECK' = 'AGENT_COMMS_UPDATE_CHECK';

/**
 * The level for one process, whatever the machine's (design 2026-10-16, U2): `never` switches it all off as
 * `AGENT_COMMS_UPDATE_CHECK=off` does. Any other word leaves the machine's level as it is.
 */
export const UPDATES_ENV: 'AGENT_COMMS_UPDATES' = 'AGENT_COMMS_UPDATES';

/**
 * Set by what starts a server from a release it pins itself — the Claude Code plugin's launcher, the Gemini
 * extension's manifest — to say so: `claude-code-plugin`, `gemini-extension`. No registration here names that server,
 * and `comms_update` never moves it; it changes when the plugin or the extension is updated. So its notice always says
 * where it is updated, whatever the channel's registrations say: restarting would start the release the plugin pins.
 */
export const UPDATE_STARTED_BY_ENV: 'AGENT_COMMS_STARTED_BY' = 'AGENT_COMMS_STARTED_BY';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a check is good for on `auto`: the registry is asked at most once in this long, by the whole machine. */
export const UPDATE_CHECK_INTERVAL_MS: number = DAY_MS;

/** How long a check, and a notice, is good for on `every-14-days`. */
export const SPACED_INTERVAL_MS: number = 14 * DAY_MS;

/** How long a pause may be, in days (design 2026-10-16, U3): 7 when no length is given. */
export const PAUSE_DAYS: readonly number[] = Object.freeze([1, 7, 14]);
export const DEFAULT_PAUSE_DAYS = 7;
const LONGEST_PAUSE_MS = 14 * DAY_MS;

export interface UpdateCheckRecord {
  /**
   * When the registry was last asked, as an ISO time, written once the ask is over — whether or not it answered. A
   * failed ask counts: a machine that is offline would otherwise ask again on every command, and a command at a
   * terminal waits for it.
   */
  lastChecked: string | null;
  /** The latest release the registry last named: the `latest` dist-tag of `@agentcomms/core`. */
  latest: string | null;
  /**
   * Whether anything on this machine — a registration, a runtime, a global package — was behind `latest` at that
   * check, as `comms_update` with `check` finds it: the machine as a whole. `null` when it is not known — a client's
   * configuration or the global packages could not be read, or a registration pins no release to compare.
   */
  behind: boolean | null;
  /**
   * Where this machine is known to run `latest`, channel by channel, as that check found it: what tells "updated but
   * not restarted" apart from "not updated" (§1). Null when that check found out neither.
   */
  current: UpdateCurrent | null;
  /** Why the last ask got no answer, when it got none. Kept for the doctor; nothing is stopped on its account. */
  lastError: string | null;
  /**
   * 0.18's "not now", which this release no longer reads: a release before 0.20 stops nothing until this ISO time. A
   * pause writes its end here too, so a server of such a release, still running until its client restarts, keeps quiet
   * for the pause as well; `resume` clears it.
   */
  snoozedUntil: string | null;
  /**
   * A check under way: when a process claimed it. Nobody else asks while it is younger than `UPDATE_CHECK_LEASE_MS`.
   * `lastChecked` is written only once the ask is over, so an ask that never finished — a command the person
   * interrupted, a server whose client closed it part-way — does not use up the day: its claim runs out, and the next
   * process asks.
   */
  checking: string | null;
  /**
   * When a command on this machine last printed the update notice (design 2026-10-16, U1): commands say it at most once
   * a day for the whole machine. Additive: a release that does not know it reads the rest of the file as it always did.
   */
  commandNoticeAt: string | null;
  /** When anything on this machine — a server or a command — last gave the notice: what `every-14-days` spaces by. */
  noticeAt: string | null;
  /**
   * A pause (design 2026-10-16, U3): when it was asked, and when it ends. It holds notices — never one of a security
   * fix — until then, and holds only while it ends at most 14 days after it was asked.
   */
  pausedAt: string | null;
  pausedUntil: string | null;
  /**
   * What the latest release's core manifest declares, as the last check read it (`agentcommsRelease`): a security fix,
   * and a release that needs a decision from the person. Null when it was not read. Counts only for `version`.
   */
  release: ReleaseFacts | null;
}

/** What a release's core manifest declares under `agentcommsRelease`, for its version. */
export interface ReleaseFacts {
  version: string;
  security: boolean;
  needsDecision: boolean;
}

/**
 * The channels whose `latest` this machine runs, by the way each is started. Each is a positive finding: a channel
 * the scan could not see, or saw registered with no release pinned, is in neither.
 */
export interface UpdateCurrent {
  /**
   * Every registration of the channel's server pins `latest` — at least one does, none pins an older release or none
   * at all, and every client's configuration was read. A server of one of these that is older was started before it
   * was registered again, and restarting the client starts `latest`.
   */
  registered: string[];
  /** The channel's package is installed globally at `latest`: its command, run again from there, is `latest`. */
  global: string[];
}

export const EMPTY_UPDATE_CHECK: Readonly<UpdateCheckRecord> = Object.freeze({
  lastChecked: null,
  latest: null,
  behind: null,
  current: null,
  lastError: null,
  snoozedUntil: null,
  checking: null,
  commandNoticeAt: null,
  noticeAt: null,
  pausedAt: null,
  pausedUntil: null,
  release: null,
});

export function updateCheckPath(stateDir: string): string {
  return join(stateDir, UPDATE_CHECK_FILE);
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((word) => typeof word === 'string');

function readRelease(value: unknown): ReleaseFacts | null {
  if (typeof value !== 'object' || value === null) return null;
  const { version, security, needsDecision } = value as Record<string, unknown>;
  if (!isVersion(version)) return null;
  return { version, security: security === true, needsDecision: needsDecision === true };
}

function readCurrent(value: unknown): UpdateCurrent | null {
  if (typeof value !== 'object' || value === null) return null;
  const { registered, global } = value as Record<string, unknown>;
  return isWords(registered) && isWords(global) ? { registered: [...registered], global: [...global] } : null;
}

/**
 * The record as the file holds it, each field checked on its own: one that is missing or not what it should be reads
 * as not known. A file that is missing, unreadable or not JSON is an empty record — never a reason to stop anything.
 */
export async function readUpdateCheck(stateDir: string): Promise<UpdateCheckRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(updateCheckPath(stateDir), 'utf8'));
  } catch {
    return { ...EMPTY_UPDATE_CHECK };
  }
  const held = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  return {
    lastChecked: isTime(held.lastChecked) ? held.lastChecked : null,
    latest: isVersion(held.latest) ? held.latest : null,
    behind: typeof held.behind === 'boolean' ? held.behind : null,
    current: readCurrent(held.current),
    lastError: typeof held.lastError === 'string' ? held.lastError.slice(0, 300) : null,
    snoozedUntil: isTime(held.snoozedUntil) ? held.snoozedUntil : null,
    checking: isTime(held.checking) ? held.checking : null,
    commandNoticeAt: isTime(held.commandNoticeAt) ? held.commandNoticeAt : null,
    noticeAt: isTime(held.noticeAt) ? held.noticeAt : null,
    pausedAt: isTime(held.pausedAt) ? held.pausedAt : null,
    pausedUntil: isTime(held.pausedUntil) ? held.pausedUntil : null,
    release: readRelease(held.release),
  };
}

/**
 * Reads the record, changes it and writes it back, under a lock beside it, atomically — so a server recording a check
 * and a person's "not now" arriving at the same moment each keep what the other wrote. Returns what `change` returned
 * alongside the record written; `change` returning `null` writes nothing.
 */
export async function changeUpdateCheck<T = void>(
  stateDir: string,
  change: (record: UpdateCheckRecord) => { record: UpdateCheckRecord; result?: T } | null,
): Promise<{ record: UpdateCheckRecord; result: T | undefined; written: boolean }> {
  return withFileLock(
    join(stateDir, '.update-check.lock'),
    async () => {
      const current = await readUpdateCheck(stateDir);
      const next = change(current);
      if (next === null) return { record: current, result: undefined, written: false };
      await writeFileAtomic(updateCheckPath(stateDir), `${JSON.stringify(next.record, null, 2)}\n`);
      return { record: next.record, result: next.result, written: true };
    },
    { timeoutMs: 2_000 },
  );
}

/**
 * Whether the check is due: never asked, asked a day or more ago, or — a clock that went back — asked more than a few
 * minutes in the future. A few minutes are allowed for, because two processes' clocks are read at slightly different
 * moments, and a check just claimed by one must not look due to the other.
 */
export function updateCheckDue(
  record: UpdateCheckRecord,
  now: Date,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS,
): boolean {
  return !within(record.lastChecked, now, intervalMs);
}

/** Whether `at` is less than `intervalMs` ago — a time from more than a few minutes in the future is not trusted. */
export function within(at: string | null, now: Date, intervalMs: number): boolean {
  if (at === null) return false;
  const since = now.getTime() - Date.parse(at);
  return since >= -CLOCK_SKEW_MS && since < intervalMs;
}

const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * How long a claimed check keeps others from asking: longer than the longest a check takes — the registry's ten
 * seconds, `npm ls`'s minute — so two processes never ask at once, and short enough that one whose process ended
 * part-way holds nobody up for long.
 */
export const UPDATE_CHECK_LEASE_MS: number = 2 * 60 * 1000;

/** Whether another process is asking the registry now: it claimed the check less than a lease ago. */
export function updateCheckUnderway(record: UpdateCheckRecord, now: Date): boolean {
  if (record.checking === null) return false;
  const since = now.getTime() - Date.parse(record.checking);
  return since >= -CLOCK_SKEW_MS && since < UPDATE_CHECK_LEASE_MS;
}

/** What turned updates off for this process, from its environment: `CI`, or a switch. Null when nothing did. */
export function updateCheckSwitchedOff(
  env: NodeJS.ProcessEnv,
): 'CI' | typeof UPDATE_CHECK_ENV | typeof UPDATES_ENV | null {
  // `CI` as `canPrompt` reads it: set, and not `0` or `false`.
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return 'CI';
  const value = env[UPDATE_CHECK_ENV]?.trim().toLowerCase();
  if (value !== undefined && ['off', '0', 'false', 'no'].includes(value)) return UPDATE_CHECK_ENV;
  if (env[UPDATES_ENV]?.trim().toLowerCase() === 'never') return UPDATES_ENV;
  return null;
}

/** How this machine updates for this process, and why (design 2026-10-16, U2). */
export interface EffectiveUpdates {
  /** The level in force: the machine's, unless the environment switched it all off. */
  level: UpdateLevel;
  /** The level the configuration sets. */
  set: UpdateLevel;
  /** What decided `level`: the configuration, or the environment. */
  by: 'setting' | 'CI' | typeof UPDATE_CHECK_ENV | typeof UPDATES_ENV;
  /**
   * Whether the background job installs updates: `auto`, and the job set up (`updateJobInstalled`). Until then `auto`
   * behaves as a daily check with a notice (U2).
   */
  background: boolean;
}

/**
 * The level in force here, read from the environment first and then the configuration. A configuration that cannot be
 * read counts as `auto`, the default: what is wrong with it is for the doctor and the tools to say, and it must not
 * quietly turn updates off.
 */
export async function effectiveUpdates(core: Core, env: NodeJS.ProcessEnv): Promise<EffectiveUpdates> {
  let set: UpdateLevel = 'auto';
  try {
    set = updateLevelOf(await core.config.load());
  } catch {
    // The default, as above.
  }
  const switched = updateCheckSwitchedOff(env);
  if (switched !== null) return { level: 'never', set, by: switched, background: false };
  const background = set === 'auto' && (await updateJobInstalled(core));
  return { level: set, set, by: 'setting', background };
}

/** Whether a check may run at all, how often, and if not, what turned it off: the environment, then the level. */
export async function updateCheckEnabled(
  core: Core,
  env: NodeJS.ProcessEnv,
): Promise<
  { on: true; intervalMs: number } | { on: false; by: 'CI' | typeof UPDATE_CHECK_ENV | typeof UPDATES_ENV | 'setting' }
> {
  const updates = await effectiveUpdates(core, env);
  if (updates.level === 'never') return { on: false, by: updates.by };
  return { on: true, intervalMs: updates.level === 'every-14-days' ? SPACED_INTERVAL_MS : UPDATE_CHECK_INTERVAL_MS };
}

/**
 * The marker the background job's installer writes (design 2026-10-16, U4), in the state directory:
 * `<state>/update-job.json`. Track C writes it when the person's yes has set the job up, and removes it with the job;
 * until then `auto` is a daily check with a notice.
 */
export const UPDATE_JOB_MARKER = 'update-job.json';

/** Whether the background update job is set up on this machine: its marker is a file in the state directory. */
export async function updateJobInstalled(core: Pick<Core, 'paths'>): Promise<boolean> {
  try {
    return (await stat(join(core.paths.stateDir, UPDATE_JOB_MARKER))).isFile();
  } catch {
    return false;
  }
}

/**
 * When a pause ends, while one holds at `now` — or null. A pause holds from when it was asked until its end, and only
 * while that end is at most 14 days after it was asked: a clock gone back to before it was asked, or an end written by
 * hand further off, holds nothing, so no pause ever lasts longer than 14 days from when it was asked.
 */
export function pauseEnd(record: UpdateCheckRecord, now: Date): Date | null {
  if (record.pausedAt === null || record.pausedUntil === null) return null;
  const asked = Date.parse(record.pausedAt);
  const ends = Date.parse(record.pausedUntil);
  if (ends - asked > LONGEST_PAUSE_MS + CLOCK_SKEW_MS) return null;
  if (now.getTime() < asked - CLOCK_SKEW_MS || now.getTime() >= ends) return null;
  return new Date(ends);
}

/**
 * The security fix this record says is out, for a process running `running`: the latest release, when its manifest
 * declares one and `running` is behind it. Null otherwise.
 */
export function securityRelease(record: UpdateCheckRecord, running: string): string | null {
  const latest = countedLatest(record);
  if (latest === null || record.release?.version !== latest || !record.release.security) return null;
  return isVersion(running) && isBehind(running, latest) ? latest : null;
}

/** A local time as a person reads it in a preview: `2026-09-29 00:00`. */
export function localStamp(at: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/**
 * The latest release as the check counts it: a version, and not a prerelease — 0.8.0-rc.1 is never an update anybody
 * is told of. Null when the file names none.
 */
export function countedLatest(record: UpdateCheckRecord): string | null {
  return record.latest !== null && isVersion(record.latest) && !isPrerelease(record.latest) ? record.latest : null;
}

/** What a process is, for the verdict: a channel's server, which a client starts, or its command, which a person runs. */
export interface UpdateSurface {
  /** Whose server or command it is: `core`, `gmail`, `whatsapp`. */
  channel: string;
  /** `server`: an MCP server, started from its registrations. `command`: a CLI, started from wherever it is installed. */
  surface: 'server' | 'command';
}

/** An update a server or a command running `running` is behind: what its notice says. */
export interface PendingUpdate {
  /**
   * `update`: a newer release is out, and this process is not known to have it anywhere to restart into. `restart`:
   * the check found it installed where this process starts from — every registration of this server, or this
   * command's global package, is at `latest` — and this process simply started before it was.
   */
  kind: 'update' | 'restart';
  running: string;
  latest: string;
}

/**
 * What the record means for a process running `running`, ignoring any "not now": null when there is nothing newer.
 *
 * `restart` only on the check's positive finding about this very server or command (`current`): a server whose every
 * registration names `latest`, or a command whose package is installed globally at `latest`. Anything else — no
 * registration the scan could see (a plugin's, an extension's, one written by hand), one that pins no release, a
 * configuration it could not read, a check that found out nothing — is `update`: restarting would start the same old
 * code, and a notice that said to restart would give advice that cannot work.
 */
export function updateVerdict(record: UpdateCheckRecord, running: string, where: UpdateSurface): PendingUpdate | null {
  const latest = countedLatest(record);
  if (latest === null || !isVersion(running) || !isBehind(running, latest)) return null;
  const installed = where.surface === 'server' ? record.current?.registered : record.current?.global;
  return { kind: installed?.includes(where.channel) === true ? 'restart' : 'update', running, latest };
}

/**
 * The update this process is behind now, from the file as it is — or null: switched off, `never`, or nothing newer.
 * What a notice makes of it — a pause, the level's spacing, a security fix — is the notice's (`update-gate.ts`).
 * Reads two files and asks nobody.
 *
 * "Restart" is decided per channel, from its registrations, and a server a plugin or an extension started is not one
 * of them (`UPDATE_STARTED_BY_ENV`): beside a registration the update moved, it was told to restart every day, and
 * restarting started the release the plugin pins. It is told to update.
 */
export async function pendingUpdate(
  options: UpdateSurface & {
    core: Core;
    env: NodeJS.ProcessEnv;
    running: string;
    now?: (() => Date) | undefined;
  },
): Promise<PendingUpdate | null> {
  if (!(await updateCheckEnabled(options.core, options.env)).on) return null;
  const record = await readUpdateCheck(options.core.paths.stateDir);
  const verdict = updateVerdict(record, options.running, options);
  const startedBy = options.env[UPDATE_STARTED_BY_ENV]?.trim();
  if (verdict?.kind === 'restart' && options.surface === 'server' && startedBy) return { ...verdict, kind: 'update' };
  return verdict;
}
