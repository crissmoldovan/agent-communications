import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { approvalViewForAgent } from '../src/mcp/agent-approval-view.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import { ruleShowForAgent, withRouteFoldersHidden } from '../src/runtime/rule-show.ts';
import { cli, DAVID, type LaneHarness, rule, structured, tool, withLaneOwner } from './support/lane-harness.ts';
import { resultText } from './support/raw-mcp.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.36.0, M3: a route step binds each project's folders and worktree root into the workflow by
 * value (W12), and `events_rule_show` and the approval view returned the stored document whole, so any agent read the
 * folders, which name clients (spec §8.1: an agent never reads the list). Now a call that names an agent — an agent
 * window over MCP, or an agent's shell — gets each candidate's id and name, `folders: []`, `worktreeRoot: null` and
 * `foldersHidden` (the whole entry, its summary too, holds no folder); the person's own view is unchanged.
 */

const ACME_FOLDER = '/example/home/work/acme-site';
const BILLING_FOLDER = '/example/home/work/billing';
const BILLING_TREES = '/example/home/work/billing-trees';
const FOLDERS = [ACME_FOLDER, BILLING_FOLDER, BILLING_TREES];
const WORKFLOW = 'which-project';

const candidates = [
  { projectId: 'acme-site', name: 'acme-site', folders: [ACME_FOLDER], worktreeRoot: null },
  { projectId: 'billing', name: 'billing', folders: [BILLING_FOLDER], worktreeRoot: BILLING_TREES },
];

/** A mail workflow with a Which project? step over two projects, then a worktree and a Raise step. */
function routeWorkflow(): Record<string, unknown> {
  return {
    ...rule(1, []),
    ruleId: WORKFLOW,
    flow: {
      flowVersion: 1,
      limits: {
        runsPerHour: 10,
        concurrentRuns: 2,
        sessionsPerHour: 2,
        worktreesPerDay: 5,
        linearWritesPerHour: 30,
        eventsPerHour: 120,
        runMs: 259_200_000,
      },
      events: { namespace: 'acme', workflow: WORKFLOW },
      start: 'route',
      steps: {
        route: { kind: 'route', by: ['hints'], inputs: [], candidates, next: { otherwise: 'note' } },
        note: { kind: 'raise', name: 'created', next: {} },
      },
    },
  };
}

function hasNoFolder(value: unknown, what: string): void {
  const text = JSON.stringify(value);
  for (const folder of FOLDERS) assert.equal(text.includes(folder), false, `${what} names ${folder}: ${text}`);
  assert.equal(text.includes('-wt'), false, `${what} names a worktree root drawn from a folder: ${text}`);
}

type Candidate = { projectId: string; name: string; folders: string[]; worktreeRoot: string | null };
const candidatesOf = (document: unknown): Candidate[] =>
  (document as { flow: { steps: { route: { candidates: Candidate[] } } } }).flow.steps.route.candidates;

function hidden(document: unknown): void {
  assert.deepEqual(candidatesOf(document), [
    { projectId: 'acme-site', name: 'acme-site', folders: [], worktreeRoot: null, foldersHidden: 1 },
    { projectId: 'billing', name: 'billing', folders: [], worktreeRoot: null, foldersHidden: 1 },
  ]);
}

/** The two projects as the person keeps them, written where the owner reads them, so the workflow may be enabled. */
function addProjects(harness: LaneHarness): void {
  const database = new DatabaseSync(eventPaths(harness.stateDir).database);
  try {
    for (const candidate of candidates) {
      database
        .prepare('INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
        .run(candidate.projectId, candidate.name, `github.com/example/${candidate.projectId}`);
      for (const folder of candidate.folders)
        database
          .prepare("INSERT INTO project_folders (folder, project_id, kind, worktree_root) VALUES (?, ?, 'checkout', ?)")
          .run(folder, candidate.projectId, candidate.worktreeRoot);
    }
  } finally {
    database.close();
  }
}

test('M3: a route candidate keeps its id and name for an agent, and its folders and worktree root are hidden', () => {
  const document = routeWorkflow();
  const shown = withRouteFoldersHidden(document);
  hidden(shown);
  hasNoFolder(shown, 'the agent document');
  assert.deepEqual(candidatesOf(document), candidates, 'the stored document itself is untouched');
  // A workflow with no route step is returned as it is.
  const plain = rule(1, []);
  assert.equal(withRouteFoldersHidden(plain), plain);

  // `rule show`'s entries, as an agent's shell prints them.
  const entries = ruleShowForAgent([{ document, digest: 'digest-1', summary: [] }]) as { document: unknown }[];
  hidden(entries[0]?.document);
  assert.equal(entries[0]?.document === document, false);

  // The approval view an agent gets.
  const view = approvalViewForAgent({
    kind: 'READY',
    approvalId: 'ap-1',
    digest: 'digest-1',
    preview: { documentVersion: 1, kind: 'rule', rule: document },
    challenge: { approvalId: 'ap-1', digest: 'digest-1', challenge: 'secret-challenge', expiresAt: 1 },
  }) as { preview: { rule: unknown } };
  hasNoFolder(view, 'the agent approval view');
  hidden(view.preview.rule);
});

test('M3: events_rule_show and the approval view hide a route step’s folders from an agent, and not from the person', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    await harness.control.request('rule-create', { document: routeWorkflow() });
    const david = await harness.window(DAVID);

    // Over MCP: an agent window.
    const message = await tool(david, 'events_rule_show', { ruleId: WORKFLOW });
    assert.notEqual(message.result?.isError, true, resultText(message));
    const overMcp = JSON.parse(resultText(message)) as { document: unknown }[];
    hasNoFolder(overMcp, 'events_rule_show');
    hidden(overMcp[0]?.document);

    // In an agent's shell.
    const shell = await cli(harness.stateDir, ['rule', 'show', WORKFLOW, '--json'], { CLAUDECODE: '1' });
    assert.equal(shell.code, 0, shell.err);
    hasNoFolder(JSON.parse(shell.out), 'rule show in an agent’s shell');
    hidden((JSON.parse(shell.out) as { document: unknown }[])[0]?.document);

    // The person's own view is unchanged.
    const person = await cli(harness.stateDir, ['rule', 'show', WORKFLOW, '--json']);
    assert.equal(person.code, 0, person.err);
    assert.deepEqual(candidatesOf((JSON.parse(person.out) as { document: unknown }[])[0]?.document), candidates);

    // The approval view, once the projects are the person's and the workflow is enabled.
    addProjects(harness);
    const planned = (await harness.control.request('rule-enable', { ruleId: WORKFLOW, version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const { approvalId } = planned;
    const digest = planned.binding.digest;
    const viewed = structured(await tool(david, 'events_approval_view', { approvalId, digest }));
    hasNoFolder(viewed, 'events_approval_view');
    hidden((viewed.preview as { rule: unknown }).rule);
    const shellView = await cli(harness.stateDir, ['approval', 'view', approvalId, '--digest', digest, '--json'], {
      CLAUDECODE: '1',
    });
    assert.equal(shellView.code, 0, shellView.err);
    hasNoFolder(JSON.parse(shellView.out), 'approval view in an agent’s shell');
    const personView = (await harness.control.request('approvalView', { approvalId, digest })) as {
      preview: { rule: unknown };
    };
    assert.deepEqual(candidatesOf(personView.preview.rule), candidates, 'the person approves the folders themselves');
  });
});
