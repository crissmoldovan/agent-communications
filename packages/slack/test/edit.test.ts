import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalStore, asV2, CommsError, renderChannelPreview, SENDING_LEASE_MS } from '@agentcomms/core';
import { certainlyRefused } from '../src/api/call.ts';
import { EDITS_MESSAGE } from '../src/operations/amend.ts';
import { beginApproval, finishApproval } from '../src/operations/approve.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { prepareDraftPost, prepareEdit, sendEdit, sendPost } from '../src/operations/post.ts';
import { LINK_MAY_UNFURL } from '../src/operations/send.ts';
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
 * Editing a message this account posted (design 2026-10-06).
 *
 * The post's gate for one more act, so most of what follows is what it refuses — somebody else's message, a message
 * that changed after the preview, an approval for another act or another message — and what it records of each
 * outcome, by the post's rules. Every test reaches Slack through a script; none reaches the real one.
 */

const FIXED = 'shipping in ten minutes';

/** An edit of the message at {@link TS} to {@link FIXED}, prepared from new words. */
async function preparedEdit(w: AmendWorld, extra: Record<string, unknown> = {}) {
  return prepareEdit(w.context, 'acme', { ts: TS, channel: 'C1', text: FIXED, ...extra }, w.slack);
}

function send(w: AmendWorld, prepared: { draftId: string; approvalId: string }, over: Record<string, unknown> = {}) {
  return sendEdit(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts: TS, ...over },
    w.slack,
  );
}

// ── Preparing ──────────────────────────────────────────────────────────────────────────────────────────────────

test('preparing an edit changes nothing, and shows the words the message has now beside the words it will have', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);

  assert.match(prepared.approvalId, /^ap_/);
  assert.equal(prepared.channel, 'C1');
  assert.equal(prepared.ts, TS);
  assert.deepEqual(prepared.preview.replaces, { ts: TS, body: WORDS });
  assert.equal(prepared.preview.body, FIXED);
  assert.equal(prepared.preview.channel, '#eng');
  assert.match(prepared.preview.context?.note ?? '', /nothing has been changed/);
  assert.equal(prepared.preview.policy, 'say yes and the message is changed');
  assert.ok(
    prepared.preview.warnings?.includes(
      'Everyone who can read the channel sees the new words in place of the old: nobody who read the old words is told what changed.',
    ),
    JSON.stringify(prepared.preview.warnings),
  );
  assert.deepEqual(prepared.riskFlags, [EDITS_MESSAGE]);
  assert.equal(prepared.requiredPolicy, 'chat');
  assert.equal(prepared.expect.subject, `edits ${TS}, reaches 0`);
  assert.equal(prepared.approval.state, 'pending');
  // Read only: the message, then the room. No permit was opened, and nothing was asked to change.
  assert.deepEqual(w.fake.methods(), ['conversations.history', 'conversations.info']);

  const [record] = await audited(w.harness, 'slack.edit.prepare');
  assert.equal(record?.outcome, 'started');
  assert.deepEqual(record?.ids, { channel: 'C1', ts: TS, draftId: prepared.draftId });

  // The terminal sees it as an edit, with both bodies fenced and counted.
  const shown = renderChannelPreview(prepared.preview);
  assert.match(shown, /^EDIT PREVIEW · workspace acme/m);
  assert.match(shown, /Now \(4 words, 23 characters\)/);
  assert.match(shown, /After the edit \(4 words, 23 characters\)/);
});

