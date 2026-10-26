import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { targetQueues } from '@agentcomms/events';
import { EventControlClient } from '../src/control/client.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type { ContextGenerator } from '../src/runtime/session-context.ts';
import { SESSION_RETRY_LIMIT } from '../src/runtime/session-dispatcher.ts';
import { releaseBackoffMs } from '../src/runtime/session-queue.ts';
import { FakeRelay, type FakeRelayOptions } from './support/fake-relay.ts';
import {
  ACCOUNT,
  DAY,
  type LaneHarness,
  OTHER,
  RULE,
  readDatabase,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { resultText } from './support/raw-mcp.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * The 0.33.0 security review's findings on the agent-session target, kept as regressions: a lane session target's
 * counts stay out of an unbound window (5); a 409 that is not "busy" never loops the busy queue, and a match's model
 * part runs once (3); a FIFO named by a file part never stalls the event service (4). The second look's, as REVIEW2-n: a
 * delivery starts at most one session (1).
 */

const PERSON = 'person-setup:terminal';
const RETENTION = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
};

interface Review {
  readonly harness: LaneHarness;
  readonly relay: FakeRelay;
  readonly root: string;
  readonly folder: string;
}

async function withReview(
  work: (review: Review) => Promise<void>,
  options: {
    readonly relay?: FakeRelayOptions;
    readonly reconcileMs?: number;
    readonly generate?: ContextGenerator;
  } = {},
): Promise<void> {
  const root = await realpath(await shortTempDir('aev-review-'));
  const folder = join(root, 'acme');
  await mkdir(folder);
  const relay = await new FakeRelay({ allowedRoots: [folder], ...options.relay }).start();
  const home = await relay.writeHome(root);
  try {
    await withLaneOwner(
      async (harness) => {
        const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
        await person.request('integration-set', {
          integration: 'agent-sessions',
          relayHome: home,
          allowFolders: [folder],
        });
        await work({ harness, relay, root, folder });
      },
      {
        agentSessions: {
          homeDirectory: join(root, 'no-home'),
          reconcileMs: options.reconcileMs ?? 60_000,
          ...(options.generate === undefined ? {} : { generate: options.generate }),
        },
      },
    );
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
}

const ruleWith = (targets: readonly Record<string, unknown>[]): Record<string, unknown> => ({
  ruleId: RULE,
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: {
    from: { $path: '/from' },
    subject: { $path: '/subject' },
    snippet: { $path: '/snippet' },
    messageId: { $path: '/messageId' },
  },
  targets,
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: targets.some(targetQueues) ? { ...RETENTION, queueMs: 7 * DAY } : RETENTION,
});

async function approveRule(harness: LaneHarness, targets: readonly Record<string, unknown>[]): Promise<void> {
  for (const target of targets) await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document: ruleWith(targets) });
  await harness.approve(1);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

interface DeliveryState {
  readonly id: string;
  readonly state: string;
  readonly last_error_code: string | null;
  readonly attempts: number;
}

function sessionDeliveries(harness: LaneHarness): readonly DeliveryState[] {
  return readDatabase(
    harness.stateDir,
    (database) =>
      database
        .prepare(
          "SELECT id, state, last_error_code, attempts FROM deliveries WHERE target_kind = 'session' ORDER BY id",
        )
        .all() as unknown as DeliveryState[],
  );
}

async function until(harness: LaneHarness, check: () => boolean, what: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await harness.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('REVIEW-5: a rule whose session target finds by a lane shows an unbound window no counts', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(async ({ harness }) => {
    await approveRule(harness, [
      {
        targetId: 's-lane',
        version: 1,
        kind: 'session',
        find: { lane: 'david' },
        ifNone: 'queue-only',
        provider: 'claude',
      },
    ]);
    const other = await harness.window(OTHER);
    structured(await tool(other, 'events_lane_whoami'));
    harness.mailbox.send('A match for lane david, no binding');
    await until(harness, () => sessionDeliveries(harness)[0]?.state === 'delivered', 'the lane item');
    const shown = JSON.parse(resultText(await tool(other, 'events_rule_show', { ruleId: RULE }))) as {
      counts7d?: unknown;
    }[];
    assert.ok(shown.length > 0);
    assert.equal(shown[0]?.counts7d, undefined, 'a lane rule’s counts are not an unbound window’s to see');
  });
});

