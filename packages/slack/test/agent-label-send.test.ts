import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { asV2, type CommsError, fallbackTextPrefix } from '@agentcomms/core';
import { beginApproval } from '../src/operations/approve.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  react,
  sendDelete,
  sendEdit,
  sendPost,
} from '../src/operations/post.ts';
import { readChannel } from '../src/operations/read.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { type SlackRequest, type SlackWorld, startFakeSlack, type WorldRoom } from './support/fake-slack.ts';
import { newHarness } from './support/harness.ts';

/**
 * What a labelled act sends (design 2026-10-15 S3–S6), against the fake's stateful workspace: the app's post with the
 * bot token, the phrase as its `username` and the account's icon; the fallback with the label in both its `text` and
 * its blocks; edits and deletions with the token that posted; reactions as the app where it can post. And the rule that
 * matters most: an app post Slack refuses is a refused send, and nothing is posted under the other identity.
 */

const PHOTO = 'https://avatars.example.test/u0001-192.png';
const PHRASE = 'Jo Example (agent)';
const USER = 'Bearer fake-user-token-0';
const BOT = 'Bearer fake-bot-token-0';

function rooms(): Record<string, WorldRoom> {
  return {
    C1: { name: 'eng', members: ['U0001', 'U2'] },
    G1: { name: 'secret', is_private: true, members: ['U0001', 'U2', 'U0BOT0001'] },
    D1: { is_im: true, user: 'U2', members: ['U0001', 'U2'] },
    // A DM with someone in an Enterprise Grid org, whose user id is a W….
    D3: { is_im: true, user: 'W0042', members: ['U0001', 'W0042'] },
  };
}

async function labelled(t: TestContext, options: { sendPolicy?: 'chat' | 'confirm' } = {}) {
  const harness = await newHarness();
  const account = await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    identity: 'agent',
    bot: { userId: 'U0BOT0001' },
    ...(options.sendPolicy ? { sendPolicy: options.sendPolicy } : {}),
  });
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const world: SlackWorld = fake.world({
    users: {
      U0001: { display_name: '', real_name: 'Jo Example', image_192: PHOTO },
      U0BOT0001: { real_name: 'Acme Agent', is_bot: true },
    },
    rooms: rooms(),
  });
  const context = harness.context({ platform: 'darwin' });
  return { harness, context, fake, world, slack: { fetch: fake.fetch }, accountId: account.id };
}

type Labelled = Awaited<ReturnType<typeof labelled>>;

const calls = (w: Labelled, method: string): SlackRequest[] =>
  w.fake.requests.filter((request) => request.method === method);

async function post(w: Labelled, channel: string, text = 'shipping in ten minutes') {
  const prepared = await prepareDraftPost(w.context, 'acme', { channel, text }, w.slack);
  return {
    prepared,
    posted: await sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: channel },
      w.slack,
    ),
  };
}

// ── The app's post ─────────────────────────────────────────────────────────────────────────────────────────────────

test('an app post goes with the bot token, the phrase as its username and the photo as its icon (S4)', async (t) => {
  const w = await labelled(t);
  const { posted } = await post(w, 'C1');
  const [sent, ...more] = calls(w, 'chat.postMessage');
  assert.equal(more.length, 0);
  assert.equal(sent?.authorization, BOT, 'the app post did not go with the bot token');
  assert.equal(sent?.params.get('username'), PHRASE);
  assert.equal(sent?.params.get('icon_url'), PHOTO);
  assert.equal(sent?.params.has('icon_emoji'), false);
  // Its words and blocks are the composer's own: nothing a caller passed, and no label in the text — the name says it.
  assert.equal(sent?.params.get('text'), 'shipping in ten minutes');
  assert.deepEqual(JSON.parse(sent?.params.get('blocks') ?? 'null'), [
    { type: 'section', text: { type: 'mrkdwn', text: 'shipping in ten minutes' } },
  ]);
  assert.equal(w.world.messages[0]?.via, 'bot');
  assert.equal(w.world.messages[0]?.bot_id, 'B0BOT0001');
  assert.equal('ts' in posted ? posted.ts : undefined, w.world.messages[0]?.ts);
});

