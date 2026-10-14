import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApprovalStore,
  asV2,
  CommsError,
  SENDING_LEASE_MS,
  TaintCollector,
  TaintStore,
  UNSENT_WORDS,
} from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { taintExclusions } from '../src/operations/read.ts';
import { listApprovals } from '../src/operations/send.ts';
import { DRAFT_SEND_PATH } from './support/fake-google.ts';
import { locatedGmailLine } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { type Connected, cli, connect, type ToolResult } from './support/surfaces.ts';

/*
 * CUE-404's acceptance, end to end with fake Gmail (design 2026-10-05 §1 "Acceptance, made exact" and §5
 * "Acceptance", ACC-a to ACC-f; CUE-404 Task 24).
 *
 * The ticket: one email to an internal colleague took four attempts and twenty minutes — the send escalated on
 * `recipient-tainted`, the client could not show a form, the approval given at the terminal at 22:48:22 was never
 * learned by the agent, and it expired unused at 22:52:46, ten minutes after it was *created*. Here the same email is
 * one prepare and one decision: the person approves once at the terminal, the agent learns it by waiting, and sends
 * with the same record — no second prepare, no second preview in the chat, and nothing asks again.
 *
 * Two mailboxes, as the owner had: `work` (example.test is its own domain) and `home` (another domain). The colleague's
 * address was read in mail in `home` — where it is external, so it was recorded — and `work` sends to it. The client is
 * an ordinary one, trusted with no forms. The approval store runs on the test's clock.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const COLLEAGUE = 'ana@example.test';
const SUBJECT = 'Tuesday';
const BODY = 'Tuesday works for me.';

interface World {
  harness: Harness;
  context: GmailContext;
  /** The approval store's clock: set, or moved on. */
  clock: { at: number };
  agent: Connected;
  /** Every tool the agent called, in order. */
  calls: string[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

async function world(start = Date.now()): Promise<World> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
      },
      { sub: 'sub-2', email: 'kim@home.test' },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  await harness.connectInbox({ alias: 'home', email: 'kim@home.test', sub: 'sub-2', sendPolicy: 'chat' });
  // Each mailbox's own domain is internal to it, as a new mailbox's is.
  await harness.core.config.update(
    (config) => ({
      ...config,
      inboxes: Object.fromEntries(
        Object.entries(config.inboxes).map(([alias, inbox]) => [
          alias,
          { ...inbox, internalDomains: [alias === 'work' ? 'example.test' : 'home.test'] },
        ]),
      ),
    }),
    { consent: { kind: 'loosening-consent', paths: ['inboxes.work.internalDomains', 'inboxes.home.internalDomains'] } },
  );
  const clock = { at: start };
  const now = () => new Date(clock.at);
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now,
    handoffs: harness.core.handoffs,
    loadConfig: () => harness.core.config.load(),
    audit: harness.core.audit,
  });
  harness.core.taint = new TaintStore(harness.core.paths.stateDir, now);
  const context = new GmailContext({ core: harness.core, env: harness.env, platform: 'darwin' });
  const agent = await connect({ core: harness.core, env: harness.env });
  const calls: string[] = [];
  return {
    harness,
    context,
    clock,
    agent,
    calls,
    call: async (name, args) => {
      calls.push(name);
      return agent.call(name, args);
    },
    close: () => agent.close(),
  };
}

/** Mail read in `alias` that named `addresses` in its headers — recorded as every read path records it. */
async function readIn(w: World, alias: string, addresses: string[]): Promise<void> {
  const { inbox } = await w.context.inbox(alias);
  const collector = new TaintCollector(inbox.id, `m-${alias}-${addresses.join(',')}`);
  collector.observeHeaders(addresses);
  await collector.flush(w.harness.core.taint, await taintExclusions(w.context, alias));
}

async function draftTo(w: World, to: string): Promise<string> {
  return (await createDraft(w.context, 'work', { to: [to], subject: SUBJECT, text: BODY })).draftId;
}

interface Preparation {
  approvalId: string;
  preview: string;
  riskFlags: string[];
  effectivePolicy: string;
  expect: { to: string[]; cc: string[]; bcc: string[]; subject: string };
  approval: Record<string, unknown>;
  nextStep: string;
}

