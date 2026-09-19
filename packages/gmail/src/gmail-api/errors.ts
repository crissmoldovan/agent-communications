import { CommsError } from '@cloudpixel/comms-core';

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
}

/**
 * Turns a Google failure into the error a user or agent can act on. Every branch names the fix, because the same HTTP
 * status means very different things here: 403 is a quota pause, a missing scope, an admin policy or a disabled API.
 */
export function mapGoogleError(error: unknown, context: ErrorContext = {}): CommsError {
  if (error instanceof CommsError) return error;
  const shape = describeGoogleError(error);
  const alias = context.alias ?? '<alias>';
  const where = context.operation ? ` while trying to ${context.operation}` : '';
  const reasons = new Set(shape.reasons);

  if (shape.status === 401) {
    return new CommsError('AUTH_REQUIRED', `Google rejected the credentials for ${alias}${where}`, {
      hint: `Sign in again: \`agent-gmail inbox reauth ${alias}\`.`,
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
        hint: `Grant it: \`agent-gmail inbox reauth ${alias} --tier organize\`.`,
        cause: error,
      });
    }
    if (reasons.has('domainPolicy')) {
      return new CommsError('AUTH_REQUIRED', `a Google Workspace policy blocks this app for ${alias}${where}`, {
        hint: 'An administrator can allow the OAuth client under Security → API controls → Manage third-party app access.',
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
