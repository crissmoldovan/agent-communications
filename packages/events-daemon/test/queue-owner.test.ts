import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { emptyConfig } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/**
 * The action queue end to end, through a real owner: a fake Gmail mailbox, a queue target, a rule a person approves,
 * then the CLI's JSON and the MCP tools. Everything a sender controls is a marker the MCP output is scanned for.
 */

const ACCOUNT = 'ibx_QUEUEOWNERQUEUE1';
const ALIAS = 'events/gmail';
const EMAIL = 'events@example.test';
const RULE = 'queue-rule';
const TARGET = 'queue-target';
const DAY = 86_400_000;

const SUBJECT = 'Queue-test subject: can you sign by Friday?';
const SENDER = 'queue.sender@example.test';
const SENDER_NAME = 'Queue Sender';
const SNIPPET = 'queue-test snippet: the contract is attached';
const MESSAGE_ID = 'g-queue-0001';

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

const rule = {
  ruleId: RULE,
  version: 1,
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
  targets: [{ targetId: TARGET, version: 1, kind: 'queue', retentionMs: 7 * DAY, show: 'summary' }],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention,
};

async function cli(stateDir: string, argv: readonly string[]) {
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
    env: {},
    streams: {
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
      stdout: Object.assign(stdout, { isTTY: false }),
      stderr: Object.assign(stderr, { isTTY: false }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

const ENVELOPE =
  /^<untrusted-content boundary="([^"]+)" field="([a-z-]+)">\n([\s\S]*)\n<\/untrusted-content boundary="\1">$/u;

function inner(value: unknown): string {
  const match = ENVELOPE.exec(String(value));
  assert.ok(match, `enveloped: ${String(value)}`);
  return match[3] as string;
}

test('QUEUE-A: a real owner puts a matched mail in the queue; the CLI reads it, MCP never sees what it says', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const root = await shortTempDir('aev-queue-owner-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes[ALIAS] = {
    id: ACCOUNT,
    provider: 'gmail',
    email: EMAIL,
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT}`,
    internalDomains: [],
    createdAt: '2026-10-25T12:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const selected = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(selected.database, 'file');
  } finally {
    selected.close();
  }
  const headers = [
    { name: 'Subject', value: SUBJECT },
    { name: 'From', value: `"${SENDER_NAME}" <${SENDER}>` },
  ];
  const message = {
    id: MESSAGE_ID,
    threadId: 'g-queue-thread',
    labelIds: ['INBOX'],
    internalDate: '1761393600000',
    snippet: SNIPPET,
  };
  let emit = false;
  const owner = await startEventOwner({
    ...noRealHome(stateDir),
    stateDir,
    configDir,
    tickMs: 60_000,
    pollIntervalMs: 1,
    gmailSourceFor: async () =>
      ({
        inboxId: ACCOUNT,
        getProfile: async () => ({ historyId: '1' }),
        listHistory: async () =>
          emit
            ? {
                historyId: '2',
                nextPageToken: undefined,
                history: [
                  {
                    id: '2',
                    messagesAdded: [{ message: { id: message.id, threadId: message.threadId } }],
                    labelsAdded: [],
                    labelsRemoved: [],
                  },
                ],
              }
            : { historyId: '1', nextPageToken: undefined, history: [] },
        getMessageMetadata: async () => ({ ...message, payload: { headers } }),
        getMessage: async () => ({ ...message, payload: { mimeType: 'text/plain', headers } }),
      }) as never,
  });
  const { server } = await createEventsMcpServer({ stateDir });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'events-queue-owner', version: '0' });
  await Promise.all([mcp.connect(clientTransport), server.connect(serverTransport)]);
  const mcpOutput: string[] = [];
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await mcp.callTool({ name, arguments: args })) as {
      readonly structuredContent?: unknown;
      readonly content: readonly { readonly text?: string }[];
      readonly isError?: boolean;
    };
    mcpOutput.push(JSON.stringify(result));
    assert.notEqual(result.isError, true, `${name}: ${result.content[0]?.text}`);
    return result.structuredContent as Record<string, unknown>;
  };
  try {
    const control = new EventControlClient({ stateDir, clientName: 'events-queue-owner-e2e' });
    await control.request('target-add', { document: rule.targets[0] });
    await control.request('rule-create', { document: rule });
    const planned = (await control.request('rule-enable', { ruleId: RULE, version: 1 })) as { approvalId: string };
    const challenge = (await control.request('approve-challenge', { approvalId: planned.approvalId })) as string;
    await control.request('approve', { approvalId: planned.approvalId, answer: challenge });
    const enabled = (await control.request('enable-all')) as { approvalId: string };
    const enableChallenge = (await control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
    await control.request('approve', { approvalId: enabled.approvalId, answer: enableChallenge });
    emit = true;
    let open = 0;
    for (let index = 0; index < 8 && open === 0; index += 1) {
      await owner.tick();
      open = ((await control.request('queue-counts')) as { open: number }).open;
    }
    assert.equal(open, 1, 'the matched mail became one open queue item');

    // The person's read, as the app runs it: `queue list --json`.
    const listed = await cli(stateDir, ['queue', 'list', '--json']);
    assert.equal(listed.code, 0, listed.err);
    const list = JSON.parse(listed.out) as {
      readonly items: readonly Record<string, unknown>[];
      readonly more: boolean;
    };
    t.diagnostic(`queue list --json: ${listed.out.trim()}`);
    assert.equal(list.more, false);
    assert.equal(list.items.length, 1);
    const item = list.items[0] as Record<string, unknown> & {
      readonly from: { readonly name?: string; readonly address?: string };
    };
    assert.deepEqual(Object.keys(item).sort(), [
      'account',
      'arrivedAt',
      'channel',
      'expiresAt',
      'from',
      'id',
      'judge',
      'lane',
      'link',
      'rule',
      'state',
      'stateAt',
      'subject',
      'text',
    ]);
    assert.match(String(item.id), /^qi_[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.equal(item.state, 'open');
    assert.equal(item.arrivedAt, new Date(Number(message.internalDate)).toISOString());
    assert.deepEqual(item.rule, { id: RULE, version: 1, name: RULE });
    assert.equal(item.channel, 'gmail');
    assert.deepEqual(item.account, { id: ACCOUNT, alias: ALIAS });
    assert.equal(inner(item.from.name), SENDER_NAME);
    assert.equal(inner(item.from.address), SENDER);
    assert.equal(inner(item.subject), SUBJECT);
    assert.equal(inner(item.text), SNIPPET);
    assert.deepEqual(item.link, {
      kind: 'gmail',
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(EMAIL)}#all/${MESSAGE_ID}`,
    });
    assert.deepEqual(item.judge, { state: 'none' });
    assert.equal(item.lane, null, 'a plain queue’s item is in no lane');

    const counted = await cli(stateDir, ['queue', 'counts', '--json']);
    assert.equal(counted.code, 0, counted.err);
    t.diagnostic(`queue counts --json: ${counted.out.trim()}`);
    assert.deepEqual(JSON.parse(counted.out), {
      open: 1,
      done: 0,
      dismissed: 0,
      byRule: [{ ruleId: RULE, name: RULE, open: 1 }],
    });
    const shown = await cli(stateDir, ['queue', 'show', String(item.id), '--json']);
    assert.equal(shown.code, 0, shown.err);
    assert.equal(inner((JSON.parse(shown.out) as { item: { subject: string } }).item.subject), SUBJECT);
    const human = await cli(stateDir, ['queue', 'list']);
    assert.equal(human.code, 0, human.err);
    assert.match(human.out, /<untrusted-content /u, 'a terminal sees the sender’s words inside their envelope');
    const missing = await cli(stateDir, ['queue', 'show', 'qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', '--json']);
    assert.equal(missing.code, 66);

    // An agent's view: content-free, and able to mark the item without reading it (Q5).
    const items = await tool('events_queue_items', { state: 'all' });
    t.diagnostic(`events_queue_items: ${JSON.stringify(items)}`);
    assert.deepEqual(
      (items.items as Array<{ id: string }>).map((entry) => entry.id),
      [item.id],
    );
    assert.deepEqual(await tool('events_queue_counts'), JSON.parse(counted.out));
    const done = await tool('events_queue_done', { itemId: item.id });
    assert.deepEqual(Object.keys(done.item as object).sort(), ['id', 'state', 'stateAt']);
    assert.equal((done.item as { state: string }).state, 'done');
    const doneCli = await cli(stateDir, ['queue', 'done', String(item.id), '--json']);
    t.diagnostic(`queue done --json: ${doneCli.out.trim()}`);
    assert.equal((await tool('events_queue_reopen', { itemId: item.id })).item instanceof Object, true);
    assert.equal(
      ((await tool('events_queue_dismiss', { itemId: item.id })).item as { state: string }).state,
      'dismissed',
    );

    // Q6: a tighter version's preview says what enabling it removes. The item is dismissed, so it removes none open.
    const reopened = await cli(stateDir, ['queue', 'reopen', String(item.id), '--json']);
    assert.equal(reopened.code, 0, reopened.err);
    const tighter = (await control.request('rule-update', {
      document: { ...rule, version: 2, retention: { ...retention, queueMs: 2 * DAY } },
    })) as { readonly tightening?: Record<string, unknown> };
    t.diagnostic(`rule update (tightening) preview: ${JSON.stringify(tighter.tightening)}`);
    assert.deepEqual(tighter.tightening, {
      editKind: 'shorten-retention',
      appliesWhen: 'rule enable',
      openQueueItemsRemoved: 1,
      notice: '1 open queue item under this rule will be removed',
    });
    await control.request('rule-enable', { ruleId: RULE, version: 2 });
    assert.equal(((await tool('events_queue_counts')) as { open: number }).open, 0, 'enabling it removed the item');

    // Clear is the person's: the terminal's and the app's, never an agent's.
    await assert.rejects(
      mcp.callTool({ name: 'events_queue_clear', arguments: {} }),
      /not found/u,
      'no MCP tool clears the queue',
    );
    const cleared = await cli(stateDir, ['queue', 'clear', '--json']);
    assert.equal(cleared.code, 0, cleared.err);
    t.diagnostic(`queue clear --json: ${cleared.out.trim()}`);
    assert.deepEqual(JSON.parse(cleared.out), { cleared: 0 });

    const everything = mcpOutput.join('\n');
    for (const content of [SUBJECT, SENDER, SENDER_NAME, SNIPPET, MESSAGE_ID, 'mail.google.com', 'untrusted-content'])
      assert.ok(!everything.includes(content), `no MCP output carries ${content}`);
  } finally {
    await Promise.all([mcp.close(), server.close()]);
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
