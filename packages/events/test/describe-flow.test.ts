import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type DescribableRuleDocument,
  describeFlow,
  type FlowDocumentV1,
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
    text(lines.at(-1)),
    /^When a run fails or finishes, it raises acme\.client-asks\.run\.failed or acme\.client-asks\.run\.finished/,
  );
  assert.deepEqual(lines.at(-1)?.stepIds, []);
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
    [['judge']],
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
