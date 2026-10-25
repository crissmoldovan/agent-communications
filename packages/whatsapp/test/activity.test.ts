import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { ActivityLine } from '@agentcomms/core';
import { WITHHELD } from '../src/activity.ts';
import {
  ALICE,
  BOB,
  BROADCAST_LIST,
  buildFixtureStore,
  CAROL,
  DAVE,
  ERIN,
  ERIN_STATUS,
  GROUP,
  HIDDEN,
  HOSTILE,
  HOSTILE_GROUP,
  MESSAGES,
} from './support/fixture.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { ACCOUNT, type Call, connect, NOBODY, person } from './support/surfaces.ts';

/*
 * 0.29.0 Task 2b (design 2026-10-25-activity, S4): WhatsApp records what each call did in core's activity log as counts
 * and nothing else — never a chat's id, a name, a number, a message or the words searched for — on the command line
 * and over MCP alike. Every test runs on a temporary home with the synthetic store; the lines are read back raw.
 */

/** A read of one chat, as the line names it. */
const READ = { operation: 'whatsapp.read', kind: 'read' } as const;

/** What a draft says: a sentence no line may hold. */
const DRAFT_TEXT = 'see you at the corner cafe at noon';

/** Every fixture chat's id, every number in them, and every name a chat or a member goes by. */
const IDENTITIES: readonly string[] = [
  ALICE,
  BOB,
  CAROL,
  DAVE,
  ERIN,
  ERIN_STATUS,
  GROUP,
  HOSTILE_GROUP,
  HIDDEN,
  BROADCAST_LIST,
  NOBODY,
  ...[ALICE, BOB, CAROL, DAVE, ERIN, NOBODY].map((id) => id.split('@')[0] as string),
  '100000000000001',
  '120363000000000001',
  '1690000000',
  'Alice Example',
  'Project Test',
  'Hidden Number Test',
  'Broadcast Test',
  'Bobby Test',
  'Carol Example',
  'Carol',
  HOSTILE.groupName,
  HOSTILE.pushName,
];

/** Every message text in the fixture, and the words searched for. */
const CONTENTS: readonly string[] = [
  ...MESSAGES.flatMap((row) => (typeof row.ZTEXT === 'string' ? [row.ZTEXT] : [])),
  DRAFT_TEXT,
  'quarterly',
  'Thursday',
];

interface World {
  readonly harness: Harness;
  readonly call: Call;
  readonly accountId: string;
  lines(): ActivityLine[];
  raw(): string;
  added<T>(run: () => Promise<T>): Promise<{ result: T; lines: ActivityLine[] }>;
}

async function world(t: TestContext): Promise<World> {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const { call, close } = await connect(harness);
  t.after(close);
  const folder = join(String(harness.env.AGENT_COMMS_STATE_DIR), 'activity');
  const raw = () =>
    (existsSync(folder) ? readdirSync(folder).filter((name) => name.endsWith('.jsonl')) : [])
      .sort()
      .map((name) => readFileSync(join(folder, name), 'utf8'))
      .join('');
  const lines = () =>
    raw()
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ActivityLine);
  return {
    harness,
    call,
    accountId: harness.coreConfig().accounts[ACCOUNT]?.id as string,
    lines,
    raw,
    async added(run) {
      const before = lines().length;
      const result = await run();
      return { result, lines: lines().slice(before) };
    },
  };
}

/** The fields a WhatsApp line may have: no item, no count of things listed, no query. */
const LINE_FIELDS = ['at', 'channel', 'account', 'operation', 'kind', 'outcome', 'reason', 'session', 'ms', 'counts'];

/** The one line a call added, as S4 has it. */
function one(
  w: World,
  lines: ActivityLine[],
  expected: { operation: string; kind: string; outcome: string; surface: string; account?: string },
): ActivityLine {
  assert.equal(lines.length, 1, `${expected.operation} over ${expected.surface}: ${JSON.stringify(lines)}`);
  const [line] = lines as [ActivityLine];
  assert.deepEqual(
    [line.channel, line.operation, line.kind, line.outcome, line.session.surface],
    ['whatsapp', expected.operation, expected.kind, expected.outcome, expected.surface],
    JSON.stringify(line),
  );
  // A call over several accounts is one line, their names joined, with no id.
  const several = expected.account?.includes(',') === true;
  assert.deepEqual(line.account, { id: several ? '' : w.accountId, alias: expected.account ?? ACCOUNT });
  for (const field of Object.keys(line)) {
    assert.ok(LINE_FIELDS.includes(field), `a WhatsApp line holds "${field}": ${JSON.stringify(line)}`);
  }
  return line;
}

