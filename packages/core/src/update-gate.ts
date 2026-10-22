import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { CHANNEL_SNAPSHOT } from './channels.generated.ts';
import type { OutputOptions, Streams } from './cli-runtime.ts';
import type { Core } from './core.ts';
import { handoffSentence, requireHandoffs } from './handoffs.ts';
import { LAUNCHER_ENV, launcherName, launcherPaths, readPointer } from './launcher.ts';
import { updateJobSupported } from './update-job.ts';
import {
  type BackgroundNotice,
  changeUpdateCheck,
  type EffectiveUpdates,
  effectiveUpdates,
  localStamp,
  type PendingUpdate,
  pauseEnd,
  readUpdateCheck,
  SPACED_INTERVAL_MS,
  securityRelease,
  UPDATE_NOTICE_LOCK,
  UPDATE_STARTED_BY_ENV,
  type UpdateCheckRecord,
  type UpdateSurface,
  updateCheckDue,
  updateCheckEnabled,
  updateCheckSwitchedOff,
  updateVerdict,
  within,
  withSecurityShown,
} from './update-state.ts';
import { backgroundNoticeLine } from './update-words.ts';
import { isBehind, isPlainVersion, isVersion } from './versions.ts';

/**
 * The update notice, where every server and every command meets it (design 2026-10-16, U1). It replaces the stop of
 * the daily update check (design 2026-09-28): nothing is refused for being behind any more. A server's first tool
 * result of its process carries one line beside the result; a command prints the same line once on stderr, at most
 * once a day for the machine, and runs.
 *
 * Reader only, like `update-state.ts`: what asks the registry is handed in — `refresh` to a server's notice, `check` to
 * a command's — by every package but WhatsApp, which has no network code and hands in nothing.
 */

/** The product, as a notice names it: never a command's name, which a sentence would read as one to run (CUE-403). */
const PRODUCT = 'agent-communications';

// ── A server: its first tool result ───────────────────────────────────────────────────────────────────────────

/**
 * What `strictToolArguments` asks once a tool has answered: the one line to carry beside that result, or null. It is
 * asked of every call, and answers a line at most once in the life of the process.
 */
export type ToolNotice = (tool: string, args?: unknown) => Promise<string | null>;

export interface UpdateToolNoticeOptions {
  core: Core;
  env: NodeJS.ProcessEnv;
  /** Its channel, `gmail`, `core`: whose registrations say whether restarting the client would start `latest`. */
  channel: string;
  /** The version this server is. */
  running: string;
  /**
   * Tools whose results never carry the notice, and do not use it up: the update's own, and the doctor — each says
   * what is behind already, in its own words.
   */
  exempt: readonly string[];
  /**
   * Calls that only read where updates stand, and so neither carry the notice nor start the check: `comms_update` with
   * `status: true`, which the desktop app polls every 15 seconds and which promises to ask npm nothing (desktop design
   * DA13). Given the tool's name and its arguments, as its schema took them.
   */
  quiet?: ((tool: string, args: unknown) => boolean) | undefined;
  /**
   * The check, run in the background — never awaited by a call — whenever a call arrives and none is running. Absent
   * for WhatsApp, which reads the file as whatever else on the machine last left it.
   */
  refresh?: (() => Promise<unknown>) | undefined;
  now?: (() => Date) | undefined;
}

/**
 * A server's notice. After a tool answers: if a newer release is out, the machine's level says so (`decideNotice`),
 * and the tool is not exempt, the result carries one line, and no later result of this process carries it again.
 * Nothing is ever refused, and nothing waits for the check: the file is read as it is.
 *
 * At most once per process, on the first result there is something to say on: a server started on a day the check is
 * due learns of the release a moment after its first call, and says so on the next.
 */
