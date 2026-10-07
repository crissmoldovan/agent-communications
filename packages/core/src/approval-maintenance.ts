import { join } from 'node:path';
import { unknownAtOf } from './approval-binding.ts';
import { type StoreInternals, storeInternals } from './approval-internals.ts';
import { decodeStored, type StoredApproval } from './approval-stored.ts';
import type { ApprovalKind, ApprovalState, ApprovalStore } from './approvals.ts';
import { APPROVAL_ID_PATTERN } from './ids.ts';
import { type HeldFileLock, type TryLockResult, tryFileLock } from './lock.ts';

/**
 * Bounded daily retention of approval records (design 2026-10-05 §D9, "Rate-limited retention before enumeration").
 *
 * `ensurePruned` is housekeeping, never a gate: it is awaited before an approval is created, listed, looked at or
 * waited on, and before an unsent report, and whatever it finds — not due, another process at it, a busy record, a
 * failure — the call that awaited it goes on. Once a day per state directory it takes the maintenance lock (never
 * waiting for it), commits the attempt's time before touching any record, and walks at most 200 record slots,
 * oldest first, for at most five seconds. A record is opened only under its own lock, taken with one non-blocking try,
 * and deleted only when it is a valid finished record ninety days past its finish: a durable `approval.retained` audit
 * row first, then its claim marker, then the record. Active records, corrupt ones and unreadable files are kept: no
 * evidence is destroyed under uncertainty.
 */

/** How often a state directory runs a batch: at most once in this long. */
export const MAINTENANCE_INTERVAL_MS: number = 24 * 60 * 60 * 1000;
/** How long a finished record is kept after it finished. */
export const RETENTION_MS: number = 90 * 24 * 60 * 60 * 1000;
/** The most record slots one batch takes on. */
export const MAINTENANCE_SLOTS = 200;
/** A hook's own elapsed budget, when its caller gives it no deadline: no step starts after it. */
export const MAINTENANCE_BUDGET_MS = 5_000;
/** The maintenance lock is abandoned after this long without a renewal... */
export const MAINTENANCE_STALE_MS = 30_000;
/** ...and renewed this often while a batch holds it. */
export const MAINTENANCE_RENEW_MS = 10_000;
/** A recorded attempt this far in the future is clock skew, and kept; one further ahead is taken as now. */
export const MAINTENANCE_FUTURE_SKEW_MS: number = 5 * 60 * 1000;

/** In the approvals directory: the lock one batch holds, and the state it keeps between days. */
export const MAINTENANCE_LOCK_FILE = '.maintenance.lock';
export const PRUNE_STATE_FILE = '.maintenance.json';

/** The step of a batch that failed. */
export type MaintenanceStep =
  | 'lock'
  | 'state'
  | 'enumerate'
  | 'stat'
  | 'read'
  | 'write'
  | 'append'
  | 'claim-unlink'
  | 'record-unlink'
  | 'lock-lost'
  | 'cursor';

/** A failure a batch met: which step, for which record, and the error's code — never anything a record holds. */
export interface MaintenanceError {
  readonly step: MaintenanceStep;
  readonly approvalId?: string | undefined;
  readonly code: string;
}

/**
 * What one call of `ensurePruned` did. `attempted` — it ran a batch; when it did not, `skipped` says why: not due
 * (a batch ran less than a day ago), busy (another process holds the maintenance lock), or no records (there is no
 * approvals directory at all). `processed` counts the slots whose record work ran to its end, `pruned` the records
 * deleted, `skippedBusy` the records whose lock was held elsewhere and were left. `complete` — the batch reached the end
 * of the directory inside both bounds; hitting 200 slots or the deadline, or losing the lock, leaves it false.
 */
export interface MaintenanceStatus {
  readonly attempted: boolean;
  readonly processed: number;
  readonly pruned: number;
  readonly skippedBusy: number;
  readonly complete: boolean;
  readonly errors: readonly MaintenanceError[];
  readonly skipped?: 'not-due' | 'busy' | 'no-records' | undefined;
}

