import { setTimeout as sleepFor } from 'node:timers/promises';
import {
  type ApprovalOutcome,
  approvalNotFound,
  NEVER_NOTICE,
  type PublicApprovalState,
  type PublicApprovalView,
  publicApproval,
} from '../approval-outcome.ts';
import type { StoredApproval } from '../approval-stored.ts';
import { channelLabel, isChannel } from '../channel-servers.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';

/**
 * Waiting for an approval (design 2026-10-05 §D3): how an agent learns that a person approved — or that a send under
 * way finished — without being told, on every surface, within bounded resources.
 *
 * A wait is only ever a look. It never claims, approves, revokes or sends; it reads the one approval through the
 * store's locked look (`inspect`), which writes nothing but what reading derives — an expiry at its boundary, a dead
 * send's `unknown` — and classifies it there, after its owner and kind (D2). Status is this with `waitSeconds: 0`.
 */

/** How long a wait lasts when the caller does not say. */
export const DEFAULT_WAIT_SECONDS = 30;
/** The longest a wait may be asked to last: clients may background or cut short a longer call, so skills wait again. */
export const MAX_WAIT_SECONDS = 300;
/** How many waits one process runs at once; the next is refused, and is free to ask again. */
export const MAX_WAITS = 8;
/** At most one look at the approval this often. */
export const WAIT_LOOK_MS = 1000;
/** How often a caller that asked for progress hears of it. */
export const WAIT_PROGRESS_MS = 15_000;

/** The clock a wait runs by: the real one, or a test's. */
export interface WaitClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const REAL_CLOCK: WaitClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    sleepFor(ms, undefined, signal === undefined ? {} : { signal }).catch((error: unknown) => {
      // Cut short by the caller: the wait goes on to its final look.
      if ((error as { name?: string }).name !== 'AbortError') throw error;
    }),
};

/** Why a wait ended. */
export type WaitEnd =
  /** `waitSeconds: 0`: the status, now. */
  | 'now'
  /** It can be used now: a chat route's pending record under a live chat, an approved one, a question answered. */
  | 'claimable'
  /** Approved, and the live policy will not let it be claimed (`never`). */
  | 'blocked'
  /**
   * A standing approval the person approved, in force: nothing claims one — an agent uses it through its channel's
   * acknowledgement — so this is where its wait ends, never `blocked` (design 2026-10-19-standing-approvals).
   */
  | 'active'
  /** Nothing more will happen to it from a person: used, failed, unknown, expired, revoked, corrupt, or legacy. */
  | 'final'
  /** The time asked for ran out while it was still waiting for a person, or still being sent. */
  | 'timeout'
  /** The caller cancelled the wait. */
  | 'cancelled';

export interface WaitProgress {
  readonly approvalId: string;
  readonly waitedSeconds: number;
  readonly state: PublicApprovalState;
}

export interface WaitOptions {
  /** How long to wait: a whole number of seconds from 0 (status now) to 300; 30 when left out. */
  readonly waitSeconds?: number | undefined;
  /** The caller's cancellation — an MCP request's signal. */
  readonly signal?: AbortSignal | undefined;
  /** Called every fifteen seconds while the wait lasts: given only by a caller that asked for progress. */
  readonly onProgress?: ((progress: WaitProgress) => void | Promise<void>) | undefined;
  /**
   * The surface waiting, by its manifest channel — null for core's own — which a timeout's hint names when it says how
   * to wait again.
   */
  readonly channel?: string | null | undefined;
  /**
   * The mailbox or account a pinned surface serves: only that owner's approvals are found, and an owner since removed
   * is nobody's — the one NOT_FOUND either way (D2).
   */
  readonly owner?: string | undefined;
  /** The clock: the real one unless a test brings its own. */
  readonly clock?: WaitClock | undefined;
}

