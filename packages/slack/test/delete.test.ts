import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALREADY_GONE,
  DELETES_MESSAGE,
  HAS_FILES,
  HAS_REPLIES,
  renderDeletionPreview,
} from '../src/operations/amend.ts';
import { beginApproval, finishApproval } from '../src/operations/approve.ts';
import { prepareDelete, prepareDraftPost, sendDelete, sendEdit, sendPost } from '../src/operations/post.ts';
import {
  type AmendWorld,
  amendWorld,
  audited,
  DROP,
  mine,
  PARENT_TS,
  refusal,
  stateOf,
  TS,
  WORDS,
} from './support/amend.ts';
import {
  assertStartedOnlyThatStep,
  assertStoppedBefore,
  FENCE_CASES,
  fenceWorld,
  suspendAt,
} from './support/fence-sites.ts';

/**
 * Deleting a message this account posted (design 2026-10-06).
 *
 * A deletion cannot be undone, so it is two steps where a reaction is one: the preview shows what is about to
 * disappear, and the approval binds it as it was. What follows is mostly what it refuses — anybody else's message,
 * whatever Slack would allow; a message that changed or gained a reply after the preview; an approval for another act
 * or another message — and what it records of each outcome.
 */

const WHERE = { channel: 'C1', ts: TS };

function prepared(w: AmendWorld, where = WHERE) {
  return prepareDelete(w.context, 'acme', where, w.slack);
}

function send(w: AmendWorld, approvalId: string, where: { channel: string; ts: string } = WHERE, signal?: AbortSignal) {
  return sendDelete(w.context, 'acme', { ...where, approvalId, ...(signal ? { signal } : {}) }, w.slack);
}

// ── Preparing ──────────────────────────────────────────────────────────────────────────────────────────────────

test('preparing a deletion deletes nothing, and shows the message as it is now', async () => {
  const w = await amendWorld();
  const deletion = await prepared(w);

  assert.match(deletion.approvalId, /^ap_/);
  assert.equal(deletion.channel, 'C1');
  assert.equal(deletion.ts, TS);
  assert.equal(deletion.preview.body, WORDS);
  assert.equal(deletion.preview.channel, '#eng');
  assert.equal(deletion.preview.replies, 0);
  assert.deepEqual(deletion.preview.files, []);
  assert.deepEqual(deletion.preview.warnings, [
    'A deletion cannot be undone: the words are gone from Slack for everyone, this account included.',
  ]);
  assert.equal(deletion.preview.policy, 'say yes and the message is deleted');
  assert.deepEqual(deletion.riskFlags, [DELETES_MESSAGE]);
  // A deletion notifies nobody: the workspace's own policy decides, and nothing raises it.
  assert.equal(deletion.requiredPolicy, 'chat');
  assert.equal(deletion.expect.subject, `deletes ${TS}`);
  assert.equal(deletion.approval.state, 'pending');
  assert.deepEqual(w.fake.methods(), ['conversations.history', 'conversations.info']);

  const [record] = await audited(w.harness, 'slack.delete.prepare');
  assert.equal(record?.outcome, 'started');
  assert.deepEqual(record?.ids, { channel: 'C1', ts: TS });

  const shown = renderDeletionPreview(deletion.preview);
  assert.match(shown, /^DELETE PREVIEW · workspace acme · approval ap_\w+ · nothing has been deleted$/m);
  assert.match(shown, /^Deletes: {2}the message at 1700000000\.000100$/m);
  assert.match(shown, /^Body \(4 words, 23 characters\):$/m);
  assert.match(shown, /^── deletes the message at 1700000000\.000100 in #eng$/m);
});

test('the preview says what stays behind: the thread’s replies and the message’s files', async () => {
  const w = await amendWorld({
    message: {
      thread_ts: TS,
      reply_count: 3,
      files: [
        { id: 'F1', name: 'chart.png' },
        { id: 'F2', name: 'notes.txt' },
      ],
    },
  });
  const deletion = await prepared(w);
  assert.equal(deletion.preview.replies, 3);
  assert.equal(deletion.preview.thread, undefined, 'a thread’s parent is not a reply in one');
  assert.deepEqual(deletion.preview.files, ['chart.png', 'notes.txt']);
  assert.deepEqual(deletion.riskFlags, [DELETES_MESSAGE, HAS_REPLIES, HAS_FILES]);
  assert.ok(
    deletion.preview.warnings.includes('It has 3 replies. Only this message is deleted: the thread’s replies are not.'),
  );
  assert.ok(
    deletion.preview.warnings.includes(
      'Only the message is deleted, not chart.png and notes.txt: if they should go too, delete them in Slack.',
    ),
  );
  const shown = renderDeletionPreview(deletion.preview);
  assert.match(shown, /^Replies: {2}3, not deleted with it$/m);
  assert.match(shown, /^File: {5}chart\.png, not deleted with it$/m);
});

test('a reply that lives only in its thread is found by its own ts, and said to be one', async () => {
  const w = await amendWorld();
  w.setMessage(mine({ thread_ts: PARENT_TS }), true);
  const deletion = await prepared(w);
  assert.equal(deletion.preview.thread, `a reply in the thread at ${PARENT_TS}`);
  assert.equal(deletion.preview.body, WORDS);
});

test('somebody else’s message is refused, whatever this account may delete in Slack', async () => {
  // An admin's token can delete anybody's message. An agent acting for one never does (§E2).
  const w = await amendWorld({ message: { user: 'U0002' } });
  const error = await refusal(prepared(w), 'somebody else’s message was offered for deletion');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.message, `nothing was deleted: the message at ${TS} was not written by this account`);
  assert.equal(
    error.hint,
    'Only a message this account posted is deleted from here; anyone else’s stays as they wrote it.',
  );
  assert.deepEqual(w.fake.methods(), ['conversations.history']);
  assert.deepEqual(await audited(w.harness, 'slack.delete.prepare'), []);
});

