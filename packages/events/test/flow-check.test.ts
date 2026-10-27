import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  canonicalJson,
  checkFlow,
  connectionAllowed,
  FLOW_BOUNDS,
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  type FlowDocumentV1,
  nextSteps,
  STEP_OUTCOMES,
  stepOrder,
  unreachableAfter,
} from '../src/index.ts';

// A path, not a URL's pathname: on Windows the pathname is `/D:/…`, which `join` turns into `D:\D:\…`.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A flow as a test edits it: any field may be changed, added or removed. */
interface Editable {
  start: string;
  steps: Record<string, Record<string, unknown>>;
  limits: Record<string, number>;
  events?: unknown;
  on?: unknown;
}

/** The spec §4.4 owner example as JSON. */
const owner = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test/fixtures/flows/owner-example.json'), 'utf8')) as {
  flow: FlowDocumentV1;
};
const ownerTargetKinds: Readonly<Record<string, string>> = {
  'client-issues@1': 'linear',
  'client-prompt@2': 'session',
  'client-done@1': 'linear-change',
};
const ALWAYS = { path: '/fields/text', op: 'exists' };

const edit = (): Editable => JSON.parse(canonicalJson(owner.flow)) as Editable;

/** Every arrow that names `from` now names `to`, and the step itself is renamed. */
function rename(flow: Editable, from: string, to: string): void {
  const steps: Record<string, Record<string, unknown>> = {};
  for (const [id, step] of Object.entries(flow.steps)) {
    const next = step.next as Record<string, string> | undefined;
    if (next !== undefined)
      for (const [outcome, target] of Object.entries(next)) if (target === from) next[outcome] = to;
    steps[id === from ? to : id] = step;
  }
  flow.steps = steps;
  if (flow.start === from) flow.start = to;
}

/** A split whose two branches both reach tell: one directly, one through another, tree and its refusal. */
function splitMeets(flow: Editable): void {
  flow.steps.s = { kind: 'split', branches: ['tell', 'another'] };
  flow.steps.route = { ...flow.steps.route, next: { none: 's', otherwise: 'found' } };
}

/** The owner example and as many notices again as make 33 steps. */
function thirtyThree(flow: Editable): void {
  for (let index = Object.keys(flow.steps).length; index < 33; index += 1)
    flow.steps[`extra-${index}`] = { kind: 'notify', text: 'x', next: {} };
}

test('checkFlow accepts the owner example, and its canonical form is the fixture', () => {
  const r = checkFlow(owner.flow, ownerTargetKinds);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.ok);
  assert.equal(canonicalJson(r.flow), canonicalJson(owner.flow));
});

