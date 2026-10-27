import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FlowDocumentV1 } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { createWorkflowEventSink } from '../src/runtime/events/sink.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import type { RunView, StepTransition } from '../src/runtime/workflow/contracts.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';
import { seedEvent, seedRun, testId } from './support/workflow-event-rows.ts';

/*
 * Security review of 0.36.0, L4: what is never pruned or purged.
 * - A raised event's charge in `workflow_effects` leaves with its hour window, as the other kinds' charges do, so the
 *   count inside every raise's transaction reads at most an hour of them.
 * - A run's history is kept as long as its decision's metadata (W7), then purged by the sweep that purges that
 *   metadata: the run, its steps and waits, its ended events, their final deliveries and replay frames, and its
 *   worktree rows that nothing is left to clean up. A live run, an event with a delivery still pending (or a dead
 *   letter still kept), a run another run or a chain still names, and a worktree row that may still be on disk are not.
 */

const RULE = 'client-asks';
const ACCOUNT = 'acme/slack';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const AT = Date.UTC(2026, 9, 27, 11, 20, 4, 120);

interface Store {
  readonly store: EventDatabase;
  readonly cipher: EventRecordCipher;
  close(): void;
}

async function openStore(): Promise<Store> {
  const root = await shortTempDir('aev-l4-history-');
  const home = await standInHome(root);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  await standInSecrets(store.database);
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir: home.configDir,
  });
  const cipher = new EventRecordCipher(store.database, secrets, new WriterQuiescer());
  return { store, cipher, close: () => store.close() };
}

test('L4: a raised event charge leaves with its hour window', { skip: WINDOWS_SKIP }, async () => {
  const { store, cipher, close } = await openStore();
  try {
    const runId = seedRun(store.database, { ruleId: RULE, ruleVersion: 5, accountId: ACCOUNT, now: AT });
    const charge = store.database.prepare("INSERT INTO workflow_effects (rule_id, kind, at) VALUES (?, 'event', ?)");
    charge.run(RULE, AT - 30 * DAY);
    charge.run('another-workflow', AT - 2 * HOUR);
    charge.run(RULE, AT - HOUR + 60_000);
    const workflow = structuredClone(OWNER_EXAMPLE) as CanonicalFullRuleDocument & { flow: FlowDocumentV1 };
    const run: RunView = {
      id: runId,
      ruleId: RULE,
      ruleVersion: 5,
      accountId: ACCOUNT,
      eventId: `event-${runId}`,
      depth: 0,
      parentRunId: null,
      startedAt: AT - 6_000,
      expiresAt: AT + DAY,
      shadow: false,
    };
    const settle: StepTransition = {
      run,
      rule: workflow,
      stepId: 'issue',
      transition: 'succeeded',
      outcome: 'done',
      output: { delivery: 'd-1' },
      attempt: 1,
      index: 1,
      path: [],
      durationMs: 10,
      error: null,
      nextAt: null,
      wait: null,
      at: AT,
    };
    const sink = createWorkflowEventSink({ cipher, installationId: 'inst-1' });
    const prepared = await sink.prepare([settle]);
    store.immediate(() => sink.commitInTransaction(store.database, prepared));
    const charges = store.database
      .prepare("SELECT rule_id, at FROM workflow_effects WHERE kind = 'event' ORDER BY at")
      .all() as Array<{ rule_id: string; at: number }>;
    assert.deepEqual(
      charges.map((row) => ({ ...row })),
      [
        { rule_id: RULE, at: AT - HOUR + 60_000 },
        { rule_id: RULE, at: AT },
      ],
      'the charges past their hour are gone; the one inside it and the new one stay',
    );
  } finally {
    close();
  }
});