test('a message that is not there, or a ts, channel or user id that cannot name one, prepares nothing', async () => {
  const gone = await amendWorld();
  gone.setMessage(null);
  assert.equal((await refusal(prepared(gone), 'a missing message')).code, 'NOT_FOUND');

  for (const [what, where, reason] of [
    ['a ts', { channel: 'C1', ts: '17' }, 'not-a-ts'],
    ['a channel', { channel: '#eng', ts: TS }, 'not-a-conversation'],
    ['a user id', { channel: 'W0002', ts: TS }, 'user-id'],
  ] as const) {
    const w = await amendWorld();
    const error = await refusal(prepared(w, where), what);
    assert.equal(error.code, 'USAGE', what);
    assert.equal(error.details?.reason, reason, what);
    assert.deepEqual(w.fake.methods(), [], `${what}: Slack was asked`);
  }
});

test('a workspace connected to read cannot prepare a deletion, nor one under never', async () => {
  const read = await amendWorld({ mode: 'read' });
  const refusedRead = await refusal(prepared(read), 'a read workspace prepared a deletion');
  assert.equal(refusedRead.code, 'SCOPE_MISSING');
  assert.match(refusedRead.message, /is connected to read, and cannot delete a message/);

  const never = await amendWorld({ policy: 'never' });
  const refusedNever = await refusal(prepared(never), 'a deletion under never');
  assert.equal(refusedNever.code, 'POLICY_NEVER');
  assert.equal(refusedNever.message, 'posting, editing and deleting are turned off for this workspace (policy: never)');
  assert.deepEqual(never.fake.methods(), []);
});

