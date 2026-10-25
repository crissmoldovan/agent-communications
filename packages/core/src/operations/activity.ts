import {
  ACTIVITY_KINDS,
  ACTIVITY_OUTCOMES,
  type ActivityFilters,
  type ActivityItem,
  type ActivityKind,
  type ActivityLine,
  type ActivityOutcome,
  type ActivitySession,
  type ActivitySessionSummary,
  type ActivitySurface,
  type ClientInfo,
  sessionIdentity,
} from '../activity.ts';
import {
  type ActivityRecordSetting,
  type ActivitySettings,
  isActivityRecordSetting,
  isActivityRetention,
  MAX_ACTIVITY_RETENTION_DAYS,
  MIN_ACTIVITY_RETENTION_DAYS,
  readActivitySettings,
  storedActivity,
} from '../activity-settings.ts';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeSurface } from '../changes.ts';
import { externalCommand } from '../command-brands.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { type Remedy, remedy } from '../handoffs.ts';
import { homeDirectory, shortenHome } from '../paths.ts';
import { newBoundary, wrapUntrusted } from '../untrusted.ts';
import type { DoctorCheck } from './maintenance.ts';

/**
 * What agent sessions read, were told, did and sent (design 2026-10-25-activity §4.7, with S3): the activity log, read
 * from a terminal (`agentcomms activity …`) or a chat (`comms_activity`), and its two settings.
 *
 * **The CLI has the full view; MCP has the caller's own (S3).** `sessions` lists every session and `show` any one of
 * them, every account included — the person's view, and the desktop app's through its allow-listed CLI. `mine` answers
 * only for the session it is called from, by its own `sessionIdentity`: no argument names another session, so no MCP
 * tool can hand one project's mail subjects to another project's agent.
 *
 * Everything a sender wrote — a subject, a sender's name, an address that is not a plain one, a file's name, a
 * conversation's name — is returned only inside the untrusted-content envelope, one boundary per answer.
 */

// ── Reading ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A session as a result shows it: its summary, and its folder with the home written `~`. */
export interface ShownActivitySession extends ActivitySessionSummary {
  readonly folderShown: string | null;
}

export interface ActivitySessionsResult {
  /** The time the list starts at, or null for every day held. */
  readonly since: string | null;
  /** Newest first. */
  readonly sessions: ShownActivitySession[];
}

export interface ActivityShowRequest {
  readonly kind?: string | undefined;
  readonly channel?: string | undefined;
  readonly account?: string | undefined;
  readonly outcome?: string | undefined;
  /** An ISO time, or a span back from now: `7d`, `12h`. */
  readonly since?: string | undefined;
}

export interface ActivityShowResult {
  readonly session: ShownActivitySession;
  readonly since: string | null;
  /** Newest first, what a sender wrote enveloped. */
  readonly lines: ActivityLine[];
  /** True when more lines matched than are listed. */
  readonly more: boolean;
}

export interface ActivityMineRequest extends ActivityShowRequest {
  /** Which surface is asking: the session is worked out as that kind of process. */
  readonly surface: 'mcp' | 'cli';
  /** The MCP client's `clientInfo`, when there is one. */
  readonly clientInfo?: ClientInfo | undefined;
}

export interface ActivityMineResult {
  /** The calling session, as this process worked it out. */
  readonly session: {
    readonly key: string;
    readonly grouped: boolean;
    readonly surface: ActivitySurface;
    readonly folder: string | null;
    readonly folderShown: string | null;
  };
  readonly since: string | null;
  /** The session over the time asked; null when it recorded nothing there. */
  readonly summary: ShownActivitySession | null;
  readonly lines: ActivityLine[];
  readonly more: boolean;
}

