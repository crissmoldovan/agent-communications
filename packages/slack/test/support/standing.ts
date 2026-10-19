import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import {
  type ApprovalRecord,
  asV2,
  type Core,
  type Notifier,
  openCore,
  type StandingNotice,
  type Streams,
} from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { SLACK_CALLER } from '../../src/caller.ts';
import { run } from '../../src/cli/program.ts';
import { SlackContext } from '../../src/context.ts';
import { createSlackMcpServer } from '../../src/mcp/server.ts';
import {
  type FakeSlack,
  type SlackRequest,
  type SlackWorld,
  startFakeSlack,
  type WorldMessage,
  type WorldRoom,
  type WorldUser,
} from './fake-slack.ts';
import { type Harness, newHarness } from './harness.ts';

/**
 * A workspace that can post, a stateful Slack on a loopback port and a clock the test moves — for the tests of standing
 * approvals (design 2026-10-19-standing-approvals): making one, approving it at a terminal, and using it. Nothing here
 * reaches the real Slack: the fake is the loopback one, and every request reaches it only through the guard.
 *
 * Ids as Slack writes them, long enough for core's id patterns. The person is {@link SELF}; the app's bot user
 * {@link BOT}; Sam and Ana are colleagues; {@link STRANGER} and {@link OUTSIDER} are from another organisation.
 */

export const SELF = 'U0001';
export const BOT = 'U0BOT0001';
export const SAM = 'U0SAM';
export const ANA = 'U0ANA';
/** Someone whose `team_id` is another organisation's. */
export const OUTSIDER = 'U0OUT';
/** Someone Slack calls `is_stranger`, with this workspace's own team id. */
export const STRANGER = 'U0STR';
/** An Enterprise Grid member from another workspace of the same organisation: a `W…` id, the same team id here. */
export const GRID = 'W0GRID';

/** `#eng`: the person, Sam, Ana and the app's bot user. */
export const ENG = 'C0ENG';
/** `#general`: sixty members, a big room. */
export const GENERAL = 'C0GENERAL';
/** `#townhall`: sixty members too, but Slack's answer for it carries no `num_members`, so they are paged and counted. */
export const TOWNHALL = 'C0TOWNHALL';
/** `#partners`: shared with another organisation, an outsider in it. */
export const PARTNERS = 'C0PARTNERS';
/** `#vendors`: an invitation to share it with another organisation is pending. */
export const VENDORS = 'C0VENDORS';
/** `#grid`: shared across an Enterprise Grid's own workspaces, and nobody else. */
export const GRIDROOM = 'C0GRIDROOM';
/** `#blind`: how many are in it cannot be read. */
export const BLIND = 'C0BLIND';
/** `#private`: a private channel, which the app's bot user has not joined. */
export const PRIVATE = 'G0PRIVATE';
/** A group DM of the person, Sam and Ana, whose answer carries no `num_members`. */
export const MPIM = 'G0MPIM';
/** The DM with Sam. */
export const SAM_DM = 'D0SAM';
/** `#mixed`: an outsider in it, though Slack does not say it is shared. */
export const MIXED = 'C0MIXED';
/** `#strange`: someone Slack calls a stranger in it, and no sharing flag. */
export const STRANGE = 'C0STRANGE';
/** `#extonly`: shared with another organisation by Slack's flag, though everyone in it reads as from here. */
export const EXTONLY = 'C0EXTONLY';

/** Sixty members of `#general`, the person among them. */
const CROWD = [SELF, ...Array.from({ length: 59 }, (_, index) => `U0C${String(index).padStart(3, '0')}`)];

