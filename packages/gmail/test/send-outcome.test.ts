import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ApprovalStore,
  asV2,
  CommsError,
  ERROR_REGISTRY,
  LEASE_LOST_BEFORE_SEND,
  SEND_RETRY_MAX,
  SENDING_HEARTBEAT_MS,
  SENDING_LEASE_MS,
  SendLedger,
  sendPacing,
  waitForApproval,
} from '@agentcomms/core';
import { renderSent } from '../src/cli/render.ts';
import { GmailContext } from '../src/context.ts';
import { mapGoogleError, sendCertainlyRefused } from '../src/gmail-api/errors.ts';
import type { GmailTransport } from '../src/gmail-api/transport.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { executeSend, listApprovals, prepareSend } from '../src/operations/send.ts';
import { DRAFT_SEND_PATH } from './support/fake-google.ts';
import { type Harness, newHarness } from './support/harness.ts';

/** A refusal's details apart from where its approval stands, which each test checks on its own (decision 8). */
function apartFromApproval(details: Record<string, unknown> | undefined): Record<string, unknown> {
  const { approval: _approval, ...rest } = details ?? {};
  return rest;
}
const approvalState = (error: CommsError) => (error.details?.approval as { state?: string } | undefined)?.state;

/**
 * Once the request has left, a failed answer and a failed send are different facts. These tests keep the approval on
 * the honest side of that difference: failed only when Gmail certainly refused, sending when the outcome is unknown,
 * and used whenever Gmail answered that it sent the message even if the local bookkeeping then broke.
 */

async function world(): Promise<{ harness: Harness; context: GmailContext; draftId: string }> {
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
  // A throttled send's waits are recorded, not slept (design 2026-10-08 §R2).
  const context = new GmailContext({
    core: harness.core,
    env: harness.env,
    sendPacing: () => sendPacing({ sleep: async () => undefined }),
  });
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tuesday',
    text: 'Tuesday works for me.',
  });
  return { harness, context, draftId: draft.draftId };
}

async function prepared(setup: Awaited<ReturnType<typeof world>>) {
  const approval = await prepareSend(setup.context, 'work', setup.draftId);
  const send = () =>
    executeSend(setup.context, 'work', {
      draftId: setup.draftId,
      approvalId: approval.approvalId,
      expect: approval.expect,
    });
  const state = async () => asV2(await setup.harness.core.approvals.get(approval.approvalId))?.state;
  return { approval, send, state };
}

/**
 * The same world on a clock of its own, read by the approvals and the ledger — and by `other()`, another process's
 * store over the same state directory, which is how a second caller looks at a send under way.
 */
function onClock(setup: Awaited<ReturnType<typeof world>>) {
  let at = Date.now();
  const now = () => new Date(at);
  const stateDir = setup.harness.core.paths.stateDir;
  const open = () => new ApprovalStore(stateDir, { now, loadConfig: () => setup.harness.core.config.load() });
  setup.harness.core.approvals = open();
  setup.harness.core.ledger = new SendLedger(stateDir, now);
  return {
    now,
    advance: (ms: number) => {
      at += ms;
    },
    other: open,
    file: (approvalId: string) =>
      JSON.parse(readFileSync(join(stateDir, 'approvals', `${approvalId}.json`), 'utf8')) as Record<string, unknown>,
  };
}

/** Another draft of the world's mailbox, prepared. */
async function preparedAnother(setup: Awaited<ReturnType<typeof world>>, text: string) {
  const draft = await createDraft(setup.context, 'work', { to: ['sam@partner.test'], subject: 'Again', text });
  return prepared({ ...setup, draftId: draft.draftId });
}

