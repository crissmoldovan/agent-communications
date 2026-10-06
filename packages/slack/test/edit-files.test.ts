import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { type TestContext, test } from 'node:test';
import { renderChannelPreview } from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { REMOVES_FILES } from '../src/operations/amend.ts';
import { beginApproval, finishApproval } from '../src/operations/approve.ts';
import { prepareEdit, sendEdit } from '../src/operations/post.ts';
import { CONTAINS_FILES } from '../src/operations/send.ts';
import { audited, homeFile, refusal, stateOf, TS } from './support/amend.ts';
import { type SlackRequest, startFakeSlack } from './support/fake-slack.ts';
import {
  assertStartedOnlyThatStep,
  assertStoppedBefore,
  FENCE_CASES,
  fenceWorld,
  suspendAt,
} from './support/fence-sites.ts';
import { newHarness } from './support/harness.ts';

/**
 * Editing a message's files (design 2026-10-06 §5, built on what was observed against a real workspace that day):
 * `chat.update`'s `file_ids` replaces the message's files with exactly the ids sent, in that order; a file left out is
 * taken off and kept by Slack, shared nowhere; and an edit that sends no `file_ids` leaves the files alone.
 *
 * So an edit sends every id the message should end with, and these tests hold it to that — and to what it refuses
 * before any file leaves the machine. Slack is the loopback fake, which takes uploads as the real files host does.
 */

/** The message's words as Slack holds them: escaped, with a mention as a span — what keeping them must send back. */
const WIRE = 'the Q3 numbers for <@U0002> &amp; the team';
const OLD = { id: 'F0OLD00001', name: 'chart-v1.png' };
const NOTES = { id: 'F0NOTES001', name: 'notes.txt' };

async function filesWorld(
  t: TestContext,
  options: {
    policy?: 'chat' | 'confirm';
    grantedScopes?: readonly string[];
    files?: readonly { id: string; name: string }[];
    update?: (request: SlackRequest) => unknown;
  } = {},
) {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    sendPolicy: options.policy ?? 'chat',
    ...(options.grantedScopes ? { grantedScopes: options.grantedScopes } : {}),
  });
  let message: Record<string, unknown> = {
    type: 'message',
    user: 'U0001',
    text: WIRE,
    ts: TS,
    files: options.files ?? [OLD, NOTES],
  };
  const fake = await startFakeSlack({
    'conversations.history': () => ({ ok: true, messages: [message] }),
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    // Slack's answer lists the message's files as the ids sent leave them, as observed.
    'chat.update':
      options.update ??
      ((request) => ({
        ok: true,
        channel: 'C1',
        ts: TS,
        message: {
          files: (JSON.parse(request.params.get('file_ids') ?? '[]') as string[]).map((id) => ({ id, name: id })),
        },
      })),
  });
  t.after(() => fake.close());
  const uploads = fake.acceptUploads({ ts: TS });
  const context = new SlackContext({ core: harness.core, env: harness.env, platform: 'darwin', surface: 'mcp' });
  const chart = homeFile(harness, 'chart-v2.png', 'the second chart');
  const sheet = homeFile(harness, 'q3.csv', 'quarter,revenue');
  const slack = { fetch: fake.fetch };
  return {
    harness,
    fake,
    uploads,
    context,
    slack,
    chart,
    sheet,
    setMessage(over: Record<string, unknown>) {
      message = { ...message, ...over };
    },
    asked: (method: string) => fake.requests.filter((request) => request.host === 'api' && request.method === method),
    uploadsSent: () => fake.requests.filter((request) => request.host === 'files').length,
    prepare: (request: Record<string, unknown>) =>
      prepareEdit(context, 'acme', { ts: TS, channel: 'C1', ...request }, slack),
    send: (prepared: { draftId: string; approvalId: string }) =>
      sendEdit(
        context,
        'acme',
        { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts: TS },
        slack,
      ),
  };
}

// ── Preparing ──────────────────────────────────────────────────────────────────────────────────────────────────

test('replacing a file shows what the message keeps, takes off and adds, keeps its words, and changes nothing', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ files: [w.chart], removeFiles: [OLD.id] });

  assert.deepEqual(prepared.preview.replaces?.files, { keeps: ['notes.txt'], removes: ['chart-v1.png'] });
  assert.equal(prepared.preview.replaces?.wordsUnchanged, true);
  assert.equal(prepared.preview.body, 'the Q3 numbers for @U0002 & the team');
  assert.deepEqual(
    prepared.preview.attachments?.map((file) => file.filename),
    ['chart-v2.png'],
    'the file it adds, as a post lists one',
  );
  assert.ok(prepared.riskFlags.includes(CONTAINS_FILES), prepared.riskFlags.join(', '));
  assert.ok(prepared.riskFlags.includes(REMOVES_FILES), prepared.riskFlags.join(', '));
  assert.equal(prepared.expect.subject, `edits ${TS}, reaches 1, removes ${OLD.id}`);
  assert.ok(
    prepared.preview.warnings?.includes(
      'chart-v1.png is taken off the message, not deleted: Slack keeps it, shared nowhere. Delete it in Slack if it should go.',
    ),
    JSON.stringify(prepared.preview.warnings),
  );
  assert.ok(
    !prepared.preview.warnings?.some((warning) =>
      warning.startsWith('Everyone who can read the channel sees the new words'),
    ),
    'words that do not change are not said to',
  );
  // Read only: the message and the room. No upload, no URL asked for, nothing shared.
  assert.deepEqual(
    w.fake.requests.map((request) => request.method),
    ['conversations.history', 'conversations.info'],
  );

  const shown = renderChannelPreview(prepared.preview);
  assert.match(shown, /^Keeps: +notes\.txt$/m);
  assert.match(shown, /^Removes: +chart-v1\.png$/m);
  assert.match(shown, /^Attach: +chart-v2\.png · /m);
  assert.match(shown, /^Words, unchanged \(/m);
});

