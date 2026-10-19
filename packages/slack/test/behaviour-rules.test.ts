import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { asV2, type CommsError } from '@agentcomms/core';
import { renderDeletionPreview } from '../src/operations/amend.ts';
import { beginApproval } from '../src/operations/approve.ts';
import { renderSlackPreview, requireAllowed } from '../src/operations/behaviour.ts';
import { createDraft, updateDraft } from '../src/operations/drafts.ts';
import { gateDepsFor } from '../src/operations/gate.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  react,
  sendDelete,
  sendEdit,
  sendPost,
} from '../src/operations/post.ts';
import { prepareReaction } from '../src/operations/send.ts';
import { homeFile } from './support/amend.ts';
import {
  ANA,
  ANA_DM,
  approvalCount,
  type BehaviourWorld,
  behaviourWorld,
  ENG,
  GROUP_WITH_SAM,
  GROUP_WITHOUT_SAM,
  MINE,
  MINE_IN_GROUP,
  PRIVATE_WITH_SAM,
  refusedWith,
  SAM,
  SAM_DM,
  setRules,
} from './support/behaviour.ts';

/**
 * What an agent may do in Slack (design 2026-10-19-agent-behaviour-rules, B2–B4): every post, reply, file, reaction,
 * edit and deletion is checked against the behaviour rules twice — at prepare, before any preview or approval, and again
 * just before its approval is claimed, on the configuration as it is then. Against the loopback fake: nothing here
 * reaches the real Slack.
 */

/** Every Slack method that puts something in front of people. None may be asked once a rule refuses the act. */
const WRITES = [
  'chat.postMessage',
  'reactions.add',
  'reactions.remove',
  'chat.update',
  'chat.delete',
  'files.getUploadURLExternal',
  'files.completeUploadExternal',
];

function nothingWritten(w: BehaviourWorld, what: string): void {
  for (const method of WRITES) assert.equal(w.asked(method), 0, `${what}: Slack was asked ${method}`);
}

/** The refusal B4 names: `ACT_NOT_ALLOWED`, exit 10, its hint naming the report and never a command that loosens. */
function assertActRefused(error: CommsError, act: string, message: string): void {
  assert.equal(error.code, 'ACT_NOT_ALLOWED', `${act}: ${error.message}`);
  assert.equal(error.exitCode, 10);
  assert.equal(error.retryable, false);
  assert.equal(error.message, message);
  assert.equal(error.details?.act, act);
  assert.match(error.hint ?? '', /behaviour/, 'the hint does not name what shows the rules');
  assert.doesNotMatch(error.hint ?? '', /\b(allow|clear)\b/, 'the hint names a command that changes the rules');
}

const WANTED = { channel: ENG, ts: MINE, name: 'eyes' };

// ── Refused at prepare ─────────────────────────────────────────────────────────────────────────────────────────

interface PrepareCase {
  readonly name: string;
  readonly acts: readonly string[];
  readonly act: string;
  readonly message: string;
  readonly prepare: (w: BehaviourWorld) => Promise<unknown>;
}

const PREPARES: readonly PrepareCase[] = [
  {
    name: 'a post',
    acts: ['reply'],
    act: 'post',
    message: 'this agent may only reply in #eng (acme)',
    prepare: (w) => prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping' }, w.slack),
  },
  {
    name: 'a reply',
    acts: ['post'],
    act: 'reply',
    message: 'this agent may only post in #eng (acme)',
    prepare: (w) => prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping', threadTs: MINE }, w.slack),
  },
  {
    name: 'a file in a thread',
    acts: ['reply'],
    act: 'file',
    message: 'this agent may only reply in #eng (acme)',
    prepare: (w) =>
      prepareDraftPost(
        w.context,
        'acme',
        { channel: ENG, text: 'the notes', threadTs: MINE, files: [homeFile(w.harness, 'notes.txt', 'the notes\n')] },
        w.slack,
      ),
  },
  {
    name: 'a file at the top of the channel',
    acts: ['reply', 'file'],
    act: 'post',
    message: 'this agent may only reply and share files in #eng (acme)',
    prepare: (w) =>
      prepareDraftPost(
        w.context,
        'acme',
        { channel: ENG, text: 'the notes', files: [homeFile(w.harness, 'notes.txt', 'the notes\n')] },
        w.slack,
      ),
  },
  {
    name: 'a reaction',
    acts: ['post'],
    act: 'reaction',
    message: 'this agent may only post in #eng (acme)',
    prepare: (w) => react(w.context, 'acme', WANTED, undefined, w.slack),
  },
  {
    name: 'an edit',
    acts: ['post'],
    act: 'edit',
    message: 'this agent may only post in #eng (acme)',
    prepare: (w) =>
      prepareEdit(w.context, 'acme', { ts: MINE, channel: ENG, text: 'shipping in ten minutes' }, w.slack),
  },
  {
    name: 'an edit that adds files',
    acts: ['edit'],
    act: 'file',
    message: 'this agent may only edit in #eng (acme)',
    prepare: (w) =>
      prepareEdit(
        w.context,
        'acme',
        { ts: MINE, channel: ENG, files: [homeFile(w.harness, 'notes.txt', 'the notes\n')] },
        w.slack,
      ),
  },
  {
    name: 'a deletion',
    acts: ['edit'],
    act: 'delete',
    message: 'this agent may only edit in #eng (acme)',
    prepare: (w) => prepareDelete(w.context, 'acme', { channel: ENG, ts: MINE }, w.slack),
  },
];

