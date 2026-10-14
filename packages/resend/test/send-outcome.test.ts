import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  ApprovalStore,
  asV2,
  CommsError,
  LEASE_LOST_BEFORE_SEND,
  openCore,
  SENDING_LEASE_MS,
  waitForApproval,
} from '@agentcomms/core';
import { writeOutcomeOf } from '../src/api/client.ts';
import { RESEND_API_ORIGIN, routeOf } from '../src/api/routes.ts';
import { RESEND_CALLER } from '../src/caller.ts';
import { renderSent } from '../src/cli/render.ts';
import type { SendInput } from '../src/compose/message.ts';
import { SendRecords } from '../src/compose/store.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import type { SeenRequest } from './support/fake-resend.ts';
import { type Harness, newHarness } from './support/harness.ts';

/** A refusal's details apart from where its approval stands, which each test checks on its own (decision 8). */
function apartFromApproval(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const { approval: _approval, ...rest } = details ?? {};
  return rest;
}
const approvalState = (error: CommsError) => (error.details?.approval as { state?: string } | undefined)?.state;

/**
 * A response says a send was refused only when Resend documents it as a pre-action answer. Everything else may be an
 * email the provider has already accepted, and local bookkeeping after a confirmed acceptance cannot change that.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const message = {
  from: 'Acme <hello@acme.test>',
  to: ['sam@partner.test'],
  subject: 'Phase 2 plan',
  text: 'Hi Sam, the plan is attached to the thread.',
};

async function prepared(over: Partial<SendInput> = {}) {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context();
  const approval = await prepareSend(context, 'acme/resend', { ...message, ...over });
  const send = () => executeSend(context, 'acme/resend', { approvalId: approval.approvalId });
  const state = async () => asV2(await harness.core.approvals.get(approval.approvalId))?.state;
  return { context, approval, send, state };
}

/** This machine as another caller sees it once the claimant's lease has run out: the same files, a later clock. */
function later(): ReturnType<typeof openCore> {
  return openCore({ env: harness.env, caller: RESEND_CALLER, now: () => new Date(Date.now() + SENDING_LEASE_MS) });
}

/** Where an approval stands now, by the zero-wait status every surface shares (design 2026-10-05 §D3). */
async function zeroWait(core: ReturnType<typeof openCore>, approvalId: string): Promise<string> {
  return (await waitForApproval(core, approvalId, { waitSeconds: 0 })).approval.state;
}

test('Resend’s certain-refusal classifier is a narrow allowlist', () => {
  for (const status of [400, 401, 403, 404, 422, 429]) assert.equal(writeOutcomeOf(status), 'not-sent', String(status));
  for (const status of [405, 408, 409, 500]) assert.equal(writeOutcomeOf(status), 'unknown', String(status));
  assert.equal(writeOutcomeOf(undefined), 'unknown', 'no answer');
});

