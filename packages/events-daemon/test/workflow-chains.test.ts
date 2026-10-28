import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Notifier } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { chainRequestsInTransaction } from '../src/runtime/events/chains.ts';
import { createWorkflowEventSink } from '../src/runtime/events/sink.ts';
import type { RunView, StepTransition } from '../src/runtime/workflow/contracts.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { type LaneHarness, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';
import { seedRun, testId } from './support/workflow-event-rows.ts';

assertLoopbackSeal();

/*
 * D6 (workflows plan, Track D): chains (workflows design W34, §9.3). A chained workflow admits each message as any
 * workflow does and waits, without holding the source back, until a run about that message raises an event its
 * `on.raised` names; then it gates and maps the message through its own approval, and its run has the raising run as
 * its parent, a depth one more, and the raised event's closed data under `/trigger`. A real owner on a fake mailbox, a
 * recording notifier, and a clock the test moves; the depth bound is read at the sink, with a real store.
 */

const HOUR = 3_600_000;

const limits = {
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
};

function clock(): { readonly now: () => number; advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance(ms) {
      offset += ms;
    },
  };
}

function recordingNotifier(): { readonly bodies: string[]; readonly notifier: Notifier } {
  const bodies: string[] = [];
  return {
    bodies,
    notifier: async (notice) => {
      bodies.push(notice.body);
      return { raised: true };
    },
  };
}

/** A workflow on the fake mailbox with this id, mapping and flow, and no targets: its steps notify and raise. */
function workflow(
  ruleId: string,
  flow: Record<string, unknown>,
  mapping: Record<string, unknown> = { subject: { $path: '/subject' }, from: { $path: '/from' } },
): Record<string, unknown> {
  return { ...rule(1, []), ruleId, mapping, flow: { flowVersion: 1, limits, ...flow } };
}

/** An ordinary workflow that raises `<namespace>.<workflow>.issue.created`, with the subject a sender wrote in it. */
function raising(ruleId: string, name: string): Record<string, unknown> {
  return workflow(ruleId, {
    events: { namespace: 'acme', workflow: name },
    start: 'issue',
    steps: { issue: { kind: 'raise', name: 'created', fields: ['/subject'], next: {} } },
  });
}

/**
 * The chained workflow B: it starts on `on`, maps only `topic`, and says which way its own check went — that it read
 * the message itself, saw none of A's fields and nothing A's mapping named, and that its trigger is the raised event.
 */
function chained(
  ruleId: string,
  name: string,
  on: readonly string[],
  then?: Record<string, unknown>,
): Record<string, unknown> {
  return workflow(
    ruleId,
    {
      events: { namespace: 'acme', workflow: name },
      on: { raised: on, withinMs: HOUR },
      start: 'check',
      steps: {
        check: {
          kind: 'condition',
          when: {
            all: [
              { path: '/fields/topic', op: 'exists' },
              { not: { path: '/fields/subject', op: 'exists' } },
              { not: { path: '/trigger/fields', op: 'exists' } },
              { path: '/trigger/outputs/name', op: 'equals', value: 'created', caseSensitive: true },
            ],
          },
          next: { yes: 'tell', no: 'leak' },
        },
        tell: {
          kind: 'notify',
          text: 'started from {{trigger.outputs.name}} of {{trigger.workflow.name}}',
          next: then === undefined ? {} : { sent: 'again' },
        },
        leak: { kind: 'notify', text: 'read what it should not', next: {} },
        ...(then === undefined ? {} : { again: then }),
      },
    },
    { topic: { $path: '/subject' } },
  );
}

