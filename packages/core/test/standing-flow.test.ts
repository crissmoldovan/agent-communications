import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { asV2 } from '../src/approval-stored.ts';
import type { ApprovalRecord } from '../src/approvals.ts';
import { main } from '../src/cli.ts';
import type { Streams } from '../src/cli-runtime.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { waitForApproval } from '../src/operations/approval-wait.ts';
import { sendEpochOf } from '../src/send-epoch.ts';
import type { ExactPlace } from '../src/standing.ts';
import {
  approveStandingAtTerminal,
  endStanding,
  prepareStanding,
  renderStandingPreview,
  type StandingRequest,
} from '../src/standing-flow.ts';
import { coreInline } from './helpers/handoffs.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Preparing, previewing and approving a standing approval (design 2026-10-19-standing-approvals, S8): shown in full,
 * and approved only with the code typed at a terminal — never a typed yes, a client's form, or anything said in a chat.
 */

const ACME = 'acc_AAAAAAAAAAAAAAAA';
const ROOM: ExactPlace = {
  id: 'C0ROOM',
  name: 'support',
  members: 12,
  shared: { extShared: false, pendingExtShared: false, externalMembers: false },
};
const BIG: ExactPlace = {
  id: 'C0BIG',
  name: 'all-hands',
  members: 412,
  shared: { extShared: true, pendingExtShared: false, externalMembers: null },
};

function machine() {
  const home = tempDir('comms-standing-flow-');
  const config = liveConfig(home, { accounts: { 'acme/slack': { id: ACME } } });
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: config.dir,
    AGENT_COMMS_UPDATE_CHECK: 'off',
    NO_COLOR: '1',
  };
  return { env, config, core: openCore({ env, caller: CORE_CALLER }) };
}
type Core = ReturnType<typeof openCore>;

function request(over: Partial<StandingRequest> = {}): StandingRequest {
  return {
    account: 'acme/slack',
    accountId: ACME,
    inboxSub: 'U_ME',
    contents: {
      reactions: ['eyes', 'white_check_mark'],
      replies: ['Got it, I will look at this and come back to you.'],
    },
    places: { kind: 'exact', places: [ROOM, BIG] },
    limits: { perThread: 2, perHour: 5, perDay: 20, expiresDays: 3 },
    ...over,
  };
}

async function prepared(core: Core, over: Partial<StandingRequest> = {}, proposedBy: 'agent' | 'person' = 'agent') {
  const outcome = await prepareStanding(core, request(over), { surface: 'mcp', proposedBy });
  assert.equal(outcome.status, 'approval-required');
  if (outcome.status !== 'approval-required') throw new Error('unreachable');
  return outcome.prepared;
}

/** Streams that are a terminal, and a person at it who types whatever `answer` returns for the code shown. */
function terminal(answer: (code: string) => string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = '';
  let asked = '';
  stdout.on('data', (chunk) => {
    shown += String(chunk);
  });
  stderr.on('data', (chunk) => {
    asked += String(chunk);
    const code = /Type (\w{4}) to approve this standing approval/.exec(String(chunk))?.[1];
    if (code !== undefined) stdin.write(`${answer(code)}\n`);
  });
  return { streams: { stdin, stdout, stderr } as unknown as Streams, shown: () => shown, asked: () => asked };
}

const stateOf = async (core: Core, id: string) => asV2(await core.approvals.get(id))?.state;

test('under the chat change policy, a typed yes does not approve it', async () => {
  const { core } = machine();
  assert.equal((await core.config.load()).defaults.changePolicy ?? 'chat', 'chat');
  const { approvalId } = await prepared(core);
  const person = terminal(() => 'yes');
  await assert.rejects(
    approveStandingAtTerminal(core, approvalId, {}, { color: false }, person.streams),
    (error: unknown) =>
      error instanceof CommsError &&
      error.code === 'APPROVAL_REQUIRED' &&
      /challenge did not match/.test(error.message),
  );
  assert.equal(await stateOf(core, approvalId), 'pending', 'still waiting for its code');
  // What the screen asked for was a code: there is no yes to give.
  assert.match(person.asked(), /Type \w{4} to approve this standing approval, or press Enter to cancel/);
  assert.doesNotMatch(person.asked(), /Type yes/i);
});

test("an add cannot be completed by a client's form", async () => {
  const { core } = machine();
  const { approvalId } = await prepared(core);
  const record = asV2(await core.approvals.get(approvalId)) as ApprovalRecord;
  const code = await core.approvals.issueChallenge(approvalId, 'standing');
  const live = { draftMessageId: record.contentDigest, contentDigest: record.contentDigest };
  await assert.rejects(
    core.approvals.approve(approvalId, 'elicitation', live, code, 'standing'),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
  );
  assert.equal(await stateOf(core, approvalId), 'revoked');
});