/** What a read takes besides its request: the clock `since` is counted back on, and the home `~` stands for. */
export interface ActivityReadOptions {
  readonly now?: (() => Date) | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

const SINCE_SPAN = /^(\d{1,4})([dh])$/;
const SINCE_ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** `since` as an ISO time: given as one, or as a span back from now — `7d`, `12h`. Undefined when not given. */
export function activitySince(value: string | undefined, now: Date = new Date()): string | undefined {
  if (value === undefined) return undefined;
  const span = SINCE_SPAN.exec(value.trim());
  if (span !== null) {
    const amount = Number(span[1]);
    const ms = span[2] === 'd' ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 60 * 1000;
    return new Date(now.getTime() - ms).toISOString();
  }
  const at = SINCE_ISO.test(value.trim()) ? Date.parse(value.trim()) : Number.NaN;
  if (Number.isFinite(at)) return new Date(at).toISOString();
  throw new CommsError(
    'USAGE',
    `--since (since, from a chat) takes an ISO time, or a span back from now such as 7d or 12h — not "${String(value).slice(0, 40)}"`,
  );
}

function filtersOf(request: ActivityShowRequest, now: Date): ActivityFilters {
  if (request.kind !== undefined && !(ACTIVITY_KINDS as readonly string[]).includes(request.kind)) {
    throw new CommsError('USAGE', `"${request.kind.slice(0, 40)}" is not a kind of activity`, {
      hint: `One of: ${ACTIVITY_KINDS.join(', ')}.`,
    });
  }
  if (request.outcome !== undefined && !(ACTIVITY_OUTCOMES as readonly string[]).includes(request.outcome)) {
    throw new CommsError('USAGE', `"${request.outcome.slice(0, 40)}" is not an outcome`, {
      hint: `One of: ${ACTIVITY_OUTCOMES.join(', ')}.`,
    });
  }
  return {
    ...(request.kind === undefined ? {} : { kind: request.kind as ActivityKind }),
    ...(request.outcome === undefined ? {} : { outcome: request.outcome as ActivityOutcome }),
    ...(request.channel === undefined ? {} : { channel: request.channel }),
    ...(request.account === undefined ? {} : { account: request.account }),
    ...(request.since === undefined ? {} : { since: activitySince(request.since, now) }),
  };
}

function shownFolder(folder: string | null, options: ActivityReadOptions): string | null {
  if (folder === null) return null;
  return shortenHome(folder, homeDirectory(options.env ?? process.env), options.platform ?? process.platform);
}

function shownSession(summary: ActivitySessionSummary, options: ActivityReadOptions): ShownActivitySession {
  return { ...summary, folderShown: shownFolder(summary.folder, options) };
}

/** The strict plain-address grammar the audit tail returns an address outside an envelope by. */
const PLAIN_ADDRESS = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

/** A line as an answer gives it: every field a sender controls wrapped, with this answer's one boundary. */
function enveloped(line: ActivityLine, boundary: string): ActivityLine {
  const wrap = (text: string, field: string) => wrapUntrusted(text, { field }, boundary);
  const address = (text: string, field: string) => (PLAIN_ADDRESS.test(text) ? text : wrap(text, field));
  const item = (each: ActivityItem): ActivityItem => ({
    ...each,
    ...(each.subject === undefined ? {} : { subject: wrap(each.subject, 'subject') }),
    ...(each.from === undefined
      ? {}
      : {
          from: {
            ...(each.from.name === undefined ? {} : { name: wrap(each.from.name, 'from-name') }),
            ...(each.from.address === undefined ? {} : { address: address(each.from.address, 'from-address') }),
          },
        }),
    ...(each.name === undefined ? {} : { name: wrap(each.name, 'file-name') }),
    ...(each.conversation === undefined ? {} : { conversation: wrap(each.conversation, 'conversation') }),
  });
  return {
    ...line,
    ...(line.items === undefined ? {} : { items: line.items.map(item) }),
    ...(line.recipients === undefined
      ? {}
      : { recipients: line.recipients.map((recipient) => address(recipient, 'recipient')) }),
  };
}

/**
 * Every session with activity since `since` (every day held, when left out), newest first: its folder, its client
 * as the client said, when it was first and last seen, and its counts by kind and outcome. The CLI's full view.
 */
export async function activitySessions(
  core: Core,
  options: { since?: string | undefined } & ActivityReadOptions = {},
): Promise<ActivitySessionsResult> {
  const since = activitySince(options.since, (options.now ?? (() => new Date()))());
  const sessions = await core.activity.sessions({ since });
  return { since: since ?? null, sessions: sessions.map((summary) => shownSession(summary, options)) };
}

/**
 * One session's timeline, newest first, filtered by kind, channel, account (name or id), outcome and time. The CLI's
 * full view: any session, by its key. NOT_FOUND when the session recorded nothing in the time asked.
 */
export async function activityShow(
  core: Core,
  key: string,
  request: ActivityShowRequest & ActivityReadOptions = {},
): Promise<ActivityShowResult> {
  const now = (request.now ?? (() => new Date()))();
  const filters = filtersOf(request, now);
  const shown = await core.activity.show(key, filters);
  if (shown.summary === null) {
    throw new CommsError(
      'NOT_FOUND',
      `no activity for session ${key}${filters.since === undefined ? '' : ` since ${filters.since}`}`,
      { hint: 'The sessions command lists every session with activity, and its key.' },
    );
  }
  const boundary = newBoundary();
  return {
    session: shownSession(shown.summary, request),
    since: filters.since ?? null,
    lines: shown.lines.map((line) => enveloped(line, boundary)),
    more: shown.more,
  };
}

/**
 * The calling session's own activity (S3): its lines and counts, filtered as `show` filters, and nothing of any other
 * session. Which session is asking is this process's own `sessionIdentity` — never an argument — so an MCP server
 * answers for the agent window that started it, and a CLI call for the window it ran in (or itself alone).
 *
 * `deps.identity` is a test's: the identity to answer as.
 */
export async function activityMine(
  core: Core,
  request: ActivityMineRequest,
  deps: { identity?: (() => Promise<ActivitySession>) | undefined } & ActivityReadOptions = {},
): Promise<ActivityMineResult> {
  const now = (deps.now ?? (() => new Date()))();
  const filters = filtersOf(request, now);
  const identity =
    deps.identity === undefined
      ? await sessionIdentity(request.surface, request.clientInfo, { log: core.activity })
      : await deps.identity();
  const shown = await core.activity.show(identity.key, filters);
  const boundary = newBoundary();
  return {
    session: {
      key: identity.key,
      grouped: identity.grouped,
      surface: identity.surface,
      folder: identity.folder,
      folderShown: shownFolder(identity.folder, deps),
    },
    since: filters.since ?? null,
    summary: shown.summary === null ? null : shownSession(shown.summary, deps),
    // `show` reads only lines whose key is this one; checked again here, since this is the boundary S3 draws.
    lines: shown.lines.filter((line) => line.session.key === identity.key).map((line) => enveloped(line, boundary)),
    more: shown.more,
  };
}

// ── The settings ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ActivitySettingsReport {
  readonly record: ActivityRecordSetting;
  readonly retentionDays: number;
  /** Values in `config.json` read as something stricter, each in a sentence; empty when every value was read. */
  readonly problems: readonly string[];
  /** Where the log is. */
  readonly directory: string;
  /** The days held, and the oldest and newest of them. */
  readonly days: number;
  readonly oldest: string | null;
  readonly newest: string | null;
}