export function updateToolNotice(options: UpdateToolNoticeOptions): ToolNotice {
  const exempt = new Set(options.exempt);
  let running: Promise<unknown> | null = null;
  let given = false;
  // One decision at a time, so two calls answered together cannot both carry the line.
  let turn: Promise<unknown> = Promise.resolve();
  return (tool, args) => {
    // Switched off by the environment: nothing — no check, no notice.
    if (updateCheckSwitchedOff(options.env) !== null) return Promise.resolve(null);
    // A read of where updates stand starts no check of its own, however due one is.
    if (options.quiet?.(tool, args)) return Promise.resolve(null);
    if (options.refresh && running === null) {
      running = options
        .refresh()
        .catch(() => undefined)
        .finally(() => {
          running = null;
        });
    }
    if (given || exempt.has(tool)) return Promise.resolve(null);
    const decided = turn.then(async () => {
      if (given) return null;
      const decision = await decideNotice(options, { channel: options.channel, surface: 'server' });
      if (decision === null) return null;
      given = true;
      return serverDecisionLine(decision, options.env);
    });
    turn = decided.catch(() => null);
    return decided.catch(() => null);
  };
}

/** What a notice says: the update this process is behind, and what is particular about it. */
export interface Notice extends PendingUpdate {
  /** The release fixes a security problem (U7): said at once, whatever the pause or the 14-day spacing. */
  security: boolean;
  /** A major release, which never installs on its own. */
  major: boolean;
  /** The release's manifest declares it needs a decision from the person. */
  needsDecision: boolean;
  /** When the pause in force ends: only a security fix is said during one. */
  pausedUntil: Date | null;
}

/** How long a command's notice is good for, by level: a day, or 14 days on `every-14-days`. */
function spacingOf(updates: EffectiveUpdates, surface: UpdateSurface['surface']): number | null {
  if (updates.level === 'every-14-days') return SPACED_INTERVAL_MS;
  return surface === 'command' ? COMMAND_NOTICE_INTERVAL_MS : null;
}

const majorOf = (version: string): number => Number(version.split('.')[0]);

/**
 * Everything one notice line says, decided together (design 2026-10-16, U1, U2, U4, U5 step 7, U6): the release this
 * process is behind (`notice`), what the last background run left for the next session (`background`), how many
 * registrations still name a versioned runtime for the one approved update to move (`moves`), and whether to offer the
 * background job (`offerJob`).
 */
export interface NoticeDecision {
  notice: Notice | null;
  background: BackgroundNotice | null;
  /** Registrations the next approved update moves onto the stable launcher: said with the notice, or alone. */
  moves: number;
  /**
   * The background job set up here that has not run in 48 hours: since when (`EffectiveUpdates.jobSilent`). Said with
   * the notice, or alone, spaced as the notice is; null, or absent, when the job works or there is none.
   */
  jobSilent?: string | null | undefined;
  /** `auto` with no background job, one that could be set up here: the notice offers it, naming its approval. */
  offerJob: boolean;
}

/**
 * What the record means for this process's notice now — or null, with nothing written — decided and recorded under the
 * file's lock, so two processes deciding together say it once where the level says once (design 2026-10-16, U2, U3,
 * U7):
 *
 * - switched off for the process — `CI`, `AGENT_COMMS_UPDATE_CHECK=off`, `AGENT_COMMS_UPDATES=never` — nothing;
 * - a security fix (the latest release's manifest says so) is said on `every-14-days`, on `never`, and on `auto` while
 *   its background job is not set up, whatever the pause or the 14-day spacing: the job installs one within a day;
 * - otherwise nothing on `never`, nothing during a pause, and on `auto` with its job set up only what needs the person:
 *   a restart, a major release, a release needing a decision;
 * - `every-14-days` says it at most once in 14 days for the machine, and a command at most once a day.
 *
 * Beside it, by the same rules of level and pause: what the last background run left (U5 step 7), said by the first
 * process it applies to and then cleared from the file — "installed" applies only to a process behind what was
 * installed — and the registrations still naming a versioned runtime (U6), spaced as the notice is.
 */
