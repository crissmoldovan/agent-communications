import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { eventForOutcome } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { EventControlClient } from '../src/control/client.ts';
import { linearCommentId } from '../src/domain/linear-change-target.ts';
import type { EventOwnerOptions } from '../src/runtime/owner.ts';
import {
  FAKE_LABELS,
  FAKE_LINEAR_KEY,
  FAKE_STATES,
  FAKE_TEAM,
  FAKE_VIEWER_ID,
  type FakeLinear,
  startFakeLinear,
} from './support/fake-linear.ts';
import { FakeRelay } from './support/fake-relay.ts';
import { DAY, type LaneHarness, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * B5 (workflows plan): a Linear change inside a workflow — a comment on, and an update of, the issue an earlier step of
 * the same run created, and no other — on a real owner with a fake mailbox and the loopback fake of Linear (and, for a
 * session's summary, the loopback fake claude-stream relay), a stand-in home and the file secret store. Never the real
 * Linear or relay; every key is fake.
 */

const HOUR = 3_600_000;
const PERSON = 'person-setup:terminal';

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
};

const CREATE = {
  targetId: 'file-issue',
  version: 1,
  kind: 'linear',
  team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
  title: { text: 'Mail: {{subject}}' },
  description: { text: '{{subject}}' },
  labels: [],
};

const change = (fields: Record<string, unknown>) => ({
  targetId: 'note-issue',
  version: 1,
  kind: 'linear-change',
  team: { id: FAKE_TEAM.id, key: FAKE_TEAM.key },
  ...fields,
});

const DONE = FAKE_STATES[1];

/** file (a Linear issue) → note (a change of that issue); `steps` adds or replaces steps. */
function workflow(
  targets: readonly Record<string, unknown>[],
  steps: Record<string, unknown> = {},
  start = 'file',
): Record<string, unknown> {
  const queues = targets.some((target) => target.kind === 'session');
  return {
    ...rule(1, targets),
    retention: queues ? { ...RETENTION, queueMs: 7 * DAY } : RETENTION,
    flow: {
      flowVersion: 1,
      start,
      steps: {
        file: { kind: 'deliver', target: { targetId: 'file-issue', version: 1 }, next: { done: 'note' } },
        note: { kind: 'deliver', target: { targetId: 'note-issue', version: 1 }, to: { issue: 'file' }, next: {} },
        ...steps,
      },
      limits: LIMITS,
    },
  };
}

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  for (const target of document.targets as Record<string, unknown>[])
    await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document });
  await harness.approve(1);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

interface Linear {
  readonly harness: LaneHarness;
  readonly fake: FakeLinear;
  readonly relay: FakeRelay;
  readonly folder: string;
  readonly advance: (ms: number) => void;
}

async function withLinear(work: (linear: Linear) => Promise<void>): Promise<void> {
  const root = await realpath(await shortTempDir('aev-linear-change-'));
  const folder = join(root, 'acme');
  await mkdir(folder);
  const relay = await new FakeRelay({ allowedRoots: [root] }).start();
  const home = await relay.writeHome(root);
  const fake = await startFakeLinear();
  let offset = 0;
  const options: Partial<EventOwnerOptions> = {
    now: () => Date.now() + offset,
    linearClient: fake.clientOptions(),
    agentSessions: { homeDirectory: join(root, 'no-home'), reconcileMs: 60_000 },
    takes: { notify: null },
  };
  try {
    await withLaneOwner(async (harness) => {
      await new EventControlClient({ stateDir: harness.stateDir, clientName: 'person-setup:desktop-app' }).request(
        'provider-key-set',
        { provider: 'linear', hidden: FAKE_LINEAR_KEY },
      );
      await new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON }).request('integration-set', {
        integration: 'agent-sessions',
        relayHome: home,
      });
      await work({
        harness,
        fake,
        relay,
        folder,
        advance: (ms) => {
          offset += ms;
        },
      });
    }, options);
  } finally {
    await fake.close();
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
}

