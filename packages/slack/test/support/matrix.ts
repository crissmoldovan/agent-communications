import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from '@agentcomms/core';
import { ApprovalStore, type ChangeBinding } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
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
import { SlackContext } from '../../src/context.ts';
import { createSlackMcpServer } from '../../src/mcp/server.ts';
import { beginApproval, finishApproval } from '../../src/operations/approve.ts';
import type { FileDownloader } from '../../src/operations/files.ts';
import { gateDepsFor } from '../../src/operations/gate.ts';
import { prepareDelete, prepareDraftPost, prepareEdit } from '../../src/operations/post.ts';
import { prepareReaction } from '../../src/operations/send.ts';
import { DROP, type FakeSlack, startFakeSlack } from './fake-slack.ts';
import { type Harness, newHarness, tempDir } from './harness.ts';

/*
 * Slack's posts, posts with files, reactions, edits and deletions in the D2 matrix (CUE-404 Task 24; edits and
 * deletions, design 2026-10-06): `test/approval-matrix.test.mjs`
 * runs this as its own program and holds what each must say. Each row starts from a post, a post with a file or a
 * reaction this package prepared itself, on a fresh home and a loopback Slack, with the approval store on a clock of
 * its own; `test/helpers/approval-matrix.mjs` puts it into the row's state.
 *
 * The surfaces: `slack_post_send` (a post, and a post with a file), `slack_react_send`, the terminal approval of a post
 * and of a reaction (`approve`: its begin, then its finish), and `slack_approval_wait`.
 */

type What = 'post' | 'files' | 'reaction' | 'edit' | 'delete';

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface World {
  what: What;
  harness: Harness;
  core: lib.Core;
  context: SlackContext;
  fake: FakeSlack;
  clock: MatrixClock;
  draftId: string;
  approvalId: string;
  notFound(action: string): Promise<ReadonlyArray<readonly [string, string]>>;
  fault(): void;
  sends(): number;
  asked(): number;
}

const TS = '1700000000.000100';
const REACTION = { channel: 'C1', ts: '1.1', emoji: 'tada' };
/** The message an edit and a deletion act on: this account's, in `C1`. */
const MESSAGE = { channel: 'C1', ts: TS };
const emit = emitter('send', 'slack');

/** The provider call that is the outward act of each kind: the post, the files' share, the reaction. */
const ACT: Record<What, string> = {
  post: 'chat.postMessage',
  files: 'files.completeUploadExternal',
  reaction: 'reactions.add',
  edit: 'chat.update',
  delete: 'chat.delete',
};

async function prepare(context: SlackContext, fake: FakeSlack, what: What, alias: string, file: string) {
  if (what === 'reaction') {
    // As `react` prepares one: version 3 first, an earlier release's records retired.
    await lib.ensureSendEpochConfig(context.core, { now: context.now });
    const gate = await gateDepsFor(context, alias, { fetch: fake.fetch });
    const prepared = await prepareReaction(gate, { channel: REACTION.channel, ts: REACTION.ts, name: REACTION.emoji });
    return { draftId: '', approvalId: prepared.approvalId };
  }
  if (what === 'edit') {
    const prepared = await prepareEdit(context, alias, { ...MESSAGE, text: 'shipping at noon' }, { fetch: fake.fetch });
    return { draftId: prepared.draftId, approvalId: prepared.approvalId };
  }
  if (what === 'delete') {
    const prepared = await prepareDelete(context, alias, MESSAGE, { fetch: fake.fetch });
    return { draftId: '', approvalId: prepared.approvalId };
  }
  const prepared = await prepareDraftPost(
    context,
    alias,
    { channel: 'C1', text: 'shipping now', ...(what === 'files' ? { files: [file] } : {}) },
    { fetch: fake.fetch },
  );
  return { draftId: prepared.draftId, approvalId: prepared.approvalId };
}

