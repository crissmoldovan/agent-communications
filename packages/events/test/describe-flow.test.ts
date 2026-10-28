import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type DescribableRuleDocument,
  describeFlow,
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  type FlowDocumentV1,
  type FlowLimits,
  type FlowLine,
  type RulePart,
} from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * A workflow's approval lists its effects as numbered lines (workflows design §10.2, W6): one per step that does
 * something, in `stepOrder`, each saying when it happens; the steps that only decide or wait are named in the "If …" of
 * the lines they lead to.
 */

type FlowRule = DescribableRuleDocument & { flow: FlowDocumentV1 };

const fixture = (name: string): FlowRule =>
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'flows', `${name}.json`), 'utf8')) as FlowRule;

const owner = fixture('owner-example');
const text = (line: FlowLine | undefined) => (line?.parts ?? []).map((part: RulePart) => part.text).join('');
const line = (rule: FlowRule, stepId: string) => describeFlow(rule).find((each) => each.stepIds[0] === stepId);

test('one line per step that does something, in stepOrder, numbered from 1', () => {
  const lines = describeFlow(owner);
  assert.deepEqual(
    lines.filter((each) => each.stepIds.length > 0).map((each) => each.stepIds[0]),
    ['route', 'found', 'issue', 'tree', 'start', 'give', 'note', 'tell'],
  );
  assert.deepEqual(
    lines.map((each) => each.number),
    lines.map((_, index) => index + 1),
  );
  const named = new Set(lines.flatMap((each) => each.stepIds));
  assert.deepEqual(
    Object.keys(owner.flow.steps).filter((id) => !named.has(id)),
    [],
    'no step is left out: the find and wait steps are named in the lines they lead to',
  );
  assert.deepEqual(line(owner, 'give')?.stepIds, ['give', 'find', 'free', 'another', 'start']);
  assert.match(
    text(lines.at(-2)),
    /^When a run fails or finishes, it raises acme\.client-asks\.run\.failed or acme\.client-asks\.run\.finished/,
  );
  assert.deepEqual(lines.at(-2)?.stepIds, []);
});

/*
 * 0.37.0 §6: the approval's lines name the limits (§10.2). The last line says every one of `flow.limits` as written,
 * defaults too, in a fixed order, and its number follows the effects'.
 */

const limited = (limits: FlowLimits): FlowRule => ({ ...owner, flow: { ...owner.flow, limits } });

test("§6: the owner example's approval ends with its limits line, exactly", () => {
  const lines = describeFlow(owner);
  const last = lines.at(-1);
  assert.equal(
    text(last),
    'At most 6 runs an hour, 2 at a time; at most 2 sessions started, 30 Linear writes and 120 events an hour; at most 5 worktrees a day; a run ends after 3 days.',
  );
  assert.deepEqual(last?.stepIds, [], 'the line is about the whole workflow, not a step');
  assert.equal(last?.number, lines.length, 'its number follows the effects');
  assert.ok(
    last?.parts.every((part) => part.kind === 'plain'),
    'a limit is a number the check bounds, never author text',
  );
});

test("§6: every limit's word and value appear, defaults too", () => {
  const said = text(describeFlow(limited({ ...FLOW_LIMIT_DEFAULTS })).at(-1));
  assert.equal(
    said,
    'At most 10 runs an hour, 2 at a time; at most 2 sessions started, 30 Linear writes and 120 events an hour; at most 5 worktrees a day; a run ends after 3 days.',
  );
  // Each limit, by its own words, in the fixed order: none is left out because it is the default.
  const words: Record<keyof FlowLimits, string> = {
    runsPerHour: `${FLOW_LIMIT_DEFAULTS.runsPerHour} runs an hour`,
    concurrentRuns: `${FLOW_LIMIT_DEFAULTS.concurrentRuns} at a time`,
    sessionsPerHour: `${FLOW_LIMIT_DEFAULTS.sessionsPerHour} sessions started`,
    linearWritesPerHour: `${FLOW_LIMIT_DEFAULTS.linearWritesPerHour} Linear writes`,
    eventsPerHour: `${FLOW_LIMIT_DEFAULTS.eventsPerHour} events an hour`,
    worktreesPerDay: `${FLOW_LIMIT_DEFAULTS.worktreesPerDay} worktrees a day`,
    runMs: 'a run ends after 3 days',
  };
  assert.deepEqual(Object.keys(words).sort(), Object.keys(FLOW_LIMIT_DEFAULTS).sort(), 'every limit has its words');
  const at = Object.values(words).map((each) => said.indexOf(each));
  assert.ok(
    at.every((index) => index >= 0),
    `each limit is named: ${JSON.stringify(words)}`,
  );
  assert.deepEqual(
    at,
    [...at].sort((left, right) => left - right),
    'in a fixed order',
  );
  // A straight line drawn as a flow has the defaults, and says them too.
  assert.equal(text(describeFlow(fixture('straight-with-events')).at(-1)), said);
});

