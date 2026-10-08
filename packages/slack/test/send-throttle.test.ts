import assert from 'node:assert/strict';
import { realpathSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { asV2, CommsError, sendPacing } from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { gateDepsFor } from '../src/operations/gate.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  sendDelete,
  sendEdit,
  sendPost,
} from '../src/operations/post.ts';
import { prepareReaction, reactPrepared } from '../src/operations/send.ts';
import { type AmendWorld, amendWorld, mine, TS } from './support/amend.ts';
import { DROP, startFakeSlack } from './support/fake-slack.ts';
import { newHarness } from './support/harness.ts';

/**
 * A post, file post, reaction, edit or deletion Slack throttled waits and tries again (design 2026-10-08 §R1–§R3).
 *
 * Slack says "later" two ways, both before it acts: a 429 with `Retry-After`, and `ratelimited` in an answer. Each is in
 * the act's "refused before acting" allowlist, so a retry cannot post twice. The pacing records its waits instead of
 * sleeping, so nothing here waits for real; every retry still runs its act's fence — and an edit's or deletion's last
 * look — and opens a fresh permit, since the guard spends one on every write.
 */

const POSTED_TS = '1700000000.000200';
const throttle = { status: 429, body: { ok: false, error: 'ratelimited' }, headers: { 'retry-after': '2' } };
const ratelimited = { ok: false, error: 'ratelimited' };

function pacing() {
  const waits: number[] = [];
  return { waits, sendPacing: () => sendPacing({ sleep: async (ms) => void waits.push(ms) }) };
}

const refused = (promise: Promise<unknown>) =>
  promise.then(
    () => assert.fail('the act was reported as done'),
    (error: unknown) => {
      assert.ok(error instanceof CommsError, String(error));
      return error;
    },
  );

/** Answers `method` with `first` the first `times` times it is asked, then as `then` would. */
function firstThen(times: number, first: unknown, then: (seen: unknown) => unknown) {
  let left = times;
  return (seen: unknown) => (left-- > 0 ? first : then(seen));
}

// ── Posts ────────────────────────────────────────────────────────────────────────────────────────────────────

async function postWorld(t: TestContext) {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const fake = await startFakeSlack({
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'chat.postMessage': () => ({ ok: true, ts: POSTED_TS }),
  });
  t.after(() => fake.close());
  const uploads = fake.acceptUploads({ ts: POSTED_TS });
  const docs = join(harness.home, 'docs');
  await mkdir(docs);
  const report = join(docs, 'report.pdf');
  writeFileSync(report, '%PDF-1.7 the report');
  const { waits, sendPacing: paced } = pacing();
  const context = new SlackContext({ core: harness.core, env: harness.env, surface: 'mcp', sendPacing: paced });
  const prepare = (files: string[] = []) =>
    prepareDraftPost(
      context,
      'acme',
      { channel: 'C1', text: 'the report', ...(files.length > 0 ? { files } : {}) },
      { fetch: fake.fetch },
    );
  const send = (draft: { draftId: string; approvalId: string }) =>
    sendPost(
      context,
      'acme',
      { draftId: draft.draftId, approvalId: draft.approvalId, expectChannel: 'C1' },
      { fetch: fake.fetch },
    );
  const state = async (approvalId: string) => asV2(await harness.core.approvals.get(approvalId))?.state;
  const asked = (method: string) => fake.requests.filter((seen) => seen.method === method).length;
  return { harness, fake, uploads, report: realpathSync.native(report), waits, prepare, send, state, asked };
}

test('a post Slack throttled waits its Retry-After, tries again, and is posted once (§R1, §R2)', async (t) => {
  const w = await postWorld(t);
  const draft = await w.prepare();
  w.fake.script['chat.postMessage'] = firstThen(1, throttle, () => ({ ok: true, ts: POSTED_TS }));

  const posted = await w.send(draft);
  assert.equal(posted.ts, POSTED_TS);
  assert.equal(await w.state(draft.approvalId), 'used');
  assert.deepEqual(w.waits, [2_000], "the wait was not Slack's");
  assert.equal(w.asked('chat.postMessage'), 2);
});

