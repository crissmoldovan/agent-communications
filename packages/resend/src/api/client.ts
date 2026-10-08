import { CommsError, type ErrorCode } from '@agentcomms/core';
import { closedPermit, type FetchLike, guardResendRequests, type WritePermit } from './guard.ts';
import { RESEND_API_ORIGIN, RESEND_DOWNLOAD_ORIGIN } from './routes.ts';
import type { Throttle } from './throttle.ts';

/**
 * One Resend call: through the throttle, through the guard, with Resend's failures turned into this repository's codes
 * — and with the key taken out of anything that could be printed.
 *
 * The key appears in exactly one place in this package's requests, the `Authorization` header built below, and in
 * no message, detail or hint: every text that came back from Resend or from the network passes through `redact` on
 * its way into an error, in case either ever echoes it.
 */

export interface ResendTransport {
  /** The inner fetch: the real one in production, a loopback fake in tests. Always wrapped by the guard. */
  readonly fetch?: FetchLike | undefined;
  readonly key: string;
  readonly throttle: Throttle;
  /** Closed except inside the one operation that opens it for one request. */
  readonly permit?: WritePermit | undefined;
  readonly timeoutMs?: number | undefined;
}

/** What a write's failure says about whether anything happened at Resend. */
export type WriteOutcome = 'not-sent' | 'unknown';

export interface ResendErrorDetails {
  status?: number | undefined;
  resendError?: string | undefined;
  /** For a write: whether the request can have had an effect. */
  outcome?: WriteOutcome | undefined;
  retryAfterSeconds?: number | undefined;
  stage?: 'network' | 'http' | 'unreadable' | undefined;
}

/** Takes a key, and anything that looks like one, out of a text that may be printed. */
export function redact(text: string, key: string): string {
  let out = text;
  const trimmed = key.trim();
  if (trimmed.length >= 6) {
    out = out.split(trimmed).join('[redacted key]');
    const tail = trimmed.startsWith('re_') ? trimmed.slice(3) : '';
    if (tail.length >= 6) out = out.split(tail).join('[redacted key]');
  }
  // Anything else shaped like a Resend key, whoever's it is.
  return out.replace(/\bre_[A-Za-z0-9_]{8,}/g, 're_[redacted]');
}

interface ResendErrorBody {
  name?: unknown;
  message?: unknown;
  statusCode?: unknown;
}

function codeFor(status: number, name: string): { code: ErrorCode; message: string; hint?: string } {
  if (name === 'restricted_api_key' && status === 401) {
    return {
      code: 'SCOPE_MISSING',
      message: 'this account’s key can only send email; Resend refuses everything else with it',
      // Prose, not a command: this layer has no installation to name one from, and the operations above it say how.
      hint: 'Reads need a full-access key. A person adds one under another account name, at their own terminal.',
    };
  }
  if (status === 401 || name === 'restricted_api_key' || name === 'suspended_api_key') {
    return {
      code: 'AUTH_REQUIRED',
      message: 'Resend refused the API key (it may have been deleted, disabled or suspended)',
      hint: 'Create a new key in the Resend dashboard, then remove this account and add it again with the new key.',
    };
  }
  if (status === 404) return { code: 'NOT_FOUND', message: 'Resend has no such thing' };
  if (status === 429) {
    return { code: 'TRANSIENT', message: 'Resend is rate-limiting this team, or its sending quota is used up' };
  }
  if (status >= 500) return { code: 'TRANSIENT', message: `Resend returned ${status}` };
  if (status === 409) return { code: 'PROVIDER_UNAVAILABLE', message: 'Resend refused the request as a conflict' };
  return { code: 'BAD_DATA', message: 'Resend refused the request' };
}

/*
 * The answers Resend documents before it acts: malformed requests (400 and 422), a key or permission it refuses (401
 * and 403), a thing that is not there (404), and a rate or quota limit (429). Kept as an allowlist because another
 * status says nothing about whether the email was accepted. In particular, 409 means an idempotency-key request
 * already exists or is in flight, so it stays unknown: the conflicting request may be the email this one was sending.
 */
const REFUSED_BEFORE_ACTING: ReadonlySet<number> = new Set([400, 401, 403, 404, 422, 429]);