test('an app post carries the agent emoji in place of the photo when one is set for the account (S4)', async (t) => {
  const w = await labelled(t);
  await w.harness.core.config.update(
    (config) => ({ ...config, agentLabel: { slackIcons: { [w.accountId]: ':jo-agent:' } } }),
    { consent: { kind: 'loosening-consent', paths: ['agentLabel.slackIcons'] } },
  );
  await post(w, 'C1');
  const [sent] = calls(w, 'chat.postMessage');
  assert.equal(sent?.params.get('icon_emoji'), ':jo-agent:');
  assert.equal(sent?.params.has('icon_url'), false, 'icon_emoji overrides icon_url, so both should never be sent');
});

test('an app post Slack refuses is a refused send, and nothing is posted as the person after it (S2)', async (t) => {
  const w = await labelled(t);
  const prepared = await prepareDraftPost(w.context, 'acme', { channel: 'G1', text: 'shipping' }, w.slack);
  assert.equal(prepared.label?.route, 'app');
  // The app removed from the room at Slack's end, after the members were read: the bot's post is refused.
  const before = w.fake.script['chat.postMessage'];
  w.fake.script['chat.postMessage'] = (request) =>
    request.authorization === BOT ? { ok: false, error: 'not_in_channel' } : before?.(request);
  await assert.rejects(
    sendPost(
      w.context,
      'acme',
      { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'G1' },
      w.slack,
    ),
    (error: CommsError) => {
      assert.notEqual(error.code, 'SEND_OUTCOME_UNKNOWN', 'a refusal was read as an outcome nobody knows');
      return true;
    },
  );
  const sent = calls(w, 'chat.postMessage');
  assert.equal(sent.length, 1, 'a second post followed the refused one');
  assert.equal(sent[0]?.authorization, BOT);
  assert.equal(w.world.messages.length, 0);
  assert.equal(asV2(await w.context.core.approvals.get(prepared.approvalId))?.state, 'failed');
});

// ── The fallback ───────────────────────────────────────────────────────────────────────────────────────────────────

test('the fallback starts its words and its notification with the label, the same in both, with the person’s token (S3)', async (t) => {
  const w = await labelled(t);
  await post(w, 'D1');
  const [sent] = calls(w, 'chat.postMessage');
  assert.equal(sent?.authorization, USER);
  assert.equal(sent?.params.has('username'), false, 'the person’s post named itself');
  const labelled_ = `${fallbackTextPrefix(PHRASE)}shipping in ten minutes`;
  // The notification carries it, and so does the one section a reader sees: the composer's shape, of the labelled words.
  assert.equal(sent?.params.get('text'), labelled_);
  assert.deepEqual(JSON.parse(sent?.params.get('blocks') ?? '[]'), [
    { type: 'section', text: { type: 'mrkdwn', text: labelled_ } },
  ]);
});

test('a labelled fallback reads back as one message: no mismatch, and the label at its top (S3)', async (t) => {
  /*
   * Reading compares what a person sees with what a notification says, and reports a difference as `mismatch` — the
   * signal for a message that reads one way to an agent and another to the room. Our own labelled post must not
   * raise it: every agent that read it would take it for a deception.
   */
  const w = await labelled(t);
  await post(w, 'D1');
  const { call } = await openWorkspace(w.context, 'acme', w.slack);
  const read = await readChannel(call, 'acme', 'D1');
  const [row, ...more] = read.rows;
  assert.equal(more.length, 0);
  assert.equal(row?.message.mismatch, false, 'our own labelled post reads back as a mismatch');
  assert.equal(row?.message.unrenderable, false);
  assert.match(row?.message.enveloped ?? '', /Jo Example \(agent\): shipping in ten minutes/);

  // An agent's edit of it keeps the label, in the text alone, and reads back the same way.
  const ts = w.world.messages[0]?.ts ?? '';
  const prepared = await prepareEdit(w.context, 'acme', { ts, channel: 'D1', text: 'shipping in five' }, w.slack);
  await sendEdit(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'D1', ts },
    w.slack,
  );
  const edited = (await readChannel(call, 'acme', 'D1')).rows[0];
  assert.equal(edited?.message.mismatch, false);
  assert.match(edited?.message.enveloped ?? '', /Jo Example \(agent\): shipping in five/);
});