test('Resend acting before its answer is lost is SEND_OUTCOME_UNKNOWN at once, still sending, and says where to check (D2pt-d)', async (t) => {
  for (const [what, answer] of [
    ['a 502', { status: 502, body: { name: 'application_error', message: 'upstream' } }],
    ['a 500', { status: 500, body: { name: 'internal_server_error', message: 'answer lost' } }],
    ['a 409', { status: 409, body: { name: 'invalid_idempotent_request', message: 'already in progress' } }],
    ['a dropped connection', { status: 0, drop: true }],
    ['an unreadable 200', { status: 200, body: undefined }],
  ] as const) {
    await t.test(what, async () => {
      const { approval, send, state } = await prepared();
      harness.fake.afterSend = () => answer;

      const error = await send().then(
        () => assert.fail(`${what} was reported as a confirmed send`),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof CommsError);
      // At once, and never retryable: the send may have happened (design 2026-10-05 §D2).
      assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
      assert.equal(error.retryable, false);
      assert.match(error.message, /^whether the email was sent is not known:/);
      assert.match(error.hint ?? '', /Resend dashboard or ask the recipient/);
      assert.match(error.hint ?? '', /do not prepare it again until you know it did not go/);
      assert.equal(error.details?.outcome, 'unknown');
      const shown = error.details?.approval as
        | { state?: string; claimable?: boolean; sendingAt?: string; sendingHeartbeatAt?: string; unknownAt?: string }
        | undefined;
      assert.equal(shown?.state, 'sending');
      assert.equal(shown?.claimable, false);
      assert.ok(shown?.sendingAt, 'when it was claimed');
      assert.ok(shown?.sendingHeartbeatAt, 'the fence before the request renewed the lease');
      assert.equal(
        shown?.unknownAt,
        new Date(Date.parse(shown?.sendingHeartbeatAt ?? '') + SENDING_LEASE_MS).toISOString(),
        'when it reads unknown: the last renewal, plus the lease',
      );
      assert.equal(await state(), 'sending');
      const store = new ApprovalStore(harness.core.paths.stateDir, {
        now: () => new Date(Date.now() + SENDING_LEASE_MS),
        loadConfig: () => harness.core.config.load(),
      });
      assert.equal(asV2(await store.get(approval.approvalId))?.state, 'unknown');
      assert.equal(harness.fake.sent.length, 1, 'Resend accepted one email');
      const local = await new SendRecords(harness.core.paths.stateDir).summary(
        (await harness.core.config.load()).accounts['acme/resend']?.id ?? '',
        approval.approvalId,
      );
      assert.equal(local?.state, 'unknown');
    });
  }
});

test('only Resend responses documented as pre-action refusals mark the approval failed, and each says nothing was sent (D2pt-g)', async (t) => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    await t.test(String(status), async () => {
      const { send, state } = await prepared();
      harness.fake.intercept = (request) =>
        request.method === 'POST' && request.path === '/emails'
          ? { status, body: { name: 'validation_error', message: 'refused before sending' } }
          : undefined;

      const error = await send().then(
        () => assert.fail(`${status} was reported as a send`),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof CommsError);
      assert.equal(error.details?.outcome, 'not-sent');
      // Resend's own words first, then what they mean: certainly nothing went (design 2026-10-05 §D2, `failed`).
      assert.match(error.message, /refused before sending/);
      assert.match(`${error.message} ${error.hint ?? ''}`, /\bnothing was sent\b/i);
      assert.notEqual(error.code, 'SEND_OUTCOME_UNKNOWN');
      assert.equal(approvalState(error), 'failed');
      assert.equal(await state(), 'failed');
      assert.equal(harness.fake.sent.length, 0);

      const retry = await send().then(
        () => assert.fail(`${status} reused a failed approval`),
        (thrown: unknown) => thrown,
      );
      assert.ok(retry instanceof CommsError);
      // The record's own state, classified before Resend is asked anything: refused for what it is.
      assert.match(retry.message, /^nothing was sent: the send it was claimed for failed/);
      assert.equal(retry.hint, 'Prepare the send again and show the new preview to the user.');
      assert.equal(approvalState(retry), 'failed');
    });
  }

  await t.test('409 is an idempotency conflict whose outcome is unknown', async () => {
    const { send, state } = await prepared();
    harness.fake.intercept = (request) =>
      request.method === 'POST' && request.path === '/emails'
        ? { status: 409, body: { name: 'invalid_idempotent_request', message: 'already in progress' } }
        : undefined;

    const error = await send().then(
      () => assert.fail('409 was reported as a send'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
    assert.equal(error.details?.outcome, 'unknown');
    assert.equal(await state(), 'sending');
  });
});

