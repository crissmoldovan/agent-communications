/*
 * A workflow run's view (0.36.0, plan F1, spec §11.2): opened from a workflow's Runs, it draws the version the run ran
 * — `workflow show <id> --version <n>`, never the newest — lit along the path it took, says each step's time and what it
 * waits for, the steps it did not take and why, the events it raised and who received them, and asks before Cancel.
 * While the run is live its record is read again every 2 seconds. Every answer is a fixture; nothing runs.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import type { JsonObject } from '../rule-editor/model.ts';
import { RUN_POLL_MS } from '../screens/workflows/RunView.tsx';
import { runSteps } from '../workflows/run-graph.ts';
import type { RunShowResultV1 } from '../workflows/types.ts';
import { failed } from './fake-bridge.ts';
import { renderApp } from './render.tsx';
import { OWNER, polyfillCanvas, workflowService } from './workflow-bridge.ts';

beforeAll(polyfillCanvas);

const RUN = 'wfr_0123456789abcdefghjkmnpqrs';
const T = 1_792_915_200_000;

/** The owner's example as its version 4 ran: the same steps, Which project? labelled. */
const V4: Record<string, unknown> = (() => {
  const document = JSON.parse(JSON.stringify(OWNER)) as Record<string, unknown> & {
    flow: { steps: Record<string, Record<string, unknown>> };
  };
  document.version = 4;
  (document.flow.steps.route as Record<string, unknown>).label = 'Pick the project (v4)';
  return document;
})();

const step = (stepId: string, kind: string, more: Record<string, unknown>) => ({
  stepId,
  kind,
  state: 'done',
  outcome: null,
  attempts: 1,
  startedAt: null,
  settledAt: null,
  output: null,
  lastErrorCode: null,
  deliveryId: null,
  wait: null,
  ...more,
});

/** A run of client-asks version 4: routed to acme-site by its sender's domain, the issue made, its session busy. */
function liveRun(state: 'waiting' | 'done' = 'waiting') {
  const waiting = state === 'waiting';
  return {
    runId: RUN,
    ruleId: 'client-asks',
    ruleVersion: 4,
    state,
    startedAt: T,
    updatedAt: T + 62_000,
    endCode: waiting ? null : 'DONE',
    eventId: '0123456789abcdef0123456789abcdef',
    parentRunId: null,
    depth: 0,
    shadow: false,
    waiting: waiting
      ? { stepId: 'free', kind: 'session-idle', since: T + 62_000, ahead: 1, needsYouInClaudeStream: true }
      : null,
    path: ['route', 'found', 'issue', 'find', 'free'],
    notRaised: 0,
    steps: [
      step('route', 'route', {
        outcome: 'chosen',
        settledAt: T + 300,
        output: {
          project: 'acme-site',
          projectName: 'acme-site',
          reason: 'hint:sender-domain',
          score: null,
          profileHash: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
        },
      }),
      step('found', 'raise', {
        outcome: 'raised',
        settledAt: T + 400,
        output: { event: 'wfe_0123456789abcdefghjkmnpqrt', name: 'project-found' },
      }),
      step('issue', 'deliver', {
        outcome: 'done',
        settledAt: T + 1_900,
        output: {
          delivery: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70',
          issue: { id: 'issue-1', identifier: 'ACME-123', url: 'https://linear.app/acme/issue/ACME-123' },
        },
        deliveryId: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70',
      }),
      step('find', 'find-session', {
        outcome: 'busy',
        settledAt: T + 2_100,
        output: { session: 'sess_3c5a7e91-2b4d-4f60-8a1c-9e0d7b6f5a42', provider: 'claude' },
      }),
      waiting
        ? step('free', 'wait', {
            state: 'waiting',
            startedAt: T + 62_000,
            wait: { kind: 'session-idle', since: T + 62_000, wakeAt: T + 7_262_000 },
          })
        : step('free', 'wait', { outcome: 'free', settledAt: T + 300_000, output: { for: 'session-idle' } }),
      step('another', 'find-session', { state: 'skipped' }),
      step('tree', 'worktree', { state: 'skipped' }),
      step('start', 'start-session', { state: 'skipped' }),
    ],
    events: [
      {
        eventId: 'wfe_0123456789abcdefghjkmnpqrs',
        type: 'acme.client-asks.issue.created',
        raisedAt: T + 1_900,
        state: 'done',
        deliveries: [{ subscriberId: 'events-dashboard', subscriberVersion: 2, state: 'delivered' }],
      },
      {
        eventId: 'wfe_0123456789abcdefghjkmnpqrv',
        type: 'acme.client-asks.route.matched',
        raisedAt: T + 300,
        state: 'done',
        deliveries: [],
      },
    ],
  };
}