export interface ApprovalWait {
  readonly approvalId: string;
  /** Where the approval stands — or `cancelled`, when it was the wait that was cancelled, not the approval. */
  readonly state: PublicApprovalState | 'cancelled';
  /** Whether the next call can use it now. Never true for a cancelled wait. */
  readonly claimable: boolean;
  /**
   * D8's public object, as the final locked look saw it — what it was for, each field a sender could have written
   * enveloped — or, for a record whose owner cannot be trusted, its stub alone (D2).
   */
  readonly approval: PublicApprovalView;
  readonly ended: WaitEnd;
  /** How long it waited, in whole seconds. */
  readonly waitedSeconds: number;
  /** What to do next, when the wait ended still waiting: wait again. Never to prepare it again. */
  readonly hint?: string | undefined;
  /**
   * For a standing approval: whether it is in force, in `standing list`'s words — `pending` until the person types its
   * code, `active` while an agent may use it, `ended` ever after, with the store's reason.
   */
  readonly standing?: { readonly state: 'pending' | 'active' | 'ended'; readonly reason?: string } | undefined;
}

let running = 0;

/** Whether the classification still waits on something: a person, or a send under way. */
function stillWaiting(stored: StoredApproval, outcome: ApprovalOutcome): boolean {
  // Only a version-2 record can still move: one an earlier release prepared, or one that cannot be read, is final here.
  if (stored.form !== 'v2' || outcome.record === null) return false;
  if (outcome.state === 'sending') return true;
  return outcome.state === 'pending' && !outcome.claimable;
}

/**
 * A standing approval's own state, as `standing list` reads it: `never` on its account ends it at a look, before any
 * use writes that down. Undefined for every other kind.
 */
function standingStateOf(outcome: ApprovalOutcome): ApprovalWait['standing'] {
  if (outcome.record?.kind !== 'standing') return undefined;
  const never = outcome.reason === NEVER_NOTICE;
  if (outcome.state === 'pending' && !never) return { state: 'pending' };
  if (outcome.state === 'approved' && !never) return { state: 'active' };
  const reason = outcome.reason ?? outcome.record.reason;
  return { state: 'ended', ...(reason === undefined ? {} : { reason }) };
}

/** Why a wait that has stopped waiting ended, from the classification it stopped on. */
function endOf(outcome: ApprovalOutcome): WaitEnd {
  if (outcome.claimable) return 'claimable';
  // A standing approval is never claimed: approved and in force is where waiting for it ends.
  const standing = standingStateOf(outcome);
  if (standing !== undefined) return standing.state === 'active' ? 'active' : 'final';
  if (outcome.record !== null && outcome.state === 'approved') return 'blocked';
  return 'final';
}

/** How to wait again, on the surface that asked: core's own tool, or the channel's, named from its manifest. */
function waitAgainHint(state: PublicApprovalState, channel: string | null | undefined): string {
  const how =
    channel === null || channel === undefined || channel === 'core' || !isChannel(channel)
      ? 'comms_approval_wait'
      : `the ${channelLabel(channel)} server’s wait`;
  const what = state === 'sending' ? 'it is still being sent' : 'it is still waiting for a person';
  return `Nothing more is needed yet: ${what}. Wait again — ${how}, or the same command — to hear when it changes.`;
}

/**
 * Waits for one approval to be usable, or finished, or for the time asked for to run out (design 2026-10-05 §D3).
 *
 * It looks at the approval at most once a second, under its lock, after its owner and kind. It keeps looking while the
 * approval waits for a person — pending and not claimable — and while it is being sent; it stops as soon as it can be
 * used, a live policy keeps an approved one from being used, it reaches a final state or expires, the caller cancels,
 * or the time runs out. It never looks past the approval's own deadline or a send's current lease: the look at that
 * boundary sees the expiry or the `unknown`, and is the last. A state change against a timeout or a cancellation is
 * decided by the final locked look. Progress goes every fifteen seconds to a caller that asked for it.
 *
 * At most eight waits run at once in a process: the ninth is refused, retryably. Every way a wait ends frees its place.
 */
export async function waitForApproval(
  core: Core,
  approvalId: string,
  options: WaitOptions = {},
): Promise<ApprovalWait> {
  const waitSeconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_WAIT_SECONDS) {
    throw new CommsError('USAGE', `a wait is a whole number of seconds from 0 to ${MAX_WAIT_SECONDS}`, {
      hint: `Leave it out for ${DEFAULT_WAIT_SECONDS}, or pass 0 for the status now. To wait longer, wait again.`,
    });
  }
  // Taken before anything is awaited, so the waits a process has started are counted in the order they started.
  if (running >= MAX_WAITS) {
    throw new CommsError('TRANSIENT', `too many waits: this process already has ${MAX_WAITS} waiting`, {
      hint: 'Wait for one of them to end, then ask again.',
    });
  }
  running += 1;
  try {
    return await waitHeld(core, approvalId, waitSeconds, options);
  } finally {
    running -= 1;
  }
}