for (const each of PREPARES) {
  test(`${each.name} a rule forbids is refused at prepare, with no approval made`, async (t) => {
    const w = await behaviourWorld(t);
    await setRules(w.harness, [{ acts: each.acts }]);
    const error = await refusedWith(each.prepare(w), each.name);
    assertActRefused(error, each.act, each.message);
    assert.equal(await approvalCount(w.harness), 0, `${each.name}: an approval was made for an act no rule allows`);
    nothingWritten(w, each.name);
  });
}

test('a rule that allows nothing says so', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: [] }]);
  const error = await refusedWith(
    prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping' }, w.slack),
    'a post where nothing is allowed',
  );
  assertActRefused(error, 'post', 'this agent may do nothing in #eng (acme)');
  assert.equal(await approvalCount(w.harness), 0);
});

// ── Direct messages ────────────────────────────────────────────────────────────────────────────────────────────

test('a DM is ruled by the person’s U rule when no D rule exists', async (t) => {
  const w = await behaviourWorld(t);
  // Sam may only be reacted to: nothing is said of the DM with him itself.
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  const error = await refusedWith(
    prepareDraftPost(w.context, 'acme', { channel: SAM_DM, text: 'hello Sam' }, w.slack),
    'a post in the DM with Sam',
  );
  assert.equal(error.code, 'ACT_NOT_ALLOWED');
  assert.equal(error.details?.act, 'post');
  assert.equal(error.details?.place, SAM, 'the refusal does not name the rule for the person');
  assert.match(error.message, /^this agent may only react in /);
  assert.equal(await approvalCount(w.harness), 0);

  // The rule is Sam's: a DM with someone else, and the channel, are not held to it.
  const toAna = await prepareDraftPost(w.context, 'acme', { channel: ANA_DM, text: 'hello Ana' }, w.slack);
  assert.equal(toAna.preview.allowedHere, 'Allowed here: everything (no rule)');
  await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'hello all' }, w.slack);
  // And what it allows, it allows in the DM: a reaction there is made.
  await react(w.context, 'acme', { channel: SAM_DM, ts: MINE, name: 'wave' }, undefined, w.slack);
  assert.equal(w.asked('reactions.add'), 1);
  assert.equal(w.asked('chat.postMessage'), 0);
});

test('a DM whose person could not be read is held to every person’s rule', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  // D0NOBODY is not a room the fake knows: Slack cannot say whose DM it is, so it may be Sam's.
  const error = await refusedWith(
    prepareDraftPost(w.context, 'acme', { channel: 'D0NOBODY', text: 'hello' }, w.slack),
    'a post in a DM nobody could read',
  );
  assert.equal(error.code, 'ACT_NOT_ALLOWED');
  assert.equal(error.details?.act, 'post');
  assert.equal(await approvalCount(w.harness), 0);
});

test('a DM post is bound to the person the DM is with: the approval posts nowhere Slack says is someone else’s', async (t) => {
  const w = await behaviourWorld(t);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: SAM_DM, text: 'hello Sam' }, w.slack);
  // Slack now says the DM is with Ana: not the place the person said yes to, whatever the rules say of either.
  w.world.rooms[SAM_DM] = { is_im: true, user: ANA, members: ['U0001', ANA] };
  const error = await refusedWith(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: SAM_DM },
      w.slack,
    ),
    'a post approved for the DM with Sam, sent once Slack says it is with Ana',
  );
  // Voided by the digest, which binds the person the DM is with — not refused for some other reason on the way there.
  assert.equal(error.code, 'APPROVAL_VOID', `${error.code}: ${error.message}`);
  assert.equal(w.asked('chat.postMessage'), 0, 'a post approved for the DM with Sam went to the DM with Ana');
});

