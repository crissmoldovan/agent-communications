import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asV2, CommsError, sendPacing } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { mapGoogleError, sendThrottleOf } from '../src/gmail-api/errors.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { DRAFT_SEND_PATH } from './support/fake-google.ts';
import { newHarness } from './support/harness.ts';

/**
 * A send Gmail throttled waits and tries again; a quota stops and says when it lifts (design 2026-10-08).
 *
 * Every refusal here is one Gmail gives before it acts — the draft stays, nothing is sent — so a retry cannot deliver
 * twice. The pacing records its waits instead of sleeping, so nothing here waits for real.
 */

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const later = (ms: number) => new Date(NOW + ms).toISOString();

async function world() {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  const waits: number[] = [];
  const context = new GmailContext({
    core: harness.core,
    env: harness.env,
    sendPacing: () => sendPacing({ sleep: async (ms) => void waits.push(ms) }),
  });
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tuesday',
    text: 'See you then.',
  });
  const approval = await prepareSend(context, 'work', draft.draftId);
  const send = () =>
    executeSend(context, 'work', { draftId: draft.draftId, approvalId: approval.approvalId, expect: approval.expect });
  const state = async () => asV2(await harness.core.approvals.get(approval.approvalId))?.state;
  const attempts = () => harness.google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length;
  return { harness, context, draft, approval, send, state, attempts, waits };
}

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('the send was reported as sent'),
    (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      return error;
    },
  );

const rateLimited = {
  status: 403,
  body: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } },
};

// ── What a refusal is ────────────────────────────────────────────────────────────────────────────────────────

test("Gmail's documented answers are read as the limit they name, and the wait is read uncapped", () => {
  const raw = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    response: { status, headers, data: body },
  });
  assert.deepEqual(sendThrottleOf(raw(403, rateLimited.body), NOW), { limit: 'rate' });
  assert.deepEqual(
    sendThrottleOf(
      raw(403, { error: { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] } }, { 'retry-after': '2' }),
      NOW,
    ),
    { limit: 'rate', waitMs: 2_000, retryAt: later(2_000) },
  );
  assert.deepEqual(
    sendThrottleOf(raw(429, { error: { code: 429, message: 'Too many concurrent requests for user' } }), NOW),
    {
      limit: 'rate',
    },
  );
  // The sending limit, with Gmail's retry time in its message — three hours, not the minute a read's parse caps it at.
  assert.deepEqual(
    sendThrottleOf(
      raw(429, {
        error: { code: 429, message: `User-rate limit exceeded.  Retry after ${later(3 * 3_600_000)} (Mail sending)` },
      }),
      NOW,
    ),
    { limit: 'sending-limit', waitMs: 3 * 3_600_000, retryAt: later(3 * 3_600_000) },
  );
  assert.deepEqual(sendThrottleOf(raw(429, {}, { 'retry-after': '7200' }), NOW), {
    limit: 'rate',
    waitMs: 7_200_000,
    retryAt: later(7_200_000),
  });
  assert.deepEqual(
    sendThrottleOf(raw(403, { error: { code: 403, errors: [{ reason: 'dailyLimitExceeded' }] } }), NOW),
    { limit: 'project-quota' },
  );
  // Not a limit: a permission, a missing draft, a server error.
  assert.equal(
    sendThrottleOf(raw(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }), NOW),
    undefined,
  );
  assert.equal(sendThrottleOf(raw(404, {}), NOW), undefined);
  assert.equal(sendThrottleOf(raw(500, {}), NOW), undefined);
});

test("the Cloud project's quota is a setting to raise, not a sign-in to repeat, on every call (§R6)", () => {
  const error = mapGoogleError({
    response: {
      status: 403,
      data: { error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } },
    },
  });
  assert.equal(error.code, 'CONFIG');
  assert.match(error.message, /Google Cloud project's daily Gmail API quota is used up/);
  assert.match(error.hint ?? '', /Raise it in the Google Cloud console/);
});

// ── A send that is throttled ─────────────────────────────────────────────────────────────────────────────────

test('a throttled send waits the time Gmail gives, tries again, and is sent once (§R1, §R2)', async () => {
  const w = await world();
  let refusals = 1;
  w.harness.google.beforeSend = () =>
    refusals-- > 0 ? { ...rateLimited, headers: { 'retry-after': '2' } } : undefined;

  const sent = await w.send();
  assert.ok(sent.sentMessageId, 'no message id');
  assert.equal(await w.state(), 'used');
  assert.deepEqual(w.waits, [2_000], 'the wait was not the one Gmail asked for');
  assert.equal(w.attempts(), 2);
  assert.equal(Object.keys(w.harness.google.accounts.get('sub-1')?.drafts ?? {}).length, 0, 'the draft was not sent');
});