test('an edit of files puts each up unshared, then sends every id the message ends with, in order, with its words', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ files: [w.chart, w.sheet], removeFiles: [OLD.id] });
  const edited = await w.send(prepared);

  // Two files up, finished with no channel — shared nowhere — then the one edit that attaches them.
  assert.equal(w.uploads.issued.length, 2);
  assert.deepEqual(w.uploads.completed, [
    {
      channelId: null,
      initialComment: null,
      threadTs: null,
      files: [
        { id: 'F0UP0001', title: 'chart-v2.png' },
        { id: 'F0UP0002', title: 'q3.csv' },
      ],
    },
  ]);
  const [update] = w.asked('chat.update');
  assert.deepEqual(Object.fromEntries(update?.params ?? []), {
    channel: 'C1',
    ts: TS,
    // The words kept exactly as Slack holds them: the mention is still a span, the escape still an escape.
    text: WIRE,
    parse: 'none',
    // What it keeps, in the message's order, then what it adds, in the draft's.
    file_ids: JSON.stringify([NOTES.id, 'F0UP0001', 'F0UP0002']),
  });
  assert.deepEqual(edited.files, [
    { id: NOTES.id, name: NOTES.id },
    { id: 'F0UP0001', name: 'F0UP0001' },
    { id: 'F0UP0002', name: 'F0UP0002' },
  ]);
  assert.equal(edited.note, undefined);
  assert.equal(edited.approval.state, 'used');
  const [record] = await audited(w.harness, 'slack.edit');
  assert.equal(record?.outcome, 'ok');
  assert.deepEqual(record?.ids?.files, ['F0UP0001', 'F0UP0002']);
});

test('taking a file off uploads nothing, and sends the ids of the files left', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ removeFiles: [NOTES.id] });
  assert.deepEqual(prepared.preview.replaces?.files, { keeps: ['chart-v1.png'], removes: ['notes.txt'] });
  await w.send(prepared);
  assert.equal(w.uploads.issued.length, 0);
  assert.equal(w.uploadsSent(), 0);
  assert.equal(w.asked('chat.update')[0]?.params.get('file_ids'), JSON.stringify([OLD.id]));
});

test('adding a file keeps every file the message has, and new words replace the old ones', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ text: 'the final Q3 numbers', files: [w.chart] });
  assert.equal(prepared.preview.replaces?.wordsUnchanged, undefined);
  assert.deepEqual(prepared.preview.replaces?.files, { keeps: ['chart-v1.png', 'notes.txt'], removes: [] });
  await w.send(prepared);
  const update = w.asked('chat.update')[0];
  assert.equal(update?.params.get('text'), 'the final Q3 numbers');
  assert.equal(update?.params.get('file_ids'), JSON.stringify([OLD.id, NOTES.id, 'F0UP0001']));
});

test('a file id that is not one of the message’s, or not a file id, is refused before anything is shown', async (t) => {
  const w = await filesWorld(t);
  const stranger = await refusal(w.prepare({ removeFiles: ['F0SOMEONE1'] }), 'another file taken off');
  assert.equal(stranger.code, 'USAGE');
  assert.equal(stranger.details?.reason, 'not-a-file-of-the-message');
  const garbage = await refusal(w.prepare({ removeFiles: ['chart-v1.png'] }), 'a name passed as an id');
  assert.equal(garbage.code, 'USAGE');
  assert.equal(garbage.details?.reason, 'not-a-file-id');
  assert.equal(w.asked('chat.update').length, 0);
});

test('an edit with nothing to change, or a mention without words, is refused before Slack is asked', async (t) => {
  const w = await filesWorld(t);
  const nothing = await refusal(w.prepare({}), 'an empty edit');
  assert.equal(nothing.code, 'USAGE');
  assert.equal(nothing.details?.reason, 'nothing-to-change');
  const mention = await refusal(w.prepare({ mentionUsers: ['U0002'], files: [w.chart] }), 'a mention with no words');
  assert.equal(mention.code, 'USAGE');
  assert.match(mention.message, /a mention is part of the words/);
  assert.deepEqual(w.fake.requests, []);
});