test('a DM reaction’s approval keeps the person the DM is with, and its screen says what their rule allows', async (t) => {
  const w = await behaviourWorld(t, { sendPolicy: 'confirm' });
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  const prepared = await prepareReaction(await gateDepsFor(w.context, 'acme', w.slack), {
    ...WANTED,
    channel: SAM_DM,
  });
  const line = `Allowed here: reaction (rule: acme, ${SAM})`;
  assert.equal(prepared.allowedHere, line);
  const prompt = await beginApproval(w.context, prepared.approvalId, w.slack);
  assert.equal(prompt.kind, 'reaction');
  assert.ok(prompt.preview.split('\n').includes(line), prompt.preview);
});

// ── Tightened after the yes ─────────────────────────────────────────────────────────────────────────────────────

test('tightened after the yes refuses at send: a post', async (t) => {
  const w = await behaviourWorld(t);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping' }, w.slack);
  await setRules(w.harness, [{ acts: ['reply'] }]);
  const send = () =>
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
      w.slack,
    );
  assertActRefused(
    await refusedWith(send(), 'a post after the rule'),
    'post',
    'this agent may only reply in #eng (acme)',
  );
  assert.equal(w.asked('chat.postMessage'), 0, 'Slack was asked to post what a rule now forbids');
  // Refused before the claim: the approval is not spent, and posts once a rule allows it again.
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
  await setRules(w.harness, []);
  await send();
  assert.equal(w.asked('chat.postMessage'), 1);
});