/** Where the next batch resumes: strictly after this slot, in `(mtime, approval id)` order. Advisory. */
export interface PruneCursor {
  readonly mtimeMs: number;
  readonly approvalId: string;
}

/** The persisted state, exactly: `{ version: 1, lastAttemptAt, cursor }`. */
export interface PruneState {
  readonly version: 1;
  readonly lastAttemptAt: string;
  readonly cursor: PruneCursor | null;
}

/** The state as read: when the last batch began (null — never, or unreadable) and where to resume. */
export interface ReadPruneState {
  readonly lastAttemptAt: number | null;
  readonly cursor: PruneCursor | null;
}

const NEVER: ReadPruneState = Object.freeze({ lastAttemptAt: null, cursor: null });
/** Exactly what `Date.prototype.toISOString` writes. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isoTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value ? at : null;
}

/**
 * The prune state, validated field by field (as `update-state.ts` reads its record): a missing, unreadable or
 * truncated file, or one whose outer object, version or `lastAttemptAt` is wrong, is never attempted, with no cursor. A
 * cursor is judged on its own: a malformed one is dropped and the timestamp kept, so the next due batch starts again
 * from the oldest record.
 */
export function parsePruneState(text: string | null): ReadPruneState {
  if (text === null) return NEVER;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NEVER;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return NEVER;
  const held = raw as Record<string, unknown>;
  const lastAttemptAt = isoTime(held.lastAttemptAt);
  if (held.version !== 1 || lastAttemptAt === null) return NEVER;
  return { lastAttemptAt, cursor: cursorOf(held.cursor) };
}

function cursorOf(value: unknown): PruneCursor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { mtimeMs, approvalId } = value as Record<string, unknown>;
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return null;
  if (typeof approvalId !== 'string' || !APPROVAL_ID_PATTERN.test(approvalId)) return null;
  return { mtimeMs, approvalId };
}

/** One approval's artifacts: its record, its claim marker, either or both. Its time is the record's, else the marker's. */
interface Slot {
  readonly approvalId: string;
  readonly mtimeMs: number;
  readonly json: boolean;
  readonly claim: boolean;
}

/** `(mtime, id)` order: oldest first, the id breaking ties. */
function compareSlots(a: PruneCursor, b: PruneCursor): number {
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs < b.mtimeMs ? -1 : 1;
  return a.approvalId < b.approvalId ? -1 : a.approvalId > b.approvalId ? 1 : 0;
}

const positionOf = (slot: Slot): PruneCursor => ({ mtimeMs: slot.mtimeMs, approvalId: slot.approvalId });

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
}

/** What a batch reports of a record it is about to delete: never a body, an address, or anything a sender wrote. */
export interface RetainedApproval {
  readonly kind: ApprovalKind;
  readonly state: ApprovalState;
  /** When it finished: its validated terminal time, or a legacy used record's safe `updatedAt`. */
  readonly finishedAt: string;
  /** A used send's provider id, when it has a non-empty one. */
  readonly providerId?: string | undefined;
  /** A record an earlier release wrote. */
  readonly legacy?: true | undefined;
}

/** What retention decides for one record read under its lock: keep it, or delete it with this audit row. */
type Verdict =
  | { readonly keep: true }
  | { readonly keep: false; readonly owner: string; readonly row: RetainedApproval };

const KEEP: Verdict = Object.freeze({ keep: true });

/**
 * When a finished record finished (design 2026-10-05 §D9): the validated state-specific terminal time — `usedAt`,
 * `failedAt`, the derived `unknownAt`, `revokedAt`, `expiredAt`. Null for an active record, which is never deleted.
 */
function finishedAtOf(record: {
  state: ApprovalState;
  usedAt?: string | undefined;
  failedAt?: string | undefined;
  revokedAt?: string | undefined;
  expiredAt?: string | undefined;
  sendingAt?: string | undefined;
  sendingHeartbeatAt?: string | undefined;
}): number | null {
  switch (record.state) {
    case 'used':
      return isoTime(record.usedAt);
    case 'failed':
      return isoTime(record.failedAt);
    case 'unknown':
      return isoTime(unknownAtOf(record));
    case 'revoked':
      return isoTime(record.revokedAt);
    case 'expired':
      return isoTime(record.expiredAt);
    default:
      return null;
  }
}

