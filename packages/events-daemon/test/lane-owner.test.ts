import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { emptyConfig } from '@agentcomms/core';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import type { LaneWindowIdentity } from '../src/domain/lanes.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { type RawClient, type RawMessage, rawClient, resultText } from './support/raw-mcp.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/**
 * Routing's first slice end to end, through a real owner (routing design 2026-10-25): a fake Gmail mailbox, a lane the
 * person approves, an agent window the person binds at a terminal, and that window woken by an MCP task with a
 * pointer, reading the item through `events_lane_item`. A second window is bound to nothing and learns nothing.
 * Every sender-written value is a marker the window-facing wire is scanned for.
 */

const ACCOUNT = 'ibx_LANEOWNERLANE001';
const ALIAS = 'events/gmail';
const RULE = 'david-by-mail';
const DAY = 86_400_000;
const SENDER = 'david.sender@example.test';
const SENDER_NAME = 'David Sender';

const DAVID: LaneWindowIdentity = {
  sessionId: '25f971a3-0c69-44e3-971c-3a4656afa986',
  activityKey: '0123456789abcdef',
  grouped: true,
  folder: '/example/home/work/david-project',
  client: { name: 'claude-code', version: '2.1.310' },
};
const OTHER: LaneWindowIdentity = {
  sessionId: 'f9423d69-c1d7-45a2-a979-a4343c34477f',
  activityKey: 'fedcba9876543210',
  grouped: true,
  folder: '/example/home/work/other-project',
  client: { name: 'claude-code', version: '2.1.310' },
};
const UNGROUPED: LaneWindowIdentity = {
  sessionId: null,
  activityKey: 'aaaaaaaaaaaaaaaa',
  grouped: false,
  folder: '/example/home',
  client: { name: 'cursor', version: '1.0' },
};

const retention = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
  queueMs: 7 * DAY,
};

const lane = (version: number, show = 'summary') => ({
  targetId: 'lane-david',
  version,
  kind: 'queue',
  retentionMs: 7 * DAY,
  show,
  lane: { name: 'david' },
});
const dryRun = { targetId: 'dry-david', version: 1, kind: 'dry-run', retentionMs: DAY };

const rule = (version: number, targets: readonly Record<string, unknown>[]) => ({
  ruleId: RULE,
  version,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: {
    from: { $path: '/from' },
    subject: { $path: '/subject' },
    snippet: { $path: '/snippet' },
    messageId: { $path: '/messageId' },
  },
  targets,
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  // A rule binds queueMs exactly when it has a queue target (action queue Q2).
  retention: targets.some((target) => target.kind === 'queue')
    ? retention
    : Object.fromEntries(Object.entries(retention).filter(([key]) => key !== 'queueMs')),
});