test('a workspace not granted files:write cannot prepare an edit of files', async (t) => {
  const w = await filesWorld(t, {
    grantedScopes: ['chat:write', 'channels:history', 'channels:read', 'users:read'],
  });
  const error = await refusal(w.prepare({ removeFiles: [OLD.id] }), 'files edited without files:write');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.match(error.message, /files:write/);
});

// ── At send ────────────────────────────────────────────────────────────────────────────────────────────────────

test('a file changed after the preview is refused before any file leaves the machine, and nothing is changed', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ files: [w.chart] });
  writeFileSync(w.chart, 'a different chart altogether');
  const error = await refusal(w.send(prepared), 'a changed file attached');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /^nothing was changed: chart-v2\.png is not the file that was approved — /);
  assert.equal(w.uploads.issued.length, 0, 'no upload URL was asked for');
  assert.equal(w.asked('chat.update').length, 0);
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'failed');
});

test('a refused edit after its files went up says they were never attached, and that Slack keeps them privately', async (t) => {
  const w = await filesWorld(t, { update: () => ({ ok: false, error: 'cant_update_message' }) });
  const prepared = await w.prepare({ files: [w.chart] });
  const error = await refusal(w.send(prepared), 'a refused edit');
  assert.equal(error.code, 'SCOPE_MISSING');
  assert.equal(error.message, 'Slack does not let this account edit that message');
  assert.match(
    error.hint ?? '',
    /chart-v2\.png was uploaded for this edit and never attached: Slack keeps it, private to this account\. Delete it in Slack if it is not wanted\./,
  );
  assert.equal(await stateOf(w.harness, prepared.approvalId), 'failed');
});

test('an edit Slack answered with other files than it sent says so, and is still the edit made', async (t) => {
  const w = await filesWorld(t, {
    update: () => ({ ok: true, channel: 'C1', ts: TS, message: { files: [{ id: OLD.id, name: 'chart-v1.png' }] } }),
  });
  const prepared = await w.prepare({ removeFiles: [NOTES.id, OLD.id], files: [w.chart] });
  const edited = await w.send(prepared);
  assert.equal(edited.note, "Slack lists the message's files as chart-v1.png, not the ones this edit sent");
  assert.deepEqual(edited.files, [{ id: OLD.id, name: 'chart-v1.png' }]);
  assert.equal(edited.approval.state, 'used');
});

test('under confirm, the approval screen shows the files kept, taken off and added, and the edit is made once', async (t) => {
  const w = await filesWorld(t, { policy: 'confirm' });
  const prepared = await w.prepare({ files: [w.chart], removeFiles: [OLD.id] });
  const prompt = await beginApproval(w.context, prepared.approvalId, w.slack);
  assert.equal(prompt.kind, 'edit');
  assert.match(prompt.preview, /^Keeps: +notes\.txt$/m);
  assert.match(prompt.preview, /^Removes: +chart-v1\.png$/m);
  assert.match(prompt.preview, /^Attach: +chart-v2\.png · /m);
  assert.match(prompt.preview, /^ +sha256 [0-9a-f]{64}$/m);
  await finishApproval(w.context, prepared.approvalId, prompt.challenge, w.slack);
  assert.equal(w.uploads.issued.length, 0, 'approving uploads nothing');
  const edited = await w.send(prepared);
  assert.equal(edited.approval.state, 'used');
  assert.equal(w.asked('chat.update').length, 1);
});

test('a file the message gained in Slack after the preview voids the edit: the list it sends would be wrong', async (t) => {
  const w = await filesWorld(t);
  const prepared = await w.prepare({ removeFiles: [OLD.id] });
  w.setMessage({ files: [OLD, NOTES, { id: 'F0LATER001', name: 'late.pdf' }] });
  const error = await refusal(w.send(prepared), 'an edit of a message whose files changed');
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.equal(w.asked('chat.update').length, 0);
});

// ── The fence before each step ─────────────────────────────────────────────────────────────────────────────────

/*
 * The fence-site table (`support/fence-sites.ts`) for an edit with two files: two upload URLs and two uploads (sites 2
 * and 3), the call finishing them (site 4) and the edit (site 6). A claimant whose lease ran out before any of them
 * starts it and no later one; one suspended after a fence said go starts that step and no later one.
 */
for (const c of FENCE_CASES.filter((one) => one.flow === 'edit-files')) {
  test(`a claimant whose lease ran out just before ${c.label} starts nothing, and says so`, async (t) => {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'before');
    await assertStoppedBefore(w, c, await w.run(c.flow), log);
  });
}

test('an edit with files whose claimant was suspended right after a fence said go starts that one step, and no later one', async (t) => {
  for (const c of FENCE_CASES.filter((one) => one.flow === 'edit-files')) {
    const w = await fenceWorld(t);
    const log = suspendAt(w, c.step, 'after');
    await assertStartedOnlyThatStep(w, c, await w.run(c.flow), log);
  }
});
