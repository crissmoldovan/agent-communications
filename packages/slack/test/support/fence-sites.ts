import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import {
  type ApprovalObject,
  ApprovalStore,
  asV2,
  CommsError,
  LEASE_LOST_BEFORE_SEND,
  SENDING_LEASE_MS,
} from '@agentcomms/core';
import { SlackContext } from '../../src/context.ts';
import { gateDepsFor } from '../../src/operations/gate.ts';
import {
  prepareDelete,
  prepareDraftPost,
  prepareEdit,
  react,
  sendDelete,
  sendEdit,
  sendPost,
} from '../../src/operations/post.ts';
import { prepareReaction } from '../../src/operations/send.ts';
import { type FakeSlack, type FakeUploads, type SlackRequest, startFakeSlack } from './fake-slack.ts';
import { type Harness, newHarness } from './harness.ts';

/**
 * Every provider step a Slack post, file post, reaction, edit or deletion makes, each of which starts only after a
 * fence (CUE-404
 * Task 16; design 2026-10-05 §D1): the claimant asks the approval store whether it still holds the send, and starts
 * no step once another caller has found its lease run out and recorded the outcome as `unknown`.
 *
 * One table, shared by `post-outcome.test.ts`, `send-files.test.ts` and `reaction-outcome.test.ts`, whose fence tests
 * are parameterised over it: drop the fence at any one site and that site's cases fail while the others pass. A
 * companion test (`post-outcome.test.ts`) holds the table to what a successful post, two-file post and reaction
 * actually ask of the loopback Slack, so a step added without a row fails there.
 */

export interface FenceSite {
  /** Its number in the plan's table. */
  readonly site: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** The step, as Slack is asked it. */
  readonly method: string;
  /** Where in `operations/send.ts` its fence is. */
  readonly code: 'postPrepared' | 'postFiles' | 'reactPrepared' | 'editPrepared' | 'deletePrepared';
  /** Whether a request the loopback fake recorded is this step. */
  readonly matches: (request: SlackRequest) => boolean;
}

const api = (method: string) => (request: SlackRequest) => request.host === 'api' && request.method === method;

export const SLACK_FENCE_SITES: readonly FenceSite[] = [
  { site: 1, method: 'chat.postMessage', code: 'postPrepared', matches: api('chat.postMessage') },
  { site: 2, method: 'files.getUploadURLExternal', code: 'postFiles', matches: api('files.getUploadURLExternal') },
  {
    site: 3,
    method: 'slackFileUpload',
    code: 'postFiles',
    matches: (request) => request.host === 'files' && request.path.startsWith('/upload/'),
  },
  {
    site: 4,
    method: 'files.completeUploadExternal',
    code: 'postFiles',
    matches: api('files.completeUploadExternal'),
  },
  {
    site: 5,
    method: 'reactions.add and reactions.remove',
    code: 'reactPrepared',
    matches: (request) => api('reactions.add')(request) || api('reactions.remove')(request),
  },
  // An edit and a deletion (design 2026-10-06): one step each, in `operations/amend.ts`.
  { site: 6, method: 'chat.update', code: 'editPrepared', matches: api('chat.update') },
  { site: 7, method: 'chat.delete', code: 'deletePrepared', matches: api('chat.delete') },
];

/**
 * What a post reads of Slack and never changes: the room, before the claim, and where shared files landed, after the
 * post — and, for an edit or a deletion, the message itself, before the claim. Nothing else is a read: every other
 * request a flow makes is a step, and must be a site above.
 */
export const SLACK_READS: readonly string[] = [
  'conversations.info',
  'files.info',
  'conversations.history',
  'conversations.replies',
];

/** Which site a request is, `read` for one of {@link SLACK_READS}, or `unlisted` — a step no fence row names. */
export function siteOf(request: SlackRequest): FenceSite['site'] | 'read' | 'unlisted' {
  if (request.host === 'api' && SLACK_READS.includes(request.method)) return 'read';
  return SLACK_FENCE_SITES.find((site) => site.matches(request))?.site ?? 'unlisted';
}

/** The steps — every request that is not a read — in the order the fake received them. */
export function stepsOf(requests: readonly SlackRequest[]): SlackRequest[] {
  return requests.filter((request) => siteOf(request) !== 'read');
}

