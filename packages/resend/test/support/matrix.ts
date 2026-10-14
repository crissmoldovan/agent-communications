import * as lib from '@agentcomms/core';
import { ApprovalStore, type ChangeBinding } from '@agentcomms/core';
import {
  drive,
  emitter,
  type MatrixClock,
  type MatrixSurface,
  matrixClock,
  NOBODY,
  type Observation,
  observeError,
  observeTool,
  routeOf,
  WRONG_CODE,
  wrongCodesOf,
} from '../../../../test/helpers/approval-matrix.mjs';
import type { ResendContext } from '../../src/context.ts';
import { beginSendApproval, finishSendApproval, prepareSend } from '../../src/operations/send.ts';
import { type Harness, newHarness } from './harness.ts';

/*
 * Resend's sends in the D2 matrix (CUE-404 Task 24): `test/approval-matrix.test.mjs` runs this as its own program and
 * holds what each must say. Each row starts from a send this package prepared itself (`prepareSend`) on a fresh home
 * and a loopback Resend, with the approval store on a clock of its own; `test/helpers/approval-matrix.mjs` puts it
 * into the row's state.
 *
 * The surfaces: `resend_send_execute`, the terminal approval (`approve`: its begin, then its finish),
 * `resend_send_status`, `resend_send_wait` — and a server pinned to the account, given another's id.
 */

interface World {
  harness: Harness;
  core: lib.Core;
  context: ResendContext;
  clock: MatrixClock;
  approvalId: string;
  notFound(action: string, surface?: { name: string }): Promise<ReadonlyArray<readonly [string, string]>>;
  fault(): void;
  asked(): number;
}

const ACCOUNT = 'acme/resend';
const OTHER = 'zeta/resend';
const MESSAGE = {
  from: 'Acme <hello@acme.test>',
  to: ['sam@partner.test'],
  subject: 'Phase 2 plan',
  text: 'Hi Sam, the plan is attached to the thread.',
};
const emit = emitter('send', 'resend');

