import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore } from '@agentcomms/core';
import type { SlackCall } from '../src/api/call.ts';
import { closedPermit } from '../src/api/guard.ts';
import { compose } from '../src/compose/blocks.ts';
import { openDraftStore } from '../src/compose/drafts.ts';
import { NameBook } from '../src/operations/people.ts';
import { postPrepared, preparePost, react } from '../src/operations/send.ts';

/**
 * The gate.
 *
 * This is the file where a bug posts to somebody's workspace, so the tests are about refusals rather than about
 * the happy path. Every one of them describes a way an agent could get a message in front of people that nobody
 * agreed to — and each corresponds to a guard that was broken on purpose to check the test fails.
 */

const NOW = () => new Date('2026-09-23T12:00:00.000Z');

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'slack-send-'));
}

/** A Slack that records what it was asked, and never posts anything real. */
function fakeSlack(script: Record<string, unknown> = {}) {
  const sent: { method: string; params: URLSearchParams }[] = [];
  const call: SlackCall = {
    token: 't',
    fetch: async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = url.split('/api/')[1] ?? '';
      sent.push({ method, params: new URLSearchParams(String(init?.body ?? '')) });
      return new Response(JSON.stringify(script[method] ?? { ok: true, ts: '1700000000.000100' }));
    },
  };
  return { call, sent };
}

async function setUp(options: { text?: string; members?: number; policy?: 'chat' | 'confirm' | 'never' } = {}) {
  const state = temp();
  const drafts = openDraftStore(state, NOW);
  const approvals = new ApprovalStore(state, { now: NOW });
  const draft = await drafts.create(
    'acc_1',
    compose({ channel: 'C1', text: options.text ?? 'shipping in ten minutes' }),
    options.text ?? 'shipping in ten minutes',
  );
  const { call, sent } = fakeSlack({
    'conversations.info': {
      ok: true,
      channel: { id: 'C1', name: 'engineering', num_members: options.members ?? 8 },
    },
  });
  const deps = {
    call,
    accountId: 'acc_1',
    workspaceId: 'T0001',
    workspaceName: 'acme/slack',
    postingAs: 'U0',
    policy: options.policy ?? ('chat' as const),
    approvals,
    permit: closedPermit(),
  };
  return { drafts, approvals, draft, deps, sent, book: new NameBook() };
}

// ── Preparing ──────────────────────────────────────────────────────────────────────────────────────────────────

test('preparing posts nothing, and shows what would be posted', async () => {
  const { deps, draft, book, sent } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  assert.match(prepared.approvalId, /^ap_/);
  assert.equal(prepared.preview.channel, '#engineering');
  assert.match(prepared.preview.body, /shipping in ten minutes/);
  assert.deepEqual(
    sent.map((call) => call.method),
    ['conversations.info'],
    'the only call made is the read that counts the room',
  );
  assert.equal(deps.permit.approvalId, null, 'and the permit was never opened');
});

test('a broadcast raises the ceremony by itself, whatever the workspace policy says', async () => {
  const { deps, draft, book } = await setUp({ text: 'deploy now' });
  const quiet = await preparePost(deps, draft, book);
  assert.equal(quiet.requiredPolicy, 'chat', 'an ordinary message to eight people is an ordinary message');

  const loud = await setUp({ text: 'deploy now', members: 412 });
  const broadcast = await loud.drafts.update(
    loud.draft.draftId,
    compose({ channel: 'C1', text: 'deploy now', mentions: [{ kind: 'broadcast', who: 'channel' }] }),
    'deploy now',
  );
  const prepared = await preparePost(loud.deps, broadcast, loud.book);
  assert.equal(prepared.requiredPolicy, 'confirm', '@channel to a room is not agreed to in a chat window');
  assert.ok(prepared.riskFlags.includes('notifies-channel'));
  assert.ok(prepared.riskFlags.includes('large-audience'));
  assert.equal(prepared.preview.notifies.estimated, 412, 'and the number is on the page');
});

test('a room whose size cannot be read says so rather than reporting a small one', async () => {
  const state = temp();
  const drafts = openDraftStore(state, NOW);
  const draft = await drafts.create(
    'acc_1',
    compose({ channel: 'C1', text: 'hi', mentions: [{ kind: 'broadcast', who: 'channel' }] }),
    'hi',
  );
  const { call } = fakeSlack({ 'conversations.info': { ok: false, error: 'channel_not_found' } });
  const prepared = await preparePost(
    {
      call,
      accountId: 'acc_1',
      workspaceId: 'T0001',
      workspaceName: 'acme/slack',
      postingAs: 'U0',
      policy: 'chat',
      approvals: new ApprovalStore(state, { now: NOW }),
    },
    draft,
    new NameBook(),
  );
  assert.match(prepared.preview.notifies.unknown ?? '', /.+/, 'the gap is stated');
  assert.equal(prepared.preview.notifies.estimated, 0, 'and not dressed up as a measured zero');
});

test('a workspace on `never` cannot prepare at all, and is told how to send it by hand', async () => {
  const { deps, draft, book } = await setUp({ policy: 'never' });
  await assert.rejects(preparePost(deps, draft, book), (error: unknown) => {
    const thrown = error as { code?: string; hint?: string };
    return thrown.code === 'POLICY_NEVER' && /paste/i.test(thrown.hint ?? '');
  });
});

// ── Posting ────────────────────────────────────────────────────────────────────────────────────────────────────

