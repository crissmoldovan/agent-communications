import { CommsError } from '@agentcomms/core';

/**
 * The credential for one workspace, as one value.
 *
 * Slack's rotation has three properties that together make a naive "store the token, refresh when it looks old"
 * unsafe, and the shape here exists to survive all three:
 *
 * 1. **Refresh tokens are single-use.** Using one revokes it after a short grace period, so two processes that
 *    both decide to refresh burn the credential between them.
 * 2. **At most two access tokens live at once.** Refreshing repeatedly revokes the oldest, so a retry loop can
 *    revoke the token another process is holding.
 * 3. **The refresh token itself expires after 30 days** on a PKCE app — "all refresh tokens issued to your app
 *    will expire in 30 days instead of lasting indefinitely". A workspace nobody has touched for a month needs a
 *    new authorisation, not a refresh.
 *
 * So this is stored as **one versioned value** replaced atomically, never as separate fields that could be
 * half-written, and it carries a `state` rather than being implicitly ready — because the dangerous moment is
 * the one where a refresh has been sent and nothing local yet knows what happened to it.
 */

export const BUNDLE_VERSION: number = 1;

export type BundleState =
  /** Usable. The ordinary case. */
  | 'ready'
  /**
   * A refresh is in flight, recorded **before** the request went out.
   *
   * This is the whole reason the state exists. A file lock says "somebody is working on this", but a lock is
   * released by a crash and, worse, is taken over on age — so a process suspended past `staleMs` can lose its
   * lock, wake, and refresh a token another process has already spent. A marker written before the call is
   * durable evidence that a refresh token may already have been consumed, and it outlives both the lock and the
   * process.
   */
  | 'refreshing'
  /**
   * The refresh token must not be presented again, and recovering means re-authorising.
   *
   * Originally only "a refresh was sent and its outcome is unknown" — a timeout, a malformed reply, a process that
   * died with a `refreshing` marker on disk. It now also covers a refresh token Slack has said outright is dead,
   * and `reason` says which. That is one state with a reason rather than a second terminal state on purpose: a
   * 0.4.0 process reading the same credential knows only these three strings, refuses to refresh exactly
   * `refreshing` and `refresh-uncertain`, and would treat any new name as refreshable — presenting a token Slack
   * has already refused. Unknown *fields* it carries through untouched, so the reason survives it.
   *
   * The old access token is kept because it may still work for up to twelve hours, and the refresh token is
   * **never** automatically reused.
   */
  | 'refresh-uncertain';

/**
 * Where in a refresh a failure happened. Recorded so the first real failure can be diagnosed from what was kept.
 *
 * `guard` is this package's own refusal before anything left; `network` is `fetch` rejecting; `http` is a status
 * with no usable body; `unreadable` a body that did not parse; `refused` Slack's `ok:false`; `parse` an `ok:true`
 * reply without a usable credential; `store` the write afterwards.
 */
export type RefreshStage = 'guard' | 'network' | 'http' | 'unreadable' | 'refused' | 'parse' | 'store';

/**
 * Why a credential is `refresh-uncertain`. Holds nothing secret — Slack's error code, never its token.
 *
 * - `dead`: Slack said the refresh token is no longer valid, or accepted it and sent back nothing usable. Spent
 *   for certain; nothing to retry.
 * - `uncertain`: the request may have reached Slack and its reply been lost. Unknowable from here.
 * - `interrupted`: a `refreshing` marker nobody finished — a process killed mid-refresh.
 */
export interface RefreshFailureReason {
  readonly kind: 'dead' | 'uncertain' | 'interrupted';
  readonly stage?: RefreshStage | undefined;
  readonly slackError?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly networkCode?: string | undefined;
  /** The attempt this came from, so this process's own unsaved result can still be written over it. */
  readonly attemptId?: string | undefined;
  readonly at: string;
}