async function cli(stateDir: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}) {
  // `lane bind` is a person's, at an interactive terminal, who types the lane's name: the test is that person.
  const binding = argv[0] === 'lane' && argv[1] === 'bind';
  const stdin = Object.assign(new PassThrough(), { isTTY: binding });
  if (binding) stdin.write(`${argv[2]}\n`);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(['--state-dir', stateDir, ...argv], {
    env,
    streams: {
      stdin,
      stdout: Object.assign(stdout, { isTTY: binding }),
      stderr: Object.assign(stderr, { isTTY: binding }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

interface Mailbox {
  /** Delivers a new mail with this subject on the owner's next poll. */
  send(subject: string): string;
}

interface Harness {
  readonly stateDir: string;
  readonly control: EventControlClient;
  readonly mailbox: Mailbox;
  readonly tick: () => Promise<void>;
  readonly window: (identity: LaneWindowIdentity) => Promise<RawClient>;
  readonly approve: (ruleVersion: number) => Promise<void>;
  readonly openCount: () => Promise<number>;
}

async function withOwner(work: (harness: Harness) => Promise<void>): Promise<void> {
  const root = await shortTempDir('aev-lane-owner-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes[ALIAS] = {
    id: ACCOUNT,
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT}`,
    internalDomains: [],
    createdAt: '2026-10-26T08:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const selected = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(selected.database, 'file');
  } finally {
    selected.close();
  }
  let history = 1;
  const pending: string[] = [];
  const messages = new Map<string, { subject: string; internalDate: string }>();
  let sequence = 0;
  const mailbox: Mailbox = {
    send(subject) {
      sequence += 1;
      const id = `g-lane-${String(sequence).padStart(4, '0')}`;
      // Gmail's internal date is when the mail arrived: now, so it is after the binding (B3).
      messages.set(id, { subject, internalDate: String(Date.now()) });
      pending.push(id);
      return id;
    },
  };
  const metadata = (id: string) => {
    const message = messages.get(id);
    if (message === undefined) throw new Error(`no fake message ${id}`);
    return {
      id,
      threadId: `${id}-thread`,
      labelIds: ['INBOX'],
      internalDate: message.internalDate,
      snippet: `snippet of ${message.subject}`,
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'Subject', value: message.subject },
          { name: 'From', value: `"${SENDER_NAME}" <${SENDER}>` },
        ],
      },
    };
  };
  const owner = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir,
    tickMs: 60_000,
    pollIntervalMs: 1,
    gmailSourceFor: async () =>
      ({
        inboxId: ACCOUNT,
        getProfile: async () => ({ historyId: String(history) }),
        listHistory: async () => {
          if (pending.length === 0) return { historyId: String(history), nextPageToken: undefined, history: [] };
          const added = pending.splice(0);
          history += 1;
          return {
            historyId: String(history),
            nextPageToken: undefined,
            history: [
              {
                id: String(history),
                messagesAdded: added.map((id) => ({ message: { id, threadId: `${id}-thread` } })),
                labelsAdded: [],
                labelsRemoved: [],
              },
            ],
          };
        },
        getMessageMetadata: async (id: string) => metadata(id),
        getMessage: async (id: string) => metadata(id),
      }) as never,
  });
  const control = new EventControlClient({ stateDir, clientName: 'events-lane-owner-e2e' });
  const opened: Array<() => Promise<void>> = [];
  const harness: Harness = {
    stateDir,
    control,
    mailbox,
    tick: () => owner.tick(),
    async window(identity) {
      const events = await createEventsMcpServer({ stateDir, window: async () => identity, progressIntervalMs: 50 });
      const [client, server] = InMemoryTransport.createLinkedPair();
      const handle = await events.serve(server);
      const raw = await rawClient(client);
      opened.push(async () => {
        await raw.close();
        await handle.close();
      });
      await raw.request('server/discover');
      return raw;
    },
    async approve(ruleVersion) {
      const planned = (await control.request('rule-enable', { ruleId: RULE, version: ruleVersion })) as {
        approvalId?: string;
      };
      if (planned.approvalId === undefined) return;
      const challenge = (await control.request('approve-challenge', { approvalId: planned.approvalId })) as string;
      try {
        await control.request('approve', { approvalId: planned.approvalId, answer: challenge });
      } catch (error) {
        // An exact replacement drains the old version before it swaps (D2): the owner's ticks finish it.
        if (!/still draining/u.test(String(error))) throw error;
      }
    },
    async openCount() {
      return ((await control.request('queue-counts')) as { open: number }).open;
    },
  };
  try {
    await work(harness);
  } finally {
    for (const close of opened) await close();
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function tool(
  client: RawClient,
  name: string,
  args: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
) {
  return client.request('tools/call', { name, arguments: args, _meta: meta });
}

function structured(message: RawMessage): Record<string, unknown> {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.notEqual(message.result?.isError, true, resultText(message));
  return message.result?.structuredContent as Record<string, unknown>;
}

async function deliver(harness: Harness, subject: string): Promise<void> {
  const before = await harness.openCount();
  harness.mailbox.send(subject);
  for (let index = 0; index < 10; index += 1) {
    await harness.tick();
    if ((await harness.openCount()) > before) return;
  }
  assert.fail(`the mail "${subject}" never became a queue item`);
}

async function setUp(harness: Harness, targets: readonly Record<string, unknown>[]): Promise<void> {
  for (const target of targets) await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document: rule(1, targets) });
  await harness.approve(1);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

test('LANE-E: a bound window is woken by a new item with a pointer and no sender text, and reads it through events_lane_item; an unbound window learns nothing', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    const whoami = structured(await tool(david, 'events_lane_whoami'));
    t.diagnostic(`events_lane_whoami: ${JSON.stringify(whoami)}`);
    assert.equal(whoami.bindWith, DAVID.sessionId);
    assert.equal(whoami.identifiable, true);
    assert.equal(whoami.lane, null);
    structured(await tool(other, 'events_lane_whoami'));

    // An item that arrives before the binding stays out of reach (B3).
    await deliver(harness, 'Before binding: the old contract');

    const listed = await cli(harness.stateDir, ['lane', 'list', '--json']);
    assert.equal(listed.code, 0, listed.err);
    t.diagnostic(`lane list --json (unbound): ${listed.out.trim()}`);
    const bound = await cli(harness.stateDir, [
      'lane',
      'bind',
      'david',
      '--window',
      DAVID.sessionId as string,
      '--json',
    ]);
    assert.equal(bound.code, 0, bound.err);
    t.diagnostic(`lane bind --json: ${bound.out.trim()}`);
    const binding = JSON.parse(bound.out) as {
      lane: string;
      binding: { window: Record<string, unknown>; since: string };
    };
    assert.equal(binding.lane, 'david');
    assert.deepEqual(binding.binding.window, {
      sessionId: DAVID.sessionId,
      activityKey: DAVID.activityKey,
      folder: DAVID.folder,
      folderShown: DAVID.folder,
      client: { name: 'claude-code', version: '2.1.310' },
    });
    const relisted = await cli(harness.stateDir, ['lane', 'list', '--json']);
    t.diagnostic(`lane list --json (bound): ${relisted.out.trim()}`);
    const lanes = JSON.parse(relisted.out) as { lanes: Array<Record<string, unknown>> };
    assert.deepEqual(
      lanes.lanes.map((entry) => [entry.name, entry.rules, entry.channels, entry.open]),
      [['david', [{ id: RULE }], ['gmail'], 1]],
    );
    assert.deepEqual((lanes.lanes[0] as { binding: unknown }).binding, binding.binding);
    assert.deepEqual(structured(await tool(david, 'events_lane_list')), {
      lanes: [{ name: 'david', boundToThisWindow: true }],
    });
    assert.deepEqual(structured(await tool(other, 'events_lane_list')), {
      lanes: [{ name: 'david', boundToThisWindow: false }],
    });

    const watch = await tool(david, 'events_watch', { lane: 'david' });
    assert.equal(watch.result?.resultType, 'task', 'the watch answers with a task (§3.4)');
    assert.equal(watch.result?.status, 'working', 'the item from before the binding wakes nothing');
    assert.equal(watch.result?.ttlMs, null, 'a watch never times out by itself');
    const taskId = String(watch.result?.taskId);
    assert.equal((await david.request('tasks/get', { taskId })).result?.status, 'working');

    await deliver(harness, 'Can you sign the David contract by Friday?');
    const done = await david.request('tasks/get', { taskId });
    assert.equal(done.result?.status, 'completed');
    const completed = done.result?.result as { structuredContent: Record<string, unknown> } | undefined;
    assert.ok(completed, 'a completed task carries its result');
    const pointer = completed.structuredContent;
    const text = resultText({ jsonrpc: '2.0', result: completed as Record<string, unknown> });
    t.diagnostic(`the wake's pointer: ${text}`);
    assert.match(
      text,
      /^1 new item in lane david \(Gmail, rule david-by-mail\): read it with events_lane_item, item qi_[0-9A-HJKMNP-TV-Z]{26}\. Then call events_watch for lane david again to keep watching\.$/u,
    );
    const item = String(pointer.item);
    assert.deepEqual(Object.keys(pointer).sort(), ['channel', 'item', 'lane', 'rule', 'text', 'waiting']);

    // The bound window reads it, enveloped; the other window cannot, and is not told it exists.
    const read = structured(await tool(david, 'events_lane_item', { item })) as {
      item: { subject: string; from: { address: string } };
    };
    assert.match(read.item.subject, /^<untrusted-content [\s\S]*Can you sign the David contract by Friday\?/u);
    assert.match(read.item.from.address, new RegExp(SENDER.replaceAll('.', '\\.'), 'u'));
    const unbound = await tool(other, 'events_lane_item', { item });
    assert.equal(unbound.result?.isError, true);
    const missing = await tool(other, 'events_lane_item', { item: 'qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ' });
    assert.equal(
      resultText(unbound),
      resultText(missing),
      'the same refusal for an item that exists and one that does not',
    );
    assert.deepEqual(structured(await tool(other, 'events_queue_items', { state: 'all' })).items, [], 'B4');
    assert.equal((structured(await tool(other, 'events_queue_counts')) as { open: number }).open, 0, 'B4');
    assert.equal((await tool(other, 'events_queue_done', { itemId: item })).result?.isError, true, 'B4');
    assert.match(resultText(await tool(other, 'events_watch', { lane: 'david' })), /not bound to this window/u);
    const ownItems = structured(await tool(david, 'events_queue_items', { state: 'all' })) as {
      items: Array<{ id: string }>;
    };
    assert.deepEqual(
      ownItems.items.map((entry) => entry.id),
      [item],
      'the bound window sees its own lane’s items since the binding, and not the one before it',
    );
    const before = (
      JSON.parse((await cli(harness.stateDir, ['queue', 'items', '--state', 'all', '--json'])).out) as {
        items: Array<{ id: string }>;
      }
    ).items.find((entry) => entry.id !== item);
    assert.ok(before, 'the person sees the item from before the binding');
    const personal = JSON.parse((await cli(harness.stateDir, ['queue', 'list', '--state', 'all', '--json'])).out) as {
      items: Array<{ id: string; lane: string | null }>;
    };
    assert.deepEqual(
      personal.items.map((entry) => entry.lane),
      ['david', 'david'],
      'queue list names each item’s lane, for the app’s lane chip and filter',
    );
    assert.equal((await tool(david, 'events_lane_item', { item: before.id })).result?.isError, true, 'B3');

    // The long-poll: an item wakes it, with a progress heartbeat while it waits; and it ends waiting when time is up.
    const waiting = tool(david, 'events_wait', { lane: 'david', seconds: 20 }, { progressToken: 'wait-1' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await deliver(harness, 'David again: second question');
    const answer = await waiting;
    assert.equal((structured(answer) as { lane: string }).lane, 'david');
    assert.match(resultText(answer), /^1 new item in lane david /u);
    const beats = david.notifications.filter(
      (message) =>
        message.method === 'notifications/progress' &&
        (message.params as { progressToken?: unknown }).progressToken === 'wait-1',
    );
    assert.ok(beats.length >= 1, 'progress while it waited');
    assert.deepEqual(structured(await tool(david, 'events_wait', { lane: 'david', seconds: 1 })), { waiting: true });

    // A wait the client cancels stops its heartbeat and ends its wait in the owner, so it takes no item with it.
    const cancelledId = david.nextId();
    const cancelled = tool(david, 'events_wait', { lane: 'david', seconds: 30 }, { progressToken: 'wait-2' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beatsFor = () =>
      david.notifications.filter(
        (message) =>
          message.method === 'notifications/progress' &&
          (message.params as { progressToken?: unknown }).progressToken === 'wait-2',
      ).length;
    assert.ok(beatsFor() >= 1, 'it was beating while it waited');
    await david.notify('notifications/cancelled', { requestId: cancelledId, reason: 'the person moved on' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const atCancel = beatsFor();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(beatsFor(), atCancel, 'no heartbeat after the cancel');
    void cancelled;
    await deliver(harness, 'David once more: after the cancelled wait');
    assert.match(
      resultText(await tool(david, 'events_watch', { lane: 'david' })),
      /^1 new item in lane david /u,
      'the cancelled wait ended in the owner and took nothing: the next watch wakes on the new item',
    );

    const everything = [...david.wire, ...other.wire]
      .filter((line) => !line.includes('"events_lane_item"') && !line.includes('untrusted-content'))
      .join('\n');
    for (const content of [SENDER, SENDER_NAME, 'David contract', 'second question', 'snippet of', 'once more'])
      assert.ok(!everything.includes(content), `no wake, pointer, list or refusal carries ${content}`);
    assert.ok(!other.wire.join('\n').includes('David contract'), 'the unbound window never saw the content');
  });
});

test('LANE-E: lane bind refuses an ungrouped window; unbind applies at once and cancels the lane’s task; a window unbinds only its own lane', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    const loose = await harness.window(UNGROUPED);
    for (const window of [david, other, loose]) structured(await tool(window, 'events_lane_whoami'));
    const refused = await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', UNGROUPED.activityKey, '--json']);
    assert.equal(refused.code, 64, refused.err);
    assert.match(refused.err, /cannot be told apart/u);
    const unknownLane = await cli(harness.stateDir, ['lane', 'bind', 'nobody', '--window', DAVID.activityKey]);
    assert.equal(unknownLane.code, 66, unknownLane.err);

    assert.equal((await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.activityKey])).code, 0);
    const watch = await tool(david, 'events_watch', { lane: 'david' });
    const taskId = String(watch.result?.taskId);
    assert.match(resultText(await tool(other, 'events_lane_unbind', { lane: 'david' })), /not bound to this window/u);
    assert.equal((await david.request('tasks/get', { taskId })).result?.status, 'working', 'still bound');

    const unbound = await cli(harness.stateDir, ['lane', 'unbind', 'david', '--json']);
    assert.equal(unbound.code, 0, unbound.err);
    assert.deepEqual(JSON.parse(unbound.out), { lane: 'david', unbound: true });
    const cancelled = await david.request('tasks/get', { taskId });
    assert.equal(cancelled.result?.status, 'cancelled', 'a task is cancelled on unbind');
    assert.match(String(cancelled.result?.statusMessage), /unbound/u);
    assert.match(resultText(await tool(david, 'events_watch', { lane: 'david' })), /not bound to this window/u);

    // A window may end its own binding over MCP, at once.
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    assert.deepEqual(structured(await tool(david, 'events_lane_unbind', { lane: 'david' })), {
      lane: 'david',
      unbound: true,
    });
    assert.equal(structured(await tool(david, 'events_lane_whoami')).lane, null);
    // Inside the event service's MCP server, binding is refused before the owner is asked.
    const marked = await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string], {
      AGENTCOMMS_MCP_SERVER: 'events',
    });
    assert.equal(marked.code, 10, marked.err);
  });
});

test('LANE-E: a binding follows its lane across a new approved target version, and ends when no active target carries it (B5)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    const david = await harness.window(DAVID);
    structured(await tool(david, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );

    // A new version of the lane's target, approved through a new rule activation, keeps the binding.
    await harness.control.request('target-update', { document: lane(2, 'minimal') });
    await harness.control.request('rule-update', { document: rule(2, [dryRun, lane(2, 'minimal')]) });
    await harness.approve(2);
    for (let index = 0; index < 10; index += 1) {
      const rules = (await harness.control.request('rules-list')) as Array<{ version: number; state: string | null }>;
      if (rules.some((row) => row.version === 2 && row.state === 'active')) break;
      await harness.tick();
    }
    const rules = (await harness.control.request('rules-list')) as Array<{ version: number; state: string | null }>;
    assert.ok(
      rules.some((row) => row.version === 2 && row.state === 'active'),
      `version 2 became active: ${JSON.stringify(rules)}`,
    );
    assert.equal(structured(await tool(david, 'events_lane_whoami')).lane, 'david', 'the binding followed its lane');
    await deliver(harness, 'After the new target version');
    const woke = await tool(david, 'events_watch', { lane: 'david' });
    assert.match(resultText(woke), /^1 new item in lane david /u, 'the bound window is still woken');

    // Removing the lane's target from the rule is a tightening applied at once: no active rule carries the lane.
    await harness.control.request('rule-update', { document: rule(3, [dryRun]) });
    await harness.approve(3);
    assert.equal(structured(await tool(david, 'events_lane_whoami')).lane, null, 'the binding ended');
    const listed = JSON.parse((await cli(harness.stateDir, ['lane', 'list', '--json'])).out) as { lanes: unknown[] };
    assert.deepEqual(listed.lanes, []);
  });
});