/** A post of words, a post of two files, a reaction added and one removed, an edit and a deletion. */
export type Flow = 'message' | 'files' | 'reaction' | 'removal' | 'edit' | 'delete';

/** What each flow asks of Slack once claimed, site by site; two files, so the second upload is fenced too. */
export const FLOWS: Readonly<Record<Flow, readonly FenceSite['site'][]>> = {
  message: [1],
  files: [2, 3, 2, 3, 4],
  reaction: [5],
  removal: [5],
  edit: [6],
  delete: [7],
};

/** How each flow is named in a case's label. */
const FLOW_NAMES: Readonly<Record<Flow, string>> = {
  message: 'a message',
  files: 'a two-file post',
  reaction: 'a reaction',
  removal: 'a removal',
  edit: 'an edit',
  delete: 'a deletion',
};

export interface FenceCase {
  readonly flow: Flow;
  /** Which step of the flow, from 0: the claimant is suspended just before it, or just after its fence. */
  readonly step: number;
  readonly site: FenceSite;
  readonly label: string;
}

const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth'];

/** Every step of every flow, as a case: each site at least once, and an upload with an earlier upload behind it. */
export const FENCE_CASES: readonly FenceCase[] = (Object.keys(FLOWS) as Flow[]).flatMap((flow) =>
  FLOWS[flow].map((number, step) => {
    const site = SLACK_FENCE_SITES.find((one) => one.site === number) as FenceSite;
    return {
      flow,
      step,
      site,
      label: `site ${number}, ${site.method} — the ${ORDINAL[step]} step of ${FLOW_NAMES[flow]}`,
    };
  }),
);

/** The two files a file post sends, in order: which of them are up once `steps` steps have reached Slack. */
export const TWO_FILES = ['a.txt', 'b.txt'] as const;

export function uploadedAfter(uploads: FakeUploads, steps: number): { id: string; name: string }[] {
  // Uploads are the second and fourth steps of the flow (indices 1 and 3).
  return TWO_FILES.flatMap((name, index) =>
    steps > index * 2 + 1 ? [{ id: uploads.issued[index]?.fileId ?? '', name }] : [],
  );
}

export interface FenceWorld {
  readonly harness: Harness;
  readonly fake: FakeSlack;
  readonly uploads: FakeUploads;
  readonly context: SlackContext;
  /** Prepares the flow, then sends it; the result or the error, and its approval. */
  run(flow: Flow): Promise<{ approvalId: string; result?: unknown; error?: unknown }>;
  /** The record's state and reason now. */
  record(approvalId: string): Promise<{ state: string | undefined; reason: string | undefined }>;
}

/**
 * A workspace that can post under `chat`, a loopback Slack that takes posts, files, reactions, edits and deletions —
 * with a message of this account's to edit and delete — and two files.
 */
export async function fenceWorld(t: TestContext): Promise<FenceWorld> {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send' });
  const fake = await startFakeSlack({
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'chat.postMessage': () => ({ ok: true, ts: '1700000000.000100' }),
    'reactions.add': () => ({ ok: true }),
    'reactions.remove': () => ({ ok: true }),
    'conversations.history': () => ({
      ok: true,
      messages: [{ type: 'message', user: 'U0001', text: 'the reprot', ts: '1700000000.000100' }],
    }),
    'chat.update': () => ({ ok: true, channel: 'C1', ts: '1700000000.000100' }),
    'chat.delete': () => ({ ok: true, channel: 'C1', ts: '1700000000.000100' }),
  });
  t.after(() => fake.close());
  const uploads = fake.acceptUploads({ ts: '1700000000.000200' });
  const docs = join(harness.home, 'docs');
  await mkdir(docs);
  const files = TWO_FILES.map((name) => {
    const path = join(docs, name);
    writeFileSync(path, `the contents of ${name}`);
    return path;
  });
  const context = new SlackContext({ core: harness.core, env: harness.env, surface: 'mcp' });
  const slack = { fetch: fake.fetch };
  const settle = async (approvalId: string, work: Promise<unknown>) =>
    work.then(
      (result) => ({ approvalId, result }),
      (error: unknown) => ({ approvalId, error }),
    );
  return {
    harness,
    fake,
    uploads,
    context,
    async run(flow) {
      if (flow === 'reaction' || flow === 'removal') {
        const wanted = { channel: 'C1', ts: '1700000000.000100', name: 'tada', remove: flow === 'removal' };
        const { approvalId } = await prepareReaction(await gateDepsFor(context, 'acme', slack), wanted);
        return settle(approvalId, react(context, 'acme', wanted, approvalId, slack));
      }
      const message = { channel: 'C1', ts: '1700000000.000100' };
      if (flow === 'edit') {
        const edit = await prepareEdit(context, 'acme', { ...message, text: 'the report' }, slack);
        const input = { draftId: edit.draftId, approvalId: edit.approvalId, expectChannel: 'C1', ts: message.ts };
        return settle(edit.approvalId, sendEdit(context, 'acme', input, slack));
      }
      if (flow === 'delete') {
        const deletion = await prepareDelete(context, 'acme', message, slack);
        const input = { ...message, approvalId: deletion.approvalId };
        return settle(deletion.approvalId, sendDelete(context, 'acme', input, slack));
      }
      const draft = await prepareDraftPost(
        context,
        'acme',
        { channel: 'C1', text: 'the report', ...(flow === 'files' ? { files } : {}) },
        slack,
      );
      const input = { draftId: draft.draftId, approvalId: draft.approvalId, expectChannel: 'C1' };
      return settle(draft.approvalId, sendPost(context, 'acme', input, slack));
    },
    async record(approvalId) {
      const record = asV2(await harness.core.approvals.get(approvalId));
      return { state: record?.state, reason: record?.reason };
    },
  };
}

