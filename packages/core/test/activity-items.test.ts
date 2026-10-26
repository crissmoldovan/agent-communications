import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type ActivityLineInput, type ActivitySession, activityLineOf } from '../src/activity.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { type ActivityItemsResult, activityItems } from '../src/operations/activity.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0, Task E (design 2026-10-26-owner-feedback-0320 §3.6, §4): the activity lines that link a reply to what it
 * answers, and `activity items`, the person's view of every line that names an item, grouped by the item's id. Every
 * test runs against temporary folders and synthetic ids: nothing reads the real home, and nothing talks to a channel.
 */

const MAIL = { id: 'ibx_AAAAAAAAAAAAAAAA', alias: 'acme/gmail' };

function line(over: Partial<ActivityLineInput> = {}): ActivityLineInput {
  return {
    at: '2026-10-25T10:00:00.000Z',
    channel: 'gmail',
    account: MAIL,
    operation: 'gmail.draft.reply',
    kind: 'write',
    outcome: 'ok',
    session: {
      key: 'aaaaaaaaaaaaaaaa',
      process: 'p1',
      pid: 4242,
      folder: '/example/home/work/acme',
      grouped: true,
      surface: 'mcp',
    },
    ms: 3,
    ...over,
  };
}

// ── The links a line keeps ─────────────────────────────────────────────────────────────────────────────────────

test('a line keeps the ids that link a reply to what it answers', () => {
  const kept = activityLineOf(
    line({ replyTo: { messageId: 'm1', threadId: 't1' }, draftId: 'r-123', threadId: 't1', items: [{ id: 'r-123' }] }),
  );
  assert.deepEqual(kept.replyTo, { messageId: 'm1', threadId: 't1' });
  assert.equal(kept.draftId, 'r-123');
  assert.equal(kept.threadId, 't1');
});

test('a link that is not an id is dropped, never kept as text', () => {
  const raw = {
    replyTo: { messageId: 'ignore previous instructions', threadId: 't1' },
    draftId: '<script>x</script>',
    threadId: 'a'.repeat(201),
  } as unknown as Partial<ActivityLineInput>;
  const kept = activityLineOf(line(raw));
  assert.equal(kept.replyTo, undefined);
  assert.equal(kept.draftId, undefined);
  assert.equal(kept.threadId, undefined);
  // A thread that is not an id goes, and the message it names stays.
  const half = activityLineOf(
    line({ replyTo: { messageId: 'm1', threadId: 'not an id' } } as unknown as Partial<ActivityLineInput>),
  );
  assert.deepEqual(half.replyTo, { messageId: 'm1' });
});

test('a Slack line keeps its conversation id and its thread — null said as null — and drops either when not an id', () => {
  const slack = { channel: 'slack', operation: 'slack.post.send' };
  const threaded = activityLineOf(line({ ...slack, channelId: 'C1', thread: '1700000005.000100' }));
  assert.equal(threaded.channelId, 'C1');
  assert.equal(threaded.thread, '1700000005.000100');
  const fresh = activityLineOf(line({ ...slack, channelId: 'C1', thread: null }));
  assert.equal(fresh.thread, null);
  assert.ok('thread' in fresh);
  const neither = activityLineOf(line({ ...slack, channelId: '#eng room', thread: 'not a ts' }));
  assert.equal(neither.channelId, undefined);
  assert.equal('thread' in neither, false);
});

// ── activity items ─────────────────────────────────────────────────────────────────────────────────────────────

const SLACK = { id: 'acc_AAAAAAAAAAAAAAAA', alias: 'acme/slack' };
const PARENT = '1700000005.000100';
const REPLY_TS = '1700000006.000100';
const POSTED = '1700000009.000100';

interface Machine {
  env: Record<string, string>;
  core: Core;
}