/**
 * A legacy (version-1) used record's finish, for retention only: its `updatedAt`, when that is a time no earlier than
 * its creation and every approval, claim or send time it holds. Anything else — and every other legacy state, which
 * holds no terminal time at all — has no safe finish, and is kept.
 */
function legacyFinishedAt(raw: Record<string, unknown>): number | null {
  if (raw.state !== 'used') return null;
  const updated = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : Number.NaN;
  const created = typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : Number.NaN;
  if (!Number.isFinite(updated) || !Number.isFinite(created) || created > updated) return null;
  for (const field of ['approvedAt', 'sendingAt', 'sentAt']) {
    if (raw[field] === undefined) continue;
    const at = typeof raw[field] === 'string' ? Date.parse(raw[field]) : Number.NaN;
    if (!Number.isFinite(at) || at > updated) return null;
  }
  return updated;
}

/** What retention decides for a record as it reads now (`stored`, derived): keep, or delete with this row. */
function verdictOf(stored: StoredApproval, now: number): Verdict {
  if (stored.form === 'v2') {
    const record = stored.record;
    const finished = finishedAtOf(record);
    if (finished === null || now < finished + RETENTION_MS) return KEEP;
    const providerId =
      record.kind === 'send' && record.state === 'used' && typeof record.sentMessageId === 'string'
        ? record.sentMessageId
        : '';
    return {
      keep: false,
      // Standing disclosure has no mailbox/account owner; retention is still auditable without inventing one.
      owner: record.kind === 'disclosure' ? '' : record.inboxId,
      row: {
        kind: record.kind,
        state: record.state,
        finishedAt: new Date(finished).toISOString(),
        ...(providerId === '' ? {} : { providerId }),
      },
    };
  }
  if (stored.form === 'legacy') {
    const raw = stored.record as unknown as Record<string, unknown>;
    const finished = legacyFinishedAt(raw);
    if (finished === null || now < finished + RETENTION_MS) return KEEP;
    const providerId = typeof raw.sentMessageId === 'string' ? raw.sentMessageId : '';
    return {
      keep: false,
      owner: stored.record.inboxId,
      row: {
        kind: stored.view.kind,
        state: 'used',
        finishedAt: new Date(finished).toISOString(),
        ...(providerId === '' ? {} : { providerId }),
        legacy: true,
      },
    };
  }
  // Corrupt or unreadable: whose it is, or what it finished as, cannot be trusted. Kept as evidence.
  return KEEP;
}

/** How one slot went: its work ran, its lock was busy, or the deadline came before its next step. */
type SlotOutcome = 'done' | 'failed' | 'busy' | 'deadline';

interface Batch {
  readonly internals: StoreInternals;
  readonly deadline: number;
  readonly errors: MaintenanceError[];
  /** The report's: told of every record a batch read under its lock, by id and text. */
  readonly observe?: ((approvalId: string, text: string) => void) | undefined;
  pruned: number;
}

export interface MaintenanceOptions {
  /**
   * When no further step may start, on the store's clock, in milliseconds: five seconds from the call when left out.
   * A report passes the one deadline it shares with its own reads.
   */
  readonly deadline?: number | undefined;
}

/**
 * Runs the day's batch for `store`'s state directory, when one is due and no other process is running it, within the
 * deadline. Never throws: what failed is in `errors`, and the caller goes on.
 */
export function ensurePruned(store: ApprovalStore, options: MaintenanceOptions = {}): Promise<MaintenanceStatus> {
  return runMaintenance(storeInternals(store), options);
}

