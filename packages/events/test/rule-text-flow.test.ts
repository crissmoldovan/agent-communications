import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFlow, type JsonObject, parseRuleText, printRuleText } from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * The workflow text's `flow` section (workflows design §4.4, W17): steps, arrows, events, Raise and chains. A flow's
 * text parses to its document and prints back to the same text; the fixtures under `fixtures/flows/` are pairs, and
 * the owner's example (`owner-example.json`, written with the flow contracts) is the source of truth for the words.
 */

const FLOWS = join(PACKAGE_ROOT, 'test', 'fixtures', 'flows');
const read = (name: string) => readFileSync(join(FLOWS, name), 'utf8');
const readJson = (name: string) => JSON.parse(read(name)) as JsonObject;

type Doc = Record<string, unknown> & {
  flow: Record<string, unknown> & { steps: Record<string, Record<string, unknown>> };
};

function parsed(text: string): Doc {
  const result = parseRuleText(text);
  assert.ok(result.ok, `the text parses:\n${text}\n${JSON.stringify(result)}`);
  return result.doc as unknown as Doc;
}

function errors(text: string) {
  const result = parseRuleText(text);
  assert.equal(result.ok, false, `the text is refused:\n${text}`);
  return result.ok ? [] : result.errors;
}

/** The kinds of a document's targets, as `checkFlow` takes them. */
function kindsOf(doc: { targets: readonly { targetId: string; version: number; kind: string }[] }) {
  return Object.fromEntries(doc.targets.map((target) => [`${target.targetId}@${target.version}`, target.kind]));
}

const HEAD = [
  'workflow client-asks, version 5',
  '',
  'when a Slack message is posted in acme/slack, in conversation C0123',
  'match text exists',
  '',
];
const TAIL = ['', 'keep text', 'at most 60 an hour', ''];
const workflow = (...flow: string[]) => [...HEAD, ...flow, ...TAIL].join('\n');

test('the owner example parses to its JSON and prints back to its text, byte for byte', () => {
  const doc = parsed(read('owner-example.txt'));
  assert.deepEqual(doc, readJson('owner-example.json'));
  assert.equal(printRuleText(doc), read('owner-example.txt'));
  assert.equal(checkFlow(doc.flow, kindsOf(doc as never)).ok, true);
});

for (const name of ['split', 'chained', 'raise-fields', 'straight-with-events', 'thread'])
  test(`the ${name} flow parses to its JSON, prints back to its text, and checkFlow accepts it`, () => {
    const doc = parsed(read(`${name}.txt`));
    assert.deepStrictEqual(doc, readJson(`${name}.json`));
    assert.equal(printRuleText(readJson(`${name}.json`)), read(`${name}.txt`));
    const checked = checkFlow(doc.flow, kindsOf(doc as never));
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.deepStrictEqual(checked.flow, doc.flow, 'the fixture is the canonical flow');
  });

test('a straight line needs no arrows, and -> reads as →', () => {
  const text = workflow(
    'flow',
    '  step note: tell me "first"',
    '  step log: dry run client-log, version 1',
    '  step tell: tell me "last"',
  );
  const doc = parsed(text);
  assert.deepEqual(doc.flow.steps.note?.next, { otherwise: 'log' }, 'a step goes on to the next one written');
  assert.deepEqual(doc.flow.steps.log?.next, { otherwise: 'tell' });
  assert.deepEqual(doc.flow.steps.tell?.next, {}, 'the last step goes nowhere else');
  assert.equal(doc.flow.start, 'note', 'the first step written is where the flow starts');
  assert.deepEqual(doc.targets, [{ targetId: 'client-log', version: 1, kind: 'dry-run' }]);
  assert.equal(printRuleText(doc), text, 'the printer writes no arrow it can leave out');
  const arrows = (arrow: string) =>
    workflow(
      'flow',
      '  step find: find a session in lane triage, with claude-code',
      `    idle ${arrow} tell`,
      `    otherwise ${arrow} end`,
      '  step tell: tell me "found one"',
    );
  assert.deepEqual(parsed(arrows('->')), parsed(arrows('→')));
  assert.deepEqual(parsed(arrows('->')).flow.steps.find?.next, { idle: 'tell', otherwise: 'end' });
});

