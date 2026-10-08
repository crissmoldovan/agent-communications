import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { asV2, CommsError, sendPacing } from '@agentcomms/core';
import { sendThrottleOf } from '../src/api/client.ts';
import { ResendContext } from '../src/context.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * A send Resend throttled waits and tries again; a quota stops and says when it lifts (design 2026-10-08).
 *
 * Every refusal here is a `429` Resend gives before acting, so a retry cannot send twice. The machine's throttle and
 * the send's pacing share one clock that the pacing moves: waiting out Resend's `retry-after` lifts the throttle's
 * stop, as it does for real.
 */

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const message = {
  from: 'Acme <hello@acme.test>',
  to: ['sam@partner.test'],
  subject: 'Phase 2 plan',
  text: 'Hi Sam, the plan is attached to the thread.',
};

async function world() {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  let now = Date.now();
  const waits: number[] = [];
  const h = harness;
  const context = new ResendContext({
    core: h.core,
    env: h.env,
    fetch: h.fake.fetch,
    throttle: {
      intervalMs: 0,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    sendPacing: () =>
      sendPacing({
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
      }),
  });
  const approval = await prepareSend(context, 'acme/resend', message);
  const send = () => executeSend(context, 'acme/resend', { approvalId: approval.approvalId, expect: approval.expect });
  const state = async () => asV2(await h.core.approvals.get(approval.approvalId))?.state;
  const attempts = () => h.fake.requests.filter((r) => r.method === 'POST' && r.path === '/emails').length;
  return { harness: h, send, state, attempts, waits, now: () => now };
}

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('the send was reported as sent'),
    (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      return error;
    },
  );

const tooMany = (name: string, headers: Record<string, string> = {}) => ({
  status: 429,
  body: { name, message: 'refused before sending' },
  headers,
});

test("Resend's documented 429 names are read as the limit they name; another name is not a limit", () => {
  const at = Date.parse('2026-10-08T15:30:00.000Z');
  const error = (resendError: string, retryAfterSeconds?: number) =>
    new CommsError('TRANSIENT', 'x', {
      details: { status: 429, resendError, outcome: 'not-sent', ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
    });
  assert.deepEqual(sendThrottleOf(error('rate_limit_exceeded', 2), at), {
    limit: 'rate',
    waitMs: 2_000,
    retryAt: '2026-10-08T15:30:02.000Z',
  });
  assert.deepEqual(sendThrottleOf(error('http_429'), at), { limit: 'rate' });
  assert.deepEqual(sendThrottleOf(error('daily_quota_exceeded', 3600), at), {
    limit: 'daily-quota',
    retryAt: '2026-10-09T00:00:00.000Z',
  });
  assert.deepEqual(sendThrottleOf(error('monthly_quota_exceeded'), at), { limit: 'monthly-quota' });
  assert.equal(sendThrottleOf(error('validation_error'), at), undefined);
  // Only a refusal before acting: an uncertain one is never a throttle.
  assert.equal(
    sendThrottleOf(new CommsError('TRANSIENT', 'x', { details: { status: 429, outcome: 'unknown' } }), at),
    undefined,
  );
});

test("a throttled send waits Resend's retry-after, tries again, and is sent once (§R1, §R2)", async () => {
  const w = await world();
  let refusals = 1;
  w.harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails' && refusals-- > 0
      ? tooMany('rate_limit_exceeded', { 'retry-after': '2' })
      : undefined;

  const sent = await w.send();
  assert.ok(sent.resendId, 'no Resend id');
  assert.equal(await w.state(), 'used');
  assert.deepEqual(w.waits, [2_000], "the wait was not Resend's");
  assert.equal(w.attempts(), 2);
  assert.equal(w.harness.fake.sent.length, 1, 'not exactly one email accepted');
});

test('a rate limit that outlasts the retries stops: nothing was sent, and it says to try again later (§R5)', async () => {
  const w = await world();
  w.harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails'
      ? tooMany('rate_limit_exceeded', { 'retry-after': '1' })
      : undefined;

  const error = await refused(w.send());
  assert.equal(error.code, 'TRANSIENT');
  assert.match(error.message, /Resend is rate-limiting this team \(tried 4 times\)/);
  assert.match(`${error.message} ${error.hint ?? ''}`, /\bnothing was sent\b/i);
  assert.equal(error.details?.limit, 'rate');
  assert.equal(error.details?.retries, 3);
  assert.equal(w.attempts(), 4);
  assert.equal(await w.state(), 'failed');
  assert.equal(w.harness.fake.sent.length, 0);
});

test("the team's daily quota stops at once and says it resets at midnight UTC (§R4)", async () => {
  const w = await world();
  w.harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails' ? tooMany('daily_quota_exceeded') : undefined;

  const error = await refused(w.send());
  assert.equal(error.code, 'TRANSIENT');
  assert.match(error.message, /this Resend team's daily sending quota is used up/);
  assert.match(error.hint ?? '', /resets at midnight UTC/);
  assert.match(String(error.details?.retryAt), /T00:00:00\.000Z$/);
  assert.equal(w.attempts(), 1, 'a daily quota was waited on');
  assert.deepEqual(w.waits, []);
  assert.equal(await w.state(), 'failed');
});

test("the team's monthly quota stops at once and points at the plan (§R4)", async () => {
  const w = await world();
  w.harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails' ? tooMany('monthly_quota_exceeded') : undefined;

  const error = await refused(w.send());
  assert.match(error.message, /this Resend team's monthly sending quota is used up/);
  assert.match(error.hint ?? '', /A larger Resend plan raises it/);
  assert.equal(w.attempts(), 1);
  assert.equal(await w.state(), 'failed');
});

test('an answer that leaves the outcome uncertain is still never retried', async () => {
  const w = await world();
  w.harness.fake.intercept = (request) =>
    request.method === 'POST' && request.path === '/emails'
      ? { status: 500, body: { name: 'application_error', message: 'lost' } }
      : undefined;

  const error = await refused(w.send());
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(w.attempts(), 1);
  assert.deepEqual(w.waits, []);
});
