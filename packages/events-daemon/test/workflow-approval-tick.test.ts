import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig, type Notifier } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { type RuleLineageRow, validateRuleLineage } from '../src/runtime/disclosure-fence.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { type LaneHarness, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * 0.36.0's end to end found that approving workflows while the owner's own timer ticks (every 50 ms there) failed with
 * "the rule does not match its completed activation". A person approving a workflow while the event service runs is
 * the normal case.
 *
 * The cause: each tick resumes claimed activations (`resumeClaimedCompletions`) — work an approval claimed and left
 * unfinished — and it took up the very activation an approval was completing at that moment, outside the approval's
 * own serialisation. Either it completed it a second time beside the approval, and whichever finished second was
 * refused (the approval, when it lost, answered "the activation was cancelled before its pointer effect committed" for
 * a workflow that was in fact on); or it settled it from a row it had read before the approval's completion committed:
 * the workflow's own new pointer looked like drift, and the completed activation was cancelled under its active
 * version, which every later disclosure — the next approval among them — then refused with the message above.
 *
 * First a real owner on its own fast timer (the test ticks nothing), then each interleaving made exact on the
 * activation runtime, with the tick's pass started inside the approval's completion.
 */

// ---------------------------------------------------------------------------------------------------------------
// A real owner, on its own timer.
// ---------------------------------------------------------------------------------------------------------------

/** Enough workflows, on a timer fast enough, that the race was hit on every run before the fix (5 of 5). */
const WORKFLOWS = 24;
const TICK_MS = 10;

const limits = {
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
};

const quiet: Notifier = async () => ({ raised: true });

/** A flow workflow on the fake mailbox: it raises `acme.<ruleId>.note.created`, then ends. */
function workflow(ruleId: string): Record<string, unknown> {
  return {
    ...rule(1, []),
    ruleId,
    mapping: { subject: { $path: '/subject' } },
    flow: {
      flowVersion: 1,
      limits,
      events: { namespace: 'acme', workflow: ruleId },
      start: 'note',
      steps: { note: { kind: 'raise', name: 'created', next: {} } },
    },
  };
}

/** Approves a prepared activation as the person does at a terminal, and returns what the approval answered. */
async function approve(harness: LaneHarness, approvalId: string): Promise<unknown> {
  const challenge = (await harness.control.request('approve-challenge', { approvalId })) as string;
  return harness.control.request('approve', { approvalId, answer: challenge });
}

interface Lineage {
  readonly rule_id: string;
  readonly state: string;
  readonly intent_status: string | null;
  readonly same_approval: number;
}

/** Each workflow's version, and the activation its lineage names: what every disclosure fence checks first. */
function lineages(harness: LaneHarness): Lineage[] {
  return readDatabase(harness.stateDir, (database) =>
    (
      database
        .prepare(
          `SELECT version.rule_id, version.state, intent.status AS intent_status,
                  intent.approval_id IS version.approval_id AS same_approval
             FROM rule_versions AS version
             LEFT JOIN activation_intents AS intent ON intent.id = version.authorization_activation_id
            ORDER BY version.rule_id`,
        )
        .all() as unknown as Lineage[]
    ).map((row) => ({ ...row })),
  );
}

interface IntentSeen {
  readonly kind: string;
  readonly status: string;
  readonly failure_code: string | null;
}

function intents(harness: LaneHarness): IntentSeen[] {
  return readDatabase(harness.stateDir, (database) =>
    (
      database
        .prepare('SELECT kind, status, failure_code FROM activation_intents ORDER BY created_at')
        .all() as unknown as IntentSeen[]
    ).map((row) => ({ ...row })),
  );
}

async function until<T>(read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  // Generous but bounded: the owner's own ticks share a loaded machine with other suites.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("approving workflows while the owner's own timer ticks: each approval completes, once, and stays completed", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      const ruleIds = Array.from({ length: WORKFLOWS }, (_, index) => `asks-${String(index).padStart(2, '0')}`);
      for (const ruleId of ruleIds) {
        await harness.control.request('rule-create', { document: workflow(ruleId) });
        const planned = (await harness.control.request('rule-enable', { ruleId, version: 1 })) as {
          approvalId: string;
        };
        const approved = (await approve(harness, planned.approvalId)) as { status?: unknown };
        assert.equal(approved.status, 'completed', `${ruleId}'s approval`);
      }
      const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
      assert.equal(((await approve(harness, enabled.approvalId)) as { status?: unknown }).status, 'completed');

      // Some ticks later, nothing a tick did undid an approval: each activation is completed, under its version.
      await new Promise((resolve) => setTimeout(resolve, 20 * TICK_MS));
      assert.deepEqual(
        intents(harness).filter((intent) => intent.status !== 'completed'),
        [],
        'no activation is left cancelled or claimed',
      );
      assert.deepEqual(
        lineages(harness),
        ruleIds.map((ruleId) => ({ rule_id: ruleId, state: 'active', intent_status: 'completed', same_approval: 1 })),
      );

      // And each workflow discloses: one message runs every one of them, on the owner's own timer.
      harness.mailbox.send('Please change the banner');
      await until(
        () =>
          readDatabase(harness.stateDir, (database) =>
            (
              database
                .prepare("SELECT rule_id FROM workflow_runs WHERE state = 'done' ORDER BY rule_id")
                .all() as Array<{ rule_id: string }>
            ).map((row) => row.rule_id),
          ),
        (done) => done.length === ruleIds.length,
        'a run of every workflow',
      );
    },
    { tickMs: TICK_MS, workflows: { notifier: quiet } },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// Each interleaving, exactly: the tick's pass (`resumeClaimedCompletions`) started inside an approval's completion.