async function world(row: string): Promise<World> {
  const harness = await newHarness();
  await harness.addAccount({ name: ACCOUNT, mode: 'send', sendPolicy: routeOf(row) });
  await harness.addAccount({ name: OTHER, mode: 'send', sendPolicy: 'chat' });
  const clock = matrixClock();
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now: clock.now,
    handoffs: harness.core.handoffs,
    loadConfig: () => harness.core.config.load(),
    audit: harness.core.audit,
  });
  const context = harness.context('mcp');
  const prepared = await prepareSend(context, ACCOUNT, MESSAGE);

  const foreign = async () => (await prepareSend(context, OTHER, MESSAGE)).approvalId;
  const change = async () => {
    const binding: ChangeBinding = {
      summary: 'Let the default send policy be chat',
      target: null,
      loosened: [{ path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' }],
      settings: [],
      effects: [],
    };
    return (await harness.core.approvals.createChange({ channel: 'resend', change: binding, policy: 'chat' }))
      .approvalId;
  };
  /** Another channel's send, as Gmail's prepare writes one for a mailbox on this machine: not Resend's. */
  const otherChannel = async () => {
    const inboxId = lib.newInboxId();
    await harness.core.config.update((config) => ({
      ...config,
      inboxes: {
        ...config.inboxes,
        'acme/gmail': {
          id: inboxId,
          provider: 'gmail',
          email: 'jo@acme.test',
          identity: 'oidc',
          client: 'desktop',
          tier: 'send',
          grantedScopes: [],
          contacts: false,
          secretRef: `gmail:refresh:${inboxId}`,
          internalDomains: ['acme.test'],
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      },
    }));
    return (
      await harness.core.approvals.create({
        channel: 'gmail',
        inboxId,
        inboxSub: 'sub-9',
        draftId: 'r-other',
        draftMessageId: 'm-other',
        contentDigest: 'b'.repeat(64),
        sendEpoch: 0,
        policy: 'chat',
        requiredPolicy: 'chat',
        riskFlags: [],
        expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Other' },
      })
    ).approvalId;
  };

  return {
    harness,
    core: harness.core,
    context,
    clock,
    approvalId: prepared.approvalId,
    notFound: async (action, surface) => {
      if (action === 'claim' || surface?.name === 'resend_send_status') {
        // Both name the account: another account's send is not theirs to find, nor another kind's approval.
        return [
          ['nobody', NOBODY],
          ['another account', await foreign()],
          ['another kind', await change()],
        ];
      }
      if (action === 'approve') {
        return [
          ['nobody', NOBODY],
          ['another channel', await otherChannel()],
          ['another kind', await change()],
        ];
      }
      // The wait answers for any approval on this machine (D2: unpinned surfaces show every record).
      return [['nobody', NOBODY]];
    },
    fault: () => {
      harness.fake.afterSend = () => ({ status: 500, body: { name: 'internal_server_error', message: 'answer lost' } });
    },
    asked: () => harness.fake.requests.length,
  };
}

const sendsOf = (w: World) => w.harness.fake.sends().length;

async function tool(w: World, name: string, args: Record<string, unknown>, options: { pinned?: string } = {}) {
  const client = await w.harness.mcp(options.pinned ? { account: options.pinned } : {});
  try {
    return await client.call(name, args);
  } finally {
    await client.close();
  }
}

async function execute(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  const before = sendsOf(w);
  const result = await tool(
    w,
    'resend_send_execute',
    { ...(pinned ? {} : { account: ACCOUNT }), approvalId },
    pinned ? { pinned } : {},
  );
  return observeTool(result, sendsOf(w) - before);
}

async function status(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  const result = await tool(
    w,
    'resend_send_status',
    { ...(pinned ? {} : { account: ACCOUNT }), approvalId },
    pinned ? { pinned } : {},
  );
  return observeTool(result, 0, { look: true });
}

async function wait(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  return observeTool(await tool(w, 'resend_send_wait', { approvalId, waitSeconds: 0 }, pinned ? { pinned } : {}), 0, {
    look: true,
  });
}

/** The terminal approval: its begin, then its finish with the code it showed — or a wrong one, as the row says. */
async function approve(w: World, approvalId: string, row: string): Promise<Observation> {
  const before = sendsOf(w);
  let challenge: string;
  try {
    challenge = (await beginSendApproval(w.context, approvalId)).challenge;
  } catch (error) {
    return { ...observeError(error, sendsOf(w) - before), extra: { step: 'begin' } };
  }
  const wrong = wrongCodesOf(row);
  if (wrong === 0) {
    try {
      await finishSendApproval(w.context, approvalId, challenge);
      const record = lib.asV2(await w.core.approvals.get(approvalId));
      return {
        ok: true,
        approval: record ? { ...(await w.core.approvals.approvalOf(record)) } : null,
        sends: sendsOf(w) - before,
      };
    } catch (error) {
      return { ...observeError(error, sendsOf(w) - before), extra: { step: 'finish' } };
    }
  }
  let last: Observation = { ok: true, sends: 0 };
  for (let attempt = 1; attempt <= wrong; attempt += 1) {
    try {
      await finishSendApproval(w.context, approvalId, WRONG_CODE);
    } catch (error) {
      last = { ...observeError(error, sendsOf(w) - before), extra: { step: 'finish', attempt } };
    }
  }
  const stored = lib.asV2(await w.core.approvals.get(approvalId));
  return { ...last, extra: { ...last.extra, stored: stored?.state } };
}

const SURFACES: ReadonlyArray<MatrixSurface<World>> = [
  { name: 'resend_send_status', action: 'look', act: (w, id) => status(w, id) },
  { name: 'resend_send_wait', action: 'look', act: (w, id) => wait(w, id) },
  { name: 'resend_send_execute', action: 'claim', act: (w, id) => execute(w, id) },
  { name: 'approve (terminal)', action: 'approve', act: (w, id, row) => approve(w, id, row) },
];

await drive('send', { world, surfaces: SURFACES, emit, lib });

// A server pinned to the account, given another's id.
{
  const w = await world('not-found');
  const theirs = (await w.notFound('claim'))[1]?.[1] as string;
  for (const [name, action, act] of [
    ['resend_send_execute (pinned)', 'claim', () => execute(w, theirs, ACCOUNT)],
    ['resend_send_status (pinned)', 'look', () => status(w, theirs, ACCOUNT)],
    ['resend_send_wait (pinned)', 'look', () => wait(w, theirs, ACCOUNT)],
  ] as const) {
    const seen = await act();
    emit(
      'not-found',
      { name, action, act: async () => seen },
      { ...seen, extra: { variant: 'pinned away', id: theirs } },
    );
  }
}

// Every fake Resend this run started is still listening; the observations are written, so the run is over.
process.exit(0);
