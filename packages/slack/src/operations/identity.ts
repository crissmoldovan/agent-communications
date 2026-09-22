import { closedPermit, guardSlackRequests } from '../api/guard.ts';
import { SLACK_ORIGIN } from '../api/methods.ts';
import type { TokenBundle } from '../auth/bundle.ts';
import type { IdentityProbe } from './doctor.ts';

/**
 * Asking Slack who a stored token actually is.
 *
 * The one network call `doctor` makes, and the only check there that can tell a revoked token from a working
 * one: everything else reads files this package wrote, so it can only confirm that we still agree with
 * ourselves. A token revoked in Slack's own admin screens looks perfect from disk.
 *
 * `auth.test` is the cheapest thing that answers. It needs no scope at all, returns the workspace and user ids,
 * and — on the way past — the scopes Slack believes the token has, which is the only way the drift check
 * compares against anything but itself.
 */

export type ProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Slack saying "not now", which says nothing about whether the token is any good. */
const TRANSIENT = new Set(['ratelimited', 'service_unavailable', 'fatal_error', 'internal_error', 'request_timeout']);

interface AuthTest {
  ok?: boolean;
  error?: string;
  team_id?: string;
  user_id?: string;
}

/**
 * One `auth.test`, never throwing.
 *
 * Every failure is a result, because this feeds a diagnostic. A `doctor` that throws when the network is down is
 * a `doctor` nobody runs on the machine that has a problem.
 */
export async function probeIdentity(
  bundle: TokenBundle,
  options: { fetch?: ProbeFetch; timeoutMs?: number } = {},
): Promise<IdentityProbe> {
  const send = guardSlackRequests((options.fetch ?? fetch) as Parameters<typeof guardSlackRequests>[0], closedPermit());
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await send(new URL('/api/auth.test', SLACK_ORIGIN), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bundle.accessToken}`,
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      signal,
    });
  } catch (error) {
    return { kind: 'unreachable', why: (error as Error).message };
  }

  /*
   * The granted scopes, read from the header rather than asked for.
   *
   * Slack returns them alongside an ordinary Web API call, so this costs nothing beyond the call already being
   * made. Opportunistic on purpose: if the header is not there, the drift check falls back to what was recorded
   * at sign-in and says so, rather than reporting an empty list as a workspace that has lost every scope.
   */
  const granted = response.headers.get('x-oauth-scopes');
  const scopes = granted
    ? granted
        .split(',')
        .map((scope) => scope.trim())
        .filter(Boolean)
        .sort()
    : undefined;

  let body: AuthTest;
  try {
    body = (await response.json()) as AuthTest;
  } catch (error) {
    return { kind: 'unreachable', why: `Slack's reply was not readable: ${(error as Error).message}` };
  }

  /*
   * Throttled or broken is not the same as refused.
   *
   * `ok: false` covers both "this token is revoked" and "ask again later", and reporting the second as the
   * first would have `doctor` telling somebody to re-authorise a credential that is perfectly good — during
   * exactly the minutes when Slack is least able to help them.
   */
  if (response.status === 429 || response.status >= 500 || TRANSIENT.has(body.error ?? '')) {
    return { kind: 'unreachable', why: `Slack could not answer right now: ${body.error ?? response.status}` };
  }
  if (body.ok !== true) return { kind: 'rejected', error: body.error ?? 'no reason given' };
  if (!body.team_id || !body.user_id) {
    return { kind: 'unreachable', why: 'Slack answered without saying which workspace or user' };
  }
  return { kind: 'ok', workspaceId: body.team_id, userId: body.user_id, ...(scopes ? { scopes } : {}) };
}