/** Creates each workflow, approves each version as the person does, then switches collection on. */
async function enable(harness: LaneHarness, documents: readonly Record<string, unknown>[]): Promise<void> {
  for (const document of documents) {
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

interface RunSeen {
  readonly id: string;
  readonly rule_id: string;
  readonly event_id: string;
  readonly parent_run_id: string | null;
  readonly depth: number;
  readonly state: string;
}

function runs(harness: LaneHarness): readonly RunSeen[] {
  return readDatabase(harness.stateDir, (database) =>
    (
      database
        .prepare(
          'SELECT id, rule_id, event_id, parent_run_id, depth, state FROM workflow_runs ORDER BY depth, started_at, id',
        )
        .all() as unknown as RunSeen[]
    ).map((row) => ({ ...row })),
  );
}

function decisions(harness: LaneHarness): ReadonlyArray<{ event_id: string; rule_id: string; outcome: string }> {
  return readDatabase(harness.stateDir, (database) =>
    (
      database
        .prepare('SELECT event_id, rule_id, outcome, encrypted_record IS NULL AS empty FROM decisions ORDER BY rowid')
        .all() as Array<{ event_id: string; rule_id: string; outcome: string; empty: number }>
    ).map((row) => ({ event_id: row.event_id, rule_id: row.rule_id, outcome: row.outcome })),
  );
}

function count(harness: LaneHarness, sql: string, ...args: (string | number)[]): number {
  return (readDatabase(harness.stateDir, (database) => database.prepare(sql).get(...args)) as { count: number }).count;
}

async function ticks(harness: LaneHarness, times: number): Promise<void> {
  for (let tick = 0; tick < times; tick += 1) await harness.tick();
}

test('B on acme.client-asks.issue.created starts once for the message, with /trigger', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { bodies, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(harness, [
        raising('client-asks', 'client-asks'),
        chained('issue-followup', 'issue-followup', ['acme.client-asks.issue.created']),
      ]);
      harness.mailbox.send('Please change the banner');
      await harness.tick();
      // The message is admitted by both: A decides it, and B waits for a run about it to raise what starts it.
      assert.deepEqual(
        decisions(harness)
          .map((decision) => `${decision.rule_id}:${decision.outcome}`)
          .sort(),
        ['client-asks:matched', 'issue-followup:awaiting-chain'],
      );
      await ticks(harness, 4);
      const [parent, child, ...more] = runs(harness);
      assert.equal(more.length, 0, JSON.stringify(runs(harness)));
      assert.deepEqual(
        { rule: parent?.rule_id, depth: parent?.depth, parent: parent?.parent_run_id, state: parent?.state },
        { rule: 'client-asks', depth: 0, parent: null, state: 'done' },
      );
      assert.deepEqual(
        { rule: child?.rule_id, depth: child?.depth, parent: child?.parent_run_id, state: child?.state },
        { rule: 'issue-followup', depth: 1, parent: parent?.id, state: 'done' },
      );
      assert.equal(child?.event_id, parent?.event_id, 'a chain is about the same message');
      assert.deepEqual(
        decisions(harness)
          .filter((decision) => decision.rule_id === 'issue-followup')
          .map((decision) => decision.outcome),
        ['matched'],
      );
      assert.ok(
        bodies.includes('Workflow issue-followup: started from created of client-asks'),
        `the run read the raised event under /trigger: ${JSON.stringify(bodies)}`,
      );
      // The request is answered, and the raised event — no subscriber's — keeps no sealed record once its chain read it.
      assert.equal(count(harness, 'SELECT COUNT(*) AS count FROM workflow_chain_requests'), 0);
      assert.equal(
        count(
          harness,
          `SELECT COUNT(*) AS count FROM workflow_events
            WHERE type = 'acme.client-asks.issue.created' AND state = 'done' AND encrypted_record IS NULL`,
        ),
        1,
      );
      await ticks(harness, 2);
      assert.equal(runs(harness).length, 2, 'once for the message');
    },
    { workflows: { notifier } },
  );
});

test('B reads the message through its own mapping, not A’s fields', { skip: WINDOWS_SKIP }, async () => {
  const { bodies, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(harness, [
        raising('client-asks', 'client-asks'),
        chained('issue-followup', 'issue-followup', ['acme.client-asks.issue.created']),
      ]);
      harness.mailbox.send('SENTINEL-SENDER a sender wrote this');
      await ticks(harness, 5);
      // B's check passed: its own `topic` is there, A's `subject` is not, and the trigger carries no declared fields,
      // though A's event sealed the subject a sender wrote among them.
      const followups = bodies.filter((body) => body.startsWith('Workflow issue-followup:'));
      assert.deepEqual(followups, ['Workflow issue-followup: started from created of client-asks']);
      assert.equal(
        bodies.some((body) => body.includes('SENTINEL-SENDER')),
        false,
      );
    },
    { workflows: { notifier } },
  );
});