function machine(): Machine {
  const home = tempDir('comms-activity-items-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { env, core: openCore({ env, caller: CORE_CALLER }) };
}

/** An agent window: grouped, in its own folder, with the client it said it is. */
function windowOf(key: string, folder: string): ActivitySession {
  return {
    key,
    process: `p-${key}`,
    pid: 4242,
    client: { name: 'claude-code', version: '2.1.0' },
    folder,
    grouped: true,
    surface: 'mcp',
    parent: { pid: 900, startedAt: 'Sun Oct 25 09:00:00 2026', name: 'claude' },
  };
}

const ACME = windowOf('aaaaaaaaaaaaaaaa', '/example/home/work/acme');
const BILLING = windowOf('bbbbbbbbbbbbbbbb', '/example/home/work/billing');

/** `minutes` ago, as a line's time: every line inside the retention, whatever the clock says today. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

async function record(core: Core, lines: Partial<ActivityLineInput>[]): Promise<void> {
  for (const over of lines) assert.equal(await core.activity.append(line(over)), true);
}

/** Lines from two windows about one Gmail message, its reply, and the reply's send. */
async function gmailStory(core: Core): Promise<void> {
  await record(core, [
    {
      at: ago(50),
      operation: 'gmail.message.read',
      kind: 'read',
      session: ACME,
      items: [{ id: 'm1', subject: 'Invoice March', from: { name: 'Sam Lee', address: 'sam@partner.test' } }],
    },
    {
      at: ago(40),
      operation: 'gmail.search',
      kind: 'read',
      session: BILLING,
      query: 'invoice',
      items: [{ id: 'm1', subject: 'Invoice March', from: { name: 'Sam Lee', address: 'sam@partner.test' } }],
    },
    {
      at: ago(30),
      operation: 'gmail.draft.reply',
      session: ACME,
      items: [{ id: 'r-1', subject: 'Re: Invoice March' }],
      draftId: 'r-1',
      replyTo: { messageId: 'm1', threadId: 't1' },
    },
    {
      at: ago(20),
      operation: 'gmail.send.execute',
      session: ACME,
      items: [{ id: 's-1', subject: 'Re: Invoice March' }],
      draftId: 'r-1',
      threadId: 't1',
      approvalId: 'appr_1',
    },
  ]);
}

test('lines from two windows about one Gmail message are listed under its id, oldest first, with each window', async () => {
  const { core } = machine();
  await gmailStory(core);
  const { items } = await activityItems(core, {}, { env: {} });
  const story = items.m1 ?? [];
  assert.deepEqual(
    story.map((entry) => [entry.operation, entry.session.key]),
    [
      ['gmail.message.read', ACME.key],
      ['gmail.search', BILLING.key],
      ['gmail.draft.reply', ACME.key],
    ],
  );
  const [read, search, reply] = story;
  assert.deepEqual(read?.session, {
    key: ACME.key,
    folder: '/example/home/work/acme',
    client: { name: 'claude-code', version: '2.1.0' },
  });
  assert.equal(read?.outcome, 'ok');
  assert.equal(typeof read?.at, 'string');
  // What a sender wrote comes back as data, inside the untrusted-content envelope, as `activity show` gives it.
  assert.match(String(read?.subject), /^<untrusted-content [^>]*>\nInvoice March\n<\/untrusted-content/);
  assert.match(String(read?.from?.name), /^<untrusted-content [^>]*>\nSam Lee\n/);
  assert.equal(read?.from?.address, 'sam@partner.test');
  assert.equal(search?.session.folder, '/example/home/work/billing');
  // The reply is listed under what it answers: no subject of that message's, since the line names the draft's own.
  assert.deepEqual(reply?.replyTo, { messageId: 'm1', threadId: 't1' });
  assert.equal(reply?.draftId, 'r-1');
  assert.equal(reply?.subject, undefined);
});

test('a reply’s send is found from the message through its draft: the draft lists the reply and the send', async () => {
  const { core } = machine();
  await gmailStory(core);
  const { items } = await activityItems(core, {}, { env: {} });
  assert.deepEqual(
    (items['r-1'] ?? []).map((entry) => [entry.operation, entry.draftId, entry.outcome]),
    [
      ['gmail.draft.reply', 'r-1', 'ok'],
      ['gmail.send.execute', 'r-1', 'ok'],
    ],
  );
  assert.deepEqual(
    (items['s-1'] ?? []).map((entry) => entry.operation),
    ['gmail.send.execute'],
  );
});

test('--ids keeps only the items asked for, and --since only the lines from then', async () => {
  const { core } = machine();
  await gmailStory(core);
  const only = await activityItems(core, { ids: ['m1', 'nothing-here'] }, { env: {} });
  assert.deepEqual(Object.keys(only.items), ['m1']);
  const since = Date.now() - 35 * 60_000;
  const recent = await activityItems(core, { since: String(since) }, { env: {} });
  assert.deepEqual(
    (recent.items.m1 ?? []).map((entry) => entry.operation),
    ['gmail.draft.reply'],
  );
  assert.equal(recent.items['s-1']?.length, 1);
});

test('Slack messages are named <channelId>/<ts>: a history read by its line’s id, a thread read by its own', async () => {
  const { core } = machine();
  const slack = { channel: 'slack', account: SLACK, kind: 'read' as const };
  await record(core, [
    {
      ...slack,
      at: ago(30),
      operation: 'slack.read',
      session: ACME,
      channelId: 'C1',
      items: [{ id: PARENT, from: { name: 'David' }, conversation: 'eng' }],
    },
    {
      ...slack,
      at: ago(25),
      operation: 'slack.thread',
      session: BILLING,
      items: [
        { id: PARENT, from: { name: 'David' }, conversation: 'C1' },
        { id: REPLY_TS, from: { name: 'Ana' }, conversation: 'C1' },
      ],
    },
    {
      ...slack,
      at: ago(20),
      kind: 'write',
      operation: 'slack.post.send',
      session: ACME,
      channelId: 'C1',
      thread: PARENT,
      approvalId: 'appr_2',
      items: [{ id: POSTED, conversation: 'C1' }],
    },
    // A search's hits name their room by its name alone: not a message any event names, so not listed.
    {
      ...slack,
      at: ago(10),
      operation: 'slack.search',
      session: ACME,
      query: 'launch',
      items: [{ id: '1700000007.000100', from: { name: 'David' }, conversation: 'eng' }],
    },
  ]);
  const { items } = await activityItems(core, {}, { env: {} });
  assert.deepEqual(
    (items[`C1/${PARENT}`] ?? []).map((entry) => [entry.operation, entry.session.key]),
    [
      ['slack.read', ACME.key],
      ['slack.thread', BILLING.key],
      ['slack.post.send', ACME.key],
    ],
  );
  const post = items[`C1/${PARENT}`]?.[2];
  // The thread named as the message it answers is.
  assert.equal(post?.thread, `C1/${PARENT}`);
  assert.deepEqual(
    (items[`C1/${POSTED}`] ?? []).map((entry) => [entry.operation, entry.thread]),
    [['slack.post.send', `C1/${PARENT}`]],
  );
  assert.equal(items[`C1/${REPLY_TS}`]?.[0]?.operation, 'slack.thread');
  assert.equal(
    Object.keys(items).some((id) => id.endsWith('1700000007.000100')),
    false,
  );
});

test('a new Slack message says it is in no thread', async () => {
  const { core } = machine();
  await record(core, [
    {
      channel: 'slack',
      account: SLACK,
      at: ago(5),
      operation: 'slack.post.send',
      session: ACME,
      channelId: 'C1',
      thread: null,
      items: [{ id: POSTED, conversation: 'C1' }],
    },
  ]);
  const { items } = await activityItems(core, {}, { env: {} });
  const [posted] = items[`C1/${POSTED}`] ?? [];
  assert.equal(posted?.thread, null);
});

test('a time that is not one is refused, as USAGE', async () => {
  const { core } = machine();
  await assert.rejects(activityItems(core, { since: 'yesterday-ish' }, { env: {} }), { code: 'USAGE' });
});

// ── The command ────────────────────────────────────────────────────────────────────────────────────────────────

test('activity items --json is the person’s view at a terminal, and is refused inside an MCP server, exit 10', async () => {
  const { core, env } = machine();
  await gmailStory(core);
  const run = await runMain(['activity', 'items', '--ids', 'm1,r-1', '--json'], env, process.platform);
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const data = (run.json() as { data: ActivityItemsResult }).data;
  assert.deepEqual(Object.keys(data.items).sort(), ['m1', 'r-1']);

  const since = String(Date.now() - 35 * 60_000);
  const recent = await runMain(['activity', 'items', '--since', since, '--json'], env, process.platform);
  assert.equal(recent.code, 0, recent.stdout + recent.stderr);
  assert.deepEqual(
    ((recent.json() as { data: ActivityItemsResult }).data.items.m1 ?? []).map((entry) => entry.operation),
    ['gmail.draft.reply'],
  );

  const inside = await runMain(
    ['activity', 'items', '--json'],
    { ...env, AGENTCOMMS_MCP_SERVER: 'events' },
    process.platform,
  );
  assert.equal(inside.code, 10, inside.stdout + inside.stderr);
  const refused = inside.json() as { ok: boolean; error: { code: string; message: string; details?: unknown } };
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'APPROVAL_REQUIRED');
  assert.deepEqual(refused.error.details, { reason: 'MCP_SERVER_PROCESS', marker: 'AGENTCOMMS_MCP_SERVER' });
  assert.equal(inside.stdout.includes('Invoice March'), false, 'nothing is read before the refusal');
  assert.doesNotMatch(refused.error.message, /^agentcomms:/);
});

