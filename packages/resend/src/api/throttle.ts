import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { CommsError, type LockOptions, withFileLock, writeFileAtomic } from '@agentcomms/core';

/**
 * How often this machine may ask Resend anything — and when it must stop asking.
 *
 * Resend allows 10 requests a second **per team, shared by every key**, with no burst. The team's own production
 * mail spends that budget too, so an agent paging through sent mail must never be the reason a password-reset email
 * is refused. Two rules:
 *
 * - **At most one request every 500 ms** (two a second), counted across every process and **every account** on this
 *   machine — a CLI command and six MCP servers share one budget, because each reserves its slot in one file under a
 *   lock.
 * - **A 429 stops everything** until the time Resend gave (`retry-after`, else `ratelimit-reset`), and so does a
 *   response saying none are left (`ratelimit-remaining: 0`). Nothing is retried: the next call is refused with the
 *   time to wait, and whoever asked decides whether to ask again.
 *
 * **One budget for the machine, not one per account.** It used to be one file per account, which is right only if
 * every account is a different team — and nothing here can tell. Resend's API names no team: a key cannot say which
 * one it belongs to, so two accounts on one team look exactly like two accounts on two. Six keys of one team,
 * connected under six names, were six budgets of two a second: twelve a second against a limit of ten, and a 429
 * through one of them held back only that one. Sharing one budget is never wrong about a team; it is only slower
 * when the accounts really are different teams, and slower is the side to be wrong on when the other side is the
 * team's production mail being refused.
 */

export const DEFAULT_INTERVAL_MS = 500;

/**
 * The longest any one request waits for the throttle's lock, however often it changes hands: thirty seconds.
 *
 * The lock is polled, not queued, so a request can keep losing it to later ones for as long as later ones keep
 * coming; without this a request could wait for ever (see `#lock`). Thirty seconds is a line of about thirty holders
 * on the slowest machine seen, where five holders took more than five seconds (a load of 97 on ten cores): each
 * holds it only for one read and one fsynced write, and the line is one request per account an agent asks at once —
 * six in the run that showed it — so thirty is several times any line seen. And it leaves room inside the minute an
 * MCP client waits for a tool call by default (the SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC`), with the slot itself still
 * to wait for and the request still to make: a request that waited longer would answer a client that had gone.
 */
export const LOCK_MAX_WAIT_MS = 30_000;

interface ThrottleFile {
  /** The earliest time, in ms since the epoch, the next request may leave. */
  next: number;
  /** Until when Resend asked for no requests at all. */
  blockedUntil: number;
  /** When a background event read most recently used a slot. */
  lastBackgroundAt?: number;
}

export type ThrottlePriority = 'interactive' | 'background-event';

export interface ThrottleOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Tests shorten this; nothing a person or an agent passes can. */
  intervalMs?: number;
  /** How long one holder of the lock may keep everyone else waiting. Tests shorten this too. */
  lockTimeoutMs?: number;
  /** How long a request may wait for the lock in all: `LOCK_MAX_WAIT_MS`. Tests shorten this too. */
  lockMaxWaitMs?: number;
}

export class Throttle {
  readonly path: string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #interval: number;
  /**
   * Five seconds **for each holder** of the lock, not for the whole line of callers ahead.
   *
   * Every Resend request on this machine takes this one lock, and an agent asking six accounts at once puts six
   * callers on it at the same moment. With the timeout counted from when each began to wait, the sixth had to see
   * five holders through inside one five-second budget; on a heavily loaded machine (a load of 97 on ten cores, in
   * the pre-push run that showed it) the read and the fsynced write under the lock slow down with everything else,
   * and it gave up with "another process is holding" while the lock was being handed on exactly as it should be. A
   * person with several accounts and a busy machine would have had requests refused for no reason but the queue.
   * Counted per holder, a caller gives up only once one holder has kept the lock for five seconds: the stuck lock
   * the timeout is there for.
   *
   * An interactive request takes the lock once to reserve its slot and waits outside it. A background event read
   * reserves nothing while it waits, so a person can always reserve the next free slot; it returns to the lock no
   * more often than once per interval. The lock is polled, not queued, so its overall wait limit still ends a caller
   * that keeps losing hand-overs to later callers. `after` waits the same way, because a stop it gave up on recording
   * is a 429 that every other account carries on into.
   */
  readonly #lock: LockOptions;

