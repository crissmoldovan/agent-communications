import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { DesktopOrigin } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import type { RunShowResultV1, RunsListResultV1 } from '../src/runtime/workflow/run-show.ts';
import { FakeRelay } from './support/fake-relay.ts';
import { DAY, type LaneHarness, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The lead's decision on B6's open question: a turn a workflow waits for that is waiting on the person in claude-stream
 * — an open request of that turn, in the session's snapshot (api-contract `pendingRequests`, read 2026-10-27) — makes
 * the wait step's stored output say so, `needsYouInClaudeStream: true`, so `runs list`, `runs show` and the app's run
 * view say "Needs you in claude-stream"; when the person answers, it says so no more; and when the turn ends, the step's
 * output is its closed one again. A real owner, the fake mailbox and the loopback fake relay; nothing real is reached.
 */

const PERSON = 'person-setup:terminal';
const HOUR = 3_600_000;

const LIMITS = {
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
};

const RETENTION = {
  ingestMs: 7 * DAY,
  holdMs: 7 * DAY,
  deliveryMs: 7 * DAY,
  dryrunMs: DAY,
  sseReplayMs: 7 * DAY,
  deadLetterMs: 7 * DAY,
  decisionMetadataMs: 90 * DAY,
  queueMs: 7 * DAY,
};

const chosenSession = {
  targetId: 'chosen-session',
  version: 1,
  kind: 'session',
  find: { flow: true },
  ifNone: 'queue-only',
  provider: 'claude',
  context: [{ fields: ['/subject'] }],
};

/** find (in the folder) → give (to the session find chose) → turn (its end). */
function workflow(folder: string): Record<string, unknown> {
  return {
    ...rule(1, [chosenSession]),
    retention: RETENTION,
    flow: {
      flowVersion: 1,
      limits: LIMITS,
      start: 'find',
      steps: {
        find: { kind: 'find-session', in: { folder }, provider: 'claude', next: { idle: 'give' } },
        give: {
          kind: 'deliver',
          target: { targetId: 'chosen-session', version: 1 },
          to: { session: ['find'] },
          next: { done: 'turn' },
        },
        turn: { kind: 'wait', for: { turnEnd: 'give' }, timeoutMs: 2 * HOUR, next: {} },
      },
    },
  };
}

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  for (const target of document.targets as Record<string, unknown>[])
    await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document });
  await harness.approve(document.version as number);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

async function json<T>(stateDir: string, args: readonly string[]): Promise<T> {
  const stdin = new PassThrough();
  stdin.end('');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run(['--state-dir', stateDir, '--json', ...args], { streams, env: {}, desktopOrigin: ATTESTED });
  assert.equal(code, 0, err);
  return JSON.parse(out) as T;
}

/** The wait step's stored output, as `runs show` reads it. */
function turnOutput(harness: LaneHarness): Record<string, unknown> | null {
  const row = readDatabase(harness.stateDir, (database) =>
    database.prepare("SELECT output FROM workflow_steps WHERE step_id = 'turn'").get(),
  ) as { output: string | null } | undefined;
  return row?.output === null || row?.output === undefined ? null : (JSON.parse(row.output) as Record<string, unknown>);
}

async function until<T>(harness: LaneHarness, read: () => T, done: (value: T) => boolean, what: string): Promise<T> {
  // Generous: the owner's ticks, the follower and the fake relay share a loaded machine with other suites.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await harness.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('a turn waiting on the person in claude-stream says "Needs you in claude-stream" until they answer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await realpath(await shortTempDir('aev-needs-you-'));
  const folder = join(root, 'acme');
  await mkdir(folder);
  const relay = await new FakeRelay({ allowedRoots: [root] }).start();
  const home = await relay.writeHome(root);
  try {
    await withLaneOwner(
      async (harness) => {
        const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
        await person.request('integration-set', { integration: 'agent-sessions', relayHome: home });
        await enable(harness, workflow(folder));
        const session = relay.addSession({ cwd: folder });
        harness.mailbox.send('Please change the banner');
        await until(
          harness,
          () => turnOutput(harness),
          (output) => output?.needsYouInClaudeStream === false,
          'the wait on the turn, the person not needed',
        );
        const runId = (
          readDatabase(harness.stateDir, (database) => database.prepare('SELECT id FROM workflow_runs').get()) as {
            id: string;
          }
        ).id;

        // The turn asks the person something: the follower's next look at the session's snapshot says so.
        relay.askThePerson(session.id);
        await until(
          harness,
          () => turnOutput(harness),
          (output) => output?.needsYouInClaudeStream === true,
          'the person needed',
        );
        const shown = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId]);
        assert.equal(shown.waiting?.stepId, 'turn');
        assert.equal(shown.waiting?.kind, 'turn-end');
        assert.equal(shown.waiting?.needsYouInClaudeStream, true);
        const listed = await json<RunsListResultV1>(harness.stateDir, ['runs', 'list']);
        assert.equal(listed.runs[0]?.waiting?.needsYouInClaudeStream, true);
        assert.equal(shown.steps.find((step) => step.stepId === 'turn')?.state, 'waiting', 'it still waits');

        // They answer in claude-stream: the turn goes on, and no longer needs them.
        relay.answerThePerson(session.id);
        await until(
          harness,
          () => turnOutput(harness),
          (output) => output?.needsYouInClaudeStream === false,
          'the person answered',
        );

        // The turn ends: the step's output is its closed one, and nothing is left of the word.
        relay.endRun(session.id);
        const ended = await until(
          harness,
          () => turnOutput(harness),
          (output) => output?.reported === null && !Object.hasOwn(output ?? {}, 'needsYouInClaudeStream'),
          'the turn end',
        );
        assert.deepEqual(ended, { for: 'turn-end', reported: null });
        const after = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId]);
        assert.equal(after.state, 'done');
        assert.equal(after.waiting, null);
      },
      {
        // The follower looks at each watched session's snapshot often, so the test does not wait half a minute.
        agentSessions: { homeDirectory: join(root, 'no-home'), reconcileMs: 100 },
        takes: { notify: null },
      },
    );
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
});