test('a step that writes arrows but no otherwise still goes on to the next step; then stop says it goes nowhere', () => {
  const doc = parsed(
    workflow(
      'flow',
      '  step check: if fields.text contains "urgent"',
      '    no → end',
      '  step tell: tell me "urgent"',
      '    then stop',
      '  step log: dry run client-log, version 1',
    ),
  );
  assert.deepEqual(doc.flow.steps.check?.next, { no: 'end', otherwise: 'tell' });
  assert.deepEqual(doc.flow.steps.tell?.next, {}, 'then stop: no otherwise');
  const printed = printRuleText({
    ...doc,
    flow: {
      ...doc.flow,
      start: 'check',
      steps: {
        check: { ...doc.flow.steps.check, next: { yes: 'tell', no: 'log' } },
        tell: { kind: 'notify', text: 'urgent', next: {} },
        log: { ...doc.flow.steps.log, next: {} },
      },
    },
  } as JsonObject);
  assert.match(
    printed,
    /\n {2}step check: if fields\.text contains "urgent"\n {4}yes → tell\n {4}no → log\n {4}otherwise stop\n/,
  );
  assert.match(printed, /\n {2}step tell: tell me "urgent"\n {4}then stop\n {2}step log: /);
  assert.deepEqual(parsed(printed).flow.steps.check?.next, { yes: 'tell', no: 'log' });
});

test('workflow and rule headers parse to one document; the printer writes workflow', () => {
  const text = read('owner-example.txt');
  assert.ok(text.startsWith('workflow client-asks, version 5\n'));
  const asRule = text.replace(/^workflow /u, 'rule ');
  assert.deepEqual(parsed(asRule), parsed(text));
  assert.equal(printRuleText(parsed(asRule)), text);
  const straight = parsed(
    [
      'rule invoices, version 1',
      'when a new message arrives in cue/gmail, in the inbox',
      'match subject exists',
      'then',
      '  dry run log, version 1',
    ].join('\n'),
  );
  assert.match(printRuleText(straight), /^workflow invoices, version 1\n/u);
  assert.equal(Object.hasOwn(straight, 'flow'), false, 'a workflow without a flow stays the straight line it is');
  assert.match(errors(`${text}rule client-asks, version 5\n`).at(0)?.message ?? '', /names it once/);
});

test('emits, events in … as …, raise and on raised … within parse to emit, flow.events, raise and flow.on', () => {
  const doc = parsed(
    workflow(
      'flow, at most 6 runs an hour, 3 at a time, 1 session an hour, 4 worktrees a day, 20 Linear writes an hour, 300 events an hour, each run up to 2 days, in shadow',
      '  events in acme as client-asks, run emits finished and failed',
      '  on raised acme.client-asks.issue.created and acme.client-asks.*.failed, within 3 hours',
      '  step found: raise project-found',
      '    fields text, author.name',
      '    label "Project found"',
      '  step tell: tell me "found"',
      '    emits notified',
    ),
  );
  assert.deepEqual(doc.flow.events, { namespace: 'acme', workflow: 'client-asks', run: ['finished', 'failed'] });
  assert.deepEqual(doc.flow.on, {
    raised: ['acme.client-asks.issue.created', 'acme.client-asks.*.failed'],
    withinMs: 3 * 3_600_000,
  });
  assert.deepEqual(doc.flow.limits, {
    runsPerHour: 6,
    concurrentRuns: 3,
    sessionsPerHour: 1,
    worktreesPerDay: 4,
    linearWritesPerHour: 20,
    eventsPerHour: 300,
    runMs: 2 * 86_400_000,
  });
  assert.equal(doc.flow.shadow, true);
  assert.deepEqual(doc.flow.steps.found, {
    kind: 'raise',
    name: 'project-found',
    fields: ['/text', '/author/name'],
    label: 'Project found',
    next: { otherwise: 'tell' },
  });
  assert.deepEqual(doc.flow.steps.tell?.emit, ['notified']);
  const defaults = parsed(workflow('flow', '  on raised acme.client-asks.issue.created', '  step tell: tell me "x"'));
  assert.deepEqual(
    defaults.flow.on,
    { raised: ['acme.client-asks.issue.created'], withinMs: 86_400_000 },
    'within 1 day',
  );
  assert.deepEqual(defaults.flow.limits, {
    runsPerHour: 10,
    concurrentRuns: 2,
    sessionsPerHour: 2,
    worktreesPerDay: 5,
    linearWritesPerHour: 30,
    eventsPerHour: 120,
    runMs: 259_200_000,
  });
  const canonical = checkFlow(doc.flow, {});
  assert.ok(canonical.ok, JSON.stringify(canonical));
  const again = printRuleText({ ...doc, flow: canonical.flow } as unknown as JsonObject);
  assert.match(
    again,
    /^flow, at most 6 runs an hour, 3 at a time, 1 session an hour, 4 worktrees a day, 20 Linear writes an hour, 300 events an hour, each run up to 2 days, in shadow$/m,
  );
  assert.match(again, /^ {2}events in acme as client-asks, run emits failed and finished$/m);
  assert.match(
    again,
    /^ {2}on raised acme\.client-asks\.\*\.failed and acme\.client-asks\.issue\.created, within 3 hours$/m,
  );
});