test('`ratelimited` in an answer is the same throttle, and one that outlasts the retries posts nothing (§R5)', async (t) => {
  const w = await postWorld(t);
  const draft = await w.prepare();
  w.fake.script['chat.postMessage'] = () => ratelimited;

  const error = await refused(w.send(draft));
  assert.equal(error.code, 'TRANSIENT');
  assert.match(error.message, /Slack is rate-limiting this workspace \(tried 4 times\)/);
  assert.match(`${error.message} ${error.hint ?? ''}`, /nothing was posted/i);
  assert.equal(error.details?.limit, 'rate');
  assert.equal(error.details?.retries, 3);
  assert.equal(w.asked('chat.postMessage'), 4);
  assert.equal(w.waits.length, 3);
  assert.equal(await w.state(draft.approvalId), 'failed');
});

test('a file post whose sharing call is throttled shares the files once, without uploading them again', async (t) => {
  const w = await postWorld(t);
  const draft = await w.prepare([w.report]);
  const share = w.fake.script['files.completeUploadExternal'];
  assert.ok(share, 'the fake shares no files');
  w.fake.script['files.completeUploadExternal'] = firstThen(1, throttle, (seen) => share(seen as never));

  await w.send(draft);
  assert.equal(await w.state(draft.approvalId), 'used');
  assert.equal(w.asked('files.completeUploadExternal'), 2);
  assert.equal(w.asked('files.getUploadURLExternal'), 1, 'the file was uploaded again');
  assert.equal(w.uploads.completed.filter((done) => done.channelId === 'C1').length, 1, 'not shared exactly once');
  assert.deepEqual(w.waits, [2_000]);
});

test('an answer that leaves a post uncertain is still never retried', async (t) => {
  const w = await postWorld(t);
  const draft = await w.prepare();
  w.fake.script['chat.postMessage'] = () => DROP;

  const error = await refused(w.send(draft));
  assert.equal(error.code, 'SEND_OUTCOME_UNKNOWN');
  assert.equal(w.asked('chat.postMessage'), 1);
  assert.deepEqual(w.waits, []);
});

// ── Reactions ────────────────────────────────────────────────────────────────────────────────────────────────

test('a reaction Slack throttled tries again and is added once', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const asked: string[] = [];
  let first = true;
  const fetch = async (input: string | URL | Request): Promise<Response> => {
    const method = String(input instanceof Request ? input.url : input).split('/api/')[1] ?? '';
    asked.push(method);
    if (method === 'reactions.add' && first) {
      first = false;
      return new Response(JSON.stringify(ratelimited));
    }
    return new Response(
      JSON.stringify(method === 'reactions.add' ? { ok: true } : { ok: false, error: 'unknown_method' }),
    );
  };
  const { waits, sendPacing: paced } = pacing();
  const context = new SlackContext({ core: harness.core, env: harness.env, surface: 'mcp', sendPacing: paced });
  const wanted = { channel: 'C1', ts: TS, name: 'tada' };
  const gate = await gateDepsFor(context, 'acme', { fetch });
  const prepared = await prepareReaction(gate, wanted);

  await reactPrepared(gate, prepared.approvalId, wanted);
  assert.equal(asV2(await harness.core.approvals.get(prepared.approvalId))?.state, 'used');
  assert.equal(asked.filter((method) => method === 'reactions.add').length, 2);
  assert.equal(waits.length, 1, 'no backoff wait for an answer without Retry-After');
});

// ── Edits and deletions ──────────────────────────────────────────────────────────────────────────────────────

function pacedAmend(w: AmendWorld) {
  const { waits, sendPacing: paced } = pacing();
  const context = new SlackContext({
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    surface: 'mcp',
    sendPacing: paced,
  });
  return { context, waits };
}

test('an edit Slack throttled tries again and changes the message once', async () => {
  const w = await amendWorld();
  const { context, waits } = pacedAmend(w);
  const prepared = await prepareEdit(
    context,
    'acme',
    { ts: TS, channel: 'C1', text: 'shipping in ten minutes' },
    w.slack,
  );
  const update = w.fake.script['chat.update'];
  assert.ok(update);
  w.fake.script['chat.update'] = firstThen(1, ratelimited, (params) => update(params as URLSearchParams));

  await sendEdit(
    context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts: TS },
    w.slack,
  );
  assert.equal(w.fake.count('chat.update'), 2);
  assert.equal(waits.length, 1);
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'used');
});

