import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES, type TakeHolder } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * Taking messages in Slack (design 2026-10-26-taking-messages §5, §6, §11 "Channels"): `slack_take` and `slack_taken`,
 * their commands, the gates on every act that answers a message — at prepare and again at the claim — and the `taken`
 * every read adds. Slack is a scripted fetch that answers by method and parameters; nothing reaches the real one. The
 * other session is a take written straight into this harness's store, with a holder no process here is.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Raw = Record<string, unknown>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

const ME = 'U0001';
const OTHER = 'U0002';
const C1 = 'C1';
const D1 = 'D1';
/** In C1: a message from someone else that starts a thread, two replies — theirs, then ours — and one of our own. */
const PARENT = '1700000000.000100';
const REPLY = '1700000000.000150';
const MY_REPLY = '1700000000.000160';
const MINE = '1700000000.000200';
/** In D1: two from them, then one of ours, the newest of all. */
const DM_OLD = '1700000000.000300';
const DM_NEW = '1700000000.000400';
const DM_MINE = '1700000000.000500';

const C1_TOP: Raw[] = [
  { ts: MINE, user: ME, text: 'ours' },
  { ts: PARENT, user: OTHER, text: 'can someone look at the invoice?', thread_ts: PARENT, reply_count: 2 },
];
const THREAD: Raw[] = [
  { ts: PARENT, user: OTHER, text: 'can someone look at the invoice?', thread_ts: PARENT, reply_count: 2 },
  { ts: REPLY, user: OTHER, text: 'it is the March one', thread_ts: PARENT },
  { ts: MY_REPLY, user: ME, text: 'looking', thread_ts: PARENT },
];
const DM: Raw[] = [
  { ts: DM_MINE, user: ME, text: 'sure' },
  { ts: DM_NEW, user: OTHER, text: 'and the other one?' },
  { ts: DM_OLD, user: OTHER, text: 'hello' },
];

/**
 * The other session: a holder no process in this test is. Its fields must never reach an agent. No parent, so its take
 * lapses only by its lease: a parent pid this machine does not run would end it the moment another session met it (T3).
 */
const BOB: TakeHolder = {
  key: 'bbbbbbbbbbbbbbbb',
  grouped: true,
  process: 'b2b2b2b2b2b2',
  sessionId: '99999999-2222-4333-8444-555555555555',
  parent: null,
  folder: '/example/home/work/client-secret-project',
  client: { name: 'other-client', version: '9.9.9' },
};
const BOB_FIELDS = [BOB.key, BOB.process, BOB.sessionId as string, 'client-secret-project', 'other-client', '9.9.9'];

/** Slack, answering by method and parameters, and counting what it was asked. */
function fakeSlack() {
  const asked: { method: string; params: URLSearchParams }[] = [];
  const reply = (method: string, params: URLSearchParams): Raw => {
    const channel = params.get('channel') ?? '';
    const ts = params.get('ts') ?? '';
    const at =
      params.get('latest') !== null && params.get('latest') === params.get('oldest') ? params.get('latest') : null;
    switch (method) {
      case 'conversations.info':
        return channel === D1
          ? { ok: true, channel: { id: D1, is_im: true, user: OTHER } }
          : { ok: true, channel: { id: channel, name: 'eng', num_members: 4, is_member: true } };
      case 'conversations.history': {
        const all = channel === D1 ? DM : channel === C1 ? C1_TOP : [];
        return { ok: true, messages: at === null ? all : all.filter((message) => message.ts === at), has_more: false };
      }
      case 'conversations.replies': {
        if (channel === C1 && [PARENT, REPLY, MY_REPLY].includes(ts))
          return { ok: true, messages: THREAD, has_more: false };
        const single = [...C1_TOP, ...DM].find((message) => message.ts === ts && message.thread_ts === undefined);
        if (single !== undefined) return { ok: true, messages: [single], has_more: false };
        return { ok: false, error: 'thread_not_found' };
      }
      case 'chat.postMessage':
        return { ok: true, ts: '1700000000.000900', channel };
      case 'reactions.add':
      case 'reactions.remove':
        return { ok: true };
      case 'users.info':
        return { ok: true, user: { id: params.get('user'), name: 'someone', team_id: 'T0001' } };
      default:
        return { ok: false, error: 'unknown_method' };
    }
  };
  const read: FakeFetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = url.pathname.split('/api/')[1] ?? '';
    const params = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    for (const [key, value] of url.searchParams) params.set(key, value);
    asked.push({ method, params });
    return new Response(JSON.stringify(reply(method, params)));
  };
  return {
    read,
    count: (method: string) => asked.filter((call) => call.method === method).length,
  };
}

