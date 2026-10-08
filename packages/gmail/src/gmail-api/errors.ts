import { type CliHandoffs, CommsError, handoffSentence } from '@agentcomms/core';

/** The parts of a Google API error this package reads, however the transport surfaced them. */
export interface GoogleErrorShape {
  status: number | undefined;
  /** Google's per-error `reason`, e.g. `rateLimitExceeded`, `accessNotConfigured`, `domainPolicy`. */
  reasons: string[];
  message: string;
  /** `Retry-After`, in milliseconds, when the response carried one. */
  retryAfterMs: number | undefined;
  /** A console URL Google puts in the message when an API is disabled. */
  activationUrl: string | undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? String(value[0]) : value === undefined ? undefined : String(value);
}

/** `Retry-After` is either seconds or an HTTP date; both are capped so a bad header cannot park a command for hours. */
export function parseRetryAfter(value: string | undefined, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(value).getTime() - nowMs;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, 60_000);
}

/** Reads what matters out of a gaxios error, a fetch Response-like error, or anything else that was thrown. */
export function describeGoogleError(error: unknown, nowMs: number = Date.now()): GoogleErrorShape {
  const anyError = error as {
    status?: number;
    code?: number | string;
    message?: string;
    response?: { status?: number; headers?: unknown; data?: unknown };
    errors?: Array<{ reason?: string; message?: string }>;
  };
  const response = anyError?.response;
  const data = response?.data as
    | {
        error?: {
          code?: number;
          status?: string;
          message?: string;
          errors?: Array<{ reason?: string }>;
          details?: unknown[];
        };
      }
    | undefined;
  const inner = data?.error;
  const numericCode = typeof anyError?.code === 'number' ? anyError.code : undefined;
  const status = response?.status ?? anyError?.status ?? inner?.code ?? numericCode;
  const reasons = [
    ...(inner?.errors ?? []).map((e) => e.reason),
    ...(anyError?.errors ?? []).map((e) => e.reason),
    inner?.status,
    typeof anyError?.code === 'string' ? anyError.code : undefined,
  ].filter((reason): reason is string => typeof reason === 'string' && reason.length > 0);
  const message = inner?.message ?? anyError?.message ?? String(error);
  return {
    status: typeof status === 'number' ? status : undefined,
    reasons,
    message,
    retryAfterMs: parseRetryAfter(headerValue(response?.headers, 'retry-after'), nowMs),
    activationUrl: /https:\/\/console\.(?:developers|cloud)\.google\.com\/\S+/
      .exec(message)?.[0]
      ?.replace(/[.,)]+$/, ''),
  };
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'backendError',
  'RESOURCE_EXHAUSTED',
  'UNAVAILABLE',
]);

/*
 * The status answers Gmail documents before a send can happen, and nothing else.
 *
 * 400 is a malformed request; 401 and 403 reject the credentials, permission or account policy; 404 means the draft
 * is not there; and 429 refuses work at a rate or quota limit. Gmail's error reference does not document 422 for this
 * API, so it is deliberately absent. A status outside this list, no status, or an answer that cannot be read does not
 * prove Gmail did nothing — recording one as failed would invite the same mail to be sent again.
 */
const SEND_REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([400, 401, 403, 404, 429]);

/** Whether a failed send request certainly did nothing at Gmail. */
export function sendCertainlyRefused(error: unknown): boolean {
  if (error instanceof CommsError && error.code === 'SEND_REFUSED') return true;
  const cause = error instanceof Error ? error.cause : undefined;
  const status = describeGoogleError(cause ?? error).status;
  return status !== undefined && SEND_REFUSED_BEFORE_ACTING.has(status);
}

/** Which limit refused a send (design 2026-10-08 §R1, §R4). */
export type SendLimit = 'rate' | 'sending-limit' | 'project-quota';

export interface SendThrottle {
  readonly limit: SendLimit;
  /** The provider's own wait, uncapped, when it gave one. */
  readonly waitMs?: number | undefined;
  /** When that wait ends. */
  readonly retryAt?: string | undefined;
}