export interface TokenBundle {
  readonly v: typeof BUNDLE_VERSION;
  readonly state: BundleState;
  /**
   * `xoxp-…`. Used whenever it has not expired, whatever `state` says.
   *
   * `state` is about the refresh token — in flight, or possibly already spent — and none of that changes whether
   * this one still works. `accessTokenFor` once demanded `ready` as well, so an interrupted refresh became an
   * immediate outage rather than a workspace that keeps reading until somebody re-authorises.
   */
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  /** Absent once spent, or on a token that does not rotate. */
  readonly refreshToken?: string | undefined;
  /** 30 days from issue on a PKCE app. Absent when there is no refresh token to expire. */
  readonly refreshExpiresAt?: string | undefined;
  readonly issuedAt: string;
  /** Set while `refreshing`, so a marker left by a dead process can be told from one a live process just wrote. */
  readonly attempt?: { readonly id: string; readonly startedAt: string } | undefined;
  /** Set only on `refresh-uncertain`: what put it there. Absent on a credential an older version marked. */
  readonly reason?: RefreshFailureReason | undefined;
}

/** Refresh this long before the access token actually expires, so a slow call does not race the deadline. */
export const REFRESH_SKEW_MS: number = 10 * 60_000;

/** Warn this long before the refresh token expires, while re-authorising is still a choice rather than a surprise. */
export const REFRESH_EXPIRY_WARNING_MS: number = 5 * 24 * 60 * 60_000;

export function parseBundle(raw: string | null): TokenBundle | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // A secret store holding something that is not a bundle is a broken install, not a missing one — and saying
    // "no credential" would send somebody to `workspace add` when the truthful answer is `reauth`.
    throw new CommsError('BAD_DATA', 'the stored Slack credential is not readable', {
      hint: 'Run `agent-slack workspace reauth <name>` to replace it.',
    });
  }
  const bundle = value as Partial<TokenBundle>;
  if (bundle.v !== BUNDLE_VERSION || typeof bundle.accessToken !== 'string' || !bundle.state) {
    throw new CommsError('BAD_DATA', 'the stored Slack credential is from a version this cannot read', {
      hint: 'Run `agent-slack workspace reauth <name>` to replace it.',
    });
  }
  return bundle as TokenBundle;
}

export function serialiseBundle(bundle: TokenBundle): string {
  return JSON.stringify(bundle);
}

/** True when the access token is close enough to expiry to be worth replacing. */
export function isDue(bundle: TokenBundle, now: Date): boolean {
  return Date.parse(bundle.accessExpiresAt) - now.getTime() <= REFRESH_SKEW_MS;
}

/**
 * True when the access token no longer works at all. Not the same question as `isDue`.
 *
 * `isDue` answers "should a `ready` token be renewed yet", and answers it ten minutes early on purpose, so a
 * request never goes out carrying a token that dies in flight. That skew is wrong for every other use: a token
 * with nine minutes left still works, and treating it as spent refused a `refresh-uncertain` credential that
 * could have kept a workspace reading, and skipped `doctor`'s identity check for a token Slack would have
 * accepted. Reusing one predicate for two questions made both answers wrong for one of them.
 */
export function isExpired(bundle: TokenBundle, now: Date): boolean {
  return Date.parse(bundle.accessExpiresAt) <= now.getTime();
}

/** True when the refresh token itself has expired, which no refresh can recover from. */
export function refreshExpired(bundle: TokenBundle, now: Date): boolean {
  if (!bundle.refreshExpiresAt) return false;
  return Date.parse(bundle.refreshExpiresAt) <= now.getTime();
}

/**
 * How long a `refreshing` marker may stand before it is treated as abandoned.
 *
 * Longer than any bounded Slack call, because the cost of being wrong is asymmetric: deciding too early that a
 * live refresh is dead turns a working credential into `refresh-uncertain` and sends somebody to re-authorise
 * for nothing.
 */
export const ATTEMPT_ABANDONED_MS: number = 2 * 60_000;

export function attemptAbandoned(bundle: TokenBundle, now: Date): boolean {
  if (bundle.state !== 'refreshing' || !bundle.attempt) return false;
  return now.getTime() - Date.parse(bundle.attempt.startedAt) > ATTEMPT_ABANDONED_MS;
}