test('an edit sends its words alone, under parse none — no blocks, no link_names, no files — and is used once', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w, { text: 'a < b & c' });
  const edited = await send(w, prepared);

  assert.equal(edited.approvalId, prepared.approvalId);
  assert.equal(edited.channel, 'C1');
  assert.equal(edited.ts, TS);
  assert.equal(edited.note, undefined);
  assert.equal(edited.approval.state, 'used');
  assert.equal(edited.approval.sentMessageId, TS);

  const update = w.fake.asked.filter((one) => one.method === 'chat.update');
  assert.equal(update.length, 1);
  // Exactly these: the composer's escaping, and the parse rule a post goes out under (§E5).
  assert.deepEqual(Object.fromEntries(update[0]?.params ?? []), {
    channel: 'C1',
    ts: TS,
    text: 'a &lt; b &amp; c',
    parse: 'none',
  });

  const again = await refusal(send(w, prepared), 'a spent approval edited again');
  assert.equal(again.code, 'APPROVAL_VOID');
  assert.match(again.message, /the approval was used already/);
  assert.equal(w.fake.count('chat.update'), 1, 'an approval is spent by the edit it permits');

  const [record] = await audited(w.harness, 'slack.edit');
  assert.equal(record?.outcome, 'ok');
  assert.equal(record?.surface, 'mcp');
  assert.deepEqual(record?.ids, { channel: 'C1', ts: TS, draftId: prepared.draftId });
});

test('a message somebody else wrote is refused before its room is read, and no approval is made', async () => {
  const w = await amendWorld({ message: { user: 'U0002' } });
  const error = await refusal(preparedEdit(w), 'somebody else’s message was offered for an edit');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.message, `nothing was changed: the message at ${TS} was not written by this account`);
  assert.equal(error.details?.reason, 'not-own-message');
  assert.deepEqual(w.fake.methods(), ['conversations.history'], 'nothing else was read, and nothing changed');
  assert.deepEqual(await audited(w.harness, 'slack.edit.prepare'), [], 'no approval was prepared');
});

test('a message with no author named is nobody’s to edit', async () => {
  const w = await amendWorld({ message: { user: undefined, bot_id: 'B1' } });
  const error = await refusal(preparedEdit(w), 'a message with no user was offered for an edit');
  assert.equal(error.details?.reason, 'not-own-message');
});

test('a reply that lives only in its thread is found by its own ts, and the preview says where it is', async () => {
  const w = await amendWorld();
  w.setMessage(mine({ thread_ts: PARENT_TS }), true);
  const prepared = await preparedEdit(w);
  assert.equal(prepared.preview.thread, `a reply in the thread at ${PARENT_TS}`);
  assert.equal(prepared.preview.replaces?.body, WORDS, 'the reply, not its parent, is the message shown');
  assert.deepEqual(w.fake.methods(), ['conversations.history', 'conversations.replies', 'conversations.info']);
  const replies = w.fake.asked.find((one) => one.method === 'conversations.replies');
  assert.equal(replies?.params.get('ts'), TS);
});

test('a message that is not there is NOT_FOUND, and nothing is prepared on a guess', async () => {
  const w = await amendWorld();
  w.setMessage(null);
  const error = await refusal(preparedEdit(w), 'a missing message was offered for an edit');
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, `no message at ${TS} in C1 that this account can read`);
  assert.equal(error.details?.reason, 'no-message');
});

test('a ts, a channel or a user id that cannot name a message is refused before Slack is asked', async () => {
  for (const [what, request, reason] of [
    ['a ts', { ts: 'yesterday', channel: 'C1', text: FIXED }, 'not-a-ts'],
    ['a channel', { ts: TS, channel: 'general', text: FIXED }, 'not-a-conversation'],
    ['a user id', { ts: TS, channel: 'U0002', text: FIXED }, 'user-id'],
  ] as const) {
    const w = await amendWorld();
    const error = await refusal(prepareEdit(w.context, 'acme', request, w.slack), what);
    assert.equal(error.code, 'USAGE', what);
    assert.equal(error.details?.reason, reason, what);
    assert.deepEqual(w.fake.methods(), [], `${what}: Slack was asked`);
  }
});