/** Whether a failed write can have taken effect. */
export function writeOutcomeOf(status: number | undefined): WriteOutcome {
  return status !== undefined && REFUSED_BEFORE_ACTING.has(status) ? 'not-sent' : 'unknown';
}

/** Which limit refused a send (design 2026-10-08 §R1, §R4), from Resend's documented `429` names. */
export type SendLimit = 'rate' | 'daily-quota' | 'monthly-quota';

export interface SendThrottle {
  readonly limit: SendLimit;
  /** Resend's own wait, when it gave one. */
  readonly waitMs?: number | undefined;
  /** When the limit lifts, when that is known: the wait's end, or midnight UTC for the daily quota. */
  readonly retryAt?: string | undefined;
}

/**
 * The limit a send's refusal names, or undefined when it names none.
 *
 * Only a `429` Resend gave before acting: `rate_limit_exceeded` (or no name) is requests per second; `daily_quota_exceeded`
 * resets at midnight UTC; `monthly_quota_exceeded` needs a larger plan (resend.com/docs/api-reference/errors, read
 * 2026-10-08).
 */
export function sendThrottleOf(error: unknown, nowMs: number = Date.now()): SendThrottle | undefined {
  if (!(error instanceof CommsError)) return undefined;
  const details = (error.details ?? {}) as ResendErrorDetails;
  if (details.status !== 429 || details.outcome !== 'not-sent') return undefined;
  const name = details.resendError;
  const limit: SendLimit | undefined =
    name === 'daily_quota_exceeded'
      ? 'daily-quota'
      : name === 'monthly_quota_exceeded'
        ? 'monthly-quota'
        : name === 'rate_limit_exceeded' || name === 'http_429' || name === undefined
          ? 'rate'
          : undefined;
  // A 429 under another name is not a limit this knows how to wait on: it keeps today's handling.
  if (limit === undefined) return undefined;
  if (limit === 'monthly-quota') return { limit };
  if (limit === 'daily-quota') {
    const midnight = new Date(nowMs);
    midnight.setUTCHours(24, 0, 0, 0);
    return { limit, retryAt: midnight.toISOString() };
  }
  const seconds = details.retryAfterSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return { limit };
  const waitMs = Math.max(1, seconds) * 1000;
  return { limit, waitMs, retryAt: new Date(nowMs + waitMs).toISOString() };
}

/**
 * The refusal a throttled send ends with, once it stops (design 2026-10-08 §R4, §R5). Nothing was sent; the send's
 * no-send bookkeeping says so in front of these words.
 */
export function throttledRefusal(throttle: SendThrottle, retries: number, cause: unknown): CommsError {
  const tried = retries === 0 ? '' : ` (tried ${retries + 1} times)`;
  const details = { limit: throttle.limit, retries, ...(throttle.retryAt ? { retryAt: throttle.retryAt } : {}) };
  if (throttle.limit === 'monthly-quota') {
    return new CommsError('TRANSIENT', "this Resend team's monthly sending quota is used up", {
      hint: 'A larger Resend plan raises it. Prepare the send again once it has.',
      details,
      cause,
    });
  }
  if (throttle.limit === 'daily-quota') {
    return new CommsError('TRANSIENT', "this Resend team's daily sending quota is used up", {
      hint: `It resets at midnight UTC (${throttle.retryAt}). Prepare the send again then, or move to a plan without a daily quota.`,
      details,
      cause,
    });
  }
  return new CommsError('TRANSIENT', `Resend is rate-limiting this team${tried}`, {
    hint: throttle.retryAt
      ? `Prepare the send again after ${throttle.retryAt}.`
      : 'Prepare the send again in a minute.',
    details,
    cause,
  });
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined> | undefined;
  body?: unknown;
  /** Only for the send: the approval id. */
  idempotencyKey?: string | undefined;
}

