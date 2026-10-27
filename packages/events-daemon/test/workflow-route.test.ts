import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { FlowStep, RouteCandidate } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import type { ProjectV1 } from '../src/domain/projects.ts';
import { composeProjects } from '../src/runtime/workflow/compose-projects.ts';
import type { JudgeAnswer } from '../src/runtime/workflow/contracts.ts';
import { routeCandidatesCheck } from '../src/runtime/workflow/route-activation.ts';
import { createRouteExecutor, profileHash, routeQuestion } from '../src/runtime/workflow/steps/route.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE, stepContext } from './support/step-context.ts';

/*
 * Which project? (workflows design §6.1, §8.3, W12): the route step's executor over a stand-in step context that
 * records every judge call, and its activation check over a real event database. Every sender value here carries
 * SENTINEL, and none may reach the step's output or a judge's question.
 */

const SENTINEL = 'SENTINEL-sender-words';
const ROUTE = OWNER_EXAMPLE.flow.steps.route as Extract<FlowStep, { kind: 'route' }>;

const project = (candidate: RouteCandidate, overrides: Partial<ProjectV1> = {}): ProjectV1 => ({
  projectId: candidate.projectId,
  name: candidate.name,
  repo: `github.com/example/${candidate.projectId}`,
  profile: `The ${candidate.name} project's own words.`,
  profileBy: 'person',
  profileAt: 1,
  hints: { senderDomains: [], slackConversations: [], people: [] },
  folders: candidate.folders.map((folder) => ({ folder, kind: 'checkout', defaultBranch: 'main', worktreeRoot: null })),
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const [ACME, BILLING] = ROUTE.candidates as [RouteCandidate, RouteCandidate];

/** A mail rule with the owner example's flow, keeping the sender's address. */
const MAIL_RULE = {
  ...OWNER_EXAMPLE,
  event: { type: 'gmail.message.received', version: 1 },
  mapping: { from: { $path: '/from' }, text: { $path: '/snippet' } },
} as unknown as CanonicalFullRuleDocument;

const MAIL_FIELDS = {
  from: { address: 'Kim@Acme.Example', name: `${SENTINEL} Kim` },
  text: `${SENTINEL} please fix the form`,
};
const SLACK_FIELDS = { author: { name: `${SENTINEL} Kim` }, text: `${SENTINEL} please fix the form` };

function executor(projects: readonly ProjectV1[]) {
  const byId = new Map(projects.map((entry) => [entry.projectId, entry]));
  return createRouteExecutor({ project: (projectId) => byId.get(projectId) ?? null });
}

/** A judge that answers per project, by the name in the question. */
function judgeBy(answers: Readonly<Record<string, JudgeAnswer>>) {
  return (_ask: unknown, _inputs: unknown, question?: string): JudgeAnswer => {
    const name = /the project ([a-z0-9-]+)/u.exec(question ?? '')?.[1] ?? '';
    return answers[name] ?? { kind: 'answer', said: 'no', score: 0.1 };
  };
}

function noSentinel(value: unknown): void {
  assert.equal(JSON.stringify(value).includes('SENTINEL'), false, JSON.stringify(value));
}

test('one sender-domain hint chooses with reason hint:sender-domain and calls no judge', async () => {
  const acme = project(ACME, { hints: { senderDomains: ['acme.example'], slackConversations: [], people: [] } });
  const ctx = stepContext({ rule: MAIL_RULE, stepId: 'route', fields: MAIL_FIELDS });
  const result = await executor([acme, project(BILLING)]).run(ctx);
  assert.deepEqual(result, {
    kind: 'settled',
    outcome: 'chosen',
    output: {
      project: 'acme-site',
      projectName: 'acme-site',
      reason: 'hint:sender-domain',
      score: null,
      profileHash: createHash('sha256').update(acme.profile, 'utf8').digest('hex'),
    },
  });
  assert.equal(ctx.judged.length, 0);
  noSentinel(result);
});

test('a Slack conversation hint, and a person hint, each choose on their own', async () => {
  const fields = { ...SLACK_FIELDS, channel: { id: 'C0123' }, author: { name: `${SENTINEL} Kim`, userId: 'U0KIM' } };
  const rule = {
    ...OWNER_EXAMPLE,
    mapping: {
      ...(OWNER_EXAMPLE.mapping as object),
      channel: { id: { $path: '/channel/id' } },
      author: { name: { $path: '/author/name' }, userId: { $path: '/author/userId' } },
    },
  } as unknown as CanonicalFullRuleDocument;
  const byConversation = await executor([
    project(ACME),
    project(BILLING, { hints: { senderDomains: [], slackConversations: ['C0123'], people: [] } }),
  ]).run(stepContext({ rule, stepId: 'route', fields }));
  assert.equal(byConversation.kind === 'settled' && byConversation.output.reason, 'hint:slack-conversation');
  assert.equal(byConversation.kind === 'settled' && byConversation.output.project, 'billing');
  const byPerson = await executor([
    project(ACME, { hints: { senderDomains: [], slackConversations: [], people: ['U0KIM'] } }),
    project(BILLING),
  ]).run(stepContext({ rule, stepId: 'route', fields }));
  assert.equal(byPerson.kind === 'settled' && byPerson.output.reason, 'hint:person');
  assert.equal(byPerson.kind === 'settled' && byPerson.output.project, 'acme-site');
});

test('two hints go to the judge, which chooses the higher yes above the bar', async () => {
  const hinted = { senderDomains: ['acme.example'], slackConversations: [], people: [] };
  const ctx = stepContext({
    rule: MAIL_RULE,
    stepId: 'route',
    fields: MAIL_FIELDS,
    judge: judgeBy({
      'acme-site': { kind: 'answer', said: 'yes', score: 0.92 },
      billing: { kind: 'answer', said: 'yes', score: 0.74 },
    }),
  });
  const result = await executor([project(ACME, { hints: hinted }), project(BILLING, { hints: hinted })]).run(ctx);
  assert.equal(result.kind, 'settled');
  assert.equal(result.kind === 'settled' && result.outcome, 'chosen');
  assert.deepEqual(result.kind === 'settled' && [result.output.project, result.output.reason, result.output.score], [
    'acme-site',
    'judge',
    0.92,
  ]);
  assert.deepEqual(
    ctx.judged.map((call) => call.question),
    [
      routeQuestion('acme-site', "The acme-site project's own words."),
      routeQuestion('billing', "The billing project's own words."),
    ],
  );
  // Only the step's inputs reach the judge, and only through them does a sender's text.
  for (const call of ctx.judged) {
    assert.deepEqual(Object.keys(call.inputs), ['/text']);
    assert.equal(call.ask, ROUTE.judge);
    noSentinel(call.question);
  }
  assert.ok(ctx.fenced.count >= 1, 'the version is fenced again before anything reaches the judge');
  noSentinel(result);
});

test('two yeses within 0.05 are unsure', async () => {
  const ctx = stepContext({
    stepId: 'route',
    fields: SLACK_FIELDS,
    judge: judgeBy({
      'acme-site': { kind: 'answer', said: 'yes', score: 0.9 },
      billing: { kind: 'answer', said: 'yes', score: 0.85 },
    }),
  });
  const result = await executor([project(ACME), project(BILLING)]).run(ctx);
  assert.deepEqual(result, {
    kind: 'settled',
    outcome: 'unsure',
    output: { project: null, projectName: null, reason: 'judge', score: 0.9, profileHash: null },
  });
});

test('no yes is none; a judge that is unsure, or fails, is unsure; one that waits holds the step', async () => {
  const none = await executor([project(ACME), project(BILLING)]).run(
    stepContext({ stepId: 'route', fields: SLACK_FIELDS, judge: judgeBy({}) }),
  );
  assert.deepEqual(none, {
    kind: 'settled',
    outcome: 'none',
    output: { project: null, projectName: null, reason: 'judge', score: 0.1, profileHash: null },
  });
  const unsure = await executor([project(ACME), project(BILLING)]).run(
    stepContext({
      stepId: 'route',
      fields: SLACK_FIELDS,
      judge: judgeBy({ billing: { kind: 'answer', said: 'unsure', score: 0.6 } }),
    }),
  );
  assert.equal(unsure.kind === 'settled' && unsure.outcome, 'unsure');
  const failed = await executor([project(ACME), project(BILLING)]).run(
    stepContext({ stepId: 'route', fields: SLACK_FIELDS, judge: () => ({ kind: 'failed', code: 'JUDGE_TIMEOUT' }) }),
  );
  assert.equal(failed.kind === 'settled' && failed.outcome, 'unsure', 'a judge failure is never yes');
  const waiting = await executor([project(ACME), project(BILLING)]).run(
    stepContext({ stepId: 'route', fields: SLACK_FIELDS, judge: () => ({ kind: 'wait', until: 1_793_000_600_000 }) }),
  );
  assert.deepEqual(waiting, { kind: 'wait', wait: 'limit', key: null, wakeAt: 1_793_000_600_000 });
});

test('at most 8 judge calls', async () => {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    projectId: `project-${index}`,
    name: `project-${index}`,
    folders: [`/example/home/work/project-${index}`],
    worktreeRoot: null,
  }));
  const step = { ...ROUTE, by: ['judge'], candidates } as unknown as FlowStep;
  const ctx = stepContext({ stepId: 'route', step, fields: SLACK_FIELDS, judge: judgeBy({}) });
  await executor(candidates.map((candidate) => project(candidate))).run(ctx);
  assert.equal(ctx.judged.length, 8);
});