test('§6: a flow with a non-default limit names its value', () => {
  assert.equal(
    text(
      describeFlow(
        limited({
          runsPerHour: 1,
          concurrentRuns: 1,
          sessionsPerHour: 1,
          worktreesPerDay: 1,
          linearWritesPerHour: 1,
          eventsPerHour: 1,
          runMs: 86_400_000,
        }),
      ).at(-1),
    ),
    'At most 1 run an hour, 1 at a time; at most 1 session started, 1 Linear write and 1 event an hour; at most 1 worktree a day; a run ends after 1 day.',
  );
  assert.equal(
    text(describeFlow(limited({ ...FLOW_LIMIT_CEILINGS })).at(-1)),
    'At most 60 runs an hour, 8 at a time; at most 10 sessions started, 120 Linear writes and 600 events an hour; at most 20 worktrees a day; a run ends after 30 days.',
  );
  assert.equal(
    text(describeFlow(limited({ ...FLOW_LIMIT_DEFAULTS, runMs: 90 * 60_000, eventsPerHour: 240 })).at(-1)),
    'At most 10 runs an hour, 2 at a time; at most 2 sessions started, 30 Linear writes and 240 events an hour; at most 5 worktrees a day; a run ends after 90 minutes.',
  );
  // The chained example's own: 4 runs an hour, 1 at a time.
  assert.match(text(describeFlow(fixture('chained')).at(-1)), /^At most 4 runs an hour, 1 at a time; /u);
});

test('a start line names its folder, provider and mode in words', () => {
  // The find before it has no line of its own, so its "If …" names where it looked, never "there".
  assert.equal(
    text(line(owner, 'start')),
    'If no session is idle in the project route chose, start a Claude Code session in the worktree tree made that asks before it acts.',
  );
  const steps = { ...owner.flow.steps, start: { ...owner.flow.steps.start, in: { project: 'route' }, mode: 'plan' } };
  const inProject = text(line({ ...owner, flow: { ...owner.flow, steps } as FlowDocumentV1 }, 'start'));
  assert.match(
    inProject,
    /start a Claude Code session in the project route chose \(\/example\/home\/work\/acme-site or \/example\/home\/work\/billing\) that only plans, and changes nothing\.$/,
  );
});