test('a draft and new words together, or neither, is refused rather than guessed at', async () => {
  const w = await amendWorld();
  const both = await refusal(
    prepareEdit(w.context, 'acme', { ts: TS, draftId: 'dft_AAAAAAAAAAAAAAAAAAAAAA', text: FIXED }, w.slack),
    'both',
  );
  assert.equal(both.code, 'USAGE');
  assert.match(both.message, /not both/);
  const neither = await refusal(prepareEdit(w.context, 'acme', { ts: TS }, w.slack), 'neither');
  assert.equal(neither.code, 'USAGE');
  assert.match(neither.message, /nothing to prepare/);
});

test('a draft written as a reply in a thread is not an edit: an edit leaves a message where it is', async () => {
  const w = await amendWorld();
  const threaded = await createDraft(w.context, 'acme', { channel: 'C1', text: FIXED, threadTs: PARENT_TS });
  const inThread = await refusal(
    prepareEdit(w.context, 'acme', { ts: TS, draftId: threaded.draftId }, w.slack),
    'a threaded draft',
  );
  assert.equal(inThread.code, 'USAGE');
  assert.equal(inThread.details?.reason, 'edit-in-thread');
  assert.equal(w.fake.count('chat.update'), 0);
});

test('a workspace connected to read, or never granted chat:write, cannot prepare an edit', async () => {
  const read = await amendWorld({ mode: 'read' });
  const refusedRead = await refusal(preparedEdit(read), 'a read workspace prepared an edit');
  assert.equal(refusedRead.code, 'SCOPE_MISSING');
  assert.match(refusedRead.message, /is connected to read, and cannot edit a message/);
  assert.equal(read.fake.count('conversations.history'), 0, 'nobody is shown a preview of an edit that cannot be made');

  const ungranted = await amendWorld({ grantedScopes: ['channels:history', 'channels:read'] });
  const refusedScope = await refusal(preparedEdit(ungranted), 'a workspace without chat:write prepared an edit');
  assert.equal(refusedScope.code, 'SCOPE_MISSING');
  assert.match(refusedScope.message, /was not granted chat:write, which editing a message needs/);
});

test('under never, an edit is refused before anything is read', async () => {
  const w = await amendWorld({ policy: 'never' });
  const error = await refusal(preparedEdit(w), 'an edit was prepared under never');
  assert.equal(error.code, 'POLICY_NEVER');
  assert.deepEqual(w.fake.methods(), []);
});

test('an @channel in an edit needs a person at a terminal, and the preview says the count may be high', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w, { broadcast: 'channel' });
  assert.equal(prepared.requiredPolicy, 'confirm');
  assert.ok(prepared.riskFlags.includes('notifies-channel'), prepared.riskFlags.join(', '));
  assert.equal(prepared.expect.subject, `edits ${TS}, reaches 4`);
  assert.ok(
    prepared.preview.warnings?.includes(
      'Whether Slack notifies anyone mentioned only in an edit is not documented: the reach above counts them as if it does.',
    ),
  );
});

test('a link in an edit is flagged as one Slack may unfurl, bare or not, since an edit cannot turn that off', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w, { text: 'the notes are at https://example.test/notes.' });
  assert.ok(prepared.riskFlags.includes(LINK_MAY_UNFURL), prepared.riskFlags.join(', '));
  assert.ok(prepared.riskFlags.includes('contains-link'));
  assert.deepEqual(prepared.preview.links, ['https://example.test/notes']);
  assert.ok(
    prepared.preview.warnings?.some((warning) => /an edit offers no way to turn that off/.test(warning)),
    JSON.stringify(prepared.preview.warnings),
  );
});

test('a message with files is told that the edit changes only its words', async () => {
  const w = await amendWorld({ message: { files: [{ id: 'F1', name: 'chart.png' }] } });
  const prepared = await preparedEdit(w);
  assert.ok(
    prepared.preview.warnings?.includes('This changes only the words: chart.png is not part of the edit.'),
    JSON.stringify(prepared.preview.warnings),
  );
});

// ── Refusals at send ──────────────────────────────────────────────────────────────────────────────────────────