test('a candidate whose approved folders no longer match takes none with PROJECT_CHANGED', async () => {
  const moved = project(ACME, {
    hints: { senderDomains: ['acme.example'], slackConversations: [], people: [] },
    folders: [
      { folder: '/example/home/work/acme-site', kind: 'checkout', defaultBranch: 'main', worktreeRoot: null },
      { folder: '/example/home/work/acme-site-2', kind: 'checkout', defaultBranch: 'main', worktreeRoot: null },
    ],
  });
  const result = await executor([moved, project(BILLING)]).run(
    stepContext({ rule: MAIL_RULE, stepId: 'route', fields: MAIL_FIELDS }),
  );
  assert.deepEqual(result, {
    kind: 'settled',
    outcome: 'none',
    output: { project: null, projectName: null, reason: 'PROJECT_CHANGED', score: null, profileHash: null },
  });
  const gone = await executor([project(BILLING)]).run(
    stepContext({
      stepId: 'route',
      fields: SLACK_FIELDS,
      judge: judgeBy({ 'acme-site': { kind: 'answer', said: 'yes', score: 0.95 } }),
    }),
  );
  assert.equal(gone.kind === 'settled' && gone.output.reason, 'PROJECT_CHANGED');
});

test('activation refuses candidates that differ from the projects as they are now', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-route-activation-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    for (const candidate of [ACME, BILLING]) {
      db.prepare('INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(
        candidate.projectId,
        candidate.name,
        `github.com/example/${candidate.projectId}`,
      );
      for (const folder of candidate.folders)
        db.prepare("INSERT INTO project_folders (folder, project_id, kind) VALUES (?, ?, 'checkout')").run(
          folder,
          candidate.projectId,
        );
    }
    assert.doesNotThrow(() => routeCandidatesCheck(OWNER_EXAMPLE, db));
    const refused = (pattern: RegExp) => (error: unknown) =>
      error instanceof EventDomainError && error.code === 'PROJECT_CHANGED' && pattern.test(error.message);
    db.prepare(
      "UPDATE project_folders SET worktree_root = '/example/home/work/billing-trees' WHERE project_id = 'billing'",
    ).run();
    assert.throws(() => routeCandidatesCheck(OWNER_EXAMPLE, db), refused(/billing's folders or worktree root/u));
    db.prepare('UPDATE project_folders SET worktree_root = NULL').run();
    db.prepare(
      "INSERT INTO project_folders (folder, project_id, kind) VALUES ('/example/home/work/billing-2', 'billing', 'worktree')",
    ).run();
    assert.throws(() => routeCandidatesCheck(OWNER_EXAMPLE, db), refused(/billing's folders/u));
    db.prepare("DELETE FROM projects WHERE id = 'billing'").run();
    db.prepare("DELETE FROM projects WHERE id = 'acme-site'").run();
    assert.throws(
      () => routeCandidatesCheck(OWNER_EXAMPLE, db),
      refused(/acme-site, which is not one of your projects/u),
    );
    // A workflow with no flow has no candidates to check.
    const { flow: _flow, ...straight } = OWNER_EXAMPLE;
    assert.doesNotThrow(() => routeCandidatesCheck(straight as CanonicalFullRuleDocument, db));
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("the output never holds the message's words", async () => {
  const hinted = { senderDomains: ['acme.example'], slackConversations: [], people: [] };
  for (const projects of [
    [project(ACME, { hints: hinted }), project(BILLING)],
    [project(ACME, { hints: hinted }), project(BILLING, { hints: hinted })],
    [project(ACME), project(BILLING)],
  ]) {
    const ctx = stepContext({
      rule: MAIL_RULE,
      stepId: 'route',
      fields: MAIL_FIELDS,
      judge: judgeBy({ billing: { kind: 'answer', said: 'yes', score: 0.88 } }),
    });
    const result = await executor(projects).run(ctx);
    assert.equal(result.kind, 'settled');
    const output = result.kind === 'settled' ? result.output : {};
    assert.equal(JSON.stringify(output).includes('SENTINEL'), false);
    for (const call of ctx.judged) noSentinel(call.question);
  }
});

test("C's composition holds the route executor and the candidates' activation check", {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-compose-projects-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const sessions = {
        relay: async () => assert.fail('no relay'),
        sessionRoots: async () => [],
        deniedFolders: () => [],
      };
      const composition = composeProjects({ store, sessions } as unknown as Parameters<typeof composeProjects>[0]);
      assert.deepEqual(
        composition.executors.map((entry) => entry.kind),
        ['route', 'find-session', 'start-session'],
      );
      assert.deepEqual(composition.activationChecks, [routeCandidatesCheck]);
      assert.equal(profileHash(''), createHash('sha256').update('').digest('hex'));
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
