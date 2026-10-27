import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type TakeHolder, TakeStore } from '@agentcomms/core';
import { catalogueEntry, type FlowDocumentV1 } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { canonicalFlowInRule } from '../src/domain/flow.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { minimiseProjection, type ProjectionCipher } from '../src/runtime/projections.ts';
import { RelayClient, readRelayToken } from '../src/runtime/relay-client.ts';
import { stepContextFor } from '../src/runtime/workflow/context.ts';
import { runMessageOf } from '../src/runtime/workflow/run-message.ts';
import { prepareFlowRun } from '../src/runtime/workflow/runs.ts';
import { createFindSessionExecutor, type SessionStepDeps } from '../src/runtime/workflow/steps/find-session.ts';
import type { EventDatabase } from '../src/store/database.ts';
import { FakeRelay } from './support/fake-relay.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome } from './support/stand-ins.ts';
import { OWNER_EXAMPLE, stepContext } from './support/step-context.ts';

/*
 * Find the session that took this conversation (workflows design W36): core's take store in a stand-in home's core
 * state folder, holding the takes a test makes; the loopback fake relay; and the thread workflow of the text's
 * fixtures. No real claude-stream, no real home, no real take.
 */

const THREAD_RULE = JSON.parse(
  readFileSync(new URL('../../events/test/fixtures/flows/thread.json', import.meta.url), 'utf8'),
) as CanonicalFullRuleDocument & { readonly flow: FlowDocumentV1 };
const ACCOUNT = 'acc_AAAAAAAAAAAAAAAA';
const OTHER_ACCOUNT = 'acc_BBBBBBBBBBBBBBBB';
const PARENT = 'C0123/1729936800.000100';
const NATIVE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CLIENT_FOLDER = '/example/home/work/client-secret-project';
const TAKER_KEY = 'aaaaaaaaaaaaaaaa';

function taker(sessionId: string | null): TakeHolder {
  return {
    key: TAKER_KEY,
    grouped: true,
    process: 'a1a1a1a1a1a1',
    sessionId,
    parent: { pid: 4242, startedAt: 'Mon Oct 26 10:00:00 2026', name: 'claude' },
    folder: CLIENT_FOLDER,
    client: { name: 'claude-code', version: '2.1.0' },
  };
}

interface Threaded {
  readonly relay: FakeRelay;
  readonly takes: TakeStore;
  readonly folder: string;
  readonly deps: SessionStepDeps;
}