test('a message changed in Slack after the preview is not the edit approved, and nothing is changed', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  w.setMessage(mine({ text: 'shipping in five minutes', edited: { user: 'U0001', ts: '1700000100.000000' } }));
  const error = await refusal(send(w, prepared), 'an edit of a message that changed since its preview');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /changed after the preview/);
  // Void for good, not merely refused: it binds a message that no longer exists in that form.
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'revoked');
  assert.equal(w.fake.count('chat.update'), 0);
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

test('a message edited in Slack after the claim, just before the edit, is never overwritten by it', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  changeOnClaim(w, mine({ text: 'changed in Slack meanwhile', edited: { user: 'U0001', ts: '1700000200.000000' } }));
  const error = await refusal(send(w, prepared), 'an edit over a message changed after its claim');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(error.message, 'nothing was changed: the message changed in Slack after the preview');
  assert.equal(error.details?.reason, 'message-changed');
  assert.equal(w.fake.count('chat.update'), 0);
  // Read twice at send: before the claim, and the last look after it.
  assert.equal(w.fake.count('conversations.history'), 3);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'failed');
  const [record] = await audited(w.harness, 'slack.edit');
  assert.equal(record?.outcome, 'failed');
});

test('a message deleted after the claim is not edited: there is nothing left to edit', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  changeOnClaim(w, null);
  const error = await refusal(send(w, prepared), 'an edit of a message deleted after its claim');
  assert.equal(error.code, 'NOT_FOUND');
  assert.equal(error.message, 'nothing was changed: the message is no longer there');
  assert.equal(w.fake.count('chat.update'), 0);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'failed');
});

test('edit send refuses a channel or a ts that is not the approval’s, and spends nothing', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  const otherTs = await refusal(send(w, prepared, { ts: '1700000000.000200' }), 'another ts');
  assert.equal(otherTs.code, 'APPROVAL_VOID');
  assert.equal(
    otherTs.message,
    `nothing was changed: this approval edits the message at ${TS} in C1, not 1700000000.000200 in C1`,
  );
  const otherChannel = await refusal(send(w, prepared, { expectChannel: 'C2' }), 'another channel');
  assert.equal(otherChannel.message, 'nothing was changed: this draft is for C1, not C2');
  assert.equal(w.fake.count('chat.update'), 0);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'pending', 'a refusal before the claim spends nothing');
  // And the approval still makes the edit it was prepared for.
  assert.equal((await send(w, prepared)).approval.state, 'used');
});

test('a post’s approval cannot edit, and an edit’s cannot post', async () => {
  const w = await amendWorld();
  w.fake.script['chat.postMessage'] = () => ({ ok: true, ts: '1700000000.000900' });
  const post = await prepareDraftPost(w.context, 'acme', { channel: 'C1', text: FIXED }, w.slack);
  const edit = await refusal(
    sendEdit(
      w.context,
      'acme',
      { draftId: post.draftId, approvalId: post.approvalId, expectChannel: 'C1', ts: TS },
      w.slack,
    ),
    'a post’s approval edited a message',
  );
  assert.equal(edit.code, 'APPROVAL_VOID');
  assert.equal(edit.message, 'nothing was changed: this approval is not for an edit');

  const prepared = await preparedEdit(w);
  await refusal(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1' },
      w.slack,
    ),
    'an edit’s approval posted a new message',
  );
  assert.equal(w.fake.count('chat.postMessage'), 0);
  assert.equal(w.fake.count('chat.update'), 0);
});

test('a draft edited after the edit was prepared voids its approval', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  const { updateDraft } = await import('../src/operations/drafts.ts');
  await updateDraft(w.context, 'acme', prepared.draftId, { text: 'shipping in an hour' });
  const error = await refusal(send(w, prepared), 'an edit whose draft changed since its preview');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(w.fake.count('chat.update'), 0);
});