test('REVIEW-4: a FIFO swapped in for a file part never stalls the service, and the part is left out', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(async ({ harness, relay, folder }) => {
    relay.addSession({ cwd: folder });
    const brief = join(folder, 'brief.md');
    await writeFile(brief, 'brief\n');
    await approveRule(harness, [
      {
        targetId: 'acme-session',
        version: 1,
        kind: 'session',
        find: { folder },
        ifNone: 'start',
        provider: 'claude',
        context: [{ file: brief }],
      },
    ]);
    // After the approval, something with write access to the folder swaps in a FIFO that nobody writes to.
    await unlink(brief);
    execFileSync('/usr/bin/mkfifo', [brief]);
    harness.mailbox.send('trigger');
    const ticked = await Promise.race([
      (async () => {
        for (let index = 0; index < 5; index += 1) await harness.tick();
        return 'returned';
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 4_000)),
    ]);
    if (ticked === 'hung') execFileSync('/bin/sh', ['-c', `printf x > '${brief}'`]);
    assert.equal(ticked, 'returned', 'the owner’s ticks go on');
    await until(harness, () => relay.runs.length === 1, 'the run');
    assert.match(relay.runs[0]?.prompt ?? '', /brief\.md: left out, because it is not a file\./u);
  });
});

test('REVIEW-4: a relay that says `/` confines nothing, so only the folders the person added are roots', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(
    async ({ harness, root, folder }) => {
      const elsewhere = join(root, 'elsewhere');
      await mkdir(elsewhere);
      const target = (targetId: string, at: string) => ({
        targetId,
        version: 1,
        kind: 'session',
        find: { folder: at },
        ifNone: 'start',
        provider: 'claude',
      });
      await harness.control.request('target-add', { document: target('outside', elsewhere) });
      await harness.control.request('rule-create', { document: ruleWith([target('outside', elsewhere)]) });
      await assert.rejects(
        harness.control.request('rule-enable', { ruleId: RULE, version: 1 }),
        /is not inside the relay's allowed roots/u,
        'the relay’s `/` is not used: the person added only the acme folder',
      );
      const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
      const shown = (await person.request('integration-show', { integration: 'agent-sessions' })) as {
        relay: { allowedRoots: unknown };
        settings: { allowedFolders: unknown };
      };
      assert.equal(shown.relay.allowedRoots, null, 'a relay root that confines nothing is not shown as one');
      assert.deepEqual(shown.settings.allowedFolders, [folder]);
    },
    { relay: { allowedRoots: ['/'] } },
  );
});

const GENERATE = { generate: { provider: 'openrouter', model: 'a/b', instruction: 'Summarise.', from: ['/subject'] } };

const queued = (folder: string, generate = true): Record<string, unknown> => ({
  targetId: 'acme-session',
  version: 1,
  kind: 'session',
  find: { folder },
  ifNone: 'start',
  ifBusy: 'queue',
  provider: 'claude',
  ...(generate ? { context: [GENERATE] } : {}),
});

const runPosts = (relay: FakeRelay): number =>
  relay.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/runs')).length;

/** Changes the owner's database directly, as time passing would: what no operation does. */
function writeDatabase(harness: LaneHarness, sql: string): void {
  const database = new DatabaseSync(eventPaths(harness.stateDir).database);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec(sql);
  } finally {
    database.close();
  }
}

const released = (harness: LaneHarness): boolean =>
  readDatabase(
    harness.stateDir,
    (database) =>
      (database.prepare('SELECT COUNT(*) AS n FROM session_queue WHERE released_at IS NOT NULL').get() as { n: number })
        .n > 0,
  );

async function settle(harness: LaneHarness, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await harness.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('REVIEW-3: a busy session that becomes one the relay only watches is left, and the model part runs once', {
  skip: WINDOWS_SKIP,
}, async () => {
  let generated = 0;
  await withReview(
    async ({ harness, relay, folder }) => {
      const session = relay.addSession({ cwd: folder });
      relay.startRunElsewhere(session.id);
      await approveRule(harness, [queued(folder)]);
      harness.mailbox.send('busy at first');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      // The session is now one the relay only watches — it answers a prompt with a 409 that is not "busy" — and its
      // run ends. It is not waited on again: a new session is started for the match.
      session.attached = 'observer';
      relay.endRun(session.id);
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'delivered', 'the delivery');
      await settle(harness, 1_000);
      assert.equal(generated, 1, 'the model part ran once');
      assert.equal(runPosts(relay), 1, 'one run was asked for');
      const ours = relay.runs.filter((run) => (run.sender as { id?: unknown } | undefined)?.id === 'agent-comms');
      assert.equal(ours.length, 1);
      assert.notEqual(ours[0]?.sessionId, session.id, 'never the watched session');
      assert.ok((sessionDeliveries(harness)[0]?.attempts ?? 0) <= 3);
    },
    {
      reconcileMs: 100,
      generate: async () => {
        generated += 1;
        return { ok: true, text: 'summary' };
      },
    },
  );
});