export function standingRooms(): Record<string, WorldRoom> {
  return {
    [ENG]: { name: 'eng', members: [SELF, SAM, ANA, BOT] },
    [GENERAL]: { name: 'general', members: [...CROWD, BOT] },
    [TOWNHALL]: { name: 'townhall', num_members: null, members: [...CROWD] },
    [PARTNERS]: { name: 'partners', is_ext_shared: true, members: [SELF, SAM, OUTSIDER, BOT] },
    [VENDORS]: { name: 'vendors', is_pending_ext_shared: true, members: [SELF, ANA, BOT] },
    [GRIDROOM]: { name: 'grid', is_org_shared: true, members: [SELF, GRID, BOT] },
    [BLIND]: { name: 'blind', num_members: null, members_unreadable: true, members: [SELF, SAM] },
    [PRIVATE]: { name: 'private', is_private: true, members: [SELF, SAM] },
    [MPIM]: { name: 'mpdm-jo--sam--ana-1', is_mpim: true, num_members: null, members: [SELF, SAM, ANA] },
    [SAM_DM]: { is_im: true, user: SAM, members: [SELF, SAM] },
    [MIXED]: { name: 'mixed', members: [SELF, SAM, OUTSIDER, BOT] },
    [STRANGE]: { name: 'strange', members: [SELF, SAM, STRANGER, BOT] },
    [EXTONLY]: { name: 'extonly', is_ext_shared: true, members: [SELF, SAM, BOT] },
  };
}

export function standingUsers(): Record<string, WorldUser> {
  const users: Record<string, WorldUser> = {
    [SELF]: { display_name: 'Jo', real_name: 'Jo Example' },
    [BOT]: { real_name: 'Acme Agent', is_bot: true },
    [SAM]: { display_name: 'Sam' },
    [ANA]: { display_name: 'Ana' },
    [OUTSIDER]: { display_name: 'Olu', team_id: 'T0OTHER' },
    [STRANGER]: { display_name: 'Stef', is_stranger: true },
    [GRID]: { display_name: 'Gia' },
  };
  for (const member of CROWD) users[member] ??= { display_name: member.toLowerCase() };
  return users;
}

export interface StandingWorld {
  readonly harness: Harness;
  /** The core every surface here is given, on the test's clock. */
  readonly core: Core;
  readonly context: SlackContext;
  readonly fake: FakeSlack;
  readonly world: SlackWorld;
  readonly slack: { fetch: FakeSlack['fetch'] };
  /** The test's clock, in milliseconds: move it, and everything here sees the time move. */
  readonly clock: { now: number };
  /** Every notice raised on the person's screen, when the world was made with the recording notifier. */
  readonly notices: StandingNotice[];
  /** What Slack was asked, by method. */
  requests(method: string): SlackRequest[];
}

export interface StandingWorldOptions {
  readonly sendPolicy?: 'chat' | 'confirm' | 'never';
  /** `agent` by default: no rule. `me` plants the rule a person sets to switch the label off for the workspace. */
  readonly identity?: 'agent' | 'me';
  /** Whether the workspace has its app's bot token: yes by default. */
  readonly bot?: boolean;
  readonly rooms?: Record<string, WorldRoom>;
  readonly messages?: WorldMessage[];
  /**
   * What raises a standing act's notice: one that records into `notices` when left out, none at all for `null`. Never
   * the platform's real notifier: no test shows a notification.
   */
  readonly notify?: Notifier | null;
}

export async function standingWorld(t: TestContext, options: StandingWorldOptions = {}): Promise<StandingWorld> {
  const harness = await newHarness();
  await harness.addWorkspace({
    alias: 'acme',
    mode: 'send',
    identity: options.identity ?? 'agent',
    ...(options.bot === false ? {} : { bot: { userId: BOT } }),
    ...(options.sendPolicy === undefined ? {} : { sendPolicy: options.sendPolicy }),
  });
  const fake = await startFakeSlack();
  t.after(() => fake.close());
  const clock = { now: Date.now() };
  const world = fake.world({
    self: SELF,
    botUserId: BOT,
    users: standingUsers(),
    rooms: options.rooms ?? standingRooms(),
    messages: options.messages ?? [],
    // What the gate posts is timed by the test's clock, so it reads as just posted.
    tsNow: () => clock.now,
  });
  const now = () => new Date(clock.now);
  const core = openCore({ env: harness.env, caller: SLACK_CALLER, now });
  const notices: StandingNotice[] = [];
  const recording: Notifier = async (notice) => {
    notices.push(notice);
    return { raised: true };
  };
  // `null` reaches the context as it is: left out, the context would take the platform's real notifier.
  const notify = options.notify === null ? null : (options.notify ?? recording);
  const context = new SlackContext({
    core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    now,
    platform: 'darwin',
    surface: 'mcp',
    notify,
  });
  return {
    harness,
    core,
    context,
    fake,
    world,
    slack: { fetch: fake.fetch },
    clock,
    notices,
    requests: (method) => fake.requests.filter((request) => request.method === method),
  };
}

