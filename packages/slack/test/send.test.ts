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
import { mentionedUserIds, notifiesOf } from '../src/compose/preview.ts';
import { NameBook, personOf } from '../src/operations/people.ts';
import {
  postPrepared,
  preparePost,
  prepareReaction,
  reactionOfApproval,
  reactPrepared,
} from '../src/operations/send.ts';

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

test('an @here raises the ceremony as @channel does, however small the room', async () => {
  /*
   * `@here` reaches whoever is online, which nothing here can count, so it is counted as the room — and the people it
   * interrupts are no more in the conversation to object than `@channel`'s. Only `@channel` and `@everyone` raised the
   * ceremony, so under `chat` an `@here` to a small room went out on a yes in the chat, while the posting skill told
   * agents every broadcast needs a person at a terminal. With posting reachable from MCP, the skill is what agents act
   * on; the code now says the same.
   */
  for (const who of ['here', 'channel', 'everyone'] as const) {
    const { deps, drafts, draft, book } = await setUp({ text: 'deploy now', members: 4 });
    const broadcast = await drafts.update(
      draft.draftId,
      compose({ channel: 'C1', text: 'deploy now', mentions: [{ kind: 'broadcast', who }] }),
      'deploy now',
    );
    const prepared = await preparePost(deps, broadcast, book);
    assert.equal(prepared.requiredPolicy, 'confirm', `@${who} to four people still needs a person at a terminal`);
    await assert.rejects(
      postPrepared(deps, broadcast, prepared.approvalId, 'C1', book),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_PENDING',
      `@${who} under \`chat\` waits for a person`,
    );
  }
});

test('a mention nobody can count — a user group, an unknown special — needs a person at a terminal, and waits for one', async () => {
  /*
   * The composer cannot write one: every mention it writes is checked, and typed text is escaped. So this is a draft
   * that did not come from it — a file edited by hand, or an older version's `--broadcast subteam^S0123`, which the
   * preview counted as nobody and let go on a yes in the chat. A group's size is not something this can read.
   */
  for (const [mention, shown] of [
    ['<!subteam^S0123>', '@S0123 (a user group)'],
    ['<!subteam^S0123|@oncall>', '@S0123 (a user group)'],
    ['<!group>', '@group (a special mention)'],
  ] as const) {
    const { deps, drafts, draft, book } = await setUp({ members: 4 });
    const text = `${mention} standup moved`;
    const edited = await drafts.update(
      draft.draftId,
      {
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
        channel: 'C1',
        unfurl_links: false,
        unfurl_media: false,
      },
      'standup moved',
    );
    const prepared = await preparePost(deps, edited, book);
    assert.equal(prepared.requiredPolicy, 'confirm', mention);
    assert.deepEqual(prepared.preview.notifies.users, [shown], `${mention} is named in the preview`);
    assert.match(prepared.preview.notifies.unknown ?? '', /nothing here can count/, `${mention}: reach not known`);
    assert.equal(prepared.preview.notifies.estimated, 0, 'and no number is invented for it');
    assert.ok(prepared.riskFlags.includes('reach-unknown'), mention);
    await assert.rejects(
      postPrepared(deps, edited, prepared.approvalId, 'C1', book),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_PENDING',
      `${mention} under \`chat\` waits for a person`,
    );
  }
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
  const posted = await postPrepared(deps, draft, prepared.approvalId, 'C1', book);
  assert.equal(posted.ts, '1700000000.000100');
  assert.ok(sent.some((call) => call.method === 'chat.postMessage'));
  assert.equal(deps.permit.approvalId, null, 'closed again afterwards');

  // The same approval cannot be spent twice: the claim marker is single-use across processes.
  await assert.rejects(postPrepared(deps, draft, prepared.approvalId, 'C1', book), /nothing was sent/);
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
    postPrepared(deps, edited, prepared.approvalId, 'C1', book),
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
  await assert.rejects(postPrepared(deps, tampered, prepared.approvalId, 'C1', book), /nothing was sent/);
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
  await assert.rejects(postPrepared(deps, draft, prepared.approvalId, 'C1', new NameBook()), /nothing was sent/);
});

test('an approval prepared for one account cannot be spent by another', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  await assert.rejects(
    postPrepared({ ...deps, postingAs: 'U9' }, draft, prepared.approvalId, 'C1', book),
    /nothing was sent/,
    'two accounts in one workspace are two different people saying the same words',
  );
});

test('a caller that restates the wrong destination cannot post', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  await assert.rejects(postPrepared(deps, draft, prepared.approvalId, 'C_OTHER', book), /nothing was sent/);
});