/** `ensurePruned`, for core's own report, which is told of every record the batch reads. */
export async function runMaintenance(
  internals: StoreInternals,
  options: MaintenanceOptions & { observe?: ((approvalId: string, text: string) => void) | undefined } = {},
): Promise<MaintenanceStatus> {
  const deadline = options.deadline ?? internals.now().getTime() + MAINTENANCE_BUDGET_MS;
  const batch: Batch = { internals, deadline, errors: [], observe: options.observe, pruned: 0 };
  const quiet = (skipped: MaintenanceStatus['skipped']): MaintenanceStatus => ({
    attempted: false,
    processed: 0,
    pruned: 0,
    skippedBusy: 0,
    complete: false,
    errors: batch.errors,
    ...(skipped === undefined ? {} : { skipped }),
  });
  // Not due, by a look without the lock: a batch began less than a day ago, so whatever another process writes now, this
  // one has nothing to do. Anything else — due, unreadable, a time too far ahead — is decided again under the lock.
  if (notDue(await readState(internals), internals.now().getTime())) return quiet('not-due');
  let result: TryLockResult<MaintenanceStatus>;
  try {
    result = await tryFileLock(
      join(internals.directory, MAINTENANCE_LOCK_FILE),
      (held) => runBatch(batch, held, quiet),
      { staleMs: internals.timings.staleMs, renewMs: internals.timings.renewMs, io: internals.io.lock },
    );
  } catch (error) {
    // No approvals directory: nothing has ever been written, so there is nothing to keep or delete.
    if (codeOf(error) === 'ENOENT') return quiet('no-records');
    batch.errors.push({ step: 'lock', code: codeOf(error) });
    return quiet(undefined);
  }
  return result.acquired ? result.value : quiet('busy');
}

/** The prune state as read and validated (`parsePruneState`): never attempted when it cannot be read at all. */
async function readState(internals: StoreInternals): Promise<ReadPruneState> {
  try {
    return parsePruneState(await internals.io.readText(join(internals.directory, PRUNE_STATE_FILE)));
  } catch {
    return NEVER;
  }
}

/** Whether a batch began less than a day before `now`, by a recorded time no further ahead than skew explains. */
function notDue(state: ReadPruneState, now: number): boolean {
  return (
    state.lastAttemptAt !== null &&
    state.lastAttemptAt <= now + MAINTENANCE_FUTURE_SKEW_MS &&
    now - state.lastAttemptAt < MAINTENANCE_INTERVAL_MS
  );
}