/** Waits, in real time, for `check` to hold. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (await check()) return;
    await sleep(5);
  }
  assert.fail(`never: ${what}`);
}

const sendsTo = (setup: Awaited<ReturnType<typeof world>>) =>
  setup.harness.google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length;

test('Gmail’s certain-refusal classifier is a narrow allowlist', () => {
  for (const status of [400, 401, 403, 404, 429]) {
    const mapped = mapGoogleError({ response: { status, data: { error: { code: status, message: 'refused' } } } });
    assert.equal(sendCertainlyRefused(mapped), true, String(status));
  }
  for (const status of [405, 408, 409, 422, 500]) {
    const mapped = mapGoogleError({ response: { status, data: { error: { code: status, message: 'uncertain' } } } });
    assert.equal(sendCertainlyRefused(mapped), false, String(status));
  }
  assert.equal(sendCertainlyRefused(mapGoogleError(new Error('connection dropped'))), false);
  assert.equal(sendCertainlyRefused(new CommsError('SEND_REFUSED', 'the local guard stopped it')), true);
});

test('Gmail acting before its answer is lost leaves the approval sending and tells the person where to check', async () => {
  const setup = await world();
  const { approval, send, state } = await prepared(setup);
  setup.harness.google.afterSend = () => ({
    status: 500,
    body: { error: { code: 500, message: 'the answer was lost after Gmail accepted the draft' } },
  });

  const error = await send().then(
    () => assert.fail('the lost answer was reported as a confirmed send'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError);
  // Uncertain the moment the answer is lost: its own code, never retryable, never TRANSIENT (D2pt-b).
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(ERROR_REGISTRY[error.code].retryable, false);
  assert.match(error.message, /^whether the email was sent is not known:/);
  assert.match(error.hint ?? '', /^Check the Sent folder before anything else/);
  assert.match(error.hint ?? '', /This approval is not used again\./);
  assert.match(error.hint ?? '', /Do not prepare the draft again automatically/);
  assert.equal(error.details?.outcome, 'unknown');
  const sending = error.details?.approval as Record<string, unknown>;
  assert.equal(sending.state, 'sending');
  assert.equal(sending.claimable, false);
  assert.equal(typeof sending.sendingAt, 'string');
  // The fence before the send renewed the lease: unknownAt is from that renewal, or from the claim.
  const renewed = Date.parse(String(sending.sendingHeartbeatAt ?? sending.sendingAt));
  assert.equal(sending.unknownAt, new Date(renewed + SENDING_LEASE_MS).toISOString());
  assert.equal(await state(), 'sending');
  const later = new ApprovalStore(setup.harness.core.paths.stateDir, {
    now: () => new Date(Date.now() + SENDING_LEASE_MS),
    loadConfig: () => setup.harness.core.config.load(),
  });
  assert.equal(asV2(await later.get(approval.approvalId))?.state, 'unknown');
  assert.equal(setup.harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 1);
  const account = setup.harness.google.accounts.get('sub-1');
  assert.equal(
    Object.values(account?.messages ?? {}).filter((message) => message.labelIds?.includes('SENT')).length,
    1,
  );
  const audit = await setup.harness.core.audit.tail({ inbox: 'work' });
  const outcome = audit.findLast((entry) => entry.operation === 'send.execute');
  assert.equal(outcome?.outcome, 'failed');
  assert.match(outcome?.reason ?? '', /^outcome unknown:/);
  assert.equal(Array.isArray(outcome?.ids?.approvalIds), true);
  assert.equal((outcome?.ids?.approvalIds as string[] | undefined)?.[0], approval.approvalId);
});

test('only Gmail responses documented as pre-action refusals mark the approval failed', async (t) => {
  for (const status of [400, 401, 403, 404, 429]) {
    await t.test(String(status), async () => {
      const setup = await world();
      const { send, state } = await prepared(setup);
      // A 429 is a throttle: the send tries again within its pacing (design 2026-10-08 §R1), so it is refused for good
      // only once Gmail has refused every attempt — the first and SEND_RETRY_MAX more.
      setup.harness.google.failNext(DRAFT_SEND_PATH, status === 429 ? SEND_RETRY_MAX + 1 : 1, status);

      const error = await send().then(
        () => assert.fail(`${status} was reported as a send`),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof CommsError);
      assert.equal(await state(), 'failed');
      assert.doesNotMatch(error.message, /not known/);
      // A certain refusal says so: nothing was sent (D2pt-f).
      assert.match(error.message, /^nothing was sent: /);
      assert.equal(error.details?.outcome, undefined);

      const retry = await send().then(
        () => assert.fail(`${status} reused a failed approval`),
        (thrown: unknown) => thrown,
      );
      assert.ok(retry instanceof CommsError);
      // The record's own state, classified before Google is asked anything: refused for what it is.
      assert.match(retry.message, /^nothing was sent: the send it was claimed for failed/);
      assert.equal(approvalState(retry), 'failed');
    });
  }

  await t.test('422 is not one of Gmail’s documented responses', async () => {
    const setup = await world();
    const { send, state } = await prepared(setup);
    setup.harness.google.failNext(DRAFT_SEND_PATH, 1, 422);

    const error = await send().then(
      () => assert.fail('422 was reported as a send'),
      (thrown: unknown) => thrown,
    );
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
    assert.equal(await state(), 'sending');
    assert.equal(error.details?.outcome, 'unknown');
  });
});

test('a final draft read failure is a certain no-send whose slot, approval and audit are settled', async () => {
  const setup = await world();
  const { approval, send, state } = await prepared(setup);
  const transport = await setup.context.transport('work');
  const getDraft = transport.getDraft.bind(transport);
  const original = new CommsError('LOCK_TIMEOUT', 'the final draft read could not finish', {
    hint: 'This is the first failure.',
    details: { phase: 'final-read' },
  });
  let reads = 0;
  transport.getDraft = async (draftId) => {
    reads += 1;
    if (reads === 2) throw original;
    return getDraft(draftId);
  };

  const error = await send().then(
    () => assert.fail('a send whose final draft read failed was reported as sent'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, original.code);
  assert.equal(error.message, original.message);
  assert.equal(error.hint, original.hint);
  assert.deepEqual(apartFromApproval(error.details), original.details);
  assert.equal(approvalState(error), 'failed', 'and says where the approval stands now');
  assert.equal(error.cause, original);
  assert.equal(await state(), 'failed');
  const inbox = (await setup.harness.core.config.load()).inboxes.work;
  assert.ok(inbox);
  assert.deepEqual(await setup.harness.core.ledger.status(inbox.id, { perHour: 20, perDay: 100 }), {
    hour: 0,
    day: 0,
  });
  assert.equal(setup.harness.google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
  const audit = await setup.harness.core.audit.tail({ inbox: 'work' });
  const outcome = audit.findLast((entry) => entry.operation === 'send.execute');
  assert.equal(outcome?.outcome, 'failed');
  assert.equal(outcome?.reason, original.message);
  assert.equal((outcome?.ids?.approvalIds as string[] | undefined)?.[0], approval.approvalId);
});

test('every certain no-send path attempts each bookkeeping step independently', async (t) => {
  const failureSets: ReadonlyArray<ReadonlyArray<'release' | 'approval' | 'audit'>> = [
    ['release'],
    ['approval'],
    ['audit'],
    ['release', 'approval'],
    ['release', 'audit'],
    ['approval', 'audit'],
  ];
  const triggers = [
    'claimed draft mismatch',
    'reservation failure',
    'final draft read',
    'changed draft',
    'Gmail refusal',
  ] as const;

  for (const trigger of triggers) {
    for (const failures of failureSets) {
      await t.test(`${trigger}; ${failures.join(' and ')} fail`, async () => {
        const setup = await world();
        const { send, state } = await prepared(setup);
        const transport = await setup.context.transport('work');
        const original = new CommsError('SEND_REFUSED', `${trigger} stopped the send`, {
          hint: 'Keep the first hint.',
          details: { trigger },
        });
        const reserve = setup.harness.core.ledger.reserve.bind(setup.harness.core.ledger);
        if (trigger === 'claimed draft mismatch') {
          const claimForSend = setup.harness.core.approvals.claimForSend.bind(setup.harness.core.approvals);
          setup.harness.core.approvals.claimForSend = async (...args) => {
            const claim = await claimForSend(...args);
            return { ...claim, record: { ...claim.record, draftId: 'dr_another_draft' } };
          };
        } else if (trigger === 'reservation failure') {
          setup.harness.core.ledger.reserve = async (...args) => {
            await reserve(...args);
            throw original;
          };
        }
        if (trigger === 'final draft read' || trigger === 'changed draft') {
          const getDraft = transport.getDraft.bind(transport);
          let reads = 0;
          transport.getDraft = async (draftId) => {
            reads += 1;
            const draft = await getDraft(draftId);
            if (reads !== 2) return draft;
            if (trigger === 'final draft read') throw original;
            return {
              ...draft,
              message: draft.message ? { ...draft.message, id: `${draft.message.id ?? 'message'}-changed` } : undefined,
            };
          };
        } else {
          transport.sendDraft = async () => {
            throw original;
          };
        }

        const calls: string[] = [];
        const release = setup.harness.core.ledger.release.bind(setup.harness.core.ledger);
        setup.harness.core.ledger.release = async (inboxId, approvalId) => {
          calls.push('release');
          if (failures.includes('release')) throw new Error('release disk is read-only');
          return release(inboxId, approvalId);
        };
        const complete = setup.harness.core.approvals.complete.bind(setup.harness.core.approvals);
        setup.harness.core.approvals.complete = async (approvalId, claimToken, outcome) => {
          calls.push('approval');
          if (failures.includes('approval')) throw new Error('approval disk is read-only');
          return complete(approvalId, claimToken, outcome);
        };
        const append = setup.harness.core.audit.append.bind(setup.harness.core.audit);
        setup.harness.core.audit.append = async (record, ...rest) => {
          if (record.operation !== 'send.execute') return append(record, ...rest);
          calls.push('audit');
          if (failures.includes('audit')) throw new Error('audit disk is read-only');
          return append(record, ...rest);
        };

        const error = await send().then(
          () => assert.fail(`${trigger} was reported as a send`),
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof CommsError, String(error));
        assert.deepEqual(calls, ['release', 'approval', 'audit']);
        if (trigger === 'claimed draft mismatch') {
          assert.equal(error.code, 'APPROVAL_VOID');
          assert.equal(error.message, 'nothing was sent: this approval was prepared for a different draft');
          assert.ok(error.cause instanceof CommsError);
          assert.equal(error.cause.message, error.message);
        } else if (trigger === 'changed draft') {
          assert.equal(error.code, 'APPROVAL_VOID');
          assert.equal(error.message, 'nothing was sent: the draft changed while it was being sent');
          assert.ok(error.cause instanceof CommsError);
          assert.equal(error.cause.message, error.message);
        } else {
          assert.equal(error.code, original.code);
          // Gmail's own refusal of the send says nothing was sent (D2pt-f); the steps before it keep their words.
          assert.equal(
            error.message,
            trigger === 'Gmail refusal' ? `nothing was sent: ${original.message}` : original.message,
          );
          assert.deepEqual(apartFromApproval(error.details), original.details);
          assert.equal(error.cause, original);
        }
        // Where the approval stands once settled: failed — or still sending, when that could not be recorded.
        assert.equal(approvalState(error), failures.includes('approval') ? 'sending' : 'failed');
        assert.match(error.hint ?? '', /^Keep the first hint\.|^Prepare the send again/);
        for (const step of failures) assert.match(error.hint ?? '', new RegExp(`${step} .*read-only`));
        assert.equal(await state(), failures.includes('approval') ? 'sending' : 'failed');
        const inbox = (await setup.harness.core.config.load()).inboxes.work;
        assert.ok(inbox);
        assert.equal(
          (await setup.harness.core.ledger.status(inbox.id, { perHour: 20, perDay: 100 })).hour,
          failures.includes('release') && trigger !== 'claimed draft mismatch' ? 1 : 0,
        );
      });
    }
  }
});

test('a reservation append failure releases a possibly committed slot and keeps the first error', async () => {
  const setup = await world();
  const { send, state } = await prepared(setup);
  const reserve = setup.harness.core.ledger.reserve.bind(setup.harness.core.ledger);
  const original = new Error('the reservation append reached disk but its close failed');
  setup.harness.core.ledger.reserve = async (...args) => {
    await reserve(...args);
    throw original;
  };

  const error = await send().then(
    () => assert.fail('a failed reservation was reported as a send'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, 'UNEXPECTED');
  assert.equal(error.message, original.message);
  assert.equal(error.hint, undefined);
  assert.equal(error.cause, original);
  assert.equal(await state(), 'failed');
  const inbox = (await setup.harness.core.config.load()).inboxes.work;
  assert.ok(inbox);
  assert.equal((await setup.harness.core.ledger.status(inbox.id, { perHour: 20, perDay: 100 })).hour, 0);
});

test('a cap refusal takes no slot, completes the claimed approval and remains RATE_CAPPED', async () => {
  const setup = await world();
  const { approval, send, state } = await prepared(setup);
  const inbox = (await setup.harness.core.config.load()).inboxes.work;
  assert.ok(inbox);
  await setup.harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, sendCaps: { perHour: 1, perDay: 10 } },
  }));
  await setup.harness.core.ledger.reserve(inbox.id, 'earlier-send', { perHour: 1, perDay: 10 });

  const error = await send().then(
    () => assert.fail('an over-cap send was reported as sent'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, 'RATE_CAPPED');
  assert.equal(error.message, 'nothing was sent: the send limit for this inbox is reached');
  assert.equal(error.details?.hour, 1);
  assert.equal(error.cause instanceof CommsError, true);
  assert.equal(await state(), 'failed');
  assert.equal((await setup.harness.core.ledger.status(inbox.id, { perHour: 1, perDay: 10 })).hour, 1);
  const audit = await setup.harness.core.audit.tail({ inbox: 'work' });
  const outcome = audit.findLast((entry) => entry.operation === 'send.execute');
  assert.equal(outcome?.outcome, 'failed');
  assert.equal((outcome?.ids?.approvalIds as string[] | undefined)?.[0], approval.approvalId);
});

test('an unknown Gmail outcome keeps its slot and approval when its audit also fails', async () => {
  const setup = await world();
  const { approval, send, state } = await prepared(setup);
  const transport = await setup.context.transport('work');
  const original = new CommsError('PROVIDER_UNAVAILABLE', 'the connection ended after the request left', {
    hint: 'The provider answer was lost.',
    details: { providerRequest: 'gmail-send-1' },
  });
  transport.sendDraft = async () => {
    throw original;
  };
  const append = setup.harness.core.audit.append.bind(setup.harness.core.audit);
  setup.harness.core.audit.append = async (record, ...rest) => {
    if (record.operation === 'send.execute') throw new Error('audit disk is read-only');
    return append(record, ...rest);
  };

  const error = await send().then(
    () => assert.fail('an unknown outcome was reported as sent'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN', 'never the transport’s retryable code');
  assert.match(error.message, /^whether the email was sent is not known:/);
  assert.match(error.hint ?? '', /^Check the Sent folder/);
  assert.match(error.hint ?? '', /audit log could not record this either \(audit disk is read-only\)/);
  assert.deepEqual(apartFromApproval(error.details), {
    providerRequest: 'gmail-send-1',
    approvalId: approval.approvalId,
    outcome: 'unknown',
  });
  assert.equal(approvalState(error), 'sending', 'nothing is recorded of a send whose outcome is not known');
  assert.equal(error.cause, original);
  assert.equal(await state(), 'sending');
  const inbox = (await setup.harness.core.config.load()).inboxes.work;
  assert.ok(inbox);
  assert.equal((await setup.harness.core.ledger.status(inbox.id, { perHour: 20, perDay: 100 })).hour, 1);
});

test('Gmail success is never rewritten when its approval or audit bookkeeping fails', async (t) => {
  await t.test('approval record', async () => {
    const setup = await world();
    const clock = onClock(setup);
    const { approval, send, state } = await prepared(setup);
    const store = setup.harness.core.approvals;
    const complete = store.complete.bind(store);
    store.complete = async (approvalId, claimToken, outcome) => {
      if ('sentMessageId' in outcome) throw new Error('approval disk is read-only');
      return complete(approvalId, claimToken, outcome);
    };

    const result = await send();
    assert.ok(result.sentMessageId);
    assert.equal(result.said, `sent, message id ${result.sentMessageId}`, 'an outward success');
    assert.match(result.note ?? '', /the approval could not be marked used \(approval disk is read-only\)/);
    assert.match(result.note ?? '', /so it will read as unknown/);
    assert.equal(result.approval.state, 'sending', 'never a used invented');
    assert.match(renderSent(result, false), /approval could not be marked used/);
    assert.equal(await state(), 'sending');
    // Later looks: sending while its lease lasts, unknown from its boundary on — never used (D2pt-h).
    const status = async () =>
      (await waitForApproval(setup.harness.core, approval.approvalId, { waitSeconds: 0, channel: 'gmail' })).state;
    const listed = async () =>
      (await listApprovals(setup.context, { inbox: 'work' })).approvals.find(
        (entry) => entry.approvalId === approval.approvalId,
      )?.state;
    assert.equal(await status(), 'sending');
    assert.equal(await listed(), 'sending');
    clock.advance(SENDING_LEASE_MS);
    assert.equal(await status(), 'unknown');
    assert.equal(await listed(), 'unknown');
  });

  await t.test('audit record', async () => {
    const setup = await world();
    const { send, state } = await prepared(setup);
    const audit = setup.harness.core.audit;
    const append = audit.append.bind(audit);
    audit.append = async (record, ...rest) => {
      if (record.operation === 'send.execute' && record.outcome === 'ok') {
        throw new Error('audit disk is read-only');
      }
      return append(record, ...rest);
    };

    const result = await send();
    assert.ok(result.sentMessageId);
    assert.match(result.note ?? '', /the audit log could not record it \(audit disk is read-only\)/);
    assert.match(renderSent(result, false), /audit log could not record it/);
    assert.equal(await state(), 'used');
  });
});

// ── The fence before every provider mutation (CUE-404 Task 12; design 2026-10-05 §D1, "Version-2 timestamps") ──────

/** One provider mutation `executeSend` makes, and how a test reaches the moment just before it. */
interface FenceSite {
  /** The mutation as the fake Google records it. */
  readonly method: string;
  readonly path: string;
  /**
   * Arranges for `pause` to run as the claimant reaches this mutation: right after the step `executeSend` takes just
   * before it, and so before the fence that guards it — the claimant suspended there, past its lease.
   */
  readonly reach: (transport: GmailTransport, pause: () => Promise<void>) => void;
}