test('a failed post is recorded rather than left in flight', async () => {
  const { deps, draft, book, approvals } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  const failing = { ...deps, call: fakeSlack({ 'chat.postMessage': { ok: false, error: 'channel_not_found' } }).call };
  await assert.rejects(postPrepared(failing, draft, prepared.approvalId, 'C1', book));
  const record = await approvals.get(prepared.approvalId);
  assert.notEqual(record?.state, 'sending', 'an approval left in `sending` is one whose outcome nobody knows');
});

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a reaction is a real approval, claimed once, not a permit opened on a bare string', async () => {
  /*
   * The version this replaces took an `approvalId` and never created or claimed one, so any string opened the
   * door. D6's lower ceremony is about the *preview* — one line rather than a rendered message — not about the
   * gate.
   */
  const { deps } = await setUp();
  const wanted = { channel: 'C1', ts: '1.1', name: 'eyes' };
  const prepared = await prepareReaction(deps, wanted);
  assert.match(prepared.approvalId, /^ap_/);

  await reactPrepared(deps, prepared.approvalId, wanted);
  assert.equal(deps.permit.approvalId, null, 'the door is shut again');

  // Single-use, like every other approval.
  await assert.rejects(reactPrepared(deps, prepared.approvalId, wanted), /nothing was sent/);

  // And an approval for one emoji does not permit another.
  const other = await prepareReaction(deps, wanted);
  await assert.rejects(
    reactPrepared(deps, other.approvalId, { ...wanted, name: 'rocket' }),
    /nothing was sent/,
    'the approval is bound to this emoji on this message',
  );
});

test('a reaction approval reads back as the reaction it binds, and is refused when it does not', async () => {
  /*
   * The approval screen renders a reaction from its record, having no draft to read — so the record has to say
   * exactly what the digest binds. A skin-tone emoji carries colons of its own, and a removal lives in the flags.
   */
  const { deps, approvals } = await setUp({ policy: 'confirm' });
  for (const wanted of [
    { channel: 'C1', ts: '1.1', name: 'thumbsup::skin-tone-2', remove: false },
    { channel: 'C2', ts: '2.2', name: 'eyes', remove: true },
  ]) {
    const prepared = await prepareReaction(deps, wanted);
    const record = await approvals.get(prepared.approvalId);
    assert.ok(record);
    assert.deepEqual(reactionOfApproval(record, 'T0001'), wanted);
    assert.throws(() => reactionOfApproval(record, 'T0002'), /does not describe/, 'another workspace’s digest');
  }

  // A post's approval is not a reaction's, and is left for the post path.
  const post = await setUp({ policy: 'confirm' });
  const prepared = await preparePost(post.deps, post.draft, post.book);
  const record = await post.approvals.get(prepared.approvalId);
  assert.ok(record);
  assert.equal(reactionOfApproval(record, 'T0001'), undefined);

  // A record whose words say one emoji while its digest binds another shows neither.
  const bound = await prepareReaction(deps, { channel: 'C1', ts: '1.1', name: 'thumbsdown' });
  const honest = await approvals.get(bound.approvalId);
  assert.ok(honest);
  const relabelled = { ...honest, expect: { ...honest.expect, subject: ':tada: on 1.1' } };
  assert.throws(() => reactionOfApproval(relabelled, 'T0001'), /does not describe the reaction it is bound to/);
});

test('`never` refuses a reaction before an approval is even made', async () => {
  const { deps } = await setUp({ policy: 'never' });
  await assert.rejects(prepareReaction(deps, { channel: 'C1', ts: '1.1', name: 'eyes' }), /posting is turned off/);
});

test('the gate writes what it did, so `audit tail` can answer what was posted', async () => {
  const { deps, draft, book } = await setUp();
  const written: { operation: string; outcome: string }[] = [];
  const audited = {
    ...deps,
    audit: { append: async (r: { operation: string; outcome: string }) => void written.push(r) },
  };
  const prepared = await preparePost(audited, draft, book);
  await postPrepared(audited, draft, prepared.approvalId, 'C1', book);
  assert.deepEqual(
    written.map((row) => `${row.operation}:${row.outcome}`),
    ['slack.post.prepare:started', 'slack.post:ok'],
  );
});

test('the digest binds mentioned ids, not the display names the preview shows', async () => {
  /*
   * `CanonicalChannelMessage.notifies.users` is documented "user ids"; the preview's `notifies.users` is
   * documented "resolved to display names". An earlier version fed the second into the first, binding the
   * approval to a mutable string its owner does not control.
   *
   * The *rendered* text still binds, and that is deliberate rather than an oversight: `visibleText` is what the
   * person read, and if a mention will render differently by the time it posts, they read something else. A
   * rename inside the approval's ten-minute window therefore voids it — a refusal, which is the safe direction.
   * What this test pins is that the identity half of the digest is an id.
   */
  assert.deepEqual(mentionedUserIds('<@U1> and <@U2> and <@U1>'), ['U1', 'U2'], 'ids, sorted and de-duplicated');
  assert.deepEqual(mentionedUserIds('no mentions here'), []);

  // And the preview, by contrast, shows names — the two are different jobs on the same message.
  const book = new NameBook();
  book.add(personOf({ id: 'U1', profile: { display_name: 'sam' } }));
  assert.deepEqual(notifiesOf({ text: '<@U1> ping' }, book, 3, undefined).users, ['sam']);
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