async function decideNotice(
  options: { core: Core; env: NodeJS.ProcessEnv; running: string; now?: (() => Date) | undefined },
  where: UpdateSurface,
): Promise<NoticeDecision | null> {
  if (updateCheckSwitchedOff(options.env) !== null) return null;
  const now = options.now ?? (() => new Date());
  const updates = await effectiveUpdates(options.core, options.env, now());
  const startedBy = options.env[UPDATE_STARTED_BY_ENV]?.trim();
  const offerJob = updates.level === 'auto' && !updates.background && (await jobCanBeSetUp(options.core, updates));
  const spacing = spacingOf(updates, where.surface);
  const reach = updates.background ? await jobReach(options.core, options.env, where.channel) : null;
  /** What the level and the spacing let this process say now, or null: decided once as read, then under the lock. */
  const due = (record: UpdateCheckRecord, at: Date): NoticeDecision | null => {
    let notice = noticeOf(record, options.running, where, updates, at, reach);
    const last =
      where.surface === 'command' && updates.level !== 'every-14-days' ? record.commandNoticeAt : record.noticeAt;
    const spaced = spacing !== null && within(last, at, spacing);
    if (notice !== null) {
      if (!notice.security) {
        if (spaced) notice = null;
      } else if (where.surface === 'command' && within(record.commandNoticeAt, at, COMMAND_NOTICE_INTERVAL_MS)) {
        // A security fix is said whatever the spacing, and still at most once a day by a command: the line on every
        // command would be the stop's noise again.
        notice = null;
      }
    }
    const quiet = updates.level === 'never' || pauseEnd(record, at) !== null;
    const background = quiet ? null : backgroundFor(record.backgroundNotice, options.running);
    const moves = quiet || spaced ? 0 : (record.moves ?? 0);
    const jobSilent = quiet || spaced ? null : (updates.jobSilent?.since ?? null);
    if (notice === null && background === null && moves === 0 && jobSilent === null) return null;
    return { notice, background, moves, jobSilent, offerJob: offerJob && (notice !== null || jobSilent !== null) };
  };
  // Most calls have nothing to say: they read the file and take no lock, so a server's calls never queue behind one.
  if (due(await readUpdateCheck(options.core.paths.stateDir), now()) === null) return null;
  const decide = (record: UpdateCheckRecord): { record: UpdateCheckRecord; result: NoticeDecision } | null => {
    const at = now();
    const decision = due(record, at);
    if (decision === null) return null;
    const stamp = at.toISOString();
    // A line about this machine's updates spaces the next one; a background run's word alone is an event, said once.
    const spaces = decision.notice !== null || decision.moves > 0 || (decision.jobSilent ?? null) !== null;
    const written: UpdateCheckRecord = {
      ...record,
      ...(spaces ? { noticeAt: stamp } : {}),
      ...(spaces && where.surface === 'command' ? { commandNoticeAt: stamp } : {}),
      // Said once, then cleared: the run's next word replaces it, and nobody is told the same thing twice.
      ...(decision.background !== null ? { backgroundNotice: null } : {}),
    };
    const { notice } = decision;
    // A server plugin or extension started is updated there, and restarting starts the release it pins: never "restart".
    const kind = notice?.kind === 'restart' && where.surface === 'server' && startedBy ? 'update' : notice?.kind;
    return {
      record: written,
      result: { ...decision, notice: notice === null || kind === undefined ? null : { ...notice, kind } },
    };
  };
  // The rest wait 2 s at most for the lock (`UPDATE_NOTICE_LOCK`), and never longer: busy past that, it throws, nothing
  // is decided or written, and both callers say nothing this time (`updateToolNotice`, `updateNoticeAtTerminal`). The
  // notice stays due, so a later call decides it.
  const decided = await changeUpdateCheck(options.core.paths.stateDir, decide, UPDATE_NOTICE_LOCK);
  return decided.result ?? null;
}

