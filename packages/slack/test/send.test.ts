import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, asV2, CommsError } from '@agentcomms/core';
import { liveConfig } from '../../core/test/helpers/live-config.ts';
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
import { slackHandoffs } from './support/handoffs.ts';

/**
 * The gate.
 *
 * This is the file where a bug posts to somebody's workspace, so the tests are about refusals rather than about
 * the happy path. Every one of them describes a way an agent could get a message in front of people that nobody
 * agreed to — and each corresponds to a guard that was broken on purpose to check the test fails.
 */

const NOW = () => new Date('2026-09-23T12:00:00.000Z');
/** The workspace these posts are made from, as the approval store finds it in the configuration it classifies by. */
const ACCOUNT = 'acc_AAAAAAAAAAAAAAAA';

/** A store over `state` that classifies by a configuration holding the workspace, sending under `policy`. */
function storeFor(state: string, policy: 'chat' | 'confirm' | 'never' = 'chat') {
  const config = liveConfig(state, { accounts: { 'acme/slack': { id: ACCOUNT, sendPolicy: policy } } });
  return { config, approvals: new ApprovalStore(state, { now: NOW, loadConfig: config.loadConfig }) };
}

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

/**
 * `conversations.info` for the room: a channel of eight this account has joined, with `room` laid over it. A field set
 * to `undefined` is left out of the answer, as Slack leaves `is_member` out of a direct message's.
 */
function roomReply(room: Record<string, unknown> = {}, members = 8): unknown {
  return {
    ok: true,
    channel: { id: 'C1', name: 'engineering', num_members: members, is_member: true, ...room },
  };
}