test('a call cancelled before the claim changes nothing, and leaves the approval to be used', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  const controller = new AbortController();
  controller.abort();
  const error = await refusal(send(w, prepared, { signal: controller.signal }), 'a cancelled edit');
  assert.equal(error.code, 'USAGE');
  assert.equal(error.message, 'cancelled: nothing was changed');
  assert.equal(error.hint, 'The approval was not used: it can still make this edit until it expires.');
  assert.equal(error.details?.reason, 'cancelled');
  assert.equal(w.fake.count('chat.update'), 0);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'pending');
});

// ── What each outcome is recorded as ──────────────────────────────────────────────────────────────────────────

/** Slack's refusal as `callSlack` presents it to the classifier. */
function refused(name: string): CommsError {
  return new CommsError('PROVIDER_UNAVAILABLE', `Slack refused the request: ${name}`, {
    details: { slackError: name },
  });
}

test('the documented refusals of chat.update and chat.delete are certain, and Slack state or partial failures are not', () => {
  const update = [
    'access_denied',
    'accesslimited',
    'account_inactive',
    'blocked_file_type',
    'cant_update_message',
    'channel_not_found',
    'deprecated_endpoint',
    'edit_window_closed',
    'ekm_access_denied',
    'enterprise_is_restricted',
    'file_deleted',
    'file_is_deleted',
    'file_not_found',
    'file_share_limit_reached',
    'invalid_arg_name',
    'invalid_arguments',
    'invalid_array_arg',
    'invalid_auth',
    'invalid_channel_id',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'is_inactive',
    'max_file_sharing_exceeded',
    'message_limit_exceeded',
    'message_not_found',
    'method_deprecated',
    'missing_post_type',
    'missing_scope',
    'msg_too_long',
    'no_permission',
    'no_text',
    'not_allowed_token_type',
    'not_authed',
    'posting_to_channel_denied',
    'ratelimited',
    'slack_connect_blocked_file_type',
    'slack_connect_canvas_sharing_blocked',
    'slack_connect_clip_sharing_blocked',
    'slack_connect_file_link_sharing_blocked',
    'slack_connect_file_upload_sharing_blocked',
    'streaming_state_conflict',
    'team_access_not_granted',
    'team_not_found',
    'token_expired',
    'token_revoked',
    'two_factor_setup_required',
  ];
  const remove = [
    'access_denied',
    'accesslimited',
    'account_inactive',
    'cant_delete_message',
    'channel_not_found',
    'deprecated_endpoint',
    'ekm_access_denied',
    'enterprise_is_restricted',
    'invalid_arg_name',
    'invalid_arguments',
    'invalid_array_arg',
    'invalid_auth',
    'invalid_channel_id',
    'invalid_charset',
    'invalid_form_data',
    'invalid_post_type',
    'method_deprecated',
    'missing_post_type',
    'missing_scope',
    'no_permission',
    'not_allowed_token_type',
    'not_authed',
    'ratelimited',
    'team_access_not_granted',
    'token_expired',
    'token_revoked',
    'two_factor_setup_required',
  ];
  // Slack's own maybe, its state, failures during the work, and what an edit never sends.
  const uncertain = [
    'external_channel_migrating',
    'fatal_error',
    'internal_error',
    'org_login_required',
    'request_timeout',
    'service_unavailable',
    'team_added_to_org',
    'update_failed',
    'unable_to_share_files',
    'something_new_went_wrong',
  ];
  for (const name of update) assert.equal(certainlyRefused(refused(name), 'chat.update'), true, `chat.update: ${name}`);
  for (const name of remove) assert.equal(certainlyRefused(refused(name), 'chat.delete'), true, `chat.delete: ${name}`);
  for (const method of ['chat.update', 'chat.delete'] as const) {
    for (const name of uncertain) assert.equal(certainlyRefused(refused(name), method), false, `${method}: ${name}`);
  }
  // Not a refusal of a deletion: the message is gone, which is what it asked for (§E8).
  assert.equal(certainlyRefused(refused('message_not_found'), 'chat.delete'), false);
});