async function runBatch(
  batch: Batch,
  held: HeldFileLock,
  quiet: (skipped: MaintenanceStatus['skipped']) => MaintenanceStatus,
): Promise<MaintenanceStatus> {
  const { internals, errors } = batch;
  const { io, directory } = internals;
  const statePath = join(directory, PRUNE_STATE_FILE);
  const writeState = (state: PruneState) =>
    io.writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, { durable: true });

  // Read again under the lock: what decides is what no other batch can change meanwhile.
  const state = await readState(internals);
  const now = internals.now().getTime();
  if (state.lastAttemptAt !== null && state.lastAttemptAt > now + MAINTENANCE_FUTURE_SKEW_MS) {
    // A time further ahead than skew explains: taken as now, and kept as now, so a clock that went back suppresses
    // maintenance for one ordinary interval at most.
    try {
      await writeState({ version: 1, lastAttemptAt: new Date(now).toISOString(), cursor: state.cursor });
    } catch (error) {
      errors.push({ step: 'state', code: codeOf(error) });
    }
    return quiet('not-due');
  }
  if (notDue(state, now)) return quiet('not-due');

  // The attempt is committed before any record is touched: a crash or a failed batch waits a day, never storms.
  const attemptedAt = new Date(now).toISOString();
  try {
    await writeState({ version: 1, lastAttemptAt: attemptedAt, cursor: state.cursor });
  } catch (error) {
    errors.push({ step: 'state', code: codeOf(error) });
    return quiet(undefined);
  }

  const counts = { processed: 0, skippedBusy: 0 };
  const status = (complete: boolean): MaintenanceStatus => ({
    attempted: true,
    processed: counts.processed,
    pruned: batch.pruned,
    skippedBusy: counts.skippedBusy,
    complete,
    errors,
  });
  const late = () => internals.now().getTime() >= batch.deadline;
  if (late()) return status(false);

  // One enumeration: every record and claim marker, paired by approval id into one slot.
  let names: string[];
  try {
    names = await io.readdir(directory);
  } catch (error) {
    errors.push({ step: 'enumerate', code: codeOf(error) });
    return status(false);
  }
  const artifacts = new Map<string, { json: boolean; claim: boolean }>();
  for (const name of names) {
    const suffix = name.endsWith('.json') ? 'json' : name.endsWith('.claim') ? 'claim' : null;
    if (suffix === null) continue;
    const approvalId = name.slice(0, name.lastIndexOf('.'));
    if (!APPROVAL_ID_PATTERN.test(approvalId)) continue;
    const entry = artifacts.get(approvalId) ?? { json: false, claim: false };
    entry[suffix] = true;
    artifacts.set(approvalId, entry);
  }

  // One stat per slot, while the budget lasts: the record's, or a lone marker's.
  const slots: Slot[] = [];
  for (const [approvalId, entry] of artifacts) {
    if (late()) return status(false);
    try {
      const { mtimeMs } = await io.stat(join(directory, `${approvalId}${entry.json ? '.json' : '.claim'}`));
      slots.push({ approvalId, mtimeMs, json: entry.json, claim: entry.claim });
    } catch (error) {
      // Gone since the listing: nothing to do. Anything else is reported, and the slot left for another day.
      if (codeOf(error) !== 'ENOENT') errors.push({ step: 'stat', approvalId, code: codeOf(error) });
    }
  }
  slots.sort((a, b) => compareSlots(positionOf(a), positionOf(b)));
  const cursor = state.cursor;
  const start = cursor === null ? 0 : slots.findIndex((slot) => compareSlots(positionOf(slot), cursor) > 0);
  const first = start === -1 ? slots.length : start;
  const selected = slots.slice(first, first + MAINTENANCE_SLOTS);

  let done = cursor;
  let beforeBusy: PruneCursor | null | undefined;
  let stopped = false;
  for (let index = 0; index < selected.length; index += 1) {
    const slot = selected[index] as Slot;
    if (late()) {
      stopped = true;
      break;
    }
    // Before each record: still this batch's lock? A holder taken over as abandoned starts nothing more.
    if (!(await held.stillHeld())) {
      errors.push({ step: 'lock-lost', code: 'ELOCKLOST' });
      return status(false);
    }
    const outcome = await runSlot(batch, slot);
    if (outcome === 'deadline') {
      stopped = true;
      break;
    }
    if (outcome === 'busy') {
      counts.skippedBusy += 1;
      if (beforeBusy === undefined) beforeBusy = done;
    } else if (outcome === 'done') {
      counts.processed += 1;
    }
    done = positionOf(slot);
  }
  const reachedEnd = !stopped && first + selected.length === slots.length;
  // Advisory: cleared at the end of the directory; otherwise just before the earliest busy slot, or after the last
  // slot attempted. Only progress made inside the bounds is recorded.
  const next = reachedEnd ? null : beforeBusy !== undefined ? beforeBusy : done;
  if (!sameCursor(next, cursor)) {
    // The last look before the cursor is written. Not a fence: a takeover after it can still lose to this rename, and
    // that costs a rescan or a skip, never a wrong deletion — every deletion is decided under the record's own lock.
    if (!(await held.stillHeld())) {
      errors.push({ step: 'lock-lost', code: 'ELOCKLOST' });
      return status(false);
    }
    try {
      await writeState({ version: 1, lastAttemptAt: attemptedAt, cursor: next });
    } catch (error) {
      errors.push({ step: 'cursor', code: codeOf(error) });
    }
  }
  return status(reachedEnd);
}

function sameCursor(a: PruneCursor | null, b: PruneCursor | null): boolean {
  return a === null || b === null ? a === b : compareSlots(a, b) === 0;
}

/**
 * One slot, under its record's lock, taken with one non-blocking try: the record opened once, classified, its derived
 * expiry or `unknown` written as any locked look writes them, and — a valid finished record ninety days past its finish
 * — deleted in the one crash-safe order. A lone claim marker, its record gone, is removed.
 */