async function connect(harness: Harness, fetch: FakeFetch) {
  const { server } = await createSlackMcpServer({ core: harness.core, env: harness.env, fetch, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

const failure = (result: ToolResult): Failure => {
  assert.equal(result.isError, true, `expected a refusal: ${JSON.stringify(result.structuredContent)}`);
  return (result.structuredContent as { error: Failure }).error;
};
const ok = (result: ToolResult): Record<string, unknown> => {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent as Record<string, unknown>;
};

async function cli(harness: Harness, argv: string[], read: FakeFetch, options: { person?: boolean } = {}) {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    // A person at a terminal, typing back the code `approve` shows.
    const asked = options.person === true && !answered ? /Type (\S+) to approve/.exec(stderr) : null;
    if (asked) {
      answered = true;
      input.write(`${asked[1]}\n`);
    }
  });
  const tty = options.person === true;
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: tty }),
      stderr: Object.assign(err, { isTTY: tty }),
      stdin: Object.assign(input, { isTTY: tty }),
    },
    openBrowser: () => undefined,
    probe: (probeInput, init) => harness.probe(probeInput, init),
    platform: 'darwin',
    read,
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** A workspace that posts on a yes in the chat — and, `required`, asks a session to take a message first. */
async function workspace(options: { required?: boolean; policy?: 'chat' | 'confirm' } = {}) {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: options.policy ?? 'chat' });
  if (options.required !== undefined) {
    // A tightening, so it is written at once, as the person's `taking --require on` writes it.
    await harness.core.config.update((config) => ({
      ...config,
      taking: { accounts: [{ accountId: account.id, account: 'acme', required: options.required }] },
    }));
  }
  return { harness, account };
}

const message = (accountId: string, channel: string, ts: string) => ({
  channel: 'slack' as const,
  accountId,
  id: `${channel}/${ts}`,
  thread: null,
});
const TERMINAL = { folder: '/example/home', ancestors: ['zsh'] };

// ── Taking ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('slack_take takes someone else’s message, says so in closed words, and renews a take of its own', async () => {
  const { harness } = await workspace();
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const taken = ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    assert.deepEqual(
      { ...taken, leaseUntil: typeof taken.leaseUntil, taken: { ...(taken.taken as Raw), since: 'at' } },
      {
        workspace: 'acme',
        message: `${C1}/${REPLY}`,
        thread: `${C1}/${PARENT}`,
        step: 'take',
        state: 'taken',
        you: true,
        leaseUntil: 'string',
        changed: true,
        taken: { state: 'taken', by: 'you', since: 'at', leaseUntil: taken.leaseUntil },
      },
    );
    const again = ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    assert.equal(again.changed, false, 'a renewal');
    const parent = ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: PARENT }));
    assert.equal(parent.thread, `${C1}/${PARENT}`, 'a thread’s parent is its own thread');
  } finally {
    await close();
  }
});

test('slack_take refuses a missing message, this account’s own, and one its app posted', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  writeAppPost(harness, account.id, D1, DM_OLD);
  const { call, close } = await connect(harness, fake.read);
  try {
    const missing = failure(await call('slack_take', { workspace: 'acme', channel: C1, ts: '1700000000.000999' }));
    assert.equal(missing.code, 'NOT_FOUND');
    const own = failure(await call('slack_take', { workspace: 'acme', channel: C1, ts: MINE }));
    assert.equal(own.code, 'USAGE');
    assert.deepEqual(own.details, { reason: 'own-message' });
    const app = failure(await call('slack_take', { workspace: 'acme', channel: D1, ts: DM_OLD }));
    assert.deepEqual(app.details, { reason: 'own-message' });
    assert.deepEqual(await harness.core.takes.list(), [], 'nothing was recorded');
    // Ids are checked before Slack is asked anything.
    const bad = failure(await call('slack_take', { workspace: 'acme', channel: '#eng', ts: PARENT }));
    assert.equal(bad.code, 'USAGE');
  } finally {
    await close();
  }
});

