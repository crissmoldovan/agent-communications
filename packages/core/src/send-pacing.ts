import { setTimeout as sleepFor } from 'node:timers/promises';

/**
 * How long a throttled send waits before it tries again, and when it stops trying (design 2026-10-08 §R2).
 *
 * Only for a refusal that proves nothing was sent and says "later" — each channel decides that, from its provider's own
 * answers (§R1, §R7); this knows budgets and delays and nothing about providers. The provider's wait is the wait when it
 * gives one; otherwise the backoff starts at one second and doubles, with jitter so parallel sends do not retry in step.
 *
 * Three retries and 45 seconds of waiting in all, counted from the first attempt: well inside the two-minute sending
 * lease that `withSendingLease` renews while the send runs. A wait that would run past what is left is never started —
 * Gmail's sending limit names a time hours away, and a send should say so at once rather than sit on a claim.
 */

/** At most this many attempts after the first. */
export const SEND_RETRY_MAX = 3;

/** At most this much time, from the first attempt, spent before the last one starts. */
export const SEND_RETRY_BUDGET_MS = 45_000;

const BASE_MS = 1_000;

export interface SendPacingOptions {
  readonly maxRetries?: number;
  readonly budgetMs?: number;
  /** Injected in tests, so nothing waits for real. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface SendPacing {
  /**
   * The wait before the next attempt, after a refusal that says "later" — or null when the send should stop now: no
   * retries left, or the wait would run past the budget. A null spends no retry. `providerWaitMs` is the provider's own
   * wait, when it gave a usable one.
   */
  next(providerWaitMs?: number): number | null;
  /** Waits that long. */
  wait(ms: number): Promise<void>;
  /** The retries granted so far. */
  readonly retries: number;
}

export function sendPacing(options: SendPacingOptions = {}): SendPacing {
  const maxRetries = options.maxRetries ?? SEND_RETRY_MAX;
  const budgetMs = options.budgetMs ?? SEND_RETRY_BUDGET_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms).then(() => undefined));
  const random = options.random ?? Math.random;
  const startedAt = now();
  let retries = 0;

  return {
    next(providerWaitMs?: number): number | null {
      if (retries >= maxRetries) return null;
      const step = BASE_MS * 2 ** retries;
      const delay =
        typeof providerWaitMs === 'number' && Number.isFinite(providerWaitMs) && providerWaitMs >= 0
          ? Math.ceil(providerWaitMs)
          : // Half the step plus up to the other half: never zero, never more than the step.
            Math.round(step / 2 + (step / 2) * random());
      if (now() - startedAt + delay > budgetMs) return null;
      retries += 1;
      return delay;
    },
    wait: (ms: number) => sleep(ms),
    get retries() {
      return retries;
    },
  };
}