test('tightened after the yes refuses at send: a reaction', async (t) => {
  const w = await behaviourWorld(t);
  const gate = await gateDepsFor(w.context, 'acme', w.slack);
  const prepared = await prepareReaction(gate, WANTED);
  await setRules(w.harness, [{ acts: ['post'] }]);
  const error = await refusedWith(
    react(w.context, 'acme', WANTED, prepared.approvalId, w.slack),
    'a reaction after the rule',
  );
  assertActRefused(error, 'reaction', 'this agent may only post in #eng (acme)');
  assert.equal(w.asked('reactions.add'), 0, 'Slack was asked to react where a rule now forbids it');
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('tightened after the yes refuses at send: an edit', async (t) => {
  const w = await behaviourWorld(t);
  const prepared = await prepareEdit(
    w.context,
    'acme',
    { ts: MINE, channel: ENG, text: 'shipping in ten minutes' },
    w.slack,
  );
  await setRules(w.harness, [{ acts: ['post'] }]);
  const error = await refusedWith(
    sendEdit(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG, ts: MINE },
      w.slack,
    ),
    'an edit after the rule',
  );
  assertActRefused(error, 'edit', 'this agent may only post in #eng (acme)');
  assert.equal(w.asked('chat.update'), 0, 'Slack was asked to edit where a rule now forbids it');
  assert.equal(w.world.messages[0]?.text, 'shipping in ten minuets');
});

test('tightened after the yes refuses at send: a deletion', async (t) => {
  const w = await behaviourWorld(t);
  const prepared = await prepareDelete(w.context, 'acme', { channel: ENG, ts: MINE }, w.slack);
  await setRules(w.harness, [{ conversation: ENG, acts: ['edit'] }]);
  const error = await refusedWith(
    sendDelete(w.context, 'acme', { channel: ENG, ts: MINE, approvalId: prepared.approvalId }, w.slack),
    'a deletion after the rule',
  );
  assertActRefused(error, 'delete', 'this agent may only edit in #eng (acme)');
  assert.equal(w.asked('chat.delete'), 0, 'Slack was asked to delete where a rule now forbids it');
  assert.equal(w.world.messages[0]?.deleted, undefined);
});

// ── What every preview says ─────────────────────────────────────────────────────────────────────────────────────

test('with no rule, every preview says everything is allowed', async (t) => {
  const w = await behaviourWorld(t);
  const line = 'Allowed here: everything (no rule)';
  const post = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping' }, w.slack);
  assert.equal(post.preview.allowedHere, line);
  assert.ok(renderSlackPreview(post.preview).split('\n').includes(line), 'the rendered post preview lacks the line');
  const edit = await prepareEdit(w.context, 'acme', { ts: MINE, channel: ENG, text: 'shipping soon' }, w.slack);
  assert.equal(edit.preview.allowedHere, line);
  const deletion = await prepareDelete(w.context, 'acme', { channel: ENG, ts: MINE }, w.slack);
  assert.equal(deletion.preview.allowedHere, line);
  const reaction = await prepareReaction(await gateDepsFor(w.context, 'acme', w.slack), WANTED);
  assert.equal(reaction.allowedHere, line);
});

test('every preview carries the Allowed here line, naming the rule that holds', async (t) => {
  const w = await behaviourWorld(t, { sendPolicy: 'confirm' });
  await setRules(w.harness, [
    { acts: ['reaction'] },
    { conversation: ENG, acts: ['post', 'reply', 'reaction', 'edit', 'delete'] },
  ]);
  const line = 'Allowed here: post, reply, reaction, edit, delete (rule: acme, #eng)';

  const post = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping' }, w.slack);
  assert.equal(post.preview.allowedHere, line);
  const shown = renderSlackPreview(post.preview).split('\n');
  assert.ok(shown.includes(line), 'the rendered post preview lacks the line');
  // Beside what has to happen before it posts, at the foot of the preview.
  assert.equal(shown.at(-2), line);

  const edit = await prepareEdit(w.context, 'acme', { ts: MINE, channel: ENG, text: 'shipping soon' }, w.slack);
  assert.equal(edit.preview.allowedHere, line);
  assert.ok(renderSlackPreview(edit.preview).split('\n').includes(line), 'the rendered edit preview lacks the line');

  const deletion = await prepareDelete(w.context, 'acme', { channel: ENG, ts: MINE }, w.slack);
  assert.equal(deletion.preview.allowedHere, line);
  assert.ok(renderDeletionPreview(deletion.preview).split('\n').includes(line), 'the deletion preview lacks the line');

  const reaction = await prepareReaction(await gateDepsFor(w.context, 'acme', w.slack), WANTED);
  assert.equal(reaction.allowedHere, line);

  // The screen a person approves at shows it too, for each act.
  for (const approvalId of [post.approvalId, edit.approvalId, deletion.approvalId]) {
    const prompt = await beginApproval(w.context, approvalId, w.slack);
    assert.ok(prompt.preview.split('\n').includes(line), `the ${prompt.kind} approval screen lacks the line`);
  }
  // A reaction's screen asks Slack nothing, so it names the room by its id.
  const asked = w.fake.requests.length;
  const prompt = await beginApproval(w.context, reaction.approvalId, w.slack);
  assert.equal(prompt.kind, 'reaction');
  assert.ok(
    prompt.preview.split('\n').includes(`Allowed here: post, reply, reaction, edit, delete (rule: acme, ${ENG})`),
    `the reaction approval screen lacks the line:\n${prompt.preview}`,
  );
  assert.equal(w.fake.requests.length, asked, 'the reaction approval screen asked Slack something');

  // Elsewhere in the account, the account's rule holds, and the line says so without a place.
  const inDm = await prepareReaction(await gateDepsFor(w.context, 'acme', w.slack), { ...WANTED, channel: SAM_DM });
  assert.equal(inDm.allowedHere, 'Allowed here: reaction (rule: acme)');
});

// ── A destination that is no conversation id ────────────────────────────────────────────────────────────────────

/**
 * Slack's `chat.postMessage` takes a channel's name as well as its id, and a name matches no rule: so `eng` once went
 * into #eng past a rule for `C0ENG` (review of spec 2, finding 8). A name, `#name` and an id in lower case are refused
 * as the usage error they are, before Slack is asked anything and before any approval is made.
 */
const NOT_IDS = ['eng', '#eng', 'c0eng'];

/** The refusal of a destination that is no conversation id: USAGE, pointing at where the ids are listed. */
function assertNotAnId(error: CommsError, channel: string): void {
  assert.equal(error.code, 'USAGE', `${channel}: ${error.message}`);
  assert.equal(error.details?.reason, 'not-a-conversation', channel);
  assert.equal(error.details?.channel, channel);
  assert.match(error.message, /is not a conversation id/, channel);
  assert.match(error.hint ?? '', /slack_channels/, `${channel}: the hint does not say where the ids are listed`);
}

/** A draft file rewritten by hand, as anything with a shell can. */
async function handEdit(
  w: BehaviourWorld,
  draftId: string,
  edit: (draft: { payload: Record<string, unknown> }) => void,
) {
  const path = join(w.harness.core.paths.stateDir, 'slack', 'drafts', `${draftId}.json`);
  const draft = JSON.parse(await readFile(path, 'utf8')) as { payload: Record<string, unknown> };
  edit(draft);
  await writeFile(path, `${JSON.stringify(draft, null, 2)}\n`);
}

test('a post to a channel by its name, #name or a lower-case id is refused at prepare, before Slack is asked', async (t) => {
  for (const channel of NOT_IDS) {
    const w = await behaviourWorld(t);
    await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
    const error = await refusedWith(
      prepareDraftPost(w.context, 'acme', { channel, text: 'shipping' }, w.slack),
      `a post to ${channel}`,
    );
    assertNotAnId(error, channel);
    assert.equal(await approvalCount(w.harness), 0, `${channel}: an approval was made`);
    assert.deepEqual(
      w.fake.requests.map((request) => request.method),
      [],
      `${channel}: Slack was asked something`,
    );
  }
});

test('a draft cannot be written or moved to a channel by its name', async (t) => {
  const w = await behaviourWorld(t);
  const draft = await createDraft(w.context, 'acme', { channel: ENG, text: 'shipping' });
  for (const channel of NOT_IDS) {
    assertNotAnId(await refusedWith(createDraft(w.context, 'acme', { channel, text: 'shipping' }), channel), channel);
    assertNotAnId(await refusedWith(updateDraft(w.context, 'acme', draft.draftId, { channel }), channel), channel);
  }
  assert.equal(w.fake.requests.length, 0);
});

test('a reaction in a channel by its name, #name or a lower-case id is refused before Slack is asked', async (t) => {
  for (const channel of NOT_IDS) {
    const w = await behaviourWorld(t);
    await setRules(w.harness, [{ conversation: ENG, acts: ['post'] }]);
    const wanted = { channel, ts: MINE, name: 'eyes' };
    assertNotAnId(await refusedWith(react(w.context, 'acme', wanted, undefined, w.slack), channel), channel);
    // The gate's own step refuses it as well, for any caller that reaches it another way.
    const gate = await gateDepsFor(w.context, 'acme', w.slack);
    assertNotAnId(await refusedWith(prepareReaction(gate, wanted), channel), channel);
    assert.equal(await approvalCount(w.harness), 0, `${channel}: an approval was made`);
    assert.deepEqual(
      w.fake.requests.map((request) => request.method),
      [],
      `${channel}: Slack was asked something`,
    );
  }
});

test('a draft file that names a channel by its name is refused at prepare and at send, and nothing posts', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  // A reply in #eng, which the rule allows: prepared, so the send below has an approval to claim.
  const draft = await createDraft(w.context, 'acme', { channel: ENG, text: 'shipping', threadTs: MINE });
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  // The file then names the room by its name, and leaves its thread: a new message at the top of #eng, to Slack.
  await handEdit(w, draft.draftId, (file) => {
    file.payload.channel = 'eng';
    delete file.payload.thread_ts;
  });
  assertNotAnId(
    await refusedWith(prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack), 'prepare'),
    'eng',
  );
  assertNotAnId(
    await refusedWith(
      sendPost(
        w.context,
        'acme',
        { draftId: draft.draftId, approvalId: prepared.approvalId, expectChannel: 'eng' },
        w.slack,
      ),
      'send',
    ),
    'eng',
  );
  assert.equal(w.asked('chat.postMessage'), 0, 'a post went to a channel named by its name');
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('beneath the refusal, a place that is no conversation id is held to every rule of the account', async (t) => {
  // The core's backstop (B4, review of spec 2): were a name ever to reach the rules, no rule could be said not to be for it.
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  const gate = await gateDepsFor(w.context, 'acme', w.slack);
  for (const place of NOT_IDS) {
    const error = await refusedWith(requireAllowed(gate, { acts: ['post'], places: [[place]] }), place);
    assert.equal(error.code, 'ACT_NOT_ALLOWED', place);
    assert.equal(error.details?.act, 'post', place);
  }
  await requireAllowed(gate, { acts: ['reply'], places: [['eng']] });
});

// ── A reply is proven ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * `reply` was decided from a `thread_ts` being there at all, and Slack posts one that names no message in that
 * conversation as a new message at its top (review of spec 2, finding 9): so a reply-only rule let a top-level post
 * through. The thread is read from Slack wherever the rules tell a post from a reply.
 */
const NO_MESSAGE = '1700000000.009999';
const IN_SAM_DM = '1700000000.000300';

test('a reply whose thread is no message in that conversation is checked as the post Slack makes of it', async (t) => {
  for (const [what, threadTs] of [
    ['a ts no message has', NO_MESSAGE],
    ['the ts of a message in another conversation', IN_SAM_DM],
  ] as const) {
    const w = await behaviourWorld(t);
    w.world.messages.push({ channel: SAM_DM, ts: IN_SAM_DM, text: 'hello', user: SAM, via: 'user' });
    await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
    const error = await refusedWith(
      prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'shipping', threadTs }, w.slack),
      what,
    );
    assertActRefused(error, 'post', 'this agent may only reply in #eng (acme)');
    assert.match(
      error.hint ?? '',
      new RegExp(`no message at ${threadTs.replace('.', '\\.')}`),
      `${what}: ${error.hint}`,
    );
    assert.equal(await approvalCount(w.harness), 0, `${what}: an approval was made`);
    nothingWritten(w, what);
    assert.equal(w.asked('conversations.replies'), 1, what);
  }
});