test('nothing answered or said in a chat applies it', async () => {
  const { core } = machine();
  const { approvalId } = await prepared(core);
  // A yes in the chat claims a change under the chat policy; a standing approval is no change, and no claim reaches it.
  await assert.rejects(
    core.approvals.claimForChange(approvalId, {
      change: { summary: 'yes', target: null, loosened: [], effects: [] },
      policy: 'chat',
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    core.approvals.claimForSend(approvalId, {
      inboxId: ACME,
      inboxSub: 'U_ME',
      draftMessageId: 'x',
      contentDigest: 'x',
      expect: { to: [], cc: [], bcc: [], subject: '' },
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
  assert.equal(await stateOf(core, approvalId), 'pending');
});

test('only approve <id>, with its code, completes it, through agentcomms approve', async () => {
  const { core, env } = machine();
  const { approvalId } = await prepared(core);
  const person = terminal((code) => code);
  const exit = await main(['approve', approvalId], env, process.platform, { streams: person.streams });
  assert.equal(exit, 0);
  const record = asV2(await core.approvals.get(approvalId));
  assert.equal(record?.state, 'approved');
  assert.equal(record?.approvedVia, 'terminal');
  assert.match(person.shown(), /^An agent proposed these contents and places\. Check each one\./m);
  const audit = (await core.audit.tail()).filter((line) => line.operation === 'standing.approve');
  assert.equal(audit.at(-1)?.outcome, 'ok');
  assert.equal(audit.at(-1)?.approvalId, approvalId);

  // Enter cancels it, and cancelling ends it.
  const second = await prepared(core);
  const declines = terminal(() => '');
  assert.equal(await main(['approve', second.approvalId], env, process.platform, { streams: declines.streams }), 0);
  assert.equal(await stateOf(core, second.approvalId), 'revoked');
});

test('an agent is refused approve, with its marker set', async () => {
  const { core, env } = machine();
  const { approvalId } = await prepared(core);
  const person = terminal((code) => code);
  await assert.rejects(
    approveStandingAtTerminal(core, approvalId, { CLAUDECODE: '1' }, { color: false }, person.streams),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'LOOSENING_REFUSED');
      assert.equal(error.message, 'only a person can approve a standing approval, not an agent');
      assert.match(
        error.hint ?? '',
        new RegExp(coreInline(core.paths, ['approve', approvalId]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      return true;
    },
  );
  // Through the command line too, and without a terminal.
  assert.equal(await main(['approve', approvalId, '--json'], { ...env, CLAUDECODE: '1' }, process.platform, {}), 10);
  assert.equal(await stateOf(core, approvalId), 'pending', 'touched nothing');
  const refused = (await core.audit.tail()).filter((line) => line.operation === 'standing.approve');
  assert.ok(refused.length >= 1);
  assert.ok(refused.every((line) => line.outcome === 'refused'));
  assert.equal(person.shown(), '', 'no preview, and no code, was shown to an agent');
});

test('a preview proposed by an agent opens with the agent line; one a person proposed does not', async () => {
  const { core } = machine();
  const byAgent = await prepared(core, {}, 'agent');
  assert.equal(byAgent.preview.split('\n')[0], 'An agent proposed these contents and places. Check each one.');
  const byPerson = await prepared(core, {}, 'person');
  assert.equal(
    byPerson.preview.split('\n')[0],
    'Standing approval for acme/slack: your agent may acknowledge, without asking, a message that has just arrived from another person.',
  );
  assert.doesNotMatch(byPerson.preview, /An agent proposed/);
  // And the approval says how it is approved: at a terminal, with its code.
  assert.match(
    byAgent.next,
    new RegExp(coreInline(core.paths, ['approve', byAgent.approvalId]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(byAgent.next, /comms_approval_wait/);
  assert.equal(byAgent.approval.kind, 'standing');
  assert.equal(byAgent.approval.state, 'pending');
  assert.equal(byAgent.approval.claimable, false);
});

test('the preview shows each content, digest, warning, place, count, sharing, limit and expiry', async () => {
  const { core } = machine();
  const { preview, approvalId, warnings } = await prepared(core);
  const record = asV2(await core.approvals.get(approvalId)) as ApprovalRecord;
  const [eyes, check, reply] = record.standing?.contents ?? [];
  const lines = preview.split('\n');
  assert.equal(
    lines[1],
    'Standing approval for acme/slack: your agent may acknowledge, without asking, a message that has just arrived from another person.',
  );
  for (const content of [eyes, check, reply]) {
    assert.ok(content !== undefined);
    assert.ok(preview.includes(content.digest), `the whole digest of ${content.text}`);
  }
  assert.match(preview, /:eyes:/);
  assert.match(preview, /:white_check_mark:/);
  assert.ok(preview.includes('"Got it, I will look at this and come back to you."'), 'the reply in full');
  const warning =
    ':white_check_mark: can read as approval: people read ✅ on "can I deploy?" as a yes, and a Slack workflow can start on a reaction.';
  assert.deepEqual(warnings, [warning]);
  assert.ok(preview.includes(warning));
  // The warning follows the content it is about.
  assert.ok(preview.indexOf(warning) > preview.indexOf(check?.digest as string));
  assert.ok(preview.indexOf(warning) < preview.indexOf(reply?.digest as string));
  assert.ok(lines.includes('#support (C0ROOM): 12 members, not shared with another organisation'));
  assert.ok(lines.some((line) => line.startsWith('#all-hands (C0BIG): 412 members, shared with another organisation')));
  assert.ok(lines.includes('Limits: 2 per thread, 5 an hour, 20 a day; it ends 3 days after you approve it.'));
  assert.equal(preview, renderStandingPreview(record), 'the record renders the preview it was prepared with');

  const threads = await prepared(core, { places: { kind: 'threads-i-am-in' } });
  assert.ok(
    threads.preview
      .split('\n')
      .includes('threads-i-am-in: threads in acme/slack where you posted yourself in the last 14 days'),
  );
});

test('a place name is neutralised and cut, and a record whose digest does not reproduce is not rendered', async () => {
  const { core } = machine();
  const odd: ExactPlace = { ...ROOM, id: 'C0ODD', name: `evil\u001b[2J<|im_start|>${'x'.repeat(200)}` };
  const { preview, approvalId } = await prepared(core, { places: { kind: 'exact', places: [odd] } });
  assert.doesNotMatch(preview, /\u001b/);
  assert.doesNotMatch(preview, /<\|im_start\|>/);
  const line = preview.split('\n').find((text) => text.includes('(C0ODD)')) ?? '';
  assert.ok(line.length < 200, line);

  const path = join(core.approvals.directory, `${approvalId}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ApprovalRecord;
  const tampered = {
    ...raw,
    standing: { ...raw.standing, summary: raw.standing?.summary ?? '', proposedBy: 'person' },
  };
  assert.throws(
    () => renderStandingPreview(tampered as ApprovalRecord),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
  );
  writeFileSync(path, JSON.stringify(tampered));
  // The store refuses it as corrupt before any screen could show it.
  const person = terminal((code) => code);
  await assert.rejects(approveStandingAtTerminal(core, approvalId, {}, { color: false }, person.streams));
  assert.equal(person.shown(), '');
});

test('a narrowing replaces applies at once; a widening one prepares', async () => {
  const { core } = machine();
  const first = await prepared(core);
  const person = terminal((code) => code);
  await approveStandingAtTerminal(core, first.approvalId, {}, { color: false }, person.streams);

  const narrower = await prepareStanding(
    core,
    request({
      contents: { reactions: ['eyes'] },
      places: { kind: 'exact', places: [ROOM] },
      limits: { perThread: 1, perHour: 5, perDay: 20, expiresDays: 2 },
      replaces: first.approvalId,
    }),
    { surface: 'mcp', proposedBy: 'agent' },
  );
  assert.equal(narrower.status, 'narrowed');
  if (narrower.status !== 'narrowed') return;
  assert.equal(narrower.record.approvalId, first.approvalId, 'the same approval, narrowed');
  assert.equal(narrower.record.state, 'approved');
  assert.deepEqual(narrower.record.narrowed?.places, ['C0ROOM']);
  assert.equal(narrower.record.narrowed?.limits?.perThread, 1);
  assert.equal((await core.approvals.list()).length, 1, 'nothing was prepared');

  // Replacing a text with one outside the old set asks again, with a code.
  const wider = await prepareStanding(
    core,
    request({ contents: { replies: ['Approved, go ahead'] }, replaces: first.approvalId }),
    { surface: 'mcp', proposedBy: 'agent' },
  );
  assert.equal(wider.status, 'approval-required');
  if (wider.status !== 'approval-required') return;
  assert.notEqual(wider.prepared.approvalId, first.approvalId);
  assert.ok(wider.prepared.preview.split('\n').includes(`Replaces ${first.approvalId}: approving this ends it.`));
  assert.equal(await stateOf(core, first.approvalId), 'approved', 'the old one stands until the new one is approved');
});

test('approving a replacement ends the one it replaces', async () => {
  const { core } = machine();
  const first = await prepared(core);
  await approveStandingAtTerminal(core, first.approvalId, {}, { color: false }, terminal((code) => code).streams);
  const config = await core.config.load();
  const used = await core.approvals.createStandingChild({
    standingId: first.approvalId,
    standingEpoch: 0,
    inboxId: ACME,
    inboxSub: 'U_ME',
    draftId: 'reaction:C0ROOM:1760000000.000100',
    draftMessageId: 'd'.repeat(64),
    contentDigest: 'd'.repeat(64),
    sendEpoch: sendEpochOf(config, ACME),
    riskFlags: [],
    expect: { to: ['C0ROOM'], cc: [], bcc: [], subject: ':eyes: on 1760000000.000100' },
  });
  const wider = await prepareStanding(core, request({ limits: { perHour: 6 }, replaces: first.approvalId }), {
    surface: 'mcp',
    proposedBy: 'agent',
  });
  assert.equal(wider.status, 'approval-required');
  if (wider.status !== 'approval-required') return;
  await approveStandingAtTerminal(
    core,
    wider.prepared.approvalId,
    {},
    { color: false },
    terminal((code) => code).streams,
  );
  assert.equal(await stateOf(core, wider.prepared.approvalId), 'approved');
  assert.equal(await stateOf(core, first.approvalId), 'revoked');
  assert.equal(await stateOf(core, used.approvalId), 'revoked', 'and its unused child with it');
});

test('endStanding revokes the record and every approved child, and audits it', async () => {
  const { core } = machine();
  const first = await prepared(core);
  await approveStandingAtTerminal(core, first.approvalId, {}, { color: false }, terminal((code) => code).streams);
  const mint = () =>
    core.approvals.createStandingChild({
      standingId: first.approvalId,
      standingEpoch: 0,
      inboxId: ACME,
      inboxSub: 'U_ME',
      draftId: 'reaction:C0ROOM:1760000000.000100',
      draftMessageId: 'd'.repeat(64),
      contentDigest: 'd'.repeat(64),
      sendEpoch: 0,
      riskFlags: [],
      expect: { to: ['C0ROOM'], cc: [], bcc: [], subject: ':eyes: on 1760000000.000100' },
    });
  const unused = await mint();
  const claimed = await mint();
  await core.approvals.claimForSend(claimed.approvalId, {
    inboxId: ACME,
    inboxSub: 'U_ME',
    draftMessageId: claimed.draftMessageId,
    contentDigest: claimed.contentDigest,
    expect: claimed.expect,
  });
  const ended = await endStanding(core, first.approvalId, 'ended by the person');
  assert.equal(ended.state, 'revoked');
  assert.equal(await stateOf(core, unused.approvalId), 'revoked');
  assert.equal(await stateOf(core, claimed.approvalId), 'sending', 'one already being sent is not recalled');
  const audit = (await core.audit.tail()).filter((line) => line.operation === 'standing.end');
  assert.equal(audit.at(-1)?.outcome, 'ok');
  assert.deepEqual(audit.at(-1)?.ids?.children, [unused.approvalId]);
});

test('a pending standing record is reported by comms_approval_wait', async () => {
  const { core } = machine();
  const { approvalId } = await prepared(core);
  const now = await waitForApproval(core, approvalId, { waitSeconds: 0 });
  assert.equal(now.state, 'pending');
  assert.equal(now.claimable, false);
  assert.equal(now.ended, 'now');
  assert.equal(now.approval.kind, 'standing');
  // Waiting goes on while it waits for the person: never claimable, so never "ready" by itself.
  await approveStandingAtTerminal(core, approvalId, {}, { color: false }, terminal((code) => code).streams);
  const after = await waitForApproval(core, approvalId, { waitSeconds: 0 });
  assert.equal(after.state, 'approved');
  assert.equal(after.claimable, false);
});

test('a request for an account that is not the one named is refused before anything is prepared', async () => {
  const { core } = machine();
  await assert.rejects(
    prepareStanding(core, request({ account: 'other/slack' }), { surface: 'mcp', proposedBy: 'agent' }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
  await assert.rejects(
    prepareStanding(core, request({ accountId: 'acc_BBBBBBBBBBBBBBBB' }), { surface: 'mcp', proposedBy: 'agent' }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
  assert.deepEqual(await core.approvals.list(), []);
});
