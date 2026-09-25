import { CommsError } from '@agentcomms/core';
import { closedPermit, type FetchLike, guardSlackRequests, type WritePermit } from './guard.ts';
import { SLACK_ORIGIN } from './methods.ts';

/**
 * One Slack Web API call, through the guard, with Slack's failures turned into this repository's codes.
 *
 * Slack answers almost everything with HTTP 200 and `{"ok": false, "error": "…"}`, so the status line says very
 * little and the body says everything. Two consequences shape this module: nothing may decide success from the
 * status alone, and the error string has to be mapped — because `channel_not_found`, `missing_scope` and
 * `ratelimited` are three completely different things to the person or agent that asked, and a caller handed a
 * bare string will map them itself, differently, in each of the nine places that call Slack.
 */

export interface SlackCall {
  /** Injected in tests; the real one in production. Always wrapped by the guard before use. */
  fetch?: FetchLike | undefined;
  /** The user token for the workspace being read. */
  token: string;
  /**
   * The permit. A read needs none, so this defaults to a closed one — which is the safe direction: a closed
   * permit lets reads through and stops anything that posts, so a write accidentally routed here fails rather
   * than slipping past on a permit nobody opened.
   */
  permit?: WritePermit | undefined;
  /** Where Slack is. Tests point this at a local server rather than relaxing the origin check. */
  baseUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Bound per call, not per operation: a paginated read makes many, and one budget for all of them is a hang. */
  timeoutMs?: number | undefined;
  /**
   * A replacement for a token Slack has just rejected, or null when there is none. Set by `openWorkspace`.
   *
   * The stored expiry is the only thing that normally starts a refresh, and it can be wrong: a clock more than ten
   * minutes out, or another sign-in of the same user and app whose refreshes revoke this token early. Without this
   * every call would fail `invalid_auth` until the recorded expiry passed — up to twelve hours.
   */
  renew?: ((rejected: string) => Promise<string | null>) | undefined;
}

export interface SlackResponse {
  ok?: boolean;
  error?: string;
  warning?: string;
  response_metadata?: { next_cursor?: string; messages?: string[] };
  [key: string]: unknown;
}

/*
 * What each of Slack's errors is, to somebody who asked for something.
 *
 * Only the ones a read can actually meet. Anything not listed becomes PROVIDER_UNAVAILABLE carrying Slack's own
 * string, which is honest — an unmapped error is one nobody has thought about, and guessing a friendlier code for
 * it would hide that.
 */
const ERRORS: Readonly<Record<string, { code: string; message: string; hint?: string }>> = {
  ratelimited: { code: 'TRANSIENT', message: 'Slack is rate-limiting this workspace', hint: 'Try again shortly.' },
  service_unavailable: { code: 'TRANSIENT', message: 'Slack is temporarily unavailable' },
  internal_error: { code: 'TRANSIENT', message: 'Slack reported an internal error' },
  fatal_error: { code: 'TRANSIENT', message: 'Slack reported a fatal error' },
  request_timeout: { code: 'TRANSIENT', message: 'Slack timed out handling the request' },

  not_authed: { code: 'AUTH_REQUIRED', message: 'no token was sent' },
  invalid_auth: { code: 'AUTH_REQUIRED', message: 'Slack rejected the token' },
  token_revoked: { code: 'AUTH_REQUIRED', message: 'the token has been revoked' },
  token_expired: { code: 'AUTH_REQUIRED', message: 'the token has expired' },
  account_inactive: { code: 'AUTH_REQUIRED', message: 'the Slack account this token belongs to is inactive' },

  missing_scope: { code: 'SCOPE_MISSING', message: 'this workspace was not granted the scope this needs' },
  not_allowed_token_type: { code: 'SCOPE_MISSING', message: 'this method cannot be called with this kind of token' },

  channel_not_found: { code: 'NOT_FOUND', message: 'no such channel, or this account cannot see it' },
  thread_not_found: { code: 'NOT_FOUND', message: 'no such thread' },
  message_not_found: { code: 'NOT_FOUND', message: 'no such message' },
  user_not_found: { code: 'NOT_FOUND', message: 'no such user' },
  file_not_found: { code: 'NOT_FOUND', message: 'no such file, or this account cannot see it' },
  /*
   * Not NOT_FOUND, deliberately.
   *
   * `not_in_channel` means the channel exists and this account is not a member — which is a different fact, and
   * the one the person needs, because the fix is to join it rather than to look for a name they got wrong.
   */
  not_in_channel: {
    code: 'SCOPE_MISSING',
    message: 'this account is not in that channel',
    hint: 'Join the channel in Slack, then try again.',
  },
  is_archived: { code: 'NOT_FOUND', message: 'that channel is archived' },

  invalid_cursor: { code: 'BAD_DATA', message: 'Slack refused the pagination cursor' },
  invalid_ts_latest: { code: 'BAD_DATA', message: 'the `latest` timestamp is not one Slack accepts' },
  invalid_ts_oldest: { code: 'BAD_DATA', message: 'the `oldest` timestamp is not one Slack accepts' },
  invalid_arguments: { code: 'BAD_DATA', message: 'Slack refused the arguments' },
};