test('a give part `from step issue identifier` parses to { step: "issue", field: "identifier" }', () => {
  const doc = parsed(
    workflow(
      'flow',
      '  step find: find a session in lane triage, with claude-code',
      '  step give: session client-prompt, version 2, with claude-code, to find',
      '    give',
      '      fields text',
      '      from step issue identifier',
    ),
  );
  assert.deepEqual((doc.targets as JsonObject[])[0]?.context, [
    { fields: ['/text'] },
    { step: 'issue', field: 'identifier' },
  ]);
  assert.deepEqual(doc.flow.steps.give?.to, { session: ['find'] });
  assert.match(printRuleText(doc), /\n {6}from step issue identifier\n/);
});

test('find the session that took this conversation, with claude-code parses to in { thread: true } and prints back', () => {
  const text = workflow(
    'flow',
    '  step thread: find the session that took this conversation, with claude-code',
    '    idle → tell',
    '    otherwise → end',
    '  step tell: tell me "it has a session"',
  );
  const doc = parsed(text);
  assert.deepEqual(doc.flow.steps.thread, {
    kind: 'find-session',
    in: { thread: true },
    provider: 'claude',
    next: { idle: 'tell', otherwise: 'end' },
  });
  assert.equal(printRuleText(doc), text);
  const thread = parsed(read('thread.txt'));
  assert.deepEqual(thread.flow.steps.thread?.in, { thread: true });
  assert.equal(thread.flow.steps.thread?.next && (thread.flow.steps.thread.next as JsonObject).none, 'route');
  assert.deepEqual(thread.flow.steps.find?.in, { project: 'route' }, "then the project's find, on none");
  const idle = workflow('flow', '  step thread: find the idle session that took this conversation, with claude-code');
  assert.deepEqual(parsed(idle).flow.steps.thread?.only, 'idle');
  assert.equal(printRuleText(parsed(idle)), idle);
});

test('flow and then together are refused at the second', () => {
  const flowFirst = workflow('flow', '  step tell: tell me "x"', 'then', '  dry run log, version 1');
  const [atThen] = errors(flowFirst);
  assert.match(atThen?.message ?? '', /flow/);
  assert.equal(atThen?.line, 8);
  const thenFirst = workflow('then', '  dry run log, version 1', 'flow', '  step tell: tell me "x"');
  const [atFlow] = errors(thenFirst);
  assert.match(atFlow?.message ?? '', /flow/);
  assert.equal(atFlow?.line, 8);
});

test('an unknown step phrase names the closest one', () => {
  assert.match(
    errors(workflow('flow', '  step x: fnd a session in lane a, with claude-code')).at(0)?.message ?? '',
    /did you mean "find a session"/,
  );
  assert.match(errors(workflow('flow', '  step x: tel me "x"')).at(0)?.message ?? '', /did you mean "tell me"/);
  const [outcome] = errors(workflow('flow', '  step x: tell me "x"', '    snet → end'));
  assert.match(
    outcome?.message ?? '',
    /snet is not an outcome of a tell me step: it has sent, and otherwise; did you mean "sent"\?/,
  );
  assert.equal(outcome?.line, 8);
  const [step] = errors(workflow('flow', '  stp x: tell me "x"'));
  assert.match(step?.message ?? '', /did you mean "step"/);
  assert.match(errors(workflow('flow')).at(0)?.message ?? '', /a flow needs its steps/);
  const [twice] = errors(workflow('flow', '  step x: tell me "a"', '  step x: tell me "b"'));
  assert.match(twice?.message ?? '', /a flow has one step x; it is already on line 7/);
});

