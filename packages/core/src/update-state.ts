import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import { type UpdateCheckSetting, updateCheckSetting } from './config.ts';
import type { Core } from './core.ts';
import { writeFileAtomic } from './fs.ts';
import { type CliHandoffs, type Handoff, handoffSentence, requireHandoffs } from './handoffs.ts';
import { withFileLock } from './lock.ts';
import { isBehind, isPrerelease, isVersion } from './versions.ts';

/**
 * The daily update check, as every server and command reads it (design 2026-09-28): one file per machine,
 * `update-check.json` in the state directory, saying when the registry was last asked, the latest release it named,
 * whether this machine's registrations were behind it, and any "not now" with when it runs out.
 *
 * This is the reader, and it has **no network code at all**: it reads and writes that file, and says what it means.
 * Asking the registry is the checker's (`update-check.ts`), which every server and command but WhatsApp's also
 * imports. WhatsApp's package promises it reaches no network — `packages/whatsapp/test/no-network.test.ts` holds it to
 * that — so it imports only this, and learns of an update once any other server or command on the machine has asked.
 */

/** The file, in the state directory: one per machine, shared by every server and command on it. */
export const UPDATE_CHECK_FILE = 'update-check.json';

/**
 * The switch that turns the whole thing off for one process — no check, no stop — whatever the setting says. Every
 * test harness and every script here that runs a command or a server sets it, so no test and no verify step asks the
 * real registry.
 */
export const UPDATE_CHECK_ENV: 'AGENT_COMMS_UPDATE_CHECK' = 'AGENT_COMMS_UPDATE_CHECK';

/**
 * Set by what starts a server from a release it pins itself — the Claude Code plugin's launcher, the Gemini
 * extension's manifest — to say so: `claude-code-plugin`, `gemini-extension`. No registration here names that server,
 * and `comms_update` never moves it; it changes when the plugin or the extension is updated. So its stop always says
 * "update", whatever the channel's registrations say: restarting would start the release the plugin pins.
 */
export const UPDATE_STARTED_BY_ENV: 'AGENT_COMMS_STARTED_BY' = 'AGENT_COMMS_STARTED_BY';

/** How long a check is good for: the registry is asked at most once in this long, by the whole machine. */
export const UPDATE_CHECK_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

/** What the stop says first, word for word: the owner's words. */
export const UPDATE_FIRST = "Hang on a minute, there's an update. Let's update first.";

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
  /** A person's "not now": nothing stops until this ISO time, the local midnight after they said it. */
  snoozedUntil: string | null;
  /**
   * A check under way: when a process claimed it. Nobody else asks while it is younger than `UPDATE_CHECK_LEASE_MS`.
   * `lastChecked` is written only once the ask is over, so an ask that never finished — a command the person
   * interrupted, a server whose client closed it part-way — does not use up the day: its claim runs out, and the next
   * process asks.
   */
  checking: string | null;
  /**
   * What the last background run left for the next session to say (design 2026-10-16 U5 step 7): a release it
   * installed, which a restart picks up, or one it would not install, and why. Null when it left nothing. Additive:
   * a release that does not know the field ignores it.
   */
  backgroundNotice?: BackgroundNotice | null | undefined;
}

/** A background run's word for the next session: what happened, to which release, and the line to show. */
export interface BackgroundNotice {
  /** When the run left it, as an ISO time. */
  at: string;
  /**
   * `installed`: switched to, and running once each client restarts its servers. `skipped`: a release that waits for
   * the person — a major version, one that needs a decision, a downgrade. `refused`: its provenance did not verify.
   * `failed`: installing or checking it did not work, and nothing was switched. `job-removed`: an organisation turned
   * background updates off, and the job is gone.
   */
  outcome: 'installed' | 'skipped' | 'refused' | 'failed' | 'job-removed';
  /** The release it is about, when it is about one. */
  version: string | null;
  /** The line itself, in words a person reads. */
  text: string;
}

const NOTICE_OUTCOMES: readonly BackgroundNotice['outcome'][] = [
  'installed',
  'skipped',
  'refused',
  'failed',
  'job-removed',
];