/**
 * Another caller, two minutes on: it finds the claimant's lease run out and persists `unknown` under the record's
 * lock — what any status, list or wait does at that boundary. The claimant itself is untouched; only its next fence
 * can tell.
 */
export async function persistUnknown(harness: Harness, approvalId: string): Promise<void> {
  const later = new ApprovalStore(harness.core.paths.stateDir, {
    now: () => new Date(Date.now() + SENDING_LEASE_MS + 1000),
    loadConfig: () => harness.core.config.load(),
  });
  const seen = await later.inspect(approvalId);
  assert.equal(seen.outcome.state, 'unknown', 'the other caller did not find the lease run out');
}

/** Each fence the claimant asked, with how many steps had reached Slack when it did, and what it was told. */
export interface FenceLog {
  readonly fences: { stepsSeen: number; verdict: 'go' | 'stop' }[];
  /** Whether the suspension happened: a case whose step never had a fence never fires. */
  fired: boolean;
}

/**
 * Suspends the claimant at the fence asked when exactly `step` steps have reached Slack — the fence before that step —
 * while another caller persists `unknown`: `before` the fence looks (the lease ran out between the last step and this
 * one), or `after` it said go (the stated limit: that one step still starts).
 *
 * Keyed on what the fake has received, not on a count of fences, so a fence removed from one site leaves every other
 * site's suspension where it was: the case for the site without one never fires, and its step reaches Slack.
 */
export function suspendAt(world: FenceWorld, step: number, when: 'before' | 'after'): FenceLog {
  const store = world.harness.core.approvals;
  const fence = store.fence.bind(store);
  const log: FenceLog = { fences: [], fired: false };
  store.fence = async (approvalId, claimToken) => {
    const stepsSeen = stepsOf(world.fake.requests).length;
    const here = !log.fired && stepsSeen === step;
    if (here && when === 'before') {
      log.fired = true;
      await persistUnknown(world.harness, approvalId);
    }
    const verdict = await fence(approvalId, claimToken);
    if (here && when === 'after' && verdict === 'go') {
      log.fired = true;
      await persistUnknown(world.harness, approvalId);
    }
    log.fences.push({ stepsSeen, verdict });
    return verdict;
  };
  return log;
}

/** Records every fence the claimant asks, and how many steps had reached Slack when it did. */
export function watchFences(world: FenceWorld): FenceLog {
  return suspendAt(world, -1, 'before');
}

/** What a file post says when its lease ran out after earlier steps: nothing was shared, so nothing was posted. */
export const LEASE_RAN_OUT = 'nothing was posted: the sending lease ran out before the files were shared';

/** What it says of the files, exactly: those that went up, which Slack discards, and what to do next. */
export function leaseRanOutHint(uploaded: readonly { name: string }[]): string {
  const names = uploaded.map((file) => file.name).join(', ');
  const discarded =
    uploaded.length === 0
      ? []
      : [
          uploaded.length === 1
            ? `${names} was uploaded and never shared; Slack discards it.`
            : `${names} were uploaded and never shared; Slack discards them.`,
        ];
  return [
    ...discarded,
    'No step started once its lease had run out, and nothing was shared. Prepare the draft again and show the new preview to the user.',
  ].join(' ');
}

