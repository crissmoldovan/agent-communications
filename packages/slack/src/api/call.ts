import { CommsError } from '@agentcomms/core';
import { closedPermit, type FetchLike, guardSlackRequests, type RevokeBinding, type WritePermit } from './guard.ts';
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
  /** Local ledger identity for a revoke; checked against its grant and never sent to Slack. */
  revocation?: Pick<RevokeBinding, 'ref' | 'kind'> | undefined;
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
 * Only the ones a read can actually meet, and the few an edit or a deletion is refused with. Anything not listed becomes
 * PROVIDER_UNAVAILABLE carrying Slack's own string, which is honest — an unmapped error is one nobody has thought
 * about, and guessing a friendlier code for it would hide that.
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
  /*
   * What an edit or a deletion is refused with, in words that say what to do (design 2026-10-06 §E8). Not reads, but
   * not left to the unmapped `Slack refused the request: …` either: that reads as an outage, and each of these is a
   * plain answer about this one message.
   */
  is_inactive: { code: 'NOT_FOUND', message: 'that conversation is frozen, archived or deleted' },
  cant_update_message: {
    code: 'SCOPE_MISSING',
    message: 'Slack does not let this account edit that message',
    hint: 'Only a message this account posted can be edited, and not every kind of message can be.',
  },
  edit_window_closed: {
    code: 'SCOPE_MISSING',
    message: 'this workspace no longer lets that message be edited',
    hint: 'Its message-editing setting has closed the window for it. Post a correction instead.',
  },
  cant_delete_message: {
    code: 'SCOPE_MISSING',
    message: 'Slack does not let this account delete that message',
    hint: 'A workspace can keep people from deleting their own messages; if this one does, it is done in Slack by someone allowed to.',
  },

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
 * The methods that post, react, edit or delete, and so the ones a failure can leave not knowing whether Slack acted.
 */
export type PostingMethod =
  | 'chat.postMessage'
  | 'files.completeUploadExternal'
  | 'reactions.add'
  | 'reactions.remove'
  | 'chat.update'
  | 'chat.delete';

/*
 * The errors each posting method answers before it has acted: an allowlist, method by method, and nothing else.
 *
 * Taken from the Errors table of each method's page in Slack's reference (docs.slack.dev/reference/methods/<method>),
 * keeping only the errors that by their own description are decided before anything is posted. That means the token,
 * its scopes and its access; the room, and whether this account may post in it; the arguments, the payload and its
 * limits; a workspace or admin policy that forbids the post; a rate limit; a method that is gone. Left out on purpose:
 * `internal_error` and `fatal_error`, which Slack says may follow a partial success ("It's possible some aspect of the
 * operation succeeded before the error was raised"); `service_unavailable`, `request_timeout` and the migration errors
 * (`team_added_to_org`, `org_login_required`), which describe Slack's state rather than the request; `file_update_failed`,
 * a failure during the work; whatever belongs to features nothing here sends (drafts, `client_msg_id`, metadata); and
 * `msg_too_long`, which the page no longer lists — it says long text is truncated instead — so what it means now is not
 * something this can read off Slack's own words.
 *
 * An allowlist, and not a list of the errors that may follow a success, because the pages say their lists are not
 * exhaustive: "other errors can be returned in the case where the service is down or other unexpected factors affect
 * processing." A refusal recorded as failed when Slack had acted is the record that invites the post again, so an
 * error this does not know — new, undocumented, or listed for the other method only — is one whose outcome is not known.
 * Adding to a list is a decision about one error, made by reading what Slack says it means.
 *
 * `chat.update` and `chat.delete` (design 2026-10-06) were read the same way, on 2026-10-06. An edit is sent `text`
 * alone, so the errors of what it never sends — blocks, attachments, `file_ids`, metadata, `reply_broadcast`,
 * `markdown_text`, `as_user` — are left out, as a post's metadata errors are; `update_failed` ("Internal update
 * failure") and `unable_to_share_files` are failures during the work, and `external_channel_migrating` describes
 * Slack's state. `msg_too_long` is in, because `chat.update`'s page still lists it as a limit it refuses. And
 * `message_not_found` from `chat.delete` is not in: the message the deletion asked to be gone is gone, which is the
 * state the approval asked for, not a refusal of it (see `deletePrepared`).
 */
