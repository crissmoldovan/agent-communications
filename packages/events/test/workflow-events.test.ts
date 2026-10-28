import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildWorkflowCloudEvent,
  canonicalEventPattern,
  canonicalJson,
  EVENT_SEGMENT,
  eventForOutcome,
  eventsFor,
  isEventSegment,
  matchesEventPattern,
  parseWorkflowEventType,
  RESERVED_NAMESPACES,
  RUN_EVENTS,
  representWorkflowEvent,
  STANDARD_STEP_EVENTS,
  schemaOf,
  WORKFLOW_EVENT_CATALOGUE_V1,
  workflowEventBytes,
  workflowEventType,
} from '../src/index.ts';

// A path, not a URL's pathname: on Windows the pathname is `/D:/…`, which `join` turns into `D:\D:\…`.
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const readFixture = (name: string): string => readFileSync(join(PACKAGE_ROOT, 'test/fixtures', name), 'utf8');

const RUN = 'wfr_01jbx2k3d5f7h9k1m3n5p7r9t1';
const sample = {
  id: 'wfe_01jbx2k9q7m3t5v8w0y2z4a6c8',
  installationId: 'inst-1',
  ruleId: 'client-asks',
  ruleVersion: 5,
  type: 'acme.client-asks.issue.created',
  schema: 'step.deliver.linear',
  time: '2026-10-27T11:20:04.120Z',
  runId: RUN,
  stepId: 'issue',
  data: {
    workflow: { id: 'client-asks', version: 5, namespace: 'acme', name: 'client-asks' },
    run: { id: RUN, startedAt: '2026-10-27T11:19:58.002Z', depth: 0, parent: null },
    step: { id: 'issue', kind: 'deliver', label: null, index: 3, attempt: 1 },
    path: ['route', 'found', 'issue'],
    event: 'created',
    outcome: 'done',
    durationMs: 1840,
    error: null,
    outputs: {
      delivery: 'dlv-1',
      issue: { id: 'issue-1', identifier: 'ACME-123', url: 'https://linear.app/acme/issue/ACME-123' },
    },
  },
} as const;
const wrap = (text: string): string => `<untrusted-content>${text}</untrusted-content>`;