/**
 * What a background run left, when it is this process's to say: an install only to a process running a release before
 * it — one already running it has nothing to restart into — and anything else, a refusal, a skip, a removed job, to
 * any process.
 */
function backgroundFor(left: BackgroundNotice | null | undefined, running: string): BackgroundNotice | null {
  if (left === null || left === undefined) return null;
  if (left.outcome !== 'installed') return left;
  return left.version !== null && isVersion(running) && isBehind(running, left.version) ? left : null;
}

/**
 * Whether the background job could be set up here, so offering it is not offering a refusal (design 2026-10-16 U4):
 * a platform it is written for, no organisation turning background updates off, and the stable core launcher it runs.
 */
async function jobCanBeSetUp(core: Core, updates: EffectiveUpdates): Promise<boolean> {
  if (updates.backgroundOff !== undefined || !updateJobSupported(process.platform)) return false;
  try {
    return (await stat(launcherPaths(core.paths.dataDir, 'core').launcher)).isFile();
  } catch {
    return false;
  }
}

/**
 * What the background job does for this process (re-review of 0.20.0, severity 6): null when it never updates it —
 * a server registered with `--launcher npx`, a versioned or local registration, a command from a global install, npx's
 * cache or a checkout — and otherwise the release its launcher starts now (`pointed`, a plain version, or null when it
 * names none). A process reaches it only when its package's stable launcher, whose pointer the job switches, started
 * it in this data directory (`LAUNCHER_ENV`).
 */
export interface JobReach {
  pointed: string | null;
}

/** Whether the job reaches a process of `name`'s launcher (`JobReach`); null where it does not, or it cannot be read. */
export async function jobReach(core: Core, env: NodeJS.ProcessEnv, name: string | undefined): Promise<JobReach | null> {
  const launched = env[LAUNCHER_ENV]?.trim();
  if (name === undefined || launched !== name) return null;
  try {
    const pointer = await readPointer(core.paths.dataDir, name);
    if (pointer === undefined) return null;
    const folder = basename(pointer.current);
    const version = folder.endsWith(`-${name}`) ? folder.slice(0, -(name.length + 1)) : '';
    return { pointed: isPlainVersion(version) ? version : null };
  } catch {
    return null;
  }
}

/**
 * Whether the job covers a security fix for this process: it reaches it (`jobReach`), it installs the fix on its own —
 * not a new major, nor one needing a decision, which it leaves for the person — and its launcher does not start the
 * fix yet, so the job installs it within a day. Once it does, the process still runs the release before: it is told.
 */
function coveredByJob(reach: JobReach | null, fix: string, record: UpdateCheckRecord, running: string): boolean {
  if (reach === null) return false;
  const from = reach.pointed ?? running;
  if (!isVersion(from) || majorOf(fix) > majorOf(from) || record.release?.needsDecision === true) return false;
  return !(reach.pointed !== null && !isBehind(reach.pointed, fix));
}

/** The launcher of the package `core` was opened for: the process's own, or undefined when it is none of ours. */
function ownLauncher(core: Core): string | undefined {
  const packageName = core.handoffs?.caller.packageName;
  if (packageName === undefined) return undefined;
  try {
    return launcherName(packageName);
  } catch {
    return undefined;
  }
}