test('a reply under a message in its own conversation is a reply, and posts in that thread', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: MINE }, w.slack);
  assert.equal(prepared.preview.allowedHere, 'Allowed here: reply (rule: acme, #eng)');
  await sendPost(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
    w.slack,
  );
  const posts = w.fake.requests.filter((request) => request.method === 'chat.postMessage');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.params.get('thread_ts'), MINE);
});

test('a thread gone by the send is checked as a post there: refused before the claim, and nothing posts', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: MINE }, w.slack);
  (w.world.messages[0] as { deleted?: boolean }).deleted = true;
  const error = await refusedWith(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
      w.slack,
    ),
    'a reply whose thread is gone',
  );
  assertActRefused(error, 'post', 'this agent may only reply in #eng (acme)');
  assert.equal(w.asked('chat.postMessage'), 0, 'a reply-only rule let a new message through');
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('a thread Slack could not be asked about is taken for neither: TRANSIENT, with nothing made or sent', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: ENG, acts: ['reply'] }]);
  const replies = w.fake.script['conversations.replies'];
  const throttled = () => ({ ok: false, error: 'ratelimited' });

  w.fake.script['conversations.replies'] = throttled;
  const atPrepare = await refusedWith(
    prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: MINE }, w.slack),
    'a prepare whose thread could not be read',
  );
  assert.equal(atPrepare.code, 'TRANSIENT', atPrepare.message);
  assert.equal(atPrepare.retryable, true);
  assert.match(atPrepare.message, /^nothing was sent/);
  assert.equal(await approvalCount(w.harness), 0);

  w.fake.script['conversations.replies'] = replies as NonNullable<typeof replies>;
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: MINE }, w.slack);
  w.fake.script['conversations.replies'] = throttled;
  const atSend = await refusedWith(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
      w.slack,
    ),
    'a send whose thread could not be read',
  );
  assert.equal(atSend.code, 'TRANSIENT', atSend.message);
  assert.equal(w.asked('chat.postMessage'), 0);
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
});

