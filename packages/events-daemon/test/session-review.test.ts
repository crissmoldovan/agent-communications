import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { targetQueues } from '@agentcomms/events';
import { EventControlClient } from '../src/control/client.ts';
import type { ContextGenerator } from '../src/runtime/session-context.ts';
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
 * part runs once (3); a FIFO named by a file part never stalls the event service (4).
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