async function withThread(work: (threaded: Threaded) => Promise<void>): Promise<void> {
  const root = await realpath(await shortTempDir('aev-find-thread-'));
  const { homeDirectory } = await standInHome(root);
  const folder = join(homeDirectory, 'work', 'acme-site');
  await mkdir(folder, { recursive: true });
  // Core's state folder, as the owner opens it on the person's: here the stand-in home's.
  const takes = new TakeStore(join(homeDirectory, '.local', 'state', 'agentcomms'), {
    running: () => true,
    probe: async () => null,
    pinLive: async () => false,
  });
  const relay = await new FakeRelay({ allowedRoots: [join(homeDirectory, 'work')] }).start();
  try {
    const client = new RelayClient({
      url: relay.url,
      token: await readRelayToken(await relay.writeHome(root)),
      attestListener: async () => ({ kind: 'unattested', platform: 'test' }),
    });
    const deps: SessionStepDeps = {
      relay: async () => ({ client }),
      sessionRoots: async () => [join(homeDirectory, 'work')],
      deniedFolders: () => [],
      laneBinding: () => null,
      threadHolder: (input) => takes.threadHolder(input),
    };
    await work({ relay, takes, folder, deps });
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
}

/** The thread step's context for a reply in the parent's thread, in the taken account. */
const replyContext = (
  message: { id: string; thread: string | null } | null = { id: 'C0123/1729937000.000300', thread: PARENT },
) => stepContext({ rule: THREAD_RULE, stepId: 'thread', run: { accountId: ACCOUNT }, message });

test('a Slack reply in a thread a session took finds that session: idle, busy, watched', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withThread(async ({ relay, takes, folder, deps }) => {
    await takes.take({ channel: 'slack', accountId: ACCOUNT, id: PARENT, thread: PARENT }, taker(NATIVE));
    const find = createFindSessionExecutor(deps);
    relay.addSession({ cwd: folder, provider: 'codex', nativeSessionId: NATIVE });
    relay.addSession({ cwd: folder, nativeSessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    const window = relay.addSession({ cwd: folder, nativeSessionId: NATIVE });
    assert.deepEqual(await find.run(replyContext()), {
      kind: 'settled',
      outcome: 'idle',
      output: { session: window.id, provider: 'claude' },
    });
    relay.startRunElsewhere(window.id);
    assert.deepEqual(await find.run(replyContext()), {
      kind: 'settled',
      outcome: 'busy',
      output: { session: window.id, provider: 'claude' },
    });
    relay.endRun(window.id);
    window.attached = 'observer';
    assert.deepEqual(await find.run(replyContext()), {
      kind: 'settled',
      outcome: 'watched',
      output: { session: window.id, provider: 'claude' },
    });
    // The parent's own run, were it the message: its own take is not an earlier one.
    const itself = await find.run(replyContext({ id: PARENT, thread: PARENT }));
    assert.equal(itself.kind === 'settled' && itself.outcome, 'none');
    // Another account's take never answers for this one.
    const elsewhere = await find.run(
      stepContext({
        rule: THREAD_RULE,
        stepId: 'thread',
        run: { accountId: OTHER_ACCOUNT },
        message: { id: 'C0123/1729937000.000300', thread: PARENT },
      }),
    );
    assert.equal(elsewhere.kind === 'settled' && elsewhere.outcome, 'none');
  });
});

test("the taker's session gone from the relay is none; a message with no thread is none", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withThread(async ({ relay, takes, folder, deps }) => {
    await takes.take({ channel: 'slack', accountId: ACCOUNT, id: PARENT, thread: PARENT }, taker(NATIVE));
    relay.addSession({ cwd: folder, nativeSessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' });
    const find = createFindSessionExecutor(deps);
    const none = { kind: 'settled', outcome: 'none', output: { session: null, provider: 'claude' } };
    assert.deepEqual(await find.run(replyContext()), none, 'the relay no longer knows the session');
    const before = relay.requests.length;
    assert.deepEqual(await find.run(replyContext({ id: 'C0123/1729938000.000400', thread: null })), none);
    assert.deepEqual(await find.run(replyContext(null)), none, 'a run whose record keeps no message');
    assert.equal(relay.requests.length, before, 'with nobody to look for, the relay is not asked');
    assert.deepEqual(await createFindSessionExecutor({ ...deps, threadHolder: undefined }).run(replyContext()), none);
    // A holder with no Claude Code session id, and the person, are nobody a workflow can give it to.
    const other = 'C0123/1729935000.000100';
    await takes.take({ channel: 'slack', accountId: ACCOUNT, id: other, thread: other }, taker(null));
    assert.deepEqual(await find.run(replyContext({ id: 'C0123/1729935100.000200', thread: other })), none);
    const kept = 'C0123/1729934000.000100';
    await takes.keep({ channel: 'slack', accountId: ACCOUNT, id: kept, thread: kept }, { folder: null, ancestors: [] });
    assert.deepEqual(await find.run(replyContext({ id: 'C0123/1729934100.000200', thread: kept })), none);
  });
});

test('activation refuses this place with codex (FIND_THREAD_NEEDS_CLAUDE)', () => {
  const { flow, ...whole } = THREAD_RULE;
  assert.doesNotThrow(() => canonicalFlowInRule(whole, flow));
  // The step alone, so nothing else in the workflow is refused first.
  const rule = { ...whole, targets: [] };
  const alone = (provider: 'claude' | 'codex') => ({
    flowVersion: 1,
    start: 'thread',
    limits: flow.limits,
    steps: { thread: { kind: 'find-session', in: { thread: true }, provider, next: {} } },
  });
  assert.doesNotThrow(() => canonicalFlowInRule(rule, alone('claude')));
  assert.throws(
    () => canonicalFlowInRule(rule, alone('codex')),
    (error: unknown) => error instanceof EventDomainError && error.code === 'FIND_THREAD_NEEDS_CLAUDE',
  );
});

test('the output holds session and provider only: no folder, client or key of the take', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withThread(async ({ relay, takes, folder, deps }) => {
    await takes.take({ channel: 'slack', accountId: ACCOUNT, id: PARENT, thread: PARENT }, taker(NATIVE));
    relay.addSession({ cwd: folder, nativeSessionId: NATIVE });
    const result = await createFindSessionExecutor(deps).run(replyContext());
    assert.equal(result.kind, 'settled');
    const output = result.kind === 'settled' ? result.output : {};
    assert.deepEqual(Object.keys(output).sort(), ['provider', 'session']);
    for (const kept of [CLIENT_FOLDER, TAKER_KEY, NATIVE, 'claude-code'])
      assert.equal(JSON.stringify(result).includes(kept), false, kept);
  });
});

test("the run's record keeps the message and its thread for a flow that finds by thread, and only then", async () => {
  const definition = catalogueEntry('slack.message.posted', 1);
  assert.ok(definition.ok);
  const reply = definition.value.examples.find((example) => (example as { threadTs?: unknown }).threadTs !== null) as
    | Record<string, unknown>
    | undefined;
  assert.ok(reply, 'the catalogue has a reply example');
  const channel = (reply.channel as { id: string }).id;
  const projected = minimiseProjection(THREAD_RULE, reply).event;
  assert.equal(projected.threadTs, reply.threadTs, "the projection keeps the thread's id");
  assert.equal(minimiseProjection(OWNER_EXAMPLE, reply).event.threadTs, undefined, 'and only for such a flow');
  const message = runMessageOf(THREAD_RULE, projected);
  assert.deepEqual(message, { id: `${channel}/${reply.ts}`, thread: `${channel}/${reply.threadTs}` });
  assert.equal(runMessageOf(OWNER_EXAMPLE, projected), undefined);
  // Sealed with the run's fields, and read back by the step's context.
  const plain: ProjectionCipher = {
    encrypt: async (_location: unknown, plaintext: Uint8Array) => Buffer.from(plaintext),
    decrypt: async (_location: unknown, ciphertext: Uint8Array) => Buffer.from(ciphertext),
  } as unknown as ProjectionCipher;
  const run = await prepareFlowRun({ cipher: plain, rule: THREAD_RULE, data: { text: 'x' }, createdAt: 1, message });
  assert.ok(run);
  const ctx = stepContextFor({
    store: {} as EventDatabase,
    cipher: plain,
    run: {
      id: run.runId,
      ruleId: THREAD_RULE.ruleId,
      ruleVersion: THREAD_RULE.version,
      accountId: ACCOUNT,
      eventId: 'event-1',
      depth: 0,
      parentRunId: null,
      startedAt: 1,
      expiresAt: 2,
      shadow: false,
    },
    rule: THREAD_RULE,
    stepId: 'thread',
    step: THREAD_RULE.flow.steps.thread as FlowDocumentV1['steps'][string],
    attempt: { id: 'a-1', number: 1 },
    now: () => 1,
    sealedRecord: run.sealedRecord,
    outputs: new Map(),
    fence: async () => {},
  });
  assert.deepEqual(await ctx.message?.(), message);
  assert.deepEqual(await ctx.fields(), { text: 'x' });
});
