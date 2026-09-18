import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ClientConfig, CommsError } from '@cloudpixel/comms-core';
import { GOOGLE_ENDPOINTS, isLoopbackHost, resolveEndpoints } from '../src/auth/endpoints.ts';
import { buildAuthUrl, exchangeCode, newPkce, newState, parseClientJson, revokeToken } from '../src/auth/oauth.ts';
import { capabilitiesOf, grantHint, parseGrantedScopes, SCOPES, scopesFor, tierOf } from '../src/auth/scopes.ts';
import { clientSecretRef, refreshTokenRef, TokenSource } from '../src/auth/session.ts';
import { newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './support/harness.ts';

const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };

test('endpoints default to Google and may only be redirected to a loopback test server', () => {
  assert.deepEqual(resolveEndpoints({}), GOOGLE_ENDPOINTS);
  const local = resolveEndpoints({ AGENT_COMMS_GOOGLE_ROOT_URL: 'http://127.0.0.1:8123' });
  assert.equal(local.tokenUrl, 'http://127.0.0.1:8123/token');
  assert.equal(local.gmailRoot, 'http://127.0.0.1:8123/');
  for (const bad of ['https://evil.test', 'http://169.254.169.254', 'http://127.0.0.1.evil.test', 'not a url']) {
    assert.throws(
      () => resolveEndpoints({ AGENT_COMMS_GOOGLE_ROOT_URL: bad }),
      (error: unknown) => error instanceof CommsError && error.code === 'CONFIG',
      bad,
    );
  }
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('localhost') && isLoopbackHost('[::1]'));
  assert.ok(!isLoopbackHost('127.0.0.1.evil.test') && !isLoopbackHost('10.0.0.1'));
});

test('tiers map to scopes, and granted scopes map back to capabilities', () => {
  assert.deepEqual(scopesFor('read', false), [SCOPES.openid, SCOPES.email, SCOPES.gmailReadonly]);
  assert.deepEqual(scopesFor('organize', true), [
    SCOPES.openid,
    SCOPES.email,
    SCOPES.gmailModify,
    SCOPES.contacts,
    SCOPES.otherContacts,
  ]);
  assert.deepEqual([...capabilitiesOf([SCOPES.gmailModify])], ['read', 'draft', 'organize']);
  assert.deepEqual([...capabilitiesOf([SCOPES.gmailReadonly])], ['read']);
  // A user who unticked "compose" on the consent screen keeps reading, and can no longer draft.
  assert.equal(tierOf([SCOPES.gmailReadonly]), 'read');
  assert.equal(tierOf([SCOPES.gmailReadonly, SCOPES.gmailCompose]), 'draft');
  assert.equal(tierOf([SCOPES.email]), null);
  assert.deepEqual(parseGrantedScopes('openid email  https://www.googleapis.com/auth/gmail.readonly'), [
    'openid',
    SCOPES.email,
    SCOPES.gmailReadonly,
  ]);
  assert.match(grantHint('work', 'organize'), /inbox reauth work --tier organize/);
  assert.match(grantHint('work', 'contacts'), /--contacts/);
});

test('the consent URL carries PKCE S256, a state and login_hint, and hd only when asked for', () => {
  const pkce = newPkce();
  const state = newState();
  const url = new URL(
    buildAuthUrl({
      client,
      endpoints: GOOGLE_ENDPOINTS,
      redirectUri: 'http://127.0.0.1:5123/',
      scopes: scopesFor('draft', false),
      state,
      codeChallenge: pkce.challenge,
      loginHint: 'jo@company.test',
    }),
  );
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
  assert.notEqual(pkce.verifier, pkce.challenge);
  assert.equal(url.searchParams.get('state'), state);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent select_account');
  assert.equal(url.searchParams.get('login_hint'), 'jo@company.test');
  // hd would exclude a personal Google account that merely uses a custom domain.
  assert.equal(url.searchParams.get('hd'), null);
  const hosted = new URL(
    buildAuthUrl({
      client,
      endpoints: GOOGLE_ENDPOINTS,
      redirectUri: 'http://127.0.0.1:5123/',
      scopes: [],
      state,
      codeChallenge: pkce.challenge,
      hostedDomain: 'company.test',
    }),
  );
  assert.equal(hosted.searchParams.get('hd'), 'company.test');
});

test('client JSON: Desktop accepted, web and secret-less files refused with the fix', () => {
  const parsed = parseClientJson(
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: 'test-secret-x', project_id: 'proj-1' } }),
  );
  assert.deepEqual(parsed, { clientId: TEST_CLIENT_ID, clientSecret: 'test-secret-x', projectId: 'proj-1' });
  const web = JSON.stringify({ web: { client_id: TEST_CLIENT_ID, client_secret: 'x' } });
  assert.throws(
    () => parseClientJson(web),
    (error: unknown) =>
      error instanceof CommsError && error.code === 'BAD_DATA' && /Desktop app/.test(error.hint ?? ''),
  );
  assert.throws(
    () => parseClientJson(JSON.stringify({ installed: { client_id: TEST_CLIENT_ID } })),
    (error: unknown) => error instanceof CommsError && /secret/.test(error.message),
  );
  assert.throws(
    () => parseClientJson('{'),
    (error: unknown) => error instanceof CommsError,
  );
});