function body<T>(result: ToolResult): T {
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  return result.structuredContent as T;
}

function refusal(result: ToolResult): { code: string; message: string; hint: string | null } {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return (result.structuredContent as { error: { code: string; message: string; hint: string | null } }).error;
}

/** The person, at their own terminal: `agent-gmail approve <id>`, reading the preview and typing the code back. */
async function approveAtTerminal(w: World, approvalId: string) {
  const run = await cli(w.harness, ['approve', approvalId], { tty: true, answer: true });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const shown = run.stdout + run.stderr;
  assert.equal(shown.match(/SEND PREVIEW/g)?.length, 1, 'one standard rendering, the ceremony itself');
  assert.equal(shown.match(/Type \S+ to send this/g)?.length, 1, 'one decision');
  assert.match(run.stdout, /^Approved\./m);
  return shown;
}

const sendsOf = (w: World) => w.harness.google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length;
const approvalsOf = async (w: World) => (await w.harness.core.approvals.list()).map((stored) => asV2(stored));

/**
 * The ticket's story with this release: the tainted internal recipient prepared once, approved at the terminal at
 * `approveAt`, learned by waiting at `waitAt`, and sent at `sendAt` — each a time after the prepare.
 */
async function oneDecision(w: World, times: { approveAt: number; waitAt: number; sendAt: number }) {
  await readIn(w, 'home', [COLLEAGUE]);
  assert.equal((await w.harness.core.taint.check(COLLEAGUE)).address, true, 'recorded from the other mailbox');
  const draftId = await draftTo(w, COLLEAGUE);
  const preparedAt = w.clock.at;

  const prepared = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
  assert.ok(prepared.riskFlags.includes('recipient-tainted'), 'the exact address still escalates (D4)');
  assert.equal(prepared.effectivePolicy, 'confirm');
  assert.match(prepared.preview, /SEND PREVIEW/);
  assert.ok(prepared.preview.includes(BODY));
  assert.deepEqual(
    [prepared.approval.state, prepared.approval.claimable, prepared.approval.route],
    ['pending', false, 'confirm'],
  );
  // What follows names the person's command and the wait, so nobody has to relay the approval.
  locatedGmailLine(prepared.nextStep, ['approve', prepared.approvalId]);
  assert.match(prepared.nextStep, /gmail_send_wait/);
  const send = { inbox: 'work', approvalId: prepared.approvalId };

  // The agent tries once before the person has decided: refused for a person outside the chat, and told how to learn.
  const early = refusal(await w.call('gmail_draft_send', send));
  assert.equal(early.code, 'APPROVAL_REQUIRED');
  assert.match(early.hint ?? '', /gmail_send_wait/);

  w.clock.at = preparedAt + times.approveAt;
  const shown = await approveAtTerminal(w, prepared.approvalId);
  assert.ok(shown.includes(BODY), 'the terminal shows the body it approves');

  w.clock.at = preparedAt + times.waitAt;
  const waited = body<{ state: string; claimable: boolean }>(
    await w.call('gmail_send_wait', { approvalId: prepared.approvalId, waitSeconds: 0 }),
  );
  assert.deepEqual([waited.state, waited.claimable], ['approved', true], 'the agent learns it by waiting');

  w.clock.at = preparedAt + times.sendAt;
  const sent = body<{ sentMessageId: string; approvalId: string; approval: Record<string, unknown> }>(
    await w.call('gmail_draft_send', send),
  );
  assert.equal(typeof sent.sentMessageId, 'string');
  assert.ok(sent.sentMessageId.length > 0);
  assert.equal(sent.approvalId, prepared.approvalId, 'the same record');
  assert.equal(sent.approval.state, 'used');
  assert.equal(sent.approval.sentMessageId, sent.sentMessageId);

  // One prepare, one record, one send: nothing was prepared again, and nothing asked again after the decision.
  assert.deepEqual(
    w.calls.filter((name) => name === 'gmail_send_prepare'),
    ['gmail_send_prepare'],
  );
  assert.deepEqual(
    (await approvalsOf(w)).map((record) => [record?.approvalId, record?.state]),
    [[prepared.approvalId, 'used']],
  );
  assert.equal(sendsOf(w), 1);
  return { prepared, sent };
}