// Review of 0.31.0, finding 5: events_deliveries_list named every lane target's deliveries to every MCP caller.
test('LANE-E: a lane target’s deliveries are listed over MCP only to the window bound to the lane (B4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    for (const window of [david, other]) structured(await tool(window, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    await deliver(harness, 'A delivery the other window must not see listed');
    const targets = (rows: unknown) =>
      [...new Set((rows as Array<{ targetId: string }>).map((row) => row.targetId))].sort();
    const listed = (message: RawMessage) => {
      assert.notEqual(message.result?.isError, true, resultText(message));
      return JSON.parse(resultText(message)) as unknown;
    };
    const person = JSON.parse((await cli(harness.stateDir, ['deliveries', 'list', '--json'])).out) as unknown;
    assert.deepEqual(targets(person), ['dry-david', 'lane-david'], 'the person sees every delivery');
    assert.deepEqual(targets(listed(await tool(david, 'events_deliveries_list'))), ['dry-david', 'lane-david']);
    assert.deepEqual(
      targets(listed(await tool(other, 'events_deliveries_list'))),
      ['dry-david'],
      'a window not bound to the lane sees none of its target’s deliveries',
    );
    // 0.32.0 (§3.5): the rows gain their target's kind, last answer, decision and event, additively; a delivered row
    // has no next try; and the new fields reveal no lane delivery to a window that is not bound to it.
    const shaped = (rows: unknown) =>
      (rows as Array<Record<string, unknown>>)
        .map((row) => ({
          targetId: row.targetId,
          targetKind: row.targetKind,
          state: row.state,
          nextAt: row.nextAt,
          lastErrorCode: row.lastErrorCode,
          lastStatus: row.lastStatus,
          decision: typeof row.decisionId,
          event: typeof row.eventId,
          delivered: typeof row.deliveredAt,
        }))
        .sort((left, right) => String(left.targetId).localeCompare(String(right.targetId)));
    const common = { state: 'delivered', nextAt: null, lastErrorCode: null, lastStatus: null };
    const kinds = { decision: 'string', event: 'string', delivered: 'number' };
    assert.deepEqual(shaped(person), [
      { targetId: 'dry-david', targetKind: 'dry-run', ...common, ...kinds },
      { targetId: 'lane-david', targetKind: 'queue', ...common, ...kinds },
    ]);
    const others = listed(await tool(other, 'events_deliveries_list'));
    assert.deepEqual(shaped(others), [{ targetId: 'dry-david', targetKind: 'dry-run', ...common, ...kinds }]);
    assert.doesNotMatch(JSON.stringify(others), /lane-david|"queue"/u, 'no lane delivery is named to the other window');
  });
});