/**
 * Every provider mutation `executeSend` makes, each with a fence before it. Today that is one: the send itself,
 * `drafts/send` through `transport.sendDraft`, reached after the ledger reservation and the final draft re-read. A
 * mutation `executeSend` gains must be listed here — the completeness test below fails until it is — and so gets its
 * own case in the fence test.
 */
const GMAIL_FENCE_SITES: readonly FenceSite[] = [
  {
    method: 'POST',
    path: DRAFT_SEND_PATH,
    // The step before it: the final draft re-read, the second read of the draft in `executeSend`.
    reach: (transport, pause) => {
      const getDraft = transport.getDraft.bind(transport);
      let reads = 0;
      transport.getDraft = async (draftId) => {
        const draft = await getDraft(draftId);
        reads += 1;
        if (reads === 2) await pause();
        return draft;
      };
    },
  },
];

test('a claimant suspended past its lease just before a provider mutation starts none of it: lease-lost-before-send, nothing sent (R11b)', async (t) => {
  for (const site of GMAIL_FENCE_SITES) {
    await t.test(`${site.method} ${site.path}`, async () => {
      const setup = await world();
      const clock = onClock(setup);
      const { approval, send, state } = await prepared(setup);
      site.reach(await setup.context.transport('work'), async () => {
        // Suspended here, renewing nothing, past its lease; another caller looks, and persists `unknown`.
        clock.advance(SENDING_LEASE_MS);
        const seen = await clock.other().inspect(approval.approvalId);
        assert.equal(seen.outcome.state, 'unknown');
        assert.equal(clock.file(approval.approvalId).state, 'unknown', 'persisted by the other caller');
      });
      const from = setup.harness.google.requests.length;

      const error = await send().then(
        () => assert.fail('a claimant whose lease ran out went on to send'),
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof CommsError, String(error));
      assert.equal(error.code, 'APPROVAL_VOID');
      assert.match(error.message, /^nothing was sent: /);
      assert.equal(
        setup.harness.google.requests
          .slice(from)
          .filter((request) => request.method === site.method && request.path === site.path).length,
        0,
        'no request for that site reached Gmail',
      );
      assert.equal(await state(), 'failed');
      assert.equal(clock.file(approval.approvalId).reason, LEASE_LOST_BEFORE_SEND);
      const settled = error.details?.approval as Record<string, unknown>;
      assert.equal(settled.state, 'failed');
      assert.equal(settled.reason, LEASE_LOST_BEFORE_SEND);
      // Nothing went, so the slot it reserved is given back, and the audit says why.
      const inbox = (await setup.harness.core.config.load()).inboxes.work;
      assert.ok(inbox);
      assert.equal((await setup.harness.core.ledger.status(inbox.id, { perHour: 20, perDay: 100 })).hour, 0);
      const audit = await setup.harness.core.audit.tail({ inbox: 'work' });
      const outcome = audit.findLast((entry) => entry.operation === 'send.execute');
      assert.equal(outcome?.outcome, 'failed');
      assert.match(outcome?.reason ?? '', new RegExp(LEASE_LOST_BEFORE_SEND));
    });
  }
});