/** A run as the engine leaves it: its state, its decision's metadata deadline, and its steps. */
function run(
  store: EventDatabase,
  input: {
    readonly state: 'held' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled' | 'expired';
    readonly metadataExpiresAt?: number;
    readonly parentRunId?: string;
  },
): string {
  const runId = seedRun(store.database, { ruleId: RULE, ruleVersion: 1, accountId: ACCOUNT, now: AT });
  store.database
    .prepare('UPDATE decisions SET metadata_expires_at = ? WHERE id = ?')
    .run(input.metadataExpiresAt ?? AT + DAY, `decision-${runId}`);
  store.database
    .prepare('UPDATE workflow_runs SET state = ?, parent_run_id = ?, depth = ?, updated_at = ? WHERE id = ?')
    .run(input.state, input.parentRunId ?? null, input.parentRunId === undefined ? 0 : 1, AT + HOUR, runId);
  const step = store.database.prepare(
    'INSERT INTO workflow_steps (run_id, step_id, state, outcome, attempts, settled_at, output) VALUES (?, ?, ?, ?, 1, ?, ?)',
  );
  step.run(runId, 'route', 'done', 'routed', AT, '{"project":"acme"}');
  step.run(runId, 'wait', input.state === 'waiting' ? 'waiting' : 'skipped', null, AT, null);
  store.database
    .prepare("INSERT INTO workflow_waits (run_id, step_id, kind, key, wake_at) VALUES (?, 'wait', 'time', NULL, ?)")
    .run(runId, AT + DAY);
  return runId;
}

/** One raised event of the run, ended or open, with one delivery in the given state. */
function event(
  store: EventDatabase,
  runId: string,
  input: {
    readonly state: 'open' | 'done' | 'expired' | 'cancelled';
    readonly delivery: 'queued' | 'retryable' | 'disclosing' | 'delivered' | 'dead-lettered' | 'expired' | 'cancelled';
    readonly deadLetterExpiresAt?: number;
  },
): string {
  const sequence =
    (
      store.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM workflow_events WHERE run_id = ?')
        .get(runId) as { next: number }
    ).next ?? 1;
  const eventId = seedEvent(store.database, {
    runId,
    ruleId: RULE,
    ruleVersion: 1,
    accountId: ACCOUNT,
    now: AT,
    sequence,
    deliveries: [{ subscriberId: 'events-dashboard', version: 1, kind: 'sse' }],
  });
  if (input.state !== 'open')
    store.database
      .prepare('UPDATE workflow_events SET state = ?, encrypted_record = NULL WHERE id = ?')
      .run(input.state, eventId);
  store.database
    .prepare('UPDATE event_deliveries SET state = ?, dead_letter_expires_at = ? WHERE event_id = ?')
    .run(input.delivery, input.deadLetterExpiresAt ?? null, eventId);
  store.database
    .prepare(
      `INSERT INTO event_stream_log (id, event_id, subscriber_id, subscriber_version, encrypted_record, delivered_at,
                                     expires_at)
       VALUES (?, ?, 'events-dashboard', 1, X'00', ?, ?)`,
    )
    .run(`frame-${eventId}`, eventId, AT, AT + 6 * DAY);
  return eventId;
}

function worktree(store: EventDatabase, runId: string, stepId: string, state: string): void {
  store.database
    .prepare(
      `INSERT INTO workflow_worktrees (run_id, step_id, project_id, checkout, path, branch, state, created_at)
       VALUES (?, ?, 'acme', '/example/home/acme', ?, ?, ?, ?)`,
    )
    .run(runId, stepId, `/example/home/acme-wt/${runId}-${stepId}`, `agent/${stepId}`, state, AT);
}

function count(store: EventDatabase, sql: string, ...args: string[]): number {
  return (store.database.prepare(sql).get(...args) as { count: number }).count;
}

function kept(store: EventDatabase, runId: string): boolean {
  return count(store, 'SELECT COUNT(*) AS count FROM workflow_runs WHERE id = ?', runId) === 1;
}

