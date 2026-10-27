// @vitest-environment node
import { describe, expect, test } from 'vitest';
import { supports } from '../gates.ts';
import {
  readCheck,
  readDescribe,
  readProject,
  readProjects,
  readRunShow,
  readRunsList,
  readScan,
  readSubscribers,
  UnknownShapeError,
} from '../workflows/types.ts';
import { createFakeBridge } from './fake-bridge.ts';
import projectScanFixture from './fixtures/project-scan.v036.json';
import projectsFixture from './fixtures/projects-list.v036.json';
import runShowFixture from './fixtures/run-show.v036.json';
import runsListFixture from './fixtures/runs-list.v036.json';
import subscribersFixture from './fixtures/subscribers-list.v036.json';
import checkFixture from './fixtures/workflow-check.v036.json';
import describeFixture from './fixtures/workflow-describe.v036.json';

/** A copy of `value` with `change` made to it: a reader's fixture, broken in one place. */
function changed<T>(value: T, change: (copy: T) => void): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  change(copy);
  return copy;
}

describe("workflows' results, read (0.36.0, plan I8)", () => {
  test('readRunShow reads a run and refuses an unknown state', () => {
    expect(readRunShow(runShowFixture).steps[0]?.stepId).toBe('route');
    expect(() => readRunShow({ ...runShowFixture, state: 'paused' })).toThrow(UnknownShapeError);
  });

  test("readRunShow keeps the run's version, path, waits and events, and leaves out a field it does not know", () => {
    const run = readRunShow({ ...runShowFixture, somethingNew: 'x' });
    expect(run.ruleVersion).toBe(4);
    expect(run.path).toEqual(['route', 'issue', 'find', 'queue']);
    expect(run.waiting).toEqual({
      stepId: 'queue',
      kind: 'session-idle',
      since: 1_792_915_262_000,
      ahead: 1,
      needsYouInClaudeStream: false,
    });
    expect(run.steps.map((step) => [step.stepId, step.kind, step.state, step.outcome])).toEqual([
      ['route', 'route', 'done', 'chosen'],
      ['issue', 'deliver', 'done', 'done'],
      ['find', 'find-session', 'done', 'busy'],
      ['queue', 'wait', 'waiting', null],
    ]);
    expect(run.steps[3]?.wait).toEqual({ kind: 'session-idle', since: 1_792_915_262_000, wakeAt: 1_793_001_662_000 });
    expect(run.events[0]?.deliveries).toEqual([
      { subscriberId: 'events-dashboard', subscriberVersion: 2, state: 'delivered' },
    ]);
    expect(Object.hasOwn(run, 'somethingNew')).toBe(false);
  });

  test('readRunShow refuses each field it cannot read', () => {
    const broken: ((run: typeof runShowFixture) => void)[] = [
      (run) => Object.assign(run, { runId: 7 }),
      (run) => Object.assign(run, { ruleVersion: '4' }),
      (run) => Object.assign(run, { ruleVersion: -1 }),
      (run) => Object.assign(run, { shadow: 'no' }),
      (run) => Object.assign(run, { path: 'route' }),
      (run) => Object.assign(run, { waiting: { ...run.waiting, kind: 'forever' } }),
      (run) => Object.assign(run.steps[0] ?? {}, { kind: 'loop' }),
      (run) => Object.assign(run.steps[0] ?? {}, { state: 'paused' }),
      (run) => Object.assign(run.steps[0] ?? {}, { output: 'chosen' }),
      (run) => Object.assign(run.steps[0] ?? {}, { attempts: 1.5 }),
      (run) => Object.assign(run.events[0] ?? {}, { state: 'sent' }),
      (run) => Object.assign(run, { steps: undefined }),
    ];
    for (const change of broken) expect(() => readRunShow(changed(runShowFixture, change))).toThrow(UnknownShapeError);
    for (const data of [null, [], 'wfr_0123456789abcdefghjkmnpqrs', 7]) expect(() => readRunShow(data)).toThrow();
  });

  test('readRunsList reads each run, waiting or not, and refuses a run of an unknown state', () => {
    const { runs } = readRunsList(runsListFixture);
    expect(runs.map((run) => [run.runId, run.state, run.waiting?.kind ?? null])).toEqual([
      ['wfr_0123456789abcdefghjkmnpqrs', 'waiting', 'session-idle'],
      ['wfr_zyxwvtsrqpnmkjhgfedcba9876', 'done', null],
    ]);
    expect(runs[0]?.summary).toEqual({ project: 'acme-site', issue: 'ACME-123', session: 'found', turn: null });
    expect(Object.hasOwn(runs[1] ?? {}, 'summary')).toBe(false);
    expect(readRunsList({ runs: [] }).runs).toEqual([]);
    expect(() =>
      readRunsList(
        changed(runsListFixture, (list) => {
          Object.assign(list.runs[0] ?? {}, {
            summary: { project: null, issue: null, session: 'borrowed', turn: null },
          });
        }),
      ),
    ).toThrow(UnknownShapeError);
    expect(() =>
      readRunsList(
        changed(runsListFixture, (list) => {
          Object.assign(list.runs[1] ?? {}, { state: 'paused' });
        }),
      ),
    ).toThrow(UnknownShapeError);
    expect(() => readRunsList(runsListFixture.runs)).toThrow(UnknownShapeError);
  });

  test("readCheck reads a check's problems and refuses one without its code", () => {
    expect(readCheck(checkFixture)).toEqual({
      ok: false,
      problems: [
        {
          code: 'FLOW_CYCLE',
          message: 'The step find leads back to route: a workflow never goes round in a circle.',
          stepId: 'find',
          pointer: '/flow/steps/find/next/busy',
        },
      ],
    });
    expect(readCheck({ ok: true, problems: [] })).toEqual({ ok: true, problems: [] });
    expect(() => readCheck({ ok: 'yes', problems: [] })).toThrow(UnknownShapeError);
    expect(() => readCheck({ ok: false, problems: [{ message: 'no code' }] })).toThrow(UnknownShapeError);
  });

  test('readProjects reads each project, its hints and folders, and refuses a folder of an unknown kind', () => {
    const { projects } = readProjects(projectsFixture);
    expect(projects.map((project) => [project.projectId, project.repo, project.profileBy])).toEqual([
      ['acme-site', 'github.com/example/acme-site', 'person'],
    ]);
    expect(projects[0]?.folders.map((folder) => folder.kind)).toEqual(['checkout', 'worktree']);
    expect(projects[0]?.hints.senderDomains).toEqual(['acme.example']);
    expect(readProject(projectsFixture.projects[0]).name).toBe('acme-site');
    expect(() =>
      readProjects(
        changed(projectsFixture, (list) => {
          Object.assign(list.projects[0]?.folders[0] ?? {}, { kind: 'clone' });
        }),
      ),
    ).toThrow(UnknownShapeError);
    expect(() =>
      readProjects(
        changed(projectsFixture, (list) => {
          Object.assign(list.projects[0] ?? {}, { profileBy: 'agent' });
        }),
      ),
    ).toThrow(UnknownShapeError);
    expect(() => readProject({ projectId: 'acme-site' })).toThrow(UnknownShapeError);
  });

  test('readScan reads the repositories found and the folders passed over, and refuses an unknown reason', () => {
    const scan = readScan(projectScanFixture);
    expect(scan.roots).toEqual(['/example/home/work', '/example/home/code']);
    expect(scan.repos.map((repo) => [repo.repo, repo.known, repo.folders.length])).toEqual([
      ['github.com/example/acme-site', 'acme-site', 1],
      ['github.com/example/billing-tool', null, 2],
    ]);
    expect(scan.skipped.map((skipped) => skipped.reason)).toEqual(['symlink', 'hidden']);
    expect(() =>
      readScan(
        changed(projectScanFixture, (result) => {
          Object.assign(result.skipped[0] ?? {}, { reason: 'too-big' });
        }),
      ),
    ).toThrow(UnknownShapeError);
  });

  test('readSubscribers reads each version, live or webhook, given events or not, and refuses an unknown kind', () => {
    const subscribers = readSubscribers(subscribersFixture);
    expect(subscribers.map((each) => [each.subscriberId, each.kind, each.state, each.listenError])).toEqual([
      ['events-dashboard', 'sse', 'active', null],
      ['crm-hook', 'webhook', 'inert', null],
      ['stream-page', 'sse', null, 'PORT_IN_USE'],
    ]);
    expect(subscribers[0]?.events).toEqual({
      namespaces: ['acme'],
      patterns: ['*.*.*.failed', 'acme.client-asks.*.*'],
      content: 'none',
    });
    expect(subscribers[0]?.listening).toEqual({ host: '127.0.0.1', port: 4801 });
    for (const change of [
      (list: typeof subscribersFixture) => Object.assign(list[0] ?? {}, { kind: 'socket' }),
      (list: typeof subscribersFixture) => Object.assign(list[0] ?? {}, { state: 'on' }),
      (list: typeof subscribersFixture) => Object.assign(list[0] ?? {}, { listenError: 'EACCES' }),
      (list: typeof subscribersFixture) =>
        Object.assign(list[0] ?? {}, { events: { namespaces: ['acme'], patterns: [], content: 'all' } }),
    ]) {
      expect(() => readSubscribers(changed(subscribersFixture, change))).toThrow(UnknownShapeError);
    }
    expect(() => readSubscribers({ subscribers: subscribersFixture })).toThrow(UnknownShapeError);
  });

  test('readDescribe reads the draft, its notes, questions and checks, and refuses an unknown provider', () => {
    const described = readDescribe(describeFixture);
    expect(described.notes).toEqual([{ step: 'route', words: 'find their project' }]);
    expect(described.unnoted).toEqual(['issue']);
    expect(described.questions[0]?.choices).toEqual(['CUE', 'ACME']);
    expect(described.check).toEqual({ ok: true, problems: [] });
    expect(described.model).toEqual({ provider: 'claude-cli', model: null });
    expect(readDescribe({ ...describeFixture, check: null }).check).toBeNull();
    expect(() => readDescribe({ ...describeFixture, model: { provider: 'gpt', model: null } })).toThrow(
      UnknownShapeError,
    );
    expect(() =>
      readDescribe({ ...describeFixture, parse: { ok: false, errors: [{ line: 1, message: 'no column' }] } }),
    ).toThrow(UnknownShapeError);
  });

  test('workflows needs 0.36.0', () => {
    expect(supports('0.35.0', 'workflows')).toBe(false);
    expect(supports('0.36.0', 'workflows')).toBe(true);
  });

  test('the fake bridge answers each workflow call with a shape the readers know', async () => {
    const bridge = createFakeBridge();
    const data = async (call: Parameters<typeof bridge.cli>[0]) => {
      const result = await bridge.cli(call);
      if (result.status !== 'ok') throw new Error(`${call.kind}: ${result.status}`);
      return result.data;
    };
    const runId = 'wfr_0123456789abcdefghjkmnpqrs';
    expect(readRunsList(await data({ kind: 'eventsRunsList' })).runs).toHaveLength(2);
    expect(readRunsList(await data({ kind: 'eventsRunsList', state: 'done' })).runs.map((run) => run.state)).toEqual([
      'done',
    ]);
    expect(readRunShow(await data({ kind: 'eventsRunShow', runId })).runId).toBe(runId);
    expect(await data({ kind: 'eventsRunCancel', runId, interrupt: true })).toMatchObject({
      runId,
      state: 'cancelled',
      interrupted: true,
    });
    expect(readCheck(await data({ kind: 'eventsRuleCheck', document: { ruleId: 'client-asks', version: 4 } })).ok).toBe(
      true,
    );
    expect(readProjects(await data({ kind: 'eventsProjectsList' })).projects).toHaveLength(1);
    expect(readProject(await data({ kind: 'eventsProjectShow', projectId: 'acme-site' })).projectId).toBe('acme-site');
    expect(readScan(await data({ kind: 'eventsProjectScan', roots: [] })).repos).toHaveLength(2);
    expect(readSubscribers(await data({ kind: 'eventsSubscribersList' }))).toHaveLength(3);
    expect(
      readDescribe(
        await data({ kind: 'eventsWorkflowDescribe', request: { words: 'Open an issue.' }, provider: 'claude-cli' }),
      ).text,
    ).toContain('workflow client-asks');
    expect(await data({ kind: 'eventsSubscriberEnable', subscriberId: 'events-dashboard', version: 2 })).toMatchObject({
      approvalId: expect.stringMatching(/^ap_/),
      binding: { digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    for (const call of [
      { kind: 'eventsRuleShowVersion', ruleId: 'invoices', version: 1 },
      { kind: 'eventsRuleTestFlow', document: {}, example: 'gmail.message.received@1:0', outcomes: {} },
      { kind: 'eventsProjectAdd', document: {} },
      { kind: 'eventsProjectUpdate', document: {} },
      { kind: 'eventsProjectRemove', projectId: 'acme-site' },
      { kind: 'eventsWorkflowEventsList' },
      { kind: 'eventsSubscriberAdd', document: {} },
      { kind: 'eventsSubscriberUpdate', document: {} },
      { kind: 'eventsSubscriberRemove', subscriberId: 'events-dashboard' },
      { kind: 'eventsSubscriberApprove', approvalId: 'ap_0123456789ABCDEFGHJKMNPQRS', digest: 'ab'.repeat(32) },
    ] as const) {
      expect((await bridge.cli(call)).status, call.kind).toBe('ok');
    }
  });
});