// ── ACC-a ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('an internal colleague recorded in another mailbox, from an untrusted client: one prepare, one terminal rendering, one decision; the wait sees it approved and execute sends with that record (ACC-a)', async () => {
  const w = await world();
  try {
    await oneDecision(w, { approveAt: 2 * MIN, waitAt: 2 * MIN + 5000, sendAt: 2 * MIN + 10_000 });
  } finally {
    await w.close();
  }
});

// ── ACC-b ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('approved at minute 25, claimed two hours later: still the same approval, and it sends (ACC-b)', async () => {
  const w = await world();
  try {
    await oneDecision(w, { approveAt: 25 * MIN, waitAt: 26 * MIN, sendAt: 25 * MIN + 2 * HOUR });
  } finally {
    await w.close();
  }
});

// ── ACC-c ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('an internal recipient whose domain alone was seen does not taint, and a chat route sends on the yes inside ten minutes (ACC-c)', async () => {
  const w = await world();
  try {
    // Somebody else at example.test was read in `home`: the domain is in the store, the colleague's address is not.
    await readIn(w, 'home', ['bob@example.test']);
    const seen = await w.harness.core.taint.check('cara@example.test');
    assert.deepEqual([seen.address, seen.domain], [false, true], 'the store holds the domain, not the address');
    const draftId = await draftTo(w, 'cara@example.test');
    const preparedAt = w.clock.at;
    const prepared = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
    assert.deepEqual(prepared.riskFlags, [], 'own domain, domain only: no escalation');
    assert.equal(prepared.effectivePolicy, 'chat');
    assert.deepEqual(
      [prepared.approval.state, prepared.approval.claimable, prepared.approval.route],
      ['pending', true, 'chat'],
    );
    // The person reads the preview in the chat and says yes; nine minutes on, the agent sends.
    w.clock.at = preparedAt + 9 * MIN;
    const status = body<{ state: string; claimable: boolean }>(
      await w.call('gmail_send_wait', { approvalId: prepared.approvalId, waitSeconds: 0 }),
    );
    assert.deepEqual([status.state, status.claimable], ['pending', true]);
    const sent = body<{ sentMessageId: string }>(
      await w.call('gmail_draft_send', {
        inbox: 'work',
        approvalId: prepared.approvalId,
      }),
    );
    assert.ok(sent.sentMessageId);
    assert.equal(sendsOf(w), 1);
  } finally {
    await w.close();
  }
});

// ── ACC-d ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('the ticket replayed — prepared 22:42:46, approved 22:48:22: the wait learns it, the send succeeds after 22:52:46, and nothing asks again (ACC-d)', async () => {
  const prepareAt = Date.parse('2026-10-04T22:42:46.000Z');
  const w = await world(prepareAt);
  try {
    const at = (time: string) => Date.parse(`2026-10-04T${time}.000Z`) - prepareAt;
    const { prepared } = await oneDecision(w, {
      approveAt: at('22:48:22'),
      waitAt: at('22:48:30'),
      // Past the moment the ticket's approval expired unused — ten minutes after it was created.
      sendAt: at('22:53:10'),
    });
    // Between the decision and the send, no result asked for the approval already given.
    const record = asV2(await w.harness.core.approvals.get(prepared.approvalId));
    assert.equal(record?.approvedAt, '2026-10-04T22:48:22.000Z');
    assert.equal(record?.usableUntil, '2026-10-05T22:48:22.000Z');
    assert.equal(record?.state, 'used');
  } finally {
    await w.close();
  }
});

// ── ACC-e and ACC-f ────────────────────────────────────────────────────────────────────────────────────────────