// Review of 0.31.0, finding 6: activating a rule that adds matches to a bound lane must say which window reads them.
test('LANE-E: the approval preview of a rule sending to a bound lane names the window bound to it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    structured(await tool(david, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    const since = (
      JSON.parse((await cli(harness.stateDir, ['lane', 'list', '--json'])).out) as {
        lanes: Array<{ binding: { since: string } }>;
      }
    ).lanes[0]?.binding.since;
    // A second rule sends more matches to the same lane's target.
    await harness.control.request('rule-create', { document: { ...rule(1, [lane(1)]), ruleId: 'david-again' } });
    const planned = (await harness.control.request('rule-enable', { ruleId: 'david-again', version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const shown = await cli(harness.stateDir, [
      'approval',
      'view',
      planned.approvalId,
      '--digest',
      planned.binding.digest,
    ]);
    assert.equal(shown.code, 0, shown.err);
    assert.match(
      shown.out,
      new RegExp(
        `^Items in lane david will be read by the window bound to it: /example/home/work/david-project \\(claude-code\\), since ${since?.replaceAll('.', '\\.')}\\.$`,
        'mu',
      ),
    );
    assert.doesNotMatch(shown.out, /can be read by the agent window you bind to it/u);
    // Over MCP the same view names no window (B4).
    const viewed = await tool(david, 'events_approval_view', {
      approvalId: planned.approvalId,
      digest: planned.binding.digest,
    });
    assert.doesNotMatch(JSON.stringify(viewed), /david-project|claude-code/u);
  });
});