function worldOf(what: What) {
  return async (row: string): Promise<World> => {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: routeOf(row) });
    await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', mode: 'send', sendPolicy: 'chat' });
    const fake = await startFakeSlack({
      'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
      'chat.postMessage': () => ({ ok: true, ts: TS }),
      'reactions.add': () => ({ ok: true }),
      // This account's message, which an edit and a deletion act on: each workspace's account is `U0001`.
      'conversations.history': () => ({
        ok: true,
        messages: [{ type: 'message', user: 'U0001', text: 'shipping now', ts: TS }],
      }),
      'chat.update': () => ({ ok: true, channel: 'C1', ts: TS }),
      'chat.delete': () => ({ ok: true, channel: 'C1', ts: TS }),
    });
    fake.acceptUploads({ ts: TS });
    const docs = join(harness.home, 'docs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'report.pdf'), '%PDF-1.7 the report');
    const file = realpathSync.native(join(docs, 'report.pdf'));
    const clock = matrixClock();
    harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
      now: clock.now,
      handoffs: harness.core.handoffs,
      loadConfig: () => harness.core.config.load(),
      audit: harness.core.audit,
    });
    const context = new SlackContext({ core: harness.core, env: harness.env, platform: 'darwin', surface: 'mcp' });
    const prepared = await prepare(context, fake, what, 'acme', file);

    const foreign = async () => (await prepare(context, fake, what, 'zeta', file)).approvalId;
    const change = async () => {
      const binding: ChangeBinding = {
        summary: 'Let the default send policy be chat',
        target: null,
        loosened: [{ path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' }],
        settings: [],
        effects: [],
      };
      return (await harness.core.approvals.createChange({ channel: 'slack', change: binding, policy: 'chat' }))
        .approvalId;
    };
    /** Another channel's send, as Gmail's prepare writes one for a mailbox on this machine: not Slack's. */
    const otherChannel = async () => {
      const inboxId = lib.newInboxId();
      await harness.core.config.update((config) => ({
        ...config,
        inboxes: {
          ...config.inboxes,
          work: {
            id: inboxId,
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc',
            client: 'desktop',
            tier: 'send',
            grantedScopes: [],
            contacts: false,
            secretRef: `gmail:refresh:${inboxId}`,
            internalDomains: ['example.test'],
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        },
      }));
      return (
        await harness.core.approvals.create({
          channel: 'gmail',
          inboxId,
          inboxSub: 'sub-9',
          draftId: 'r-other',
          draftMessageId: 'm-other',
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
      what,
      harness,
      core: harness.core,
      context,
      fake,
      clock,
      draftId: prepared.draftId,
      approvalId: prepared.approvalId,
      notFound: async (action) => {
        if (action === 'claim') {
          return [
            ['nobody', NOBODY],
            ['another workspace', await foreign()],
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
      fault: () => {
        const answer = fake.script[ACT[what]];
        fake.script[ACT[what]] = (request) => {
          answer?.(request);
          return DROP;
        };
      },
      sends: () => fake.requests.filter((request) => request.method === ACT[what]).length,
      asked: () => fake.requests.length,
    };
  };
}

async function mcp(w: World, pinned?: string) {
  const { server } = await createSlackMcpServer({
    core: w.harness.core,
    env: w.harness.env,
    fetch: w.fake.fetch,
    platform: 'darwin',
    ...(pinned ? { workspace: pinned } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => void (await Promise.all([client.close(), server.close()])),
  };
}

/**
 * The claim: `slack_post_send` for a post (with its file or not), `slack_react_send` for a reaction, `slack_edit_send`
 * for an edit and `slack_delete_send` for a deletion.
 */
async function claim(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  const client = await mcp(w, pinned);
  try {
    const before = w.sends();
    const where = pinned ? {} : { workspace: 'acme' };
    const result =
      w.what === 'reaction'
        ? await client.call('slack_react_send', { ...where, ...REACTION, approvalId })
        : w.what === 'edit'
          ? await client.call('slack_edit_send', {
              ...where,
              draftId: w.draftId,
              approvalId,
              expectChannel: 'C1',
              ts: MESSAGE.ts,
            })
          : w.what === 'delete'
            ? await client.call('slack_delete_send', { ...where, ...MESSAGE, approvalId })
            : await client.call('slack_post_send', { ...where, draftId: w.draftId, approvalId, expectChannel: 'C1' });
    return observeTool(result, w.sends() - before);
  } finally {
    await client.close();
  }
}

/** The terminal approval: its begin, then its finish with the code it showed — or a wrong one, as the row says. */
async function approve(w: World, approvalId: string, row: string): Promise<Observation> {
  const deps = { fetch: w.fake.fetch };
  const before = w.sends();
  let challenge: string;
  try {
    challenge = (await beginApproval(w.context, approvalId, deps)).challenge;
  } catch (error) {
    return { ...observeError(error, w.sends() - before), extra: { step: 'begin' } };
  }
  const wrong = wrongCodesOf(row);
  if (wrong === 0) {
    try {
      await finishApproval(w.context, approvalId, challenge, deps);
      const record = lib.asV2(await w.core.approvals.get(approvalId));
      return {
        ok: true,
        approval: record ? { ...(await w.core.approvals.approvalOf(record)) } : null,
        sends: w.sends() - before,
      };
    } catch (error) {
      return { ...observeError(error, w.sends() - before), extra: { step: 'finish' } };
    }
  }
  let last: Observation = { ok: true, sends: 0 };
  for (let attempt = 1; attempt <= wrong; attempt += 1) {
    try {
      await finishApproval(w.context, approvalId, WRONG_CODE, deps);
    } catch (error) {
      last = { ...observeError(error, w.sends() - before), extra: { step: 'finish', attempt } };
    }
  }
  const stored = lib.asV2(await w.core.approvals.get(approvalId));
  return { ...last, extra: { ...last.extra, stored: stored?.state } };
}

async function look(w: World, approvalId: string, pinned?: string): Promise<Observation> {
  const client = await mcp(w, pinned);
  try {
    return observeTool(await client.call('slack_approval_wait', { approvalId, waitSeconds: 0 }), 0, { look: true });
  } finally {
    await client.close();
  }
}

const NAMES: Record<What, { claim: string; approve: string; look: string }> = {
  post: { claim: 'slack_post_send', approve: 'approve (terminal, a post)', look: 'slack_approval_wait (a post)' },
  files: {
    claim: 'slack_post_send (a post with a file)',
    approve: 'approve (terminal, a post with a file)',
    look: 'slack_approval_wait (a post with a file)',
  },
  reaction: {
    claim: 'slack_react_send',
    approve: 'approve (terminal, a reaction)',
    look: 'slack_approval_wait (a reaction)',
  },
  edit: { claim: 'slack_edit_send', approve: 'approve (terminal, an edit)', look: 'slack_approval_wait (an edit)' },
  delete: {
    claim: 'slack_delete_send',
    approve: 'approve (terminal, a deletion)',
    look: 'slack_approval_wait (a deletion)',
  },
};

for (const what of ['post', 'files', 'reaction', 'edit', 'delete'] as const) {
  const surfaces: ReadonlyArray<MatrixSurface<World>> = [
    { name: NAMES[what].look, action: 'look', act: (w, id) => look(w, id) },
    { name: NAMES[what].claim, action: 'claim', act: (w, id) => claim(w, id) },
    { name: NAMES[what].approve, action: 'approve', act: (w, id, row) => approve(w, id, row) },
  ];
  await drive('send', { world: worldOf(what), surfaces, emit, lib });

  // A server pinned to the workspace, given another's id.
  const w = await worldOf(what)('not-found');
  const theirs = (await w.notFound('claim'))[1]?.[1] as string;
  const pinnedClaim = await claim(w, theirs, 'acme');
  emit(
    'not-found',
    { name: `${NAMES[what].claim} (pinned)`, action: 'claim', act: async () => pinnedClaim },
    {
      ...pinnedClaim,
      extra: { variant: 'pinned away', id: theirs },
    },
  );
  const pinnedLook = await look(w, theirs, 'acme');
  emit(
    'not-found',
    { name: `${NAMES[what].look} (pinned)`, action: 'look', act: async () => pinnedLook },
    {
      ...pinnedLook,
      extra: { variant: 'pinned away', id: theirs },
    },
  );
}

// A post with a file that Slack refused to share after the upload (D2, `failed`: "nothing was posted", and what was
// uploaded said). Then the same approval, claimed again: the send it was claimed for failed.
{
  const w = await worldOf('files')('provider-refused');
  const share = w.fake.script['files.completeUploadExternal'];
  w.fake.script['files.completeUploadExternal'] = (request) => {
    share?.(request);
    return { ok: false, error: 'posting_to_channel_denied' };
  };
  const refused = await claim(w, w.approvalId);
  const stored = lib.asV2(await w.core.approvals.get(w.approvalId));
  const surface = { name: NAMES.files.claim, action: 'claim' as const, act: async () => refused };
  emit('failed', surface, { ...refused, extra: { stored: stored?.state } }, 'provider-refused');
}

// ── Downloads: a question of where a stranger's files are saved ────────────────────────────────────────────────

interface DownloadWorld {
  harness: Harness;
  core: lib.Core;
  clock: MatrixClock;
  approvalId: string;
  route: 'chat' | 'confirm';
  cwd: string;
  saved(): number;
  asked(): number;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  notFound(action: string): Promise<ReadonlyArray<readonly [string, string]>>;
}

const FILE_TS = '1700000000.000100';
const FILE = {
  id: 'F0AAA1',
  name: 'numbers.pdf',
  title: 'Numbers',
  mimetype: 'application/pdf',
  user: 'U0001',
  url_private_download: 'https://files.slack.com/files-pri/T0001-F0AAA1/download/numbers.pdf',
  shares: { public: { C0AAA1: [{ ts: FILE_TS }] } },
};

/** A question asked by `slack_file_download` itself, under the workspace's change policy: the row's route. */
async function downloadWorld(row: string): Promise<DownloadWorld> {
  const route = routeOf(row);
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'read' });
  if (route === 'confirm') {
    // A tightening: nobody's approval needed.
    await harness.core.config.update((config) => ({
      ...config,
      accounts: Object.fromEntries(
        Object.entries(config.accounts).map(([name, account]) => [
          name,
          { ...account, changePolicy: 'confirm' as const },
        ]),
      ),
    }));
  }
  const clock = matrixClock();
  harness.core.approvals = new ApprovalStore(harness.core.paths.stateDir, {
    now: clock.now,
    handoffs: harness.core.handoffs,
    loadConfig: () => harness.core.config.load(),
    audit: harness.core.audit,
  });
  const fetch = async (input: string | URL | Request) => {
    asks += 1;
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    const answer =
      method === 'files.info'
        ? { ok: true, file: FILE }
        : method === 'users.info'
          ? { ok: true, user: { id: 'U0001', profile: { display_name: 'sam' } } }
          : { ok: false, error: 'unknown_method' };
    return new Response(JSON.stringify(answer));
  };
  let saves = 0;
  let asks = 0;
  const fileDownload: FileDownloader = async () => {
    saves += 1;
    asks += 1;
    return { bytes: Buffer.from('numbers'), contentType: 'application/pdf' };
  };
  const cwd = tempDir('agent-slack-matrix-cwd-');
  const call = async (name: string, args: Record<string, unknown>) => {
    const { server } = await createSlackMcpServer({
      core: harness.core,
      env: harness.env,
      fetch,
      platform: 'darwin',
      cwd,
      fileDownload,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  };
  const asked = await call('slack_file_download', { workspace: 'acme', fileIds: ['F0AAA1'] });
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
    return (await harness.core.approvals.createChange({ channel: 'slack', change: binding, policy: 'chat' }))
      .approvalId;
  };
  return {
    harness,
    core: harness.core,
    clock,
    approvalId,
    route,
    cwd,
    saved: () => saves,
    asked: () => asks,
    call,
    notFound: async (action) =>
      action === 'look'
        ? [['nobody', NOBODY]]
        : [
            ['nobody', NOBODY],
            ['another kind', await change()],
          ],
  };
}

/**
 * The claim: the download made again with the question's id — and, under `chat`, the person's answer relayed in the
 * arguments; under `confirm` the answer is the one recorded at the terminal.
 */
async function download(w: DownloadWorld, approvalId: string): Promise<Observation> {
  const before = w.saved();
  const result = await w.call('slack_file_download', {
    workspace: 'acme',
    fileIds: ['F0AAA1'],
    choiceId: approvalId,
    ...(w.route === 'chat' ? { saveTo: 'downloads' } : {}),
  });
  const seen = observeTool(result, w.saved() - before);
  if (!seen.ok) return seen;
  const record = lib.asV2(await w.core.approvals.get(approvalId));
  return { ...seen, approval: record ? { ...(await w.core.approvals.approvalOf(record)) } : null };
}

await drive('download', {
  world: downloadWorld,
  surfaces: [
    {
      name: 'slack_approval_wait (a download’s question)',
      action: 'look',
      act: async (w, id) =>
        observeTool(await w.call('slack_approval_wait', { approvalId: id, waitSeconds: 0 }), 0, { look: true }),
    },
    { name: 'slack_file_download', action: 'claim', act: (w, id) => download(w, id) },
  ],
  emit: emitter('download', 'slack'),
  lib,
});

// Every fake Slack this run started is still listening; the observations are written, so the run is over.
process.exit(0);