export type ActivitySettingsRequest =
  | { readonly record: ActivityRecordSetting; readonly retentionDays?: undefined }
  | { readonly retentionDays: number; readonly record?: undefined };

export interface ActivitySettingsResult extends ActivitySettingsReport {
  /** False when the settings already said this, and nothing was written. */
  readonly changed: boolean;
  /** The days deleted at once because fewer are kept now. */
  readonly pruned: readonly string[];
}

async function reportOf(core: Core, settings: ActivitySettings): Promise<ActivitySettingsReport> {
  const days = await core.activity.days().catch(() => [] as string[]);
  return {
    record: settings.record,
    retentionDays: settings.retentionDays,
    problems: [...settings.problems],
    directory: core.activity.directory,
    days: days.length,
    oldest: days[0] ?? null,
    newest: days.at(-1) ?? null,
  };
}

/** Whether activity is recorded, how many days are kept, and what the log holds. */
export async function activitySettingsReport(core: Core): Promise<ActivitySettingsReport> {
  return reportOf(core, readActivitySettings(await core.config.load()));
}

const RECORD_SUMMARIES: Readonly<Record<ActivityRecordSetting, string>> = {
  on: 'Record again what agent sessions read, were told, did and sent: subjects, senders, searches and recipients, never a message body',
  off: 'Stop recording what agent sessions read, were told, did and sent',
};

/**
 * One change to the activity settings, through the one flow every change goes through (design 2026-10-25-activity
 * §4.1): `off` and fewer days are tightenings and apply at once; `on` and more days are loosenings, shown first and
 * approved. Keeping fewer days deletes the older ones at once, as the result says.
 */
export function activitySettingsChange(
  core: Core,
  request: ActivitySettingsRequest,
  surface: ChangeSurface,
): GatedChange<ActivitySettingsResult> {
  const record = (request as { record?: unknown } | undefined)?.record;
  const retentionDays = (request as { retentionDays?: unknown } | undefined)?.retentionDays;
  if ((record === undefined) === (retentionDays === undefined)) {
    throw new CommsError('USAGE', 'one change at a time: whether to record, or how many days to keep', {
      hint: 'Give `record` (on or off), or `retentionDays` (1 to 365) — not both, and not neither.',
    });
  }
  if (record !== undefined && !isActivityRecordSetting(record)) {
    throw new CommsError('USAGE', `recording is on or off, not "${String(record).slice(0, 40)}"`);
  }
  if (retentionDays !== undefined && !isActivityRetention(retentionDays)) {
    throw new CommsError(
      'USAGE',
      `the activity log keeps a whole number of days, ${MIN_ACTIVITY_RETENTION_DAYS} to ${MAX_ACTIVITY_RETENTION_DAYS}, not ${String(retentionDays).slice(0, 40)}`,
    );
  }
  const field = record !== undefined ? 'record' : 'retentionDays';
  const value = (record ?? retentionDays) as ActivityRecordSetting | number;
  const edit = (config: Config): Config => ({
    ...config,
    activity: { ...(storedActivity(config) ?? {}), [field]: value },
  });
  return {
    plan: (config) => {
      // The file's own value, so a word this release reads as off is written over even when `off` is asked for.
      const same = storedActivity(config)?.[field] === value;
      return {
        before: config,
        after: same ? config : edit(config),
        summary:
          record !== undefined
            ? RECORD_SUMMARIES[record as ActivityRecordSetting]
            : `Keep the activity log for ${value} ${value === 1 ? 'day' : 'days'}`,
      };
    },
    apply: async (consent, planned) => {
      if (planned.after === planned.before) {
        return { ...(await activitySettingsReport(core)), changed: false, pruned: [] };
      }
      const keptBefore = readActivitySettings(planned.before).retentionDays;
      const written = await core.config.update(edit, consent ? { consent } : {});
      await core.audit.append({
        inboxId: '',
        operation: field === 'record' ? 'activity.record' : 'activity.retention',
        outcome: 'ok',
        surface,
        reason: String(value),
      });
      const settings = readActivitySettings(written);
      // Fewer days kept is in force at once: the days past it go now, not at the next day's first line.
      const pruned =
        field === 'retentionDays' && settings.retentionDays < keptBefore
          ? (await core.activity.prune(settings.retentionDays)).deleted
          : [];
      return { ...(await reportOf(core, settings)), changed: true, pruned };
    },
  };
}