// 0.32.0 (owner feedback §3.5): one delivery as the person reads it, through a real owner, with no terminal and --json
// as the app runs it. The source ids come from the event's dedupe key; a lane target names its lane.
test('0.32 B3: delivery show --json gives a delivery’s decision, event, source ids and target; an unknown one is 66', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    const messageId = harness.mailbox.send('A delivery the person opens');
    for (let index = 0; index < 10 && (await harness.openCount()) === 0; index += 1) await harness.tick();
    const rows = JSON.parse((await cli(harness.stateDir, ['deliveries', 'list', '--json'])).out) as Array<{
      deliveryId: string;
      targetKind: string;
    }>;
    const dry = rows.find((row) => row.targetKind === 'dry-run')?.deliveryId as string;
    const queued = rows.find((row) => row.targetKind === 'queue')?.deliveryId as string;
    const shown = await cli(harness.stateDir, ['delivery', 'show', dry, '--json']);
    assert.equal(shown.code, 0, shown.err);
    t.diagnostic(`delivery show --json (dry-run): ${shown.out.trim()}`);
    const detail = JSON.parse(shown.out) as {
      delivery: Record<string, unknown>;
      decision: Record<string, unknown>;
      event: Record<string, unknown>;
      target: Record<string, unknown>;
      dryRun: { expiresAt: number | null } | null;
    };
    assert.deepEqual(Object.keys(detail), ['delivery', 'decision', 'event', 'target', 'dryRun']);
    assert.equal(detail.delivery.deliveryId, dry);
    assert.equal(detail.delivery.state, 'delivered');
    assert.equal(detail.delivery.nextAt, null);
    assert.deepEqual({ ...detail.decision, decidedAt: null }, { outcome: 'matched', decidedAt: null, judge: null });
    assert.equal(detail.event.type, 'gmail.message.received');
    assert.equal(detail.event.accountId, ACCOUNT);
    assert.deepEqual(detail.event.source, { channel: 'gmail', messageId });
    assert.deepEqual(detail.target, { kind: 'dry-run', id: 'dry-david', version: 1 });
    assert.equal(typeof detail.dryRun?.expiresAt, 'number');
    assert.doesNotMatch(shown.out, new RegExp(`${SENDER}|${SENDER_NAME}|A delivery the person opens`, 'u'));

    const inLane = JSON.parse((await cli(harness.stateDir, ['delivery', 'show', queued, '--json'])).out) as {
      target: unknown;
      dryRun: unknown;
    };
    assert.deepEqual(inLane.target, { kind: 'queue', id: 'lane-david', version: 1, lane: 'david' });
    assert.equal(inLane.dryRun, null);

    const unknown = await cli(harness.stateDir, ['delivery', 'show', 'delivery-that-never-was', '--json']);
    assert.equal(unknown.code, 66, unknown.err);
    const marked = await cli(harness.stateDir, ['delivery', 'show', dry, '--json'], {
      AGENTCOMMS_MCP_SERVER: 'events',
    });
    assert.equal(marked.code, 10, marked.err);
  });
});