/** The notice the record makes for this process, before any spacing: see `decideNotice`. */
function noticeOf(
  record: UpdateCheckRecord,
  running: string,
  where: UpdateSurface,
  updates: EffectiveUpdates,
  at: Date,
  reach: JobReach | null,
): Notice | null {
  const pending = updateVerdict(record, running, where);
  if (pending === null) return null;
  // The job's work counts only for a process it reaches: any other is told as on a machine with no job.
  const background = updates.background && reach !== null;
  const fix = securityRelease(record, running);
  const security = fix !== null && !(background && coveredByJob(reach, fix, record, running));
  const pausedUntil = pauseEnd(record, at);
  const facts = record.release?.version === pending.latest ? record.release : null;
  // What waits for the person is said only where anything installs without them: on `auto` with its job, every
  // other release installs on its own; on every other level, every release waits for them anyway.
  const notice: Notice = {
    ...pending,
    security,
    major: background && isVersion(running) && majorOf(pending.latest) > majorOf(running),
    needsDecision: background && facts?.needsDecision === true,
    pausedUntil,
  };
  if (security) return notice;
  if (updates.level === 'never' || pausedUntil !== null) return null;
  if (background && pending.kind !== 'restart' && !notice.major && !notice.needsDecision) return null;
  return notice;
}

/** Who started a server from a release it pins itself, in words: the plugin's, the extension's. */
function startedByWords(startedBy: string): string {
  if (startedBy === 'claude-code-plugin') return 'the Claude Code plugin';
  if (startedBy === 'gemini-extension') return 'the Gemini extension';
  return 'a plugin or an extension';
}

/**
 * The server's line. "Installed" only on the check's positive finding that restarting starts `latest`; a server a
 * plugin or an extension started is updated where it was installed, which `comms_update` never moves.
 */
export function serverNoticeLine(notice: PendingUpdate & Partial<Notice>, env: NodeJS.ProcessEnv = {}): string {
  const paused = pausedWords(notice);
  if (notice.kind === 'restart') {
    return `${PRODUCT} ${notice.latest} is installed; restart the client (in Claude Code, /mcp → Reconnect) to use it.${paused}`;
  }
  const startedBy = env[UPDATE_STARTED_BY_ENV]?.trim();
  if (startedBy) {
    return `${PRODUCT} ${notice.latest} is out${whatItIs(notice)}; this server came with ${startedByWords(startedBy)}, and is updated there ${notice.security ? 'soon' : 'when it suits you'}.${paused}`;
  }
  return `${PRODUCT} ${notice.latest} is out${whatItIs(notice)}; say "update" ${notice.security ? 'soon' : 'when it suits you'}.${paused}`;
}

/**
 * The line for a background job that has not run in 48 hours (U4, U7): as though there were none, every notice and the
 * security line are said again, and this says why, and where to look.
 */
export function jobSilentLine(since: string): string {
  const at = new Date(since);
  const day = Number.isFinite(at.getTime()) ? localStamp(at).slice(0, 10) : 'it was set up';
  return `${PRODUCT}: background updates have not run since ${day}; check Login Items (macOS) or run doctor.`;
}

/** How many registrations, in words: "one registration", "2 registrations". */
const registrations = (count: number): string => (count === 1 ? 'one registration' : `${count} registrations`);

/**
 * A server's one line, from everything `decideNotice` decided: the background run's word first, then the release this
 * server is behind — unless the run's word is about that same release — then the move to the stable launcher, and the
 * offer of the background job.
 */
export function serverDecisionLine(decision: NoticeDecision, env: NodeJS.ProcessEnv = {}): string {
  const { notice, background, moves } = decision;
  const parts: string[] = [];
  // The run's word in fixed sentences only: never the state file's text as it is (`update-words.ts`).
  if (background !== null) parts.push(backgroundNoticeLine(background));
  if (notice !== null && !(background !== null && background.version === notice.latest)) {
    parts.push(serverNoticeLine(notice, env));
  }
  if (decision.jobSilent) parts.push(jobSilentLine(decision.jobSilent));
  if (moves > 0) {
    parts.push(
      notice !== null
        ? `The update also moves ${registrations(moves)} onto the stable launcher, the last update that edits a client's configuration.`
        : `${PRODUCT}: ${moves === 1 ? 'one registration still starts' : `${moves} registrations still start`} a versioned runtime; one approved update (say "update") moves ${moves === 1 ? 'it' : 'them'} onto the stable launcher, after which updates never edit a client's configuration again.`,
    );
  }
  if (decision.offerJob) {
    parts.push(
      'To have releases install in the background instead, comms_update with backgroundJob "on" sets up a daily job: its preview shows the job, when it runs and how to remove it, and sets nothing up without your yes.',
    );
  }
  return parts.join(' ');
}