test('a file post’s initial comment begins with the label (S3)', async (t) => {
  const w = await labelled(t);
  const uploads = w.fake.acceptUploads();
  const docs = join(w.harness.home, 'docs');
  mkdirSync(docs);
  const path = join(docs, 'notes.txt');
  writeFileSync(path, 'the notes\n');
  const prepared = await prepareDraftPost(
    w.context,
    'acme',
    { channel: 'C1', text: 'the notes', files: [realpathSync.native(path)] },
    w.slack,
  );
  await sendPost(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1' },
    w.slack,
  );
  assert.equal(uploads.completed[0]?.initialComment, `${fallbackTextPrefix(PHRASE)}the notes`);
  assert.equal(calls(w, 'files.completeUploadExternal')[0]?.authorization, USER);
});

// ── Edits and deletes ──────────────────────────────────────────────────────────────────────────────────────────────

/** A message the person typed in Slack, planted in the world. */
function typed(w: Labelled, channel = 'C1', ts = '1700000000.000100') {
  w.world.messages.push({ channel, ts, text: 'shiping soon', user: 'U0001', via: 'user' });
  return ts;
}

async function edit(w: Labelled, ts: string, text: string, as?: 'agent' | 'me') {
  const prepared = await prepareEdit(w.context, 'acme', { ts, channel: 'C1', text, ...(as ? { as } : {}) }, w.slack);
  await sendEdit(
    w.context,
    'acme',
    { draftId: prepared.draftId, approvalId: prepared.approvalId, expectChannel: 'C1', ts },
    w.slack,
  );
  return prepared;
}

test('an agent’s edit of a message the person posted gets the prefix in its new text, with their token (S5)', async (t) => {
  const w = await labelled(t);
  const prepared = await edit(w, typed(w), 'shipping soon');
  const [sent] = calls(w, 'chat.update');
  assert.equal(sent?.authorization, USER);
  assert.equal(sent?.params.get('text'), `${fallbackTextPrefix(PHRASE)}shipping soon`);
  assert.equal(sent?.params.has('blocks'), false);
  assert.match(
    prepared.preview.postingAs,
    /^Jo Example · labelled "Jo Example \(agent\):" at the start of the new words/,
  );
  // As the person, unlabelled, when they say so.
  const plain = await labelled(t);
  await edit(plain, typed(plain), 'shipping soon', 'me');
  assert.equal(calls(plain, 'chat.update')[0]?.params.get('text'), 'shipping soon');
});

test('an app message this account posted is edited and deleted with the bot token (S5)', async (t) => {
  const w = await labelled(t);
  const { posted } = await post(w, 'C1', 'shiping');
  const ts = 'ts' in posted && posted.ts ? posted.ts : '';
  await edit(w, ts, 'shipping');
  const [updated] = calls(w, 'chat.update');
  assert.equal(updated?.authorization, BOT, 'the app’s message was edited with the person’s token');
  // The app's own name says who: its words carry no second label.
  assert.equal(updated?.params.get('text'), 'shipping');

  const deletion = await prepareDelete(w.context, 'acme', { channel: 'C1', ts }, w.slack);
  await sendDelete(w.context, 'acme', { channel: 'C1', ts, approvalId: deletion.approvalId }, w.slack);
  assert.equal(calls(w, 'chat.delete')[0]?.authorization, BOT);
  assert.equal(w.world.messages[0]?.deleted, true);
});

test('an app message this account’s own record does not hold is refused before any preview (S5)', async (t) => {
  // The bot token is the workspace's: another member's agent posted this, through the same organisation app.
  const w = await labelled(t);
  w.world.messages.push({
    channel: 'C1',
    ts: '1700000000.000900',
    text: 'theirs',
    user: 'U0BOT0001',
    bot_id: 'B0BOT0001',
    username: 'Someone Else (agent)',
    via: 'bot',
  });
  for (const attempt of [
    () => prepareEdit(w.context, 'acme', { ts: '1700000000.000900', channel: 'C1', text: 'mine now' }, w.slack),
    () => prepareDelete(w.context, 'acme', { channel: 'C1', ts: '1700000000.000900' }, w.slack),
  ]) {
    await assert.rejects(attempt(), (error: CommsError) => {
      assert.equal(error.code, 'SCOPE_MISSING');
      assert.equal(error.details?.reason, 'not-own-app-message');
      return true;
    });
  }
  assert.deepEqual(await w.context.core.approvals.list(), [], 'a refused app message left an approval');
});