// ---------------------------------------------------------------------------------------------------------------

const ACCOUNT = 'ibx_TICKRACETICK0001';

function gmailRule(ruleId: string): Record<string, unknown> {
  return {
    ruleId,
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [{ targetId: 'dry', version: 1, kind: 'dry-run', retentionMs: 86_400_000 }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: 604_800_000,
      holdMs: 604_800_000,
      deliveryMs: 604_800_000,
      dryrunMs: 86_400_000,
      sseReplayMs: 604_800_000,
      deadLetterMs: 604_800_000,
      decisionMetadataMs: 7_776_000_000,
    },
  };
}

interface Runtime {
  readonly root: string;
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly approvals: ApprovalStore;
  readonly runtime: ActivationRuntime;
  /** Every Gmail profile call: one per baseline sampled. */
  readonly profileCalls: () => number;
  /** Runs inside each profile call (a baseline), awaited: where a test starts the tick's pass, mid-completion. */
  onProfile: ((call: number) => Promise<void>) | undefined;
  /** Runs inside each rule point's encryption, after the baselines and before the pointer commit, awaited. */
  onPoint: ((call: number) => Promise<void>) | undefined;
  /** Holds core's answer to the next read of this approval until the release it returns: the tick's await, widened. */
  hold(approvalId: string): () => void;
  /** Prepares, creates the challenge for and plans an approval of this rule's version 1. */
  prepare(ruleId: string): Promise<{ readonly prepared: PreparedActivation; readonly answer: string }>;
  status(intentId: string): { status: string; failure_code: string | null };
  lineage(ruleId: string): Promise<unknown>;
}