/** What is particular about the release, after "is out": a security fix, a major release, a decision it needs. */
function whatItIs(notice: Partial<Notice>): string {
  if (notice.security) return ', and fixes a security problem';
  if (notice.major) return ', a major release, which waits for you';
  if (notice.needsDecision) return ', and needs a decision from you before it installs';
  return '';
}

/** Every notice during a pause says when it ends (U3): only a security fix is said then. */
function pausedWords(notice: Partial<Notice>): string {
  if (!notice.pausedUntil) return '';
  return ` Updates are paused until ${localStamp(notice.pausedUntil)}; a security fix is not held.`;
}

// ── The security line, in a send or post preview ────────────────────────────────────────────────────────────

/**
 * The line a send or post preview opens with when a security fix is out and this machine does not install it on its
 * own (design 2026-10-16, U7): `A security fix is out (0.20.1): update first, or approve to send anyway` — or null.
 *
 * Every channel's send and post prepare calls this, once it has prepared the approval, and names it (`approvalId`). On
 * `every-14-days`, on `never`, and on `auto` while its background job is not set up or does not run, a release whose
 * manifest declares a security fix — one this process is behind — is asked about in every preview until the person
 * answers: the approval it was shown on is recorded, under the file's lock, and the person's yes to it — approved, or
 * sent (`securityAnswered`, which the approval store calls) — is the answer. A preview prepared and never answered,
 * set aside, run out or refused, answers nothing, so the next one asks again. The line is display only, never in what
 * an approval binds. A pause never holds it. Nothing at all where the environment switched updates off, and it never
 * throws: a preview is never refused on its account.
 */
export async function securityNotice(options: {
  core: Core;
  env: NodeJS.ProcessEnv;
  /** The version the preparing process is. */
  running: string;
  /** What the person approves: `send` for mail, `post` for a channel message. */
  act?: string | undefined;
  /** The approval the preview is for: the person's yes to it answers the line. Left out, nothing answers it. */
  approvalId?: string | undefined;
  /** The preparing process's channel, whose launcher the job may switch; left out, the package core was opened for. */
  channel?: string | undefined;
}): Promise<string | null> {
  try {
    if (updateCheckSwitchedOff(options.env) !== null) return null;
    const updates = await effectiveUpdates(options.core, options.env);
    // The background job installs a security fix within a day: nothing to ask (U7) — but only of a process it
    // reaches, and only until its launcher starts the fix (re-review of 0.20.0, severity 6).
    const reach = updates.background
      ? await jobReach(options.core, options.env, options.channel ?? ownLauncher(options.core))
      : null;
    const asked = (record: UpdateCheckRecord): string | null => {
      const version = securityRelease(record, options.running);
      if (version === null || coveredByJob(reach, version, record, options.running)) return null;
      return record.securityAsked === version ? null : version;
    };
    // Nothing to ask, as nearly always: read, and no lock taken.
    const version = asked(await readUpdateCheck(options.core.paths.stateDir));
    if (version === null) return null;
    const { approvalId } = options;
    let shown = version;
    if (approvalId !== undefined) {
      // A notice's bound: busy past 2 s, this preview goes without the line, and the next one carries it.
      const decided = await changeUpdateCheck<string>(
        options.core.paths.stateDir,
        (record) => {
          const now = asked(record);
          return now === null ? null : { record: withSecurityShown(record, now, approvalId), result: now };
        },
        UPDATE_NOTICE_LOCK,
      );
      if (decided.result === undefined) return null;
      shown = decided.result;
    }
    return `A security fix is out (${shown}): update first, or approve to ${options.act ?? 'send'} anyway`;
  } catch {
    return null;
  }
}