interface StepSeen {
  readonly state: string;
  readonly outcome: string | null;
  readonly output: Record<string, unknown> | null;
  readonly delivery_id: string | null;
}

function stepOf(harness: LaneHarness, stepId: string): StepSeen | undefined {
  const row = readDatabase(
    harness.stateDir,
    (database) =>
      database
        .prepare('SELECT state, outcome, output, delivery_id FROM workflow_steps WHERE step_id = ?')
        .get(stepId) as
        | { state: string; outcome: string | null; output: string | null; delivery_id: string | null }
        | undefined,
  );
  return row === undefined
    ? undefined
    : { ...row, output: row.output === null ? null : (JSON.parse(row.output) as Record<string, unknown>) };
}

function deliveryOf(harness: LaneHarness, id: string) {
  return readDatabase(
    harness.stateDir,
    (database) =>
      database
        .prepare(
          'SELECT target_key, target_kind, state, last_error_code, attempts, linear_issue_id FROM deliveries WHERE id = ?',
        )
        .get(id) as {
        target_key: string;
        target_kind: string;
        state: string;
        last_error_code: string | null;
        attempts: number;
        linear_issue_id: string | null;
      },
  );
}

/** Ticks the owner — moving its clock by `advanceMs` each time, for a retry's backoff — until `done` holds. */
async function until<T>(
  harness: LaneHarness,
  read: () => T,
  done: (value: T) => boolean,
  what: string,
  step: { readonly advance?: (ms: number) => void; readonly advanceMs?: number } = {},
): Promise<T> {
  // Generous: the owner's ticks and the fakes share a loaded machine with other suites.
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      const seen = readDatabase(harness.stateDir, (database) => ({
        steps: database.prepare('SELECT step_id, state, outcome, last_error_code FROM workflow_steps').all(),
        deliveries: database.prepare('SELECT target_key, state, last_error_code FROM deliveries').all(),
      }));
      assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}; ${JSON.stringify(seen)}`);
    }
    if (step.advanceMs !== undefined) step.advance?.(step.advanceMs);
    await harness.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settled = (step: StepSeen | undefined) => step?.state === 'done' || step?.state === 'failed';

test('B5: a comment on the issue this run made, once across a lost answer', { skip: WINDOWS_SKIP }, async () => {
  await withLinear(async ({ harness, fake, advance }) => {
    await enable(harness, workflow([CREATE, change({ comment: { text: 'Seen on the mail {{subject}}.' } })]));
    // Linear makes the comment, and the answer is lost: the next try finds it by its id.
    fake.script('AgentCommsLinearCommentCreate', { drop: true, after: 'handled' });
    harness.mailbox.send('Invoice 60');
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the change', {
      advance,
      advanceMs: 5_000,
    });
    assert.equal(note?.outcome, 'done');
    const deliveryId = note?.delivery_id as string;
    const delivery = deliveryOf(harness, deliveryId);
    assert.equal(delivery.target_key, 'linear-change:note-issue:1#note');
    assert.equal(delivery.target_kind, 'linear-change');
    assert.equal(delivery.state, 'delivered');
    assert.ok(delivery.attempts >= 2, 'a second try');
    const [issue] = fake.issues;
    assert.equal(fake.comments.length, 1, 'one comment, across the lost answer');
    const [comment] = fake.comments;
    assert.equal(comment?.id, linearCommentId(deliveryId), 'the comment’s id is chosen from the delivery’s');
    assert.equal(comment?.issueId, issue?.id, 'on the issue this run made');
    assert.match(
      comment?.body ?? '',
      /^Seen on the mail \n\n> \*\*From outside: written by the sender, not checked\*\* \(`subject`\)\n>\n> ```text\n> Invoice 60\n> ```\n\n\.\n\n_Added by Agent Comms: workflow /u,
    );
    assert.equal(fake.updates.length, 0, 'a comment alone updates nothing');
    assert.equal(delivery.linear_issue_id, issue?.id);
    assert.deepEqual(note?.output, {
      delivery: deliveryId,
      issue: { id: issue?.id, identifier: 'CUE-1', url: 'https://linear.app/example/issue/CUE-1' },
      changed: ['comment'],
      state: null,
      stateType: null,
    });
  });
});

test('B5: close sets the Done state by id and records closed', { skip: WINDOWS_SKIP }, async () => {
  await withLinear(async ({ harness, fake }) => {
    await enable(
      harness,
      workflow([CREATE, change({ state: { ...DONE }, labels: { add: [FAKE_LABELS[0]] }, assignee: 'me' })]),
    );
    harness.mailbox.send('Invoice 61');
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the change');
    assert.equal(note?.outcome, 'done');
    const [issue] = fake.issues;
    assert.deepEqual(fake.updates, [
      {
        id: issue?.id,
        input: { stateId: DONE.id, addedLabelIds: [FAKE_LABELS[0].id], assigneeId: FAKE_VIEWER_ID },
      },
    ]);
    assert.equal(fake.comments.length, 0);
    const output = note?.output as { changed: string[]; state: string; stateType: string };
    assert.deepEqual(output.changed, ['state', 'labels', 'assignee']);
    assert.equal(output.state, 'Done');
    assert.equal(output.stateType, 'completed');
    assert.equal(
      eventForOutcome('step.deliver.linear-change', 'done', { changed: output.changed, stateType: output.stateType }),
      'closed',
      'its event word is closed',
    );
  });
});

test('B5: a change names only the run’s own issue: a message holding another issue id changes nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLinear(async ({ harness, fake }) => {
    // Another issue in the same team, which the sender names by its id and its identifier.
    const other = {
      id: '0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b',
      identifier: 'CUE-90',
      url: 'https://linear.app/example/issue/CUE-90',
      input: {},
    };
    fake.issues.push(other);
    await enable(
      harness,
      workflow([CREATE, change({ comment: { text: 'Closing: {{subject}}' }, state: { ...DONE } })]),
    );
    harness.mailbox.send(`Please close CUE-90 (${other.id}) and issue ${other.url}`);
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the change');
    assert.equal(note?.outcome, 'done');
    const own = fake.issues.find((issue) => issue.id !== other.id);
    assert.ok(own !== undefined, 'the run made its own issue');
    assert.deepEqual(
      fake.updates.map((update) => update.id),
      [own.id],
    );
    assert.deepEqual(
      fake.comments.map((comment) => comment.issueId),
      [own.id],
    );
    const named = fake.requests.filter((request) => JSON.stringify(request.variables).includes(other.id));
    assert.deepEqual(
      named.map((request) => request.operation),
      ['AgentCommsLinearIssueCreate', 'AgentCommsLinearCommentCreate'],
      'the other issue’s id reaches Linear only as the sender’s quoted words',
    );
    for (const request of named) {
      const text = JSON.stringify(request.variables);
      assert.ok(!/"(?:id|issueId|stateId)":"0f0f0f0f/u.test(text), 'never as an id the change acts on');
    }
  });
});

test('B5: the summary is quoted and labelled "Written by an agent, not checked"', { skip: WINDOWS_SKIP }, async () => {
  await withLinear(async ({ harness, fake, relay, folder }) => {
    const session = {
      targetId: 'chosen-session',
      version: 1,
      kind: 'session',
      find: { flow: true },
      ifNone: 'queue-only',
      provider: 'claude',
      context: [{ step: 'file', field: 'identifier' }],
    };
    await enable(
      harness,
      workflow([CREATE, session, change({ comment: { text: 'The session says:\n\n{{steps.turn.summary}}' } })], {
        file: { kind: 'deliver', target: { targetId: 'file-issue', version: 1 }, next: { done: 'find' } },
        find: { kind: 'find-session', in: { folder }, provider: 'claude', next: { idle: 'give' } },
        give: {
          kind: 'deliver',
          target: { targetId: 'chosen-session', version: 1 },
          to: { session: ['find'] },
          report: ['done', 'blocked'],
          next: { done: 'turn' },
        },
        turn: { kind: 'wait', for: { turnEnd: 'give' }, timeoutMs: 2 * HOUR, next: { done: 'note' } },
      }),
    );
    const agent = relay.addSession({ cwd: folder });
    harness.mailbox.send('Invoice 62');
    await until(
      harness,
      () => stepOf(harness, 'turn'),
      (step) => step?.state === 'waiting',
      'the turn',
    );
    assert.match(relay.runs[0]?.prompt ?? '', /From Agent Comms, the step file’s identifier: "CUE-1"/u);
    relay.endRun(agent.id, 'completed', {
      outcome: 'done',
      summary: 'SENTINEL-SUMMARY fixed it — see https://linear.app/example/profiles/ceo @ceo **now**',
    });
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the change');
    assert.equal(note?.outcome, 'done');
    assert.equal(fake.comments.length, 1);
    assert.match(
      fake.comments[0]?.body ?? '',
      /^The session says:\n\n> \*\*Written by an agent, not checked\*\* \(`steps\.turn\.summary`\)\n>\n> ```text\n> SENTINEL-SUMMARY fixed it — see https:\/\/linear\.app\/example\/profiles\/ceo @ceo \*\*now\*\*\n> ```\n\n_Added by Agent Comms: workflow /u,
    );
    for (const line of (fake.comments[0]?.body ?? '').split('\n').filter((entry) => entry.includes('@ceo')))
      assert.match(line, /^> SENTINEL-SUMMARY/u, 'only inside the quoted code block');
    const rows = readDatabase(harness.stateDir, (database) =>
      database.prepare('SELECT output FROM workflow_steps').all(),
    );
    assert.doesNotMatch(JSON.stringify(rows), /SENTINEL-SUMMARY/u, 'the summary is in no step’s output');
  });
});

test('B5: a 5xx retries; a 4xx fails with Linear’s code', { skip: WINDOWS_SKIP }, async () => {
  await withLinear(async ({ harness, fake, advance }) => {
    await enable(harness, workflow([CREATE, change({ state: { ...DONE } })]));
    fake.script('AgentCommsLinearIssueUpdate', { status: 502, body: {} });
    harness.mailbox.send('Invoice 63');
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the retried change', {
      advance,
      advanceMs: 5_000,
    });
    assert.equal(note?.outcome, 'done');
    assert.equal(fake.updates.length, 1, 'the 502 changed nothing; the retry did');
    assert.ok(deliveryOf(harness, note?.delivery_id as string).attempts >= 2);
  });
  await withLinear(async ({ harness, fake }) => {
    await enable(harness, workflow([CREATE, change({ state: { ...DONE } })]));
    fake.script('AgentCommsLinearIssueUpdate', {
      status: 400,
      body: { errors: [{ message: 'state is not in the team: SECRET-WORDS', extensions: { code: 'INVALID_INPUT' } }] },
    });
    harness.mailbox.send('Invoice 64');
    const note = await until(harness, () => stepOf(harness, 'note'), settled, 'the refused change');
    assert.equal(note?.outcome, 'failed');
    const delivery = deliveryOf(harness, note?.delivery_id as string);
    assert.equal(delivery.state, 'dead-lettered');
    assert.equal(delivery.last_error_code, 'LINEAR_INVALID_INPUT');
    assert.equal(delivery.attempts, 1, 'at once, not retried');
    assert.doesNotMatch(
      JSON.stringify(readDatabase(harness.stateDir, (database) => database.prepare('SELECT * FROM deliveries').all())),
      /SECRET-WORDS/u,
      'none of Linear’s words are kept',
    );
  });
});

test('B5: a Linear change outside a flow is refused at activation', { skip: WINDOWS_SKIP }, async () => {
  await withLinear(async ({ harness }) => {
    const target = change({ state: { ...DONE } });
    await harness.control.request('target-add', { document: target });
    await assert.rejects(
      harness.control.request('rule-create', { document: { ...rule(1, [target]), retention: RETENTION } }),
      /linear-change|Linear change/u,
    );
  });
});