const REFUSED_BEFORE_ACTING: Readonly<Record<PostingMethod, ReadonlySet<string>>> = {
  'chat.postMessage': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'app_access_restricted',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    // The room, and whether this account may post in it.
    'channel_not_found',
    'not_in_channel',
    'is_archived',
    'cannot_reply_to_message',
    'team_not_found',
    // A workspace or admin policy that forbids the post.
    'restricted_action',
    'restricted_action_read_only_channel',
    'restricted_action_thread_only_channel',
    'restricted_action_non_threadable_channel',
    'restricted_action_thread_locked',
    'ekm_access_denied',
    'messages_tab_disabled',
    'slack_connect_file_link_sharing_blocked',
    'slack_connect_canvas_sharing_blocked',
    'slack_connect_lists_sharing_blocked',
    // The arguments and the payload.
    'no_text',
    'msg_blocks_too_long',
    'invalid_blocks',
    'invalid_blocks_format',
    'too_many_attachments',
    'attachment_payload_limit_exceeded',
    'too_many_contact_cards',
    'markdown_text_conflict',
    'as_user_not_supported',
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'rate_limited',
    'message_limit_exceeded',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
  'files.completeUploadExternal': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    'user_is_external_guest',
    // The room, and whether this account may post in it.
    'channel_not_found',
    'invalid_channel',
    'not_in_channel',
    'posting_to_channel_denied',
    'channels_limit_exceeded',
    // The files, and a workspace or admin policy that forbids them.
    'file_not_found',
    'file_type_not_allowed',
    'file_uploads_except_images_disabled',
    'ekm_access_denied',
    // The arguments.
    'invalid_blocks',
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
  'reactions.add': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    // The message, and whether this account may react to it.
    'channel_not_found',
    'is_archived',
    'message_not_found',
    'no_access',
    'thread_locked',
    'ekm_access_denied',
    // The reaction and the arguments.
    'invalid_name',
    'too_many_emoji',
    'too_many_reactions',
    'not_reactable',
    'bad_timestamp',
    'no_item_specified',
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
  'reactions.remove': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    // The item, and whether this account may remove its reaction from it.
    'channel_not_found',
    'message_not_found',
    'file_not_found',
    'file_comment_not_found',
    'no_access',
    'thread_locked',
    'ekm_access_denied',
    // The reaction and the arguments.
    'invalid_name',
    'bad_timestamp',
    'no_item_specified',
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
  'chat.update': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    // The message, and whether this account may change it.
    'channel_not_found',
    'invalid_channel_id',
    'message_not_found',
    'cant_update_message',
    'edit_window_closed',
    'is_inactive',
    'streaming_state_conflict',
    'team_not_found',
    // A workspace or admin policy that forbids the words.
    'ekm_access_denied',
    'slack_connect_file_link_sharing_blocked',
    'slack_connect_canvas_sharing_blocked',
    // The arguments and the text.
    'no_text',
    'msg_too_long',
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'message_limit_exceeded',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
  'chat.delete': new Set([
    // The token, its scopes, and its access.
    'not_authed',
    'invalid_auth',
    'account_inactive',
    'token_revoked',
    'token_expired',
    'not_allowed_token_type',
    'missing_scope',
    'no_permission',
    'team_access_not_granted',
    'access_denied',
    'accesslimited',
    'enterprise_is_restricted',
    'two_factor_setup_required',
    // The message, and whether this account may delete it.
    'channel_not_found',
    'invalid_channel_id',
    'cant_delete_message',
    'ekm_access_denied',
    // The arguments.
    'invalid_arguments',
    'invalid_arg_name',
    'invalid_array_arg',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'missing_post_type',
    // A rate limit, and a method that is gone.
    'ratelimited',
    'deprecated_endpoint',
    'method_deprecated',
  ]),
};

/**
 * Whether a posting request that failed certainly did nothing at Slack.
 *
 * True for a refusal before the request left — the guard's, which is `SEND_REFUSED`; for an `ok: false` naming an error
 * on `method`'s allowlist above; and for a 429, which Slack answers instead of acting. False for everything else after
 * the request was handed over: any other error Slack names, a connection that failed or dropped, a call's own time
 * running out, a 5xx, an answer that could not be read. Those say nothing about whether Slack acted, and a post that may
 * be in the channel must never be recorded as one that is not — that is how a person is invited to post it twice.
 */
export function certainlyRefused(error: unknown, method: PostingMethod): boolean {
  if (!(error instanceof CommsError)) return false;
  if (error.code === 'SEND_REFUSED') return true;
  const slackError = error.details?.slackError;
  if (typeof slackError === 'string') return REFUSED_BEFORE_ACTING[method].has(slackError);
  // The 429 in `callOnce` is the one failure that carries this, with or without a number in it.
  return error.details !== undefined && 'retryAfterSeconds' in error.details;
}

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
  const send = guardSlackRequests(call.fetch ?? (fetch as FetchLike), call.permit ?? closedPermit(), call.revocation);
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
    throw new CommsError('TRANSIENT', `Slack returned ${response.status}`, {
      hint: 'Try again in a moment.',
      details: { httpStatus: response.status },
    });
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