// ── The doctor's check ─────────────────────────────────────────────────────────────────────────────────────────

function ownerOnly(dir: string, platform: NodeJS.Platform): Remedy {
  try {
    return remedy(
      externalCommand(
        ['chmod', '700', dir],
        'chmod is the system command that makes a directory private to its owner',
        platform,
      ),
    );
  } catch {
    return remedy(`make ${dir} readable and writable by its owner alone (mode 700)`);
  }
}

/**
 * `doctor`'s `activity` check (§4.6): whether recording is on, the folder is private, today's file can be written,
 * retention is in force — and the last line any process could not write, while nothing has been written since.
 */
export async function activityDoctorCheck(
  core: Core,
  platform: NodeJS.Platform = process.platform,
): Promise<DoctorCheck> {
  const name = 'activity';
  let settings: ActivitySettings;
  try {
    settings = readActivitySettings(await core.config.load());
  } catch {
    return {
      name,
      ok: true,
      warn: true,
      detail: 'unknown — the configuration could not be read, and while it cannot, nothing is recorded',
    };
  }
  const health = await core.activity.health();
  const dir = health.directory;
  if (!health.isDirectory) {
    return {
      name,
      ok: false,
      detail: `activity is not being recorded: ${dir} is not a folder`,
      fix: remedy(`Move what is at ${dir} out of the way: the next call recorded makes the folder.`),
    };
  }
  if (health.private === false) {
    return { name, ok: false, detail: `${dir} can be read by others`, fix: ownerOnly(dir, platform) };
  }
  const kept = `${settings.retentionDays} ${settings.retentionDays === 1 ? 'day' : 'days'}`;
  const problems = settings.problems.length > 0 ? `; ${settings.problems.join('; ')}` : '';
  const failure = health.failure;
  const failing = failure !== null && (health.lastWritten === null || failure.at > health.lastWritten);
  // Retention holds whether or not anything is recorded: a day past it is never shown, and the day's first read or
  // call deletes it. One still here is one that could not be deleted yet.
  const cutoff = new Date(Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const overdue = health.days.filter((day) => day < cutoff).length;
  const waiting =
    overdue > 0 ? `; ${overdue} older than that, never shown, and deleted by the day's first read or call` : '';
  if (settings.record === 'off') {
    return {
      name,
      ok: true,
      ...(problems || overdue > 0 ? { warn: true as const } : {}),
      detail: `off: nothing is recorded; ${health.days.length} ${health.days.length === 1 ? 'day' : 'days'} held, kept ${kept}${waiting}${problems}`,
    };
  }
  if (!health.writable) {
    return {
      name,
      ok: false,
      detail: `activity is not being recorded: ${dir} cannot be written`,
      fix: remedy(`Make ${dir} writable by its owner: recording resumes with the next call.`),
    };
  }
  if (failing) {
    return {
      name,
      ok: false,
      detail: `activity is not being recorded: ${failure.message} (since ${failure.at})`,
      fix: remedy(`Make ${dir} a folder its owner can write: recording resumes with the next call.`),
    };
  }
  const held =
    health.days.length === 0
      ? 'nothing recorded yet'
      : `${health.days.length} ${health.days.length === 1 ? 'day' : 'days'} held, from ${health.days[0]}`;
  const past =
    failure === null ? '' : `; the last line that could not be written, at ${failure.at}, has been followed by others`;
  return {
    name,
    ok: true,
    ...(problems || overdue > 0 ? { warn: true as const } : {}),
    detail: `on, kept ${kept}: ${held}${waiting}${past}${problems}`,
  };
}