test('a message the person posted is deleted with their token (S5)', async (t) => {
  const w = await labelled(t);
  const ts = typed(w);
  const deletion = await prepareDelete(w.context, 'acme', { channel: 'C1', ts }, w.slack);
  await sendDelete(w.context, 'acme', { channel: 'C1', ts, approvalId: deletion.approvalId }, w.slack);
  assert.equal(calls(w, 'chat.delete')[0]?.authorization, USER);
});

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('an agent reaction where the app can post is the app’s, with the bot token (S6)', async (t) => {
  const w = await labelled(t);
  const done = await react(
    w.context,
    'acme',
    { channel: 'C1', ts: '1700000000.000100', name: 'eyes' },
    undefined,
    w.slack,
  );
  assert.equal(calls(w, 'reactions.add')[0]?.authorization, BOT);
  assert.equal(w.world.reactions[0]?.via, 'bot');
  assert.equal(done.label?.route, 'app');
});

test('in a DM the person reacts, and the preview says the reaction is unlabelled (S6)', async (t) => {
  const w = await labelled(t);
  const done = await react(
    w.context,
    'acme',
    { channel: 'D1', ts: '1700000000.000100', name: 'eyes' },
    undefined,
    w.slack,
  );
  assert.equal(calls(w, 'reactions.add')[0]?.authorization, USER);
  assert.equal(done.label?.route, 'person');
  assert.match(done.label?.line ?? '', /with no label/);

  // Under `confirm`, the screen a person approves it at says so too.
  const confirm = await labelled(t, { sendPolicy: 'confirm' });
  let approvalId = '';
  await assert.rejects(
    react(confirm.context, 'acme', { channel: 'D1', ts: '1700000000.000100', name: 'eyes' }, undefined, confirm.slack),
    (error: CommsError) => {
      approvalId = String(error.details?.approvalId ?? '');
      return error.code === 'APPROVAL_PENDING';
    },
  );
  const screen = await beginApproval(confirm.context, approvalId, confirm.slack);
  assert.match(screen.preview, /From: as you, with no label/);
});

test('a rule naming a person decides a reaction in a DM with them, a Grid person’s W… id too (L4, S6)', async (t) => {
  const w = await labelled(t);
  await w.harness.core.config.update(
    (config) => ({ ...config, agentLabel: { rules: [{ account: 'acme', conversation: 'W0042', as: 'me' }] } }),
    { consent: { kind: 'loosening-consent', paths: ['agentLabel.rules'] } },
  );
  const done = await react(
    w.context,
    'acme',
    { channel: 'D3', ts: '1700000000.000100', name: 'eyes' },
    undefined,
    w.slack,
  );
  assert.equal(done.label, undefined, 'the rule for W0042 did not decide the reaction in the DM with them');
  assert.equal(calls(w, 'reactions.add')[0]?.authorization, USER);
});

// ── The workspace's style (the owner's decision, 2026-10-17) ─────────────────────────────────────────────────────

/** This workspace's style set to `labelled`, as `label style` writes it once the person has said yes. */
async function chooseLabelled(w: Labelled): Promise<void> {
  await w.harness.core.config.update(
    (config) => ({ ...config, agentLabel: { slackStyles: { [w.accountId]: 'labelled' } } }),
    { consent: { kind: 'loosening-consent', paths: ['agentLabel.slackStyles'] } },
  );
}

const LABELLED_REASON = 'you chose labelled posts for this workspace';