test('a code is exchanged once, with PKCE verified, and yields a refresh token and the account', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const pkce = newPkce();
  const state = newState();
  const redirectUri = 'http://127.0.0.1:5123/';
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri,
    scopes: scopesFor('organize', true),
    state,
    codeChallenge: pkce.challenge,
  });
  const redirect = new URL(harness.google.consent(authUrl));
  assert.equal(redirect.searchParams.get('state'), state);
  const code = redirect.searchParams.get('code') ?? '';

  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri,
  });
  assert.match(tokens.refreshToken, /^rt_/);
  assert.equal(tokens.idClaims.sub, 'sub-1');
  assert.equal(tokens.idClaims.email, 'jo@example.test');
  assert.ok(tokens.grantedScopes.includes(SCOPES.gmailModify));
  assert.ok(tokens.expiresAt > Date.now());

  // Single use: Google refuses a replayed code, and so does the fake.
  await assert.rejects(
    exchangeCode({ client, endpoints: harness.endpoints, code, codeVerifier: pkce.verifier, redirectUri }),
    (error: unknown) => error instanceof CommsError && error.code === 'AUTH_REQUIRED',
  );

  // A wrong PKCE verifier is refused on a fresh code.
  const second = new URL(harness.google.consent(authUrl));
  await assert.rejects(
    exchangeCode({
      client,
      endpoints: harness.endpoints,
      code: second.searchParams.get('code') ?? '',
      codeVerifier: newPkce().verifier,
      redirectUri,
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'AUTH_REQUIRED',
  );
});

test('a refused consent and a wrong client are reported with what to do about them', async () => {
  const harness = await newHarness();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: ['openid'],
    state: 'st',
    codeChallenge: newPkce().challenge,
  });
  const denied = new URL(harness.google.consent(authUrl, { deny: 'access_denied' }));
  assert.equal(denied.searchParams.get('error'), 'access_denied');

  await assert.rejects(
    exchangeCode({
      client: { clientId: TEST_CLIENT_ID, clientSecret: 'wrong' },
      endpoints: harness.endpoints,
      code: 'ac_whatever',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1:5123/',
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'CONFIG' && /OAuth client/.test(error.message),
  );
});

test('TokenSource refreshes, caches, and explains a dead grant instead of retrying it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: scopesFor('organize', false),
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
  const granted = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  const inbox = await harness.addInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: granted.refreshToken,
  });
  const config = await harness.core.config.load();
  const source = new TokenSource({
    core: harness.core,
    endpoints: harness.endpoints,
    inbox,
    client: defaultClient(config),
    alias: 'work',
  });

  const first = await source.accessToken();
  assert.match(first.token, /^at_/);
  const tokenRequests = harness.google.requests.filter((r) => r.path === '/token').length;
  assert.equal((await source.accessToken()).token, first.token, 'a valid token is reused');
  assert.equal(harness.google.requests.filter((r) => r.path === '/token').length, tokenRequests);
  assert.equal((await harness.core.states.get(inbox.id)).lastRefreshOkAt !== undefined, true);

  // Concurrent callers share one refresh rather than each spending a token request.
  source.invalidate();
  const [a, b] = await Promise.all([source.accessToken(), source.accessToken()]);
  assert.equal(a.token, b.token);
  assert.equal(harness.google.requests.filter((r) => r.path === '/token').length, tokenRequests + 1);

  harness.google.revoke(granted.refreshToken);
  source.invalidate();
  await assert.rejects(
    source.accessToken(),
    (error: unknown) =>
      error instanceof CommsError && error.code === 'AUTH_REQUIRED' && /reauth work/.test(error.hint ?? ''),
  );
  assert.equal((await harness.core.states.get(inbox.id)).lastError?.code, 'AUTH_REQUIRED');
});

test('a refresh token replaced by another process is picked up without a re-auth', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const mint = async (): Promise<string> => {
    const pkce = newPkce();
    const authUrl = buildAuthUrl({
      client,
      endpoints: harness.endpoints,
      redirectUri: 'http://127.0.0.1:5123/',
      scopes: scopesFor('read', false),
      state: 'st',
      codeChallenge: pkce.challenge,
    });
    const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
    const tokens = await exchangeCode({
      client,
      endpoints: harness.endpoints,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: 'http://127.0.0.1:5123/',
    });
    return tokens.refreshToken;
  };
  const dead = await mint();
  const inbox = await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: dead });
  harness.google.revoke(dead);
  const secrets = await harness.core.secrets('file');
  await secrets.set(refreshTokenRef(inbox.id), await mint());

  const config = await harness.core.config.load();
  const source = new TokenSource({
    core: harness.core,
    endpoints: harness.endpoints,
    inbox,
    client: defaultClient(config),
    alias: 'work',
  });
  assert.match((await source.accessToken()).token, /^at_/);
});

test('revoking a token makes Google refuse it afterwards', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: scopesFor('read', false),
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
  const granted = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  await revokeToken(harness.endpoints, granted.refreshToken);
  assert.equal(harness.google.tokens.get(granted.refreshToken)?.revoked, true);
});

test('secret references are per inbox id and per client name', () => {
  assert.equal(clientSecretRef('default'), 'client:default:secret');
  assert.equal(refreshTokenRef('ibx_AAAAAAAAAAAAAAAA'), 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA');
});

/** The client row the harness registered; a test that cannot find it should fail loudly, not assert non-null. */
function defaultClient(config: { clients: Record<string, ClientConfig> }): ClientConfig {
  const client = config.clients.default;
  if (!client) throw new Error('the harness did not register a default client');
  return client;
}