function writeAppPost(harness: Harness, accountId: string, channel: string, ts: string): void {
  const dir = join(harness.core.paths.stateDir, 'slack', 'app-posts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${accountId}.jsonl`), `${JSON.stringify({ channel, ts, approvalId: 'ap_x', at: 'x' })}\n`);
}

test('another session’s take is refused in closed words, and neither the refusal nor taken names it', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  await harness.core.takes.take(message(account.id, C1, REPLY), BOB);
  const { call, close } = await connect(harness, fake.read);
  try {
    const refused = failure(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    assert.equal(refused.code, 'TAKEN_ELSEWHERE');
    assert.deepEqual(refused.details, { reason: 'HELD' });
    const handBack = failure(
      await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY, step: 'hand-back', reason: 'not-mine' }),
    );
    assert.equal(handBack.code, 'TAKEN_ELSEWHERE');
    const views = ok(await call('slack_taken', { workspace: 'acme', messages: [`${C1}/${REPLY}`, `${C1}/${PARENT}`] }));
    const since = (views.messages as { taken: { since?: string } | null }[])[0]?.taken?.since;
    assert.match(since ?? '', /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(views, {
      workspace: 'acme',
      messages: [
        { id: `${C1}/${REPLY}`, taken: { state: 'taken', by: 'another session', since } },
        { id: `${C1}/${PARENT}`, taken: null },
      ],
    });
    for (const said of [JSON.stringify(refused), JSON.stringify(views)]) {
      for (const field of BOB_FIELDS) assert.equal(said.includes(field), false, `${field} reached the agent`);
    }
  } finally {
    await close();
  }
});

test('hand back with a closed reason and a note for the person; done keeps others refused', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const back = ok(
      await call('slack_take', {
        workspace: 'acme',
        channel: C1,
        ts: REPLY,
        step: 'hand-back',
        reason: 'not-mine',
        note: 'about billing',
      }),
    );
    assert.deepEqual(
      { state: back.state, you: back.you, taken: back.taken },
      {
        state: 'open',
        you: false,
        taken: { state: 'open', handedBack: ['not-mine'] },
      },
    );
    assert.equal(JSON.stringify(back).includes('billing'), false, 'the note is the person’s alone');
    const noReason = failure(
      await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY, step: 'hand-back' }),
    );
    assert.equal(noReason.code, 'USAGE');
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const done = ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY, step: 'done' }));
    assert.equal(done.state, 'done');
    await assert.rejects(harness.core.takes.take(message(account.id, C1, REPLY), BOB), { code: 'TAKEN_ELSEWHERE' });
  } finally {
    await close();
  }
});

test('the tools take no argument naming a session: `session` and `key` are refused', async () => {
  const { harness } = await workspace();
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    for (const extra of [{ session: BOB.sessionId }, { key: BOB.key }]) {
      const take = failure(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY, ...extra }));
      assert.equal(take.code, 'USAGE');
      const taken = failure(await call('slack_taken', { workspace: 'acme', ...extra }));
      assert.equal(taken.code, 'USAGE');
    }
    assert.deepEqual(await harness.core.takes.list(), []);
  } finally {
    await close();
  }
});

test('slack_taken with no messages lists this session’s own takes, and not another’s', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  await harness.core.takes.take(message(account.id, D1, DM_NEW), BOB);
  const { call, close } = await connect(harness, fake.read);
  try {
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const mine = ok(await call('slack_taken', { workspace: 'acme' }));
    assert.deepEqual(
      (mine.messages as { id: string; taken: { by: string } }[]).map((each) => [each.id, each.taken.by]),
      [[`${C1}/${REPLY}`, 'you']],
    );
  } finally {
    await close();
  }
});

// ── The gates ─────────────────────────────────────────────────────────────────────────────────────────────────

test('with a take required, a reaction is refused until this session takes the message, and then made', async () => {
  const { harness } = await workspace({ required: true });
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const refused = failure(await call('slack_react', { workspace: 'acme', channel: C1, ts: REPLY, emoji: 'eyes' }));
    assert.equal(refused.code, 'TAKE_REQUIRED');
    assert.deepEqual(refused.details, { reason: 'NOT_TAKEN', act: 'slack.react', message: `${C1}/${REPLY}` });
    assert.match(refused.hint ?? '', /slack_take \(step "take"\)/);
    assert.equal(fake.count('reactions.add'), 0);
    assert.equal((await harness.core.approvals.list()).length, 0, 'no approval was made');
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    ok(await call('slack_react', { workspace: 'acme', channel: C1, ts: REPLY, emoji: 'eyes' }));
    assert.equal(fake.count('reactions.add'), 1);
  } finally {
    await close();
  }
});