// ── A command at a terminal ──────────────────────────────────────────────────────────────────────────────────────

/** The commands that never print the notice, by their first word; `mcp` alone runs a server, which has its own. */
const EXEMPT_COMMANDS: readonly string[] = Object.freeze(['update', 'doctor', 'paths', 'approve', 'approvals', 'help']);

/**
 * Whether a command is left alone by the update notice: `update` in every form, `doctor`, `paths`, `approve`,
 * `approvals`, help, and `mcp` alone — the server, which gives its own notice. `mcp install` and `mcp prune` are not.
 * `also` adds a channel's own — WhatsApp's `status`, its doctor. `--help` and `--version` never reach a command.
 */
export function exemptFromUpdateNotice(path: readonly string[], also: readonly string[] = []): boolean {
  const [first] = path;
  if (first === undefined) return true;
  if (EXEMPT_COMMANDS.includes(first) || also.includes(first)) return true;
  return first === 'mcp' && path.length === 1;
}

/** The shape of a Commander command this needs: its name, and the command it is under (null for the program). */
export interface CommandLike {
  name(): string;
  readonly parent: CommandLike | null;
}

/** A Commander command's path below the program, `['mcp', 'install']`: what `exemptFromUpdateNotice` reads. */
export function commandPathOf(command: CommandLike): string[] {
  const path: string[] = [];
  for (let at: CommandLike | null = command; at?.parent; at = at.parent) path.unshift(at.name());
  return path;
}

/** What asks the registry for a command: handed in by every CLI but WhatsApp's — see `terminalUpdateHooks`. */
export interface TerminalUpdateHooks {
  /**
   * The check, when the file is due. It never throws, and it is never cut short: the notice stops waiting for it after
   * about three seconds, and it carries on beside the command — in a detached child of its own, which holds none of the
   * command's output, so the command's process ends when the command does (#48).
   */
  check?: (() => Promise<void>) | undefined;
}

export interface TerminalNoticeOptions extends TerminalUpdateHooks {
  core: Core;
  env: NodeJS.ProcessEnv;
  /** Its channel, `gmail`, `core`: whose global package says whether running the command again would run `latest`. */
  channel: string;
  /** The version this command is. */
  running: string;
  output: OutputOptions;
  streams: Streams;
  now?: (() => Date) | undefined;
  /** How long the command waits for the check before it goes on without it. About three seconds. */
  waitMs?: number | undefined;
}

export const TERMINAL_CHECK_WAIT_MS = 3_000;

/** How often a command says it, for the whole machine: once a day. */
export const COMMAND_NOTICE_INTERVAL_MS: number = 24 * 60 * 60 * 1000;

/**
 * The update notice at a terminal, before a command runs. It never stops the command, and never throws.
 *
 * It reads the file first. If the check is due for the machine's level it asks the registry — through `check` — waiting
 * at most about three seconds and going on without it after that. Then, when the level says so (`decideNotice`), it
 * prints one line on stderr — never on stdout, where a result or `--json` is — and the command runs.
 */
export async function updateNoticeAtTerminal(options: TerminalNoticeOptions): Promise<void> {
  const { core, env, streams } = options;
  const now = options.now ?? (() => new Date());
  try {
    if (updateCheckSwitchedOff(env) !== null) return;
    const enabled = await updateCheckEnabled(core, env);
    if (
      enabled.on &&
      options.check &&
      updateCheckDue(await readUpdateCheck(core.paths.stateDir), now(), enabled.intervalMs)
    ) {
      // Stops waiting, and goes on: the check itself is not cut short, and finishes beside the command. A timer that
      // keeps the process alive, so the wait is the wait, whatever the check is waiting on.
      let timer: NodeJS.Timeout | undefined;
      const gaveUp = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.waitMs ?? TERMINAL_CHECK_WAIT_MS);
      });
      try {
        await Promise.race([options.check().catch(() => undefined), gaveUp]);
      } finally {
        clearTimeout(timer);
      }
    }
    const line = await commandNotice(options, now);
    if (line !== null) streams.stderr.write(`${line}\n`);
  } catch {
    // The notice never stops anything, a command least of all.
  }
}