// ── Deleting ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a deletion asks Slack to delete exactly that message, once, and is used by its ts', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  const deleted = await send(w, approvalId);
  assert.equal(deleted.approvalId, approvalId);
  assert.equal(deleted.channel, 'C1');
  assert.equal(deleted.ts, TS);
  assert.equal(deleted.note, undefined);
  assert.equal(deleted.approval.state, 'used');
  assert.equal(deleted.approval.sentMessageId, TS);

  const call = w.fake.asked.filter((one) => one.method === 'chat.delete');
  assert.equal(call.length, 1);
  assert.deepEqual(Object.fromEntries(call[0]?.params ?? []), { channel: 'C1', ts: TS });

  const again = await refusal(send(w, approvalId), 'a spent deletion used again');
  assert.equal(again.code, 'APPROVAL_VOID');
  assert.equal(w.fake.count('chat.delete'), 1);
  const [record] = await audited(w.harness, 'slack.delete');
  assert.equal(record?.outcome, 'ok');
  assert.deepEqual(record?.ids, { channel: 'C1', ts: TS });
});

test('message_not_found is the state a deletion asked for: used, and the result says nothing was left to delete', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  w.fake.script['chat.delete'] = () => ({ ok: false, error: 'message_not_found' });
  const deleted = await send(w, approvalId);
  assert.equal(deleted.note, ALREADY_GONE);
  assert.equal(deleted.approval.state, 'used');
  const [record] = await audited(w.harness, 'slack.delete');
  assert.equal(record?.outcome, 'ok');
  assert.equal(record?.reason, ALREADY_GONE);
});

test('a message edited in Slack, or a thread that gained a reply, after the preview voids the deletion', async () => {
  for (const [what, changed] of [
    ['edited', mine({ text: 'shipping tomorrow', edited: { user: 'U0001', ts: '1700000500.000000' } })],
    ['a reply', mine({ thread_ts: TS, reply_count: 1 })],
  ] as const) {
    const w = await amendWorld();
    const { approvalId } = await prepared(w);
    w.setMessage(changed);
    const error = await refusal(send(w, approvalId), what);
    assert.equal(error.code, 'APPROVAL_VOID', what);
    assert.equal(await stateOf(w.harness, approvalId), 'revoked', what);
    assert.equal(w.fake.count('chat.delete'), 0, what);
  }
});

/** Changes what Slack holds at the message the moment the approval is claimed: the gap the last look closes. */
function changeOnClaim(w: AmendWorld, next: Record<string, unknown> | null): void {
  const store = w.harness.core.approvals;
  const claim = store.claimForSend.bind(store);
  store.claimForSend = async (...args: Parameters<typeof claim>) => {
    const claimed = await claim(...args);
    w.setMessage(next);
    return claimed;
  };
}

test('a message edited in Slack after the claim, just before the deletion, is not deleted', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  changeOnClaim(w, mine({ text: 'changed in Slack meanwhile', edited: { user: 'U0001', ts: '1700000200.000000' } }));
  const error = await refusal(send(w, approvalId), 'a deletion of a message changed after its claim');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(error.message, 'nothing was deleted: the message changed in Slack after the preview');
  assert.equal(w.fake.count('chat.delete'), 0);
  assert.equal(await stateOf(w.harness, approvalId), 'failed');
});

test('a message already gone at the last look is the deletion asked for: used, and nothing is asked of chat.delete', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  changeOnClaim(w, null);
  const deleted = await send(w, approvalId);
  assert.equal(deleted.note, ALREADY_GONE);
  assert.equal(deleted.approval.state, 'used');
  assert.equal(w.fake.count('chat.delete'), 0);
});

test('a channel archived or gone after the claim is not taken for a deleted message: refused, never a false success', async () => {
  for (const slackError of ['is_archived', 'channel_not_found']) {
    const w = await amendWorld();
    const { approvalId } = await prepared(w);
    const store = w.harness.core.approvals;
    const claim = store.claimForSend.bind(store);
    store.claimForSend = async (...args: Parameters<typeof claim>) => {
      const claimed = await claim(...args);
      w.fake.script['conversations.history'] = () => ({ ok: false, error: slackError });
      return claimed;
    };
    const error = await refusal(send(w, approvalId), `${slackError} at the last look`);
    assert.equal(error.code, 'NOT_FOUND', slackError);
    assert.match(
      error.message,
      /^nothing was deleted: the message could not be read again just before it was to be deleted — /,
      slackError,
    );
    assert.equal(error.details?.reason, 'last-look-failed', slackError);
    assert.equal(error.details?.slackError, slackError, slackError);
    assert.equal(w.fake.count('chat.delete'), 0, slackError);
    assert.equal(await stateOf(w.harness, approvalId), 'failed', `${slackError}: recorded as a success`);
    const [record] = await audited(w.harness, 'slack.delete');
    assert.equal(record?.outcome, 'failed', slackError);
  }
});