test('a take released between the prepare and the claim stops the reaction: nothing is sent', async () => {
  const { harness, account } = await workspace({ required: true, policy: 'confirm' });
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const waiting = failure(await call('slack_react', { workspace: 'acme', channel: C1, ts: REPLY, emoji: 'eyes' }));
    assert.equal(waiting.code, 'APPROVAL_PENDING');
    const approvalId = String(waiting.details?.approvalId);
    const [record] = await harness.core.takes.list();
    assert.ok(record !== undefined && 'record' in record);
    assert.deepEqual(record.record.pins, [approvalId], 'the take is pinned while its approval waits');
    const approved = await cli(harness, ['approve', approvalId], fake.read, { person: true });
    assert.equal(approved.code, EXIT_CODES.OK, approved.stdout + approved.stderr);
    await harness.core.takes.release(message(account.id, C1, REPLY), TERMINAL);
    await harness.core.takes.take(message(account.id, C1, REPLY), BOB);
    const refused = failure(
      await call('slack_react_send', { workspace: 'acme', channel: C1, ts: REPLY, emoji: 'eyes', approvalId }),
    );
    assert.equal(refused.code, 'TAKEN_ELSEWHERE');
    assert.equal(fake.count('reactions.add'), 0, 'nothing was sent');
  } finally {
    await close();
  }
});

test('a post in a thread needs the take of the newest message from someone else there, at prepare and at the claim', async () => {
  const { harness, account } = await workspace({ required: true });
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const post = { workspace: 'acme', channel: C1, text: 'on it', threadTs: PARENT };
    const refused = failure(await call('slack_post_prepare', post));
    assert.equal(refused.code, 'TAKE_REQUIRED');
    // Their reply, not ours after it, and not the parent.
    assert.deepEqual(refused.details, { reason: 'NOT_TAKEN', act: 'slack.post.prepare', message: `${C1}/${REPLY}` });
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const prepared = ok(await call('slack_post_prepare', post));
    assert.match(String((prepared.preview as { taken?: string }).taken), /^Taken by this session at \d\d:\d\d\.$/);
    const { draftId, approvalId } = prepared as { draftId: string; approvalId: string };
    // Released by the person in between: nothing is posted.
    await harness.core.takes.release(message(account.id, C1, REPLY), TERMINAL);
    const stopped = failure(
      await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: C1 }),
    );
    assert.equal(stopped.code, 'TAKE_REQUIRED');
    assert.equal(stopped.details?.act, 'slack.post.send');
    assert.equal(fake.count('chat.postMessage'), 0, 'nothing was posted');
    // Taken again, the same approval posts.
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    ok(await call('slack_post_send', { workspace: 'acme', draftId, approvalId, expectChannel: C1 }));
    assert.equal(fake.count('chat.postMessage'), 1);
  } finally {
    await close();
  }
});

test('a top-level post in a DM is gated by the newest message from someone else; a channel post and an edit are not', async () => {
  const { harness } = await workspace({ required: true });
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const dm = failure(await call('slack_post_prepare', { workspace: 'acme', channel: D1, text: 'hi' }));
    assert.equal(dm.code, 'TAKE_REQUIRED');
    assert.equal(dm.details?.message, `${D1}/${DM_NEW}`, 'theirs, not ours after it');
    const history = fake.count('conversations.history');
    ok(await call('slack_post_prepare', { workspace: 'acme', channel: C1, text: 'announcement' }));
    assert.equal(fake.count('conversations.history'), history, 'a channel post reads nothing for a take');
    const edit = await call('slack_edit_prepare', { workspace: 'acme', channel: C1, ts: MINE, text: 'ours, edited' });
    if (edit.isError === true) assert.notEqual(failure(edit).code, 'TAKE_REQUIRED', 'an edit answers nobody');
    ok(await call('slack_take', { workspace: 'acme', channel: D1, ts: DM_NEW }));
    ok(await call('slack_post_prepare', { workspace: 'acme', channel: D1, text: 'hi' }));
  } finally {
    await close();
  }
});