test('every certain no-send path attempts release, approval, local record and audit independently', async (t) => {
  type Step = 'release' | 'approval' | 'record' | 'audit';
  const failureSets: ReadonlyArray<ReadonlyArray<Step>> = [
    ['release'],
    ['approval'],
    ['record'],
    ['audit'],
    ['release', 'approval'],
    ['release', 'record'],
    ['release', 'audit'],
    ['approval', 'record'],
    ['approval', 'audit'],
    ['record', 'audit'],
  ];
  const triggers = [
    'reservation failure',
    'attempt record',
    'started audit',
    'throttle preflight',
    'Resend refusal',
  ] as const;

  for (const trigger of triggers) {
    for (const failures of failureSets) {
      await t.test(`${trigger}; ${failures.join(' and ')} fail`, async () => {
        const { approval, context, send, state } = await prepared();
        const config = await harness.core.config.load();
        const accountId = config.accounts['acme/resend']?.id;
        assert.ok(accountId);
        const original: Error =
          trigger === 'throttle preflight'
            ? new Error('the throttle state could not be read before the request')
            : new CommsError('LOCK_TIMEOUT', `${trigger} stopped the send`, {
                hint: 'Keep the first hint.',
                details: { trigger },
              });
        if (trigger === 'Resend refusal') {
          harness.fake.intercept = (request) =>
            request.method === 'POST' && request.path === '/emails'
              ? { status: 400, body: { name: 'validation_error', message: 'Resend refused before sending' } }
              : undefined;
        }

        const calls: Step[] = [];
        const reserve = SendRecords.prototype.reserve;
        const release = SendRecords.prototype.release;
        const record = SendRecords.prototype.record;
        const complete = harness.core.approvals.complete.bind(harness.core.approvals);
        const append = harness.core.audit.append.bind(harness.core.audit);
        SendRecords.prototype.reserve = async function (...args) {
          await reserve.apply(this, args);
          if (trigger === 'reservation failure' && args[1] === approval.approvalId) {
            throw original;
          }
        };
        SendRecords.prototype.release = async function (id, approvalId) {
          calls.push('release');
          if (failures.includes('release')) throw new Error('release disk is read-only');
          return release.call(this, id, approvalId);
        };
        SendRecords.prototype.record = async function (id, line) {
          if (line.event === 'attempt' && trigger === 'attempt record') throw original;
          if (line.event === 'failed') {
            calls.push('record');
            if (failures.includes('record')) throw new Error('send record disk is read-only');
          }
          return record.call(this, id, line);
        };
        harness.core.approvals.complete = async (approvalId, claimToken, outcome) => {
          calls.push('approval');
          if (failures.includes('approval')) throw new Error('approval disk is read-only');
          return complete(approvalId, claimToken, outcome);
        };
        harness.core.audit.append = async (audit, ...rest) => {
          if (audit.operation !== 'resend.send.execute') return append(audit, ...rest);
          if (audit.outcome === 'started' && trigger === 'started audit') throw original;
          if (audit.outcome === 'failed') {
            calls.push('audit');
            if (failures.includes('audit')) throw new Error('audit disk is read-only');
          }
          return append(audit, ...rest);
        };
        if (trigger === 'throttle preflight') {
          context.throttle().before = async () => {
            throw original;
          };
        }

        try {
          const error = await send().then(
            () => assert.fail(`${trigger} was reported as a send`),
            (thrown: unknown) => thrown,
          );
          assert.ok(error instanceof CommsError, String(error));
          assert.deepEqual(calls, ['release', 'approval', 'record', 'audit']);
          if (original instanceof CommsError) {
            assert.ok(error.cause instanceof CommsError);
            const cause = error.cause as CommsError;
            assert.equal(error.code, cause.code);
            assert.equal(error.message, cause.message);
            assert.deepEqual(apartFromApproval(error.details), apartFromApproval(cause.details));
            if (trigger !== 'Resend refusal') assert.equal(cause, original);
            if (cause.hint !== undefined) assert.ok(error.hint?.startsWith(cause.hint));
          } else {
            assert.equal(error.code, 'UNEXPECTED');
            assert.equal(error.message, original.message);
            assert.deepEqual(apartFromApproval(error.details), {});
            assert.equal(error.cause, original);
          }
          // Where the approval stands once settled: failed — or still sending, when that could not be recorded.
          assert.equal(approvalState(error), failures.includes('approval') ? 'sending' : 'failed');
          for (const step of failures) {
            const needle = step === 'record' ? 'send record' : step;
            assert.match(error.hint ?? '', new RegExp(`${needle} .*read-only`));
          }
          assert.equal(await state(), failures.includes('approval') ? 'sending' : 'failed');
          if (trigger === 'throttle preflight') assert.equal(harness.fake.sends().length, 0);

          const records = new SendRecords(harness.core.paths.stateDir);
          const probe = await records.reserve(accountId, 'capacity-probe', { perHour: 1, perDay: 1 }).then(
            () => 'free' as const,
            (thrown: unknown) => {
              assert.ok(thrown instanceof CommsError, String(thrown));
              assert.equal(thrown.code, 'RATE_CAPPED');
              return 'held' as const;
            },
          );
          assert.equal(probe, failures.includes('release') ? 'held' : 'free');
          if (probe === 'free') await release.call(records, accountId, 'capacity-probe');
        } finally {
          SendRecords.prototype.reserve = reserve;
          SendRecords.prototype.release = release;
          SendRecords.prototype.record = record;
          harness.core.approvals.complete = complete;
          harness.core.audit.append = append;
        }
      });
    }
  }
});

