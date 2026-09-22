import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CommsError, type SecretStore, withFileLock } from '@agentcomms/core';
import {
  ATTEMPT_ABANDONED_MS,
  attemptAbandoned,
  BUNDLE_VERSION,
  isDue,
  isExpired,
  parseBundle,
  refreshExpired,
  serialiseBundle,
  type TokenBundle,
} from './bundle.ts';

/**
 * Keeping one workspace's access token fresh, without ever spending its refresh token twice.
 *
 * The hard part is not the HTTP call. Slack's refresh tokens are single-use and it keeps at most two access
 * tokens alive, so the failure that matters is two processes — an MCP server and a CLI, or two MCP servers —
 * both deciding the token is due at the same moment. One of them burns the refresh token; the other presents a
 * revoked one, or worse, revokes the first one's brand-new access token.
 *
 * A file lock alone is not enough authority for that, and the reason is specific: this repository's lock takes
 * over on **age**. A process suspended past `staleMs` — a laptop lid, a busy machine — loses its lock without
 * knowing, and can wake up and proceed. So the lock serialises, and a **durable marker written before the
 * request** is what makes a spent refresh token recognisable afterwards by anybody.
 *
 * The sequence, and every step is on disk before the next begins:
 *
 *   ready ──(lock, re-read, still due)──> refreshing{attemptId} ──> one bounded call
 *                                                                    ├─ ok ──────────> ready (new bundle)
 *                                                                    ├─ timeout ─────> refresh-uncertain
 *                                                                    └─ store fails ─> retry the store only
 *
 * and a `refreshing` marker found stale by anyone becomes `refresh-uncertain` rather than being retried, because
 * the token behind it may already be spent and nothing local can tell.
 *
 * **Nothing in the package calls this yet**, and that is not an oversight. S2 signs in; the first Slack method
 * call arrives with S3's transport, and this is what that transport will ask for a token. It is here now because
 * the sign-in it belongs to is here now — `bundleFrom` records the expiry this reads, and a rotation scheme
 * designed a phase after the credential shape it rotates is a rotation scheme that discovers the shape is wrong.
 * `doctor` already reports the states it writes, so an interrupted refresh is explicable from the day it can
 * happen rather than from the day something reads it.
 */

export interface RefreshDeps {
  secrets: SecretStore;
  /** Where the per-account lock file lives. Not the config lock: this one is held across a network call. */
  stateDir: string;
  now(): Date;
  /** Exchanges a refresh token for a new bundle. Bounded by the caller; never retried by this module. */
  exchange(refreshToken: string): Promise<Omit<TokenBundle, 'v' | 'state' | 'attempt'>>;
}

/**
 * `staleMs` for the refresh lock.
 *
 * Deliberately longer than the bounded Slack call plus the two secret writes around it. The repository's lock
 * documentation advises against network work inside a critical section for good reason — but the alternative
 * here is releasing the lock around the one call that must not happen twice, so instead the window is made wide
 * enough that a normal call cannot outlive it, and the marker covers the abnormal one.
 */
const LOCK_STALE_MS = 3 * 60_000;
const LOCK_TIMEOUT_MS = 90_000;

/** One in-flight refresh per account per process, so concurrent callers here share a result instead of racing. */
const inFlight = new Map<string, Promise<TokenBundle>>();

function lockPathFor(stateDir: string, accountId: string): string {
  return join(stateDir, 'slack', `${accountId}.refresh.lock`);
}

/**
 * Returns a usable access token, refreshing first if it is due.
 *
 * The in-process map is an optimisation for the common case of several calls at once in one server; the file
 * lock is the authority across processes, and the marker is the authority across crashes.
 */
export async function accessTokenFor(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
): Promise<{ token: string; bundle: TokenBundle }> {
  const existing = inFlight.get(accountId);
  if (existing) {
    const bundle = await existing;
    return { token: bundle.accessToken, bundle };
  }

  const work = (async (): Promise<TokenBundle> => {
    // Read outside the lock first: the overwhelmingly common case is a token with hours left, and taking a lock
    // to discover that would serialise every call in the process for no reason.
    deps.secrets.invalidate(secretRef);
    const current = requireBundle(await deps.secrets.get(secretRef));
    /*
     * A token that still works is used, whatever state the bundle is in.
     *
     * This asked for `ready` as well, which made the state decide something it has no business deciding. The
     * state is about the *refresh* token — whether one is in flight, whether one may already have been spent —
     * and none of that changes whether the access token in hand is still valid for the next few hours.
     *
     * The comment on `refresh-uncertain` had said as much all along ("the old access token is kept because it
     * may still work for up to twelve hours"), and the code refused it anyway: an interrupted refresh became an
     * immediate total outage instead of a workspace that keeps reading until somebody re-authorises. `doctor`
     * reports the state as a failure either way, so nothing is hidden by letting reads continue.
     *
     * The same reasoning covers `refreshing`: another process renewing this credential is not a reason to stop
     * using the one we already hold.
     */
    if (stillUsable(current, deps.now())) return current;

    return withFileLock(lockPathFor(deps.stateDir, accountId), () => refreshUnderLock(deps, secretRef), {
      staleMs: LOCK_STALE_MS,
      timeoutMs: LOCK_TIMEOUT_MS,
    });
  })();

  inFlight.set(accountId, work);
  try {
    const bundle = await work;
    return { token: bundle.accessToken, bundle };
  } finally {
    inFlight.delete(accountId);
  }
}

