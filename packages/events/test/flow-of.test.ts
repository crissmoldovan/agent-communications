import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson, checkFlow, FLOW_LIMIT_DEFAULTS, type FlowDocumentV1, flowOf, stepOrder } from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * Every workflow is drawn as a graph (workflows design W2, W22): its own flow, or, for today's straight line, one
 * deliver step per target. The drawing is derived and never stored.
 */

type Target = { targetId: string; version: number; kind: string };

const oneTarget = { targets: [{ targetId: 'invoices-log', version: 1, kind: 'dry-run', retentionMs: 86_400_000 }] };
/** A split step's branches, refusing any other kind. */
function branchesOf(flow: FlowDocumentV1, id: string): readonly string[] {
  const step = flow.steps[id];
  assert.equal(step?.kind, 'split');
  return step?.kind === 'split' ? step.branches : [];
}

const kindsOf = (targets: readonly Target[]) =>
  Object.fromEntries(targets.map((target) => [`${target.targetId}@${target.version}`, target.kind]));

test('a straight line with one target is one deliver step', () => {
  const { flow, derived } = flowOf(oneTarget);
  assert.equal(derived, true);
  assert.deepEqual(Object.keys(flow.steps), ['deliver-invoices-log']);
  assert.deepEqual(flow, {
    flowVersion: 1,
    start: 'deliver-invoices-log',
    steps: {
      'deliver-invoices-log': { kind: 'deliver', target: { targetId: 'invoices-log', version: 1 }, next: {} },
    },
    limits: FLOW_LIMIT_DEFAULTS,
  });
  assert.equal(checkFlow(flow, kindsOf(oneTarget.targets)).ok, true);
});

test('several targets are a split into one deliver each', () => {
  const targets: Target[] = [
    { targetId: 'billing', version: 1, kind: 'queue' },
    { targetId: 'Invoices Log', version: 2, kind: 'dry-run' },
    { targetId: 'invoices-log', version: 1, kind: 'dry-run' },
    { targetId: 'client.prompt@acme:2', version: 3, kind: 'session' },
  ];
  const { flow, derived } = flowOf({ targets });
  assert.equal(derived, true);
  assert.equal(flow.start, 'split');
  assert.deepEqual(flow.steps.split, {
    kind: 'split',
    branches: ['deliver-billing', 'deliver-invoices-log', 'deliver-invoices-log-2', 'deliver-client-prompt-acme-2'],
  });
  assert.deepEqual(flow.steps['deliver-invoices-log-2'], {
    kind: 'deliver',
    target: { targetId: 'invoices-log', version: 1 },
    next: {},
  });
  const checked = checkFlow(flow, kindsOf(targets));
  assert.ok(checked.ok, JSON.stringify(checked));
  assert.deepEqual(stepOrder(flow), ['split', ...branchesOf(flow, 'split')]);
});

test('a step id folds the target id to at most 24 characters, and stays one when ids collide', () => {
  const long = 'A'.repeat(40);
  const targets: Target[] = [
    { targetId: long, version: 1, kind: 'dry-run' },
    { targetId: long.toLowerCase(), version: 2, kind: 'dry-run' },
    { targetId: '請求書', version: 1, kind: 'dry-run' },
    { targetId: '--', version: 1, kind: 'dry-run' },
  ];
  const { flow } = flowOf({ targets });
  const ids = branchesOf(flow, 'split');
  assert.deepEqual(ids, [
    `deliver-${'a'.repeat(24)}`,
    `deliver-${'a'.repeat(22)}-2`,
    'deliver-target',
    'deliver-target-2',
  ]);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]{0,31}$/);
  assert.equal(checkFlow(flow, kindsOf(targets)).ok, true);
});

test('more than eight targets hang under splits of at most eight branches', () => {
  const targets: Target[] = Array.from({ length: 17 }, (_, index) => ({
    targetId: `log-${index}`,
    version: 1,
    kind: 'dry-run',
  }));
  const { flow } = flowOf({ targets });
  const branches = (id: string) => branchesOf(flow, id);
  assert.equal(branches('split').length, 8);
  assert.equal(branches('split').at(-1), 'split-2');
  assert.equal(branches('split-2').at(-1), 'split-3');
  assert.deepEqual(branches('split-3'), ['deliver-log-14', 'deliver-log-15', 'deliver-log-16']);
  const delivered = Object.values(flow.steps).filter((step) => step.kind === 'deliver').length;
  assert.equal(delivered, 17);
  const checked = checkFlow(flow, kindsOf(targets));
  assert.ok(checked.ok, JSON.stringify(checked));
});

test('a workflow with a flow returns its own flow, not derived', () => {
  const owner = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'flows', 'owner-example.json'), 'utf8'),
  ) as { targets: Target[]; flow: FlowDocumentV1 };
  const { flow, derived } = flowOf(owner);
  assert.equal(derived, false);
  assert.equal(flow, owner.flow, 'the very flow the document holds');
});

test('flowOf never writes flow into the document it reads', () => {
  const before = canonicalJson(oneTarget);
  flowOf(oneTarget);
  assert.equal(canonicalJson(oneTarget), before);
  assert.equal(Object.hasOwn(oneTarget, 'flow'), false);
  const frozen = Object.freeze({ targets: Object.freeze([...oneTarget.targets]) });
  assert.doesNotThrow(() => flowOf(frozen));
  const { flow } = flowOf(oneTarget);
  flow.limits.runsPerHour = 1;
  assert.equal(FLOW_LIMIT_DEFAULTS.runsPerHour, 10, 'the drawing has its own copy of the defaults');
});