test('what Slack answered decides an edit’s record: a refusal is failed, anything that may have acted is not', async () => {
  const cases: { what: string; answer: unknown; state: 'failed' | 'sending'; code?: string }[] = [
    {
      what: 'cant_update_message',
      answer: { ok: false, error: 'cant_update_message' },
      state: 'failed',
      code: 'SCOPE_MISSING',
    },
    {
      what: 'edit_window_closed',
      answer: { ok: false, error: 'edit_window_closed' },
      state: 'failed',
      code: 'SCOPE_MISSING',
    },
    {
      what: 'message_not_found',
      answer: { ok: false, error: 'message_not_found' },
      state: 'failed',
      code: 'NOT_FOUND',
    },
    { what: 'internal_error', answer: { ok: false, error: 'internal_error' }, state: 'sending' },
    { what: 'update_failed', answer: { ok: false, error: 'update_failed' }, state: 'sending' },
    { what: 'a dropped connection', answer: DROP, state: 'sending' },
  ];
  for (const { what, answer, state, code } of cases) {
    const w = await amendWorld();
    const prepared = await preparedEdit(w);
    w.fake.script['chat.update'] = () => answer;
    const error = await refusal(send(w, prepared), what);
    assert.equal(await stateOf(w.harness, prepared.approvalId), state, what);
    const [record] = await audited(w.harness, 'slack.edit');
    assert.equal(record?.outcome, 'failed', what);
    if (state === 'sending') {
      assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN', what);
      assert.equal(error.retryable, false, what);
      assert.match(error.message, /^whether the message was changed is not known: /, what);
      assert.match(error.hint ?? '', /Look at the message before anything else/, what);
      assert.match(record?.reason ?? '', /^outcome unknown: /, what);
    } else {
      assert.equal(error.code, code, what);
      assert.equal((error.details?.approval as { state?: string } | undefined)?.state, 'failed', what);
      assert.doesNotMatch(record?.reason ?? '', /unknown/, what);
    }
  }
});

test('the words Slack gives an edit refusal say what to do', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  w.fake.script['chat.update'] = () => ({ ok: false, error: 'edit_window_closed' });
  const error = await refusal(send(w, prepared), 'an edit after the window closed');
  assert.equal(error.message, 'this workspace no longer lets that message be edited');
  assert.equal(error.hint, 'Its message-editing setting has closed the window for it. Post a correction instead.');
});

test('an edit Slack accepted without a ts is said to be one, and never recorded used by an empty id', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  w.fake.script['chat.update'] = () => ({ ok: true, channel: 'C1' });
  const edited = await send(w, prepared);
  assert.equal(edited.note, 'sent; the provider returned no id');
  assert.equal(edited.approval.state, 'sending');
  const later = new ApprovalStore(w.harness.core.paths.stateDir, {
    now: () => new Date(Date.now() + SENDING_LEASE_MS),
    loadConfig: () => w.harness.core.config.load(),
  });
  assert.equal(asV2(await later.get(prepared.approvalId))?.state, 'unknown');
  const [record] = await audited(w.harness, 'slack.edit');
  assert.equal(record?.outcome, 'ok');
  assert.match(record?.reason ?? '', /^accepted without an id/);
});

test('an edit Slack accepted whose bookkeeping fails is never failed, and the result says what was not recorded', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  const store = w.harness.core.approvals;
  const complete = store.complete.bind(store);
  store.complete = async (approvalId, claimToken, outcome) => {
    if ('sentMessageId' in outcome) throw new CommsError('LOCK_TIMEOUT', 'another process is holding the approval');
    return complete(approvalId, claimToken, outcome);
  };
  const audit = w.harness.core.audit;
  const append = audit.append.bind(audit);
  audit.append = async (record, ...rest) => {
    if (record.operation === 'slack.edit') throw new Error('EROFS: read-only file system');
    return append(record, ...rest);
  };

  const edited = await send(w, prepared);
  assert.match(edited.note ?? '', /the approval could not be marked used \(another process is holding the approval\)/);
  assert.match(edited.note ?? '', /the audit log could not record it \(EROFS: read-only file system\)/);
  assert.equal(edited.approval.state, 'sending');
  assert.equal(w.fake.count('chat.update'), 1);
});

