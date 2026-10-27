import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { emptyConfig, type Notifier, type TakeHolder, TakeStore } from '@agentcomms/core';
import type { SlackEventMessage, SlackEventPage, SlackEventSource } from '@agentcomms/slack';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { EventControlClient } from '../src/control/client.ts';
import { type EventOwner, type EventOwnerOptions, startEventOwner } from '../src/runtime/owner.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type { WorkflowFailpoint } from '../src/runtime/workflow/engine.ts';
import type { RunShowResultV1 } from '../src/runtime/workflow/run-show.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { ATTESTED_APP, type CliOptions, type CliRun, runCli } from './support/events-owner.ts';
import { FAKE_LINEAR_KEY, FAKE_STATES, FAKE_TEAM, type FakeLinear, startFakeLinear } from './support/fake-linear.ts';
import { FakeRelay, type FakeSession } from './support/fake-relay.ts';
import { freePort } from './support/live-events.ts';
import { type LoopbackReceiver, startLoopbackReceiver } from './support/loopback-receiver.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';

assertLoopbackSeal();

/*
 * G2 (workflows plan): the owner's thirteen steps (workflows design §1), end to end, on one real event-service owner.
 * Everything outside it is a stand-in: a home, a configuration folder and the file secret store of the test's own; a
 * fake Slack workspace the owner's Slack source reads; the loopback fake claude-stream relay; the loopback fake of
 * Linear; a loopback webhook receiver; temporary git repositories with a GitHub origin; an approved live subscription
 * read over WebSocket; and a chained workflow. Nothing real is read, started or contacted, and every key is fake.
 *
 * The person does what only the person may: adds the projects, approves each workflow at the terminal with its
 * challenge, and approves the subscriptions in the attested app with the digest their preview showed.
 *
 * | Owner's step (design §1)                                  | Proved by (test: what it asserts)                          |
 * |-----------------------------------------------------------|------------------------------------------------------------|
 * | 1. An event comes in                                      | every test: a Slack message the owner's own source reads   |
 * | 2. Conditions are set                                     | the owner example: its trigger, `match text exists`        |
 * | 3. If they are met, it continues                          | the owner example: one run, and the exact path it took     |
 * | 4. It searches for the session and determines which it is | the owner example: find says busy; the none path: none     |
 * | 5. If it's about that session, it goes there              | step 5: a reply in the thread goes to its taker, no route  |
 * | 6. If the session is found, it goes there                 | the owner example: wait until free, then give it the turn  |
 * | 7. If not, search for another one                         | the none path: another, idle only, says none               |
 * | 8. If no session was found, it creates a new session      | the none path: one session started, in the worktree        |
 * | 9. … it checks what project it is in                      | every routed run: Which project?, by the person's hint     |
 * | 10. It creates a separate worktree, optionally            | the none path: `ac/acme-2`, the repository's hooks off     |
 * | 11. It adds a Linear ticket                               | the owner example: ACME-1, before the session search       |
 * | 12. … with instructions on what the ticket should contain | the owner example: the issue's title and enveloped text    |
 * | 13. When it finishes work, it closes the Linear ticket    | the owner example and the none path: the summary, Done     |
 * | Every step can tell others (§2, W23–W33)                  | the owner example: six events, by WebSocket and webhook    |
 * | An event starts another workflow, once (W34)              | the owner example: B on issue.created, depth 1, once       |
 * | Runs survive restarts, no effect twice (§2, §7.3, §7.4)   | a restart in the middle of every step (three crash points) |
 * | A raised event never slows a run (§2, W33)                | a webhook subscriber that hangs                            |
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERSON = 'person-setup:terminal';
const APP = 'person-setup:desktop-app';
const ACCOUNT_ID = 'acc_ACMESLACK0000001';
const ALIAS = 'acme/slack';
const WORKSPACE = 'T0ACME';
const CONVERSATION = 'C0123';
const SENTINEL = 'SENTINEL-SENDER';
/** Linear's team for the example: the fake's id, its key ACME, so its issues are ACME-1, ACME-2… */
const ACME_TEAM = { id: FAKE_TEAM.id, key: 'ACME', name: 'Acme' } as const;
const DONE_STATE = FAKE_STATES.find((state) => state.name === 'Done') as (typeof FAKE_STATES)[number];
/** What the session reports when its turn ends: agent-written, so it reaches only the issue's comment. */
const SUMMARY = 'Changed the banner on a branch of its own; nothing pushed.';

type Doc = Record<string, unknown>;

function fixture(name: string): Doc {
  return JSON.parse(
    readFileSync(new URL(`../../events/test/fixtures/flows/${name}.json`, import.meta.url), 'utf8'),
  ) as Doc;
}

// ---------------------------------------------------------------------------------------------------------------
// The fake Slack workspace: one conversation, its top-level messages and their threads, as the channel package's
// read-only event source answers (`conversations.history` newest first, `conversations.replies` parent first).
// ---------------------------------------------------------------------------------------------------------------

class FakeSlack {
  readonly messages: SlackEventMessage[] = [];
  readonly #now: () => number;
  #last = 0;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** A person posts: at the owner's now, after every earlier message. Returns the message's ts. */
  post(input: { readonly text: string; readonly threadTs?: string | undefined }): string {
    // Microseconds since the epoch, strictly increasing, never after the owner's now.
    const micros = Math.max(this.#now() * 1000, this.#last + 1);
    this.#last = micros;
    const ts = `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, '0')}`;
    this.messages.push({
      ts,
      threadTs: input.threadTs ?? null,
      text: input.text,
      truncated: false,
      mismatch: false,
      unrenderable: false,
      author: { userId: 'U0KIM', name: `${SENTINEL} Kim`, app: false, external: false },
      editedTs: null,
      replyCount: 0,
      mentions: [],
      files: [],
    });
    return ts;
  }

  #withReplies(message: SlackEventMessage): SlackEventMessage {
    const replies = this.messages.filter((other) => other.threadTs === message.ts && other.ts !== message.ts);
    return replies.length === 0 ? message : { ...message, threadTs: message.ts, replyCount: replies.length };
  }