test('the fence-site table lists every provider mutation a successful send makes, and nothing else', async () => {
  const setup = await world();
  const { send } = await prepared(setup);
  const from = setup.harness.google.requests.length;
  await send();
  // A mutation is anything but a read of Gmail: OAuth's own token requests are the client's, not the mailbox's.
  const made = setup.harness.google.requests
    .slice(from)
    .filter((request) => request.path.startsWith('/gmail/') && request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);
  assert.deepEqual(
    [...new Set(made)].sort(),
    GMAIL_FENCE_SITES.map((site) => `${site.method} ${site.path}`).sort(),
    'executeSend made a provider mutation the fence-site table does not list: list it, with a fence before it',
  );
});

test('a send Gmail holds across several renewals stays sending, then records what Gmail said — sent, and again refused (R10c)', async (t) => {
  for (const outcome of ['used', 'failed'] as const) {
    await t.test(outcome, async (t) => {
      const setup = await world();
      const clock = onClock(setup);
      const { approval, send, state } = await prepared(setup);
      const id = approval.approvalId;
      // The real transport against the loopback fake, which holds the send open: Gmail still working.
      const held = setup.harness.google.holdNext(DRAFT_SEND_PATH);
      if (outcome === 'failed') setup.harness.google.failNext(DRAFT_SEND_PATH, 1, 400);
      t.mock.timers.enable({ apis: ['setInterval'] });
      const settled = send().then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      await held.reached;
      const claimedAt = Date.parse(String(clock.file(id).sendingAt));
      for (let beat = 1; beat <= 5; beat += 1) {
        clock.advance(SENDING_HEARTBEAT_MS);
        t.mock.timers.tick(SENDING_HEARTBEAT_MS);
        await until(
          () => clock.file(id).sendingHeartbeatAt === clock.now().toISOString(),
          `renewal ${beat} written while Gmail holds the send`,
        );
        // Another caller looks: still sending — past two minutes from the claim, inside the lease it renewed.
        const seen = await clock.other().inspect(id);
        assert.equal(seen.outcome.state, 'sending', `after renewal ${beat}`);
      }
      assert.ok(clock.now().getTime() - claimedAt > SENDING_LEASE_MS, 'held beyond the lease of the claim alone');
      assert.equal(await state(), 'sending');
      held.release();
      const { result, error } = await settled;
      if (outcome === 'used') {
        assert.ok(result, String(error));
        assert.equal(result.approval.state, 'used');
        assert.equal(await state(), 'used');
        assert.equal(clock.file(id).sendingHeartbeatAt, clock.now().toISOString(), 'its last renewal is kept');
      } else {
        assert.ok(error instanceof CommsError, String(error));
        assert.match(error.message, /^nothing was sent: /);
        assert.equal(await state(), 'failed');
      }
      assert.equal(sendsTo(setup), 1);
    });
  }
});