for (const [name, mutate, code] of [
  [
    'a cycle',
    (f) => {
      f.steps.give = { ...f.steps.give, next: { otherwise: 'route' } };
    },
    'FLOW_CYCLE',
  ],
  [
    'an unreachable step',
    (f) => {
      f.steps.orphan = { kind: 'notify', text: 'x', next: {} };
    },
    'FLOW_UNREACHABLE',
  ],
  ['split branches that meet', splitMeets, 'FLOW_SPLIT_MEETS'],
  [
    'a split of 1',
    (f) => {
      f.steps.s = { kind: 'split', branches: ['tell'] };
      f.start = 's';
    },
    'FLOW_SPLIT_BRANCHES',
  ],
  ['33 steps', thirtyThree, 'FLOW_TOO_MANY_STEPS'],
  ['the step id run', (f) => rename(f, 'tell', 'run'), 'FLOW_STEP_ID'],
  [
    'emit "found" on a condition',
    (f) => {
      f.steps.c = { kind: 'condition', when: ALWAYS, emit: ['found'], next: {} };
    },
    'FLOW_EMIT_UNKNOWN',
  ],
  [
    'emit without flow.events',
    (f) => {
      delete f.events;
    },
    'FLOW_EVENTS_MISSING',
  ],
  [
    'a Raise named succeeded',
    (f) => {
      f.steps.found = { ...f.steps.found, name: 'succeeded' };
    },
    'FLOW_RAISE_NAME',
  ],
  [
    'runsPerHour 61',
    (f) => {
      f.limits.runsPerHour = 61;
    },
    'FLOW_LIMIT',
  ],
  [
    'an on.raised pattern with **',
    (f) => {
      f.on = { raised: ['acme.**'], withinMs: 1 };
    },
    'FLOW_ON_PATTERN',
  ],
  [
    'a label of 61 characters',
    (f) => {
      f.steps.tell = { ...f.steps.tell, label: 'x'.repeat(61) };
    },
    'FLOW_LABEL',
  ],
  [
    'a thread place on start-session',
    (f) => {
      f.steps.start = { ...f.steps.start, in: { thread: true } };
    },
    'FLOW_PLACE',
  ],
  [
    'an arrow to a step that is not there',
    (f) => {
      f.steps.tell = { ...f.steps.tell, next: { sent: 'nowhere' } };
    },
    'FLOW_ARROW',
  ],
  [
    'an outcome the step cannot have',
    (f) => {
      f.steps.free = { ...f.steps.free, next: { elapsed: 'give' } };
    },
    'FLOW_OUTCOME',
  ],
  [
    'a start that is not a step',
    (f) => {
      f.start = 'nowhere';
    },
    'FLOW_START',
  ],
  [
    'an unknown key',
    (f) => {
      f.steps.tell = { ...f.steps.tell, colour: 'red' };
    },
    'FLOW_SHAPE',
  ],
  [
    'a notice that names a field a sender wrote',
    (f) => {
      f.steps.tell = { ...f.steps.tell, text: 'From {{author.name}}' };
    },
    'FLOW_SHAPE',
  ],
  [
    "a branch named from a session's summary",
    (f) => {
      f.steps.tree = { ...f.steps.tree, branch: 'ac/{{steps.wait.summary}}' };
    },
    'FLOW_SHAPE',
  ],
  [
    'a limit left out',
    (f) => {
      delete (f.limits as Partial<Record<string, number>>).runMs;
    },
    'FLOW_LIMIT',
  ],
  [
    'a wait longer than the run',
    (f) => {
      f.steps.wait = { ...f.steps.wait, timeoutMs: FLOW_LIMIT_DEFAULTS.runMs + 1 };
    },
    'FLOW_LIMIT',
  ],
  [
    'a reserved namespace',
    (f) => {
      f.events = { namespace: 'com', workflow: 'client-asks' };
    },
    'FLOW_SHAPE',
  ],
  [
    'emit on a Raise step',
    (f) => {
      f.steps.found = { ...f.steps.found, emit: ['project-found'] };
    },
    'FLOW_EMIT_UNKNOWN',
  ],
  [
    'an on.raised pattern from any workflow',
    (f) => {
      f.on = { raised: ['acme.*.issue.created'], withinMs: 1 };
    },
    'FLOW_ON_PATTERN',
  ],
] as const satisfies readonly (readonly [string, (flow: Editable) => void, string])[])
  test(`checkFlow refuses ${name}`, () => {
    const f = edit();
    mutate(f);
    const r = checkFlow(f, ownerTargetKinds);
    assert.equal(r.ok, false);
    assert.ok(!r.ok);
    assert.equal(r.problems[0]?.code, code, JSON.stringify(r.problems));
  });

test('find-session in { thread: true } is accepted', () => {
  const f = edit();
  f.steps.find = { ...f.steps.find, in: { thread: true } };
  assert.equal(checkFlow(f, ownerTargetKinds).ok, true);
});

test('emit is sorted and unique, and left out when empty; a chained workflow is accepted', () => {
  const f = edit();
  f.steps.route = { ...f.steps.route, emit: ['none', 'matched'] };
  f.steps.tell = { ...f.steps.tell, emit: [] };
  f.on = { raised: ['other.intake.*.created', 'other.intake.issue.failed'], withinMs: FLOW_BOUNDS.onWithinDefaultMs };
  const r = checkFlow(f, ownerTargetKinds);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.flow.steps.route?.emit, ['matched', 'none']);
  assert.equal(Object.hasOwn(r.flow.steps.tell ?? {}, 'emit'), false);
  assert.deepEqual(r.flow.on?.raised, ['other.intake.*.created', 'other.intake.issue.failed']);
});

