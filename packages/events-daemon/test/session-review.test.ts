import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { targetQueues } from '@agentcomms/events';
import { EventControlClient } from '../src/control/client.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type { ContextGenerator } from '../src/runtime/session-context.ts';
import { SESSION_RETRY_LIMIT } from '../src/runtime/session-dispatcher.ts';
import { busyBackoffMs } from '../src/runtime/session-queue.ts';
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
 * delivery starts at most one session (1); a dead letter keeps no record, and a waiting match's kept file part goes only
 * while its folder is still allowed (2); a busy session never fails a match, and other failures still count (3); a
 * record that does not open ends its delivery (4).
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

test('REVIEW2-3: a session someone keeps busy never fails the match: its busy tries are given back, further apart', {
  skip: WINDOWS_SKIP,
}, async () => {
  // An eighth of the time waited, at most five minutes.
  assert.deepEqual(
    [0, 8_000, 60_000, 40 * 60_000, 7 * 24 * 60 * 60_000].map(busyBackoffMs),
    [0, 1_000, 7_500, 300_000, 300_000],
  );
  let generated = 0;
  await withReview(
    async ({ harness, relay, folder }) => {
      relay.addSession({ cwd: folder });
      // Every run start loses the race to the person's own, until they stop.
      relay.refuseRunsAsBusy = 1_000;
      await approveRule(harness, [queued(folder)]);
      harness.mailbox.send('the person keeps the session busy');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      // As if it had already failed in other ways SESSION_RETRY_LIMIT - 1 times: one more failure would end it.
      writeDatabase(
        harness,
        `UPDATE deliveries SET attempts = ${SESSION_RETRY_LIMIT - 1} WHERE target_kind = 'session'`,
      );
      const before = runPosts(relay);
      await until(harness, () => runPosts(relay) >= before + 3, 'three more busy tries', 15_000);
      const [waiting] = sessionDeliveries(harness);
      assert.equal(waiting?.state, 'retryable', 'still waiting, never dead-lettered for being busy');
      assert.equal(waiting?.last_error_code, 'SESSION_BUSY');
      assert.equal(waiting?.attempts, SESSION_RETRY_LIMIT - 1, 'no busy try counted');
      relay.refuseRunsAsBusy = 0;
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'delivered', 'the delivery', 15_000);
      assert.equal(generated, 1, 'its model part ran once for all those tries');
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

test('REVIEW2-3: other failures still count: the try after SESSION_RETRY_LIMIT - 1 of them fails the match', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(
    async ({ harness, relay, folder }) => {
      relay.addSession({ cwd: folder });
      relay.refuseNextRunAsBusy = true;
      await approveRule(harness, [queued(folder, false)]);
      harness.mailbox.send('busy, then a relay failure');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      writeDatabase(
        harness,
        `UPDATE deliveries SET attempts = ${SESSION_RETRY_LIMIT - 1} WHERE target_kind = 'session'`,
      );
      relay.failNextRunWith = 500;
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'dead-lettered', 'the dead letter');
      assert.equal(sessionDeliveries(harness)[0]?.last_error_code, 'RELAY_FAILED');
      assert.equal(sessionDeliveries(harness)[0]?.attempts, SESSION_RETRY_LIMIT);
      assert.equal(relay.runs.length, 0);
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

function sessionRecordKept(harness: LaneHarness): boolean | undefined {
  return readDatabase(harness.stateDir, (database) => {
    const row = database
      .prepare("SELECT encrypted_record IS NOT NULL AS kept FROM deliveries WHERE target_kind = 'session'")
      .get() as { kept: number } | undefined;
    return row === undefined ? undefined : row.kept === 1;
  });
}

test('REVIEW2-2: a dead-lettered session delivery keeps no record — no file text, no model words', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(
    async ({ harness, relay, folder }) => {
      const brief = join(folder, 'brief.md');
      await writeFile(brief, 'the house rules\n');
      relay.fenceNewSessions = 'fenced';
      await approveRule(harness, [{ ...queued(folder), context: [GENERATE, { file: brief }] }]);
      harness.mailbox.send('fenced after the parts were read');
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'dead-lettered', 'the dead letter');
      assert.equal(sessionRecordKept(harness), false, 'the sealed parts went with the dead letter');
    },
    { reconcileMs: 100, generate: async () => ({ ok: true, text: 'summary' }) },
  );
});

test('REVIEW2-2: a waiting match sends a kept file part only while its folder is still allowed', {
  skip: WINDOWS_SKIP,
}, async () => {
  let generated = 0;
  await withReview(
    async ({ harness, relay, root, folder }) => {
      const docs = join(root, 'docs');
      await mkdir(docs);
      const brief = join(docs, 'brief.md');
      await writeFile(brief, 'the house rules, from a folder the person allowed\n');
      const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
      await person.request('integration-set', { integration: 'agent-sessions', allowFolders: [docs] });
      relay.addSession({ cwd: folder });
      // The parts are read, and the run start then loses the race, again and again: the match waits, its parts kept.
      relay.refuseRunsAsBusy = 1_000;
      await approveRule(harness, [{ ...queued(folder), context: [GENERATE, { file: brief }] }]);
      harness.mailbox.send('waits with a file');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      assert.equal(sessionRecordKept(harness), true);
      // While it waits, the person takes the folder off the list.
      await person.request('integration-set', { integration: 'agent-sessions', removeFolders: [docs] });
      relay.refuseRunsAsBusy = 0;
      await until(harness, () => relay.runs.length === 1, 'the run');
      const prompt = relay.runs[0]?.prompt ?? '';
      assert.ok(!prompt.includes('the house rules'), 'the file’s text is not sent');
      assert.match(prompt, /brief\.md: left out, because it is outside the folders it may be read from\./u);
      assert.match(prompt, /summary/u, 'the rest of the kept context goes');
      assert.equal(generated, 1, 'and its model part was not run again');
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

test('REVIEW2-4: a waiting record replaced with bytes that are no record ends as content-unreadable, not claimed again', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withReview(
    async ({ harness, relay, folder }) => {
      relay.addSession({ cwd: folder });
      relay.refuseNextRunAsBusy = true;
      await approveRule(harness, [queued(folder, false)]);
      harness.mailbox.send('waits, then its record is replaced');
      await until(harness, () => sessionDeliveries(harness)[0]?.last_error_code === 'SESSION_BUSY', 'busy');
      const database = new DatabaseSync(eventPaths(harness.stateDir).database);
      try {
        database.exec('PRAGMA busy_timeout = 5000');
        // Not the packed record format at all (its first byte is the format's version).
        const bytes = Buffer.concat([Buffer.from([0xff]), randomBytes(95)]);
        database
          .prepare("UPDATE deliveries SET encrypted_record = ?, next_at = 0 WHERE target_kind = 'session'")
          .run(bytes);
      } finally {
        database.close();
      }
      await until(harness, () => sessionDeliveries(harness)[0]?.state === 'content-unreadable', 'content-unreadable');
      assert.equal(sessionRecordKept(harness), false);
      assert.equal(runPosts(relay), 1, 'only the first, refused, start');
    },
    { reconcileMs: 100 },
  );
});