test("a worktree line names its root, branch template and that git runs without the repository's hooks", () => {
  const tree = line(owner, 'tree');
  assert.match(text(tree), /in \/example\/home\/work\/acme-site-wt or \/example\/home\/work\/billing-wt/);
  assert.match(text(tree), /on a branch named 'ac\/\{\{steps\.issue\.identifier\}\}'/);
  assert.match(text(tree), /by running git as you, without the repository's hooks, and keep it\.$/);
  assert.ok(tree?.parts.some((part) => part.kind === 'untrusted' && part.text === 'ac/{{steps.issue.identifier}}'));
});

test('an emitting step lists each event by name and says nothing a sender wrote', () => {
  assert.match(text(line(owner, 'issue')), /raises acme\.client-asks\.issue\.created, .*nothing a sender wrote/);
  assert.match(
    text(line(owner, 'issue')),
    /^If a project is chosen, or it is unsure which project, create an issue in Linear, team ACME, titled '\{\{author\.name\}\} asks about \{\{steps\.route\.project\}\}', assigned to you\. It raises acme\.client-asks\.issue\.created, with the delivery's id and the issue's id, identifier and link: nothing a sender wrote, to subscribers given acme and to workflows that start on it\.$/,
  );
  assert.ok(
    line(owner, 'issue')?.parts.some((part) => part.kind === 'value' && part.text === 'acme.client-asks.issue.created'),
  );
});

test('a Raise with fields says only to subscribers allowed what senders write, inside the envelope', () => {
  const raised = fixture('raise-fields');
  const said = text(line(raised, 'asked'));
  assert.match(said, /raise acme\.client-asked\.asked\.client-asked, to subscribers given acme/i);
  assert.match(
    said,
    /what senders wrote in the text and the author's name goes with it only to subscribers allowed what senders write, inside the envelope\.$/,
  );
  assert.match(text(line(owner, 'found')), /raise acme\.client-asks\.found\.project-found: nothing a sender wrote/);
});

test('a chained workflow names its patterns and how long it keeps each message', () => {
  const [first] = describeFlow(fixture('chained'));
  assert.deepEqual(first?.stepIds, []);
  assert.equal(
    text(first),
    'It starts only when client-asks raises acme.client-asks.issue.created or acme.client-asks.run.failed about the same message, and keeps what it needs of each message for up to 2 hours in case it does.',
  );
});

test('an outcome with no arrow reads "If none, it stops"', () => {
  const steps = {
    ...owner.flow.steps,
    route: { ...owner.flow.steps.route, next: { chosen: 'found', unsure: 'found' } },
  };
  const said = text(line({ ...owner, flow: { ...owner.flow, steps } as FlowDocumentV1 }, 'route'));
  assert.match(said, / If none, it stops\.$/);
  const split = describeFlow(fixture('split'));
  assert.equal(
    text(split.find((each) => each.stepIds[0] === 'log')),
    'Record it in the Dry-run log. If it fails, it stops.',
  );
});

test('a find in this conversation reads "If a session already took an earlier message in this conversation, …"', () => {
  const thread = fixture('thread');
  assert.match(text(line(thread, 'give')), /^If a session already took an earlier message in this conversation, /);
  assert.match(
    text(line(thread, 'route')),
    /^If no session took an earlier message in this conversation, choose a project/,
  );
  assert.match(
    text(line(thread, 'thread')),
    /^Look for the session that took an earlier message in this conversation, with Claude Code\. It raises acme\.client-thread\.thread\.found and acme\.client-thread\.thread\.not-found/,
  );
});

test('labels, templates and notify text are untrusted parts', () => {
  assert.ok(line(owner, 'tell')?.parts.some((p) => p.kind === 'untrusted' && p.text.includes('needs you')));
  assert.ok(line(owner, 'issue')?.parts.some((p) => p.kind === 'untrusted' && p.text.includes('{{author.name}}')));
  assert.ok(
    line(owner, 'route')?.parts.some((p) => p.kind === 'untrusted' && p.text === 'Is this message about this project?'),
  );
  const labelled = line(fixture('raise-fields'), 'asked');
  assert.deepEqual(labelled?.parts.slice(0, 2), [
    { text: 'Tell the dashboard', kind: 'untrusted' },
    { text: ': ', kind: 'plain' },
  ]);
  assert.ok(
    line(owner, 'start')?.parts.every((p) => p.kind !== 'untrusted'),
    'a start in a worktree names no folder',
  );
});

test('a step that only decides, and that no effect follows, still has a line of its own', () => {
  const lone: FlowRule = {
    ...owner,
    flow: {
      ...owner.flow,
      start: 'judge',
      steps: {
        judge: {
          kind: 'judge',
          ask:
            owner.flow.steps.route?.kind === 'route' ? (owner.flow.steps.route.judge as never) : (undefined as never),
          next: {},
        },
      },
      events: undefined,
    } as unknown as FlowDocumentV1,
  };
  const lines = describeFlow(lone);
  assert.deepEqual(
    lines.map((each) => each.stepIds),
    [['judge'], []],
    'the judge, then the limits',
  );
  assert.equal(
    text(lines[0]),
    "Ask Jev 'Is this message about this project?', looking at the text. If it says yes, it says no or it is unsure, it stops.",
  );
});

test("a reader's labels name the fields", () => {
  const said = text(
    describeFlow(owner, { fields: { '/text': 'the message text' } }).find((each) => each.stepIds[0] === 'give'),
  );
  assert.match(said, /the message: the message text and the author's name, and the words/);
});