  source(accountId: string): SlackEventSource {
    const page = (messages: readonly SlackEventMessage[]): SlackEventPage => ({
      messages,
      nextCursor: null,
      retainedHistoryBoundary: false,
    });
    const within = (ts: string, oldest: string, latest: string) =>
      Number(ts) >= Number(oldest) && Number(ts) <= Number(latest);
    return {
      accountId,
      accountAlias: ALIAS,
      workspaceId: WORKSPACE,
      conversation: async ({ conversationId }) => ({
        id: conversationId,
        name: 'acme-requests',
        kind: 'public_channel',
      }),
      history: async (input) =>
        page(
          this.messages
            .filter((message) => message.threadTs === null && within(message.ts, input.oldest, input.latest))
            .map((message) => this.#withReplies(message))
            .reverse()
            .slice(0, input.limit ?? 100),
        ),
      replies: async (input) => {
        const parent = this.messages.find((message) => message.ts === input.parentTs);
        const replies = this.messages.filter(
          (message) => message.threadTs === input.parentTs && Number(message.ts) <= Number(input.latest),
        );
        return page(parent === undefined ? replies : [this.#withReplies(parent), ...replies]);
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A loopback webhook receiver: each request's headers and body, answered 200 — or never answered, when it hangs.
// ---------------------------------------------------------------------------------------------------------------

interface Received {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** When it was read, by this Mac's clock. */
  readonly at: number;
}

interface Receiver {
  readonly server: LoopbackReceiver;
  readonly url: string;
  readonly requests: Received[];
  /** Requests it has read and is holding open, unanswered. */
  readonly hanging: () => number;
  /** Drops every request it holds open, as a subscriber that gives up would. */
  release(): void;
}

async function webhookReceiver(behaviour: 'answer' | 'hang' = 'answer'): Promise<Receiver> {
  const requests: Received[] = [];
  const held = new Set<Socket>();
  const server = await startLoopbackReceiver((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
      const headers = Object.fromEntries(
        head.slice(1).map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      const length = Number(headers['content-length'] ?? 0);
      if (buffer.byteLength < end + 4 + length) return;
      requests.push({ headers, body: buffer.subarray(end + 4, end + 4 + length).toString('utf8'), at: Date.now() });
      buffer = Buffer.alloc(0);
      if (behaviour === 'hang') {
        held.add(socket);
        socket.once('close', () => held.delete(socket));
        return;
      }
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  return {
    server,
    url: `http://127.0.0.1:${server.port}/hooks/events`,
    requests,
    hanging: () => held.size,
    release: () => {
      for (const socket of held) socket.destroy();
    },
  };
}

/** Standard Webhooks: each `v1,` signature over `<id>.<timestamp>.<body>` with the secret's key, in order. */
function signedWith(secret: string, received: Received): boolean[] {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${received.headers['webhook-id']}.${received.headers['webhook-timestamp']}.${received.body}`, 'utf8')
    .digest('base64');
  return (received.headers['webhook-signature'] ?? '').split(' ').map((signature) => signature === `v1,${expected}`);
}

// ---------------------------------------------------------------------------------------------------------------
// A WebSocket client of the live listener, as a program connects: the bearer in its Authorization header.
// ---------------------------------------------------------------------------------------------------------------

interface LiveClient {
  readonly messages: string[];
  close(): void;
}

async function liveClient(port: number, subscriberId: string, token: string): Promise<LiveClient> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/streams/${subscriberId}`, {
      headers: { authorization: `Bearer ${token}` },
    } as never);
    const messages: string[] = [];
    socket.addEventListener('message', (event) => messages.push(String(event.data)));
    // The handshake holds no reference on the event loop: keep it alive until the socket opens or fails.
    const alive = setInterval(() => undefined, 100);
    const opened = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(true));
      socket.addEventListener('error', () => resolve(false));
      socket.addEventListener('close', () => resolve(false));
    }).finally(() => clearInterval(alive));
    if (opened) return { messages, close: () => socket.close() };
    if (Date.now() > deadline) assert.fail('the live listener never took the WebSocket');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The harness: one owner, its stand-ins and fakes, and what the person does.
// ---------------------------------------------------------------------------------------------------------------

function clock(): { readonly now: () => number; advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance(ms) {
      offset += ms;
    },
  };
}

interface Harness {
  readonly root: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly work: string;
  /** The two projects' checkouts, real git repositories with a GitHub origin. */
  readonly acme: string;
  readonly billing: string;
  readonly relay: FakeRelay;
  readonly linear: FakeLinear;
  readonly slack: FakeSlack;
  readonly time: ReturnType<typeof clock>;
  readonly notices: string[];
  readonly control: EventControlClient;
  readonly database: DatabaseSync;
  /** The owner now running. */
  owner(): EventOwner;
  tick(): Promise<void>;
  /** Stops this owner, as a crash's end would, and starts another on the same state, with these options added. */
  restart(more?: Partial<EventOwnerOptions>): Promise<void>;
  cli(argv: readonly string[], options?: CliOptions): Promise<CliRun>;
  git(cwd: string, ...args: string[]): string;
}

function setupGit(home: string, cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).toString();
}

async function repository(home: string, path: string, origin: string): Promise<string> {
  await mkdir(path, { recursive: true });
  setupGit(home, path, 'init', '-q', '-b', 'main');
  setupGit(home, path, 'commit', '-q', '--allow-empty', '-m', 'init');
  setupGit(home, path, 'remote', 'add', 'origin', origin);
  return realpath(path);
}

interface HarnessOptions {
  /** "A session must take a message first" for the Slack account (taking design), so a delivery offers it. */
  readonly taking?: boolean;
  readonly owner?: Partial<EventOwnerOptions>;
}

async function withOwner(work: (harness: Harness) => Promise<void>, options: HarnessOptions = {}): Promise<void> {
  const root = await realpath(await shortTempDir('aev-g2-'));
  const stateDir = join(root, 'state');
  const home = await standInHome(root);
  const workFolder = join(home.homeDirectory, 'work');
  await mkdir(workFolder, { recursive: true });
  const acme = await repository(
    home.homeDirectory,
    join(workFolder, 'acme-site'),
    'git@github.com:example/acme-site.git',
  );
  const billing = await repository(
    home.homeDirectory,
    join(workFolder, 'billing'),
    'https://github.com/example/billing.git',
  );
  const config = emptyConfig();
  config.accounts[ALIAS] = {
    id: ACCOUNT_ID,
    platform: 'slack',
    workspace: WORKSPACE,
    userId: 'U0OWNER',
    tier: 'read',
    grantedScopes: [],
    secretRef: `slack:none:${ACCOUNT_ID}`,
    createdAt: '2026-10-27T08:00:00.000Z',
  } as never;
  if (options.taking === true)
    (config as unknown as Doc).taking = { accounts: [{ accountId: ACCOUNT_ID, account: ALIAS, required: true }] };
  await writeFile(join(home.configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const opened = await openEventDatabase({ stateDir });
  try {
    await standInSecrets(opened.database);
  } finally {
    opened.close();
  }
  const time = clock();
  const relay = await new FakeRelay({ allowedRoots: [workFolder] }).start();
  const linear = await startFakeLinear({ team: ACME_TEAM });
  const slack = new FakeSlack(time.now);
  const notices: string[] = [];
  const notifier: Notifier = async (notice) => {
    notices.push(notice.body);
    return { raised: true };
  };
  const base = (more: Partial<EventOwnerOptions> = {}): EventOwnerOptions => ({
    stateDir,
    configDir: home.configDir,
    dataDir: home.dataDir,
    homeDirectory: home.homeDirectory,
    tickMs: 60_000,
    pollIntervalMs: 1,
    now: time.now,
    slackSourceFor: async ({ accountId }) => slack.source(accountId),
    linearClient: linear.clientOptions(),
    // The relay's default homes are looked for under the stand-in home, never the person's.
    agentSessions: { homeDirectory: home.homeDirectory, reconcileMs: 60_000 },
    takes: { notify: null },
    ...options.owner,
    ...more,
    workflows: { notifier, ...options.owner?.workflows, ...more.workflows },
  });
  let owner = await startEventOwner(base());
  const control = new EventControlClient({ stateDir, clientName: 'g2-end-to-end' });
  const database = new DatabaseSync(eventPaths(stateDir).database, { readOnly: true });
  database.exec('PRAGMA busy_timeout = 5000');
  const harness: Harness = {
    root,
    stateDir,
    configDir: home.configDir,
    work: workFolder,
    acme,
    billing,
    relay,
    linear,
    slack,
    time,
    notices,
    control,
    database,
    owner: () => owner,
    tick: () => owner.tick(),
    async restart(more = {}) {
      await owner.stop();
      owner = await startEventOwner(base(more));
    },
    cli: (argv, cliOptions) => runCli(stateDir, argv, cliOptions),
    git: (cwd, ...args) => setupGit(home.homeDirectory, cwd, ...args),
  };
  try {
    await work(harness);
  } finally {
    database.close();
    await owner.stop();
    await relay.stop();
    await linear.close();
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Ticks the owner until `done` holds of what `read` gives, or fails naming `what` and what the store holds. With
 * `ownTicks`, the test ticks nothing: the owner's own timer does, as it does on the person's Mac.
 */
async function until<T>(
  harness: Harness,
  read: () => T,
  done: (value: T) => boolean,
  what: string,
  options: { readonly ownTicks?: boolean } = {},
): Promise<T> {
  // Generous but bounded: the owner's ticks, the fakes and git share a loaded machine with other suites.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline)
      assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}; ${JSON.stringify(seen(harness))}`);
    if (options.ownTicks !== true) await harness.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function seen(harness: Harness): unknown {
  return {
    runs: harness.database
      .prepare('SELECT rule_id, state, end_code, executed_steps FROM workflow_runs')
      .all()
      .map((row) => ({ ...row })),
    steps: harness.database
      .prepare('SELECT run_id, step_id, state, outcome, last_error_code, attempts FROM workflow_steps')
      .all()
      .map((row) => ({ ...row })),
    deliveries: harness.database
      .prepare('SELECT target_key, state, last_error_code FROM deliveries')
      .all()
      .map((row) => ({ ...row })),
    decisions: harness.database
      .prepare('SELECT rule_id, outcome FROM decisions')
      .all()
      .map((row) => ({ ...row })),
    events: harness.database
      .prepare(
        `SELECT e.type, d.subscriber_id, d.state, d.attempts, d.last_error_code
           FROM workflow_events e LEFT JOIN event_deliveries d ON d.event_id = e.id ORDER BY e.sequence`,
      )
      .all()
      .map((row) => ({ ...row })),
  };
}

function json(run: CliRun): Record<string, unknown> {
  assert.equal(run.code, 0, run.err);
  return JSON.parse(run.out) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// The documents: the projects, the targets and the workflows, from the spec's owner example (its fixtures).
// ---------------------------------------------------------------------------------------------------------------

function projectDocument(projectId: string, folder: string, hints: Partial<Record<string, string[]>>): Doc {
  return {
    projectId,
    name: projectId,
    repo: `example/${projectId}`,
    profile: `The ${projectId} project, as the person describes it.`,
    hints: { senderDomains: [], slackConversations: [], people: [], ...hints },
    folders: [{ folder, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null }],
  };
}

/** The route step's candidates: the person's two projects, as they are now (W12). */
function candidates(harness: Harness): Doc[] {
  return [
    { projectId: 'acme-site', name: 'acme-site', folders: [harness.acme], worktreeRoot: null },
    { projectId: 'billing', name: 'billing', folders: [harness.billing], worktreeRoot: null },
  ];
}

/** A fixture made this Mac's: the Slack account, the projects' real folders, Linear's ACME team and its Done state. */
function localise(document: Doc, harness: Harness): Doc {
  const copy = structuredClone(document) as Doc & {
    source: { accountIds: string[] };
    flow: { steps: Record<string, Doc> };
    targets: Doc[];
  };
  copy.version = 1;
  copy.source.accountIds = [ACCOUNT_ID];
  // The gate's own judge stays out: the workflow is the person's words and hints, so nothing calls a model.
  delete copy.agentic;
  for (const step of Object.values(copy.flow.steps))
    if (step.kind === 'route') {
      step.by = ['hints'];
      delete step.judge;
      step.candidates = candidates(harness);
    }
  copy.mapping = {
    ...(copy.mapping as Doc),
    // The conversation and the author's id are what the person's hints are matched against: ids, never words.
    channel: { id: { $path: '/channel/id' } },
    author: { name: { $path: '/author/name' }, userId: { $path: '/author/userId' } },
  };
  for (const target of copy.targets) {
    if (target.kind === 'linear' || target.kind === 'linear-change') target.team = { id: ACME_TEAM.id, key: 'ACME' };
    if (target.kind === 'linear-change')
      target.state = { id: DONE_STATE.id, name: DONE_STATE.name, type: DONE_STATE.type };
  }
  return copy;
}

/** The owner example (spec §4.4), on this Mac. */
function ownerExample(harness: Harness): Doc {
  return localise(fixture('owner-example'), harness);
}

/** The chained workflow B: it starts when a run about the same message raises acme.client-asks.issue.created. */
function chainedWorkflow(harness: Harness): Doc {
  return localise(fixture('chained'), harness);
}

const SUBSCRIBED = ['acme.client-asks.*.*'];

/** The live subscriber, on a port of its own: its events, no browser page, nothing a sender wrote. */
function liveSubscriber(port: number): Doc {
  return {
    subscriberId: 'events-dashboard',
    version: 1,
    kind: 'sse',
    authority: { host: '127.0.0.1', port },
    origins: [],
    retentionMs: DAY,
    events: { namespaces: ['acme'], patterns: SUBSCRIBED, content: 'none' },
  };
}

function hookSubscriber(url: string): Doc {
  return {
    subscriberId: 'crm-hook',
    version: 1,
    kind: 'webhook',
    url: { kind: 'plain', value: url },
    approvedAddressSet: ['127.0.0.1'],
    signing: 'standard-webhooks',
    retryLimit: 3,
    events: { namespaces: ['acme'], patterns: SUBSCRIBED, content: 'none' },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What the person does, once: the relay and Linear, the projects, the workflows, the switch, the subscriptions.
// ---------------------------------------------------------------------------------------------------------------

async function connect(harness: Harness): Promise<void> {
  const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
  await person.request('integration-set', {
    integration: 'agent-sessions',
    relayHome: await harness.relay.writeHome(harness.root),
  });
  await new EventControlClient({ stateDir: harness.stateDir, clientName: APP }).request('provider-key-set', {
    provider: 'linear',
    hidden: FAKE_LINEAR_KEY,
  });
  // The projects, added from the app, as the person picked them from the scan.
  for (const project of [
    projectDocument('acme-site', harness.acme, { slackConversations: [CONVERSATION] }),
    projectDocument('billing', harness.billing, {}),
  ])
    json(await harness.cli(['project', 'add', '-'], { stdin: JSON.stringify(project), desktopOrigin: ATTESTED_APP }));
}

/** Creates each workflow and its targets, and approves each at the terminal with its challenge. */
async function approveWorkflows(harness: Harness, documents: readonly Doc[]): Promise<void> {
  const added = new Set<string>();
  for (const document of documents) {
    for (const target of document.targets as Doc[]) {
      const key = `${target.targetId}@${target.version}`;
      if (added.has(key)) continue;
      added.add(key);
      await harness.control.request('target-add', { document: target });
    }
    await harness.control.request('rule-create', { document });
    const planned = (await harness.control.request('rule-enable', {
      ruleId: document.ruleId,
      version: document.version,
    })) as { approvalId: string };
    const challenge = (await harness.control.request('approve-challenge', {
      approvalId: planned.approvalId,
    })) as string;
    await harness.control.request('approve', { approvalId: planned.approvalId, answer: challenge });
  }
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

interface Subscribed {
  readonly live: LiveClient;
  readonly hook: Receiver;
  readonly secret: string;
  /** Connects another WebSocket client, as the live one does: after a restart, say. */
  reconnect(): Promise<LiveClient>;
}

/**
 * The two subscribers: added, the live one's token and the webhook's signing secret made at the terminal (shown once),
 * each subscription prepared and approved in the attested app with its preview's digest; then the WebSocket connects.
 */
async function subscribe(harness: Harness, hook: Receiver): Promise<Subscribed> {
  const port = await freePort();
  json(await harness.cli(['subscriber', 'add', '-'], { stdin: JSON.stringify(liveSubscriber(port)) }));
  json(await harness.cli(['subscriber', 'add', '-'], { stdin: JSON.stringify(hookSubscriber(hook.url)) }));
  const token = await harness.cli(['subscriber', 'token', 'create', 'events-dashboard', '--version', '1'], {
    tty: true,
    json: false,
  });
  assert.equal(token.code, 0, token.err);
  const bearer = /Generated credential \(shown once\): (\S+)/u.exec(token.out)?.[1];
  assert.ok(bearer, 'the bearer token is shown once at the terminal');
  const signing = await harness.cli(['subscriber', 'secret', 'create', 'crm-hook', '--version', '1'], {
    tty: true,
    json: false,
  });
  assert.equal(signing.code, 0, signing.err);
  const secret = /Generated credential \(shown once\): (whsec_\S+)/u.exec(signing.out)?.[1];
  assert.ok(secret, 'the signing secret is shown once at the terminal');
  for (const subscriberId of ['events-dashboard', 'crm-hook']) {
    const prepared = json(await harness.cli(['subscriber', 'enable', subscriberId, '1'])) as {
      approvalId: string;
      binding: { digest: string };
    };
    const approved = json(
      await harness.cli(['subscriber', 'approve', prepared.approvalId, '--digest', prepared.binding.digest], {
        desktopOrigin: ATTESTED_APP,
      }),
    );
    assert.equal(approved.approvedBy, 'desktop-app');
  }
  await harness.tick();
  const live = await liveClient(port, 'events-dashboard', bearer);
  return { live, hook, secret, reconnect: () => liveClient(port, 'events-dashboard', bearer) };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading what happened.
// ---------------------------------------------------------------------------------------------------------------

interface RunRow {
  readonly id: string;
  readonly rule_id: string;
  readonly state: string;
  readonly depth: number;
  readonly parent_run_id: string | null;
  readonly started_at: number;
  readonly updated_at: number;
}

function runsOf(harness: Harness, ruleId: string): RunRow[] {
  return harness.database
    .prepare(
      'SELECT id, rule_id, state, depth, parent_run_id, started_at, updated_at FROM workflow_runs WHERE rule_id = ? ORDER BY started_at, id',
    )
    .all(ruleId)
    .map((row) => ({ ...(row as unknown as RunRow) }));
}

function stepOf(
  harness: Harness,
  runId: string,
  stepId: string,
): { state: string; outcome: string | null } | undefined {
  const row = harness.database
    .prepare('SELECT state, outcome FROM workflow_steps WHERE run_id = ? AND step_id = ?')
    .get(runId, stepId) as { state: string; outcome: string | null } | undefined;
  return row === undefined ? undefined : { ...row };
}

async function runShow(harness: Harness, runId: string): Promise<RunShowResultV1> {
  return json(
    await harness.cli(['runs', 'show', runId], { desktopOrigin: ATTESTED_APP }),
  ) as unknown as RunShowResultV1;
}

/** The CloudEvent types a stream of canonical JSON messages carried, in order. */
function typesOf(messages: readonly string[]): string[] {
  return messages.map((message) => (JSON.parse(message) as { type: string }).type);
}

// ---------------------------------------------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------------------------------------------

test('the owner example: route by hint, raise project-found, issue ACME-1, find busy, wait free, give, done, close', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await webhookReceiver();
  try {
    await withOwner(async (harness) => {
      await connect(harness);
      // Steps 1–3: the workflow's trigger and condition, and B, which starts on A's issue; approved at the terminal.
      await approveWorkflows(harness, [ownerExample(harness), chainedWorkflow(harness)]);
      const { live, secret } = await subscribe(harness, hook);
      try {
        // Step 4's find will see the one session in acme-site, busy with a turn someone else started.
        const session = harness.relay.addSession({ cwd: harness.acme, nativeSessionId: randomUUID() });
        harness.relay.startRunElsewhere(session.id);

        harness.slack.post({ text: `${SENTINEL} please change the banner on the booking page` });
        const [run] = await until(
          harness,
          () => runsOf(harness, 'client-asks'),
          (runs) => runs.length === 1 && stepOf(harness, runs[0]?.id ?? '', 'free')?.state === 'waiting',
          'the run to wait for the busy session',
        );
        assert.ok(run);
        assert.equal(stepOf(harness, run.id, 'find')?.outcome, 'busy');
        // Step 11: the issue was made before the search, and B started once on its event.
        assert.equal(harness.linear.issues.length, 1);
        assert.equal(harness.linear.issues[0]?.identifier, 'ACME-1');
        // Step 12: what the issue says is the workflow's template, the sender's words inside their envelope.
        const issue = harness.linear.issues[0]?.input as { title: string; description: string };
        assert.match(issue.title, /asks about acme-site/u);
        assert.match(
          issue.description,
          /From outside: written by the sender, not checked[\s\S]*please change the banner/u,
          'the sender’s words, quoted and labelled as theirs',
        );
        assert.equal(harness.linear.comments.length, 0, 'nothing is commented before the work is done');
        assert.equal(harness.relay.runs.length, 1, 'nothing is given to the busy session');

        // Step 6: the session comes free; the run gives it the message, which reports when its turn ends.
        harness.relay.endRun(session.id);
        await until(
          harness,
          () => stepOf(harness, run.id, 'wait')?.state,
          (state) => state === 'waiting',
          'the turn',
        );
        const turn = harness.relay.runs[1];
        assert.equal(turn?.sessionId, session.id, 'the session find chose');
        assert.match(
          turn?.prompt ?? '',
          /<untrusted-content[^>]*>[\s\S]*please change the banner[\s\S]*<\/untrusted-content/u,
        );
        // Step 13: the session says it is done; the run comments its summary on the issue and closes it.
        harness.relay.endRun(session.id, 'completed', { outcome: 'done', summary: SUMMARY });
        await until(
          harness,
          () => runsOf(harness, 'client-asks')[0]?.state,
          (state) => state === 'done',
          'the run to finish',
        );
        const shown = await runShow(harness, run.id);
        assert.deepEqual(shown.path, ['route', 'found', 'issue', 'find', 'free', 'give', 'wait', 'note']);
        // Step 9: the project, by the person's hint — the conversation acme-site lists — so no judge was asked.
        const routed = shown.steps.find((step) => step.stepId === 'route')?.output;
        assert.deepEqual([routed?.project, routed?.reason], ['acme-site', 'hint:slack-conversation']);
        const closed = harness.linear.issue('ACME-1');
        assert.equal(closed?.state, 'Done');
        assert.equal(closed?.comments.length, 1);
        // The summary, labelled as an agent's words that nobody checked.
        assert.match(closed?.comments[0] ?? '', /Written by an agent, not checked[\s\S]*Changed the banner/u);

        const expected = [
          'acme.client-asks.route.matched',
          'acme.client-asks.found.project-found',
          'acme.client-asks.issue.created',
          'acme.client-asks.give.given',
          'acme.client-asks.note.closed',
          'acme.client-asks.run.finished',
        ];
        await until(
          harness,
          () => ({ live: live.messages.length, hook: hook.requests.length }),
          (count) => count.live >= expected.length && count.hook >= expected.length,
          'every event to reach both subscribers',
        );
        assert.deepEqual(typesOf(live.messages), expected);
        // The same six, signed, by webhook: each its event's id as webhook-id, in the order raised.
        assert.equal(hook.requests.length, 6);
        assert.deepEqual(
          hook.requests.map((request) => request.body),
          live.messages,
          'the same CloudEvent, byte for byte',
        );
        for (const request of hook.requests) {
          assert.deepEqual(signedWith(secret, request), [true]);
          assert.equal(request.headers['webhook-id'], (JSON.parse(request.body) as { id: string }).id);
        }
        // The chained workflow started once, about the same message, from the issue's event.
        const chained = runsOf(harness, 'issue-followup');
        assert.equal(chained.length, 1);
        assert.deepEqual([chained[0]?.depth, chained[0]?.parent_run_id], [1, run.id]);
        await until(
          harness,
          () => harness.notices,
          (notices) => notices.some((notice) => notice.includes('ACME-1 was made')),
          'B to tell the person',
        );
        // What a sender wrote is in no byte of any event, wherever it went.
        const everything = [...live.messages, ...hook.requests.map((request) => JSON.stringify(request))].join('\n');
        assert.equal(everything.includes(SENTINEL), false);
        assert.equal(everything.includes('please change the banner'), false);
        assert.equal(everything.includes(harness.acme), false, 'and no folder path');
      } finally {
        live.close();
      }
    });
  } finally {
    await hook.server.close();
  }
});

/** A Claude Code window, as a take records who holds a message: its key, its process and its session's id. */
function window(sessionId: string, folder: string): TakeHolder {
  return {
    key: 'abcdef0123456789',
    grouped: true,
    process: 'a1a1a1a1a1a1',
    sessionId,
    parent: null,
    folder,
    client: { name: 'claude-code', version: '2.1.310' },
  };
}

test('step 5: a reply in the same Slack thread goes to the session that took the first message, before any routing', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(
    async (harness) => {
      await connect(harness);
      // The thread workflow (spec W36): the session that took this conversation first; Which project? only for none.
      await approveWorkflows(harness, [localise(fixture('thread'), harness)]);
      const native = randomUUID();
      const taker = harness.relay.addSession({ cwd: harness.acme, nativeSessionId: native });

      // The first message starts a conversation nobody has taken: it is routed, and given to the one session there.
      const parentTs = harness.slack.post({ text: `${SENTINEL} the booking form fails on Safari` });
      const [first] = await until(
        harness,
        () => runsOf(harness, 'client-thread'),
        (runs) => runs[0]?.state === 'done',
        'the first run',
      );
      assert.ok(first);
      assert.deepEqual((await runShow(harness, first.id)).path, ['thread', 'route', 'find', 'give']);
      assert.equal(harness.relay.runs[0]?.sessionId, taker.id);
      // Offered to that session, which takes it — as Slack's take records a message no one has answered yet: no thread.
      assert.match(harness.relay.runs[0]?.prompt.split('\n\n')[1] ?? '', /It is offered to this session until/u);
      const takes = new TakeStore(harness.stateDir, {
        now: () => new Date(harness.time.now()),
        running: () => true,
        probe: async () => null,
      });
      await takes.take(
        { channel: 'slack', accountId: ACCOUNT_ID, id: `${CONVERSATION}/${parentTs}`, thread: null },
        window(native, harness.acme),
      );
      harness.relay.endRun(taker.id);
      // A newer idle session in the same project: the one a search of the project would choose.
      const newer: FakeSession = harness.relay.addSession({ cwd: harness.acme, nativeSessionId: randomUUID() });

      // The reply, in the same thread.
      harness.slack.post({ text: `${SENTINEL} any news on this?`, threadTs: parentTs });
      const runs = await until(
        harness,
        () => runsOf(harness, 'client-thread'),
        (all) => all.length === 2 && all[1]?.state === 'done',
        'the reply’s run',
      );
      const reply = runs[1] as RunRow;
      assert.deepEqual((await runShow(harness, reply.id)).path, ['thread', 'give'], 'no routing, no search');
      assert.equal(stepOf(harness, reply.id, 'thread')?.outcome, 'idle');
      assert.deepEqual(
        stepOf(harness, reply.id, 'route'),
        { state: 'skipped', outcome: null },
        'Which project? never ran',
      );
      assert.equal(harness.relay.runs.length, 2);
      assert.equal(harness.relay.runs[1]?.sessionId, taker.id, 'the session that took the first message');
      assert.notEqual(harness.relay.runs[1]?.sessionId, newer.id);
    },
    { taking: true },
  );
});

test('the none path: no idle session anywhere, a worktree on ac/acme-2, a session started in it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withOwner(async (harness) => {
    await connect(harness);
    await approveWorkflows(harness, [ownerExample(harness)]);
    // The repository's own hooks would write a marker on any checkout: the event service's git runs none of them.
    const marker = join(harness.root, 'hook-ran');
    await mkdir(join(harness.acme, '.githooks'));
    await writeFile(join(harness.acme, '.githooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o755,
    });
    harness.git(harness.acme, 'config', 'core.hooksPath', '.githooks');
    // An earlier message's issue is ACME-1, so this run's is ACME-2.
    harness.linear.issues.push({
      id: randomUUID(),
      identifier: 'ACME-1',
      url: 'https://linear.app/example/issue/ACME-1',
      input: {},
    });
    // No idle Claude session anywhere: a Codex one in acme-site, and a Claude one busy in billing.
    harness.relay.addSession({ cwd: harness.acme, provider: 'codex' });
    harness.relay.startRunElsewhere(harness.relay.addSession({ cwd: harness.billing }).id);
    const before = harness.relay.sessions.length;

    harness.slack.post({ text: `${SENTINEL} the footer link is broken` });
    const [run] = await until(
      harness,
      () => runsOf(harness, 'client-asks'),
      (runs) => runs.length === 1 && stepOf(harness, runs[0]?.id ?? '', 'wait')?.state === 'waiting',
      'the run to give the new session its turn',
    );
    assert.ok(run);
    assert.equal(stepOf(harness, run.id, 'find')?.outcome, 'none');
    assert.equal(stepOf(harness, run.id, 'another')?.outcome, 'none');
    // Step 10: a worktree of acme-site beside its checkout, on the issue's branch, made without the repository's hooks.
    const tree = join(`${harness.acme}-wt`, 'ac-acme-2');
    const shown = await runShow(harness, run.id);
    assert.deepEqual(shown.steps.find((step) => step.stepId === 'tree')?.output, {
      branch: 'ac/acme-2',
      path: tree,
      refusal: null,
    });
    const listed = harness.git(harness.acme, 'worktree', 'list', '--porcelain');
    assert.match(
      listed,
      new RegExp(
        `worktree ${tree.replaceAll(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}\\nHEAD [0-9a-f]+\\nbranch refs/heads/ac/acme-2`,
        'u',
      ),
    );
    assert.equal(
      await readFile(marker).then(
        () => true,
        () => false,
      ),
      false,
      'no hook of the repository ran',
    );
    // Step 8: one session started, in that worktree, under the run's marker; the turn is given there.
    assert.equal(harness.relay.sessions.length, before + 1);
    const started = harness.relay.sessions.at(-1) as FakeSession;
    assert.deepEqual([started.cwd, started.provider, started.requestedMode], [tree, 'claude', 'manual']);
    assert.equal(started.title, `Agent Comms · client-asks · ${run.id.slice(4, 12)}`);
    assert.equal(harness.relay.runs.at(-1)?.sessionId, started.id);
    harness.relay.endRun(started.id, 'completed', { outcome: 'done', summary: SUMMARY });
    await until(
      harness,
      () => runsOf(harness, 'client-asks')[0]?.state,
      (state) => state === 'done',
      'the run to finish',
    );
    assert.deepEqual((await runShow(harness, run.id)).path, [
      'route',
      'found',
      'issue',
      'find',
      'another',
      'tree',
      'start',
      'give',
      'wait',
      'note',
    ]);
    assert.equal(harness.linear.issue('ACME-2')?.state, 'Done');
    assert.equal(harness.linear.issue('ACME-1')?.state, null, 'an issue this run did not make is never touched');
  });
});

/** Past a step's claim lease (`RUN_STEP_LEASE_MS`, 30 seconds) and an event delivery's: what a restart waits out. */
const LEASE_LAPSED = 31_000;

/**
 * A crash at `point` in the first life of every claim: the first call there throws, the next — the claim again, after
 * the restart — passes, the one after throws again, and so on. Every step is cut short once, at that point.
 */
function crashingAt(point: WorkflowFailpoint): {
  readonly failpoint: (at: WorkflowFailpoint) => void;
  /** The steps each crash cut short, in order, as `running` reads them at the crash. */
  readonly cut: string[];
  /** Which steps are claimed now: set once the harness's store can be read. */
  running: () => readonly string[];
  takePending(): boolean;
} {
  let calls = 0;
  let pending = false;
  const crash = {
    cut: [] as string[],
    running: (): readonly string[] => [],
    failpoint(at: WorkflowFailpoint) {
      if (at !== point) return;
      calls += 1;
      if (calls % 2 === 0) return;
      crash.cut.push(...crash.running());
      pending = true;
      throw new Error(`a crash at ${at}`);
    },
    takePending() {
      const was = pending;
      pending = false;
      return was;
    },
  };
  return crash;
}

for (const point of ['after-claim', 'after-effect', 'before-settle-commit'] as const)
  test(`a restart in the middle of every step resumes with no second effect (a crash ${point.replaceAll('-', ' ')})`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const crash = crashingAt(point);
    const hook = await webhookReceiver();
    try {
      await withOwner(
        async (harness) => {
          crash.running = () =>
            harness.database
              .prepare("SELECT step_id FROM workflow_steps WHERE state = 'running' ORDER BY step_id")
              .all()
              .map((row) => (row as { step_id: string }).step_id);
          await connect(harness);
          await approveWorkflows(harness, [ownerExample(harness)]);
          const { live, secret } = await subscribe(harness, hook);
          live.close();
          harness.linear.issues.push({
            id: randomUUID(),
            identifier: 'ACME-1',
            url: 'https://linear.app/example/issue/ACME-1',
            input: {},
          });
          harness.slack.post({ text: `${SENTINEL} the footer link is broken` });
          // The owner runs until the run is done; each crash stops it, and another starts on the same state once the
          // crashed claim's lease has lapsed. The session's turn ends once, whichever owner is there to hear it.
          let restarts = 0;
          let ended = false;
          const deadline = Date.now() + 240_000;
          for (;;) {
            const run = runsOf(harness, 'client-asks')[0];
            if (run?.state === 'done') break;
            if (Date.now() > deadline) assert.fail(`the run never finished: ${JSON.stringify(seen(harness))}`);
            await harness.tick();
            await new Promise((resolve) => setTimeout(resolve, 20));
            if (crash.takePending()) {
              harness.time.advance(LEASE_LAPSED);
              await harness.restart();
              restarts += 1;
              continue;
            }
            const turn = harness.relay.runs.find((candidate) => candidate.startId !== undefined);
            if (!ended && turn?.status === 'running' && stepOf(harness, run?.id ?? '', 'wait')?.state === 'waiting') {
              harness.relay.endRun(turn.sessionId, 'completed', { outcome: 'done', summary: SUMMARY });
              ended = true;
            }
          }
          const [run] = runsOf(harness, 'client-asks');
          assert.ok(run);
          const path = (await runShow(harness, run.id)).path;
          assert.deepEqual(path, [
            'route',
            'found',
            'issue',
            'find',
            'another',
            'tree',
            'start',
            'give',
            'wait',
            'note',
          ]);
          // Every step was cut short (a deliver step and a wait twice: their claim, and their wake), and restarted.
          assert.deepEqual([...new Set(crash.cut)].sort(), [...path].sort(), `cut short: ${crash.cut.join(', ')}`);
          assert.equal(restarts, crash.cut.length);
          const steps = harness.database
            .prepare('SELECT step_id, settle_seq FROM workflow_steps WHERE run_id = ? AND state = ? ORDER BY step_id')
            .all(run.id, 'done')
            .map((row) => ({ ...row }));
          assert.equal(steps.length, path.length, 'each step on the path settled, once');

          // No second effect, counted in the fakes.
          const tree = join(`${harness.acme}-wt`, 'ac-acme-2');
          assert.equal(
            harness.relay.requests.filter((request) => request.method === 'POST' && request.path === '/v1/sessions')
              .length,
            1,
            'one session started',
          );
          const started = harness.relay.sessions.filter((session) => session.cwd === tree);
          assert.equal(started.length, 1);
          assert.equal(
            harness.relay.runs.filter((candidate) => candidate.sessionId === started[0]?.id).length,
            1,
            'one turn given',
          );
          assert.deepEqual(
            harness.linear.issues.map((issue) => issue.identifier),
            ['ACME-1', 'ACME-2'],
            'one issue made',
          );
          assert.equal(harness.linear.comments.length, 1, 'one comment');
          assert.equal(harness.linear.updates.length, 1, 'one state change');
          assert.equal(harness.linear.issue('ACME-2')?.state, 'Done');
          const worktrees = harness
            .git(harness.acme, 'worktree', 'list', '--porcelain')
            .split('\n')
            .filter((line) => line.startsWith('worktree '));
          assert.deepEqual(worktrees, [`worktree ${harness.acme}`, `worktree ${tree}`], 'one worktree made');
          const raised = harness.database
            .prepare('SELECT type, COUNT(*) AS count FROM workflow_events WHERE run_id = ? GROUP BY type ORDER BY type')
            .all(run.id)
            .map((row) => ({ ...row }));
          const types = [
            'acme.client-asks.found.project-found',
            'acme.client-asks.give.given',
            'acme.client-asks.issue.created',
            'acme.client-asks.note.closed',
            'acme.client-asks.route.matched',
            'acme.client-asks.run.finished',
          ];
          assert.deepEqual(
            raised,
            types.map((type) => ({ type, count: 1 })),
            'one event per ticked transition',
          );
          // A webhook may be sent again after a crash — at least once — but always as the same event, the same id.
          await until(
            harness,
            () => new Set(hook.requests.map((request) => request.headers['webhook-id'])).size,
            (count) => count === types.length,
            'every event to reach the webhook',
          );
          const byId = new Map(hook.requests.map((request) => [request.headers['webhook-id'], request.body]));
          assert.deepEqual(
            [...new Set([...byId.values()].map((body) => (JSON.parse(body) as { type: string }).type))].sort(),
            types,
          );
          for (const request of hook.requests) {
            assert.equal(request.body, byId.get(request.headers['webhook-id']), 'a repeat is byte for byte the same');
            assert.deepEqual(signedWith(secret, request), [true]);
          }
        },
        { owner: { workflows: { failpoint: crash.failpoint } } },
      );
    } finally {
      await hook.server.close();
    }
  });

test("a webhook subscriber that hangs leaves the run's timing unchanged", { skip: WINDOWS_SKIP }, async () => {
  const hook = await webhookReceiver('hang');
  try {
    await withOwner(async (harness) => {
      await connect(harness);
      // The owner example's first steps, then a short pause, so the run spans ticks a hanging delivery could hold.
      const document = ownerExample(harness) as Doc & { flow: { steps: Record<string, Doc> }; retention: Doc };
      const { route, found } = document.flow.steps as { route: Doc; found: Doc };
      document.flow.steps = {
        route: { ...route, next: { otherwise: 'found' } },
        found: { ...found, next: { otherwise: 'pause' } },
        pause: { kind: 'wait', for: { time: { afterMs: 250 } }, timeoutMs: HOUR, next: {} },
      };
      document.targets = [];
      delete document.retention.queueMs;
      await approveWorkflows(harness, [document]);
      const subscribed = await subscribe(harness, hook);
      subscribed.live.close();
      // From here the owner runs on its own quick timer, as on the person's Mac: the test ticks nothing.
      await harness.restart({ tickMs: 50 });
      const live = await subscribed.reconnect();
      try {
        harness.slack.post({ text: `${SENTINEL} the footer link is broken` });
        const [run] = await until(
          harness,
          () => runsOf(harness, 'client-asks'),
          (runs) => runs[0]?.state === 'done',
          'the run to finish',
          { ownTicks: true },
        );
        assert.ok(run);
        assert.deepEqual((await runShow(harness, run.id)).path, ['route', 'found', 'pause']);
        assert.ok(run.updated_at - run.started_at < 1_000, `the run took ${run.updated_at - run.started_at} ms`);
        // The subscriber had its first event's request, and held it open, unanswered, while the run went on.
        assert.ok(hook.requests.length >= 1, 'the webhook was asked');
        assert.ok((hook.requests[0] as Received).at < run.updated_at, 'before the run finished');
        assert.equal(hook.hanging(), 1, 'and it still holds that request open');
        const deliveries = harness.database
          .prepare("SELECT state FROM event_deliveries WHERE subscriber_id = 'crm-hook' ORDER BY ordering_sequence")
          .all()
          .map((row) => (row as { state: string }).state);
        assert.deepEqual(deliveries, ['disclosing', 'queued', 'queued'], 'the rest wait behind it, in order');
        // One subscriber's hang holds back no other's: the live one had every event, in order.
        await until(
          harness,
          () => live.messages.length,
          (count) => count >= 3,
          'the live subscriber',
          { ownTicks: true },
        );
        assert.deepEqual(typesOf(live.messages), [
          'acme.client-asks.route.matched',
          'acme.client-asks.found.project-found',
          'acme.client-asks.run.finished',
        ]);
      } finally {
        live.close();
        hook.release();
      }
    });
  } finally {
    await hook.server.close();
  }
});