test('a message edited in Slack during the wait is not overwritten: every retry repeats the last look (§R3)', async () => {
  const w = await amendWorld();
  const { waits } = pacedAmend(w);
  const paced = sendPacing({
    sleep: async (ms) => {
      waits.push(ms);
      // The author changes the message in Slack while the edit waits.
      w.setMessage(mine({ text: 'shipping at noon', edited: { user: 'U0001', ts: '1700000001.000000' } }));
    },
  });
  const context = new SlackContext({
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    surface: 'mcp',
    sendPacing: () => paced,
  });
  const prepared = await prepareEdit(
    context,
    'acme',
    { ts: TS, channel: 'C1', text: 'shipping in ten minutes' },
    w.slack,
  );
  w.fake.script['chat.update'] = () => ratelimited;

  const error = await refused(
    sendEdit(
      context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts: TS },
      w.slack,
    ),
  );
  assert.equal(error.code, 'APPROVAL_VOID');
  assert.match(error.message, /changed in Slack after the preview/);
  assert.equal(w.fake.count('chat.update'), 1, 'the newer message was overwritten');
});

test('a deletion Slack throttled tries again and deletes the message once', async () => {
  const w = await amendWorld();
  const { context, waits } = pacedAmend(w);
  const where = { channel: 'C1', ts: TS };
  const prepared = await prepareDelete(context, 'acme', where, w.slack);
  const remove = w.fake.script['chat.delete'];
  assert.ok(remove);
  w.fake.script['chat.delete'] = firstThen(1, ratelimited, (params) => remove(params as URLSearchParams));

  await sendDelete(context, 'acme', { ...where, approvalId: prepared.approvalId }, w.slack);
  assert.equal(w.fake.count('chat.delete'), 2);
  assert.equal(waits.length, 1);
  assert.equal(asV2(await w.harness.core.approvals.get(prepared.approvalId))?.state, 'used');
});

test('an edit adding a file, throttled finishing the upload, finishes it once and edits once', async (t) => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const message = {
    type: 'message',
    user: 'U0001',
    text: 'the Q3 numbers',
    ts: TS,
    files: [{ id: 'F0OLD00001', name: 'chart-v1.png' }],
  };
  const fake = await startFakeSlack({
    'conversations.history': () => ({ ok: true, messages: [message] }),
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'chat.update': (request) => ({
      ok: true,
      channel: 'C1',
      ts: TS,
      message: {
        files: (JSON.parse(request.params.get('file_ids') ?? '[]') as string[]).map((id) => ({ id, name: id })),
      },
    }),
  });
  t.after(() => fake.close());
  fake.acceptUploads({ ts: TS });
  const finish = fake.script['files.completeUploadExternal'];
  assert.ok(finish, 'the fake finishes no uploads');
  fake.script['files.completeUploadExternal'] = firstThen(1, throttle, (seen) => finish(seen as never));
  const { waits, sendPacing: paced } = pacing();
  const context = new SlackContext({
    core: harness.core,
    env: harness.env,
    platform: 'darwin',
    surface: 'mcp',
    sendPacing: paced,
  });
  const docs = join(harness.home, 'docs');
  await mkdir(docs);
  const chart = join(docs, 'chart-v2.png');
  writeFileSync(chart, 'the second chart');
  const slack = { fetch: fake.fetch };
  const prepared = await prepareEdit(
    context,
    'acme',
    { ts: TS, channel: 'C1', files: [realpathSync.native(chart)] },
    slack,
  );

  await sendEdit(
    context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts: TS },
    slack,
  );
  const asked = (method: string) =>
    fake.requests.filter((request) => request.host === 'api' && request.method === method).length;
  assert.equal(asked('files.completeUploadExternal'), 2);
  assert.equal(asked('files.getUploadURLExternal'), 1, 'the file was uploaded again');
  assert.equal(asked('chat.update'), 1);
  assert.deepEqual(waits, [2_000]);
  assert.equal(asV2(await harness.core.approvals.get(prepared.approvalId))?.state, 'used');
});