test('a bookkeeping failure while recording a refusal cannot hide what Slack refused', async () => {
  const w = await amendWorld();
  const prepared = await preparedEdit(w);
  w.fake.script['chat.update'] = () => ({ ok: false, error: 'cant_update_message' });
  const audit = w.harness.core.audit;
  const append = audit.append.bind(audit);
  audit.append = async (record, ...rest) => {
    if (record.operation === 'slack.edit') throw new Error('EROFS: read-only file system');
    return append(record, ...rest);
  };
  const error = await refusal(send(w, prepared), 'a refused edit');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.message, 'Slack does not let this account edit that message');
  assert.match(error.hint ?? '', /audit log could not record the refusal \(EROFS: read-only file system\)/);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'failed');
});

// ── At a terminal ─────────────────────────────────────────────────────────────────────────────────────────────

test('under confirm, a person approves the edit they were shown, and only then is it made', async () => {
  const w = await amendWorld({ policy: 'confirm' });
  const prepared = await preparedEdit(w);
  const held = await refusal(send(w, prepared), 'an edit under confirm before anyone approved it');
  assert.equal(held.code, 'APPROVAL_PENDING');
  assert.match(held.hint ?? '', /slack_edit_send/, 'the agent is told which call to make again');
  assert.equal(w.fake.count('chat.update'), 0);

  const prompt = await beginApproval(w.context, prepared.approvalId, w.slack);
  assert.equal(prompt.kind, 'edit');
  assert.match(prompt.preview, /^EDIT PREVIEW · workspace acme · approval ap_/m);
  assert.match(prompt.preview, /nothing has been changed — approving does not change it/);
  assert.match(prompt.preview, new RegExp(WORDS));
  assert.match(prompt.preview, new RegExp(FIXED));
  await finishApproval(w.context, prepared.approvalId, prompt.challenge, w.slack);
  assert.equal(w.fake.count('chat.update'), 0, 'approving does not edit');

  assert.equal((await send(w, prepared)).approval.state, 'used');
  assert.equal(w.fake.count('chat.update'), 1);
});

test('an edit whose message changed is never shown for approval, and its approval is void', async () => {
  const w = await amendWorld({ policy: 'confirm' });
  const prepared = await preparedEdit(w);
  w.setMessage(mine({ text: 'shipping tomorrow' }));
  const error = await refusal(beginApproval(w.context, prepared.approvalId, w.slack), 'a changed message approved');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /^nothing was approved: the message, the channel, or the account it posts as/);
  assert.match(error.hint ?? '', /Prepare the edit again/);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'revoked');
});

// ── The fence before the step ────────────────────────────────────────────────────────────────────────────────

/*
 * The fence-site table (`support/fence-sites.ts`), for the one step an edit makes — `chat.update`, site 6 — against the
 * loopback Slack: a claimant whose lease ran out starts nothing, and one suspended after its fence said go still makes
 * that one edit and records it.
 */
for (const c of FENCE_CASES.filter((one) => one.flow === 'edit')) {
  test(`a claimant whose lease ran out just before ${c.label} starts nothing, and says so`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'before');
    await assertStoppedBefore(w, c, await w.run(c.flow), log);
  });

  test(`an edit's claimant suspended right after its fence said go still makes ${c.label.replace(/^site \d+, /, 'its ')}`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'after');
    await assertStartedOnlyThatStep(w, c, await w.run(c.flow), log);
  });
}
