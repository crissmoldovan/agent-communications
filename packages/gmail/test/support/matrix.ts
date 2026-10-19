import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import * as lib from '@agentcomms/core';
import { ApprovalStore, type ChangeBinding } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  arrange,
  drive,
  emitter,
  type MatrixClock,
  type MatrixSurface,
  matrixClock,
  NOBODY,
  type Observation,
  observeError,
  observeTool,
  routeOf,
  WRONG_CODE,
  wrongCodesOf,
} from '../../../../test/helpers/approval-matrix.mjs';
import { run } from '../../src/cli/program.ts';
import { GmailContext } from '../../src/context.ts';
import { createGmailMcpServer } from '../../src/mcp/server.ts';
import { createDraft } from '../../src/operations/drafts.ts';
import { beginApproval, finishApproval, prepareSend } from '../../src/operations/send.ts';
import { DRAFT_SEND_PATH, type FakeMessage } from './fake-google.ts';
import { type Harness, newHarness, setAgentLabel, tempDir } from './harness.ts';

/*
 * Gmail's sends in the D2 matrix (CUE-404 Task 24): `test/approval-matrix.test.mjs` runs this as its own program,
 * with `AGENTCOMMS_MATRIX_OUT` naming the file each observation is appended to, and holds what each must say. Every
 * row starts from a send this package prepared itself (`prepareSend`) on a fresh home and a fake Google, with the
 * approval store on a clock of its own; `test/helpers/approval-matrix.mjs` puts it into the row's state.
 *
 * The surfaces: `gmail_draft_send` from an ordinary client, from a client trusted with forms, and from a server pinned
 * to the mailbox; `send execute` at the command line; the terminal approval (`approve`: its begin, then its finish);
 * `gmail_send_wait`; and `gmail_send_list`.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface World {
  harness: Harness;
  core: lib.Core;
  context: GmailContext;
  clock: MatrixClock;
  draftId: string;
  approvalId: string;
  notFound(action: string): Promise<ReadonlyArray<readonly [string, string]>>;
  fault(): void;
  asked(): number;
}

const TRUSTED = 'trusted-client';
const emit = emitter('send', 'gmail');

async function world(row: string): Promise<World> {
  const route = routeOf(row);
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo', isDefault: true, isPrimary: true }],
      },
      {
        sub: 'sub-2',
        email: 'kim@home.test',
        sendAs: [{ sendAsEmail: 'kim@home.test', displayName: 'Kim', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: route });
  await harness.connectInbox({ alias: 'home', email: 'kim@home.test', sub: 'sub-2', sendPolicy: 'chat' });
  // `home` signs in as the first account, whose send-as list has no name for its address: the label's comes from here.
  await setAgentLabel(harness, { name: 'Kim Example' });
  // No escalation from what was read — each row's route is its policy's — and one client trusted with forms.
  await harness.core.config.update(
    (config) => ({
      ...config,
      defaults: {
        ...config.defaults,
        riskEscalation: false,
        confirm: { ...config.defaults.confirm, elicitationClients: [TRUSTED] },
      },
    }),
    {
      consent: {
        kind: 'loosening-consent',
        paths: ['defaults.riskEscalation', 'defaults.confirm.elicitationClients'],
      },
    },
  );
  const clock = matrixClock();
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now: clock.now,
    handoffs: harness.core.handoffs,
    loadConfig: () => harness.core.config.load(),
    audit: harness.core.audit,
  });
  const context = new GmailContext({ core: harness.core, env: harness.env, platform: 'darwin' });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Tuesday.' });
  const prepared = await prepareSend(context, 'work', draft.draftId);

  /** Another mailbox's send. */
  const foreign = async () => {
    const theirs = await createDraft(context, 'home', { to: ['sam@partner.test'], subject: 'Home', text: 'Home.' });
    return (await prepareSend(context, 'home', theirs.draftId)).approvalId;
  };
  /** A change's approval: another kind. */
  const change = async () => {
    const binding: ChangeBinding = {
      summary: 'Let the default send policy be chat',
      target: null,
      loosened: [{ path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' }],
      settings: [],
      effects: [],
    };
    return (await harness.core.approvals.createChange({ channel: 'gmail', change: binding, policy: 'chat' }))
      .approvalId;
  };
  /** Another channel's send, as Resend's prepare writes one for a Resend account on this machine: not Gmail's. */
  const otherChannel = async () => {
    const id = lib.newAccountId();
    const handle = `key_${id.slice(-8).toLowerCase()}`;
    await harness.core.config.update(
      (config) => ({
        ...config,
        accounts: {
          ...config.accounts,
          mail: {
            id,
            platform: 'resend',
            workspace: handle,
            userId: handle,
            tier: 'send',
            mode: 'send',
            grantedScopes: ['sending_access'],
            secretRef: `resend:key:${id}`,
            createdAt: '2026-09-26T10:00:00.000Z',
          },
        },
      }),
      { consent: { kind: 'loosening-consent', paths: ['accounts.mail.mode'] } },
    );
    return (
      await harness.core.approvals.create({
        channel: 'resend',
        inboxId: id,
        inboxSub: handle,
        draftId: 'rsd_other',
        draftMessageId: 'other',
        contentDigest: 'b'.repeat(64),
        sendEpoch: 0,
        policy: 'chat',
        requiredPolicy: 'chat',
        riskFlags: [],
        expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Other' },
      })
    ).approvalId;
  };

  return {
    harness,
    core: harness.core,
    context,
    clock,
    draftId: draft.draftId,
    approvalId: prepared.approvalId,
    // What each surface must not find: a claim names its mailbox, a pinned server has one, the terminal is Gmail's
    // and approves a send, and an unpinned wait answers for any approval on this machine (D2: unpinned surfaces show
    // every record), so only an id nobody prepared is not found there.
    notFound: async (action) => {
      if (action === 'claim') {
        return [
          ['nobody', NOBODY],
          ['another mailbox', await foreign()],
          ['another kind', await change()],
        ];
      }
      if (action === 'approve') {
        return [
          ['nobody', NOBODY],
          ['another channel', await otherChannel()],
          ['another kind', await change()],
        ];
      }
      return [['nobody', NOBODY]];
    },
    fault: () => harness.google.failNext(DRAFT_SEND_PATH, 1, 500),
    asked: () => gmailAsked(harness),
  };
}

/** Every request made of Gmail's own API — reading a draft, a message, Sent — apart from signing in. */
function gmailAsked(harness: Harness): number {
  return harness.google.requests.filter((request) => request.path.startsWith('/gmail/')).length;
}

const sendsOf = (w: World) => w.harness.google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length;

/** An MCP client on this world's server: ordinary, trusted with forms (answering them as `form` says), or pinned. */
async function mcp(
  w: World,
  options: { trusted?: boolean; form?: 'accept' | 'decline' | 'cancel'; pinned?: string } = {},
): Promise<{ call(name: string, args: Record<string, unknown>): Promise<ToolResult>; close(): Promise<void> }> {
  const built = await createGmailMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    ...(options.pinned ? { inbox: options.pinned } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: options.trusted ? TRUSTED : 'test-client', version: '1.0.0' },
    options.trusted ? { capabilities: { elicitation: {} } } : {},
  );
  if (options.trusted) {
    client.setRequestHandler('elicitation/create', async (request) => {
      if (options.form === 'decline') return { action: 'decline' as const };
      if (options.form === 'cancel') return { action: 'cancel' as const };
      const code = /Type ([A-Za-z0-9_-]{4}) to send/.exec(request.params.message)?.[1] ?? WRONG_CODE;
      return { action: 'accept' as const, content: { code } };
    });
  }
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    call: async (name, args) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await built.close();
    },
  };
}