/** The designer's fake event service, with client-asks' version 4 to show and its run. */
function service(run: () => unknown = () => liveRun()) {
  return workflowService(undefined, {
    eventsRuleShowVersion: (call: Call) => {
      const { version } = call as Extract<Call, { kind: 'eventsRuleShowVersion' }>;
      return version === 4 ? [{ document: V4, state: 'superseded', summary: null }] : [];
    },
    eventsRunShow: run,
  });
}

const cliCalls = (fake: ReturnType<typeof service>): Call[] =>
  fake.bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args as Call);

/** Opens Events → Workflows, client-asks' page, and the run from its Runs; gives the run's region. */
async function openRun(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('tab', { name: /^Workflows\b/ }));
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-rule="client-asks"]');
    if (found === null) throw new Error('no card yet');
    return found;
  });
  fireEvent.click(card);
  const page = await screen.findByRole('region', { name: 'Workflow client-asks' });
  const runs = await within(page).findByRole('region', { name: 'Runs' });
  fireEvent.click(
    await waitFor(() => {
      const row = runs.querySelector<HTMLElement>(`[data-run="${RUN}"]`);
      if (row === null) throw new Error('no run yet');
      return row;
    }),
  );
  // The run's view loads with its own chunk, as the designer does: give it the time a loaded machine takes.
  return screen.findByRole('region', { name: 'A run of client-asks' }, { timeout: 10_000 });
}

/** A box on the run's canvas, once it is drawn. */
async function box(view: HTMLElement, stepId: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = view.querySelector<HTMLElement>(`.react-flow [data-step="${stepId}"]`);
    if (found === null) throw new Error(`${stepId} is not drawn yet`);
    return found;
  });
}