/** One problem Slack found, where it says more than one word: what is wrong, and where in what was sent. */
export interface SlackProblem {
  readonly message: string;
  readonly pointer?: string | undefined;
}

/**
 * The `errors` list Slack puts beside `error` on some refusals, as plain bounded strings.
 *
 * The manifest methods answer `invalid_manifest` with one entry per problem — a message and a JSON pointer into the
 * manifest — and the one word alone tells a person nothing they can fix. Bounded and reduced to strings because it
 * is still a reply this package did not write: twenty entries of a few hundred characters is plenty to act on.
 */
function problemsOf(response: SlackResponse | undefined): SlackProblem[] {
  const listed = response?.errors;
  if (!Array.isArray(listed)) return [];
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value.slice(0, 300) : undefined;
  const problems: SlackProblem[] = [];
  for (const entry of listed.slice(0, 20)) {
    const message = text((entry as { message?: unknown } | null)?.message);
    if (message === undefined) continue;
    const pointer = text((entry as { pointer?: unknown }).pointer);
    problems.push(pointer === undefined ? { message } : { message, pointer });
  }
  return problems;
}

function fail(error: string, response?: SlackResponse): never {
  const problems = problemsOf(response);
  const details = { slackError: error, ...(problems.length > 0 ? { slackProblems: problems } : {}) };
  const known = ERRORS[error];
  if (known) {
    throw new CommsError(known.code as never, known.message, {
      ...(known.hint ? { hint: known.hint } : {}),
      details,
    });
  }
  throw new CommsError('PROVIDER_UNAVAILABLE', `Slack refused the request: ${error}`, { details });
}

/** Slack takes form-encoded parameters; `undefined` means "do not send", which is not the same as empty. */
function body(params: Record<string, string | number | boolean | undefined>): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) form.set(key, String(value));
  }
  return form.toString();
}

/** What Slack says about a token that no longer works — the rejections a renewed token can fix. */
const RENEWABLE: ReadonlySet<string> = new Set(['invalid_auth', 'token_expired', 'token_revoked']);

/**
 * One call.
 *
 * Every read goes through here, which is what makes "reads never carry a permit" and "every failure is mapped"
 * true by construction rather than by each operation remembering.
 *
 * A token Slack rejects is renewed once and the call made again — never for a write. The permit is spent by the
 * first attempt whether or not Slack accepted it, so a second would be refused by the guard, and a post is a
 * person's act at a terminal who can simply run it again.
 */