// 0.32.0 (§3.5): the dry-run log as the app reads it, with --json and no terminal, through a real owner. The record comes
// back as data: the would-be CloudEvent parsed, its sender-written fields named in agentcommsuntrusted. The terminal
// view still wraps the record in the untrusted-content envelope.
test('0.32 B4: dryrun list and show --json give the app the log as data; the terminal view keeps the envelope', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    const messageId = harness.mailbox.send('Dry-run subject the app shows as outside text');
    for (let index = 0; index < 10 && (await harness.openCount()) === 0; index += 1) await harness.tick();
    const listed = await cli(harness.stateDir, ['dryrun', 'list', '--json']);
    assert.equal(listed.code, 0, listed.err);
    t.diagnostic(`dryrun list --json: ${listed.out.trim()}`);
    const entries = JSON.parse(listed.out) as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), [
      'accountId',
      'deliveredAt',
      'deliveryId',
      'eventId',
      'expiresAt',
      'ruleId',
      'ruleVersion',
      'targetId',
      'targetVersion',
    ]);
    assert.doesNotMatch(listed.out, /Dry-run subject/u, 'the list is content-free');
    const deliveryId = entries[0]?.deliveryId as string;

    const shown = await cli(harness.stateDir, ['dryrun', 'show', deliveryId, '--json']);
    assert.equal(shown.code, 0, shown.err);
    t.diagnostic(`dryrun show --json: ${shown.out.trim()}`);
    const record = JSON.parse(shown.out) as Record<string, unknown> & {
      record: { data: Record<string, unknown>; agentcommsuntrusted?: unknown; type: string; dataschema: string };
    };
    assert.deepEqual(Object.keys(record), [
      'deliveryId',
      'ruleId',
      'ruleVersion',
      'targetId',
      'targetVersion',
      'eventId',
      'accountId',
      'deliveredAt',
      'expiresAt',
      'record',
    ]);
    assert.equal(record.deliveryId, deliveryId);
    assert.equal(record.ruleId, RULE);
    // Review of 0.32.0, finding 2: an agent's shell runs as the person, so each sender-written field leaves enveloped,
    // as `queue show --json` gives it; the app unwraps the envelope into its From outside box.
    const subject = String(record.record.data.subject);
    assert.match(
      subject,
      /^<untrusted-content boundary="[^"]+" field="event" id="[^"]+">\nDry-run subject the app shows as outside text\n<\/untrusted-content boundary="[^"]+">$/u,
    );
    assert.match(String((record.record.data.from as { name: unknown }).name), /^<untrusted-content /u);
    assert.match(
      String((record.record.data.from as { address: unknown }).address),
      /^<untrusted-content [^\n]*>\ndavid\.sender@example\.test\n/u,
      'a From address is the sender’s too, as the queue gives it',
    );
    assert.match(String(record.record.data.snippet), /^<untrusted-content /u);
    assert.equal(record.record.data.messageId, messageId, 'an id the sender did not write is left as it is');
    assert.ok(record.record.agentcommsuntrusted !== undefined, 'the event names its sender-written fields');

    const terminal = await cli(harness.stateDir, ['dryrun', 'show', deliveryId]);
    assert.equal(terminal.code, 0, terminal.err);
    assert.match(terminal.out, /<untrusted-content/u, 'the terminal view keeps the envelope');
    assert.match(terminal.out, /^Local dry-run delivery /mu);
  });
});

