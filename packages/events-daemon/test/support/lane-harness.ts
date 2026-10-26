import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { emptyConfig } from '@agentcomms/core';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../../src/cli/program.ts';
import { EventControlClient } from '../../src/control/client.ts';
import type { LaneWindowIdentity } from '../../src/domain/lanes.ts';
import { createEventsMcpServer } from '../../src/mcp/server.ts';
import { type EventOwnerOptions, startEventOwner } from '../../src/runtime/owner.ts';
import { eventPaths } from '../../src/runtime/paths.ts';
import { openEventDatabase } from '../../src/store/database.ts';
import { selectEventSecretStore } from '../../src/store/event-secrets.ts';
import { type RawClient, type RawMessage, rawClient, resultText } from './raw-mcp.ts';
import { shortTempDir } from './short-temp.ts';

/**
 * A real owner with a fake Gmail mailbox, a lane the person approves, and agent windows that reach it through the
 * event service's MCP server, as `lane-owner.test.ts` drives it (routing design 2026-10-25). Shared by the tests of
 * what happens to a message after it arrives (0.32.0 §3.6): its queue item's history, and the person's story of it.
 */

export const ACCOUNT = 'ibx_LANEOWNERLANE001';
export const ALIAS = 'events/gmail';
export const RULE = 'david-by-mail';
export const DAY = 86_400_000;
export const SENDER = 'david.sender@example.test';
export const SENDER_NAME = 'David Sender';

export const DAVID: LaneWindowIdentity = {
  sessionId: '25f971a3-0c69-44e3-971c-3a4656afa986',
  activityKey: '0123456789abcdef',
  grouped: true,
  folder: '/example/home/work/david-project',
  client: { name: 'claude-code', version: '2.1.310' },
};
export const OTHER: LaneWindowIdentity = {
  sessionId: 'f9423d69-c1d7-45a2-a979-a4343c34477f',
  activityKey: 'fedcba9876543210',
  grouped: true,
  folder: '/example/home/work/other-project',
  client: { name: 'claude-code', version: '2.1.310' },
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

export const lane = (version: number, show = 'summary'): Record<string, unknown> => ({
  targetId: 'lane-david',
  version,
  kind: 'queue',
  retentionMs: 7 * DAY,
  show,
  lane: { name: 'david' },
});
export const dryRun: Record<string, unknown> = { targetId: 'dry-david', version: 1, kind: 'dry-run', retentionMs: DAY };

/** A rule on the fake mailbox: every message with a subject by default, or only those `condition` matches. */
export const rule = (
  version: number,
  targets: readonly Record<string, unknown>[],
  condition: Record<string, unknown> = { path: '/subject', op: 'exists' },
): Record<string, unknown> => ({
  ruleId: RULE,
  version,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition,
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

export interface CliResult {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

/** Runs `agent-events` against this owner, as a person would; `lane bind` is typed at an interactive terminal. */
export async function cli(stateDir: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
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

export interface Mailbox {
  /** Delivers a new mail with this subject on the owner's next poll, and returns its Gmail message id. */
  send(subject: string): string;
}

export interface LaneHarness {
  readonly stateDir: string;
  readonly control: EventControlClient;
  readonly mailbox: Mailbox;
  readonly tick: () => Promise<void>;
  readonly window: (identity: LaneWindowIdentity) => Promise<RawClient>;
  readonly approve: (ruleVersion: number) => Promise<void>;
  readonly openCount: () => Promise<number>;
}

export async function withLaneOwner(
  work: (harness: LaneHarness) => Promise<void>,
  /** More owner options, for a test that needs a seam this harness does not set (Linear's client, agent sessions). */
  options: Partial<EventOwnerOptions> = {},
): Promise<void> {
  const root = await shortTempDir('aev-lane-story-');
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
      const id = `g-story-${String(sequence).padStart(4, '0')}`;
      // Gmail's internal date is when the mail arrived: now, so it is after any binding (B3).
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
    stateDir,
    configDir,
    tickMs: 60_000,
    pollIntervalMs: 1,
    ...options,
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
  const control = new EventControlClient({ stateDir, clientName: 'events-lane-story-e2e' });
  const opened: Array<() => Promise<void>> = [];
  const harness: LaneHarness = {
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

export async function tool(
  client: RawClient,
  name: string,
  args: Record<string, unknown> = {},
  meta: Record<string, unknown> = {},
): Promise<RawMessage> {
  return client.request('tools/call', { name, arguments: args, _meta: meta });
}

export function structured(message: RawMessage): Record<string, unknown> {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.notEqual(message.result?.isError, true, resultText(message));
  return message.result?.structuredContent as Record<string, unknown>;
}

/** Sends a mail and ticks the owner until it is a queue item. */
export async function deliver(harness: LaneHarness, subject: string): Promise<string> {
  const before = await harness.openCount();
  const messageId = harness.mailbox.send(subject);
  for (let index = 0; index < 10; index += 1) {
    await harness.tick();
    if ((await harness.openCount()) > before) return messageId;
  }
  assert.fail(`the mail "${subject}" never became a queue item`);
}

/** Sends a mail no rule matches and ticks the owner until its decision is recorded. */
export async function observe(harness: LaneHarness, subject: string): Promise<string> {
  const messageId = harness.mailbox.send(subject);
  for (let index = 0; index < 10; index += 1) {
    await harness.tick();
    const decided = readDatabase(harness.stateDir, (database) =>
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM decisions d JOIN ingest i ON i.event_id = d.event_id
            WHERE json_extract(i.dedupe_key, '$[1]') = ?`,
        )
        .get(messageId),
    ) as { count: number };
    if (decided.count > 0) return messageId;
  }
  assert.fail(`the mail "${subject}" was never decided`);
}

/** Approves the rule and switches collection on, as the person does once at a terminal. */
export async function setUp(
  harness: LaneHarness,
  targets: readonly Record<string, unknown>[],
  condition?: Record<string, unknown>,
): Promise<void> {
  for (const target of targets) await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document: rule(1, targets, condition) });
  await harness.approve(1);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

/** Binds lane `david` to a window that has reported itself, at the person's terminal. */
export async function bindDavid(harness: LaneHarness, window: RawClient): Promise<void> {
  structured(await tool(window, 'events_lane_whoami'));
  const bound = await cli(harness.stateDir, ['lane', 'bind', 'david', '--window', DAVID.sessionId as string]);
  assert.equal(bound.code, 0, bound.err);
}

/** Reads the owner's database directly, read-only, while it runs: what no operation is asked for. */
export function readDatabase<T>(stateDir: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(eventPaths(stateDir).database, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}