/**
 * The limit a send refusal names, or undefined when it names none (design 2026-10-08 §R1, §R4).
 *
 * Read from Gmail's documented answers: `403 rateLimitExceeded` and `userRateLimitExceeded`, and a `429` for concurrent
 * requests or bandwidth, are a short throttle (`rate`); a `429` "User-rate limit exceeded (Mail sending)" is the account's
 * sending limit, which "might result in these errors for multiple hours"; `403 dailyLimitExceeded` is the Cloud
 * project's quota. The wait is read uncapped — `parseRetryAfter` caps it at a minute for reads, which would turn Google's
 * "after three hours" into "after a minute" — from `Retry-After`, else the "Retry after <time>" Gmail puts in its message.
 */
export function sendThrottleOf(error: unknown, nowMs: number = Date.now()): SendThrottle | undefined {
  const raw = error instanceof Error && error.cause !== undefined ? error.cause : error;
  const shape = describeGoogleError(raw, nowMs);
  const limit: SendLimit | undefined =
    shape.status === 403 && shape.reasons.includes('dailyLimitExceeded')
      ? 'project-quota'
      : shape.status === 429
        ? /mail sending/i.test(shape.message)
          ? 'sending-limit'
          : 'rate'
        : shape.status === 403 &&
            shape.reasons.some((reason) => reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded')
          ? 'rate'
          : undefined;
  if (limit === undefined) return undefined;
  const waitMs = waitOf(
    headerValue((raw as { response?: { headers?: unknown } } | undefined)?.response?.headers, 'retry-after'),
    shape.message,
    nowMs,
  );
  return {
    limit,
    ...(waitMs === undefined ? {} : { waitMs, retryAt: new Date(nowMs + waitMs).toISOString() }),
  };
}

function waitOf(header: string | undefined, message: string, nowMs: number): number | undefined {
  const fromHeader = header === undefined ? Number.NaN : Number(header.trim());
  if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader * 1000;
  const at =
    header !== undefined ? Date.parse(header) : Date.parse(/retry after (\S+?)[.)]?(?:\s|$)/i.exec(message)?.[1] ?? '');
  return Number.isFinite(at) && at >= nowMs ? at - nowMs : undefined;
}

/**
 * The refusal a throttled send ends with, once it stops (design 2026-10-08 §R4, §R5): which limit, and when it lifts.
 * Nothing was sent; `noSendError` says so in front of these words.
 */
export function throttledRefusal(throttle: SendThrottle, retries: number, cause: unknown): CommsError {
  const after = throttle.retryAt === undefined ? undefined : `after ${throttle.retryAt}`;
  const tried = retries === 0 ? '' : ` (tried ${retries + 1} times)`;
  const details = { limit: throttle.limit, retries, ...(throttle.retryAt ? { retryAt: throttle.retryAt } : {}) };
  if (throttle.limit === 'project-quota') {
    return new CommsError('CONFIG', "this Google Cloud project's daily Gmail API quota is used up", {
      hint: 'Raise it in the Google Cloud console (APIs & Services → Gmail API → Quotas), or wait for the daily reset. Then prepare the send again.',
      details,
      cause,
    });
  }
  if (throttle.limit === 'sending-limit') {
    return new CommsError('TRANSIENT', "Gmail's sending limit for this account is reached", {
      hint: after
        ? `Google accepts mail from this account again ${after}. Prepare the send again then.`
        : 'Google says this can last several hours. Prepare the send again later.',
      details,
      cause,
    });
  }
  return new CommsError('TRANSIENT', `Google is rate-limiting this account${tried}`, {
    hint: after ? `Prepare the send again ${after}.` : 'Prepare the send again in a minute.',
    details,
    cause,
  });
}

/** True when the same request may be sent again (the caller still decides whether the operation is safe to repeat). */
export function isRetryable(shape: GoogleErrorShape): boolean {
  if (shape.status === 429) return true;
  if (shape.status !== undefined && shape.status >= 500) return true;
  if (shape.status === 403 && shape.reasons.some((reason) => RATE_LIMIT_REASONS.has(reason))) return true;
  if (shape.status === undefined) {
    // No HTTP response at all: a dropped connection or a DNS blip, not an answer from Google.
    return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|socket hang up|network|fetch failed/i.test(
      shape.message,
    );
  }
  return false;
}

export interface ErrorContext {
  /** Inbox alias, for the command shown in the hint. */
  alias?: string | undefined;
  /** What was being done, e.g. `read the profile`. */
  operation?: string | undefined;
  /** `gmail` or `people`: which API a SERVICE_DISABLED error is about. */
  api?: 'gmail' | 'people' | undefined;
  /**
   * The commands a fix names: this installation's own, located (`GmailContext.handoffs`, CUE-403). Without them — an
   * error mapped where no context is in reach — the fix is said in words, with no command.
   */
  handoffs?: CliHandoffs | undefined;
}