async function runSlot(batch: Batch, slot: Slot): Promise<SlotOutcome> {
  const { internals, errors } = batch;
  const { io, directory } = internals;
  const { approvalId } = slot;
  const jsonPath = join(directory, `${approvalId}.json`);
  const claimPath = join(directory, `${approvalId}.claim`);
  const late = () => internals.now().getTime() >= batch.deadline;
  // Every step starts only while time remains: the lock try, the read, a derived write, the deletion.
  if (late()) return 'deadline';
  let tried: TryLockResult<SlotOutcome>;
  try {
    tried = await tryFileLock(
      `${jsonPath}.lock`,
      async () => {
        if (late()) return 'deadline';
        let text: string | null;
        try {
          text = await io.readText(jsonPath);
        } catch (error) {
          if (codeOf(error) !== 'ENOENT') {
            errors.push({ step: 'read', approvalId, code: codeOf(error) });
            return 'failed';
          }
          text = null;
        }
        if (text === null) {
          // A claim marker whose record is gone: nothing it guards remains.
          try {
            await io.unlink(claimPath);
          } catch (error) {
            if (codeOf(error) !== 'ENOENT') {
              errors.push({ step: 'claim-unlink', approvalId, code: codeOf(error) });
              return 'failed';
            }
          }
          return 'done';
        }
        batch.observe?.(approvalId, text);
        const now = internals.now();
        // Decoded with no configuration: retention needs no owner, and an earlier release's record is read as it is.
        let stored = decodeStored(approvalId, text, null, now);
        if (stored.form === 'v2') {
          const derived = internals.derive(stored.record);
          if (derived.state !== stored.record.state) {
            // A stale send becomes `unknown`, a lapsed approval `expired`, before anything is judged — written as any
            // locked look writes it. Maintenance never moves a record any further than that.
            if (late()) return 'deadline';
            try {
              await io.writeAtomic(
                jsonPath,
                `${JSON.stringify({ ...derived, updatedAt: internals.now().toISOString() }, null, 2)}\n`,
              );
            } catch (error) {
              errors.push({ step: 'write', approvalId, code: codeOf(error) });
              return 'failed';
            }
            stored = { form: 'v2', record: derived };
          }
        }
        const verdict = verdictOf(stored, now.getTime());
        if (verdict.keep) return 'done';
        if (late()) return 'deadline';
        return prune(batch, approvalId, verdict, { jsonPath, claimPath });
      },
      { staleMs: internals.timings.recordStaleMs, io: io.lock },
    );
  } catch (error) {
    errors.push({ step: 'lock', approvalId, code: codeOf(error) });
    return 'failed';
  }
  return tried.acquired ? tried.value : 'busy';
}

/**
 * The delete, in its one order, under the record's lock: the durable `approval.retained` row, then the claim marker
 * (absent is fine), then the record. No unlink starts before the row is on disk. A failure stops there and leaves what
 * remains for another day: duplicate rows after a retry are preferred to deleting the only terminal history.
 */
async function prune(
  batch: Batch,
  approvalId: string,
  verdict: Extract<Verdict, { keep: false }>,
  paths: { jsonPath: string; claimPath: string },
): Promise<SlotOutcome> {
  const { internals, errors } = batch;
  try {
    await internals.audit.append(
      {
        inboxId: verdict.owner,
        operation: 'approval.retained',
        outcome: 'ok',
        approvalId,
        retained: verdict.row,
      },
      { durable: true },
    );
  } catch (error) {
    errors.push({ step: 'append', approvalId, code: codeOf(error) });
    return 'failed';
  }
  try {
    await internals.io.unlink(paths.claimPath);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') {
      errors.push({ step: 'claim-unlink', approvalId, code: codeOf(error) });
      return 'failed';
    }
  }
  try {
    await internals.io.unlink(paths.jsonPath);
  } catch (error) {
    errors.push({ step: 'record-unlink', approvalId, code: codeOf(error) });
    return 'failed';
  }
  batch.pruned += 1;
  return 'done';
}
