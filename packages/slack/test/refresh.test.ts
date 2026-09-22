import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommsError, SecretStore } from '@agentcomms/core';
import { BUNDLE_VERSION, parseBundle, serialiseBundle, type TokenBundle } from '../src/auth/bundle.ts';
import { accessTokenFor, type RefreshDeps } from '../src/auth/refresh.ts';

/**
 * The refresh path, which is where a mistake costs a credential rather than a request.
 *
 * Fixture tokens are spelled `fake-…` rather than `xoxp-…`: the repository's own secret scanner refuses a file
 * carrying something token-shaped, which is the check working, and a fixture that looks like the real thing is
 * exactly what nobody should train themselves to skim past.
 *
 * Slack's refresh tokens are single-use and it keeps at most two access tokens alive, so every test here is
 * really the same question asked from a different angle: **can this spend a refresh token twice?**
 */

const REF = 'slack/token/acme';
const ACCOUNT = 'acc_AAAAAAAAAAAAAAAA';

/** An in-memory secret store that records every write, so a test can see the order things were committed in. */
function store(initial?: string): SecretStore & { writes: string[]; failNextSet: number } {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(REF, initial);
  const self = {
    kind: 'file' as const,
    writes: [] as string[],
    failNextSet: 0,
    async get(ref: string) {
      return values.get(ref) ?? null;
    },
    async set(ref: string, value: string) {
      if (self.failNextSet > 0) {
        self.failNextSet -= 1;
        throw new Error('the store is unavailable');
      }
      values.set(ref, value);
      self.writes.push(parseBundle(value)?.state ?? '?');
    },
    async delete(ref: string) {
      return values.delete(ref);
    },
    invalidate() {},
  };
  return self;
}

const AT = (iso: string) => new Date(iso);
const NOW = AT('2026-09-22T12:00:00.000Z');

/** Already expired, so the state machine below is reachable at all. */
const DUE = '2026-09-22T11:00:00.000Z';

function bundle(over: Partial<TokenBundle> = {}): TokenBundle {
  return {
    v: BUNDLE_VERSION,
    state: 'ready',
    accessToken: 'fake-access-old',
    // Twelve hours out, so nothing is due unless a test says so.
    accessExpiresAt: '2026-09-23T00:00:00.000Z',
    refreshToken: 'fake-refresh-1',
    refreshExpiresAt: '2026-10-22T12:00:00.000Z',
    issuedAt: '2026-09-22T00:00:00.000Z',
    ...over,
  };
}

async function deps(secrets: SecretStore, exchange: RefreshDeps['exchange']): Promise<RefreshDeps> {
  return { secrets, stateDir: await mkdtemp(join(tmpdir(), 'slack-refresh-')), now: () => NOW, exchange };
}

test('a token with hours left is used as it is, and nothing is written', async () => {
  const secrets = store(serialiseBundle(bundle()));
  const d = await deps(secrets, async () => assert.fail('it refreshed a token that was not due'));
  const { token } = await accessTokenFor(d, ACCOUNT, REF);
  assert.equal(token, 'fake-access-old');
  assert.deepEqual(secrets.writes, [], 'a read-only path wrote to the secret store');
});

test('the refreshing marker is written before the request, not after', async () => {
  /*
   * The whole design rests on this order. A marker written after the call proves nothing about a call that never
   * returned — and the state that matters is exactly "a refresh token may already be spent".
   */
  const secrets = store(serialiseBundle(bundle({ accessExpiresAt: '2026-09-22T12:01:00.000Z' })));
  let markerAtCallTime: string | undefined;
  const d = await deps(secrets, async () => {
    markerAtCallTime = parseBundle(await secrets.get(REF))?.state;
    return {
      accessToken: 'fake-access-new',
      accessExpiresAt: '2026-09-23T00:00:00.000Z',
      refreshToken: 'fake-refresh-2',
      refreshExpiresAt: '2026-10-22T12:00:00.000Z',
      issuedAt: NOW.toISOString(),
    };
  });

  const { token } = await accessTokenFor(d, ACCOUNT, REF);
  assert.equal(markerAtCallTime, 'refreshing', 'the request went out before the marker was stored');
  assert.equal(token, 'fake-access-new');
  assert.deepEqual(secrets.writes, ['refreshing', 'ready']);
  assert.equal(
    parseBundle(await secrets.get(REF))?.refreshToken,
    'fake-refresh-2',
    'the new refresh token was not kept',
  );
});

test('a refresh that does not come back leaves the credential uncertain, never retried', async () => {
  const secrets = store(serialiseBundle(bundle({ accessExpiresAt: '2026-09-22T12:01:00.000Z' })));
  let calls = 0;
  const d = await deps(secrets, async () => {
    calls += 1;
    throw new Error('socket hang up');
  });

  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), (error: CommsError) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.match(error.message, /did not complete/);
    return true;
  });
  assert.equal(calls, 1, 'an ambiguous refresh was retried, which can spend the token twice');

  const after = parseBundle(await secrets.get(REF));
  assert.equal(after?.state, 'refresh-uncertain');
  // The old access token is kept: it may still have hours on it, and refusing to use it helps nobody.
  assert.equal(after?.accessToken, 'fake-access-old');
});

test('an uncertain credential is not retried once its access token is due', async () => {
  const secrets = store(serialiseBundle(bundle({ state: 'refresh-uncertain', accessExpiresAt: DUE })));
  const d = await deps(secrets, async () => assert.fail('it refreshed after an uncertain outcome'));
  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), /cannot be retried safely/);
});