/**
 * Turns a Google failure into the error a user or agent can act on. Every branch names the fix, because the same HTTP
 * status means very different things here: 403 is a quota pause, a missing scope, an admin policy or a disabled API.
 */
export function mapGoogleError(error: unknown, context: ErrorContext = {}): CommsError {
  if (error instanceof CommsError) return error;
  const shape = describeGoogleError(error);
  const alias = context.alias ?? '<alias>';
  const { handoffs } = context;
  // This installation's `inbox reauth` with these words after the alias, in `say`; or the same said in words.
  const reauth = (more: readonly string[], say: (command: string) => string, words: string): string =>
    handoffs === undefined || context.alias === undefined
      ? words
      : handoffSentence(handoffs.own(['inbox', 'reauth', context.alias, ...more]), say);
  const where = context.operation ? ` while trying to ${context.operation}` : '';
  const reasons = new Set(shape.reasons);

  if (shape.status === 401) {
    return new CommsError('AUTH_REQUIRED', `Google rejected the credentials for ${alias}${where}`, {
      hint: reauth([], (command) => `Sign in again: ${command}.`, `Sign in to ${alias} again.`),
      cause: error,
    });
  }
  if (shape.status === 403) {
    if (reasons.has('accessNotConfigured') || reasons.has('SERVICE_DISABLED')) {
      const api = context.api === 'people' ? 'People API' : 'Gmail API';
      return new CommsError('CONFIG', `the ${api} is not enabled for this Google Cloud project`, {
        hint: shape.activationUrl
          ? `Enable it here, then retry: ${shape.activationUrl}`
          : `Enable the ${api} in the Google Cloud project that owns the OAuth client.`,
        cause: error,
      });
    }
    if (reasons.has('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || reasons.has('insufficientPermissions')) {
      return new CommsError('SCOPE_MISSING', `${alias} was not granted the permission this needs${where}`, {
        hint: reauth(
          ['--tier', 'organize'],
          (command) => `Grant it: ${command}.`,
          `Grant it: sign in to ${alias} again at the organize tier.`,
        ),
        cause: error,
      });
    }
    if (reasons.has('domainPolicy')) {
      return new CommsError('AUTH_REQUIRED', `a Google Workspace policy blocks this app for ${alias}${where}`, {
        hint: 'An administrator can allow the OAuth client under Security → API controls → Manage third-party app access.',
        cause: error,
      });
    }
    if (reasons.has('dailyLimitExceeded')) {
      // The Cloud project's quota, not the account: re-authorising changes nothing (design 2026-10-08 §R6).
      return new CommsError('CONFIG', `this Google Cloud project's daily Gmail API quota is used up${where}`, {
        hint: 'Raise it in the Google Cloud console (APIs & Services → Gmail API → Quotas), or wait for the daily reset.',
        cause: error,
      });
    }
    if ([...reasons].some((reason) => RATE_LIMIT_REASONS.has(reason))) {
      return new CommsError('TRANSIENT', `Google is rate-limiting this account${where}`, {
        hint: 'Wait a minute and retry.',
        cause: error,
      });
    }
    return new CommsError('AUTH_REQUIRED', `Google refused the request for ${alias}${where}: ${shape.message}`, {
      cause: error,
    });
  }
  if (shape.status === 404) {
    return new CommsError('NOT_FOUND', shape.message || `not found${where}`, { cause: error });
  }
  if (shape.status === 429) {
    return new CommsError('TRANSIENT', `Google is rate-limiting this account${where}`, {
      hint: 'Wait a minute and retry.',
      cause: error,
    });
  }
  if (shape.status !== undefined && shape.status >= 500) {
    return new CommsError('TRANSIENT', `Google returned ${shape.status}${where}`, {
      hint: 'A Google-side error. Retry shortly.',
      cause: error,
    });
  }
  if (shape.status === 400 && reasons.has('failedPrecondition')) {
    return new CommsError('BAD_DATA', shape.message, { cause: error });
  }
  if (shape.status === undefined) {
    return new CommsError('PROVIDER_UNAVAILABLE', `could not reach Google${where}: ${shape.message}`, { cause: error });
  }
  return new CommsError('BAD_DATA', `Google rejected the request${where}: ${shape.message}`, { cause: error });
}