test('a deliver step whose target is unknown is left to activation, and its emit to its kind when known', () => {
  const f = edit();
  f.steps.issue = { ...f.steps.issue, target: { targetId: 'not-yet', version: 3 } };
  assert.equal(checkFlow(f, ownerTargetKinds).ok, true);
  const g = edit();
  g.steps.issue = { ...g.steps.issue, emit: ['given'] };
  const r = checkFlow(g, ownerTargetKinds);
  assert.ok(!r.ok);
  assert.equal(r.problems[0]?.code, 'FLOW_EMIT_UNKNOWN');
});

test('the limits and bounds are the spec’s', () => {
  assert.deepEqual(FLOW_LIMIT_DEFAULTS, {
    runsPerHour: 10,
    concurrentRuns: 2,
    sessionsPerHour: 2,
    worktreesPerDay: 5,
    linearWritesPerHour: 30,
    eventsPerHour: 120,
    runMs: 259_200_000,
  });
  assert.deepEqual(Object.values(FLOW_LIMIT_CEILINGS), [60, 8, 10, 20, 120, 600, 2_592_000_000]);
  assert.equal(FLOW_BOUNDS.steps, 32);
  assert.deepEqual(STEP_OUTCOMES['find-session'], ['idle', 'busy', 'none', 'watched']);
});

test('connectionAllowed refuses a cycle and a split meeting itself, and allows a fresh arrow', () => {
  assert.equal(connectionAllowed(owner.flow, { stepId: 'give', outcome: 'done' }, 'route'), false);
  assert.equal(connectionAllowed(owner.flow, { stepId: 'wait', outcome: 'timed-out' }, 'tell'), true);
  assert.equal(connectionAllowed(owner.flow, { stepId: 'wait', outcome: 'elapsed' }, 'tell'), false);
  const f = edit();
  f.steps.s = { kind: 'split', branches: ['tell', 'note'] };
  f.steps.route = { ...f.steps.route, next: { none: 's', otherwise: 'found' } };
  f.steps.wait = { ...f.steps.wait, next: { done: 'end', otherwise: 'end' } };
  const split = f as unknown as FlowDocumentV1;
  assert.equal(connectionAllowed(split, { stepId: 'note', outcome: 'done' }, 'tell'), false);
  assert.equal(connectionAllowed(split, { stepId: 'note', outcome: 'done' }, 'end'), true);
});

test('nextSteps follows an arrow, then otherwise; end is none; a split is its branches', () => {
  const steps = owner.flow.steps;
  assert.deepEqual(nextSteps(steps.find as never, 'idle'), ['give']);
  assert.deepEqual(nextSteps(steps.find as never, 'watched'), ['free']);
  assert.deepEqual(nextSteps(steps.note as never, 'done'), []);
  assert.deepEqual(nextSteps(steps.tell as never, 'sent'), []);
  assert.deepEqual(nextSteps({ kind: 'split', branches: ['a', 'b'] }, 'anything'), ['a', 'b']);
});

test('stepOrder is the printer’s: depth first, a merge written once every step before it is', () => {
  assert.deepEqual(stepOrder(owner.flow), [
    'route',
    'found',
    'issue',
    'find',
    'free',
    'another',
    'tree',
    'start',
    'give',
    'wait',
    'note',
    'tell',
  ]);
});

test('unreachableAfter names the branches a settle closed', () => {
  assert.deepEqual(unreachableAfter(owner.flow, new Set(['give']), new Set(['route', 'found', 'issue', 'find'])), [
    'free',
    'another',
    'tree',
    'start',
  ]);
});

test('checkFlow refuses what is not JSON, and never changes what it reads', () => {
  const before = canonicalJson(owner.flow);
  checkFlow(owner.flow, ownerTargetKinds);
  assert.equal(canonicalJson(owner.flow), before);
  const r = checkFlow({ ...owner.flow, limits: { ...owner.flow.limits, runMs: Number.NaN } }, ownerTargetKinds);
  assert.ok(!r.ok);
  assert.equal(r.problems[0]?.code, 'FLOW_SHAPE');
});