test('delete send refuses a message that is not the approval’s, and spends nothing', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  const other = await refusal(send(w, approvalId, { channel: 'C1', ts: '1700000000.000200' }), 'another message');
  assert.equal(other.code, 'APPROVAL_VOID');
  assert.equal(
    other.message,
    `nothing was deleted: this approval deletes the message at ${TS} in C1, not 1700000000.000200 in C1`,
  );
  assert.equal(w.fake.count('chat.delete'), 0);
  assert.equal(await stateOf(w.harness, approvalId), 'pending');
  assert.equal((await send(w, approvalId)).approval.state, 'used');
});

test('a deletion’s approval cannot post or edit, and a post’s cannot delete', async () => {
  const w = await amendWorld();
  w.fake.script['chat.postMessage'] = () => ({ ok: true, ts: '1700000000.000900' });
  const post = await prepareDraftPost(w.context, 'acme', { channel: 'C1', text: 'the report' }, w.slack);

  // Claimed as a post, it is claimed against a post's content, which it does not bind: void, as any approval is.
  const asPost = await prepared(w);
  const posted = await refusal(
    sendPost(w.context, 'acme', { draftId: post.draftId, approvalId: asPost.approvalId, expectChannel: 'C1' }, w.slack),
    'a deletion’s approval posted',
  );
  assert.equal(posted.code, 'APPROVAL_VOID');
  assert.equal(await stateOf(w.harness, asPost.approvalId), 'revoked');

  // An edit and a deletion look at the approval first, and refuse another act's before claiming anything.
  const asEdit = await prepared(w);
  const edited = await refusal(
    sendEdit(
      w.context,
      'acme',
      { draftId: post.draftId, approvalId: asEdit.approvalId, expectChannel: 'C1', ts: TS },
      w.slack,
    ),
    'a deletion’s approval edited',
  );
  assert.equal(edited.message, 'nothing was changed: this approval is not for an edit');
  assert.equal(await stateOf(w.harness, asEdit.approvalId), 'pending');
  const deleted = await refusal(send(w, post.approvalId), 'a post’s approval deleted');
  assert.equal(deleted.message, 'nothing was deleted: this approval is not for a deletion');
  assert.equal(await stateOf(w.harness, post.approvalId), 'pending');

  assert.equal(w.fake.count('chat.postMessage'), 0);
  assert.equal(w.fake.count('chat.update'), 0);
  assert.equal(w.fake.count('chat.delete'), 0);
});

test('a call cancelled before the claim deletes nothing, and leaves the approval to be used', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  const controller = new AbortController();
  controller.abort();
  const error = await refusal(send(w, approvalId, WHERE, controller.signal), 'a cancelled deletion');
  assert.equal(error.message, 'cancelled: nothing was deleted');
  assert.equal(error.hint, 'The approval was not used: it can still make this deletion until it expires.');
  assert.equal(w.fake.count('chat.delete'), 0);
  assert.equal(await stateOf(w.harness, approvalId), 'pending');
});