async function withRuntime(work: (fixture: Runtime) => Promise<void>): Promise<void> {
  const root = await shortTempDir('aev-tick-race-');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
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
    createdAt: '2026-10-27T08:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => configStore.load() });
  const held = new Map<string, Promise<void>>();
  // What the runtime reads core through: the real store, with the next read of an approval the test names held.
  const gated = new Proxy(approvals, {
    get(target, property, receiver) {
      if (property === 'get')
        return async (approvalId: string) => {
          const wait = held.get(approvalId);
          held.delete(approvalId);
          const answer = await target.get(approvalId);
          await wait;
          return answer;
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let profileCalls = 0;
  let pointCalls = 0;
  let ordinal = 0;
  const fixture: Runtime = {
    root,
    store,
    approvals,
    runtime: undefined as unknown as ActivationRuntime,
    profileCalls: () => profileCalls,
    onProfile: undefined,
    onPoint: undefined,
    hold(approvalId) {
      let release: () => void = () => undefined;
      held.set(
        approvalId,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return release;
    },
    async prepare(ruleId) {
      const prepared = (await fixture.runtime.prepareRule({ ruleId, version: 1 })) as PreparedActivation;
      return { prepared, answer: await fixture.runtime.issueChallenge(prepared.approvalId) };
    },
    status(intentId) {
      return {
        ...(store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(intentId) as {
          status: string;
          failure_code: string | null;
        }),
      };
    },
    async lineage(ruleId) {
      const row = store.database
        .prepare(
          'SELECT id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, revoked_at FROM rule_versions WHERE rule_id = ? AND version = 1',
        )
        .get(ruleId) as unknown as RuleLineageRow;
      const lineage = await validateRuleLineage(store.database, approvals, { ...row });
      return lineage.valid ? 'valid' : { code: lineage.code, message: lineage.message };
    },
  };
  (fixture as { runtime: ActivationRuntime }).runtime = new ActivationRuntime({
    store,
    approvals: gated,
    config: configStore,
    // Ordered ids, so the tick's pass lists the activations in the order they were prepared.
    newIntentId: () => {
      ordinal += 1;
      return `act_${String(ordinal).padStart(32, '0')}`;
    },
    gmailSourceFor: async () => ({
      getProfile: async () => {
        profileCalls += 1;
        await fixture.onProfile?.(profileCalls);
        return { emailAddress: 'events@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '202' };
      },
      listHistory: async () => {
        throw new Error('activation baselines must not scan history');
      },
      getMessageMetadata: async () => {
        throw new Error('activation baselines must not read message metadata');
      },
    }),
    encryptBaseline: async (_intentId, _accountId, position) => Buffer.from(JSON.stringify(position)),
    decryptBaseline: async (_intentId, _accountId, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
    encryptPoint: async (input) => {
      pointCalls += 1;
      await fixture.onPoint?.(pointCalls);
      return Buffer.from(JSON.stringify(input.position));
    },
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    mailboxLock: new MailboxLock(),
  });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget({ targetId: 'dry', version: 1, kind: 'dry-run', retentionMs: 86_400_000 });
  try {
    await work(fixture);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test('a tick that lists the activation an approval is completing leaves it to the approval, which completes it once', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRuntime(async (fixture) => {
    new ImmutableVersions(fixture.store.database).createRule(gmailRule('asks'));
    const { prepared, answer } = await fixture.prepare('asks');
    let tick: Promise<void> | undefined;
    // Between the approval's baseline and its pointer commit, the tick's pass starts, and the approval goes on only
    // once that pass has done all it will. Before the fix, the pass completed the activation itself, and the approval
    // was refused — "the activation was cancelled before its pointer effect committed" — though its workflow was on.
    fixture.onPoint = async (call) => {
      if (call !== 1) return;
      tick = fixture.runtime.resumeClaimedCompletions();
      await tick;
    };
    const completed = await fixture.runtime.approve({ approvalId: prepared.approvalId, answer });
    await tick;
    assert.equal(completed.status, 'completed');
    assert.equal(fixture.profileCalls(), 1, 'one baseline, sampled by the approval alone');
    assert.deepEqual(fixture.status(prepared.intentId), { status: 'completed', failure_code: null });
    assert.equal(await fixture.lineage('asks'), 'valid');
  });
});

test("a tick that read the activation before the approval's completion committed never settles it from that read", {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRuntime(async (fixture) => {
    new ImmutableVersions(fixture.store.database).createRule(gmailRule('asks'));
    const { prepared, answer } = await fixture.prepare('asks');
    // The tick's pass lists the activation while the approval completes it, then waits on core while that completion
    // commits. Before the fix it then read the workflow's own new pointer as drift and cancelled the completed
    // activation, under its active version: every disclosure after it refused "the rule does not match its completed
    // activation". (The approval reads core for the last time before its baseline call.)
    let release: () => void = () => undefined;
    let tick: Promise<void> | undefined;
    fixture.onProfile = async (call) => {
      if (call !== 1) return;
      release = fixture.hold(prepared.approvalId);
      tick = fixture.runtime.resumeClaimedCompletions();
    };
    const completed = await fixture.runtime.approve({ approvalId: prepared.approvalId, answer });
    release();
    await tick;
    assert.equal(completed.status, 'completed');
    assert.equal(await fixture.lineage('asks'), 'valid');
    assert.deepEqual(fixture.status(prepared.intentId), { status: 'completed', failure_code: null });
  });
});

test('a tick that reaches a listed activation only after its approval completed it reads it again, and leaves it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRuntime(async (fixture) => {
    const versions = new ImmutableVersions(fixture.store.database);
    versions.createRule(gmailRule('asks-a'));
    versions.createRule(gmailRule('asks-b'));
    // A's approval was claimed and cut short at its baseline call: the tick's pass is what finishes it.
    const a = await fixture.prepare('asks-a');
    fixture.onProfile = async () => {
      throw new Error('the baseline call failed');
    };
    await assert.rejects(
      () => fixture.runtime.approve({ approvalId: a.prepared.approvalId, answer: a.answer }),
      /the baseline call failed/u,
    );
    assert.equal(fixture.status(a.prepared.intentId).status, 'pending-completion');
    // B's approval is completing when the pass lists both; the pass waits on core for A while B's completion commits,
    // and only then reaches B — no longer being approved, but no longer what the pass listed either.
    const b = await fixture.prepare('asks-b');
    const release = fixture.hold(a.prepared.approvalId);
    let tick: Promise<void> | undefined;
    fixture.onProfile = async () => {
      if (tick === undefined) tick = fixture.runtime.resumeClaimedCompletions();
    };
    const completed = await fixture.runtime.approve({ approvalId: b.prepared.approvalId, answer: b.answer });
    release();
    await tick;
    assert.equal(completed.status, 'completed');
    assert.deepEqual(
      fixture.status(a.prepared.intentId),
      { status: 'completed', failure_code: null },
      'A, by the tick',
    );
    assert.deepEqual(fixture.status(b.prepared.intentId), { status: 'completed', failure_code: null }, 'B, by its own');
    assert.equal(await fixture.lineage('asks-a'), 'valid');
    assert.equal(await fixture.lineage('asks-b'), 'valid');
  });
});