/** `gmail_draft_send`, as an agent calls it. */
async function draftSend(w: World, approvalId: string, options: Parameters<typeof mcp>[1] = {}): Promise<Observation> {
  const client = await mcp(w, options);
  try {
    const before = sendsOf(w);
    const result = await client.call('gmail_draft_send', {
      ...(options.pinned ? {} : { inbox: 'work' }),
      approvalId,
    });
    return observeTool(result, sendsOf(w) - before);
  } finally {
    await client.close();
  }
}

/** `send execute --json`, at the command line. */
async function execute(w: World, approvalId: string): Promise<Observation> {
  let stdout = '';
  const out = new PassThrough().on('data', (chunk) => {
    stdout += String(chunk);
  });
  const before = sendsOf(w);
  const exit = await run(['send', 'execute', approvalId, '--inbox', 'work', '--json'], {
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(new PassThrough(), { isTTY: false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
  });
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  const seen = observeTool(
    envelope.ok ? { structuredContent: envelope.data ?? {} } : { isError: true, structuredContent: envelope },
    sendsOf(w) - before,
  );
  return { ...seen, extra: { exit } };
}

/** The terminal approval: its begin, then its finish with the code it showed — or a wrong one, as the row says. */
async function approve(w: World, approvalId: string, row: string): Promise<Observation> {
  const before = sendsOf(w);
  let challenge: string;
  try {
    challenge = (await beginApproval(w.context, approvalId)).challenge;
  } catch (error) {
    return { ...observeError(error, sendsOf(w) - before), extra: { step: 'begin' } };
  }
  const wrong = wrongCodesOf(row);
  if (wrong === 0) {
    try {
      const approved = await finishApproval(w.context, approvalId, challenge);
      return { ok: true, approval: { ...(await w.core.approvals.approvalOf(approved)) }, sends: sendsOf(w) - before };
    } catch (error) {
      return { ...observeError(error, sendsOf(w) - before), extra: { step: 'finish' } };
    }
  }
  let last: Observation = { ok: true, sends: 0 };
  for (let attempt = 1; attempt <= wrong; attempt += 1) {
    try {
      await finishApproval(w.context, approvalId, WRONG_CODE);
    } catch (error) {
      last = { ...observeError(error, sendsOf(w) - before), extra: { step: 'finish', attempt } };
    }
  }
  const stored = lib.asV2(await w.core.approvals.get(approvalId));
  return { ...last, extra: { ...last.extra, stored: stored?.state } };
}

async function look(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  const client = await mcp(w, pinned ? { pinned } : {});
  try {
    return observeTool(await client.call('gmail_send_wait', { approvalId, waitSeconds: 0 }), 0, { look: true });
  } finally {
    await client.close();
  }
}

async function list(w: World, approvalId: string): Promise<Observation> {
  const client = await mcp(w);
  try {
    const result = await client.call('gmail_send_list', {});
    if (result.isError) return observeTool(result, 0);
    const approvals = (result.structuredContent?.approvals ?? []) as Array<Record<string, unknown>>;
    return { ok: true, approval: approvals.find((each) => each.approvalId === approvalId) ?? null, sends: 0 };
  } finally {
    await client.close();
  }
}

const SURFACES: ReadonlyArray<MatrixSurface<World>> = [
  { name: 'gmail_send_wait', action: 'look', act: (w, id) => look(w, id) },
  { name: 'gmail_send_list', action: 'list', act: (w, id) => list(w, id) },
  { name: 'gmail_draft_send', action: 'claim', act: (w, id) => draftSend(w, id) },
  {
    name: 'gmail_draft_send (a client trusted with forms)',
    action: 'claim',
    act: (w, id) => draftSend(w, id, { trusted: true, form: 'accept' }),
  },
  { name: 'send execute', action: 'claim', act: (w, id) => execute(w, id) },
  { name: 'approve (terminal)', action: 'approve', act: (w, id, row) => approve(w, id, row) },
];

await drive('send', { world, surfaces: SURFACES, emit, lib });

// What only some surfaces meet: a server pinned to the mailbox, given another's id; a trusted form declined or
// cancelled — one decision, or none.
{
  const w = await world('not-found');
  const theirs = (await w.notFound('claim'))[1]?.[1] as string;
  for (const [surface, act] of [
    ['gmail_draft_send (pinned)', 'claim'],
    ['gmail_send_wait (pinned)', 'look'],
  ] as const) {
    const seen = act === 'claim' ? await draftSend(w, theirs, { pinned: 'work' }) : await look(w, theirs, 'work');
    emit(
      'not-found',
      { name: surface, action: act, act: async () => seen },
      {
        ...seen,
        extra: { variant: 'pinned away', id: theirs },
      },
    );
  }
}
for (const form of ['decline', 'cancel'] as const) {
  const w = await world('pending-confirm');
  await arrange('pending-confirm', { core: w.core, lib, clock: w.clock, approvalId: w.approvalId });
  const seen = await draftSend(w, w.approvalId, { trusted: true, form });
  const stored = lib.asV2(await w.core.approvals.get(w.approvalId));
  const surface = {
    name: `gmail_draft_send (a client trusted with forms; the form ${form === 'decline' ? 'declined' : 'cancelled'})`,
    action: 'claim' as const,
  };
  emit('pending-confirm', { ...surface, act: async () => seen }, { ...seen, extra: { stored: stored?.state } }, form);
}

// ── Downloads: a question of where a stranger's files are saved ────────────────────────────────────────────────

interface DownloadWorld {
  harness: Harness;
  core: lib.Core;
  clock: MatrixClock;
  approvalId: string;
  route: 'chat' | 'confirm';
  downloads: string;
  cwd: string;
  asked(): number;
  notFound(action: string): Promise<ReadonlyArray<readonly [string, string]>>;
}

const INVOICE: FakeMessage = {
  id: 'm1',
  threadId: 'm1',
  labelIds: ['INBOX'],
  internalDate: String(Date.parse('2026-09-15T09:00:00Z')),
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Sam Lee <sam@partner.test>' },
      { name: 'Subject', value: 'Invoice for August' },
    ],
    parts: [
      { partId: '0', mimeType: 'text/plain', body: { size: 2, data: Buffer.from('hi').toString('base64url') } },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
        body: { size: 13, attachmentId: 'a1' },
      },
    ],
  },
};