test('where no rule tells a post from a reply, the thread is not read: Slack is asked what it always was', async (t) => {
  for (const rules of [[], [{ conversation: ENG, acts: ['post', 'reply'] }]] as const) {
    const w = await behaviourWorld(t);
    await setRules(w.harness, rules);
    const prepared = await prepareDraftPost(
      w.context,
      'acme',
      { channel: ENG, text: 'on it', threadTs: NO_MESSAGE },
      w.slack,
    );
    await sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
      w.slack,
    );
    assert.equal(w.asked('conversations.replies'), 0, JSON.stringify(rules));
    assert.equal(w.asked('chat.postMessage'), 1);
  }
});

test('a thread that is no message timestamp is refused wherever a post’s thread is given, before Slack is asked', async (t) => {
  const w = await behaviourWorld(t);
  const notTs = (error: CommsError, what: string) => {
    assert.equal(error.code, 'USAGE', `${what}: ${error.message}`);
    assert.equal(error.details?.reason, 'not-a-ts', what);
  };
  notTs(
    await refusedWith(createDraft(w.context, 'acme', { channel: ENG, text: 'x', threadTs: 'yesterday' }), 'create'),
    'create',
  );
  const draft = await createDraft(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: MINE });
  notTs(await refusedWith(updateDraft(w.context, 'acme', draft.draftId, { threadTs: '1.2.3' }), 'update'), 'update');
  notTs(
    await refusedWith(
      prepareDraftPost(w.context, 'acme', { channel: ENG, text: 'on it', threadTs: `${MINE} ` }, w.slack),
      'prepare',
    ),
    'prepare',
  );
  assert.equal(w.fake.requests.length, 0, 'Slack was asked about a thread no ts could name');

  // A draft file whose thread was written by hand is refused where every post is viewed, at prepare and at send.
  const prepared = await prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack);
  await handEdit(w, draft.draftId, (file) => {
    file.payload.thread_ts = 'the standup';
  });
  for (const [what, work] of [
    ['prepare', prepareDraftPost(w.context, 'acme', { draftId: draft.draftId }, w.slack)],
    [
      'send',
      sendPost(
        w.context,
        'acme',
        { draftId: draft.draftId, approvalId: prepared.approvalId, expectChannel: ENG },
        w.slack,
      ),
    ],
  ] as const) {
    const error = await refusedWith(work, what);
    assert.equal(error.code, 'BAD_DATA', `${what}: ${error.message}`);
    assert.equal(error.details?.reason, 'not-a-ts', what);
  }
  assert.equal(w.asked('chat.postMessage'), 0);
  assert.equal(await approvalCount(w.harness), 1, 'only the prepare before the file was changed made an approval');
});

