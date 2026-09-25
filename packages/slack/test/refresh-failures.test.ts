import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { classifyRefreshFailure } from '../src/auth/refresh.ts';
import { SlackContext } from '../src/context.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { newHarness, slackOk } from './support/harness.ts';
import { attemptsFailed, contextFor, expired, fetchFailed, stored, syscallFailed } from './support/refresh.ts';

/**
 * Every way a refresh can fail, and what each leaves in the store.
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

// ── Not sent: the token never left, so nothing changes ──────────────────────────────────────────────────────────

for (const [label, error] of [
  ['DNS failure (ENOTFOUND)', fetchFailed('ENOTFOUND')],
  ['DNS retry (EAI_AGAIN)', fetchFailed('EAI_AGAIN')],
  ['connection refused on both address families', fetchFailed('ECONNREFUSED', 'ECONNREFUSED')],
  ['no route (ENETUNREACH)', fetchFailed('ENETUNREACH')],
  ['connect timeout (UND_ERR_CONNECT_TIMEOUT)', fetchFailed('UND_ERR_CONNECT_TIMEOUT')],
  ['certificate rejected (CERT_HAS_EXPIRED)', fetchFailed('CERT_HAS_EXPIRED')],
  [
    'one address timed out connecting, the other refused',
    attemptsFailed(['ETIMEDOUT', 'connect'], ['ECONNREFUSED', 'connect']),
  ],
] as const) {
  test(`not sent — ${label}: the credential goes back to ready, and the next call refreshes`, async () => {
    /*
     * The P0 the audit found. Each of these fails before a byte of the form leaves, so Slack still accepts the
     * token — and the first version marked every one `refresh-uncertain`, permanently, on the first read made
     * from a laptop that happened to be offline.
     */
    const harness = await newHarness();
    const account = await expired(harness);
    harness.reply = () => {
      throw error;
    };
    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), (thrown: CommsError) => {
      assert.equal(thrown.code, 'TRANSIENT');
      assert.equal(thrown.details?.stage, 'network');
      return true;
    });
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'ready');
    assert.equal(after?.attempt, undefined, 'the marker was left behind');
    assert.equal(after?.refreshToken, 'fake-refresh-token-0');

    harness.reply = () => slackOk({ authed_user: { access_token: 'fake-new-access' } });
    const session = await openWorkspace(contextFor(harness), 'acme');
    assert.equal(session.call.token, 'fake-new-access');
    assert.equal(harness.calls.length, 2);
  });
}

test('a connection that never opened is not sent, whatever its code; a timeout after one opened may have been', () => {
  /*
   * The shape Node really produces when one address hangs and the other refuses: the aggregate carries the first
   * attempt's `ETIMEDOUT`, a code that also happens after a request was written. What proves nothing left is where
   * each attempt failed — in `connect`, before there was a connection to write to.
   */
  assert.deepEqual(classifyRefreshFailure(attemptsFailed(['ETIMEDOUT', 'connect'], ['ECONNREFUSED', 'connect'])), {
    kind: 'not-sent',
    stage: 'network',
    networkCode: 'ETIMEDOUT',
  });
  assert.equal(classifyRefreshFailure(syscallFailed('ECONNRESET', 'connect')).kind, 'not-sent');
  assert.equal(classifyRefreshFailure(syscallFailed('ETIMEDOUT', 'connect')).kind, 'not-sent');

  // After the connection opened, the same codes can follow a request that was written.
  assert.equal(classifyRefreshFailure(syscallFailed('ETIMEDOUT', 'read')).kind, 'ambiguous');
  assert.equal(classifyRefreshFailure(syscallFailed('ECONNRESET', 'write')).kind, 'ambiguous');
  assert.equal(classifyRefreshFailure(fetchFailed('ETIMEDOUT')).kind, 'ambiguous');
  // One attempt that got past `connect` is enough to make the whole ambiguous.
  assert.equal(
    classifyRefreshFailure(attemptsFailed(['ETIMEDOUT', 'connect'], ['ECONNRESET', 'read'])).kind,
    'ambiguous',
  );
});

test('the guard refusing the request is not sent either', async () => {
  const harness = await newHarness();
  const account = await expired(harness);
  harness.reply = () => {
    throw new CommsError('SEND_REFUSED', 'that request went somewhere else');
  };
  await assert.rejects(openWorkspace(contextFor(harness), 'acme'), { code: 'SEND_REFUSED' });
  assert.equal((await stored(harness, account.secretRef))?.state, 'ready');
});

// ── Refused by Slack before it looked at the token ──────────────────────────────────────────────────────────────

for (const [slackError, code] of [
  ['ratelimited', 'TRANSIENT'],
  ['request_timeout', 'TRANSIENT'],
  ['service_unavailable', 'TRANSIENT'],
  ['team_added_to_org', 'TRANSIENT'],
  ['org_login_required', 'TRANSIENT'],
  ['invalid_client_id', 'CONFIG'],
  ['pkce_not_allowed', 'CONFIG'],
  ['invalid_grant_type', 'UNEXPECTED'],
  ['invalid_arguments', 'UNEXPECTED'],
  ['invalid_form_data', 'UNEXPECTED'],
  ['invalid_charset', 'UNEXPECTED'],
] as const) {
  test(`refused, token unused — ${slackError}: ready again, and Slack’s code is in the error`, async () => {
    const harness = await newHarness();
    const account = await expired(harness);
    harness.reply = () => ({ ok: false, error: slackError });
    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), (error: CommsError) => {
      assert.equal(error.code, code);
      assert.equal(error.details?.slackError, slackError);
      assert.equal(error.details?.stage, 'refused');
      assert.match(error.message, new RegExp(slackError));
      return true;
    });
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'ready');
    assert.equal(after?.refreshToken, 'fake-refresh-token-0');
  });
}

