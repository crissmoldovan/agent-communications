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
   * A refresh was sent and its outcome is unknown: a timeout, a malformed reply, or a process that died with a
   * `refreshing` marker still on disk.
   *
   * There is no transaction spanning Slack and this machine and no idempotency key, so this is genuinely
   * unknowable rather than merely unknown — the refresh token may or may not have been consumed. The old access
   * token is kept because it may still work for up to twelve hours, and the refresh token is **never**
   * automatically reused: recovering means re-authorising.
   */
  | 'refresh-uncertain';

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