test('A → B → A does not loop: A has already decided for the message', { skip: WINDOWS_SKIP }, async () => {
  const { bodies, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      // The intake starts it; A starts on the intake's event and on B's; B starts on A's and raises again.
      await enable(harness, [
        raising('intake', 'intake'),
        chained('client-asks', 'client-asks', ['acme.intake.issue.created', 'acme.issue-followup.again.created'], {
          kind: 'raise',
          name: 'created',
          next: {},
        }),
        chained('issue-followup', 'issue-followup', ['acme.client-asks.again.created'], {
          kind: 'raise',
          name: 'created',
          next: {},
        }),
      ]);
      harness.mailbox.send('Please change the banner');
      await ticks(harness, 8);
      const seen = runs(harness).map((run) => `${run.rule_id}@${run.depth}`);
      assert.deepEqual(seen, ['intake@0', 'client-asks@1', 'issue-followup@2']);
      const [intake, asks, followup] = runs(harness);
      assert.equal(asks?.parent_run_id, intake?.id);
      assert.equal(followup?.parent_run_id, asks?.id);
      // B raised what A starts on, and A had decided for the message: it is never asked again.
      assert.equal(
        count(
          harness,
          "SELECT COUNT(*) AS count FROM workflow_events WHERE type = 'acme.issue-followup.again.created'",
        ),
        1,
      );
      assert.equal(count(harness, 'SELECT COUNT(*) AS count FROM workflow_chain_requests'), 0);
      assert.equal(count(harness, "SELECT COUNT(*) AS count FROM decisions WHERE rule_id = 'client-asks'"), 1);
      assert.equal(bodies.filter((body) => body.includes('read what it should not')).length, 0);
    },
    { workflows: { notifier } },
  );
});

test('an event raised at depth 3 starts nothing', { skip: WINDOWS_SKIP }, async () => {
  const root = await shortTempDir('aev-d6-depth-');
  const home = await standInHome(root);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    await standInSecrets(store.database);
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: home.configDir,
    });
    const cipher = new EventRecordCipher(store.database, secrets, new WriterQuiescer());
    const at = Date.UTC(2026, 9, 27, 12, 0, 0);
    // The chained workflow D, active, starting on the owner example's Raise step.
    const document = JSON.stringify({
      ruleId: 'deep-followup',
      version: 1,
      flow: { on: { raised: ['acme.client-asks.found.project-found'], withinMs: HOUR } },
    });
    store.database
      .prepare(
        `INSERT INTO rule_versions
           (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('deep-followup@1', 'deep-followup', 1, ?, 'digest', 'active', 'approval', 'activation', ?)`,
      )
      .run(document, at);
    const workflowRule = structuredClone(OWNER_EXAMPLE) as unknown as StepTransition['rule'];
    const sink = createWorkflowEventSink({
      cipher,
      installationId: 'inst-1',
      onRaisedInTransaction: (database, event, now) => chainRequestsInTransaction(database, event, event.run, now),
    });
    const raiseAt = async (depth: number) => {
      const parentRunId = seedRun(store.database, {
        ruleId: 'intake',
        ruleVersion: 1,
        accountId: 'acme/slack',
        now: at,
      });
      const runId = seedRun(store.database, {
        ruleId: 'client-asks',
        ruleVersion: 5,
        accountId: 'acme/slack',
        now: at,
      });
      store.database
        .prepare('UPDATE workflow_runs SET depth = ?, parent_run_id = ? WHERE id = ?')
        .run(depth, parentRunId, runId);
      const run: RunView = {
        id: runId,
        ruleId: 'client-asks',
        ruleVersion: 5,
        accountId: 'acme/slack',
        eventId: `event-${runId}`,
        depth,
        parentRunId,
        startedAt: at,
        expiresAt: at + limits.runMs,
        shadow: false,
      };
      const eventId = testId('wfe_');
      const prepared = await sink.prepare([
        {
          run,
          rule: workflowRule,
          stepId: 'found',
          transition: 'succeeded',
          outcome: 'raised',
          output: { event: eventId, name: 'project-found' },
          attempt: 1,
          index: 1,
          path: ['route', 'found'],
          durationMs: 3,
          error: null,
          nextAt: null,
          wait: null,
          at,
        },
      ]);
      store.immediate(() => sink.commitInTransaction(store.database, prepared));
      const event = store.database
        .prepare('SELECT state, encrypted_record IS NOT NULL AS sealed FROM workflow_events WHERE id = ?')
        .get(eventId) as { state: string; sealed: number };
      const requests = store.database
        .prepare(
          'SELECT rule_id, depth, parent_run_id, workflow_event_id FROM workflow_chain_requests WHERE event_id = ?',
        )
        .all(`event-${runId}`)
        .map((row) => ({ ...row }));
      return { runId, eventId, event: { ...event }, requests };
    };
    const second = await raiseAt(2);
    assert.deepEqual(second.requests, [
      { rule_id: 'deep-followup', depth: 3, parent_run_id: second.runId, workflow_event_id: second.eventId },
    ]);
    // No subscriber receives it, and a chain may still start from it: it keeps its sealed record, open.
    assert.deepEqual(second.event, { state: 'open', sealed: 1 });
    const third = await raiseAt(3);
    assert.deepEqual(third.requests, []);
    assert.deepEqual(third.event, { state: 'done', sealed: 0 });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('no chain within withinMs: not-chained, the projection purged', { skip: WINDOWS_SKIP }, async () => {
  const time = clock();
  const { notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(harness, [chained('issue-followup', 'issue-followup', ['acme.client-asks.issue.created'])]);
      harness.mailbox.send('Please change the banner');
      await harness.tick();
      assert.deepEqual(
        decisions(harness).map((decision) => decision.outcome),
        ['awaiting-chain'],
      );
      // It keeps what it needs of the message while it waits, and no longer than withinMs.
      const deadline = readDatabase(harness.stateDir, (database) =>
        database.prepare("SELECT decision_deadline FROM ingest_rules WHERE rule_id = 'issue-followup'").get(),
      ) as { decision_deadline: number };
      assert.ok(deadline.decision_deadline <= time.now() + HOUR);
      time.advance(HOUR - 60_000);
      await harness.tick();
      assert.equal(count(harness, 'SELECT COUNT(*) AS count FROM ingest_rules'), 1);
      time.advance(2 * 60_000);
      await harness.tick();
      assert.deepEqual(
        readDatabase(harness.stateDir, (database) =>
          database
            .prepare('SELECT outcome, encrypted_record IS NULL AS empty FROM decisions')
            .all()
            .map((row) => ({ ...row })),
        ),
        [{ outcome: 'not-chained', empty: 1 }],
      );
      assert.equal(count(harness, 'SELECT COUNT(*) AS count FROM ingest_rules'), 0);
      assert.deepEqual(runs(harness), []);
    },
    { now: time.now, workflows: { notifier } },
  );
});