// ── Group DMs ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A person's rule held the DM with them, and not a group DM with them (review of spec 2, finding 14): "with Sam, only
 * react" let a post into a group DM with Sam. Now each member of a group DM is matched with the room itself, and every
 * one of them must allow the act.
 */
test('a person’s rule holds every group DM with them, for every act — and nothing else', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  const acts: [string, (w: BehaviourWorld) => Promise<unknown>][] = [
    ['post', (w) => prepareDraftPost(w.context, 'acme', { channel: GROUP_WITH_SAM, text: 'hello both' }, w.slack)],
    [
      'reply',
      (w) =>
        prepareDraftPost(w.context, 'acme', { channel: GROUP_WITH_SAM, text: 'yes', threadTs: MINE_IN_GROUP }, w.slack),
    ],
    [
      'edit',
      (w) =>
        prepareEdit(w.context, 'acme', { ts: MINE_IN_GROUP, channel: GROUP_WITH_SAM, text: 'lunch at one?' }, w.slack),
    ],
    ['delete', (w) => prepareDelete(w.context, 'acme', { channel: GROUP_WITH_SAM, ts: MINE_IN_GROUP }, w.slack)],
  ];
  for (const [act, prepare] of acts) {
    const error = await refusedWith(prepare(w), `a ${act} in the group DM with Sam`);
    assert.equal(error.code, 'ACT_NOT_ALLOWED', `${act}: ${error.message}`);
    assert.equal(error.details?.act, act);
    assert.equal(error.details?.place, SAM, `${act}: the refusal does not name the rule for the person`);
    assert.match(error.message, /^this agent may only react in /);
  }
  assert.equal(await approvalCount(w.harness), 0);
  nothingWritten(w, 'the group DM with Sam');

  // What his rule allows, it allows there: a reaction is made.
  await react(w.context, 'acme', { channel: GROUP_WITH_SAM, ts: MINE_IN_GROUP, name: 'wave' }, undefined, w.slack);
  assert.equal(w.asked('reactions.add'), 1);
  // A group DM without him, and a private channel he is in, are not held to his rule.
  const without = await prepareDraftPost(w.context, 'acme', { channel: GROUP_WITHOUT_SAM, text: 'hi' }, w.slack);
  assert.equal(without.preview.allowedHere, 'Allowed here: everything (no rule)');
  const room = await prepareDraftPost(w.context, 'acme', { channel: PRIVATE_WITH_SAM, text: 'hi all' }, w.slack);
  assert.equal(room.preview.allowedHere, 'Allowed here: everything (no rule)');
});

test('a group DM whose members could not be read, or a G… room that could not be, is held to every person’s rule', async (t) => {
  const w = await behaviourWorld(t);
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  // Slack does not say who is in the group DM with Ana and Ben: it may be Sam's too.
  w.fake.script['conversations.members'] = () => ({ ok: false, error: 'ratelimited' });
  for (const channel of [GROUP_WITHOUT_SAM, 'G0NOBODY']) {
    const error = await refusedWith(
      prepareDraftPost(w.context, 'acme', { channel, text: 'hi' }, w.slack),
      `a post in ${channel}, its people unread`,
    );
    assert.equal(error.code, 'ACT_NOT_ALLOWED', `${channel}: ${error.message}`);
    assert.equal(error.details?.act, 'post', channel);
  }
  // A reaction is held the same way: under Sam's rule allowing only posts, refused in a room Sam may be in.
  await setRules(w.harness, [{ conversation: SAM, acts: ['post'] }]);
  const gate = await gateDepsFor(w.context, 'acme', w.slack);
  const reaction = await refusedWith(
    prepareReaction(gate, { channel: GROUP_WITHOUT_SAM, ts: MINE_IN_GROUP, name: 'eyes' }),
    'a reaction in a group DM whose people are unread',
  );
  assert.equal(reaction.code, 'ACT_NOT_ALLOWED');
  assert.equal(reaction.details?.act, 'reaction');
  assert.equal(await approvalCount(w.harness), 0);
  nothingWritten(w, 'a room whose people are unread');
});

