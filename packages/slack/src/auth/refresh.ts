import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CommsError, type ErrorCode, type SecretStore, withCredentialsLock, withFileLock } from '@agentcomms/core';
import {
  ATTEMPT_ABANDONED_MS,
  attemptAbandoned,
  BUNDLE_VERSION,
  isDue,
  isExpired,
  parseBundle,
  type RefreshStage,
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
 *     ├─ ok ─────────────────────────────> ready (new bundle), the store retried — never Slack
 *     ├─ not sent (DNS, connect, TLS) ───> ready again, unchanged: the token never left
 *     ├─ Slack refused without using it ─> ready again, unchanged, with Slack's code
 *     ├─ Slack said the token is dead ───> refresh-uncertain, reason `dead`
 *     └─ anything else ──────────────────> refresh-uncertain, reason `uncertain`
 *
 * and a `refreshing` marker found stale by anyone becomes `refresh-uncertain` rather than being retried, because
 * the token behind it may already be spent and nothing local can tell.
 *
 * **Every outcome is classified before anything is written**, and that is the lesson of the first version, which
 * sent every failure to `refresh-uncertain`. A laptop that was offline for the first read of the day — the
 * request never left the machine, and Slack still accepts the token — was told to re-authorise, permanently. The
 * default is still the terminal state: only a failure this can *prove* did not use the token goes back to
 * `ready`, and anything it cannot account for is treated as possibly spent.
 */

export interface RefreshDeps {
  /** The store as it is now: only for the read that decides whether a refresh is due at all. */
  secrets: SecretStore;
  /**
   * The store the credential lives in *now*, resolved under the credentials lock.
   *
   * A refresh writes a rotated, single-use refresh token. Written through a store picked before the lock, it could
   * land in a backend `agentcomms secrets migrate` had just switched away from — which the migration then empties —
   * leaving the workspace with a token Slack has already retired. So the write goes wherever the configuration says
   * the credentials are at the moment it is made, with every migration held off until it is done.
   */
  openSecrets(): Promise<SecretStore>;
  /** The config directory, whose credentials lock every change to a stored credential takes first. */
  configDir: string;
  /** Where the per-account lock file lives. Not the config lock: this one is held across a network call. */
  stateDir: string;
  now(): Date;
  /**
   * Exchanges a refresh token for a new bundle. Bounded by the caller; never retried by this module.
   *
   * What it throws is classified, so it has to say what happened: a `CommsError` whose `details.stage` names the
   * step (see {@link RefreshStage}) with `slackError` and `httpStatus` where there are any, or `fetch`'s own
   * rejection untouched, whose `cause` codes are what prove a request never left.
   */
  exchange(refreshToken: string): Promise<Omit<TokenBundle, 'v' | 'state' | 'attempt'>>;
  /** The workspace's name, so a hint can say which one to re-authorise instead of `<name>`. */
  alias?: string | undefined;
  /** How long, and how patiently, the write after Slack answered is retried. Tests shorten it. */
  persist?: PersistPolicy | undefined;
}

export interface PersistPolicy {
  readonly budgetMs: number;
  readonly backoffMs: readonly number[];
}

/**
 * `staleMs` for the refresh lock.
 *
 * Deliberately longer than everything done while it is held: a marker write (up to twelve seconds against a
 * keychain), the bounded Slack call (thirty), and the write afterwards (up to a minute of retries, then one more
 * call) — or, when the marker write fails, the same minute spent waiting to take it back. The repository's lock
 * documentation advises against network work inside a critical section for good reason — but the alternative here
 * is releasing the lock around the one call that must not happen twice, so instead the window is made wide enough
 * that a normal refresh cannot outlive it, and the marker covers the abnormal one.
 */
const LOCK_STALE_MS = 3 * 60_000;
const LOCK_TIMEOUT_MS = 90_000;

/**
 * How long the write after a successful exchange keeps trying.
 *
 * A minute, because the thing it most often waits for is a person: a keychain call held by an OS dialog fails fast
 * until the dialog is answered, and three immediate retries — what this used to do — were over in the time it took
 * the dialog to draw. Safe to hold the locks that long, because the credentials lock renews itself and the account
 * lock's `staleMs` above is sized for it.
 */
const PERSIST: PersistPolicy = { budgetMs: 60_000, backoffMs: [250, 500, 1_000, 2_000, 4_000, 8_000] };

/**
 * How old a token Slack rejects must be before that rejection earns a refresh.
 *
 * A token Slack refuses minutes after issuing it was not killed by rotation or by a clock: an IP allowlist or a
 * removed app would refuse the next one too. Forcing a refresh for those would spend a refresh token on every
 * call, and Slack revokes the oldest access token each time — so the rule is one forced renewal per credential
 * that has actually lived a while.
 */
const FORCED_RENEWAL_MIN_AGE_MS = 10 * 60_000;

/**
 * One in-flight refresh per account per process, so concurrent callers here share a result instead of racing. The
 * workspace's name rides along, so an exit that cannot wait for one can say which workspace it left.
 */
const inFlight = new Map<string, { readonly work: Promise<TokenBundle>; readonly alias: string | undefined }>();

/**
 * A result this process holds and could not write down, per account.
 *
 * After Slack answers, the old refresh token is spent; if every write of the new one fails, throwing it away
 * would leave the workspace with nothing anyone can renew. So it is kept here, used by this process, and written
 * on the next call or as the process exits (see `settleRefreshes`) — under both locks, and only over the marker it
 * came from (see `settlePending`), because by then something else may have written a credential that is newer
 * than it.
 */
interface PendingWrite {
  readonly secretRef: string;
  readonly attemptId: string;
  readonly bundle: TokenBundle;
  /** Whether `bundle` is a credential Slack issued and nothing else holds, rather than an outcome to record. */
  readonly renewed: boolean;
  readonly deps: RefreshDeps;
}
const pendingWrites = new Map<string, PendingWrite>();

function lockPathFor(stateDir: string, accountId: string): string {
  return join(stateDir, 'slack', `${accountId}.refresh.lock`);
}

function reauthHint(alias: string | undefined): string {
  return `Run \`agent-slack workspace reauth ${alias ?? '<name>'}\`.`;
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
  const bundle = await withInFlight(deps, accountId, secretRef, undefined);
  return { token: bundle.accessToken, bundle };
}

/**
 * A fresh token to replace one Slack has just rejected, or null when there is none to be had.
 *
 * `accessTokenFor` trusts the stored expiry, and two things make it wrong: a clock more than ten minutes out, and
 * another sign-in of the same user and app whose refreshes revoke this one's access token (Slack keeps two).
 * Either way the bundle says `ready` with hours left and every call fails — for up to twelve hours, since nothing
 * else would start a refresh. So a rejection is allowed to force one, once, under the same locks as any other.
 *
 * Null means "report Slack's refusal as it was": the credential cannot be refreshed, it was issued moments ago
 * (see `FORCED_RENEWAL_MIN_AGE_MS`), or the refresh itself did not produce a different token.
 */
export async function renewRejectedToken(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
  rejected: string,
): Promise<string | null> {
  // A credential that cannot be renewed comes back unchanged — the same token — rather than as an error, so an
  // ordinary caller that joined this call in flight gets a bundle as it always does.
  const bundle = await withInFlight(deps, accountId, secretRef, rejected);
  return bundle.accessToken === rejected ? null : bundle.accessToken;
}

async function withInFlight(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
  rejected: string | undefined,
): Promise<TokenBundle> {
  const existing = inFlight.get(accountId);
  if (existing) {
    const shared = await existing.work;
    // A caller replacing a rejected token cannot settle for that same token back from somebody else's call.
    if (rejected === undefined || shared.accessToken !== rejected) return shared;
  }

  const work = (async (): Promise<TokenBundle> => {
    /*
     * Read outside the lock first: the overwhelmingly common case is a token with hours left, and taking a lock
     * to discover that would serialise every call in the process for no reason. Not when a result is waiting to
     * be written, though — that write needs the locks, and the next call is when it is owed.
     */
    if (!pendingWrites.has(accountId)) {
      deps.secrets.invalidate(secretRef);
      const current = requireBundle(await deps.secrets.get(secretRef), deps.alias);
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
      if (current.accessToken !== rejected && stillUsable(current, deps.now())) return current;
    }

    /*
     * The credentials lock first, then this account's: the order everything takes them in — credentials before
     * config, credentials before anything narrower — so a refresh can never hold one while waiting for the other in
     * the opposite order to a migration or a removal. Held across the Slack call, and renewed while it runs, because
     * the write it protects is the one that call produces.
     */
    return withCredentialsLock(
      deps.configDir,
      () =>
        withFileLock(
          lockPathFor(deps.stateDir, accountId),
          async () => refreshUnderLock({ ...deps, secrets: await deps.openSecrets() }, accountId, secretRef, rejected),
          { staleMs: LOCK_STALE_MS, timeoutMs: LOCK_TIMEOUT_MS },
        ),
      { timeoutMs: LOCK_TIMEOUT_MS },
    );
  })();

  inFlight.set(accountId, { work, alias: deps.alias });
  try {
    return await work;
  } finally {
    if (inFlight.get(accountId)?.work === work) inFlight.delete(accountId);
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

/** Whether a result this process could not write down holds a token to use: current, and not the one Slack refused. */
function keptTokenUsable(pending: PendingWrite, rejected: string | undefined, now: Date): boolean {
  return (
    pending.bundle.state === 'ready' && pending.bundle.accessToken !== rejected && stillUsable(pending.bundle, now)
  );
}

function requireBundle(raw: string | null, alias?: string): TokenBundle {
  const bundle = parseBundle(raw);
  if (!bundle) {
    throw new CommsError('AUTH_REQUIRED', 'this workspace has no stored credential', {
      hint: alias ? reauthHint(alias) : 'Connect it with `agent-slack workspace add`.',
    });
  }
  return bundle;
}

async function refreshUnderLock(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
  rejected: string | undefined,
): Promise<TokenBundle> {
  /*
   * Re-read inside the lock, and invalidate the cache first.
   *
   * Another process may have refreshed while this one waited, in which case there is nothing to do — and the
   * keychain wrapper caches, so without the invalidation this would read its own stale copy and refresh a token
   * that was replaced thirty seconds ago.
   */
  deps.secrets.invalidate(secretRef);
  const now = deps.now();
  const pending = pendingWrites.get(accountId);
  let raw: string | null;
  try {
    raw = await deps.secrets.get(secretRef);
  } catch (error) {
    /*
     * A store that cannot be read is no more able to take the kept result than one that cannot be written, and the
     * keychain is both at once while a dialog holds an earlier call — the very case a result gets kept for. So the
     * token this process holds is used here too, rather than every call failing until the store comes back.
     */
    if (pending && keptTokenUsable(pending, rejected, now)) return pending.bundle;
    throw error;
  }
  let current = requireBundle(raw, deps.alias);

  if (pending) {
    const outcome = await settlePending(deps.secrets, accountId, secretRef, pending, current);
    if (outcome === 'written') {
      current = pending.bundle;
    } else if (outcome !== 'stale') {
      // Still unwritable. The token it holds is the only live one this workspace has, so while it lasts it is
      // used rather than refused; once it is due there is nothing safe left to do but say why.
      if (keptTokenUsable(pending, rejected, now)) return pending.bundle;
      const renewed = pending.bundle.refreshToken !== current.refreshToken;
      throw new CommsError(
        'SECRET_STORE_UNAVAILABLE',
        renewed
          ? 'a renewed Slack credential still cannot be stored'
          : 'the outcome of the last token refresh still cannot be stored',
        {
          hint: renewed
            ? 'This process holds the only copy of the renewed token. Fix the secret store (run `agentcomms doctor`) ' +
              `and try again from this same session; if it has ended, ${reauthHint(deps.alias).toLowerCase()}`
            : 'Fix the secret store (run `agentcomms doctor`), then try again.',
          details: { stage: 'store' },
          cause: outcome.error,
        },
      );
    }
  }

  const forced = rejected !== undefined && current.accessToken === rejected;
  if (!forced && stillUsable(current, now)) return current;

  if (current.state === 'refresh-uncertain') {
    if (forced) return current;
    const details = reasonDetails(current);
    throw new CommsError('AUTH_REQUIRED', uncertainMessage(current), {
      hint: `Slack refresh tokens are single-use. ${reauthHint(deps.alias)}`,
      ...(details ? { details } : {}),
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
     * another process is using. The attempt is named in the reason, so the process that made it — if it is alive
     * and holding the result — can still write it over this.
     */
    await deps.secrets.set(
      secretRef,
      serialiseBundle({
        ...current,
        state: 'refresh-uncertain',
        attempt: undefined,
        reason: { kind: 'interrupted', attemptId: current.attempt?.id, at: now.toISOString() },
      }),
    );
    throw new CommsError('AUTH_REQUIRED', 'a token refresh was interrupted and cannot be retried safely', {
      hint: `Slack refresh tokens are single-use. ${reauthHint(deps.alias)}`,
      details: { reason: 'interrupted' },
    });
  }

  /*
   * A state this version does not know is not a licence to refresh.
   *
   * Only `ready` may be refreshed. A later version that adds a state will have added it because the credential
   * needs handling this one cannot give — and the one thing sure to be wrong is presenting a refresh token that
   * version decided to stop presenting. This is the rule 0.4.0 lacked, and the reason the terminal states above
   * are one string with a reason rather than several.
   */
  if (current.state !== 'ready') {
    if (forced) return current;
    throw new CommsError('AUTH_REQUIRED', `the stored credential is in a state this version does not know`, {
      hint: `Upgrade agent-slack, or ${reauthHint(deps.alias).toLowerCase()}`,
      details: { state: String(current.state) },
    });
  }

  if (!current.refreshToken) {
    if (forced) return current;
    throw new CommsError('AUTH_REQUIRED', 'this credential cannot be refreshed', { hint: reauthHint(deps.alias) });
  }
  if (refreshExpired(current, now)) {
    if (forced) return current;
    // 30 days on a PKCE app. No refresh recovers from this; only a new authorisation does.
    throw new CommsError('AUTH_REQUIRED', 'the refresh token for this workspace has expired', {
      hint: `Slack expires them 30 days after they are issued. ${reauthHint(deps.alias)}`,
    });
  }
  if (forced && now.getTime() - Date.parse(current.issuedAt) < FORCED_RENEWAL_MIN_AGE_MS) return current;

  return refreshNow(deps, accountId, secretRef, current, current.refreshToken, now);
}

async function refreshNow(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
  current: TokenBundle,
  refreshToken: string,
  now: Date,
): Promise<TokenBundle> {
  // The marker, written **before** the request. This is the durable part: after this line, anybody who finds it
  // knows a refresh token may already have been consumed.
  const attempt = { id: randomBytes(8).toString('hex'), startedAt: now.toISOString() };
  try {
    await deps.secrets.set(secretRef, serialiseBundle({ ...current, state: 'refreshing', attempt, reason: undefined }));
  } catch (error) {
    await withdrawMarker(deps, accountId, secretRef, current, attempt.id);
    throw error;
  }

  let fresh: Omit<TokenBundle, 'v' | 'state' | 'attempt'>;
  try {
    fresh = await deps.exchange(refreshToken);
  } catch (error) {
    const failure = classifyRefreshFailure(error);
    const unchanged = failure.kind === 'not-sent' || failure.kind === 'refused';
    /*
     * What the store should say now, decided by what is *known* about the token.
     *
     * Not sent, or refused by Slack before it looked at the token: the old refresh token is exactly as good as
     * it was, so the credential goes back to `ready` and the next call simply tries again. Anything else keeps
     * the rule the first version applied to everything — the token may be spent, so it is never presented again.
     */
    const settled: TokenBundle = unchanged
      ? { ...current, state: 'ready', attempt: undefined, reason: undefined }
      : {
          ...current,
          state: 'refresh-uncertain',
          attempt: undefined,
          reason: {
            kind: failure.kind === 'dead' ? 'dead' : 'uncertain',
            stage: failure.stage,
            slackError: failure.slackError,
            httpStatus: failure.httpStatus,
            networkCode: failure.networkCode,
            attemptId: attempt.id,
            at: now.toISOString(),
          },
        };
    const storeError = await persist(deps, secretRef, settled);
    if (storeError !== null) {
      pendingWrites.set(accountId, { secretRef, attemptId: attempt.id, bundle: settled, renewed: false, deps });
    }
    throw failureError(failure, error, deps.alias);
  }

  const replacement: TokenBundle = { v: BUNDLE_VERSION, state: 'ready', ...fresh, attempt: undefined };
  /*
   * Slack answered, so the new credential exists whether or not this machine manages to write it down. A failure
   * here is retried **against the store only** — calling Slack again would spend the new refresh token to fix a
   * disk problem, and could revoke the very token this is trying to save.
   *
   * And if the store never recovers, the result is still returned. The old refresh token is gone; this one is the
   * workspace's only credential, and throwing it away to report a storage error turned a slow keychain into a
   * forced re-authorisation. It is kept for this process and written on its next call.
   */
  const storeError = await persist(deps, secretRef, replacement);
  if (storeError !== null) {
    pendingWrites.set(accountId, { secretRef, attemptId: attempt.id, bundle: replacement, renewed: true, deps });
  }
  return replacement;
}

/**
 * Takes back a marker whose write was reported failed, if it landed anyway — before the locks are released.
 *
 * Nothing was sent: the exchange never started. But a keychain write that timed out is not a write that did not
 * happen. The native call stays pending on the OS dialog, and when the person clicks Allow the marker lands with no
 * process behind it. Everyone after that is told another process is refreshing, and two minutes later that a
 * refresh was interrupted — a re-authorisation for a token that never left this machine. Releasing the locks first
 * would be worse still: another process could refresh, and then have its result overwritten by the late marker.
 *
 * So this waits for the store to settle, for as long as the write after an exchange would and no longer, and
 * looks. This attempt's marker, if it is there, goes back to `ready`. If the store still cannot say — the dialog is
 * still up — the unchanged credential is kept as a pending write: the next call in this process, or its exit,
 * writes it over the marker if it has landed by then, and drops it if it never does (see `settlePending`).
 */
async function withdrawMarker(
  deps: RefreshDeps,
  accountId: string,
  secretRef: string,
  current: TokenBundle,
  attemptId: string,
): Promise<void> {
  const unchanged: TokenBundle = { ...current, state: 'ready', attempt: undefined, reason: undefined };
  if (deps.secrets.settled) await within(deps.secrets.settled(), (deps.persist ?? PERSIST).budgetMs);
  try {
    deps.secrets.invalidate(secretRef);
    const found = parseBundle(await deps.secrets.get(secretRef));
    if (found?.state !== 'refreshing' || found.attempt?.id !== attemptId) return;
    await deps.secrets.set(secretRef, serialiseBundle(unchanged));
  } catch {
    pendingWrites.set(accountId, { secretRef, attemptId, bundle: unchanged, renewed: false, deps });
  }
}

/**
 * Writes one value that cannot be got again, patiently. Returns the last error, or null once it is stored.
 *
 * Waits for the store to be free between tries, not just for a timer: the keychain fails every call fast while
 * an earlier one is still held by an OS dialog, and three instant retries against that — what this used to do —
 * collapsed into one. The real clock, not `deps.now`, because this measures time actually spent.
 */
async function persist(deps: RefreshDeps, ref: string, bundle: TokenBundle): Promise<unknown | null> {
  const policy = deps.persist ?? PERSIST;
  const serialised = serialiseBundle(bundle);
  const deadline = Date.now() + policy.budgetMs;
  let lastError: unknown = null;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await deps.secrets.set(ref, serialised);
      return null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) return lastError;
    if (deps.secrets.settled) await within(deps.secrets.settled(), deadline - Date.now());
    const pause = Math.min(
      policy.backoffMs[Math.min(attempt, policy.backoffMs.length - 1)] ?? 0,
      deadline - Date.now(),
    );
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

async function within(work: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Writes a result this process kept, if the store still holds the marker it belongs to.
 *
 * The guard is the whole point. Between the failed write and this one, another path may have written something
 * newer: a re-authorisation, or another process that found the marker stale. Only two things are ours to
 * overwrite — the `refreshing` marker with this attempt's id, or the `refresh-uncertain` another process made of
 * that same marker, which names the attempt in its reason. Anything else wins, and the kept result is dropped.
 */
async function settlePending(
  secrets: SecretStore,
  accountId: string,
  secretRef: string,
  pending: PendingWrite,
  current: TokenBundle,
): Promise<'written' | 'stale' | { error: unknown }> {
  const ours =
    pending.secretRef === secretRef &&
    ((current.state === 'refreshing' && current.attempt?.id === pending.attemptId) ||
      (current.state === 'refresh-uncertain' && current.reason?.attemptId === pending.attemptId));
  if (!ours) {
    pendingWrites.delete(accountId);
    return 'stale';
  }
  try {
    await secrets.set(secretRef, serialiseBundle(pending.bundle));
  } catch (error) {
    return { error };
  }
  pendingWrites.delete(accountId);
  return 'written';
}

/** A refresh an exiting process could not settle, as the person has to be told about it. Never the token itself. */
export interface UnsettledRefresh {
  /** The workspace's name, where the caller gave one. */
  readonly workspace: string | undefined;
  /**
   * `renewed`: Slack issued a credential that only this process holds. `unrecorded`: nothing new was issued, but
   * the store may still show a refresh in progress. `running`: the refresh had not finished.
   */
  readonly kind: 'renewed' | 'unrecorded' | 'running';
  /** One line for stderr: which workspace, what happened, and what to do about it. */
  readonly message: string;
}

/**
 * Waits, up to `timeoutMs`, for every refresh this process has started, and writes down any result it is holding.
 *
 * For shutdown, of every kind. A refresh killed between Slack's reply and the write loses the only copy of the new
 * token, and an MCP client that wants its server gone sends SIGTERM without knowing one is in flight. A result
 * kept because the store failed lives only in memory, and an ordinary exit — a CLI command finishing, a client
 * closing stdin — is the last chance to write it. Resolves with what could not be settled, empty when nothing is
 * left outstanding, so the caller can say so rather than exit as though all were well.
 */
export async function settleRefreshes(timeoutMs: number): Promise<UnsettledRefresh[]> {
  const deadline = Date.now() + timeoutMs;
  await within(Promise.allSettled([...inFlight.values()].map(({ work }) => work)), timeoutMs);
  for (const [accountId, pending] of [...pendingWrites]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const { deps, secretRef } = pending;
    await within(
      withCredentialsLock(
        deps.configDir,
        () =>
          withFileLock(
            lockPathFor(deps.stateDir, accountId),
            async () => {
              const secrets = await deps.openSecrets();
              secrets.invalidate(secretRef);
              const current = parseBundle(await secrets.get(secretRef));
              if (current) await settlePending(secrets, accountId, secretRef, pending, current);
            },
            { staleMs: LOCK_STALE_MS, timeoutMs: remaining },
          ),
        { timeoutMs: remaining },
      ).catch(() => undefined),
      remaining,
    );
  }
  return [
    ...[...inFlight.values()].map(({ alias }) => unsettled(alias, 'running')),
    ...[...pendingWrites.values()].map(({ deps, renewed }) =>
      unsettled(deps.alias, renewed ? 'renewed' : 'unrecorded'),
    ),
  ];
}

/**
 * Says what was left, and what it will look like later.
 *
 * What the person will next see is not this line but a later command's "another process is refreshing", then "a
 * token refresh was interrupted" — the marker this process leaves behind — so the warning names that, and the one
 * way out of it.
 */
function unsettled(alias: string | undefined, kind: UnsettledRefresh['kind']): UnsettledRefresh {
  const name = alias ? `“${alias}”` : 'a workspace';
  const what = {
    renewed: `could not save the renewed Slack credential for ${name}, and it may be lost as this process exits`,
    unrecorded: `could not record in the secret store how the token refresh for ${name} ended`,
    running: `a token refresh for ${name} was still running when this process exited`,
  }[kind];
  const next = 'If a later command says a refresh was interrupted, the workspace needs signing in again.';
  return { workspace: alias, kind, message: `agent-slack: ${what}. ${next} ${reauthHint(alias)}` };
}

// ── Classifying a failed exchange ──────────────────────────────────────────────────────────────────────────────

/**
 * `fetch` failures that prove no request body was written: the name did not resolve, nothing answered, or TLS
 * refused the certificate during the handshake. Each happens before a byte of the form — and so of the refresh
 * token — leaves.
 *
 * Deliberately a short, exact list. `ECONNRESET`, `ETIMEDOUT`, a socket closed mid-reply, an abort: all can happen
 * after the request was written, so none of them is here, and none of them is a prefix match either — an
 * `ERR_SSL_` code can come from a record mid-stream as easily as from the handshake. When one of them comes from
 * `connect`, that is proof enough on its own; `networkEvidence` reads the syscall for that.
 */
const NOT_SENT_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  // Certificate verification, which completes before the handshake does.
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Slack refusals that mean the request was turned away before the token was looked at, so it is still good.
 *
 * From the `oauth.v2.access` error table (docs.slack.dev/reference/methods/oauth.v2.access): each describes the
 * request, the app or the workspace rather than the token — a malformed or truncated form, a client id or grant
 * type Slack does not accept, a rate limit, a workspace mid-migration. Only `internal_error` and `fatal_error` say
 * "it's possible some aspect of the operation succeeded", and they are not here.
 */
const NOT_CONSUMED: Readonly<Record<string, { code: ErrorCode; message: string; hint: string }>> = {
  ratelimited: { code: 'TRANSIENT', message: 'Slack is rate-limiting token renewals', hint: 'Try again shortly.' },
  request_timeout: {
    code: 'TRANSIENT',
    message: 'Slack received the token renewal truncated',
    hint: 'Try again in a moment.',
  },
  service_unavailable: {
    code: 'TRANSIENT',
    message: 'Slack is temporarily unavailable for token renewals',
    hint: 'Try again in a moment; if it persists, check https://status.slack.com.',
  },
  team_added_to_org: {
    code: 'TRANSIENT',
    message: 'this workspace is being moved into an Enterprise organisation',
    hint: 'Slack is intermittently unavailable until the migration finishes. Try again later.',
  },
  org_login_required: {
    code: 'TRANSIENT',
    message: 'this workspace is unavailable until its Enterprise migration completes',
    hint: 'Try again later.',
  },
  invalid_client_id: {
    code: 'CONFIG',
    message: 'Slack does not recognise the client id recorded for this workspace',
    hint: 'The app may have been deleted or recreated. Re-authorise the workspace with the current app’s Client ID.',
  },
  pkce_not_allowed: {
    code: 'CONFIG',
    message: 'the Slack app no longer allows PKCE, which this package signs in with',
    hint: 'Check the app still has PKCE enabled — `agent-slack manifest` prints the settings it needs.',
  },
  invalid_grant_type: {
    code: 'UNEXPECTED',
    message: 'Slack refused the token renewal request as malformed',
    hint: 'This is a bug — please report it.',
  },
  invalid_arguments: {
    code: 'UNEXPECTED',
    message: 'Slack refused the token renewal request as malformed',
    hint: 'This is a bug — please report it.',
  },
  invalid_form_data: {
    code: 'UNEXPECTED',
    message: 'Slack refused the token renewal request as malformed',
    hint: 'This is a bug — please report it.',
  },
  invalid_charset: {
    code: 'UNEXPECTED',
    message: 'Slack refused the token renewal request as malformed',
    hint: 'This is a bug — please report it.',
  },
};

/** Slack saying, in so many words, that the refresh token will never work again. */
const DEAD: ReadonlySet<string> = new Set([
  'invalid_refresh_token',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'access_denied',
]);

export interface RefreshFailure {
  readonly kind: 'not-sent' | 'refused' | 'dead' | 'ambiguous';
  readonly stage: RefreshStage;
  readonly slackError?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly networkCode?: string | undefined;
}

/**
 * What a failed exchange proves about the refresh token it carried.
 *
 * `ambiguous` is the default, and every other answer has to be earned by evidence: an error code that can only
 * happen before sending, or Slack's own words. That direction matters more than any single entry — a wrong
 * `ambiguous` costs a re-authorisation, and a wrong `not-sent` presents a spent token and can revoke a live one.
 */
export function classifyRefreshFailure(error: unknown): RefreshFailure {
  if (error instanceof CommsError) {
    if (error.code === 'SEND_REFUSED') return { kind: 'not-sent', stage: 'guard' };
    const details = error.details ?? {};
    const stage = typeof details.stage === 'string' ? (details.stage as RefreshStage) : undefined;
    const slackError = typeof details.slackError === 'string' ? details.slackError : undefined;
    const httpStatus = typeof details.httpStatus === 'number' ? details.httpStatus : undefined;
    if (stage === 'refused' && slackError !== undefined) {
      if (Object.hasOwn(NOT_CONSUMED, slackError)) return { kind: 'refused', stage, slackError, httpStatus };
      if (DEAD.has(slackError)) return { kind: 'dead', stage, slackError, httpStatus };
      return { kind: 'ambiguous', stage, slackError, httpStatus };
    }
    // A 429 is the rate limiter turning the request away, which is `ratelimited` without the body.
    if (stage === 'http' && httpStatus === 429) {
      return { kind: 'refused', stage, slackError: 'ratelimited', httpStatus };
    }
    // Slack said `ok:true`, so the old token is spent — and nothing usable came back to replace it.
    if (stage === 'parse') return { kind: 'dead', stage, httpStatus };
    return { kind: 'ambiguous', stage: stage ?? 'network', slackError, httpStatus };
  }
  const found = networkEvidence(error);
  const networkCode = found.find((one) => one.code !== undefined)?.code;
  if (found.length > 0 && found.every((one) => one.notSent)) {
    return { kind: 'not-sent', stage: 'network', networkCode };
  }
  return { kind: 'ambiguous', stage: 'network', networkCode };
}

interface NetworkEvidence {
  readonly code: string | undefined;
  readonly notSent: boolean;
}

/**
 * What each error in a cause chain says about the request, including each of an `AggregateError`'s errors.
 *
 * `fetch` rejects with `TypeError('fetch failed')` and puts the reason in `cause`; a connection tried over IPv4
 * and IPv6 fails with an `AggregateError` of both. Every error that carries a code or a syscall has to prove "not
 * sent" for the whole to, so one attempt that got further than the others makes the answer `ambiguous`.
 *
 * An error proves it by its code (see {@link NOT_SENT_CODES}) or by where it happened. One raised by `connect`
 * failed before there was a connection, so nothing can have been written to it — whatever its code says. That is
 * what makes a happy-eyeballs failure provable: Node drops an address that has not connected within 250 ms with an
 * `ETIMEDOUT` from `connect`, and the `AggregateError` it raises when every address has failed carries its first
 * attempt's code and no syscall. The same `ETIMEDOUT` from `read` or `write`, or with no syscall at all, can follow
 * a request that went, so it proves nothing. The aggregate counts as a `connect` failure only when every attempt
 * inside it is one.
 */
function networkEvidence(error: unknown): NetworkEvidence[] {
  const found: NetworkEvidence[] = [];
  const seen = new Set<unknown>();
  const failedToConnect = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    const { syscall, errors } = value as { syscall?: unknown; errors?: unknown };
    if (syscall === 'connect') return true;
    return Array.isArray(errors) && errors.length > 0 && errors.every(failedToConnect);
  };
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    const { code, syscall, cause, errors } = value as {
      code?: unknown;
      syscall?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    const named = typeof code === 'string' ? code : undefined;
    if (named !== undefined || typeof syscall === 'string') {
      found.push({
        code: named,
        notSent: failedToConnect(value) || (named !== undefined && NOT_SENT_CODES.has(named)),
      });
    }
    visit(cause, depth + 1);
    if (Array.isArray(errors)) for (const inner of errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return found;
}

function failureDetails(failure: RefreshFailure): Record<string, unknown> {
  return {
    stage: failure.stage,
    ...(failure.slackError !== undefined ? { slackError: failure.slackError } : {}),
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.networkCode !== undefined ? { networkCode: failure.networkCode } : {}),
  };
}

function failureError(failure: RefreshFailure, error: unknown, alias: string | undefined): CommsError {
  const details = failureDetails(failure);
  switch (failure.kind) {
    case 'not-sent':
      // The guard's own refusal already says what it means, and is a bug to report rather than a network to check.
      if (error instanceof CommsError && error.code === 'SEND_REFUSED') return error;
      return new CommsError('TRANSIENT', 'could not reach Slack to renew the token; nothing was sent', {
        hint: 'The stored credential is unchanged. Check the network, then try again.',
        details,
        cause: error,
      });
    case 'refused': {
      const known = NOT_CONSUMED[failure.slackError ?? ''] ?? {
        code: 'TRANSIENT' as const,
        message: 'Slack turned the token renewal away',
        hint: 'Try again shortly.',
      };
      return new CommsError(known.code, `${known.message} (${failure.slackError})`, {
        hint: `${known.hint} The stored credential is unchanged.`,
        details,
        cause: error,
      });
    }
    case 'dead':
      return new CommsError(
        'AUTH_REQUIRED',
        failure.stage === 'parse'
          ? 'Slack renewed the token, but its reply held no credential this could use'
          : `Slack says this workspace’s refresh token is no longer valid (${failure.slackError})`,
        { hint: reauthHint(alias), details, cause: error },
      );
    default:
      return new CommsError('AUTH_REQUIRED', 'the token refresh did not complete, and cannot be retried safely', {
        hint: `Slack refresh tokens are single-use, and this one may have been used. ${reauthHint(alias)}`,
        details,
        cause: error,
      });
  }
}

function uncertainMessage(bundle: TokenBundle): string {
  switch (bundle.reason?.kind) {
    case 'dead':
      return bundle.reason.slackError
        ? `Slack said this workspace’s refresh token is no longer valid (${bundle.reason.slackError})`
        : 'Slack renewed this workspace’s token, but the reply held no credential this could use';
    case 'interrupted':
      return 'a token refresh was interrupted and cannot be retried safely';
    default:
      return 'a previous token refresh did not finish, and cannot be retried safely';
  }
}

function reasonDetails(bundle: TokenBundle): Record<string, unknown> | undefined {
  const reason = bundle.reason;
  if (!reason) return undefined;
  return {
    reason: reason.kind,
    ...(reason.stage !== undefined ? { stage: reason.stage } : {}),
    ...(reason.slackError !== undefined ? { slackError: reason.slackError } : {}),
    ...(reason.httpStatus !== undefined ? { httpStatus: reason.httpStatus } : {}),
    ...(reason.networkCode !== undefined ? { networkCode: reason.networkCode } : {}),
  };
}

export const REFRESH_LOCK_STALE_MS: number = LOCK_STALE_MS;
export const REFRESH_ATTEMPT_ABANDONED_MS: number = ATTEMPT_ABANDONED_MS;