/** A record as the store holds it now. */
export async function recordOf(w: StandingWorld, approvalId: string): Promise<ApprovalRecord> {
  const record = asV2(await w.core.approvals.get(approvalId));
  if (record === null) throw new Error(`no record ${approvalId}`);
  return record;
}

/**
 * A terminal a person sits at: stdin and stdout are terminals, and whatever the code asked for is typed back, as the
 * person reads it off the screen. `answer` types something else instead — a `yes`, say, or what a function makes of
 * the code shown.
 */
export function terminal(answer?: string | ((code: string) => string)): Streams & { readonly said: () => string } {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let said = '';
  stdout.on('data', (chunk) => {
    said += String(chunk);
  });
  stderr.on('data', (chunk) => {
    said += String(chunk);
    const code = /Type (\w{4}) to approve/.exec(String(chunk))?.[1];
    if (code !== undefined) stdin.write(`${typeof answer === 'function' ? answer(code) : (answer ?? code)}\n`);
  });
  return { stdin, stdout, stderr, said: () => said } as unknown as Streams & { readonly said: () => string };
}

/** Streams no person sits at: what an agent's shell gives a command. */
function piped(): Streams & { readonly out: () => string; readonly err: () => string } {
  let out = '';
  let err = '';
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  return {
    stdout: Object.assign(stdout, { isTTY: false }),
    stderr: Object.assign(stderr, { isTTY: false }),
    stdin: Object.assign(new PassThrough(), { isTTY: false }),
    out: () => out,
    err: () => err,
  } as unknown as Streams & { readonly out: () => string; readonly err: () => string };
}

export interface CliOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  json<T>(): { ok: boolean; data?: T; error?: { code: string; message: string; hint?: string; details?: any } };
}

/**
 * Runs `agent-slack` against this world: as an agent's shell (no terminal) unless `streams` says a person sits there.
 * `env` is laid over the harness's: an agent marker, for one.
 */
export async function cli(
  w: StandingWorld,
  argv: readonly string[],
  options: { streams?: Streams & { readonly said?: () => string }; env?: NodeJS.ProcessEnv } = {},
): Promise<CliOutcome> {
  const fallback = piped();
  const streams = options.streams ?? fallback;
  const code = await run([...argv], {
    core: w.core,
    env: { ...w.harness.env, ...options.env },
    platform: 'darwin',
    now: () => new Date(w.clock.now),
    exchange: (params) => w.harness.exchange(params),
    streams,
    openBrowser: () => undefined,
    probe: (input, init) => w.harness.probe(input, init),
    read: w.fake.fetch,
    // The world's notifier, or none: never the platform's real one.
    notify: w.context.notify ?? null,
  });
  const stdout = options.streams === undefined ? fallback.out() : (options.streams.said?.() ?? '');
  const stderr = options.streams === undefined ? fallback.err() : '';
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
}

export interface ToolOutcome {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, any>;
}

/** A client of the Slack MCP server, and how it calls a tool. */
export interface McpClient {
  readonly client: Client;
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

/** The Slack MCP server over this world, as a client reaches it. */
export async function mcp(w: StandingWorld, t: TestContext): Promise<McpClient> {
  const { server } = await createSlackMcpServer({
    core: w.core,
    env: w.harness.env,
    fetch: w.fake.fetch,
    platform: 'darwin',
    now: () => new Date(w.clock.now),
    // The world's notifier, or none: never the platform's real one.
    notify: w.context.notify ?? null,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  t.after(() => Promise.all([client.close(), server.close()]));
  return {
    client,
    call: async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> =>
      (await client.callTool({ name, arguments: args })) as ToolOutcome,
  };
}