test("L4: a run's history goes at its decision's metadata deadline, and nothing still needed goes with it", {
  skip: WINDOWS_SKIP,
}, async () => {
  const { store, close } = await openStore();
  try {
    const SWEEP = AT + 2 * DAY;
    // Purged: ended, its decision's metadata past its deadline, nothing of it still pending.
    const ended = run(store, { state: 'done' });
    const endedEvents = [
      event(store, ended, { state: 'done', delivery: 'delivered' }),
      event(store, ended, { state: 'expired', delivery: 'dead-lettered', deadLetterExpiresAt: SWEEP - 1 }),
    ];
    worktree(store, ended, 'removed', 'removed');
    worktree(store, ended, 'refused', 'refused');
    // A worktree that may still be on disk: its row is kept, though its run goes.
    worktree(store, ended, 'made', 'made');
    worktree(store, ended, 'kept', 'kept');
    worktree(store, ended, 'recording', 'recording');
    const failed = run(store, { state: 'failed' });
    const cancelled = run(store, { state: 'cancelled' });
    event(store, cancelled, { state: 'cancelled', delivery: 'cancelled' });

    // Kept, each for its own reason.
    const live = run(store, { state: 'waiting' });
    const held = run(store, { state: 'held' });
    const notYet = run(store, { state: 'done', metadataExpiresAt: SWEEP + 1 });
    const sending = run(store, { state: 'expired' });
    event(store, sending, { state: 'expired', delivery: 'disclosing' });
    const queued = run(store, { state: 'done' });
    event(store, queued, { state: 'open', delivery: 'queued' });
    const deadLetter = run(store, { state: 'cancelled' });
    event(store, deadLetter, { state: 'expired', delivery: 'dead-lettered', deadLetterExpiresAt: SWEEP + DAY });
    const parent = run(store, { state: 'done' });
    const child = run(store, { state: 'running', parentRunId: parent });
    const chained = run(store, { state: 'done' });
    store.database
      .prepare(
        `INSERT INTO workflow_chain_requests
           (event_id, rule_id, rule_version, workflow_event_id, parent_run_id, depth, requested_at)
         VALUES (?, 'chained-workflow', 1, ?, ?, 1, ?)`,
      )
      .run(`event-${chained}`, testId('wfe_'), chained, AT);
    const delivering = run(store, { state: 'done' });
    store.database
      .prepare(
        `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
            encrypted_record, expires_at, state, switch_generation, run_id, step_id)
         VALUES ('delivery-of-a-step', ?, ?, ?, 1, 'dry-run:target:1', 'target', 1, X'00', ?, 'retryable', 0, ?, 'route')`,
      )
      .run(`decision-${delivering}`, ACCOUNT, RULE, SWEEP + DAY, delivering);

    new EventExpiry(store, () => SWEEP).sweep();

    for (const runId of [ended, failed, cancelled]) {
      assert.equal(kept(store, runId), false, `the ended run ${runId} is purged`);
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id = ?', runId), 0);
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM workflow_waits WHERE run_id = ?', runId), 0);
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM workflow_events WHERE run_id = ?', runId), 0);
    }
    for (const eventId of endedEvents) {
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM event_deliveries WHERE event_id = ?', eventId), 0);
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM event_stream_log WHERE event_id = ?', eventId), 0);
    }
    assert.deepEqual(
      (
        store.database
          .prepare('SELECT step_id FROM workflow_worktrees WHERE run_id = ? ORDER BY step_id')
          .all(ended) as Array<{ step_id: string }>
      ).map((row) => row.step_id),
      ['kept', 'made', 'recording'],
      'a removed or refused worktree has nothing left to clean up; one that may be on disk keeps its row',
    );
    for (const runId of [live, held, notYet, sending, queued, deadLetter, parent, child, chained, delivering]) {
      assert.equal(kept(store, runId), true, `the run ${runId} is kept`);
      assert.equal(count(store, 'SELECT COUNT(*) AS count FROM workflow_steps WHERE run_id = ?', runId), 2);
    }
    for (const runId of [sending, queued, deadLetter])
      assert.equal(
        count(
          store,
          `SELECT COUNT(*) AS count FROM event_deliveries
            WHERE event_id IN (SELECT id FROM workflow_events WHERE run_id = ?)`,
          runId,
        ),
        1,
        'with its event and its delivery',
      );
    const decisions = count(store, "SELECT COUNT(*) AS count FROM decisions WHERE metadata_state = 'purged'");
    assert.ok(decisions >= 3, "the decisions' own metadata is purged by the same sweep");

    // The child ends; once its history is due, it goes, and then its parent.
    store.database.prepare("UPDATE workflow_runs SET state = 'done' WHERE id = ?").run(child);
    store.database
      .prepare("UPDATE workflow_steps SET state = 'skipped' WHERE run_id = ? AND step_id = 'wait'")
      .run(child);
    new EventExpiry(store, () => SWEEP + 1).sweep();
    new EventExpiry(store, () => SWEEP + 2).sweep();
    assert.equal(kept(store, child), false);
    assert.equal(kept(store, parent), false);
  } finally {
    close();
  }
});
