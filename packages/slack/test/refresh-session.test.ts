import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommsError } from '@agentcomms/core';
import type { TokenBundle } from '../src/auth/bundle.ts';
import { SlackContext } from '../src/context.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';
import { contextFor, expired, stored } from './support/refresh.ts';

/**
 * What a refresh sends, and how Slack's reply is read.
 *
 * The refresh, driven the way a read drives it: `openWorkspace`, with only Slack's side replaced.
 *
 * `refresh.test.ts` injects an exchange that already returns a bundle, so it never sees what is sent to Slack, how
 * Slack's reply is read, or what each kind of failure leaves in the store. Those are exactly where the first real
 * refresh can lose a credential — Slack's single-use refresh token is spent the moment Slack answers `ok:true` —
 * so they are tested here, from the parameters on the wire to the state a second call finds.
 *
 * Every store is the harness's file store in a temporary directory. Nothing here reaches Slack or the keychain.
 */

// ── What is sent, and how the reply is read ─────────────────────────────────────────────────────────────────────

test('a refresh sends exactly grant_type, refresh_token and client_id — no secret, no verifier', async () => {
  /*
   * Slack's PKCE guide: refreshes for a desktop-redirect app "do not require a client_secret", and "no PKCE
   * parameters (code_verifier, code_challenge) are used during refresh". Anything more is a field Slack may refuse,
   * and a refusal of a refresh is where a credential gets lost.
   */
  const harness = await newHarness();
  await expired(harness);
  harness.reply = () => slackOk();
  await openWorkspace(contextFor(harness), 'acme');
  assert.deepEqual(harness.calls[0]?.params, {
    grant_type: 'refresh_token',
    refresh_token: 'fake-refresh-token-0',
    client_id: TEST_CLIENT_ID,
  });
});

test('the real exchange posts that form to oauth.v2.access, and nothing else', async () => {
  // The same assertion one layer down, through `postExchange` itself, with `fetch` replaced rather than Slack.
  const harness = await newHarness();
  await expired(harness);
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(slackOk()), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await openWorkspace(new SlackContext({ core: harness.core, env: harness.env }), 'acme');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.equal(
    new Headers(seen[0]?.init?.headers).get('content-type'),
    'application/x-www-form-urlencoded;charset=utf-8',
  );
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(seen[0]?.init?.body))), {
    grant_type: 'refresh_token',
    refresh_token: 'fake-refresh-token-0',
    client_id: TEST_CLIENT_ID,
  });
});

for (const [shape, reply] of [
  [
    // How Slack's own SDKs read a refreshed user token: python's TokenRotator, @slack/oauth, java's TokenRotator.
    'the SDKs’ top-level shape',
    {
      ok: true,
      access_token: 'fake-new-access',
      refresh_token: 'fake-new-refresh',
      expires_in: 43_200,
      token_type: 'user',
      scope: 'channels:read',
    },
  ],
  [
    // The one the old parser threw away after the token was spent: tokens at the top, an identity-only object beside.
    'top level with authed_user carrying only an id',
    {
      ok: true,
      access_token: 'fake-new-access',
      refresh_token: 'fake-new-refresh',
      expires_in: 43_200,
      token_type: 'user',
      authed_user: { id: 'U0001' },
    },
  ],
  [
    'the sign-in’s shape, nested under authed_user',
    slackOk({ authed_user: { access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' } }),
  ],
] as const) {
  test(`a renewal in ${shape} is stored and used`, async () => {
    const harness = await newHarness();
    const account = await expired(harness);
    harness.reply = () => reply;
    const session = await openWorkspace(contextFor(harness), 'acme');
    assert.equal(session.call.token, 'fake-new-access');
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'ready');
    assert.equal(after?.accessToken, 'fake-new-access');
    assert.equal(after?.refreshToken, 'fake-new-refresh', 'the rotated refresh token was not kept');
    assert.equal(after?.attempt, undefined);
  });
}

test('a renewal with no expires_in is kept, at Slack’s documented twelve hours, not thrown away', async () => {
  /*
   * Slack has said `ok:true`; the old refresh token is spent. Refusing the reply for a missing number would leave
   * the workspace with nothing, so this path — and only this one — uses the value Slack says "will always" be sent.
   */
  const harness = await newHarness();
  const account = await expired(harness);
  harness.reply = () => ({ ok: true, access_token: 'fake-new-access', refresh_token: 'fake-new-refresh' });
  const before = Date.now();
  await openWorkspace(contextFor(harness), 'acme');
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'ready');
  const lifetime = Date.parse(after?.accessExpiresAt ?? '') - before;
  assert.ok(Math.abs(lifetime - 43_200_000) < 60_000, `expected twelve hours, got ${lifetime} ms`);
});

test('a renewal that returns only a bot token is not stored as this account’s credential', async () => {
  const harness = await newHarness();
  const account = await expired(harness);
  harness.reply = () => ({
    ok: true,
    access_token: 'fake-bot-access',
    refresh_token: 'fake-bot-refresh',
    expires_in: 43_200,
    token_type: 'bot',
  });
  await assert.rejects(openWorkspace(contextFor(harness), 'acme'), (error: CommsError) => {
    assert.equal(error.code, 'AUTH_REQUIRED');
    assert.equal(error.details?.stage, 'parse');
    return true;
  });
  const after = await stored(harness, account.secretRef);
  assert.equal(after?.state, 'refresh-uncertain', 'Slack said ok:true, so the old token is spent');
  assert.equal(after?.reason?.kind, 'dead');
  assert.notEqual(after?.accessToken, 'fake-bot-access');
});

test('a state this version does not know is never refreshed', async () => {
  /*
   * 0.4.0 refreshed anything that was not `refreshing` or `refresh-uncertain`, so a terminal state added later
   * would have been read as refreshable. This version refreshes only `ready`, so the next one can add a state
   * without an older process presenting the token that state was added to protect.
   */
  const harness = await newHarness();
  const account = await expired(harness, { state: 'refresh-dead' as TokenBundle['state'] });
  await assert.rejects(openWorkspace(contextFor(harness), 'acme'), { code: 'AUTH_REQUIRED' });
  assert.equal(harness.calls.length, 0, 'a credential in an unknown state was refreshed');
  assert.equal((await stored(harness, account.secretRef))?.state, 'refresh-dead');
});
