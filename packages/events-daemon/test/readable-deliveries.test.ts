import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { run } from '../src/cli/program.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { MCP_SERVER_MARKER } from '../src/targets/queue.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * 0.32.0, owner feedback §3.5: deliveries a person can read. `deliveries list` rows gain the target's kind, the last
 * answer, the decision and event they came from, and when they were delivered where a table keeps that, all additive
 * and content-free.
 */

const ACCOUNT = 'ibx_READABLEDELIVER1';

type Store = Awaited<ReturnType<typeof openEventDatabase>>;

function seedEvent(store: Store, suffix: string): void {
  store.database
    .prepare(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, 1000, 1100, 1100)`,
    )
    .run(`event-${suffix}`, store.installationId, ACCOUNT, `["7","g-${suffix}","received"]`);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES (?, ?, ?, 'rule-readable', 1, 'matched', 999999, 'retained')`,
    )
    .run(`decision-${suffix}`, `event-${suffix}`, ACCOUNT);
}

function seedDryRun(store: Store): void {
  seedEvent(store, 'dry');
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, attempts, next_at, expires_at, state, switch_generation)
       VALUES ('delivery-dry', 'decision-dry', ?, 'rule-readable', 1, 'dryrun:dry-readable:1', 'dry-readable', 1,
               'dry-run', NULL, 1, NULL, 90000, 'delivered', 3)`,
    )
    .run(ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO dryrun_log
         (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
          delivered_at, expires_at)
       VALUES ('delivery-dry', 'rule-readable', 1, 'dry-readable', 1, 'event-dry', ?, X'01', 2000, 3000)`,
    )
    .run(ACCOUNT);
}

function seedWebhook(store: Store): void {
  seedEvent(store, 'hook');
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, attempts, next_at, expires_at, state, switch_generation, last_error_code, last_status)
       VALUES ('delivery-hook', 'decision-hook', ?, 'rule-readable', 1, 'webhook:hook-readable:1', 'hook-readable', 1,
               'webhook', X'02', 2, 5000, 90000, 'retryable', 3, 'WEBHOOK_STATUS', 503)`,
    )
    .run(ACCOUNT);
}

async function withControl(work: (store: Store, control: B3OperatorControl) => Promise<void>): Promise<void> {
  const stateDir = await shortTempDir('aev-readable-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      await work(store, new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } }));
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('0.32 B2: deliveries list rows carry the target kind, the last answer, the decision and event, and the delivered time', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withControl(async (store, control) => {
    seedDryRun(store);
    seedWebhook(store);
    const rows = (await control.handle({ operation: 'deliveriesList', args: {} })) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      {
        deliveryId: 'delivery-dry',
        accountId: ACCOUNT,
        ruleId: 'rule-readable',
        ruleVersion: 1,
        targetId: 'dry-readable',
        targetVersion: 1,
        subscriberId: null,
        subscriberVersion: null,
        attempts: 1,
        nextAt: null,
        expiresAt: 90000,
        state: 'delivered',
        switchGeneration: 3,
        deadLetterExpiresAt: null,
        targetKind: 'dry-run',
        lastErrorCode: null,
        lastStatus: null,
        decisionId: 'decision-dry',
        eventId: 'event-dry',
        deliveredAt: 2000,
      },
      {
        deliveryId: 'delivery-hook',
        accountId: ACCOUNT,
        ruleId: 'rule-readable',
        ruleVersion: 1,
        targetId: 'hook-readable',
        targetVersion: 1,
        subscriberId: null,
        subscriberVersion: null,
        attempts: 2,
        nextAt: 5000,
        expiresAt: 90000,
        state: 'retryable',
        switchGeneration: 3,
        deadLetterExpiresAt: null,
        targetKind: 'webhook',
        lastErrorCode: 'WEBHOOK_STATUS',
        lastStatus: 503,
        decisionId: 'decision-hook',
        eventId: 'event-hook',
        deliveredAt: null,
      },
    ]);
    // A dry-run entry past its 24 hours is gone: the delivery stays, and no longer says when it was delivered.
    store.database.exec("DELETE FROM dryrun_log WHERE delivery_id = 'delivery-dry'");
    const after = (await control.handle({ operation: 'deliveriesList', args: {} })) as Array<Record<string, unknown>>;
    assert.equal(after[0]?.deliveredAt, null);
  });
});

/** The CLI as the app runs it: no terminal, stdin closed, `--json`. */
async function cli(argv: readonly string[], env: NodeJS.ProcessEnv, tty = false) {
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
  const code = await run(argv, {
    env,
    streams: {
      stdin: Object.assign(new PassThrough(), { isTTY: tty }),
      stdout: Object.assign(stdout, { isTTY: tty }),
      stderr: Object.assign(stderr, { isTTY: tty }),
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, out, err };
}

// With no owner running, a read the gate lets through gets as far as asking it, and exits 66 "not running".
test('0.32 B3: delivery show refuses inside the event service’s MCP server, and is the person’s with --json outside it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-delivery-gate-');
  try {
    const argv = ['--state-dir', stateDir, 'delivery', 'show', 'delivery-1', '--json'];
    const refused = await cli(argv, { [MCP_SERVER_MARKER]: 'events' });
    assert.equal(refused.code, 10, refused.err);
    assert.match(refused.err, /the event service's MCP server cannot read them/u);
    assert.equal(refused.out, '', 'nothing is printed');
    // The app's call: no terminal, --json, no agent marker.
    const app = await cli(argv, {});
    assert.equal(app.code, 66, app.err);
    assert.match(app.err, /not running/u);
    // A shell an agent runs is the person's own: this gate does not pretend otherwise (Q1's trade).
    assert.equal((await cli(argv, { CLAUDECODE: '1' })).code, 66);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

// 0.32.0 (§3.5, events design D7: "at the terminal or in the app"): the dry-run log moves from the human-terminal gate
// to the queue's Q1 gate. Inside an MCP server's process it is refused; outside it, the app reads it with --json.
test('0.32 B4: dryrun list and show refuse inside the event service’s MCP server, and are the person’s with --json', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-dryrun-gate-');
  try {
    const base = ['--state-dir', stateDir];
    for (const argv of [
      [...base, 'dryrun', 'list', '--json'],
      [...base, 'dryrun', 'show', 'delivery-1', '--json'],
      [...base, 'dryrun', 'list'],
      [...base, 'dryrun', 'show', 'delivery-1'],
    ]) {
      const refused = await cli(argv, { [MCP_SERVER_MARKER]: 'events' });
      assert.equal(refused.code, 10, `${argv.join(' ')}: ${refused.err}`);
      assert.match(refused.err, /the event service's MCP server cannot read it/u);
      assert.equal(refused.out, '', 'nothing is printed');
      // Even at a terminal: the marker is the MCP server's own process, whatever its streams are.
      assert.equal((await cli(argv, { [MCP_SERVER_MARKER]: 'events' }, true)).code, 10);
    }
    for (const argv of [
      [...base, 'dryrun', 'list', '--json'],
      [...base, 'dryrun', 'show', 'delivery-1', '--json'],
    ]) {
      // The app's call: no terminal, --json. It gets as far as asking the owner, which is not running here.
      const app = await cli(argv, {});
      assert.equal(app.code, 66, `${argv.join(' ')}: ${app.err}`);
      assert.match(app.err, /not running/u);
      // The trade Q1 accepted for the queue: a shell an agent runs is the person's own, and is not refused.
      assert.equal((await cli(argv, { CLAUDECODE: '1' })).code, 66, argv.join(' '));
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