test('REVIEW-3: a run start refused as busy sends the same prompt next time, without running the model part again', {
  skip: WINDOWS_SKIP,
}, async () => {
  let generated = 0;
  await withReview(
    async ({ harness, relay, folder }) => {
      relay.addSession({ cwd: folder });
      // Another client's run wins the race between the snapshot and the start.
      relay.refuseNextRunAsBusy = true;
      await approveRule(harness, [queued(folder)]);
      harness.mailbox.send('raced');
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'delivered', 'the delivery');
      assert.equal(generated, 1, 'the prompt was written once and kept');
      assert.equal(runPosts(relay), 2, 'refused once, then made');
      assert.equal(relay.runs.length, 1);
      assert.match(relay.runs[0]?.prompt ?? '', /summary number 1/u);
    },
    {
      reconcileMs: 100,
      generate: async () => {
        generated += 1;
        return { ok: true, text: `summary number ${generated}` };
      },
    },
  );
});

test('REVIEW-3: a relay that repeats run ends cannot drive the busy queue faster than the reconcile interval', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(async ({ harness, relay, folder }) => {
    const session = relay.addSession({ cwd: folder });
    relay.startRunElsewhere(session.id);
    await approveRule(harness, [queued(folder, false)]);
    harness.mailbox.send('busy');
    await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
    await until(harness, () => relay.streamCount > 0, 'the follower');
    // The session's run never ends, but the relay says one did, over and over.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      relay.publishRunEnd(session.id);
      await harness.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const [row] = sessionDeliveries(harness);
    assert.equal(row?.state, 'retryable');
    assert.ok((row?.attempts ?? 0) <= 2, `tried ${row?.attempts} times, not once per record`);
    assert.equal(runPosts(relay), 0, 'a busy session is never sent a run');
  });
});

test('REVIEW-3: a session never free fails its delivery after SESSION_RETRY_LIMIT tries, each further apart', {
  skip: WINDOWS_SKIP,
}, async () => {
  assert.deepEqual([1, 2, 3, 4, 12, 30].map(releaseBackoffMs), [0, 1_000, 2_000, 4_000, 300_000, 300_000]);
  await withReview(
    async ({ harness, relay, folder }) => {
      const session = relay.addSession({ cwd: folder });
      relay.startRunElsewhere(session.id);
      await approveRule(harness, [queued(folder, false)]);
      harness.mailbox.send('never free');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      // Its tries so far, as if it had been let go and found busy again many times.
      writeDatabase(
        harness,
        `UPDATE deliveries SET attempts = ${SESSION_RETRY_LIMIT - 1} WHERE target_kind = 'session'`,
      );
      await until(harness, () => relay.streamCount > 0, 'the follower');
      relay.publishRunEnd(session.id);
      // Let go after a backoff that grows with its tries; the backoff passes.
      await until(harness, () => released(harness), 'the release');
      writeDatabase(harness, "UPDATE deliveries SET next_at = 0 WHERE target_kind = 'session'");
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'dead-lettered', 'the dead letter');
      assert.equal(sessionDeliveries(harness)[0]?.last_error_code, 'SESSION_BUSY');
      assert.equal(sessionDeliveries(harness)[0]?.attempts, SESSION_RETRY_LIMIT);
      assert.equal(runPosts(relay), 0);
    },
    { reconcileMs: 100 },
  );
});

const sessionPosts = (relay: FakeRelay): number =>
  relay.requests.filter((request) => request.method === 'POST' && request.path === '/v1/sessions').length;

test('REVIEW2-1: a delivery starts at most one session; when the relay fences or moves it, the delivery fails saying so', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [state, code] of [
    ['fenced', 'SESSION_FENCED'],
    ['moved', 'SESSION_MOVED'],
  ] as const)
    await withReview(
      async ({ harness, relay, folder }) => {
        // No session works in the folder, and the relay fences (or moves) every session it starts.
        relay.fenceNewSessions = state;
        await approveRule(harness, [{ ...queued(folder, false), ifBusy: 'queue' }]);
        harness.mailbox.send(`every new session ${state}`);
        await until(
          harness,
          () => sessionDeliveries(harness)[0]?.state === 'dead-lettered',
          `the ${state} dead letter`,
        );
        assert.equal(sessionDeliveries(harness)[0]?.last_error_code, code);
        assert.equal(sessionPosts(relay), 1, 'one session started, never a second');
        assert.equal(relay.runs.length, 0);
      },
      { reconcileMs: 100 },
    );
});