test('every read and the draft record one line on each surface, with counts of chats and messages and nothing else', async (t) => {
  const w = await world(t);
  const rows: {
    operation: string;
    kind: 'read' | 'approval';
    argv: string[];
    tool: string;
    args: Record<string, unknown>;
    counts: (data: Record<string, unknown>) => Record<string, number>;
  }[] = [
    {
      operation: 'whatsapp.sync',
      kind: 'read',
      argv: ['sync', '--account', ACCOUNT],
      tool: 'whatsapp_sync',
      args: { account: ACCOUNT },
      counts: (data) => ({ chats: data.chats as number, messages: data.messages as number }),
    },
    {
      operation: 'whatsapp.chats',
      kind: 'read',
      argv: ['chats', '--account', ACCOUNT],
      tool: 'whatsapp_chats',
      args: { account: ACCOUNT },
      counts: (data) => ({ chats: (data.chats as unknown[]).length }),
    },
    {
      operation: 'whatsapp.read',
      kind: 'read',
      argv: ['read', ALICE, '--account', ACCOUNT],
      tool: 'whatsapp_read',
      args: { account: ACCOUNT, chat: ALICE },
      counts: (data) => ({ chats: 1, messages: (data.messages as unknown[]).length }),
    },
    {
      operation: 'whatsapp.search',
      kind: 'read',
      argv: ['search', 'quarterly report', '--account', ACCOUNT],
      tool: 'whatsapp_search',
      args: { account: ACCOUNT, query: 'quarterly report' },
      counts: (data) => {
        const results = data.results as { chat: { id: string } }[];
        return { chats: new Set(results.map((hit) => hit.chat.id)).size, messages: results.length };
      },
    },
    {
      operation: 'whatsapp.draft',
      kind: 'approval',
      argv: ['draft', ALICE, DRAFT_TEXT, '--account', ACCOUNT],
      tool: 'whatsapp_draft',
      args: { account: ACCOUNT, to: ALICE, text: DRAFT_TEXT },
      counts: () => ({ chats: 1, messages: 1 }),
    },
  ];
  for (const row of rows) {
    const command = await w.added(() => w.harness.cli([...row.argv, '--json']));
    assert.equal(command.result.code, 0, command.result.stdout);
    const fromCli = one(w, command.lines, { ...row, outcome: 'ok', surface: 'cli' });
    assert.deepEqual(fromCli.counts, row.counts(command.result.data()), row.operation);

    const tool = await w.added(() => w.call(row.tool, row.args));
    assert.notEqual(tool.result.isError, true, JSON.stringify(tool.result.structuredContent));
    const fromMcp = one(w, tool.lines, { ...row, outcome: 'ok', surface: 'mcp' });
    assert.deepEqual(fromMcp.counts, row.counts(tool.result.structuredContent), row.operation);
    assert.deepEqual(fromMcp.session.client, { name: 'test', version: '0' }, 'what the client said it is');
    // This package starts no process, so it cannot read its parent's start: each process is a session of its own.
    assert.deepEqual([fromCli.session.grouped, fromMcp.session.grouped], [false, false]);
    assert.equal(fromMcp.session.key, fromCli.session.key, 'one process, one session');
  }
  // Something was counted: a line of zeros everywhere would pass the shape and say nothing.
  assert.ok(w.lines().some((line) => (line.counts?.messages ?? 0) > 1));
});

