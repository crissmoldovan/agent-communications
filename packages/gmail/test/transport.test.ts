import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ClientConfig, CommsError } from '@agent-communications/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES, scopesFor } from '../src/auth/scopes.ts';
import { TokenSource } from '../src/auth/session.ts';
import { describeGoogleError, isRetryable, mapGoogleError, parseRetryAfter } from '../src/gmail-api/errors.ts';
import { createLimiter, withRetry } from '../src/gmail-api/retry.ts';
import { GoogleGmailTransport } from '../src/gmail-api/transport.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './support/harness.ts';

const REDIRECT = 'http://127.0.0.1:5123/';

/** Signs in through the fake server and returns a transport for the resulting inbox. */
async function connect(
  harness: Harness,
  options: { alias?: string; scopes?: string[]; sub?: string; email?: string } = {},
): Promise<{ transport: GoogleGmailTransport; refreshToken: string }> {
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client: { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET },
    endpoints: harness.endpoints,
    redirectUri: REDIRECT,
    scopes: options.scopes ?? scopesFor('organize', true),
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl, { sub: options.sub })).searchParams.get('code') ?? '';
  const granted = await exchangeCode({
    client: { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET },
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: REDIRECT,
  });
  const alias = options.alias ?? 'work';
  const inbox = await harness.addInbox({
    alias,
    email: options.email ?? 'jo@example.test',
    sub: options.sub ?? 'sub-1',
    refreshToken: granted.refreshToken,
    grantedScopes: granted.grantedScopes,
  });
  const config = await harness.core.config.load();
  const tokens = new TokenSource({
    core: harness.core,
    endpoints: harness.endpoints,
    inbox,
    client: defaultClient(config),
    alias,
  });
  return {
    transport: new GoogleGmailTransport({
      tokens,
      endpoints: harness.endpoints,
      retry: { sleep: async () => undefined },
    }),
    refreshToken: granted.refreshToken,
  };
}

test('the transport reads the profile, labels and send-as addresses through the Google libraries', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { transport } = await connect(harness);

  const profile = await transport.getProfile();
  assert.equal(profile.emailAddress, 'jo@example.test');
  assert.equal(profile.messagesTotal, 42);

  const labels = await transport.listLabels();
  assert.deepEqual(
    labels.map((l) => `${l.type}:${l.name}`),
    ['system:INBOX', 'user:Clients'],
  );

  const sendAs = await transport.listSendAs();
  assert.equal(sendAs[0]?.sendAsEmail, 'jo@example.test');
  assert.equal(sendAs[0]?.isDefault, true);

  // The access token came from our TokenSource, not from the library holding a refresh token.
  assert.ok(harness.google.requests.some((r) => r.path === '/gmail/v1/users/me/profile'));
});

test('a rate-limited call is retried and then succeeds; Retry-After is honoured', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { transport } = await connect(harness);
  harness.google.failNext('/gmail/v1/users/me/profile', 1, 429, 'rateLimitExceeded', '2');
  const profile = await transport.getProfile();
  assert.equal(profile.emailAddress, 'jo@example.test');
  assert.equal(harness.google.requests.filter((r) => r.path === '/gmail/v1/users/me/profile').length, 2);

  harness.google.failNext('/gmail/v1/users/me/labels', 2, 503);
  assert.equal((await transport.listLabels()).length, 2);
});

test('a failure that keeps repeating is reported with what to do, not retried forever', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { transport } = await connect(harness);
  harness.google.failNext('/gmail/v1/users/me/profile', 10, 429, 'rateLimitExceeded');
  await assert.rejects(
    transport.getProfile(),
    (error: unknown) => error instanceof CommsError && error.code === 'TRANSIENT' && error.exitCode === 75,
  );
  const attempts = harness.google.requests.filter((r) => r.path === '/gmail/v1/users/me/profile').length;
  assert.equal(attempts, 5, 'five attempts, then the caller is told');
});