test('a group DM’s own rule wins over the account’s; a person’s rule there holds, and does not widen it', async (t) => {
  const w = await behaviourWorld(t);
  const post = () => prepareDraftPost(w.context, 'acme', { channel: GROUP_WITH_SAM, text: 'hello both' }, w.slack);
  // The room's own rule, wider than the account's: the person said yes to it, and it holds there.
  await setRules(w.harness, [{ acts: ['reaction'] }, { conversation: GROUP_WITH_SAM, acts: ['post', 'reaction'] }]);
  await post();
  // A person in it whose rule is narrower holds it to that.
  await setRules(w.harness, [
    { acts: ['reaction'] },
    { conversation: GROUP_WITH_SAM, acts: ['post', 'reaction'] },
    { conversation: SAM, acts: ['reaction'] },
  ]);
  assert.equal((await refusedWith(post(), 'Sam’s narrower rule')).details?.place, SAM);
  // And a person's rule wider than the account's widens the DM with them, not a group DM with someone else in it.
  await setRules(w.harness, [{ acts: ['reaction'] }, { conversation: SAM, acts: ['post', 'reaction'] }]);
  await prepareDraftPost(w.context, 'acme', { channel: SAM_DM, text: 'hello Sam' }, w.slack);
  // Ana is in it, and no rule names her: the account's rule holds the room for her.
  const error = await refusedWith(post(), 'Ana, under the account’s rule');
  assert.equal(error.details?.act, 'post');
  assert.equal(error.details?.place, GROUP_WITH_SAM);
  assert.deepEqual(error.details?.rule, { account: 'acme' });
});

test('a group DM post binds what it always did: its members are read only where a person’s rule could hold them', async (t) => {
  const w = await behaviourWorld(t);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: GROUP_WITH_SAM, text: 'hello both' }, w.slack);
  assert.equal(w.asked('conversations.members'), 0, 'members were read where no rule names a person');
  // Tightened after the yes, by Sam's rule: refused at send, before the claim — not voided — and nothing posts.
  await setRules(w.harness, [{ conversation: SAM, acts: ['reaction'] }]);
  const send = () =>
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: GROUP_WITH_SAM },
      w.slack,
    );
  const error = await refusedWith(send(), 'a group DM post after Sam’s rule');
  assert.equal(error.code, 'ACT_NOT_ALLOWED', error.message);
  assert.equal(w.asked('chat.postMessage'), 0);
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'pending');
  // A rule for Sam that allows it: the same approval posts, its digest unchanged by the members read for the rule.
  await setRules(w.harness, [{ conversation: SAM, acts: ['post', 'reaction'] }]);
  await send();
  assert.ok(w.asked('conversations.members') > 0);
  assert.equal(w.asked('chat.postMessage'), 1);
});

test('a group DM reaction’s approval screen says what the rules of the people in it allow, asking Slack nothing', async (t) => {
  const w = await behaviourWorld(t, { sendPolicy: 'confirm' });
  await setRules(w.harness, [
    { conversation: SAM, acts: ['reaction'] },
    { conversation: ANA, acts: ['reaction', 'post'] },
  ]);
  const gate = await gateDepsFor(w.context, 'acme', w.slack);
  const prepared = await prepareReaction(gate, { channel: GROUP_WITH_SAM, ts: MINE_IN_GROUP, name: 'eyes' });
  const line = `Allowed here: reaction (rule: acme, ${SAM})`;
  assert.equal(prepared.allowedHere, line);
  const asked = w.fake.requests.length;
  const prompt = await beginApproval(w.context, prepared.approvalId, w.slack);
  assert.equal(prompt.kind, 'reaction');
  assert.ok(prompt.preview.split('\n').includes(line), prompt.preview);
  assert.equal(w.fake.requests.length, asked, 'the reaction approval screen asked Slack something');
});