/** A question asked by `gmail_attachment_download` itself, under the mailbox's change policy: the row's route. */
async function downloadWorld(row: string): Promise<DownloadWorld> {
  const route = routeOf(row);
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test', messages: { m1: INVOICE }, attachments: { a1: 'invoice bytes' } },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  if (route === 'confirm') {
    // A tightening: nobody's approval needed.
    await harness.core.config.update((config) => ({
      ...config,
      inboxes: Object.fromEntries(
        Object.entries(config.inboxes).map(([alias, inbox]) => [alias, { ...inbox, changePolicy: 'confirm' as const }]),
      ),
    }));
  }
  // A home of its own, apart from this package's configuration folder, which nothing is ever saved into.
  const home = tempDir('agent-gmail-matrix-home-');
  harness.env.HOME = home;
  harness.env.USERPROFILE = home;
  const clock = matrixClock();
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now: clock.now,
    handoffs: harness.core.handoffs,
    loadConfig: () => harness.core.config.load(),
    audit: harness.core.audit,
  });
  const cwd = tempDir('agent-gmail-matrix-cwd-');
  const w = { harness, cwd } as DownloadWorld;
  const asked = await downloadCall(w, {});
  const approvalId = String(asked.structuredContent?.choiceId);
  if (!approvalId.startsWith('ap_')) throw new Error(`no question was asked: ${JSON.stringify(asked)}`);
  const change = async () => {
    const binding: ChangeBinding = {
      summary: 'Let the default send policy be chat',
      target: null,
      loosened: [{ path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' }],
      settings: [],
      effects: [],
    };
    return (await harness.core.approvals.createChange({ channel: 'gmail', change: binding, policy: 'chat' }))
      .approvalId;
  };
  return Object.assign(w, {
    core: harness.core,
    clock,
    approvalId,
    route,
    downloads: join(home, 'Downloads'),
    asked: () => gmailAsked(harness),
    notFound: async (action: string) =>
      action === 'look'
        ? ([['nobody', NOBODY]] as const)
        : ([
            ['nobody', NOBODY],
            ['another kind', await change()],
          ] as const),
  });
}

async function downloadCall(w: Pick<DownloadWorld, 'harness' | 'cwd'>, args: Record<string, unknown>) {
  const built = await createGmailMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    platform: 'darwin',
    cwd: w.cwd,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({
      name: 'gmail_attachment_download',
      arguments: { inbox: 'work', messageIds: ['m1'], ...args },
    })) as ToolResult;
  } finally {
    await client.close();
    await built.close();
  }
}