test('labelled: a post in a public channel the app could post in goes with the person’s token, labelled as S3 says', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  const { prepared } = await post(w, 'C1');
  assert.equal(prepared.label?.route, 'fallback');
  assert.equal(prepared.label?.reason, LABELLED_REASON);
  const [sent, ...more] = calls(w, 'chat.postMessage');
  assert.equal(more.length, 0);
  assert.equal(sent?.authorization, USER, 'a labelled post went with the bot token');
  assert.equal(sent?.params.has('username'), false);
  assert.equal(sent?.params.has('icon_url'), false);
  assert.equal(sent?.params.has('icon_emoji'), false);
  const words = `${fallbackTextPrefix(PHRASE)}shipping in ten minutes`;
  assert.equal(sent?.params.get('text'), words);
  assert.deepEqual(JSON.parse(sent?.params.get('blocks') ?? '[]'), [
    { type: 'section', text: { type: 'mrkdwn', text: words } },
  ]);
  assert.equal(w.world.messages[0]?.via, 'user');
  // The bot token was never opened.
  assert.equal(
    w.fake.requests.some((request) => request.authorization === BOT),
    false,
  );
});

test('labelled: the post reads back as one message, with no mismatch and the label at its top (S3)', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  await post(w, 'C1');
  const { call } = await openWorkspace(w.context, 'acme', w.slack);
  const [row, ...more] = (await readChannel(call, 'acme', 'C1')).rows;
  assert.equal(more.length, 0);
  assert.equal(row?.message.mismatch, false, 'a labelled post reads back as a mismatch');
  assert.equal(row?.message.unrenderable, false);
  assert.match(row?.message.enveloped ?? '', /Jo Example \(agent\): shipping in ten minutes/);
});

test('labelled: a reaction where the app could post is the person’s, unlabelled, and its preview says so (S6)', async (t) => {
  const w = await labelled(t);
  await chooseLabelled(w);
  const done = await react(
    w.context,
    'acme',
    { channel: 'C1', ts: '1700000000.000100', name: 'eyes' },
    undefined,
    w.slack,
  );
  assert.equal(calls(w, 'reactions.add')[0]?.authorization, USER, 'a labelled workspace’s reaction was the app’s');
  assert.equal(w.world.reactions[0]?.via, 'user');
  assert.equal(done.label?.identity, 'agent');
  assert.equal(done.label?.route, 'person');
  assert.equal(done.label?.reason, `a reaction carries no words to label, and ${LABELLED_REASON}`);
  assert.match(done.label?.line ?? '', /^as you, with no label: a reaction carries no words/);

  // Under `confirm`, the screen a person approves it at says the same.
  const confirm = await labelled(t, { sendPolicy: 'confirm' });
  await chooseLabelled(confirm);
  let approvalId = '';
  await assert.rejects(
    react(confirm.context, 'acme', { channel: 'C1', ts: '1700000000.000100', name: 'eyes' }, undefined, confirm.slack),
    (error: CommsError) => {
      approvalId = String(error.details?.approvalId ?? '');
      return error.code === 'APPROVAL_PENDING';
    },
  );
  const screen = await beginApproval(confirm.context, approvalId, confirm.slack);
  assert.match(screen.preview, /From: as you, with no label/);
});

test('labelled: an app message posted before the switch is still edited by the app, which posted it (S5)', async (t) => {
  const w = await labelled(t);
  const { posted } = await post(w, 'C1', 'shiping');
  const ts = 'ts' in posted && posted.ts ? posted.ts : '';
  await chooseLabelled(w);
  await edit(w, ts, 'shipping');
  const [updated] = calls(w, 'chat.update');
  assert.equal(updated?.authorization, BOT, 'only the token that posted can change a message');
  assert.equal(updated?.params.get('text'), 'shipping');
  // A message the person posted is edited as the person, labelled, for the reason an edit always had.
  const typedTs = typed(w, 'C1', '1700000000.000200');
  const prepared = await edit(w, typedTs, 'shipping soon');
  assert.equal(calls(w, 'chat.update')[1]?.authorization, USER);
  assert.equal(calls(w, 'chat.update')[1]?.params.get('text'), `${fallbackTextPrefix(PHRASE)}shipping soon`);
  assert.match(prepared.preview.postingAs, /an edit of a message you posted is made as you$/);
});