export async function callSlack(
  call: SlackCall,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<SlackResponse> {
  const writing = (call.permit?.approvalId ?? null) !== null;
  try {
    return await callOnce(call, method, params);
  } catch (error) {
    const slackError = error instanceof CommsError ? error.details?.slackError : undefined;
    if (writing || !call.renew || typeof slackError !== 'string' || !RENEWABLE.has(slackError)) throw error;
    const fresh = await call.renew(call.token);
    if (fresh === null || fresh === call.token) throw error;
    // Kept on the call, so the rest of a paginated read uses it rather than being rejected page by page.
    call.token = fresh;
    return callOnce({ ...call, renew: undefined }, method, params);
  }
}

async function callOnce(
  call: SlackCall,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
): Promise<SlackResponse> {
  const send = guardSlackRequests(call.fetch ?? (fetch as FetchLike), call.permit ?? closedPermit());
  const url = new URL(`/api/${method}`, call.baseUrl ?? SLACK_ORIGIN);
  const signal = call.signal ?? AbortSignal.timeout(call.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await send(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${call.token}`,
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: body(params),
      signal,
    });
  } catch (error) {
    // A guard refusal is this package's own decision and already says what it means; only transport failures
    // become TRANSIENT here.
    if (error instanceof CommsError) throw error;
    throw new CommsError('TRANSIENT', `could not reach Slack: ${(error as Error).message}`, {
      hint: 'Check the network, then try again.',
    });
  }

  /*
   * 429 before the body, because there may not be one.
   *
   * Slack sends `Retry-After` on a rate limit and an empty body with it often enough that parsing first would
   * report "Slack's reply was not readable" for the one condition that has a documented, actionable answer.
   */
  if (response.status === 429) {
    const after = Number(response.headers.get('retry-after') ?? '');
    throw new CommsError('TRANSIENT', 'Slack is rate-limiting this workspace', {
      hint: Number.isFinite(after) && after > 0 ? `Try again in ${after} second(s).` : 'Try again shortly.',
      details: { retryAfterSeconds: Number.isFinite(after) ? after : undefined },
    });
  }
  if (response.status >= 500) {
    throw new CommsError('TRANSIENT', `Slack returned ${response.status}`, { hint: 'Try again in a moment.' });
  }

  let parsed: SlackResponse;
  try {
    parsed = (await response.json()) as SlackResponse;
  } catch {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s reply was not readable', {
      hint: 'Try again; if it persists, check https://status.slack.com.',
    });
  }
  if (parsed.ok !== true) fail(parsed.error ?? 'unknown_error', parsed);
  return parsed;
}

/**
 * Every page of a cursor-paginated method, up to a bound the caller sets.
 *
 * Bounded on purpose, and the bound is reported rather than silently applied: an unbounded read of a busy
 * workspace is an unbounded number of calls against a rate limit shared with everything else the person is doing.
 * A caller that wants more asks for more, and a reader that got less is told so by `complete: false` rather than
 * being left to assume a short list means a quiet channel — which is the failure the Gmail follow-ups path was
 * shaped around.
 */
export interface Paged<T> {
  readonly items: T[];
  /** False when a page remained and the bound stopped the read. */
  readonly complete: boolean;
  /** Where to resume. Present only when `complete` is false. */
  readonly cursor?: string | undefined;
}

export async function paginate<T>(
  call: SlackCall,
  method: string,
  params: Record<string, string | number | boolean | undefined>,
  pick: (page: SlackResponse) => T[],
  options: { limit: number; maxPages?: number; cursor?: string | undefined },
): Promise<Paged<T>> {
  const items: T[] = [];
  let cursor = options.cursor;
  const maxPages = options.maxPages ?? 10;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await callSlack(call, method, {
      ...params,
      limit: Math.min(200, options.limit - items.length),
      ...(cursor ? { cursor } : {}),
    });
    items.push(...pick(response));
    cursor = response.response_metadata?.next_cursor || undefined;
    if (!cursor || items.length >= options.limit) break;
  }
  const complete = !cursor || items.length < options.limit;
  return {
    items: items.slice(0, options.limit),
    complete: complete && !cursor,
    ...(cursor ? { cursor } : {}),
  };
}