/** The command's line, decided and recorded under the file's lock: see `decideNotice`. */
async function commandNotice(options: TerminalNoticeOptions, now: () => Date): Promise<string | null> {
  const decision = await decideNotice({ ...options, now }, { channel: options.channel, surface: 'command' });
  if (decision === null) return null;
  return commandDecisionLine(options.core, decision, options.channel, options.output.platform);
}

/**
 * The CLI a notice names, in product words — "Gmail CLI", "core CLI" — never its binary, which is no command most
 * people can run, and which a sentence would read as one (CUE-403).
 */
function cliOf(channel: string): string {
  if (channel === 'core') return 'core CLI';
  return `${CHANNEL_SNAPSHOT.find((entry) => entry.manifest.channel === channel)?.manifest.label ?? channel} CLI`;
}

/**
 * The command's line: the update, as core's own command located from what is printing — or why there is none here —
 * or, when this command's package is installed globally at `latest` and an older copy is running, to run that one.
 */
export function commandNoticeLine(
  core: Pick<Core, 'handoffs'>,
  notice: PendingUpdate & Partial<Notice>,
  channel: string,
  platform?: NodeJS.Platform | undefined,
): string {
  const paused = pausedWords(notice);
  if (notice.kind === 'restart') {
    return `${PRODUCT} ${notice.latest} is installed; this ${cliOf(channel)} is ${notice.running}, started from somewhere else — npx's cache, a project's own install, a checkout: run it from the installed one.${paused}`;
  }
  const update = requireHandoffs(core, platform).core(['update']);
  const when = notice.security ? 'soon' : 'when it suits you';
  return `${PRODUCT} ${notice.latest} is out${whatItIs(notice)} (this is ${notice.running}); ${handoffSentence(update, (command) => `run ${command} ${when}.`)}${paused}`;
}

/**
 * A command's one line, from everything `decideNotice` decided, as `serverDecisionLine` puts it together — every
 * command named located for this installation, or why there is none here.
 */
export function commandDecisionLine(
  core: Pick<Core, 'handoffs'>,
  decision: NoticeDecision,
  channel: string,
  platform?: NodeJS.Platform | undefined,
): string {
  const { notice, background, moves } = decision;
  const handoffs = requireHandoffs(core, platform);
  const parts: string[] = [];
  // The run's word in fixed sentences only: never the state file's text as it is (`update-words.ts`).
  if (background !== null) parts.push(backgroundNoticeLine(background));
  if (notice !== null && !(background !== null && background.version === notice.latest)) {
    parts.push(commandNoticeLine(core, notice, channel, platform));
  }
  if (decision.jobSilent) parts.push(jobSilentLine(decision.jobSilent));
  if (moves > 0) {
    parts.push(
      notice !== null
        ? `The update also moves ${registrations(moves)} onto the stable launcher, the last update that edits a client's configuration.`
        : `${PRODUCT}: ${moves === 1 ? 'one registration still starts' : `${moves} registrations still start`} a versioned runtime; ${handoffSentence(
            handoffs.core(['update']),
            (update) =>
              `one approved update, ${update}, moves ${moves === 1 ? 'it' : 'them'} onto the stable launcher, after which updates never edit a client's configuration again.`,
          )}`,
    );
  }
  if (decision.offerJob) {
    parts.push(
      handoffSentence(
        handoffs.core(['update', '--background-job', 'on']),
        (command) =>
          `To have releases install in the background instead, run ${command}: it shows the job, when it runs and how to remove it, and sets nothing up without your yes.`,
      ),
    );
  }
  return parts.join(' ');
}