test('a disabled API names the console URL from the error; a missing scope names the reauth command', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { transport } = await connect(harness);

  harness.google.failNext('/gmail/v1/users/me/profile', 1, 403, 'accessNotConfigured');
  await assert.rejects(transport.getProfile(), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'CONFIG');
    assert.match(error.hint ?? '', /console\.developers\.google\.com\/apis\/api\/gmail/);
    return true;
  });

  // An inbox granted only `openid email` cannot read: Gmail answers 403 with the scope reason.
  const readless = await newHarness({
    accounts: [{ sub: 'sub-2', email: 'sam@example.test', grantScopes: [SCOPES.openid, SCOPES.email] }],
  });
  const { transport: limited } = await connect(readless, { alias: 'limited', sub: 'sub-2', email: 'sam@example.test' });
  await assert.rejects(limited.getProfile(), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'SCOPE_MISSING');
    assert.equal(error.exitCode, 77);
    assert.match(error.hint ?? '', /inbox reauth limited/);
    return true;
  });
});

test('a revoked grant surfaces as re-authorise, not as an unexplained 401 loop', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const { transport, refreshToken } = await connect(harness);
  await transport.getProfile();
  harness.google.revoke(refreshToken);
  harness.google.failNext('/gmail/v1/users/me/profile', 3, 401);
  await assert.rejects(
    transport.getProfile(),
    (error: unknown) => error instanceof CommsError && error.code === 'AUTH_REQUIRED',
  );
});

test('retry classification: what may be repeated, and what a send may never repeat', async () => {
  const rateLimited = { response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } };
  const forbidden = { response: { status: 403, data: { error: { errors: [{ reason: 'domainPolicy' }] } } } };
  assert.ok(isRetryable(describeGoogleError(rateLimited)));
  assert.ok(isRetryable(describeGoogleError({ response: { status: 500 } })));
  assert.ok(isRetryable(describeGoogleError({ code: 'ECONNRESET', message: 'socket hang up' })));
  assert.ok(!isRetryable(describeGoogleError(forbidden)));
  assert.ok(!isRetryable(describeGoogleError({ response: { status: 404 } })));

  let calls = 0;
  const flaky = async (): Promise<string> => {
    calls++;
    if (calls < 3) throw rateLimited;
    return 'ok';
  };
  assert.equal(await withRetry(flaky, { sleep: async () => undefined }), 'ok');
  assert.equal(calls, 3);

  // `never` is what a send uses: one attempt, whatever the failure.
  calls = 0;
  await assert.rejects(withRetry(flaky, { mode: 'never', sleep: async () => undefined }));
  assert.equal(calls, 1);

  // Without an HTTP answer the request may have been received, so only a safe call retries.
  calls = 0;
  const dropped = async (): Promise<string> => {
    calls++;
    throw { code: 'ECONNRESET', message: 'socket hang up' };
  };
  await assert.rejects(withRetry(dropped, { mode: 'rate-limit-only', sleep: async () => undefined }));
  assert.equal(calls, 1);

  const waited: number[] = [];
  await assert.rejects(
    withRetry(async () => Promise.reject(rateLimited), {
      attempts: 3,
      sleep: async (ms) => {
        waited.push(ms);
      },
      random: () => 1,
    }),
  );
  assert.deepEqual(waited, [500, 1000]);
});

test('Retry-After is read as seconds or a date, and capped', () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  assert.equal(parseRetryAfter('2', now), 2000);
  assert.equal(parseRetryAfter('2026-09-18T12:00:30Z', now), 30_000);
  assert.equal(parseRetryAfter('99999', now), 60_000);
  assert.equal(parseRetryAfter('-5', now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
  assert.equal(parseRetryAfter('nonsense', now), undefined);
});

test('the per-inbox limiter keeps at most five calls in flight', async () => {
  const limit = createLimiter(5);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 20 }, () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      }),
    ),
  );
  assert.equal(peak, 5);
  assert.equal(active, 0);
});

test('unexpected failures keep their meaning: not found, unreachable, bad request', () => {
  assert.equal(
    mapGoogleError({ response: { status: 404, data: { error: { message: 'Not Found' } } } }).code,
    'NOT_FOUND',
  );
  assert.equal(mapGoogleError({ message: 'fetch failed' }).code, 'PROVIDER_UNAVAILABLE');
  assert.equal(mapGoogleError({ response: { status: 400, data: { error: { message: 'bad' } } } }).code, 'BAD_DATA');
  const existing = new CommsError('POLICY_NEVER', 'x');
  assert.equal(mapGoogleError(existing), existing);
});

/** The client row the harness registered; a test that cannot find it should fail loudly, not assert non-null. */
function defaultClient(config: { clients: Record<string, ClientConfig> }): ClientConfig {
  const client = config.clients.default;
  if (!client) throw new Error('the harness did not register a default client');
  return client;
}