/** Files saved in either folder the question offered: what a download does. */
function savedIn(w: DownloadWorld): number {
  return [w.downloads, w.cwd].reduce((count, folder) => {
    try {
      return count + readdirSync(folder).length;
    } catch {
      return count;
    }
  }, 0);
}

/**
 * The claim: the download made again with the question's id — and, under `chat`, the person's answer relayed in the
 * arguments; under `confirm` the answer is the one recorded at the terminal, and an answer passed is refused.
 */
async function download(w: DownloadWorld, approvalId: string): Promise<Observation> {
  const before = savedIn(w);
  const result = await downloadCall(w, {
    choiceId: approvalId,
    ...(w.route === 'chat' ? { saveTo: 'downloads' } : {}),
  });
  const seen = observeTool(result, savedIn(w) - before);
  if (!seen.ok) return seen;
  const record = lib.asV2(await w.core.approvals.get(approvalId));
  return { ...seen, approval: record ? { ...(await w.core.approvals.approvalOf(record)) } : null };
}

async function downloadLook(w: DownloadWorld, approvalId: string): Promise<Observation> {
  const built = await createGmailMcpServer({ core: w.harness.core, env: w.harness.env, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([built.server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({
      name: 'gmail_send_wait',
      arguments: { approvalId, waitSeconds: 0 },
    })) as ToolResult;
    return observeTool(result, 0, { look: true });
  } finally {
    await client.close();
    await built.close();
  }
}

await drive('download', {
  world: downloadWorld,
  surfaces: [
    { name: 'gmail_send_wait (a download’s question)', action: 'look', act: (w, id) => downloadLook(w, id) },
    { name: 'gmail_attachment_download', action: 'claim', act: (w, id) => download(w, id) },
  ],
  emit: emitter('download', 'gmail'),
  lib,
});

// Every fake Google this run started is still listening; the observations are written, so the run is over.
process.exit(0);