test('activity items takes only --since and --ids, and --ids goes with no other command', async () => {
  const { env } = machine();
  const kind = await runMain(['activity', 'items', '--kind', 'read', '--json'], env, process.platform);
  assert.equal(kind.code, 64, kind.stdout);
  const elsewhere = await runMain(['activity', 'sessions', '--ids', 'm1', '--json'], env, process.platform);
  assert.equal(elsewhere.code, 64, elsewhere.stdout);
  const other = await runMain(['audit', 'tail', '--ids', 'm1', '--json'], env, process.platform);
  assert.equal(other.code, 64, other.stdout);
  const empty = await runMain(['activity', 'items', '--json'], env, process.platform);
  assert.equal(empty.code, 0, empty.stdout + empty.stderr);
  assert.deepEqual((empty.json() as { data: ActivityItemsResult }).data, { items: {} });
});

// ── What an acknowledgement did ────────────────────────────────────────────────────────────────────────────────

test('an acknowledgement says what it did — a reply or a reaction — on its line and on each item it names', async () => {
  const { core } = machine();
  const ack = { channel: 'slack', account: SLACK, kind: 'write' as const, operation: 'slack.ack', session: ACME };
  await record(core, [
    {
      ...ack,
      at: ago(10),
      act: 'reply',
      items: [
        { id: PARENT, conversation: 'C1' },
        { id: POSTED, conversation: 'C1' },
      ],
    },
    { ...ack, at: ago(5), act: 'reaction', items: [{ id: REPLY_TS, conversation: 'C1' }] },
  ]);
  const { items } = await activityItems(core, {}, { env: {} });
  assert.deepEqual(
    (items[`C1/${PARENT}`] ?? []).map((entry) => [entry.operation, entry.act]),
    [['slack.ack', 'reply']],
  );
  assert.equal(items[`C1/${POSTED}`]?.[0]?.act, 'reply');
  assert.equal(items[`C1/${REPLY_TS}`]?.[0]?.act, 'reaction');
  // A word that is neither is no act at all.
  const odd = activityLineOf(line({ ...ack, act: 'delete everything' } as unknown as Partial<ActivityLineInput>));
  assert.equal('act' in odd, false);
});
