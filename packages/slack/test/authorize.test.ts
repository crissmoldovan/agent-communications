import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import { buildAuthorizeUrl, readCallback, readExchange, redirectUrlFor, scopeMismatch } from '../src/auth/authorize.ts';
import { sameState } from '../src/auth/pkce.ts';
import { scopesForMode } from '../src/manifest.ts';
import { assertNoBareCommand, slackHandoffs, slackInlineToFill, TEST_PATHS } from './support/handoffs.ts';

/** Slack's own commands, located from this checkout, for the refusals that name one. */
const HANDOFFS = slackHandoffs();

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

test('the PKCE sign-in asks Slack for user scopes only, in either mode (S1, revised 2026-10-15)', () => {
  /*
   * Slack's PKCE page: "Desktop redirects are not allowed to request bot scopes", and a `localhost` redirect from a PKCE
   * app is one. So neither mode's sign-in sends `scope`: the send app's bot token comes from the app's own page, pasted
   * once (`workspace bot`), or from the client-secret sign-in. The send manifest still declares the bot user, so the app's
   * "Install to Workspace" can create it.
   */
  for (const mode of ['read', 'send'] as const) {
    const url = new URL(buildAuthorizeUrl({ clientId: CLIENT, mode, port: 51234 }).url);
    assert.equal(url.searchParams.get('scope'), null, `the ${mode} sign-in asked for bot scopes`);
    assert.deepEqual(url.searchParams.get('user_scope')?.split(','), scopesForMode(mode));
    for (const bot of ['chat:write.customize', 'chat:write.public']) {
      assert.equal(url.href.includes(encodeURIComponent(bot)), false, `the ${mode} sign-in carries ${bot}`);
    }
  }
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

test('the url names the workspace the sign-in must land in, and only when one is known', () => {
  /*
   * An organisation's app is not distributed, so Slack authorises it only in the workspace that made it — and with
   * no `team`, Slack signs the person in to whichever workspace their browser was last in. A member signed in to
   * another one met `invalid_team_for_non_distributed_app` on Slack's own page, and nothing came back to the listener.
   */
  const known = buildAuthorizeUrl({ clientId: CLIENT, mode: 'read', port: 51234, team: 'TJYMH92Q2' });
  assert.equal(new URL(known.url).searchParams.get('team'), 'TJYMH92Q2');

  // An own app's workspace is not known until Slack answers, so nothing is guessed.
  const unknown = buildAuthorizeUrl({ clientId: CLIENT, mode: 'read', port: 51234 });
  assert.equal(new URL(unknown.url).searchParams.has('team'), false);
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
  const token = readExchange(reply(), HANDOFFS);
  assert.equal(token.accessToken, 'fake-access-1');
  assert.equal(token.refreshToken, 'fake-refresh-1');
  assert.equal(token.expiresInSeconds, 43_200);
  assert.equal(token.userId, 'U0001');
  assert.equal(token.workspaceId, 'T0001');
  assert.equal(token.workspaceName, 'Acme');
  assert.equal(token.appId, 'A0001');
  assert.deepEqual(token.scopes, scopesForMode('read'));
});

test('the exchange keeps a raw app id for the profile validator and accepts an own-app reply without one', () => {
  assert.equal(readExchange(reply({ app_id: 'not-an-app-id' }), HANDOFFS).appId, 'not-an-app-id');
  assert.equal(readExchange(reply({ app_id: undefined }), HANDOFFS).appId, undefined);
});

test('an exchange refusal preserves Slack error and description as structured details', () => {
  assert.throws(
    () =>
      readExchange({ ok: false, error: 'app_not_approved', error_description: 'Admin approval required' }, HANDOFFS),
    (error: CommsError) => {
      assert.deepEqual(error.details, { slackError: 'app_not_approved', slackDescription: 'Admin approval required' });
      return true;
    },
  );
});

test('a bot token in the reply is refused, not quietly dropped', () => {
  /*
   * A bot token would live in the same app, outside everything this package guards, and read mode's whole claim
   * is that no token exists which can post. Dropping it would leave it in existence and unmentioned.
   */
  assert.throws(
    () => readExchange(reply({ access_token: 'fake-bot-1' }), HANDOFFS),
    (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /bot token/);
      return true;
    },
  );
});

/** Slack's reply for the send app: the user's token under `authed_user`, the bot's at the top (S1). */
function sendReply(over: Record<string, unknown> = {}) {
  return reply({
    authed_user: { ...reply().authed_user, scope: scopesForMode('send').join(',') },
    access_token: 'fake-bot-1',
    token_type: 'bot',
    scope: 'chat:write,chat:write.customize,chat:write.public,reactions:write',
    bot_user_id: 'U0BOT0001',
    refresh_token: 'fake-bot-refresh-1',
    expires_in: 43_200,
    ...over,
  });
}

test('a send reply that carries a bot token anyway keeps it, held to exactly the four scopes (S1)', () => {
  const token = readExchange(sendReply(), HANDOFFS, 'send');
  assert.equal(token.accessToken, 'fake-access-1', 'the user token is still the account’s own');
  assert.deepEqual(token.bot, {
    accessToken: 'fake-bot-1',
    refreshToken: 'fake-bot-refresh-1',
    expiresInSeconds: 43_200,
    scopes: ['chat:write', 'chat:write.customize', 'chat:write.public', 'reactions:write'],
    userId: 'U0BOT0001',
  });
});

test('a send reply whose bot token has any other scope, or is not a rotating bot token, is refused (S1)', () => {
  const refused = (over: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(
      () => readExchange(sendReply(over), HANDOFFS, 'send'),
      (error: CommsError) => {
        assert.equal(error.code, 'AUTH_REQUIRED');
        assert.match(error.message, pattern);
        // Never the token itself, in the message or anywhere in what the refusal carries.
        assert.equal(JSON.stringify({ ...error, message: error.message }).includes('fake-bot-1'), false);
        return true;
      },
    );
  // More than the four: a bot that can read is not this app.
  refused({ scope: 'chat:write,chat:write.customize,chat:write.public,reactions:write,channels:history' }, /bot/);
  // Fewer: it cannot name its posts, so they would go out as the app's own name.
  refused({ scope: 'chat:write,chat:write.public,reactions:write' }, /bot/);
  refused({ token_type: 'user' }, /bot/);
  refused({ bot_user_id: undefined }, /bot/);
  refused({ refresh_token: undefined }, /bot/);
  refused({ expires_in: undefined }, /bot/);
});

test('a send reply with no bot token is a good one: the bot token comes another way (S1, revised)', () => {
  const token = readExchange(
    reply({ authed_user: { ...reply().authed_user, scope: scopesForMode('send').join(',') } }),
    HANDOFFS,
    'send',
  );
  assert.equal(token.bot, undefined);
  assert.deepEqual(token.scopes, scopesForMode('send'));
});

test('a read reply carrying a bot token is still refused (S1)', () => {
  assert.throws(
    () => readExchange(sendReply({ authed_user: reply().authed_user }), HANDOFFS, 'read'),
    (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /bot token/);
      return true;
    },
  );
});

test('a reply with no user token, or the wrong type, is refused', () => {
  assert.throws(() => readExchange(reply({ authed_user: { id: 'U1' } }), HANDOFFS), /no user token/);
  assert.throws(
    () => readExchange(reply({ authed_user: { ...reply().authed_user, token_type: 'bot' } }), HANDOFFS),
    /not a user token/,
  );
});

test('a failure from Slack keeps its reason', () => {
  assert.throws(() => readExchange({ ok: false, error: 'invalid_code' }, HANDOFFS), /invalid_code/);
  assert.throws(() => readExchange(undefined, HANDOFFS), /no reason given/);
});

test('a reply that does not name the workspace is refused', () => {
  // Every id this account will ever see is only meaningful inside one workspace. Storing it without one would
  // make every later lookup ambiguous.
  assert.throws(
    () => readExchange(reply({ team: {} }), HANDOFFS),
    (error: CommsError) => {
      assert.match(error.message, /which workspace/);
      // Slack's own `workspace add`, located from this installation, the name left for the agent to fill in.
      const add = slackInlineToFill(TEST_PATHS, ['workspace', 'add'], ['<name>']);
      assert.equal(error.hint, `Start again with ${add}.`);
      assertNoBareCommand(error.hint ?? '');
      return true;
    },
  );
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