test('an HTTP 429 with no body is Slack’s rate limiter, not an ambiguous outage', async () => {
  const harness = await newHarness();
  const account = await expired(harness);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(openWorkspace(new SlackContext({ core: harness.core, env: harness.env }), 'acme'), {
      code: 'TRANSIENT',
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal((await stored(harness, account.secretRef))?.state, 'ready');
});

// ── Definitely dead ─────────────────────────────────────────────────────────────────────────────────────────────

for (const slackError of [
  'invalid_refresh_token',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'access_denied',
]) {
  test(`dead — ${slackError}: terminal, named, and never presented again`, async () => {
    const harness = await newHarness();
    const account = await expired(harness);
    harness.reply = () => ({ ok: false, error: slackError });
    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, new RegExp(slackError));
      assert.match(error.hint ?? '', /workspace reauth acme/, 'the hint should name the workspace, not <name>');
      return true;
    });
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'refresh-uncertain', '0.4.0 must read this as terminal too');
    assert.equal(after?.reason?.kind, 'dead');
    assert.equal(after?.reason?.slackError, slackError);

    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), new RegExp(slackError));
    assert.equal(harness.calls.length, 1, 'a refresh token Slack called dead was presented again');
  });
}

// ── Ambiguous: may have been used ───────────────────────────────────────────────────────────────────────────────

for (const [label, reply, stage] of [
  ['connection reset after sending', fetchFailed('ECONNRESET'), 'network'],
  ['one address refused, the other reset', fetchFailed('ECONNREFUSED', 'ECONNRESET'), 'network'],
  ['a timeout reading the reply', syscallFailed('ETIMEDOUT', 'read'), 'network'],
  [
    'one address refused, the other timed out after connecting',
    attemptsFailed(['ECONNREFUSED', 'connect'], ['ETIMEDOUT', 'read']),
    'network',
  ],
  ['an abort with no code', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'network'],
  ['internal_error', { ok: false, error: 'internal_error' }, 'refused'],
  ['fatal_error', { ok: false, error: 'fatal_error' }, 'refused'],
  ['a code nobody has classified', { ok: false, error: 'something_new' }, 'refused'],
  [
    'HTTP 503',
    new CommsError('TRANSIENT', 'Slack returned 503', { details: { stage: 'http', httpStatus: 503 } }),
    'http',
  ],
  [
    'an unreadable body',
    new CommsError('PROVIDER_UNAVAILABLE', 'not readable', { details: { stage: 'unreadable', httpStatus: 200 } }),
    'unreadable',
  ],
] as const) {
  test(`ambiguous — ${label}: refresh-uncertain, with where it failed recorded`, async () => {
    const harness = await newHarness();
    const account = await expired(harness);
    harness.reply = () => {
      if (reply instanceof Error || reply instanceof DOMException) throw reply;
      return reply;
    };
    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), (error: CommsError) => {
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.equal(error.details?.stage, stage);
      return true;
    });
    const after = await stored(harness, account.secretRef);
    assert.equal(after?.state, 'refresh-uncertain');
    assert.equal(after?.reason?.kind, 'uncertain');
    assert.equal(after?.reason?.stage, stage);
    await assert.rejects(openWorkspace(contextFor(harness), 'acme'), /cannot be retried safely/);
    assert.equal(harness.calls.length, 1, 'a refresh token that may be spent was presented again');
  });
}

test('the real exchange: a 503 and an unreadable body are ambiguous, ENOTFOUND is not', async () => {
  // `postExchange` is what tags a status or a body with its stage; checked here against `fetch` itself.
  const cases: [string, () => Promise<Response>, string, Record<string, unknown>][] = [
    [
      '503',
      async () => new Response('upstream', { status: 503 }),
      'refresh-uncertain',
      { stage: 'http', httpStatus: 503 },
    ],
    [
      'unreadable',
      async () => new Response('<html>', { status: 200 }),
      'refresh-uncertain',
      { stage: 'unreadable', httpStatus: 200 },
    ],
    ['ENOTFOUND', async () => Promise.reject(fetchFailed('ENOTFOUND')), 'ready', { stage: 'network' }],
  ];
  for (const [label, respond, state, details] of cases) {
    const harness = await newHarness();
    const account = await expired(harness);
    const original = globalThis.fetch;
    globalThis.fetch = respond as typeof fetch;
    try {
      await assert.rejects(
        openWorkspace(new SlackContext({ core: harness.core, env: harness.env }), 'acme'),
        (error: CommsError) => {
          for (const [key, value] of Object.entries(details))
            assert.equal(error.details?.[key], value, `${label}: ${key}`);
          return true;
        },
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal((await stored(harness, account.secretRef))?.state, state, label);
  }
});