test('with no take required nothing is demanded, but another session’s take is still respected', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    ok(await call('slack_post_prepare', { workspace: 'acme', channel: D1, text: 'hi' }));
    assert.equal(fake.count('conversations.history'), 0, 'with no take anywhere, Slack is asked nothing more');
    ok(await call('slack_react', { workspace: 'acme', channel: C1, ts: REPLY, emoji: 'eyes' }));
    await harness.core.takes.take(message(account.id, D1, DM_NEW), BOB);
    await harness.core.takes.take(message(account.id, C1, PARENT), BOB);
    const dm = failure(await call('slack_post_prepare', { workspace: 'acme', channel: D1, text: 'hi' }));
    assert.equal(dm.code, 'TAKEN_ELSEWHERE');
    const reaction = failure(await call('slack_react', { workspace: 'acme', channel: C1, ts: PARENT, emoji: 'eyes' }));
    assert.equal(reaction.code, 'TAKEN_ELSEWHERE');
    for (const field of BOB_FIELDS) assert.equal(JSON.stringify([dm, reaction]).includes(field), false);
    ok(await call('slack_post_prepare', { workspace: 'acme', channel: C1, text: 'announcement' }));
  } finally {
    await close();
  }
});

test('an acknowledgement needs the take of its message, refused before anything is read or counted', async () => {
  const { harness } = await workspace({ required: true });
  const fake = fakeSlack();
  const { call, close } = await connect(harness, fake.read);
  try {
    const refused = failure(
      await call('slack_ack', {
        workspace: 'acme',
        standingId: 'ap_00000000000000000000000000',
        channel: C1,
        ts: REPLY,
        content: 'a'.repeat(64),
      }),
    );
    assert.equal(refused.code, 'TAKE_REQUIRED');
    assert.equal(refused.details?.act, 'slack.ack');
    assert.equal(fake.count('conversations.replies'), 0, 'nothing was read');
  } finally {
    await close();
  }
});

// ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('slack_read, slack_thread and slack_search say who has each message, in closed words', async () => {
  const { harness, account } = await workspace();
  const fake = fakeSlack();
  await harness.core.takes.take(message(account.id, C1, PARENT), BOB);
  const { call, close } = await connect(harness, fake.read);
  try {
    ok(await call('slack_take', { workspace: 'acme', channel: C1, ts: REPLY }));
    const thread = ok(await call('slack_thread', { workspace: 'acme', channel: C1, ts: PARENT }));
    const parent = thread.parent as { taken: Raw };
    const replies = thread.replies as { message: { ts: string }; taken: Raw | null }[];
    assert.equal(parent.taken.by, 'another session');
    assert.deepEqual(
      replies.map((row) => [row.message.ts, row.taken === null ? null : row.taken.by]),
      [
        [REPLY, 'you'],
        [MY_REPLY, null],
      ],
    );
    const read = ok(await call('slack_read', { workspace: 'acme', channel: C1 }));
    const rows = read.rows as { message: { ts: string }; taken: Raw | null }[];
    assert.equal(rows.find((row) => row.message.ts === PARENT)?.taken?.by, 'another session');
    assert.equal(rows.find((row) => row.message.ts === MINE)?.taken, null);
    for (const field of BOB_FIELDS) assert.equal(JSON.stringify([thread, read]).includes(field), false);
  } finally {
    await close();
  }
});

// ── The person at a terminal ──────────────────────────────────────────────────────────────────────────────────

test('at your own terminal, take refuses and points at takes keep; taken answers in the same words', async () => {
  const { harness, account } = await workspace({ required: true });
  const fake = fakeSlack();
  await harness.core.takes.take(message(account.id, C1, REPLY), BOB);
  const take = await cli(harness, ['--json', 'take', '--workspace', 'acme', C1, PARENT], fake.read);
  assert.equal(take.code, EXIT_CODES.USAGE, take.stdout + take.stderr);
  assert.match(take.json<{ error: { hint: string } }>().error.hint, /takes keep/);
  const taken = await cli(harness, ['--json', 'taken', '--workspace', 'acme', `${C1}/${REPLY}`], fake.read);
  assert.equal(taken.code, EXIT_CODES.OK, taken.stdout + taken.stderr);
  const data = taken.json<{ data: { messages: { taken: { by: string } }[] } }>().data;
  assert.equal(data.messages[0]?.taken.by, 'another session');
  // The person is never held to taking: a reaction from their terminal goes on a yes there.
  const react = await cli(
    harness,
    ['--json', 'react', '--workspace', 'acme', '--channel', C1, '--ts', PARENT, '--emoji', 'eyes'],
    fake.read,
  );
  assert.equal(react.code, EXIT_CODES.OK, react.stdout + react.stderr);
});
