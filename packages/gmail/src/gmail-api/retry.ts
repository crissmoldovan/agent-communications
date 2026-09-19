import { setTimeout as sleep } from 'node:timers/promises';
import { describeGoogleError, isRetryable } from './errors.ts';

/**
 * How a call may be repeated. gaxios retries neither 403s nor POSTs, so the retry policy lives here, next to the
 * classification — and `never` exists because a send must not be retried: a repeat can deliver the mail twice.
 */
export type RetryMode = 'safe' | 'rate-limit-only' | 'never';

export interface RetryOptions {
  mode?: RetryMode;
  attempts?: number;
  /** Base for the exponential backoff, in milliseconds. */
  baseMs?: number;
  maxDelayMs?: number;
  /** Injected in tests so backoff costs no wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export const DEFAULT_ATTEMPTS = 5;

/**
 * Runs `fn`, repeating it while Google's answer says "later": 429, 5xx, the 403 rate-limit reasons, and — for calls
 * that are safe to repeat — a connection that never produced an answer. `Retry-After` wins over the backoff; otherwise
 * the delay is exponential with full jitter, so parallel inboxes do not retry in lockstep.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const mode = options.mode ?? 'safe';
  const attempts = mode === 'never' ? 1 : (options.attempts ?? DEFAULT_ATTEMPTS);
  const baseMs = options.baseMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 32_000;
  const wait = options.sleep ?? ((ms: number) => sleep(ms));
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= attempts) throw error;
      const shape = describeGoogleError(error);
      // Without an HTTP status the request may have been received and answered; only a call that is safe to repeat
      // may be retried on that.
      if (shape.status === undefined && mode !== 'safe') throw error;
      if (!isRetryable(shape)) throw error;
      const backoff = Math.min(baseMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = shape.retryAfterMs ?? Math.round(backoff * random());
      options.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }
}

/**
 * Runs at most `limit` tasks at once. Gmail's per-user quota is the scarce resource, so each inbox gets its own
 * limiter rather than one global pool.
 */
export function createLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = (): void => {
    active--;
    queue.shift()?.();
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      next();
    }
  };
}