function readBackgroundNotice(value: unknown): BackgroundNotice | null {
  if (typeof value !== 'object' || value === null) return null;
  const { at, outcome, version, text } = value as Record<string, unknown>;
  if (!isTime(at) || !NOTICE_OUTCOMES.includes(outcome as BackgroundNotice['outcome']) || typeof text !== 'string') {
    return null;
  }
  return {
    at,
    outcome: outcome as BackgroundNotice['outcome'],
    version: isVersion(version) ? version : null,
    text: text.slice(0, 600),
  };
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
  backgroundNotice: null,
});

export function updateCheckPath(stateDir: string): string {
  return join(stateDir, UPDATE_CHECK_FILE);
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((word) => typeof word === 'string');

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
    backgroundNotice: readBackgroundNotice(held.backgroundNotice),
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
export function updateCheckDue(record: UpdateCheckRecord, now: Date): boolean {
  if (record.lastChecked === null) return true;
  const since = now.getTime() - Date.parse(record.lastChecked);
  return !(since >= -CLOCK_SKEW_MS && since < UPDATE_CHECK_INTERVAL_MS);
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

/** What turned the check off for this process, from its environment: `CI`, or the switch. Null when neither did. */
export function updateCheckSwitchedOff(env: NodeJS.ProcessEnv): 'CI' | typeof UPDATE_CHECK_ENV | null {
  // `CI` as `canPrompt` reads it: set, and not `0` or `false`.
  if (env.CI && env.CI !== '0' && env.CI !== 'false') return 'CI';
  const value = env[UPDATE_CHECK_ENV]?.trim().toLowerCase();
  if (value !== undefined && ['off', '0', 'false', 'no'].includes(value)) return UPDATE_CHECK_ENV;
  return null;
}

/** Whether a check may run at all, and if not, what turned it off: the environment first, then the machine's setting. */
export async function updateCheckEnabled(
  core: Core,
  env: NodeJS.ProcessEnv,
): Promise<{ on: true } | { on: false; by: 'CI' | typeof UPDATE_CHECK_ENV | 'setting' }> {
  const switched = updateCheckSwitchedOff(env);
  if (switched !== null) return { on: false, by: switched };
  return (await machineSetting(core)) === 'off' ? { on: false, by: 'setting' } : { on: true };
}

/**
 * The machine's setting, from `config.json`. A configuration that cannot be read counts as `on`, the default: what is
 * wrong with it is for the doctor and the tools to say, and it must not quietly turn this off.
 */
async function machineSetting(core: Core): Promise<UpdateCheckSetting> {
  try {
    return updateCheckSetting(await core.config.load());
  } catch {
    return 'on';
  }
}

/** The start of the next local day: when a "not now" runs out. */
export function nextLocalMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
}

/** A local time as a person reads it in a preview: `2026-09-29 00:00`. */
export function localStamp(at: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** Whether a person's "not now" still holds. */
export function updateSnoozed(record: UpdateCheckRecord, now: Date): boolean {
  return record.snoozedUntil !== null && now.getTime() < Date.parse(record.snoozedUntil);
}

/**
 * The latest release as the check counts it: a version, and not a prerelease — 0.8.0-rc.1 is never an update anybody
 * is stopped for. Null when the file names none.
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

/** An update that stops a server or a command running `running`. */
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
 * code, and a reply that said to restart would stop every call with advice that cannot work.
 */
export function updateVerdict(record: UpdateCheckRecord, running: string, where: UpdateSurface): PendingUpdate | null {
  const latest = countedLatest(record);
  if (latest === null || !isVersion(running) || !isBehind(running, latest)) return null;
  const installed = where.surface === 'server' ? record.current?.registered : record.current?.global;
  return { kind: installed?.includes(where.channel) === true ? 'restart' : 'update', running, latest };
}

/**
 * The update that stops this process now, from the file as it is — or null: switched off, snoozed, or nothing newer.
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
  if (updateSnoozed(record, (options.now ?? (() => new Date()))())) return null;
  const verdict = updateVerdict(record, options.running, options);
  const startedBy = options.env[UPDATE_STARTED_BY_ENV]?.trim();
  if (verdict?.kind === 'restart' && options.surface === 'server' && startedBy) return { ...verdict, kind: 'update' };
  return verdict;
}

/**
 * The update and "not now" as commands a person runs at a terminal: core's, located from whatever is printing
 * (`core.handoffs`) — a channel finds the core it is installed with — or, for each, why there is none here.
 */
export interface UpdateCommands {
  readonly update: Handoff;
  readonly later: Handoff;
}

export function updateCommands(
  core: { readonly handoffs?: CliHandoffs | undefined },
  platform?: NodeJS.Platform | undefined,
): UpdateCommands {
  const handoffs = requireHandoffs(core, platform);
  return { update: handoffs.core(['update']), later: handoffs.core(['update', '--later']) };
}

/** One of them in a sentence `say` makes: in backticks, or, with no command here, the sentence saying why. */
export function updateCommandSaid(
  commands: UpdateCommands,
  which: 'update' | 'later',
  say: (command: string) => string,
): string {
  return handoffSentence(commands[which], say);
}

/**
 * The two ways on, as a stop's details give them: the tool, and the command — core's own, located, or the sentence
 * saying why there is none here. Written out as text where the details leave the process (`PrintedCommand.toJSON`):
 * its line, or its words as JSON with what to do, or that sentence — as these fields always carried.
 */
export interface UpdateWays {
  readonly update: { readonly tool: 'comms_update'; readonly command: Handoff };
  readonly later: {
    readonly tool: 'comms_update';
    readonly arguments: { readonly later: true };
    readonly command: Handoff;
  };
}

export function updateWaysOf(commands: UpdateCommands): UpdateWays {
  return {
    update: { tool: 'comms_update', command: commands.update },
    later: { tool: 'comms_update', arguments: { later: true }, command: commands.later },
  };
}

/** A channel's product name, from core's snapshot of the manifests: `Gmail`. */
function labelOf(channel: string): string {
  return CHANNEL_SNAPSHOT.find((entry) => entry.manifest.channel === channel)?.manifest.label ?? channel;
}

/**
 * What a stopped tool call says, in words an agent passes on: the owner's sentence first, then the versions, then the
 * two ways on — the update, from chat or a terminal, or "not now", which the person approves like any other change.
 */
export function updateStopMessage(
  pending: PendingUpdate,
  where: { server: string; channel: string; tool: string },
  commands: UpdateCommands,
): string {
  // The server by its product — never its name as a client lists it, which reads as a command to run (CUE-403).
  const server = where.channel === 'core' ? 'the core server' : `the ${labelOf(where.channel)} server`;
  const didNotRun = `Nothing was done: ${where.tool} did not run.`;
  const later = `Not now: call comms_update with \`later: true\` — a change the person approves — and nothing stops again until midnight; the next request after it asks again. ${updateCommandSaid(commands, 'later', (command) => `At a terminal: ${command}.`)}`;
  if (pending.kind === 'restart') {
    return [
      "Hang on a minute, the update is installed, but this server isn't running it yet. Restart the client first.",
      `This is ${server}, ${pending.running}; ${pending.latest} is installed on this machine — every registration of this server names it — and a client starts it only once it is restarted. ${didNotRun}`,
      `Ask the person to restart the MCP client — quit it and open it again — and carry on after. ${later}`,
    ].join('\n');
  }
  return [
    UPDATE_FIRST,
    `This is ${server}, ${pending.running}; the latest release is ${pending.latest}. ${didNotRun}`,
    'Ask the person which they want:',
    `- Update now: call comms_update on the core server. It shows every step and asks before it changes anything; restart the client after. ${updateCommandSaid(commands, 'update', (command) => `At a terminal: ${command}.`)} A server comms_update does not find registered here — a plugin's, an extension's — is updated where it was installed.`,
    `- ${later}`,
  ].join('\n');
}