test('an uncertain credential still hands back an access token that has not expired', async () => {
  /*
   * `state` is about the *refresh* token — in flight, or possibly already spent — and none of that changes
   * whether the access token in hand still works for the next few hours.
   *
   * Demanding `ready` here turned an interrupted refresh into an immediate total outage rather than a workspace
   * that keeps reading until somebody re-authorises. `doctor` reports the state as a failure either way, so
   * letting reads continue hides nothing.
   */
  const secrets = store(serialiseBundle(bundle({ state: 'refresh-uncertain' })));
  const d = await deps(secrets, async () => assert.fail('it refreshed a token that was not due'));
  const { token, bundle: got } = await accessTokenFor(d, ACCOUNT, REF);
  assert.equal(token, 'fake-access-old');
  assert.equal(got.state, 'refresh-uncertain', 'using the token quietly repaired the state');
});

test('a live refreshing marker makes another caller wait rather than refresh too', async () => {
  const secrets = store(
    serialiseBundle(
      bundle({ state: 'refreshing', accessExpiresAt: DUE, attempt: { id: 'a1', startedAt: NOW.toISOString() } }),
    ),
  );
  const d = await deps(secrets, async () => assert.fail('two processes refreshed the same token'));
  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), (error: CommsError) => {
    assert.equal(error.code, 'TRANSIENT', 'a live refresh should be waited for, not treated as broken');
    return true;
  });
});

test('a marker left by a dead process becomes uncertain, not a second refresh', async () => {
  // The case a file lock cannot cover: the holder died, so the lock is gone, but the token it named may be spent.
  const secrets = store(
    serialiseBundle(
      bundle({
        state: 'refreshing',
        accessExpiresAt: DUE,
        attempt: { id: 'a1', startedAt: '2026-09-22T11:50:00.000Z' },
      }),
    ),
  );
  const d = await deps(secrets, async () => assert.fail('it retried a refresh token that may already be spent'));
  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), /interrupted/);
  assert.equal(parseBundle(await secrets.get(REF))?.state, 'refresh-uncertain');
});

test('an expired refresh token sends you to reauth instead of trying', async () => {
  // 30 days on a PKCE app. Nothing recovers from this except a new authorisation.
  const secrets = store(
    serialiseBundle(
      bundle({ accessExpiresAt: '2026-09-22T12:01:00.000Z', refreshExpiresAt: '2026-09-01T00:00:00.000Z' }),
    ),
  );
  const d = await deps(secrets, async () => assert.fail('it tried to use an expired refresh token'));
  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), (error: CommsError) => {
    assert.match(error.message, /refresh token .* has expired/);
    assert.match(error.hint ?? '', /30 days/);
    return true;
  });
});

test('a store that fails after Slack answered is retried against the store, never against Slack', async () => {
  /*
   * Slack has already issued the new credential, so the old refresh token is spent. Calling Slack again to fix a
   * disk problem would spend the *new* one too — and Slack keeps only two access tokens, so it could revoke the
   * token this is trying to save.
   */
  const secrets = store(serialiseBundle(bundle({ accessExpiresAt: '2026-09-22T12:01:00.000Z' })));
  let calls = 0;
  const d = await deps(secrets, async () => {
    calls += 1;
    // Fail the first store write that happens after this returns.
    secrets.failNextSet = 1;
    return {
      accessToken: 'fake-access-new',
      accessExpiresAt: '2026-09-23T00:00:00.000Z',
      refreshToken: 'fake-refresh-2',
      refreshExpiresAt: '2026-10-22T12:00:00.000Z',
      issuedAt: NOW.toISOString(),
    };
  });

  const { token } = await accessTokenFor(d, ACCOUNT, REF);
  assert.equal(token, 'fake-access-new');
  assert.equal(calls, 1, 'Slack was called again to recover from a storage failure');
});

test('three callers at once cause exactly one refresh', async () => {
  /*
   * The guarantee is "one refresh", and two things provide it: the in-process map, which makes concurrent
   * callers share a result, and the file lock behind it, which serialises them so the later ones re-read and
   * find nothing due. Removing the map does not break this test, and that is the useful fact — the lock alone
   * is sufficient, and the map is an optimisation rather than the thing keeping the token safe.
   */
  const secrets = store(serialiseBundle(bundle({ accessExpiresAt: '2026-09-22T12:01:00.000Z' })));
  let calls = 0;
  const d = await deps(secrets, async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      accessToken: 'fake-access-new',
      accessExpiresAt: '2026-09-23T00:00:00.000Z',
      refreshToken: 'fake-refresh-2',
      refreshExpiresAt: '2026-10-22T12:00:00.000Z',
      issuedAt: NOW.toISOString(),
    };
  });

  const results = await Promise.all([
    accessTokenFor(d, ACCOUNT, REF),
    accessTokenFor(d, ACCOUNT, REF),
    accessTokenFor(d, ACCOUNT, REF),
  ]);
  assert.equal(calls, 1, `three callers caused ${calls} refreshes, and each one spends a single-use token`);
  for (const { token } of results) assert.equal(token, 'fake-access-new');
});

test('a credential that is not a bundle says reauth rather than pretending there is none', async () => {
  const secrets = store('not json at all');
  const d = await deps(secrets, async () => assert.fail('unreachable'));
  await assert.rejects(accessTokenFor(d, ACCOUNT, REF), (error: CommsError) => {
    assert.equal(error.code, 'BAD_DATA');
    assert.match(error.hint ?? '', /reauth/);
    return true;
  });
});