test('a waiting chained workflow holds back no later message of the account', { skip: WINDOWS_SKIP }, async () => {
  const { notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(harness, [
        chained('issue-followup', 'issue-followup', ['acme.client-asks.issue.created']),
        workflow('later-notes', {
          start: 'tell',
          steps: { tell: { kind: 'notify', text: 'a mail came', next: {} } },
        }),
      ]);
      harness.mailbox.send('the first message');
      await harness.tick();
      harness.mailbox.send('the second message');
      await harness.tick();
      // The second message is read and decided while the chained workflow still waits on the first.
      const outcomes = decisions(harness);
      const messages = [...new Set(outcomes.map((decision) => decision.event_id))];
      assert.equal(messages.length, 2, JSON.stringify(outcomes));
      for (const message of messages)
        assert.deepEqual(
          outcomes
            .filter((decision) => decision.event_id === message)
            .map((decision) => `${decision.rule_id}:${decision.outcome}`)
            .sort(),
          ['issue-followup:awaiting-chain', 'later-notes:matched'],
        );
      assert.equal(count(harness, "SELECT COUNT(*) AS count FROM workflow_runs WHERE rule_id = 'later-notes'"), 2);
    },
    { workflows: { notifier } },
  );
});

test('a pattern with * in the namespace or workflow is refused at activation', { skip: WINDOWS_SKIP }, async () => {
  await withLaneOwner(async (harness) => {
    for (const pattern of ['acme.*.issue.created', '*.client-asks.issue.created'])
      await assert.rejects(
        harness.control.request('rule-create', {
          document: chained('issue-followup', 'issue-followup', [pattern]),
        }),
        (error: unknown) => {
          const details = (error as { details?: { reason?: unknown; problems?: { code: string }[] } }).details;
          assert.equal(details?.reason, 'FLOW_INVALID', String(error));
          assert.ok(details?.problems?.some((problem) => problem.code === 'FLOW_ON_PATTERN'));
          return true;
        },
      );
    // Its own events, and a wait longer than it keeps a message, are refused too.
    await assert.rejects(
      harness.control.request('rule-create', {
        document: chained('issue-followup', 'issue-followup', ['acme.issue-followup.tell.sent']),
      }),
      (error: unknown) => {
        assert.match(String(error), /its own events/u);
        return true;
      },
    );
    const long = chained('issue-followup', 'issue-followup', ['acme.client-asks.issue.created']);
    (long.flow as { on: { withinMs: number } }).on.withinMs = 8 * 24 * HOUR;
    await assert.rejects(harness.control.request('rule-create', { document: long }), (error: unknown) => {
      const details = (error as { details?: { problems?: { code: string; pointer?: string }[] } }).details;
      assert.ok(
        details?.problems?.some((problem) => problem.pointer === '/on/withinMs'),
        String(error),
      );
      return true;
    });
    // A literal namespace and workflow is a chained workflow the person can approve.
    await harness.control.request('rule-create', {
      document: chained('issue-followup', 'issue-followup', ['acme.client-asks.*.created']),
    });
    const planned = (await harness.control.request('rule-enable', { ruleId: 'issue-followup', version: 1 })) as {
      approvalId?: string;
    };
    assert.equal(typeof planned.approvalId, 'string');
  });
});