test('a claim across the hourly cap rollover is counted when its slot is reserved, after the claim (D1rr-f)', async () => {
  const setup = await world();
  const clock = onClock(setup);
  await setup.harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, sendCaps: { perHour: 1, perDay: 10 } },
  }));
  const first = await prepared(setup);
  await first.send();
  const hour = 60 * 60 * 1000;

  // Claimed and reserved inside the hour: the cap refuses it, its approval fails, and nothing is sent.
  clock.advance(hour - 5 * 60 * 1000);
  const early = await preparedAnother(setup, 'Before the hour is out.');
  clock.advance(5 * 60 * 1000 - 1);
  const refused = await early.send().then(
    () => assert.fail('a send over the hourly cap went'),
    (thrown: unknown) => thrown,
  );
  assert.ok(refused instanceof CommsError);
  assert.equal(refused.code, 'RATE_CAPPED');
  assert.equal(await early.state(), 'failed');

  // Claimed in the hour's last millisecond, its slot reserved at the rollover: the reservation is what counts.
  const late = await preparedAnother(setup, 'At the hour.');
  const store = setup.harness.core.approvals;
  const claim = store.claimForSend.bind(store);
  let claimedAt = '';
  store.claimForSend = async (...args) => {
    const claimed = await claim(...args);
    claimedAt = claimed.record.sendingAt ?? '';
    clock.advance(1);
    return claimed;
  };
  const sent = await late.send();
  assert.equal(sent.approval.state, 'used');
  assert.ok(
    Date.parse(claimedAt) < Date.parse(String(asV2(await store.get(first.approval.approvalId))?.sentAt)) + hour,
  );

  // The approval the cap refused stays refused after the rollover: it was claimed once, and failed.
  const again = await early.send().then(
    () => assert.fail('a failed approval was used after the rollover'),
    (thrown: unknown) => thrown,
  );
  assert.ok(again instanceof CommsError);
  assert.match(again.message, /^nothing was sent: the send it was claimed for failed/);
  assert.equal(sendsTo(setup), 2);
});