test('a refusal or a failure keeps its code and none of its words: the chat it named is not in the line', async (t) => {
  const w = await world(t);
  const withheld = (code: string) => `${code}: ${WITHHELD}`;

  // A chat that is not there: its id is in the error, and not in the line.
  const command = await w.added(() => w.harness.cli(['read', NOBODY, '--account', ACCOUNT, '--json']));
  assert.equal(command.result.code, 66, command.result.stdout);
  assert.ok(String(command.result.json().error?.message).includes(NOBODY), 'the error itself still says which');
  assert.equal(one(w, command.lines, { ...READ, outcome: 'failed', surface: 'cli' }).reason, withheld('NOT_FOUND'));
  const tool = await w.added(() => w.call('whatsapp_read', { account: ACCOUNT, chat: NOBODY }));
  assert.equal(tool.result.isError, true);
  assert.equal(one(w, tool.lines, { ...READ, outcome: 'failed', surface: 'mcp' }).reason, withheld('NOT_FOUND'));

  // A number that is not one: refused for its form, and the number typed is not in the line either.
  const typed = await w.added(() => w.call('whatsapp_read', { account: ACCOUNT, chat: '07700 900123' }));
  assert.equal(typed.result.isError, true);
  assert.equal(one(w, typed.lines, { ...READ, outcome: 'refused', surface: 'mcp' }).reason, withheld('USAGE'));

  // A chat the person denies is answered as absent from then on, and its lines say no more than that.
  await person(w.harness, 'deny', ALICE);
  for (const surface of ['cli', 'mcp'] as const) {
    const read = await w.added<unknown>(() =>
      surface === 'cli'
        ? w.harness.cli(['read', ALICE, '--account', ACCOUNT, '--json'])
        : w.call('whatsapp_read', { account: ACCOUNT, chat: ALICE }),
    );
    assert.equal(one(w, read.lines, { ...READ, outcome: 'failed', surface }).reason, withheld('NOT_FOUND'));
    const drafted = await w.added<unknown>(() =>
      surface === 'cli'
        ? w.harness.cli(['draft', ALICE, DRAFT_TEXT, '--account', ACCOUNT, '--json'])
        : w.call('whatsapp_draft', { account: ACCOUNT, to: ALICE, text: DRAFT_TEXT }),
    );
    const line = one(w, drafted.lines, { operation: 'whatsapp.draft', kind: 'approval', outcome: 'failed', surface });
    assert.equal(line.reason, withheld('NOT_FOUND'));
    assert.equal(line.counts, undefined, 'a refused draft counts nothing');
    const searched = await w.added<unknown>(() =>
      surface === 'cli'
        ? w.harness.cli(['search', 'Thursday', '--account', ACCOUNT, '--json'])
        : w.call('whatsapp_search', { account: ACCOUNT, query: 'Thursday' }),
    );
    assert.deepEqual(
      one(w, searched.lines, { operation: 'whatsapp.search', kind: 'read', outcome: 'ok', surface }).counts,
      { chats: 0, messages: 0 },
      'nothing of the hidden chat is counted',
    );
  }
});

test('a draft that names no account is recorded under the only account, or as one line over all of several', async (t) => {
  const w = await world(t);
  const lone = await w.added(() => w.call('whatsapp_draft', { to: ALICE, text: DRAFT_TEXT }));
  assert.notEqual(lone.result.isError, true, JSON.stringify(lone.result.structuredContent));
  one(w, lone.lines, { operation: 'whatsapp.draft', kind: 'approval', outcome: 'ok', surface: 'mcp' });

  const business = await buildFixtureStore(join(w.harness.root, 'business'));
  const added = await w.harness.cli(['add', 'biz/whatsapp', '--source', business.path, '--json'], {
    env: w.harness.personEnv,
  });
  assert.equal(added.code, 0, added.stdout);
  const either = await w.added(() => w.harness.cli(['draft', ALICE, DRAFT_TEXT, '--json']));
  assert.equal(either.result.code, 0, either.result.stdout);
  one(w, either.lines, {
    operation: 'whatsapp.draft',
    kind: 'approval',
    outcome: 'ok',
    surface: 'cli',
    account: `${ACCOUNT},biz/whatsapp`,
  });
});

