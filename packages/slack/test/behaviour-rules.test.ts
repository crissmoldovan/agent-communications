import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asV2, type CommsError } from '@agentcomms/core';
import { renderDeletionPreview } from '../src/operations/amend.ts';
import { beginApproval } from '../src/operations/approve.ts';
import { renderSlackPreview } from '../src/operations/behaviour.ts';
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
  MINE,
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
  await assert.rejects(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: SAM_DM },
      w.slack,
    ),
  );
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