test('a prepared post goes once, through a permit that is open for exactly that request', async () => {
  const { deps, draft, book, sent } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  const posted = await postPrepared(deps, draft, prepared.approvalId, prepared.expect, book);
  assert.equal(posted.ts, '1700000000.000100');
  assert.ok(sent.some((call) => call.method === 'chat.postMessage'));
  assert.equal(deps.permit.approvalId, null, 'closed again afterwards');

  // The same approval cannot be spent twice: the claim marker is single-use across processes.
  await assert.rejects(postPrepared(deps, draft, prepared.approvalId, prepared.expect, book), /nothing was sent/);
});

test('an edit between the preview and the post voids the approval', async () => {
  const { deps, drafts, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  const edited = await drafts.update(
    draft.draftId,
    compose({ channel: 'C1', text: 'something else' }),
    'something else',
  );
  await assert.rejects(
    postPrepared(deps, edited, prepared.approvalId, prepared.expect, book),
    /nothing was sent/,
    'the bytes approved are the bytes posted, or nothing is',
  );
});

test('a payload change the visible text does not show still voids the approval', async () => {
  /*
   * Why the digest covers the exact bytes and not only what a reader sees.
   *
   * The revision check catches every edit made *through the store*, so this deliberately does not go through it:
   * the file is rewritten with the same revision, which is what a hand-edit or a bug in a later composer looks
   * like. What is left to catch it is the payload hash. The person approved a rendering; the bytes are what posts.
   */
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);

  const tampered = {
    ...draft,
    payload: {
      ...draft.payload,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'something else entirely' } }],
    },
  };
  assert.equal(tampered.payload.text, draft.payload.text, 'the visible text is untouched');
  assert.equal(tampered.revision, draft.revision, 'and so is the revision, so only the bytes differ');
  await assert.rejects(postPrepared(deps, tampered, prepared.approvalId, prepared.expect, book), /nothing was sent/);
});

test('a room that grew between the preview and the post voids the approval', async () => {
  /*
   * The reach is inside the digest, and this is why. The words did not change; who reads them did. A person who
   * agreed to interrupt eight people did not agree to interrupt four hundred.
   */
  const state = temp();
  const drafts = openDraftStore(state, NOW);
  const approvals = new ApprovalStore(state, { now: NOW });
  const draft = await drafts.create(
    'acc_1',
    compose({ channel: 'C1', text: 'heads up', mentions: [{ kind: 'broadcast', who: 'here' }] }),
    'heads up',
  );
  let members = 8;
  const call: SlackCall = {
    token: 't',
    fetch: async (input, init) => {
      const method = String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '';
      if (method === 'conversations.info') {
        return new Response(JSON.stringify({ ok: true, channel: { id: 'C1', name: 'eng', num_members: members } }));
      }
      void init;
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
    },
  };
  const deps = {
    call,
    accountId: 'acc_1',
    workspaceId: 'T0001',
    workspaceName: 'acme/slack',
    postingAs: 'U0',
    policy: 'chat' as const,
    approvals,
    permit: closedPermit(),
  };
  const prepared = await preparePost(deps, draft, new NameBook());
  members = 412;
  await assert.rejects(
    postPrepared(deps, draft, prepared.approvalId, prepared.expect, new NameBook()),
    /nothing was sent/,
  );
});

test('an approval prepared for one account cannot be spent by another', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  await assert.rejects(
    postPrepared({ ...deps, postingAs: 'U9' }, draft, prepared.approvalId, prepared.expect, book),
    /nothing was sent/,
    'two accounts in one workspace are two different people saying the same words',
  );
});

test('a caller that restates the wrong destination cannot post', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  await assert.rejects(
    postPrepared(deps, draft, prepared.approvalId, { ...prepared.expect, to: ['C_OTHER'] }, book),
    /nothing was sent/,
  );
});

test('a failed post is recorded rather than left in flight', async () => {
  const { deps, draft, book, approvals } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  const failing = { ...deps, call: fakeSlack({ 'chat.postMessage': { ok: false, error: 'channel_not_found' } }).call };
  await assert.rejects(postPrepared(failing, draft, prepared.approvalId, prepared.expect, book));
  const record = await approvals.get(prepared.approvalId);
  assert.notEqual(record?.state, 'sending', 'an approval left in `sending` is one whose outcome nobody knows');
});

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a reaction goes through the permit, and `never` refuses it like anything else', async () => {
  const { sent, call } = fakeSlack();
  const permit = closedPermit();
  await react({ call, permit, policy: 'chat', approvalId: 'ap_x' }, { channel: 'C1', ts: '1.1', name: 'eyes' });
  assert.equal(sent[0]?.method, 'reactions.add');
  assert.equal(permit.approvalId, null, 'and the door is shut again');

  await assert.rejects(
    react({ call, permit, policy: 'never', approvalId: 'ap_x' }, { channel: 'C1', ts: '1.1', name: 'eyes' }),
    /posting is turned off/,
  );
});

test('every posting method is refused without an open permit', async () => {
  // The four doors. A permit opened for one does not open the others, and a closed permit opens none.
  const { call } = fakeSlack();
  const closed = closedPermit();
  for (const method of ['chat.postMessage', 'reactions.add', 'reactions.remove', 'files.completeUploadExternal']) {
    const { callSlack } = await import('../src/api/call.ts');
    await assert.rejects(
      callSlack({ ...call, permit: closed }, method, { channel: 'C1' }),
      /permit|approval/i,
      `${method} needs a permit`,
    );
  }
});