async function waitHeld(
  core: Core,
  approvalId: string,
  waitSeconds: number,
  options: WaitOptions,
): Promise<ApprovalWait> {
  const clock = options.clock ?? REAL_CLOCK;
  // The day's approval retention first, on its own bounded budget: the status or wait goes on whatever it finds
  // (design 2026-10-05 §D9), and the wait's own time starts after it.
  await core.approvals.ensurePruned();
  const started = clock.now();
  const deadline = started + waitSeconds * 1000;
  const expect = options.owner === undefined ? {} : { owner: options.owner };
  // A pin to an owner that is gone finds nothing: a removed mailbox or account is nobody's to wait on (D2).
  if (options.owner !== undefined) {
    const config = await core.config.load();
    const known = [...Object.values(config.inboxes), ...Object.values(config.accounts)].some(
      (entry) => entry.id === options.owner,
    );
    if (!known) throw approvalNotFound(approvalId, undefined);
  }

  let lastLook = clock.now();
  let seen = await core.approvals.inspect(approvalId, expect, { action: 'wait' });
  const finish = (ended: WaitEnd, outcome: ApprovalOutcome): ApprovalWait => {
    const waitedSeconds = Math.floor((clock.now() - started) / 1000);
    const approval = publicApproval(seen.stored, outcome);
    if (ended === 'cancelled') {
      return {
        approvalId,
        state: 'cancelled',
        claimable: false,
        approval,
        ended,
        waitedSeconds,
      };
    }
    const standing = standingStateOf(outcome);
    return {
      approvalId,
      state: outcome.state,
      claimable: outcome.claimable,
      approval,
      ended,
      waitedSeconds,
      ...(ended === 'timeout' ? { hint: waitAgainHint(outcome.state, options.channel) } : {}),
      ...(standing === undefined ? {} : { standing }),
    };
  };
  if (waitSeconds === 0) return finish('now', seen.outcome);

  let lastProgress = started;
  for (;;) {
    if (!stillWaiting(seen.stored, seen.outcome)) return finish(endOf(seen.outcome), seen.outcome);
    if (options.signal?.aborted) return cancelled();
    if (clock.now() >= deadline) return finish('timeout', seen.outcome);

    /*
     * The next look: a second after the last. The approval's own boundary — its pending or usable deadline, a send's
     * current lease — is seen by the first look at or after it, which then ends the wait: none follows it. A look that
     * would fall after the deadline is not made: the last one is the final one.
     */
    const next = lastLook + WAIT_LOOK_MS;
    if (next > deadline) return finish('timeout', seen.outcome);
    await clock.sleep(Math.max(0, next - clock.now()), options.signal);
    if (options.signal?.aborted) return cancelled();
    if (clock.now() < next) continue;

    lastLook = clock.now();
    seen = await core.approvals.inspect(approvalId, expect, { action: 'wait' });
    if (options.onProgress !== undefined && clock.now() - lastProgress >= WAIT_PROGRESS_MS) {
      lastProgress += WAIT_PROGRESS_MS * Math.floor((clock.now() - lastProgress) / WAIT_PROGRESS_MS);
      // Best effort: a client that went away gets no progress, and the wait still ends as it should.
      await Promise.resolve(
        options.onProgress({
          approvalId,
          waitedSeconds: Math.round((lastProgress - started) / 1000),
          state: seen.outcome.state,
        }),
      ).catch(() => undefined);
    }
  }

  /**
   * The caller cancelled. The final locked look decides: a change it sees wins over the cancellation; with nothing
   * changed, the wait was cancelled — not the approval. Within a second of the last look, that look is the final one.
   */
  async function cancelled(): Promise<ApprovalWait> {
    if (clock.now() >= lastLook + WAIT_LOOK_MS) {
      lastLook = clock.now();
      seen = await core.approvals.inspect(approvalId, expect, { action: 'wait' });
    }
    if (!stillWaiting(seen.stored, seen.outcome)) return finish(endOf(seen.outcome), seen.outcome);
    return finish('cancelled', seen.outcome);
  }
}