describe('a workflow run', () => {
  it("the run view draws the run's version (workflow show --version), not the newest", async () => {
    const fake = service();
    renderApp(fake.bridge, { screen: 'events' });
    const view = await openRun();
    await waitFor(() =>
      expect(cliCalls(fake)).toContainEqual({ kind: 'eventsRuleShowVersion', ruleId: 'client-asks', version: 4 }),
    );
    // Version 4's own words are on its canvas: the newest version, 5, has no label on Which project?.
    const route = await box(view, 'route');
    expect(route.textContent).toContain('Pick the project (v4)');
    expect(cliCalls(fake)).not.toContainEqual({ kind: 'eventsRuleShowVersion', ruleId: 'client-asks', version: 5 });
  });

  it('the taken path is lit; untaken steps say why', async () => {
    renderApp(service().bridge, { screen: 'events' });
    const view = await openRun();
    for (const id of ['route', 'found', 'issue', 'find'])
      expect((await box(view, id)).getAttribute('data-run'), id).toBe('taken');
    expect((await box(view, 'free')).getAttribute('data-run')).toBe('now');
    for (const id of ['another', 'tree', 'start'])
      expect((await box(view, id)).getAttribute('data-run'), id).toBe('not-taken');
    // Steps it may still reach are not yet taken, nor passed over.
    expect((await box(view, 'give')).getAttribute('data-run')).toBe('not-yet');
    const passed = within(view).getByRole('region', { name: 'Not taken, and why' });
    expect(passed.querySelector('[data-not-taken="another"]')?.textContent).toContain('Find a session came out busy.');
    expect(passed.querySelector('[data-not-taken="tree"]')?.textContent).toContain('Find a session came out busy.');
    expect(passed.querySelector('[data-not-taken="give"]')).toBeNull();
    // Each step's line, in closed words: why Which project? chose acme-site, the issue it made.
    const steps = within(view).getByRole('region', { name: 'Step by step' });
    expect(steps.querySelector('[data-run-step="route"]')?.textContent).toContain(
      'acme-site, because its sender’s domain is one acme-site lists',
    );
    expect(steps.querySelector('[data-run-step="issue"]')?.textContent).toContain('Made ACME-123');
    expect(within(view).getByText(/Which project\?: a project → Raise an event: raised/)).toBeTruthy();
  });

  it("a worktree refused for its repository's own config says why, with the key and its scope (0.37)", () => {
    const ended = liveRun('done');
    const refusedWith = (output: Record<string, unknown>) =>
      ({
        ...ended,
        steps: ended.steps.map((each) =>
          each.stepId === 'tree'
            ? step('tree', 'worktree', { outcome: 'refused', settledAt: T + 400_000, output })
            : each,
        ),
      }) as unknown as RunShowResultV1;
    const lineOf = (output: Record<string, unknown>) =>
      runSteps(V4 as JsonObject, refusedWith(output), { time: () => '11:20', home: '/example/home' }).find(
        (each) => each.stepId === 'tree',
      )?.line;
    const refused = { branch: 'ac/acme-123', path: null };
    expect(
      lineOf({ ...refused, refusal: 'REPO_CONFIG_UNSAFE', configKey: 'filter.x.process', configScope: 'local' }),
    ).toBe('Refused: the repository’s own config names a program git would run (filter.x.process, local)');
    // An attempt that lost its output keeps the words, without a key to name.
    expect(lineOf({ ...refused, refusal: 'REPO_CONFIG_UNSAFE' })).toBe(
      'Refused: the repository’s own config names a program git would run',
    );
    expect(lineOf({ ...refused, refusal: 'REPO_CONFIG_UNREADABLE' })).toBe(
      'Refused: the repository’s git config could not be read',
    );
    expect(lineOf({ ...refused, refusal: 'BRANCH_EXISTS' })).toBe('Refused: BRANCH_EXISTS');
  });

  it('Waiting for acme-site · Claude Code, 1 ahead, and Needs you in claude-stream', async () => {
    renderApp(service().bridge, { screen: 'events' });
    const view = await openRun();
    const waiting = await waitFor(() => {
      const found = view.querySelector<HTMLElement>('[data-slot="run-waiting"]');
      if (found === null || !/ahead/.test(found.textContent ?? '')) throw new Error('not yet');
      return found;
    });
    expect(waiting.textContent).toContain('Waiting for acme-site · Claude Code, 1 ahead');
    expect(waiting.textContent).toContain('Needs you in claude-stream');
  });

  it('events raised and who received them', async () => {
    renderApp(service().bridge, { screen: 'events' });
    const view = await openRun();
    const events = within(view).getByRole('region', { name: 'Events it raised' });
    const created = events.querySelector<HTMLElement>('[data-run-event="wfe_0123456789abcdefghjkmnpqrs"]');
    expect(created?.textContent).toContain('acme.client-asks.issue.created');
    expect(created?.querySelector('[data-received-by="events-dashboard"]')?.textContent).toBe(
      'events-dashboard, version 2: delivered',
    );
    const matched = events.querySelector<HTMLElement>('[data-run-event="wfe_0123456789abcdefghjkmnpqrv"]');
    expect(matched?.textContent).toContain('No subscriber receives it.');
  });

  it('it polls runs show every 2 seconds while live and stops when the run ends', { timeout: 20_000 }, async () => {
    let state: 'waiting' | 'done' = 'waiting';
    const fake = service(() => liveRun(state));
    renderApp(fake.bridge, { screen: 'events' });
    const view = await openRun();
    const reads = () => cliCalls(fake).filter((call) => call.kind === 'eventsRunShow').length;
    const first = reads();
    expect(first).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(reads()).toBeGreaterThan(first), { timeout: RUN_POLL_MS * 2 });
    // The run ends: the next read says so, and nothing reads it after that.
    state = 'done';
    await waitFor(() => expect(within(view).getByText('Finished')).toBeTruthy(), { timeout: RUN_POLL_MS * 2 });
    const settled = reads();
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS + 600));
    expect(reads()).toBe(settled);
    // An ended run offers no Cancel.
    expect(within(view).queryByRole('button', { name: 'Cancel this run…' })).toBeNull();
  });

  it('Cancel asks, then calls eventsRunCancel', async () => {
    const fake = service();
    renderApp(fake.bridge, { screen: 'events' });
    const view = await openRun();
    fireEvent.click(within(view).getByRole('button', { name: 'Cancel this run…' }));
    // It asks first: nothing is cancelled by the press alone.
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('Nothing it already did is undone.');
    expect(cliCalls(fake).filter((call) => call.kind === 'eventsRunCancel')).toEqual([]);
    // The run waits for a session to be free, not for a turn: there is no turn to stop.
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel the run' }));
    await waitFor(() =>
      expect(cliCalls(fake).filter((call) => call.kind === 'eventsRunCancel')).toEqual([
        { kind: 'eventsRunCancel', runId: RUN, interrupt: false },
      ]),
    );
    expect(await within(view).findByText('Cancelled. 1 delivery and 0 events were cancelled.')).toBeTruthy();
  });

  it("a workflow's Runs and its card say each run's story in a few words: project, issue, session, turn", async () => {
    renderApp(service().bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Workflows\b/ }));
    const card = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-rule="client-asks"]');
      if (found?.querySelector('[data-slot="last-run-summary"]') == null) throw new Error('no summary yet');
      return found;
    });
    expect(card.querySelector('[data-slot="last-run-summary"]')?.textContent).toBe(
      ': acme-site, ACME-123, a session found',
    );
    expect(card.textContent).toMatch(/2 runs this week|runs this week/);
    fireEvent.click(card);
    const page = await screen.findByRole('region', { name: 'Workflow client-asks' });
    const runs = await within(page).findByRole('region', { name: 'Runs' });
    const row = await waitFor(() => {
      const found = runs.querySelector<HTMLElement>(`[data-run="${RUN}"]`);
      if (found === null) throw new Error('no run yet');
      return found;
    });
    expect([...row.querySelectorAll('[data-slot="run-summary"]')].map((each) => each.textContent)).toEqual([
      'acme-site',
      'ACME-123',
      'a session found',
    ]);
  });

  it('a run that cannot be read says so, and asks nothing else', async () => {
    const fake = workflowService(undefined, { eventsRunShow: { runId: RUN, state: 'paused' } });
    renderApp(fake.bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Workflows\b/ }));
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-rule="client-asks"]');
        if (found === null) throw new Error('no card yet');
        return found;
      }),
    );
    const page = await screen.findByRole('region', { name: 'Workflow client-asks' });
    const runs = await within(page).findByRole('region', { name: 'Runs' });
    fireEvent.click(
      await waitFor(() => {
        const row = runs.querySelector<HTMLElement>(`[data-run="${RUN}"]`);
        if (row === null) throw new Error('no run yet');
        return row;
      }),
    );
    expect(await screen.findByText('This run could not be read.')).toBeTruthy();
    expect(fake.bridge.calls.some((call) => (call.args as Call)?.kind === 'eventsRuleShowVersion')).toBe(false);
  });

  it('a delivery a run made opens that run from Deliveries', async () => {
    const fake = workflowService(undefined, {
      eventsRuleShowVersion: [{ document: V4, state: 'superseded', summary: null }],
      eventsRunShow: () => liveRun(),
      eventsDeliveries: [
        {
          deliveryId: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70',
          ruleId: 'client-asks',
          ruleVersion: 4,
          targetId: 'client-issues',
          targetVersion: 1,
          accountId: 'in_01EXAMPLE0000000000000000',
          attempts: 1,
          nextAt: null,
          expiresAt: T + 604_800_000,
          state: 'delivered',
          targetKind: 'linear',
          lastErrorCode: null,
          lastStatus: null,
          decisionId: 'dec_1',
          eventId: '0123456789abcdef0123456789abcdef',
          deliveredAt: T + 1_900,
          deadLetteredAt: null,
        },
      ],
    });
    renderApp(fake.bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Deliveries\b/ }));
    const open = await screen.findByRole('button', { name: 'Open the run that made this delivery' });
    fireEvent.click(open);
    const view = await screen.findByRole('region', { name: 'A run of client-asks' }, { timeout: 10_000 });
    fireEvent.click(within(view).getByRole('button', { name: 'Deliveries' }));
    expect(await screen.findByRole('region', { name: 'Deliveries' })).toBeTruthy();
  });

  it('an events service before 0.36.0 shows no Runs and reads none', async () => {
    const fake = workflowService(undefined, {
      version: (call: Call) => (call.kind === 'version' && call.product === 'events-daemon' ? '0.35.0' : '0.33.0'),
      eventsRunsList: failed('APP_REFUSED', 'should not be asked'),
    });
    renderApp(fake.bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Workflows\b/ }));
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-rule="invoices"]');
        if (found === null) throw new Error('no card yet');
        return found;
      }),
    );
    const page = await screen.findByRole('region', { name: 'Workflow invoices' });
    await within(page).findByRole('region', { name: 'Versions' });
    expect(within(page).queryByRole('region', { name: 'Runs' })).toBeNull();
    expect(
      cliCalls({ bridge: fake.bridge } as ReturnType<typeof service>).some((call) => call.kind === 'eventsRunsList'),
    ).toBe(false);
  });
});