// 0.32.0: `delivery drop` now stops a delivery that will be tried again. Over MCP a window that is not bound to a lane
// cannot stop, drop or even confirm a delivery to that lane (routing B4): for it, the delivery is not there.
test('0.32 B7: over MCP, a window not bound to a lane cannot drop its deliveries; the bound one and the person reach them', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    for (const window of [david, other]) structured(await tool(window, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    await deliver(harness, 'A delivery only the lane may touch');
    const rows = JSON.parse((await cli(harness.stateDir, ['deliveries', 'list', '--json'])).out) as Array<{
      deliveryId: string;
      targetId: string;
    }>;
    const laneDelivery = rows.find((row) => row.targetId === 'lane-david')?.deliveryId as string;
    const dryDelivery = rows.find((row) => row.targetId === 'dry-david')?.deliveryId as string;
    const unbound = await tool(other, 'events_delivery_drop', { deliveryId: laneDelivery });
    assert.equal(unbound.result?.isError, true);
    assert.match(resultText(unbound), /the delivery does not exist/u, 'the other window learns nothing of it');
    // The bound window and the person reach it: it is delivered, so there is nothing to stop.
    const bound = await tool(david, 'events_delivery_drop', { deliveryId: laneDelivery });
    assert.equal(bound.result?.isError, true);
    assert.match(resultText(bound), /can be dropped/u);
    assert.doesNotMatch(resultText(bound), /does not exist/u);
    const person = await cli(harness.stateDir, ['delivery', 'drop', laneDelivery, '--json']);
    assert.equal(person.code, 10, person.err);
    assert.match(person.err, /can be dropped/u);
    // A delivery outside any lane is reached by every window, as the list shows it to every window.
    const outside = await tool(other, 'events_delivery_drop', { deliveryId: dryDelivery });
    assert.match(resultText(outside), /can be dropped/u);
  });
});