test('status and the person’s own commands record nothing: they read no chat for an agent', async (t) => {
  const w = await world(t);
  for (const argv of [
    ['status', '--no-check'],
    ['status', '--account', ACCOUNT],
  ]) {
    const ran = await w.added(() => w.harness.cli([...argv, '--json']));
    assert.equal(ran.result.code, 0, ran.result.stdout);
    assert.deepEqual(ran.lines, [], argv.join(' '));
  }
  const tool = await w.added(() => w.call('whatsapp_status', { check: false }));
  assert.notEqual(tool.result.isError, true);
  assert.deepEqual(tool.lines, []);
  for (const argv of [['allow', BOB], ['deny', CAROL], ['clear', BOB], ['clear']]) {
    const ran = await w.added(() => person(w.harness, ...argv));
    assert.ok(ran.result);
    assert.deepEqual(ran.lines, [], argv.join(' '));
  }
  const removed = await w.added(() => w.harness.cli(['remove', ACCOUNT, '--json'], { env: w.harness.personEnv }));
  assert.equal(removed.result.code, 0, removed.result.stdout);
  assert.deepEqual(removed.lines, []);
});

test('after every call, the activity file holds none of a fixture chat’s id, name or number, and no message', async (t) => {
  const w = await world(t);
  const reads: [string[], string, Record<string, unknown>][] = [
    [['sync', '--account', ACCOUNT], 'whatsapp_sync', { account: ACCOUNT }],
    [['chats', '--account', ACCOUNT], 'whatsapp_chats', { account: ACCOUNT }],
    [['chats', '--account', ACCOUNT, '--kind', 'status'], 'whatsapp_chats', { account: ACCOUNT, kind: 'status' }],
    ...[ALICE, BOB, GROUP, HIDDEN, HOSTILE_GROUP, BROADCAST_LIST, ERIN_STATUS].map(
      (chat): [string[], string, Record<string, unknown>] => [
        ['read', chat, '--account', ACCOUNT],
        'whatsapp_read',
        { account: ACCOUNT, chat },
      ],
    ),
    [['read', NOBODY, '--account', ACCOUNT], 'whatsapp_read', { account: ACCOUNT, chat: NOBODY }],
    [['read', '+1 555 555 0101', '--account', ACCOUNT], 'whatsapp_read', { account: ACCOUNT, chat: '+1 555 555 0101' }],
    [['search', 'quarterly', '--account', ACCOUNT], 'whatsapp_search', { account: ACCOUNT, query: 'quarterly' }],
    [
      ['search', 'Thursday', '--account', ACCOUNT, '--chat', ALICE],
      'whatsapp_search',
      { account: ACCOUNT, query: 'Thursday', chat: ALICE },
    ],
    [
      ['search', 'report', '--account', ACCOUNT, '--sender', 'Bobby Test'],
      'whatsapp_search',
      { account: ACCOUNT, query: 'report', sender: 'Bobby Test' },
    ],
    [
      ['draft', ALICE, DRAFT_TEXT, '--account', ACCOUNT],
      'whatsapp_draft',
      { account: ACCOUNT, to: ALICE, text: DRAFT_TEXT },
    ],
    [
      ['draft', GROUP, DRAFT_TEXT, '--account', ACCOUNT],
      'whatsapp_draft',
      { account: ACCOUNT, to: GROUP, text: DRAFT_TEXT },
    ],
  ];
  for (const [argv, tool, args] of reads) {
    await w.harness.cli([...argv, '--json']);
    await w.call(tool, args);
  }
  // Once more after the person hides a chat, so a refusal of a hidden one is in the file too.
  await person(w.harness, 'deny', BOB);
  await w.harness.cli(['read', BOB, '--account', ACCOUNT, '--json']);
  await w.call('whatsapp_read', { account: ACCOUNT, chat: BOB });

  const raw = w.raw();
  assert.ok(w.lines().length >= reads.length * 2, `every call wrote its line: ${w.lines().length}`);
  for (const identity of IDENTITIES) {
    assert.ok(!raw.includes(identity), `"${identity}" is in the activity file`);
  }
  for (const words of CONTENTS) assert.ok(!raw.includes(words), `"${words}" is in the activity file`);
  assert.ok(
    w.lines().every((line) => line.items === undefined && line.query === undefined),
    'no line lists an item or a query',
  );
});
