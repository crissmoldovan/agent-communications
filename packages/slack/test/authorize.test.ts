import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { buildAuthorizeUrl, readCallback, readExchange, redirectUrlFor, scopeMismatch } from '../src/auth/authorize.ts';
import { sameState } from '../src/auth/pkce.ts';
import { scopesForMode } from '../src/manifest.ts';

/**
 * The authorisation request and what comes back.
 *
 * `--mode read` is the claim this file mostly defends. D1 says Slack itself enforces that a read install cannot
 * post — true only if no write scope was granted, which is knowable only here, before anything is stored.
 */

const CLIENT = '1234567890.9876543210';

test('the authorisation url asks Slack for user scopes only', () => {
  const request = buildAuthorizeUrl({ clientId: CLIENT, mode: 'read', port: 51234 });
  const url = new URL(request.url);

  assert.equal(url.origin, 'https://slack.com');
  assert.equal(url.pathname, '/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), CLIENT);

  // Two independent reasons this must never be `scope`: only a user token reaches the person's DMs and unjoined
  // public channels, and Slack says desktop redirects may not request bot scopes — and this is one.
  assert.equal(url.searchParams.get('scope'), null, 'the request asked for bot scopes');
  assert.deepEqual(url.searchParams.get('user_scope')?.split(','), scopesForMode('read'));
});

test('the url carries the PKCE challenge, never the verifier', () => {
  const request = buildAuthorizeUrl({ clientId: CLIENT, mode: 'send', port: 51234 });
  const url = new URL(request.url);

  assert.equal(url.searchParams.get('code_challenge'), request.pkce.challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  // The whole point: the verifier stays here, so an intercepted code cannot be exchanged by whoever took it.
  assert.equal(request.url.includes(request.pkce.verifier), false, 'the verifier was put in the URL');
  assert.equal(url.searchParams.get('state'), request.state);
});

test('the redirect is localhost, which is the spelling Slack documents', () => {
  /*
   * The Gmail side deliberately uses `127.0.0.1`, because `localhost` resolves to whatever a name service says.
   * Slack promises desktop handling for one spelling and says nothing about the literal address, so the two
   * packages differ — deliberately, and this test is where that is recorded rather than looking like a slip.
   */
  assert.equal(redirectUrlFor(51234), 'http://localhost:51234/slack/callback');
  const request = buildAuthorizeUrl({ clientId: CLIENT, mode: 'read', port: 51234 });
  assert.equal(new URL(request.url).searchParams.get('redirect_uri'), 'http://localhost:51234/slack/callback');
});

test('a redirect with the wrong state is ignored, not failed', () => {
  // A stray tab or another local process must not be able to cancel a sign-in the person is in the middle of.
  const outcome = readCallback(
    new URL('http://localhost:1/slack/callback?state=somebody-else&code=abc'),
    'the-real-state',
    sameState,
  );
  assert.equal(outcome.kind, 'ignored');
});

test('a refusal by the person is read off the query, because that is how Slack reports it', () => {
  const outcome = readCallback(
    new URL('http://localhost:1/slack/callback?state=s&error=access_denied&error_description=nope'),
    's',
    sameState,
  );
  assert.deepEqual(outcome, { kind: 'denied', error: 'access_denied', description: 'nope' });
});

test('a redirect with neither a code nor an error is ignored', () => {
  const outcome = readCallback(new URL('http://localhost:1/slack/callback?state=s'), 's', sameState);
  assert.equal(outcome.kind, 'ignored');
});

/** The shape Slack returns for a user-scope-only app. */
function reply(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    app_id: 'A0001',
    team: { id: 'T0001', name: 'Acme' },
    authed_user: {
      id: 'U0001',
      access_token: 'fake-access-1',
      refresh_token: 'fake-refresh-1',
      expires_in: 43_200,
      scope: scopesForMode('read').join(','),
      token_type: 'user',
    },
    ...over,
  };
}

test('a good reply is read into the fields the account needs', () => {
  const token = readExchange(reply());
  assert.equal(token.accessToken, 'fake-access-1');
  assert.equal(token.refreshToken, 'fake-refresh-1');
  assert.equal(token.expiresInSeconds, 43_200);
  assert.equal(token.userId, 'U0001');
  assert.equal(token.workspaceId, 'T0001');
  assert.equal(token.workspaceName, 'Acme');
  assert.equal(token.appId, 'A0001');
  assert.deepEqual(token.scopes, scopesForMode('read'));
});

test('a bot token in the reply is refused, not quietly dropped', () => {
  /*
   * A bot token would live in the same app, outside everything this package guards, and read mode's whole claim
   * is that no token exists which can post. Dropping it would leave it in existence and unmentioned.
   */
  assert.throws(
    () => readExchange(reply({ access_token: 'fake-bot-1' })),
    (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /bot token/);
      return true;
    },
  );
});

test('a reply with no user token, or the wrong type, is refused', () => {
  assert.throws(() => readExchange(reply({ authed_user: { id: 'U1' } })), /no user token/);
  assert.throws(
    () => readExchange(reply({ authed_user: { ...reply().authed_user, token_type: 'bot' } })),
    /not a user token/,
  );
});

test('a failure from Slack keeps its reason', () => {
  assert.throws(() => readExchange({ ok: false, error: 'invalid_code' }), /invalid_code/);
  assert.throws(() => readExchange(undefined), /no reason given/);
});

test('a reply that does not name the workspace is refused', () => {
  // Every id this account will ever see is only meaningful inside one workspace. Storing it without one would
  // make every later lookup ambiguous.
  assert.throws(() => readExchange(reply({ team: {} })), /which workspace/);
});

test('extra scopes are a mismatch, not a bonus', () => {
  /*
   * The finding this exists for: a token from an app that once had `chat:write`, stored as `read`. Everything
   * downstream would then report a mailbox that cannot post while holding a token that can.
   */
  const granted = [...scopesForMode('read'), 'chat:write'];
  const { missing, extra } = scopeMismatch('read', granted);
  assert.deepEqual(missing, []);
  assert.deepEqual(extra, ['chat:write'], 'a write scope in a read install was not noticed');
});

test('missing scopes are a mismatch too, and both directions are reported at once', () => {
  const granted = scopesForMode('read')
    .filter((scope) => scope !== 'search:read')
    .concat('files:write');
  const { missing, extra } = scopeMismatch('read', granted);
  assert.deepEqual(missing, ['search:read']);
  assert.deepEqual(extra, ['files:write']);
});

test('an exactly-right install has nothing to report', () => {
  for (const mode of ['read', 'send'] as const) {
    assert.deepEqual(scopeMismatch(mode, scopesForMode(mode)), { missing: [], extra: [] });
  }
});