/**
 * Whether the token in hand should be used as it is.
 *
 * Two different thresholds, because the two situations want different things. A `ready` token is renewed ten
 * minutes early, so nothing goes out carrying a token that dies in flight. Any other state cannot be renewed
 * right now — a refresh is in flight, or one may already have been spent — so the token is used until it has
 * actually expired, rather than being refused with minutes left on it.
 */
function stillUsable(bundle: TokenBundle, now: Date): boolean {
  return bundle.state === 'ready' ? !isDue(bundle, now) : !isExpired(bundle, now);
}

function requireBundle(raw: string | null): TokenBundle {
  const bundle = parseBundle(raw);
  if (!bundle) {
    throw new CommsError('AUTH_REQUIRED', 'this workspace has no stored credential', {
      hint: 'Connect it with `agent-slack workspace add`.',
    });
  }
  return bundle;
}

async function refreshUnderLock(deps: RefreshDeps, secretRef: string): Promise<TokenBundle> {
  /*
   * Re-read inside the lock, and invalidate the cache first.
   *
   * Another process may have refreshed while this one waited, in which case there is nothing to do — and the
   * keychain wrapper caches, so without the invalidation this would read its own stale copy and refresh a token
   * that was replaced thirty seconds ago.
   */
  deps.secrets.invalidate(secretRef);
  const current = requireBundle(await deps.secrets.get(secretRef));
  const now = deps.now();

  if (stillUsable(current, now)) return current;

  if (current.state === 'refresh-uncertain') {
    throw new CommsError('AUTH_REQUIRED', 'a previous token refresh did not finish, and cannot be retried safely', {
      hint: 'Slack refresh tokens are single-use. Run `agent-slack workspace reauth <name>`.',
    });
  }

  if (current.state === 'refreshing') {
    if (!attemptAbandoned(current, now)) {
      // Another process holds it and is within its window. Its result will land in the store; ours would be a
      // second refresh of the same token.
      throw new CommsError('TRANSIENT', 'another process is refreshing this workspace’s token', {
        hint: 'Try again in a moment.',
      });
    }
    /*
     * A marker nobody is behind any more. The token it names may or may not have been spent, and there is no way
     * to find out — so this records the uncertainty rather than gambling on a retry that could revoke a token
     * another process is using.
     */
    await deps.secrets.set(secretRef, serialiseBundle({ ...current, state: 'refresh-uncertain', attempt: undefined }));
    throw new CommsError('AUTH_REQUIRED', 'a token refresh was interrupted and cannot be retried safely', {
      hint: 'Slack refresh tokens are single-use. Run `agent-slack workspace reauth <name>`.',
    });
  }

  if (!current.refreshToken) {
    throw new CommsError('AUTH_REQUIRED', 'this credential cannot be refreshed', {
      hint: 'Run `agent-slack workspace reauth <name>`.',
    });
  }
  if (refreshExpired(current, now)) {
    // 30 days on a PKCE app. No refresh recovers from this; only a new authorisation does.
    throw new CommsError('AUTH_REQUIRED', 'the refresh token for this workspace has expired', {
      hint: 'Slack expires them 30 days after they are issued. Run `agent-slack workspace reauth <name>`.',
    });
  }

  // The marker, written **before** the request. This is the durable part: after this line, anybody who finds it
  // knows a refresh token may already have been consumed.
  const attempt = { id: randomBytes(8).toString('hex'), startedAt: now.toISOString() };
  await deps.secrets.set(secretRef, serialiseBundle({ ...current, state: 'refreshing', attempt }));

  let fresh: Omit<TokenBundle, 'v' | 'state' | 'attempt'>;
  try {
    fresh = await deps.exchange(current.refreshToken);
  } catch (error) {
    /*
     * The genuinely ambiguous case. The request may have reached Slack and its reply been lost, in which case the
     * refresh token is spent and the new one is gone with the reply — or it may never have arrived. Nothing local
     * can distinguish those, so neither token is reused and the state says so.
     */
    await deps.secrets.set(secretRef, serialiseBundle({ ...current, state: 'refresh-uncertain', attempt: undefined }));
    throw new CommsError('AUTH_REQUIRED', 'the token refresh did not complete, and cannot be retried safely', {
      hint: 'Slack refresh tokens are single-use. Run `agent-slack workspace reauth <name>`.',
      cause: error,
    });
  }

  const replacement: TokenBundle = { v: BUNDLE_VERSION, state: 'ready', ...fresh, attempt: undefined };
  /*
   * Slack answered, so the new credential exists whether or not this machine manages to write it down. A failure
   * here is retried **against the store only** — calling Slack again would spend the new refresh token to fix a
   * disk problem, and could revoke the very token this is trying to save.
   */
  await persistWithRetry(deps.secrets, secretRef, replacement);
  return replacement;
}

async function persistWithRetry(secrets: SecretStore, ref: string, bundle: TokenBundle): Promise<void> {
  const serialised = serialiseBundle(bundle);
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await secrets.set(ref, serialised);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new CommsError('UNEXPECTED', 'a refreshed Slack credential could not be stored', {
    hint: 'The old token may still work for a few hours. Run `agent-slack doctor` and then `workspace reauth`.',
    cause: lastError,
  });
}

export const REFRESH_LOCK_STALE_MS: number = LOCK_STALE_MS;
export const REFRESH_ATTEMPT_ABANDONED_MS: number = ATTEMPT_ABANDONED_MS;