test('every kind of step has its phrase, and each prints back as it was written', () => {
  const text = [
    ...HEAD,
    'flow',
    '  events in acme as client-asks',
    '  step check: if any',
    '    fields.text contains "change"',
    '    steps.route.project is "acme-site"',
    '    no → end',
    '  step judge: ask jev, version 2, via typesafe',
    '    question "Is it urgent?"',
    '    looking at fields.text',
    '    yes at 0.7, if unsure drop',
    '    yes → route',
    '    otherwise → end',
    '  step route: choose a project among acme-site, by jev version 2',
    '    looking at text',
    '    project acme-site, id acme, in /example/home/work/acme and /example/home/work/acme-api, worktrees in /example/home/work/acme-wt',
    '    asking',
    '      question "Is this message about this project?"',
    '    emits matched',
    '  step tree: make a worktree of route\'s project, branch "ac/{{run}}", from main, removed if clean',
    '  step start: start a session in tree, with codex, mode plan',
    '  step both: split into give and pause',
    '  step give: deliver client-prompt, version 2, to start',
    '    report done',
    '    then stop',
    '  step pause: wait for 10 minutes, up to 1 hour',
    '',
    'keep text',
    'at most 60 an hour',
    '',
    'raw /targets = []',
    '',
  ].join('\n');
  const doc = parsed(text);
  assert.deepEqual(doc.flow.steps.tree, {
    kind: 'worktree',
    project: 'route',
    branch: 'ac/{{run}}',
    base: { branch: 'main' },
    cleanup: 'remove-if-clean',
    next: { otherwise: 'start' },
  });
  assert.deepEqual(doc.flow.steps.start, {
    kind: 'start-session',
    in: { worktree: 'tree' },
    provider: 'codex',
    mode: 'plan',
    next: { otherwise: 'both' },
  });
  assert.deepEqual(doc.flow.steps.both, { kind: 'split', branches: ['give', 'pause'] });
  assert.deepEqual(doc.flow.steps.give, {
    kind: 'deliver',
    target: { targetId: 'client-prompt', version: 2 },
    to: { session: ['start'] },
    report: ['done'],
    next: {},
  });
  assert.deepEqual(doc.flow.steps.pause, {
    kind: 'wait',
    for: { time: { afterMs: 600_000 } },
    timeoutMs: 3_600_000,
    next: {},
  });
  assert.deepEqual((doc.flow.steps.route?.candidates as JsonObject[] | undefined)?.[0], {
    projectId: 'acme',
    name: 'acme-site',
    folders: ['/example/home/work/acme', '/example/home/work/acme-api'],
    worktreeRoot: '/example/home/work/acme-wt',
  });
  assert.deepEqual(doc.flow.steps.route?.by, ['judge']);
  assert.deepEqual(doc.targets, [], 'a step that names its target by id leaves the targets to raw /targets');
  assert.equal(printRuleText(doc), text);
});

test('a target the words cannot say on its step names every target by id, and raw /targets gives them', () => {
  const owner = readJson('owner-example.json') as unknown as Doc & { targets: JsonObject[] };
  const odd = { ...owner, targets: [...owner.targets, { targetId: 'unused', version: 1, kind: 'dry-run' }] };
  const text = printRuleText(odd as unknown as JsonObject);
  assert.match(text, /\n {2}step issue: deliver client-issues, version 1\n/);
  assert.match(
    text,
    /\n {2}step give: deliver client-prompt, version 2, to find, another or start\n {4}report done and needs-the-person\n/,
  );
  assert.match(text, /\nraw \/targets = \[/);
  assert.deepStrictEqual(parseRuleText(text).ok && parseRuleText(text), { ok: true, doc: odd });
  const mixed = read('owner-example.txt').replace(
    /step issue: linear issue client-issues, version 1, in team ACME, assigned to me\n( {4}.*\n)+?( {4}emits created)/u,
    'step issue: deliver client-issues, version 1\n$2',
  );
  assert.match(mixed, /step issue: deliver client-issues, version 1\n {4}emits created\n/);
  assert.match(errors(mixed).at(0)?.message ?? '', /names its target by id, while other steps write theirs in full/);
});

test('a step the words cannot say is raw JSON in its place, and a flow they cannot say at all is raw /flow', () => {
  const owner = readJson('owner-example.json') as unknown as Doc;
  const steps = { ...owner.flow.steps, tell: { ...owner.flow.steps.tell, colour: 'red' } };
  const text = printRuleText({ ...owner, flow: { ...owner.flow, steps } } as unknown as JsonObject);
  assert.match(text, /\n {2}step tell: raw \{"colour":"red","kind":"notify","next":\{\},"text":"A message for/);
  assert.deepStrictEqual(parsed(text).flow.steps.tell, steps.tell);
  const unsayable = { ...owner, flow: { ...owner.flow, start: 'nowhere' } };
  const raw = printRuleText(unsayable as unknown as JsonObject);
  assert.match(raw, /\nthen\n {2}linear issue client-issues, version 1/);
  assert.match(raw, /\nraw \/flow = \{/);
  assert.deepStrictEqual(parsed(raw), unsayable);
});