test('a reservation append failure releases a possibly committed Resend slot and keeps the first error', async () => {
  const { send, state } = await prepared();
  const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
  assert.ok(accountId);
  const reserve = SendRecords.prototype.reserve;
  const original = new Error('the reservation append reached disk but its close failed');
  SendRecords.prototype.reserve = async function (...args) {
    await reserve.apply(this, args);
    throw original;
  };
  try {
    const error = await send().then(
      () => assert.fail('a failed reservation was reported as a send'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'UNEXPECTED');
    assert.equal(error.message, original.message);
    // The first error's words, and what they mean: Resend was never asked.
    assert.equal(error.hint, 'Nothing was sent.');
    assert.equal(error.cause, original);
    assert.equal(await state(), 'failed');
  } finally {
    SendRecords.prototype.reserve = reserve;
  }
  const records = new SendRecords(harness.core.paths.stateDir);
  await records.reserve(accountId, 'capacity-probe', { perHour: 1, perDay: 1 });
});

test('a Resend cap refusal takes no slot, completes the claimed approval and remains RATE_CAPPED', async () => {
  const { approval, send, state } = await prepared();
  const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
  assert.ok(accountId);
  await harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, sendCaps: { perHour: 1, perDay: 10 } },
  }));
  const records = new SendRecords(harness.core.paths.stateDir);
  await records.reserve(accountId, 'earlier-send', { perHour: 1, perDay: 10 });

  const error = await send().then(
    () => assert.fail('an over-cap send was reported as sent'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, 'RATE_CAPPED');
  assert.equal(error.message, 'nothing was sent: the send limit for this account is reached');
  assert.equal(error.cause instanceof CommsError, true);
  assert.equal(await state(), 'failed');
  const local = await records.summary(accountId, approval.approvalId);
  assert.equal(local?.state, 'failed');
  await assert.rejects(records.reserve(accountId, 'capacity-probe', { perHour: 1, perDay: 10 }), (thrown: unknown) => {
    assert.ok(thrown instanceof CommsError, String(thrown));
    return thrown.code === 'RATE_CAPPED';
  });
});