type Outcome = Awaited<ReturnType<FenceWorld['run']>>;

/** The audit record the claimant wrote last for this approval. */
async function lastAudit(world: FenceWorld, approvalId: string) {
  const records = (await world.harness.core.audit.tail({ limit: 50 })).filter(
    (record) => record.approvalId === approvalId,
  );
  return records.at(-1);
}

/**
 * The fence-site case: a claimant whose lease ran out just before `c`'s step started neither it nor any later step,
 * and said so — `lease-lost-before-send` before a flow's first step, "nothing was posted" with the exact disclosure of
 * the files already up after earlier ones.
 */
export async function assertStoppedBefore(
  world: FenceWorld,
  c: FenceCase,
  outcome: Outcome,
  log: FenceLog,
): Promise<void> {
  const what = c.label;
  assert.deepEqual(
    stepsOf(world.fake.requests).map(siteOf),
    FLOWS[c.flow].slice(0, c.step),
    `${what}: a step reached Slack after the lease ran out`,
  );
  assert.ok(log.fired, `${what}: no fence was asked before the step`);
  assert.equal(
    world.fake.requests.some((request) => request.method === 'files.info'),
    false,
    `${what}: Slack was asked where the files landed`,
  );
  const { error } = outcome;
  assert.ok(error instanceof CommsError, `${what}: ${error === undefined ? 'it was posted' : String(error)}`);
  assert.equal(error.code, 'APPROVAL_VOID', what);
  const record = await world.record(outcome.approvalId);
  assert.equal(record.state, 'failed', what);
  assert.equal((error.details?.approval as ApprovalObject | undefined)?.state, 'failed', what);
  const audit = await lastAudit(world, outcome.approvalId);
  assert.equal(audit?.outcome, 'failed', what);
  if (c.step === 0) {
    assert.equal(error.message, 'nothing was sent: the sending lease ran out before anything was sent', what);
    assert.equal(record.reason, LEASE_LOST_BEFORE_SEND, what);
    assert.equal(audit?.reason, LEASE_LOST_BEFORE_SEND, what);
    return;
  }
  const uploaded = uploadedAfter(world.uploads, c.step);
  assert.equal(error.message, LEASE_RAN_OUT, what);
  assert.equal(error.hint, leaseRanOutHint(uploaded), what);
  assert.deepEqual(error.details?.uploaded, uploaded, what);
  assert.equal('possiblyUploaded' in (error.details ?? {}), false, `${what}: a file was said to be possibly up`);
  assert.equal(record.reason, LEASE_RAN_OUT, what);
  assert.deepEqual(
    audit?.ids?.files ?? [],
    uploaded.map((file) => file.id),
    what,
  );
}

/**
 * The stated limit (§5 R12b): a claimant suspended right after a fence said go starts that one step — and no later
 * one. The last step of a flow is then the post, which the claimant records as its own late success.
 */
export async function assertStartedOnlyThatStep(
  world: FenceWorld,
  c: FenceCase,
  outcome: Outcome,
  log: FenceLog,
): Promise<void> {
  const what = c.label;
  assert.ok(log.fired, `${what}: the fence before the step never said go`);
  assert.deepEqual(
    stepsOf(world.fake.requests).map(siteOf),
    FLOWS[c.flow].slice(0, c.step + 1),
    `${what}: not exactly that one step started`,
  );
  const record = await world.record(outcome.approvalId);
  if (c.step === FLOWS[c.flow].length - 1) {
    assert.equal(outcome.error, undefined, `${what}: ${String(outcome.error)}`);
    assert.equal(record.state, 'used', `${what}: the claimant's late success was not recorded`);
    return;
  }
  const { error } = outcome;
  assert.ok(error instanceof CommsError, `${what}: ${error === undefined ? 'it was posted' : String(error)}`);
  const uploaded = uploadedAfter(world.uploads, c.step + 1);
  assert.equal(error.message, LEASE_RAN_OUT, what);
  assert.equal(error.hint, leaseRanOutHint(uploaded), what);
  assert.deepEqual(error.details?.uploaded, uploaded, what);
  assert.equal(record.state, 'failed', what);
}