/** One API request. Resolves to the parsed JSON body of a 2xx, or throws a `CommsError` whose text holds no key. */
export async function resendRequest<T>(
  transport: ResendTransport,
  method: 'GET' | 'POST',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const writing = method !== 'GET';
  const url = new URL(path, RESEND_API_ORIGIN);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${transport.key}`,
    accept: 'application/json',
    'user-agent': 'agent-resend',
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;

  try {
    await transport.throttle.before();
  } catch (error) {
    // Refused before anything left: for a write, that is certainly not sent.
    if (writing && error instanceof CommsError) {
      throw new CommsError(error.code, error.message, {
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        details: { ...error.details, outcome: 'not-sent' },
      });
    }
    throw error;
  }
  const send = guardResendRequests(transport.fetch ?? (fetch as FetchLike), transport.permit ?? closedPermit());

  let response: Response;
  try {
    response = await send(url, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(transport.timeoutMs ?? 30_000),
    });
  } catch (error) {
    // A guard refusal is this package's own decision and already says what it means.
    if (error instanceof CommsError) throw error;
    const text = redact(error instanceof Error ? error.message : String(error), transport.key);
    throw new CommsError('TRANSIENT', `could not reach Resend: ${text}`, {
      hint: writing
        ? 'Whether Resend acted on it is not known. Do not repeat it: check first.'
        : 'Check the network, then try again.',
      details: { stage: 'network', ...(writing ? { outcome: 'unknown' } : {}) } satisfies ResendErrorDetails,
    });
  }

  const stopFor = await transport.throttle.after(response.status, response.headers);

  if (response.status >= 200 && response.status < 300) {
    try {
      return (await response.json()) as T;
    } catch {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'Resend’s reply was not readable', {
        hint: writing ? 'Resend accepted the request; whether it acted is not known from here.' : 'Try again.',
        details: {
          status: response.status,
          stage: 'unreadable',
          ...(writing ? { outcome: 'unknown' } : {}),
        } satisfies ResendErrorDetails,
      });
    }
  }

  let body: ResendErrorBody = {};
  try {
    body = (await response.json()) as ResendErrorBody;
  } catch {
    // An empty or non-JSON error body: the status says enough.
  }
  // Both of Resend's texts are redacted: `name` is meant to be a code, but it is Resend's to fill, and it reaches
  // `details.resendError`, which every surface prints.
  const name =
    typeof body.name === 'string' ? redact(body.name, transport.key).slice(0, 64) : `http_${response.status}`;
  const said = typeof body.message === 'string' ? redact(body.message, transport.key).slice(0, 300) : '';
  const known = codeFor(response.status, name);
  const hint =
    stopFor !== null
      ? `Nothing more is asked of Resend for ${stopFor} second(s). The team’s own mail shares this limit.`
      : known.hint;
  throw new CommsError(known.code, said ? `${known.message}: ${said}` : known.message, {
    ...(hint ? { hint } : {}),
    details: {
      status: response.status,
      resendError: name,
      stage: 'http',
      ...(stopFor !== null ? { retryAfterSeconds: stopFor } : {}),
      ...(writing ? { outcome: writeOutcomeOf(response.status) } : {}),
    } satisfies ResendErrorDetails,
  });
}

/**
 * A received attachment's bytes, from the signed link Resend returned — without the key, and up to `maxBytes`.
 *
 * The link must be on Resend's CDN; the guard checks that too, and refuses one carrying an `Authorization` header.
 */
export async function resendDownload(transport: ResendTransport, link: string, maxBytes: number): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new CommsError('BAD_DATA', 'Resend returned a download link that is not a URL');
  }
  if (url.origin !== RESEND_DOWNLOAD_ORIGIN) {
    throw new CommsError('BAD_DATA', `Resend returned a download link on ${url.origin}, which is not its CDN`, {
      hint: 'Nothing was downloaded.',
    });
  }
  await transport.throttle.before();
  const send = guardResendRequests(transport.fetch ?? (fetch as FetchLike), closedPermit());
  let response: Response;
  try {
    response = await send(url, { method: 'GET', signal: AbortSignal.timeout(transport.timeoutMs ?? 120_000) });
  } catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError('TRANSIENT', 'could not download the attachment from Resend', {
      hint: 'Try again; the link lasts an hour and a fresh one is fetched each time.',
    });
  }
  if (!response.ok) {
    throw new CommsError(
      response.status === 404 ? 'NOT_FOUND' : 'TRANSIENT',
      `the download returned ${response.status}`,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new CommsError('BAD_DATA', `the attachment is larger than ${maxBytes} bytes`, { hint: 'Nothing was saved.' });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new CommsError('BAD_DATA', `the attachment is larger than ${maxBytes} bytes`, { hint: 'Nothing was saved.' });
  }
  return bytes;
}