test('Gmail accepting a send without an id is said as exactly that: never used, never an empty id, no read-back (D8o-e, D8o-g)', async (t) => {
  const bodies: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['no id', { threadId: 't-1', labelIds: ['SENT'] }],
    ['an empty id', { id: '', threadId: 't-1' }],
    ['a null id', { id: null }],
  ];
  for (const [name, body] of bodies) {
    await t.test(name, async () => {
      const setup = await world();
      const clock = onClock(setup);
      const { approval, send, state } = await prepared(setup);
      setup.harness.google.afterSend = () => ({ status: 200, body });
      const transport = await setup.context.transport('work');
      // What the transport hands back, from a send this approval made.
      const returned: Array<{ id: string | undefined }> = [];
      const sendDraft = transport.sendDraft.bind(transport);
      transport.sendDraft = async (draftId) => {
        const answer = await sendDraft(draftId);
        returned.push(answer);
        return answer;
      };
      const readBacks: string[] = [];
      const metadata = transport.getMessageMetadata.bind(transport);
      transport.getMessageMetadata = async (messageId) => {
        readBacks.push(messageId);
        return metadata(messageId);
      };
      const completions: unknown[] = [];
      const store = setup.harness.core.approvals;
      const complete = store.complete.bind(store);
      store.complete = async (approvalId, claimToken, outcome) => {
        completions.push(outcome);
        return complete(approvalId, claimToken, outcome);
      };
      const audited: unknown[] = [];
      const append = setup.harness.core.audit.append.bind(setup.harness.core.audit);
      setup.harness.core.audit.append = async (record, ...rest) => {
        if (record.operation === 'send.execute') audited.push(record);
        return append(record, ...rest);
      };

      const result = await send();
      assert.equal(returned.length, 1);
      assert.equal(returned[0]?.id, undefined, 'absent, never the empty string');
      assert.equal(result.said, 'sent; the provider returned no id');
      assert.equal(result.sentMessageId, undefined);
      assert.equal('sentMessageId' in result, false);
      assert.equal(result.approval.state, 'sending', 'never used');
      assert.equal(result.approval.sentMessageId, undefined);
      assert.equal(result.verified, null, 'nothing to read back by');
      assert.deepEqual(completions, [], 'no completion: there is no id to record it by');
      assert.deepEqual(readBacks, [], 'no read-back with no id');
      assert.equal(audited.length, 1);
      const line = audited[0] as { outcome: string; ids?: Record<string, unknown>; reason?: string };
      assert.equal(line.outcome, 'ok');
      assert.match(line.reason ?? '', /^accepted-without-id/);
      assert.equal(line.ids?.messageIds, undefined, 'the id field is left out');
      assert.ok(!JSON.stringify(audited).includes('""'), 'no empty id anywhere in the audit line');
      assert.equal(await state(), 'sending');
      const rendered = renderSent(result, false);
      assert.match(rendered, /sent; the provider returned no id/);
      assert.doesNotMatch(rendered, /undefined|message id/);
      // And at its lease boundary it reads unknown, as nothing recorded it.
      clock.advance(SENDING_LEASE_MS);
      assert.equal(
        (await waitForApproval(setup.harness.core, approval.approvalId, { waitSeconds: 0, channel: 'gmail' })).state,
        'unknown',
      );
      assert.equal(sendsTo(setup), 1);
    });
  }
});