async function setUp(
  options: {
    text?: string;
    members?: number;
    policy?: 'chat' | 'confirm' | 'never';
    channel?: string;
    room?: Record<string, unknown>;
  } = {},
) {
  const state = temp();
  const drafts = openDraftStore(state, NOW, slackHandoffs());
  const { approvals, config } = storeFor(state, options.policy);
  const draft = await drafts.create(
    ACCOUNT,
    compose({ channel: options.channel ?? 'C1', text: options.text ?? 'shipping in ten minutes' }),
    options.text ?? 'shipping in ten minutes',
  );
  // Replaceable mid-test: what Slack says about the room when the send reads it again.
  const script: Record<string, unknown> = { 'conversations.info': roomReply(options.room, options.members) };
  const { call, sent } = fakeSlack(script);
  const deps = {
    call,
    accountId: ACCOUNT,
    workspaceId: 'T0001',
    workspaceName: 'acme/slack',
    postingAs: 'U0',
    handoffs: slackHandoffs(),
    policy: options.policy ?? ('chat' as const),
    sendEpoch: 0,
    // The configuration the store classifies by, which holds no behaviour rules: every act is allowed, as before them.
    currentConfig: config.loadConfig,
    approvals,
    permit: closedPermit(),
  };
  return { drafts, approvals, draft, deps, sent, script, book: new NameBook(), config };
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
  const drafts = openDraftStore(state, NOW, slackHandoffs());
  const draft = await drafts.create(
    ACCOUNT,
    compose({ channel: 'C1', text: 'hi', mentions: [{ kind: 'broadcast', who: 'channel' }] }),
    'hi',
  );
  const { call } = fakeSlack({ 'conversations.info': { ok: false, error: 'channel_not_found' } });
  const { approvals, config } = storeFor(state);
  const prepared = await preparePost(
    {
      call,
      accountId: ACCOUNT,
      workspaceId: 'T0001',
      workspaceName: 'acme/slack',
      postingAs: 'U0',
      handoffs: slackHandoffs(),
      policy: 'chat',
      sendEpoch: 0,
      currentConfig: config.loadConfig,
      approvals,
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

// ── Membership ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The refusal of a post to a room this account has not joined: its code, its details, and the step it offers. */
function notAMember(error: unknown): boolean {
  assert.ok(error instanceof CommsError, `not a CommsError: ${String(error)}`);
  assert.equal(error.code, 'SCOPE_MISSING', error.message);
  assert.match(error.message, /nothing was sent/);
  assert.match(error.message, /#engineering \(C1\)/, 'the channel is named');
  // Apart from where its approval stands: none at prepare, the one waiting at send (design 2026-10-05 §D8).
  const { approval: _approval, ...details } = error.details ?? {};
  assert.deepEqual(details, { channel: 'C1', reason: 'not-a-member' });
  assert.match(error.hint ?? '', /Join the channel in Slack yourself, then prepare the post again/);
  return true;
}

test('a post to a channel this account has not joined is refused at prepare, and only the room was read', async () => {
  /*
   * Issue #43: a post an agent aims at a room the person never joined puts them into a conversation they are not part
   * of, and Slack cannot be relied on to stop it. It is stopped here, before anyone is shown a preview of it. A room
   * whose answer leaves `is_member` out is not taken as joined either.
   */
  for (const room of [{ is_member: false }, { is_member: undefined }]) {
    const { deps, draft, book, sent, approvals } = await setUp({ room });
    await assert.rejects(preparePost(deps, draft, book), notAMember, JSON.stringify(room));
    assert.deepEqual(
      sent.map((call) => call.method),
      ['conversations.info'],
      'the only call made is the read of the room',
    );
    assert.deepEqual(await approvals.list(), [], 'an approval was made for a post that was refused');
    assert.equal(deps.permit.approvalId, null);
  }
});

test('a stored draft that names a user is refused at prepare and at send, before Slack is asked anything', async () => {
  /*
   * Creating and updating a draft refuse a user id; a draft stored before 0.12.0, or written by hand, never went
   * through either. `chat.postMessage` takes a user id as a destination of its own, so it is refused where every post
   * is viewed, before the room is read.
   */
  const userId = (error: unknown) =>
    error instanceof CommsError && error.code === 'USAGE' && error.details?.reason === 'user-id';
  for (const channel of ['U024BE7LH', 'W024BE7LH']) {
    const { deps, draft, book, sent, approvals } = await setUp({ channel });
    await assert.rejects(preparePost(deps, draft, book), userId, channel);
    assert.deepEqual(sent, [], `Slack was asked something about ${channel}`);
    assert.deepEqual(await approvals.list(), []);
  }
  // Prepared to a channel, then the stored draft pointed at a user: refused at send, with nothing posted.
  const { deps, draft, book, sent, drafts } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  const moved = await drafts.update(
    draft.draftId,
    compose({ channel: 'U024BE7LH', text: 'shipping in ten minutes' }),
    'shipping in ten minutes',
  );
  // The channel the send is told to expect is the draft's own, so this is the user-id check and not the one that
  // compares the draft with what was approved.
  await assert.rejects(postPrepared(deps, moved, prepared.approvalId, 'U024BE7LH', book), userId);
  assert.equal(
    sent.some((call) => call.method === 'chat.postMessage'),
    false,
  );
});

test('a person who left the channel after prepare is refused at send, before the approval is claimed', async () => {
  /*
   * Before the claim, so the refusal spends nothing: the approval is still there, and once the person has joined again
   * the same approval posts. Checked after it, the approval would be spent on a post that never went.
   */
  const { deps, draft, book, sent, approvals, script } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  script['conversations.info'] = roomReply({ is_member: false });

  await assert.rejects(postPrepared(deps, draft, prepared.approvalId, 'C1', book), (error: unknown) => {
    notAMember(error);
    assert.equal(((error as CommsError).details?.approval as { state?: string } | undefined)?.state, 'pending');
    return true;
  });
  assert.equal(
    sent.some((call) => call.method === 'chat.postMessage'),
    false,
    'posted to a room the person has left',
  );
  assert.equal(asV2(await approvals.get(prepared.approvalId))?.state, 'pending', 'the refusal spent the approval');

  // Back in the room, the same approval posts.
  script['conversations.info'] = roomReply();
  const posted = await postPrepared(deps, draft, prepared.approvalId, 'C1', book);
  assert.equal(posted.ts, '1700000000.000100');
  assert.equal(asV2(await approvals.get(prepared.approvalId))?.state, 'used');
});

test('a direct message and a group DM post, though Slack says nothing of membership for either', async () => {
  /*
   * Slack leaves `is_member` out of a direct message's answer, and `channelOf` reads that as false. A DM is exempt by
   * what it is, never by that field — otherwise every DM would be refused as a room nobody had joined.
   */
  for (const [channel, room] of [
    ['D1', { id: 'D1', name: undefined, is_im: true, user: 'U7', is_member: undefined, num_members: undefined }],
    ['G1', { id: 'G1', name: 'mpdm-ann--bo--cy-1', is_mpim: true, is_member: undefined, num_members: 3 }],
  ] as const) {
    const { deps, draft, book, sent } = await setUp({ channel, room });
    const prepared = await preparePost(deps, draft, book);
    const posted = await postPrepared(deps, draft, prepared.approvalId, channel, book);
    assert.equal(posted.ts, '1700000000.000100', channel);
    assert.equal(sent.filter((call) => call.method === 'chat.postMessage').length, 1, channel);
  }
});

test('a room that cannot be read prepares as it did, and the preview says membership could not be checked', async () => {
  const { deps, draft, book, sent, script } = await setUp();
  script['conversations.info'] = { ok: false, error: 'ratelimited' };
  const prepared = await preparePost(deps, draft, book);
  assert.ok(
    (prepared.preview.warnings ?? []).some((warning) =>
      /could not check whether this account is a member/.test(warning),
    ),
    (prepared.preview.warnings ?? []).join('\n'),
  );
  // And it posts as it did before membership was checked: nothing is known to be wrong, only unread.
  const posted = await postPrepared(deps, draft, prepared.approvalId, 'C1', book);
  assert.equal(posted.ts, '1700000000.000100');
  assert.ok(sent.some((call) => call.method === 'chat.postMessage'));
});

test('a joined room’s preview carries no membership warning', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  assert.deepEqual(prepared.preview.warnings, []);
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

test('a draft whose blocks say something its text does not is refused before its text is shown as the post', async () => {
  /*
   * The preview reads the text; the post sends the blocks, and a client renders — and notifies from — the blocks.
   * A draft file rewritten by hand (anything with a shell can) so the two disagree was previewed from its text,
   * approved, and posted as its blocks: the person agreed to one message and another went out. Here the hidden one
   * also pings the room, which the text-derived reach did not count. Nothing about it may be prepared, and Slack is
   * not even asked about the room.
   */
  const { deps, draft, book, sent } = await setUp();
  const tampered = {
    ...draft,
    payload: {
      ...draft.payload,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '<!channel> wire the float to account 4471' } }],
    },
  };
  await assert.rejects(
    preparePost(deps, tampered, book),
    (error: unknown) =>
      error instanceof CommsError &&
      error.code === 'BAD_DATA' &&
      /not what its text composes to/.test(error.message) &&
      /nothing was sent/.test(error.message),
  );
  assert.deepEqual(sent, [], 'refused before Slack was asked anything');

  // And a field the post never sends, added by hand, is the same refusal: the file is the payload, or it is nothing.
  const widened = { ...draft, payload: { ...draft.payload, reply_broadcast: true } };
  await assert.rejects(preparePost(deps, widened, book), /not what its text composes to/);

  // A draft the composer wrote prepares as it always did.
  const prepared = await preparePost(deps, draft, book);
  assert.match(prepared.preview.body, /shipping in ten minutes/);
});

test('what posts is the payload the digest was taken over, field for field', async () => {
  /*
   * The approval binds a hash of the payload, and the post sends named fields of it. Checked on the wire rather than
   * trusted: every field `chat.postMessage` is given comes from the one composed payload the preview showed.
   */
  const { deps, draft, book, sent } = await setUp({ text: 'a < b & c' });
  const prepared = await preparePost(deps, draft, book);
  await postPrepared(deps, draft, prepared.approvalId, 'C1', book);
  const params = sent.find((call) => call.method === 'chat.postMessage')?.params;
  assert.ok(params);
  const composed = compose({ channel: 'C1', text: 'a < b & c' });
  assert.equal(params.get('text'), composed.text);
  assert.deepEqual(JSON.parse(params.get('blocks') ?? 'null'), composed.blocks);
  assert.equal(params.get('channel'), 'C1');
  assert.equal(params.get('unfurl_links'), 'false');
  assert.equal(params.get('unfurl_media'), 'false');
  assert.equal(prepared.preview.body, 'a < b & c', 'and the preview is that text, decoded as the client shows it');
});

test('a room that grew between the preview and the post voids the approval', async () => {
  /*
   * The reach is inside the digest, and this is why. The words did not change; who reads them did. A person who
   * agreed to interrupt eight people did not agree to interrupt four hundred.
   */
  const state = temp();
  const drafts = openDraftStore(state, NOW, slackHandoffs());
  const { approvals, config } = storeFor(state);
  const draft = await drafts.create(
    ACCOUNT,
    compose({ channel: 'C1', text: 'heads up', mentions: [{ kind: 'broadcast', who: 'here' }] }),
    'heads up',
  );
  let members = 8;
  const call: SlackCall = {
    token: 't',
    fetch: async (input, init) => {
      const method = String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '';
      if (method === 'conversations.info') {
        return new Response(
          JSON.stringify({ ok: true, channel: { id: 'C1', name: 'eng', num_members: members, is_member: true } }),
        );
      }
      void init;
      return new Response(JSON.stringify({ ok: true, ts: '1.1' }));
    },
  };
  const deps = {
    call,
    accountId: ACCOUNT,
    workspaceId: 'T0001',
    workspaceName: 'acme/slack',
    postingAs: 'U0',
    handoffs: slackHandoffs(),
    policy: 'chat' as const,
    sendEpoch: 0,
    currentConfig: config.loadConfig,
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
  const failing = {
    ...deps,
    call: fakeSlack({
      'conversations.info': roomReply(),
      'chat.postMessage': { ok: false, error: 'channel_not_found' },
    }).call,
  };
  await assert.rejects(postPrepared(failing, draft, prepared.approvalId, 'C1', book));
  const record = asV2(await approvals.get(prepared.approvalId));
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
    const record = asV2(await approvals.get(prepared.approvalId));
    assert.ok(record);
    assert.deepEqual(reactionOfApproval(record, 'T0001'), wanted);
    assert.throws(() => reactionOfApproval(record, 'T0002'), /does not describe/, 'another workspace’s digest');
  }

  // A post's approval is not a reaction's, and is left for the post path.
  const post = await setUp({ policy: 'confirm' });
  const prepared = await preparePost(post.deps, post.draft, post.book);
  const record = asV2(await post.approvals.get(prepared.approvalId));
  assert.ok(record);
  assert.equal(reactionOfApproval(record, 'T0001'), undefined);

  // A record whose words say one emoji while its digest binds another shows neither.
  const bound = await prepareReaction(deps, { channel: 'C1', ts: '1.1', name: 'thumbsdown' });
  const honest = asV2(await approvals.get(bound.approvalId));
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

// ── Classified before anything is asked of Slack, and where the approval stands (CUE-404 Task 9; §D2, §D8) ──────────

test('a post or a reaction finds an id nobody prepared, another workspace’s — expired or not — and another kind’s as the one NOT_FOUND, before Slack is asked anything (D2-b)', async () => {
  const OTHER = 'acc_BBBBBBBBBBBBBBBB';
  const { deps, draft, book, sent, approvals, config } = await setUp();
  config.write({
    accounts: { 'acme/slack': { id: ACCOUNT, sendPolicy: 'chat' }, 'zeta/slack': { id: OTHER, sendPolicy: 'chat' } },
  });
  const theirs = (subject: string) =>
    approvals.create({
      channel: 'slack',
      inboxId: OTHER,
      inboxSub: 'U9',
      draftId: 'dr_theirs',
      draftMessageId: 'rev-1',
      contentDigest: 'c'.repeat(64),
      sendEpoch: 0,
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['C1'], cc: [], bcc: [], subject },
    });
  const live = await theirs('reaches 8');
  // Created an hour before the store's clock: classified, it would be refused as expired.
  const anHourAgo = new ApprovalStore(join(approvals.directory, '..'), {
    now: () => new Date(NOW().getTime() - 60 * 60_000),
    loadConfig: config.loadConfig,
  });
  const expired = await anHourAgo.create({
    channel: 'slack',
    inboxId: OTHER,
    draftId: 'dr_old',
    draftMessageId: 'rev-1',
    contentDigest: 'd'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: { to: ['C1'], cc: [], bcc: [], subject: 'reaches 8' },
  });
  const change = await approvals.createChange({
    channel: 'slack',
    change: { summary: 'x', target: null, loosened: [], effects: ['does a thing'] },
    policy: 'chat',
  });
  const ids = [live.approvalId, expired.approvalId, change.approvalId];
  const files = ids.map((id) => readFileSync(join(approvals.directory, `${id}.json`), 'utf8'));
  for (const [what, attempt] of [
    ['post', (id: string) => postPrepared(deps, draft, id, 'C1', book)],
    ['reaction', (id: string) => reactPrepared(deps, id, { channel: 'C1', ts: '1.1', name: 'eyes' })],
  ] as const) {
    const envelopes = [];
    for (const id of [`ap_${'7'.repeat(26)}`, live.approvalId, expired.approvalId, change.approvalId]) {
      const error = await attempt(id).then(
        () => assert.fail(`${what} ${id} went through`),
        (refused: unknown) => refused as CommsError,
      );
      assert.equal(error.code, 'NOT_FOUND', `${what}: ${error.message}`);
      assert.deepEqual(error.details, { approval: null }, what);
      envelopes.push(JSON.stringify({ m: error.message, h: error.hint, d: error.details }).replaceAll(id, 'ID'));
    }
    assert.equal(new Set(envelopes).size, 1, `${what}: one envelope, byte for byte`);
  }
  assert.deepEqual(sent, [], 'Slack was asked nothing: not the room, not a post');
  assert.deepEqual(
    ids.map((id) => readFileSync(join(approvals.directory, `${id}.json`), 'utf8')),
    files,
    'no record was written: none was classified',
  );
});

test('every post and reaction result and refusal says where its approval stands (D8o-a)', async () => {
  const { deps, draft, book } = await setUp();
  const prepared = await preparePost(deps, draft, book);
  assert.equal(prepared.approval.id, prepared.approvalId);
  assert.equal(prepared.approval.channel, 'slack');
  assert.equal(prepared.approval.state, 'pending');
  assert.equal(prepared.approval.claimable, true, 'a yes in the chat posts it');
  const posted = await postPrepared(deps, draft, prepared.approvalId, 'C1', book);
  assert.equal(posted.approval.state, 'used');
  assert.equal(posted.approval.sentMessageId, posted.ts);
  // Used: refused before Slack is asked, with where it stands.
  const again = await postPrepared(deps, draft, prepared.approvalId, 'C1', book).then(
    () => assert.fail('posted twice'),
    (error: unknown) => error as CommsError,
  );
  assert.equal(again.code, 'APPROVAL_VOID');
  assert.equal((again.details?.approval as { state?: string } | undefined)?.state, 'used');

  const reaction = await prepareReaction(deps, { channel: 'C1', ts: '1.1', name: 'eyes' });
  assert.equal(reaction.approval.state, 'pending');
  assert.equal(reaction.approval.claimable, true);
  const reacted = await reactPrepared(deps, reaction.approvalId, { channel: 'C1', ts: '1.1', name: 'eyes' });
  assert.equal(reacted.approval.state, 'used');

  // Waiting for a person: the hand-over says so, with the record as it stands.
  const confirm = await setUp({ policy: 'confirm' });
  const waiting = await preparePost(confirm.deps, confirm.draft, confirm.book);
  assert.equal(waiting.approval.claimable, false);
  const pending = await postPrepared(confirm.deps, confirm.draft, waiting.approvalId, 'C1', confirm.book).then(
    () => assert.fail('posted without a person'),
    (error: unknown) => error as CommsError,
  );
  assert.equal(pending.code, 'APPROVAL_PENDING');
  assert.equal((pending.details?.approval as { state?: string } | undefined)?.state, 'pending');
  assert.equal((pending.details?.approval as { claimable?: boolean } | undefined)?.claimable, false);

  // Refused before any approval exists: nothing to say of one.
  const never = await setUp({ policy: 'never' });
  const refused = await preparePost(never.deps, never.draft, never.book).then(
    () => assert.fail('prepared under never'),
    (error: unknown) => error as CommsError,
  );
  assert.equal(refused.code, 'POLICY_NEVER');
  assert.equal(refused.details?.approval, undefined);
});