test('names: acme.client-asks.issue.created, 131 at most, reserved namespaces refused', () => {
  assert.equal(workflowEventType('acme', 'client-asks', 'issue', 'created'), 'acme.client-asks.issue.created');
  assert.equal(isEventSegment('a'.repeat(33)), false);
  assert.equal(isEventSegment('Acme'), false);
  assert.equal(isEventSegment('a'.repeat(32)), true);
  assert.equal(canonicalEventPattern('com.*.*.*', ['com']).ok, false);
  assert.deepEqual(RESERVED_NAMESPACES, ['agentcomms', 'com']);
  const longest = workflowEventType('a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(32));
  assert.equal(longest.length, 131);
  assert.throws(() => workflowEventType('agentcomms', 'x', 'y', 'z'), { code: 'WORKFLOW_EVENT_INVALID' });
  assert.throws(() => workflowEventType('acme', 'client.asks', 'y', 'z'), { code: 'WORKFLOW_EVENT_INVALID' });
  assert.deepEqual(parseWorkflowEventType('acme.client-asks.run.failed'), {
    namespace: 'acme',
    workflow: 'client-asks',
    step: 'run',
    event: 'failed',
  });
  assert.equal(parseWorkflowEventType('com.agentcomms.gmail.message.received.v1'), null);
  assert.equal(parseWorkflowEventType('com.agentcomms.slack.v1'), null);
  assert.ok(EVENT_SEGMENT.test('tell-crm'));
});

test('only a literal string is a segment: sender text that looks like a name is never one', () => {
  for (const value of [{ toString: () => 'acme' }, ['acme'], 7, null, undefined, 'acme\n', ' acme', 'ac me'])
    assert.equal(isEventSegment(value), false, String(value));
});

test('patterns match segment by segment, only in the namespaces given', () => {
  assert.equal(matchesEventPattern('acme.client-asks.issue.failed', '*.*.*.failed', ['acme']), true);
  assert.equal(matchesEventPattern('other.client-asks.issue.failed', '*.*.*.failed', ['acme']), false);
  assert.equal(canonicalEventPattern('other.*.*.*', ['acme']).ok, false);
  assert.equal(canonicalEventPattern('acme.client-*.*.*', ['acme']).ok, false);
  assert.equal(canonicalEventPattern('acme.**', ['acme']).ok, false);
  assert.equal(canonicalEventPattern('acme.*.*', ['acme']).ok, false);
  assert.deepEqual(canonicalEventPattern('acme.client-asks.*.*', ['acme']), {
    ok: true,
    pattern: 'acme.client-asks.*.*',
  });
  assert.equal(matchesEventPattern('acme.client-asks.issue.created', 'acme.client-asks.*.*', ['acme']), true);
  assert.equal(matchesEventPattern('acme.client-asks.issue.created', 'acme.other.*.*', ['acme']), false);
  assert.equal(matchesEventPattern('acme.client-asks.issue.created', 'acme.*.created', ['acme']), false);
  assert.equal(matchesEventPattern('acme.client-asks.issue.created', 'acme.*.*.*', []), false);
});

test('the catalogue is Appendix W.3, byte for byte', () => {
  assert.equal(
    canonicalJson(WORKFLOW_EVENT_CATALOGUE_V1),
    canonicalJson(JSON.parse(readFixture('workflow-events-v1.json'))),
  );
  assert.deepEqual(eventsFor('step.find-session'), [
    'started',
    'succeeded',
    'failed',
    'skipped',
    'retrying',
    'found',
    'busy',
    'not-found',
    'watched',
  ]);
  assert.equal(eventForOutcome('step.find-session', 'idle'), 'found');
  assert.ok(Object.isFrozen(WORKFLOW_EVENT_CATALOGUE_V1));
  assert.ok(Object.isFrozen(WORKFLOW_EVENT_CATALOGUE_V1['step.route'].own));
  assert.deepEqual(STANDARD_STEP_EVENTS, ['started', 'succeeded', 'failed', 'waiting', 'skipped', 'retrying']);
  assert.deepEqual(eventsFor('run'), [...RUN_EVENTS]);
});

test('eventsFor narrows a wait by what it waits for, and a Raise step to its name', () => {
  const wait = (waitsFor: object) => ({ kind: 'wait', for: waitsFor, timeoutMs: 1, next: {} }) as never;
  assert.deepEqual(eventsFor('step.wait', wait({ turnEnd: 'give' })).slice(4), ['finished', 'timed-out']);
  assert.deepEqual(eventsFor('step.wait', wait({ sessionIdle: 'find' })).slice(4), ['free', 'timed-out']);
  assert.deepEqual(eventsFor('step.wait', wait({ time: { afterMs: 5 } })).slice(4), ['elapsed']);
  assert.deepEqual(eventsFor('raise', { kind: 'raise', name: 'project-found', next: {} }), ['project-found']);
});

test('schemaOf and eventForOutcome follow W.3', () => {
  assert.equal(schemaOf(null), 'run');
  assert.equal(schemaOf({ kind: 'notify', text: 'x', next: {} }), 'step.notify');
  assert.equal(schemaOf({ kind: 'raise', name: 'x', next: {} }), 'raise');
  const deliver = { kind: 'deliver', target: { targetId: 't', version: 1 }, next: {} } as const;
  assert.equal(schemaOf(deliver, 'linear-change'), 'step.deliver.linear-change');
  assert.throws(() => schemaOf(deliver), { code: 'WORKFLOW_EVENT_INVALID' });
  assert.throws(() => schemaOf(deliver, 'email'), { code: 'WORKFLOW_EVENT_INVALID' });
  for (const [schema, outcome, word] of [
    ['step.condition', 'yes', 'matched'],
    ['step.condition', 'no', 'not-matched'],
    ['step.route', 'chosen', 'matched'],
    ['step.find-session', 'none', 'not-found'],
    ['step.start-session', 'started', 'session-started'],
    ['step.deliver.session', 'done', 'given'],
    ['step.deliver.linear', 'done', 'created'],
    ['step.deliver.webhook', 'done', 'delivered'],
    ['step.wait', 'needs-the-person', 'finished'],
    ['step.wait', 'timed-out', 'timed-out'],
    ['step.wait', 'free', 'free'],
    ['step.notify', 'sent', 'notified'],
    ['run', 'done', 'finished'],
  ] as const)
    assert.equal(eventForOutcome(schema, outcome), word, `${schema} ${outcome}`);
  assert.equal(eventForOutcome('step.deliver.linear', 'failed'), null);
  assert.equal(eventForOutcome('step.split', 'yes'), null);
  assert.equal(eventForOutcome('step.deliver.linear-change', 'done', { stateType: 'completed' }), 'closed');
  assert.equal(eventForOutcome('step.deliver.linear-change', 'done', { changed: ['comment'] }), 'commented');
  assert.equal(eventForOutcome('step.deliver.linear-change', 'done', { changed: ['comment', 'labels'] }), 'changed');
});

test('buildWorkflowCloudEvent fixes every attribute', () => {
  const e = buildWorkflowCloudEvent(sample);
  assert.equal(e.specversion, '1.0');
  assert.equal(e.source, 'urn:agentcomms:inst-1:workflows:client-asks@5');
  assert.equal(e.dataschema, 'urn:agentcomms:workflow-events:v1:step.deliver.linear');
  assert.equal(e.subject, sample.runId);
  assert.equal(e.agentcommsstep, 'issue');
  assert.equal(e.agentcommsrule, 'client-asks@5');
  assert.equal(e.agentcommsrun, RUN);
  assert.equal(e.datacontenttype, 'application/json');
  assert.equal(Object.hasOwn(e, 'agentcommsuntrusted'), false);
  assert.deepEqual(Object.keys(e.data).sort(), [
    'durationMs',
    'error',
    'event',
    'outcome',
    'outputs',
    'path',
    'run',
    'step',
    'workflow',
  ]);
  assert.equal(workflowEventBytes(e), canonicalJson(e));
  const ruled = buildWorkflowCloudEvent({
    ...sample,
    ruleId: 'Client Asks',
    data: { ...sample.data, workflow: { ...sample.data.workflow, id: 'Client Asks' } },
  });
  assert.equal(ruled.source, 'urn:agentcomms:inst-1:workflows:Client%20Asks@5');
});

test("a run's event has no step and no agentcommsstep", () => {
  const e = buildWorkflowCloudEvent({
    ...sample,
    type: 'acme.client-asks.run.failed',
    schema: 'run',
    stepId: null,
    data: { ...sample.data, step: null, event: 'failed', outcome: null, error: 'STEP_LIMIT', outputs: {} },
  });
  assert.equal(Object.hasOwn(e, 'agentcommsstep'), false);
  assert.equal(e.data.step, null);
});

test('buildWorkflowCloudEvent refuses what W.2 and W.3 do not allow', () => {
  for (const bad of [
    { ...sample, id: 'wfe_short' },
    { ...sample, id: 'wfe_01JBX2K9Q7M3T5V8W0Y2Z4A6C8' },
    { ...sample, runId: 'run_01jbx2k3d5f7h9k1m3n5p7r9t1' },
    { ...sample, type: 'com.client-asks.issue.created' },
    { ...sample, type: 'acme.client-asks.other.created' },
    { ...sample, type: 'acme.client-asks.issue.given', data: { ...sample.data, event: 'given' } },
    { ...sample, time: 'yesterday' },
    { ...sample, schema: 'run' },
    { ...sample, data: { ...sample.data, folder: '/example/home/acme' } },
    { ...sample, data: { ...sample.data, workflow: { ...sample.data.workflow, namespace: 'other' } } },
  ])
    assert.throws(() => buildWorkflowCloudEvent(bad as never), { code: 'WORKFLOW_EVENT_INVALID' });
});

test('representWorkflowEvent: none drops fields, enveloped wraps them and lists their pointers', () => {
  const raised = buildWorkflowCloudEvent({ ...sample, fields: { text: 'SENTINEL-SENDER' } });
  assert.equal(raised.agentcommsuntrusted, '%2Ffields%2Ftext');
  const none = representWorkflowEvent(raised, 'none', wrap);
  assert.equal(JSON.stringify(none).includes('SENTINEL-SENDER'), false);
  assert.equal(Object.hasOwn(none, 'agentcommsuntrusted'), false);
  assert.equal(Object.hasOwn(none.data, 'fields'), false);
  const pointers: string[] = [];
  const env = representWorkflowEvent(raised, 'enveloped', (t, pointer) => {
    pointers.push(pointer);
    return `<<${t}>>`;
  });
  assert.equal(env.data.fields?.text, '<<SENTINEL-SENDER>>');
  assert.ok(env.agentcommsuntrusted);
  assert.deepEqual(pointers, ['/fields/text']);
  const plain = buildWorkflowCloudEvent(sample);
  assert.deepEqual(representWorkflowEvent(plain, 'enveloped', wrap), plain);
});