test('approved and never claimed: a day later the report says “not sent with any approval in the last 90 days”, “still in Drafts” only from the live look-up; preparing it again is the full preview, unblocked (ACC-e, ACC-f)', async () => {
  const w = await world();
  try {
    await readIn(w, 'home', [COLLEAGUE]);
    const draftId = await draftTo(w, COLLEAGUE);
    const preparedAt = w.clock.at;
    const first = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
    w.clock.at = preparedAt + 3 * MIN;
    await approveAtTerminal(w, first.approvalId);
    // Nobody claims it. A day after its approval, and a minute.
    w.clock.at = preparedAt + 3 * MIN + 24 * HOUR + MIN;
    const status = body<{ state: string; claimable: boolean; reason?: string }>(
      await w.call('gmail_send_wait', { approvalId: first.approvalId, waitSeconds: 0 }),
    );
    assert.deepEqual([status.state, status.claimable], ['expired', false]);

    const lookups = () =>
      w.harness.google.requests.filter((request) => request.path === `/gmail/v1/users/me/drafts/${draftId}`).length;
    const before = lookups();
    const { unsent } = await listApprovals(w.context, { inbox: 'work' });
    assert.equal(unsent.evidence, 'complete-90-days', 'a complete, readable scan of the retained approvals');
    const row = unsent.rows.find((each) => each.draftId === draftId);
    assert.ok(row, JSON.stringify(unsent.rows));
    assert.deepEqual([row.status, row.said], ['unsent', UNSENT_WORDS.complete]);
    assert.doesNotMatch(row.said, /Drafts/, 'what the records prove says nothing of Drafts');
    assert.deepEqual(row.drafts, { state: 'found', said: 'still in Drafts' });
    assert.equal(lookups(), before + 1, '“still in Drafts” came from a look-up in Drafts');
    const shown = await cli(w.harness, ['send', 'list', '--inbox', 'work']);
    assert.match(shown.stdout, /not sent with any approval in the last 90 days; still in Drafts\./);

    // Without the look-up's answer, nothing says it is still there.
    const transport = await w.context.transport('work');
    const read = transport.getDraft.bind(transport);
    transport.getDraft = async (id) => {
      if (id === draftId) throw new CommsError('TRANSIENT', 'Google returned 503 while reading a draft');
      return read(id);
    };
    const failed = (await listApprovals(w.context, { inbox: 'work' })).unsent.rows.find(
      (each) => each.draftId === draftId,
    );
    assert.equal(failed?.said, UNSENT_WORDS.complete);
    assert.equal(failed?.drafts.state, 'failed');
    assert.doesNotMatch(JSON.stringify(failed), /still in Drafts/);
    transport.getDraft = read;

    // ACC-f: the same content again is the full ordinary preview, not blocked by the expired record.
    const again = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
    assert.notEqual(again.approvalId, first.approvalId);
    assert.equal(again.preview.replaceAll(again.approvalId, first.approvalId), first.preview, 'the full preview');
    assert.equal(again.approval.state, 'pending');
    assert.equal(sendsOf(w), 0);
  } finally {
    await w.close();
  }
});

test('a prior send whose outcome is unknown does not block preparing the identical content again: the full preview, and a new approval (ACC-f)', async () => {
  const w = await world();
  try {
    const draftId = await draftTo(w, 'cara@example.test');
    const first = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
    // Gmail answers the send with a 500 before acting on it: this call cannot know whether it was sent.
    w.harness.google.failNext(DRAFT_SEND_PATH, 1, 500);
    const unknown = refusal(await w.call('gmail_draft_send', { inbox: 'work', approvalId: first.approvalId }));
    assert.equal(unknown.code, 'SEND_OUTCOME_UNKNOWN');
    // The lease runs out: the record is final as unknown.
    w.clock.at += SENDING_LEASE_MS + 1000;
    const status = body<{ state: string; claimable: boolean }>(
      await w.call('gmail_send_wait', { approvalId: first.approvalId, waitSeconds: 0 }),
    );
    assert.deepEqual([status.state, status.claimable], ['unknown', false]);

    // The person checked Sent, found nothing, and asks for it again.
    const again = body<Preparation>(await w.call('gmail_send_prepare', { inbox: 'work', draftId }));
    assert.notEqual(again.approvalId, first.approvalId);
    assert.equal(again.preview.replaceAll(again.approvalId, first.approvalId), first.preview, 'the full preview');
    assert.deepEqual([again.approval.state, again.approval.claimable], ['pending', true]);
    assert.equal(asV2(await w.harness.core.approvals.get(first.approvalId))?.state, 'unknown', 'left as it was');
  } finally {
    await w.close();
  }
});