  /** Takes no account on purpose: see above. Every throttle on a state directory is the same one. */
  constructor(stateDir: string, options: ThrottleOptions = {}) {
    this.path = join(stateDir, 'resend', 'throttle.json');
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => sleepFor(ms).then(() => undefined));
    this.#interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#lock = {
      timeoutPerHolder: true,
      maxWaitMs: options.lockMaxWaitMs ?? LOCK_MAX_WAIT_MS,
      ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }),
    };
  }

  async #read(): Promise<ThrottleFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ThrottleFile>;
      return {
        next: Number.isFinite(parsed.next) ? Number(parsed.next) : 0,
        blockedUntil: Number.isFinite(parsed.blockedUntil) ? Number(parsed.blockedUntil) : 0,
        ...(Number.isFinite(parsed.lastBackgroundAt) ? { lastBackgroundAt: Number(parsed.lastBackgroundAt) } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return { next: 0, blockedUntil: 0 };
      }
      throw error;
    }
  }

  /** Runs `fn` holding the machine's one throttle lock, waiting for it as `#lock` says. */
  #locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.path}.lock`, fn, this.#lock);
  }

  /** When Resend will next be asked anything from this machine, or null when it is not holding off. */
  async blockedUntil(): Promise<string | null> {
    const state = await this.#read();
    return state.blockedUntil > this.#now() ? new Date(state.blockedUntil).toISOString() : null;
  }

  /** Throws while Resend has asked for no requests. */
  #refuseIfHeld(state: ThrottleFile): void {
    const now = this.#now();
    if (state.blockedUntil <= now) return;
    const seconds = Math.ceil((state.blockedUntil - now) / 1000);
    throw new CommsError('TRANSIENT', 'Resend asked this machine to stop for now (rate limit)', {
      hint: `Nothing was sent to Resend. Try again in ${seconds} second(s); the team's own mail shares this limit.`,
      details: { retryAfterSeconds: seconds, blockedUntil: new Date(state.blockedUntil).toISOString() },
    });
  }

  /**
   * Waits for this request's slot, or refuses at once while Resend has asked for none.
   *
   * The slot is reserved under the lock and waited for outside it, so a slow request does not hold every other
   * process's reservation. **And the hold is looked at again after the wait**: a request queued behind another is
   * still waiting when that one comes back 429, and the stop Resend asked for covers it as much as anything asked
   * later.
   */
  async before(priority: ThrottlePriority = 'interactive'): Promise<void> {
    if (priority === 'interactive') {
      const wait = await this.#locked(async () => {
        const state = await this.#read();
        this.#refuseIfHeld(state);
        const now = this.#now();
        const slot = Math.max(now, state.next);
        await writeFileAtomic(
          this.path,
          JSON.stringify({
            next: slot + this.#interval,
            blockedUntil: state.blockedUntil,
            ...(state.lastBackgroundAt === undefined ? {} : { lastBackgroundAt: state.lastBackgroundAt }),
          }),
        );
        return slot - now;
      });
      if (wait > 0) {
        await this.#sleep(wait);
        this.#refuseIfHeld(await this.#read());
      }
      return;
    }

    for (;;) {
      const decision = await this.#locked(async () => {
        const state = await this.#read();
        this.#refuseIfHeld(state);
        const now = this.#now();
        const backgroundWait =
          state.lastBackgroundAt === undefined ? 0 : Math.max(0, state.lastBackgroundAt + 2 * this.#interval - now);
        if (state.next <= now && backgroundWait === 0) {
          await writeFileAtomic(
            this.path,
            JSON.stringify({ next: now + this.#interval, blockedUntil: state.blockedUntil, lastBackgroundAt: now }),
          );
          return { granted: true, wait: 0 };
        }
        return { granted: false, wait: Math.max(state.next - now, backgroundWait, this.#interval) };
      });
      if (decision.granted) return;
      await this.#sleep(decision.wait);
    }
  }

  /**
   * Reads what Resend said about the budget, and stops every account on this machine when it says to — whichever
   * account's request it answered. Returns the stop, if any.
   */
  async after(status: number, headers: Headers): Promise<number | null> {
    const seconds = (name: string): number | null => {
      const value = headers.get(name);
      if (value === null || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return null;
      return Number(value);
    };
    let stopFor: number | null = null;
    if (status === 429) stopFor = seconds('retry-after') ?? seconds('ratelimit-reset') ?? 1;
    else if (seconds('ratelimit-remaining') === 0) stopFor = seconds('ratelimit-reset') ?? 1;
    if (stopFor === null) return null;
    const until = this.#now() + Math.max(1, stopFor) * 1000;
    await this.#locked(async () => {
      const state = await this.#read();
      await writeFileAtomic(this.path, JSON.stringify({ ...state, blockedUntil: Math.max(state.blockedUntil, until) }));
    });
    return Math.max(1, Math.ceil(stopFor));
  }
}