// Review of 0.32.0, finding 4: stopping a delivery that will be tried again is the person's — CLI and app — like
// `queue clear`. Over MCP a window may stop only a delivery in the lane it is bound to; a dead letter's payload can be
// dropped as before. A cap of one delivery an hour keeps each rule's second delivery queued, to be stopped.
test('0.32 R4: over MCP only the bound window stops its lane’s queued delivery; every other stop is the person’s', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    const capped = (ruleId: string, targets: readonly Record<string, unknown>[]) => ({
      ...rule(1, targets),
      ruleId,
      deliveryRateCap: 1,
    });
    for (const target of [dryRun, lane(1)]) await harness.control.request('target-add', { document: target });
    for (const [ruleId, targets] of [
      ['lane-capped', [lane(1)]],
      ['dry-capped', [dryRun]],
    ] as const) {
      await harness.control.request('rule-create', { document: capped(ruleId, targets) });
      const planned = (await harness.control.request('rule-enable', { ruleId, version: 1 })) as { approvalId: string };
      const challenge = (await harness.control.request('approve-challenge', {
        approvalId: planned.approvalId,
      })) as string;
      await harness.control.request('approve', { approvalId: planned.approvalId, answer: challenge });
    }
    const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
    const challenge = (await harness.control.request('approve-challenge', {
      approvalId: enabled.approvalId,
    })) as string;
    await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    for (const window of [david, other]) structured(await tool(window, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    harness.mailbox.send('First: delivered within the cap');
    harness.mailbox.send('Second: waits for the cap');
    type Row = { deliveryId: string; ruleId: string; state: string };
    const list = async () => JSON.parse((await cli(harness.stateDir, ['deliveries', 'list', '--json'])).out) as Row[];
    for (let index = 0; index < 10 && (await list()).filter((row) => row.state === 'queued').length < 2; index += 1)
      await harness.tick();
    const queued = (ruleId: string) =>
      list().then((rows) => rows.find((row) => row.ruleId === ruleId && row.state === 'queued')?.deliveryId as string);
    const laneQueued = await queued('lane-capped');
    const dryQueued = await queued('dry-capped');
    assert.ok(laneQueued && dryQueued, 'each rule has a delivery waiting for its cap');
    const stateOf = async (id: string) => (await list()).find((row) => row.deliveryId === id)?.state;

    // A delivery outside any lane: no window may stop it, and the CLI inside an MCP server's process may not either.
    for (const window of [david, other]) {
      const refused = await tool(window, 'events_delivery_drop', { deliveryId: dryQueued });
      assert.equal(refused.result?.isError, true);
      assert.match(resultText(refused), /for a person, at a terminal or in the app/u);
    }
    const marked = await cli(harness.stateDir, ['delivery', 'drop', dryQueued, '--json'], {
      AGENTCOMMS_MCP_SERVER: 'events',
    });
    assert.equal(marked.code, 10, marked.err);
    assert.match(marked.err, /for a person, at a terminal or in the app/u);
    assert.equal(await stateOf(dryQueued), 'queued', 'no refused stop changed it');
    // The person stops it, at a terminal or in the app.
    const person = await cli(harness.stateDir, ['delivery', 'drop', dryQueued, '--json']);
    assert.equal(person.code, 0, person.err);
    assert.equal(await stateOf(dryQueued), 'cancelled');

    // A lane's delivery: the other window learns nothing of it; the bound window may stop it.
    assert.match(
      resultText(await tool(other, 'events_delivery_drop', { deliveryId: laneQueued })),
      /the delivery does not exist/u,
    );
    const bound = structured(await tool(david, 'events_delivery_drop', { deliveryId: laneQueued }));
    assert.deepEqual(bound, { kind: 'delivery-dropped', deliveryId: laneQueued });
    assert.equal(await stateOf(laneQueued), 'cancelled');

    // A finished delivery outside a lane is not a stop: every window gets the drop's own answer, as before.
    const delivered = (await list()).find((row) => row.ruleId === 'dry-capped' && row.state === 'delivered');
    const finished = await tool(other, 'events_delivery_drop', { deliveryId: delivered?.deliveryId as string });
    assert.match(resultText(finished), /can be dropped/u);
    assert.doesNotMatch(resultText(finished), /for a person/u);
  });
});

// Review of 0.32.0, finding 8: what a rule did in the last 7 days tells how much reached its lane. Over MCP a window
// not bound to that lane gets the rule without `counts7d`; the bound window, the person's CLI and the app keep it.
test('0.32 R8: events_rule_show leaves out counts7d of a lane rule for a window not bound to its lane', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await setUp(harness, [dryRun, lane(1)]);
    await harness.control.request('rule-create', { document: { ...rule(1, [dryRun]), ruleId: 'dry-only' } });
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    for (const window of [david, other]) structured(await tool(window, 'events_lane_whoami'));
    assert.equal(
      (await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string])).code,
      0,
    );
    await deliver(harness, 'A match the lane counts');
    type Entry = { document: { ruleId: string }; counts7d?: { matched: number }; summary?: unknown };
    const shown = async (window: RawClient, ruleId: string) => {
      const message = await tool(window, 'events_rule_show', { ruleId });
      assert.notEqual(message.result?.isError, true, resultText(message));
      return JSON.parse(resultText(message)) as Entry[];
    };
    const unbound = await shown(other, RULE);
    assert.equal(unbound.length, 1);
    assert.equal('counts7d' in (unbound[0] as object), false, 'no count of a lane the window is not bound to');
    assert.ok(unbound[0]?.summary !== undefined, 'the rule itself is still shown');
    assert.equal((await shown(david, RULE))[0]?.counts7d?.matched, 1, 'the bound window sees its lane’s counts');
    const person = JSON.parse((await cli(harness.stateDir, ['rule', 'show', RULE, '--json'])).out) as Entry[];
    assert.equal(person[0]?.counts7d?.matched, 1, 'the person sees every count');
    // A rule with no lane keeps its counts for every window.
    assert.ok((await shown(other, 'dry-only'))[0]?.counts7d !== undefined);
  });
});