test('what Slack answered decides a deletion’s record: a refusal is failed, anything that may have acted is not', async () => {
  const cases: { what: string; answer: unknown; state: 'failed' | 'sending' }[] = [
    { what: 'cant_delete_message', answer: { ok: false, error: 'cant_delete_message' }, state: 'failed' },
    { what: 'channel_not_found', answer: { ok: false, error: 'channel_not_found' }, state: 'failed' },
    { what: 'internal_error', answer: { ok: false, error: 'internal_error' }, state: 'sending' },
    { what: 'an error Slack never documented', answer: { ok: false, error: 'something_new' }, state: 'sending' },
    { what: 'a dropped connection', answer: DROP, state: 'sending' },
  ];
  for (const { what, answer, state } of cases) {
    const w = await amendWorld();
    const { approvalId } = await prepared(w);
    w.fake.script['chat.delete'] = () => answer;
    const error = await refusal(send(w, approvalId), what);
    assert.equal(await stateOf(w.harness, approvalId), state, what);
    if (state === 'sending') {
      assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN', what);
      assert.match(error.message, /^whether the message was deleted is not known: /, what);
      assert.match(error.hint ?? '', /Look for the message before anything else: Slack may have deleted it/, what);
    } else {
      assert.notEqual(error.code, 'SEND_OUTCOME_UNKNOWN', what);
      assert.equal((error.details?.approval as { state?: string } | undefined)?.state, 'failed', what);
    }
  }
});

test('Slack refusing a deletion says what to do', async () => {
  const w = await amendWorld();
  const { approvalId } = await prepared(w);
  w.fake.script['chat.delete'] = () => ({ ok: false, error: 'cant_delete_message' });
  const error = await refusal(send(w, approvalId), 'a deletion Slack refused');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.message, 'Slack does not let this account delete that message');
  assert.match(error.hint ?? '', /A workspace can keep people from deleting their own messages/);
});

// ── At a terminal ─────────────────────────────────────────────────────────────────────────────────────────────

test('under confirm, a person approves the deletion they were shown, and only then is it made', async () => {
  const w = await amendWorld({ policy: 'confirm', message: { reply_count: 2, thread_ts: TS } });
  const { approvalId } = await prepared(w);
  const held = await refusal(send(w, approvalId), 'a deletion under confirm before anyone approved it');
  assert.equal(held.code, 'APPROVAL_PENDING');
  assert.match(held.hint ?? '', /slack_delete_send/);
  assert.equal(w.fake.count('chat.delete'), 0);

  const prompt = await beginApproval(w.context, approvalId, w.slack);
  assert.equal(prompt.kind, 'delete');
  assert.match(
    prompt.preview,
    /^DELETE PREVIEW · workspace acme · approval ap_\w+ · nothing has been deleted — approving does not delete it$/m,
  );
  assert.match(prompt.preview, /^Replies: {2}2, not deleted with it$/m);
  assert.match(prompt.preview, new RegExp(WORDS));
  await finishApproval(w.context, approvalId, prompt.challenge, w.slack);
  assert.equal(w.fake.count('chat.delete'), 0, 'approving does not delete');

  assert.equal((await send(w, approvalId)).approval.state, 'used');
  assert.equal(w.fake.count('chat.delete'), 1);
});

test('a deletion whose message changed before the code was typed is never approved', async () => {
  const w = await amendWorld({ policy: 'confirm' });
  const { approvalId } = await prepared(w);
  const prompt = await beginApproval(w.context, approvalId, w.slack);
  w.setMessage(mine({ text: 'something else entirely' }));
  const error = await refusal(
    finishApproval(w.context, approvalId, prompt.challenge, w.slack),
    'a changed message approved for deletion',
  );
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(error.message, 'nothing was approved: the message, or its thread, is not what the preview showed');
  assert.equal(await stateOf(w.harness, approvalId), 'revoked');
});

// ── The fence before the step ────────────────────────────────────────────────────────────────────────────────

for (const c of FENCE_CASES.filter((one) => one.flow === 'delete')) {
  test(`a claimant whose lease ran out just before ${c.label} starts nothing, and says so`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'before');
    await assertStoppedBefore(w, c, await w.run(c.flow), log);
  });

  test(`a deletion's claimant suspended right after its fence said go still makes ${c.label.replace(/^site \d+, /, 'its ')}`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'after');
    await assertStartedOnlyThatStep(w, c, await w.run(c.flow), log);
  });
}