test('a throttle that outlasts the retries stops: nothing was sent, and it says to try again later (§R5)', async () => {
  const w = await world();
  w.harness.google.beforeSend = () => rateLimited;

  const error = await refused(w.send());
  assert.equal(error.code, 'TRANSIENT');
  assert.equal(error.message, 'nothing was sent: Google is rate-limiting this account (tried 4 times)');
  assert.equal(error.details?.limit, 'rate');
  assert.equal(error.details?.retries, 3);
  assert.equal(w.attempts(), 4, 'more than three retries, or fewer');
  assert.equal(w.waits.length, 3);
  assert.equal(await w.state(), 'failed');
  assert.equal(Object.keys(w.harness.google.accounts.get('sub-1')?.drafts ?? {}).length, 1, 'the draft is gone');
});

test("Gmail's sending limit stops at once, names the limit, and says when Google accepts mail again (§R4)", async () => {
  const w = await world();
  const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  w.harness.google.beforeSend = () => ({
    status: 429,
    body: { error: { code: 429, message: `User-rate limit exceeded.  Retry after ${at} (Mail sending)` } },
  });

  const error = await refused(w.send());
  assert.equal(error.code, 'TRANSIENT');
  assert.equal(error.message, "nothing was sent: Gmail's sending limit for this account is reached");
  assert.equal(error.details?.limit, 'sending-limit');
  assert.ok(typeof error.details?.retryAt === 'string');
  assert.match(error.hint ?? '', /Google accepts mail from this account again after /);
  assert.equal(w.attempts(), 1, 'a sending limit was waited on');
  assert.deepEqual(w.waits, []);
  assert.equal(await w.state(), 'failed');
});

test('a sending limit with no retry time is not waited on either: it can last hours (§R4)', async () => {
  const w = await world();
  w.harness.google.beforeSend = () => ({
    status: 429,
    body: { error: { code: 429, message: 'User-rate limit exceeded (Mail sending)' } },
  });

  const error = await refused(w.send());
  assert.equal(error.details?.limit, 'sending-limit');
  assert.equal(error.details?.retryAt, undefined);
  assert.match(error.hint ?? '', /can last several hours/);
  assert.equal(w.attempts(), 1, 'a sending limit was retried on backoff');
  assert.deepEqual(w.waits, []);
});

test("the Cloud project's quota stops at once as a setting, and nothing was sent (§R4, §R6)", async () => {
  const w = await world();
  w.harness.google.beforeSend = () => ({
    status: 403,
    body: { error: { code: 403, message: 'Daily Limit Exceeded', errors: [{ reason: 'dailyLimitExceeded' }] } },
  });

  const error = await refused(w.send());
  assert.equal(error.code, 'CONFIG');
  assert.match(error.message, /^nothing was sent: this Google Cloud project's daily Gmail API quota is used up$/);
  assert.equal(w.attempts(), 1);
  assert.equal(await w.state(), 'failed');
});

test('a draft changed during the wait is not sent: every retry repeats the last look (§R3)', async () => {
  const w = await world();
  w.harness.google.beforeSend = () => {
    w.harness.google.beforeSend = null;
    return rateLimited;
  };
  // The person edits the draft in Gmail's web app while the send waits: Gmail gives the draft a new message.
  const pacing = sendPacing({
    sleep: async () => {
      const draft = w.harness.google.accounts.get('sub-1')?.drafts?.[w.draft.draftId];
      assert.ok(draft?.message, 'no draft to edit');
      draft.message = { ...draft.message, id: 'edited-in-gmail-web' };
    },
  });
  const context = new GmailContext({ core: w.harness.core, env: w.harness.env, sendPacing: () => pacing });

  const error = await refused(
    executeSend(context, 'work', {
      draftId: w.draft.draftId,
      approvalId: w.approval.approvalId,
      expect: w.approval.expect,
    }),
  );
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /the draft changed while it was being sent/);
  assert.equal(w.attempts(), 1, 'the changed draft was sent');
  assert.equal(await w.state(), 'failed');
});

test('an answer that leaves the outcome uncertain is still never retried', async () => {
  const w = await world();
  w.harness.google.afterSend = () => ({ status: 500, body: { error: { code: 500, message: 'lost after acting' } } });

  const error = await refused(w.send());
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(w.attempts(), 1);
  assert.deepEqual(w.waits, []);
});