test('an unknown Resend outcome attempts its local record and audit independently without releasing the slot', async () => {
  const { approval, send, state } = await prepared();
  const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
  assert.ok(accountId);
  harness.fake.afterSend = () => ({ status: 500, body: { name: 'application_error', message: 'answer lost' } });
  const calls: string[] = [];
  const record = SendRecords.prototype.record;
  SendRecords.prototype.record = async function (id, line) {
    if (line.event === 'unknown') {
      calls.push('record');
      throw new Error('send record disk is read-only');
    }
    return record.call(this, id, line);
  };
  const append = harness.core.audit.append.bind(harness.core.audit);
  harness.core.audit.append = async (audit, ...rest) => {
    if (audit.operation === 'resend.send.execute' && audit.outcome === 'failed') {
      calls.push('audit');
      throw new Error('audit disk is read-only');
    }
    return append(audit, ...rest);
  };
  try {
    const error = await send().then(
      () => assert.fail('an unknown outcome was reported as sent'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
    assert.match(error.message, /^whether the email was sent is not known:/);
    assert.match(error.hint ?? '', /send record could not record this \(send record disk is read-only\)/);
    assert.match(error.hint ?? '', /audit log could not record this \(audit disk is read-only\)/);
    assert.ok(error.cause instanceof CommsError);
    assert.deepEqual(calls, ['record', 'audit']);
    assert.equal(await state(), 'sending');
    const records = new SendRecords(harness.core.paths.stateDir);
    await assert.rejects(records.reserve(accountId, 'capacity-probe', { perHour: 1, perDay: 1 }), (thrown: unknown) => {
      assert.ok(thrown instanceof CommsError, String(thrown));
      return thrown.code === 'RATE_CAPPED';
    });
    assert.equal((await records.summary(accountId, approval.approvalId))?.state, 'attempted');
  } finally {
    SendRecords.prototype.record = record;
    harness.core.audit.append = append;
  }
});

test('Resend success is never rewritten when its approval, send record or audit bookkeeping fails (D2pt-j)', async (t) => {
  await t.test('approval record', async () => {
    const { approval, send, state } = await prepared();
    const store = harness.core.approvals;
    const complete = store.complete.bind(store);
    store.complete = async (approvalId, claimToken, outcome) => {
      if ('sentMessageId' in outcome) throw new Error('approval disk is read-only');
      return complete(approvalId, claimToken, outcome);
    };

    const result = await send();
    assert.ok(result.resendId);
    assert.equal(result.said, 'sent');
    assert.match(result.note ?? '', /the approval could not be marked used \(approval disk is read-only\)/);
    assert.match(renderSent(result), /approval could not be marked used/);
    assert.equal(result.approval.state, 'sending', 'never a used invented');
    assert.equal(await state(), 'sending');
    // The zero-wait status: being sent until the lease boundary, then unknown — never used.
    assert.equal(await zeroWait(harness.core, approval.approvalId), 'sending');
    assert.equal(await zeroWait(later(), approval.approvalId), 'unknown');
    assert.equal(harness.fake.sends().length, 1);
  });

  await t.test('send record', async () => {
    const { send, state } = await prepared();
    const record = SendRecords.prototype.record;
    SendRecords.prototype.record = async function (accountId, line) {
      if (line.event === 'sent') throw new Error('send record disk is read-only');
      return record.call(this, accountId, line);
    };
    try {
      const result = await send();
      assert.ok(result.resendId);
      assert.match(result.note ?? '', /the send record could not record it \(send record disk is read-only\)/);
      assert.match(renderSent(result), /send record could not record it/);
      assert.equal(await state(), 'used');
    } finally {
      SendRecords.prototype.record = record;
    }
  });

  await t.test('audit record', async () => {
    const { send, state } = await prepared();
    const audit = harness.core.audit;
    const append = audit.append.bind(audit);
    audit.append = async (record, ...rest) => {
      if (record.operation === 'resend.send.execute' && record.outcome === 'ok') {
        throw new Error('audit disk is read-only');
      }
      return append(record, ...rest);
    };

    const result = await send();
    assert.ok(result.resendId);
    assert.match(result.note ?? '', /the audit log could not record it \(audit disk is read-only\)/);
    assert.match(renderSent(result), /audit log could not record it/);
    assert.equal(await state(), 'used');
  });
});

// ── The fence before every provider step (CUE-404 Task 17; design 2026-10-05 §D1) ────────────────────────────────────

/**
 * Every provider mutation `executeSend` makes, in order, each with the fence before it. Today there is one: the request
 * the one `spendOn(` in `executeSend` opens for `emails.send`. A step added to the send is added here, or the
 * completeness test below fails.
 */
interface FenceSite {
  readonly site: number;
  /** The route, by its name in `api/routes.ts`. */
  readonly route: string;
  readonly code: string;
  /**
   * Holds the claimant at the last thing it does before this step — after which only the fence is left — and runs
   * `whileHeld` there. Returns how to stop holding.
   */
  holdBefore(whileHeld: () => Promise<void>): () => void;
}

const RESEND_FENCE_SITES: readonly FenceSite[] = [
  {
    site: 1,
    route: 'emails.send',
    code: "executeSend: spendOn(permit, approvalId, 'emails.send', …)",
    holdBefore(whileHeld) {
      // The attempt is audited, durably, just before the request: the last step before the fence.
      const append = harness.core.audit.append.bind(harness.core.audit);
      harness.core.audit.append = async (audit, ...rest) => {
        const written = await append(audit, ...rest);
        if (audit.operation === 'resend.send.execute' && audit.outcome === 'started') await whileHeld();
        return written;
      };
      return () => {
        harness.core.audit.append = append;
      };
    },
  },
];

/** The route a request the fake saw was for, by the closed table's own names. */
const routeName = (request: SeenRequest) =>
  routeOf(request.method, RESEND_API_ORIGIN, request.path)?.name ?? `${request.method} ${request.path}`;

/** Requests that change something at Resend: every one is a write the route table names. */
const mutating = () =>
  harness.fake.requests.filter((request) => request.origin === 'api' && request.method !== 'GET').map(routeName);

test('the fence: a claimant held before a provider step while another caller finds its lease run out sends nothing, and records lease-lost-before-send (R11d)', async (t) => {
  for (const site of RESEND_FENCE_SITES) {
    await t.test(`site ${site.site}: ${site.route}`, async () => {
      const { approval, send, state } = await prepared();
      const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
      assert.ok(accountId);
      let held = false;
      const release = site.holdBefore(async () => {
        held = true;
        // Another caller, after the lease boundary, looks at it: `unknown`, persisted.
        const seen = await later().approvals.inspect(approval.approvalId, { kind: 'send' });
        assert.equal(seen.stored.form === 'v2' ? seen.stored.record.state : seen.stored.form, 'unknown');
      });
      try {
        const error = await send().then(
          () => assert.fail('a send went out after its lease was lost'),
          (thrown: unknown) => thrown,
        );
        assert.ok(held, 'the claimant was held before the step');
        assert.ok(error instanceof CommsError, String(error));
        assert.equal(error.code, 'APPROVAL_VOID');
        assert.match(error.message, /^nothing was sent: the sending lease ran out before anything was sent/);
        assert.equal(error.details?.reason, LEASE_LOST_BEFORE_SEND);
        assert.equal(approvalState(error), 'failed');
      } finally {
        release();
      }
      // Nothing for this site, nor any later one, reached Resend.
      const fromHere = RESEND_FENCE_SITES.filter((other) => other.site >= site.site).map((other) => other.route);
      assert.deepEqual(
        mutating().filter((route) => fromHere.includes(route)),
        [],
      );
      assert.equal(harness.fake.sent.length, 0);
      const record = asV2(await harness.core.approvals.get(approval.approvalId));
      assert.equal(record?.state, 'failed');
      assert.equal(record?.reason, LEASE_LOST_BEFORE_SEND);
      assert.equal(await state(), 'failed');
      // The rest of the no-send bookkeeping: the slot freed, the local record and the audit say it failed.
      const records = new SendRecords(harness.core.paths.stateDir);
      assert.equal((await records.summary(accountId, approval.approvalId))?.state, 'failed');
      await records.reserve(accountId, 'capacity-probe', { perHour: 1, perDay: 1 });
      assert.deepEqual(
        (await harness.audit()).filter((line) => line.operation === 'resend.send.execute').map((line) => line.outcome),
        ['started', 'failed'],
      );
    });
  }
});

test('the fence-site table is complete: a successful send, now or scheduled, makes no provider mutation it does not list', async (t) => {
  const listed = RESEND_FENCE_SITES.map((site) => site.route);
  for (const [what, over] of [
    ['now', {}],
    ['scheduled', { scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString() }],
  ] as const) {
    await t.test(what, async () => {
      const { send } = await prepared(over);
      await send();
      const seen = mutating();
      assert.deepEqual(
        seen.filter((route) => !listed.includes(route)),
        [],
        'every provider mutation of a send has a fence site',
      );
      assert.deepEqual([...new Set(seen)].sort(), [...listed].sort(), 'and every site is one a send makes');
    });
  }
});

// ── A provider success with no id (design 2026-10-05 §D8) ─────────────────────────────────────────────────────────

test('Resend accepting a send without an id is reported as exactly that, never used and never an empty id (R22b, R23e)', async (t) => {
  const at = new Date(Date.now() + 3600 * 1000).toISOString();
  for (const [what, body] of [
    ['no id', {}],
    ['a null id', { id: null }],
    ['an empty id', { id: '' }],
    ['a blank id', { id: '  ' }],
    ['an id that is not a string', { id: 42 }],
  ] as const) {
    for (const scheduledAt of [null, at]) {
      await t.test(`${what}, ${scheduledAt === null ? 'now' : 'scheduled'}`, async () => {
        const { approval, send, state } = await prepared(scheduledAt === null ? {} : { scheduledAt });
        const accountId = (await harness.core.config.load()).accounts['acme/resend']?.id;
        assert.ok(accountId);
        harness.fake.afterSend = () => ({ status: 200, body });
        const completions: unknown[] = [];
        const store = harness.core.approvals;
        const complete = store.complete.bind(store);
        store.complete = async (approvalId, claimToken, outcome) => {
          completions.push(outcome);
          return complete(approvalId, claimToken, outcome);
        };

        const result = await send();
        assert.equal(
          result.said,
          scheduledAt === null
            ? 'sent; the provider returned no id'
            : 'accepted (scheduled); the provider returned no id',
        );
        assert.equal('resendId' in result, false, 'no id, not an empty one');
        assert.equal(result.state, scheduledAt === null ? 'sent' : 'scheduled');
        assert.equal(result.scheduledAt, scheduledAt);
        assert.match(result.note ?? '', /Resend returned no id, so the approval is not marked used/);
        assert.equal(
          renderSent(result),
          scheduledAt === null
            ? 'Sent; the provider returned no id — to sam@partner.test.\nNote: Resend returned no id, so the approval is not marked used: it reads as sending, then unknown.'
            : `Accepted (scheduled); the provider returned no id — scheduled for ${at}, to sam@partner.test.\nNote: Resend returned no id, so the approval is not marked used: it reads as sending, then unknown.`,
        );
        // Never used: no completion at all, so nothing carries an id — empty or otherwise.
        assert.deepEqual(completions, []);
        assert.equal(result.approval.state, 'sending');
        assert.equal(await state(), 'sending');
        assert.equal(await zeroWait(harness.core, approval.approvalId), 'sending');
        assert.equal(await zeroWait(later(), approval.approvalId), 'unknown');
        // The audit says Resend accepted it without an id, and has no id field to carry an empty one.
        const done = (await harness.audit()).filter(
          (line) => line.operation === 'resend.send.execute' && line.outcome === 'ok',
        );
        assert.equal(done.length, 1);
        assert.equal('ids' in (done[0] ?? {}), false);
        assert.match(String(done[0]?.reason), /accepted without an id/);
        // The local record: accepted, with no id.
        const local = await new SendRecords(harness.core.paths.stateDir).summary(accountId, approval.approvalId);
        assert.equal(local?.state, 'sent');
        assert.equal(local?.resendId, undefined);
        assert.ok(
          (await harness.everyFile()).every((file) => !/"resendId":\s*""/.test(file.text)),
          'no empty id anywhere on disk',
        );
        assert.equal(harness.fake.sends().length, 1, 'one request, never a second');
      });
    }
  }
});

test('a scheduled send Resend accepted with an id says so, with the time the request asked for', async () => {
  const at = new Date(Date.now() + 3600 * 1000).toISOString();
  const { send } = await prepared({ scheduledAt: at });
  const result = await send();
  assert.ok(result.resendId);
  assert.equal(result.said, `accepted by Resend, scheduled for ${at}`);
  assert.equal(result.approval.state, 'used');
  assert.equal(
    renderSent(result),
    `Accepted by Resend, scheduled for ${at}, as ${result.resendId}, to sam@partner.test.`,
  );
});
