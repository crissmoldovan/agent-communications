import { expect, type Locator, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * The owner's workflow, made in the app end to end (0.36.0, plan G2, spec §11.2–§11.3) against the built UI, with
 * Tauri's IPC mocked: a new workflow from an empty canvas — a wait dragged from the palette, a notice dragged beside
 * it, a wire drawn from the wait's "elapsed" to the notice — two of its events ticked, approved in the app by typing
 * its id, and then one of its runs opened from its page, drawn with the path it took lit. Nothing is stored, enabled
 * or run: every answer is the scenario's, and the event service's part is proved by its own end-to-end test.
 */

// The app approves in the app only where it can attest the person, on macOS: this runs as a Mac's window does.
test.use({
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const ACCOUNT = 'in_01EXAMPLE0000000000000000';
const DIGEST = 'ada6752bbfedde7cdde540ee02823ddc3959eca43c741438c9094e07fc1e07d0';
const APPROVAL = 'ap_NFB269AFMQY89NN2RMJ1PPB1Y8';

/** What the canvas makes of the steps below: wait an hour, then tell me; two events ticked, named after acme/gmail. */
const FLOW = {
  flowVersion: 1,
  start: 'wait-1',
  steps: {
    'wait-1': {
      kind: 'wait',
      for: { time: { afterMs: 3600000 } },
      timeoutMs: 3600000,
      emit: ['elapsed'],
      next: { elapsed: 'notify-1' },
    },
    'notify-1': { kind: 'notify', text: 'Time to look at it again', emit: ['notified'], next: {} },
  },
  limits: {
    runsPerHour: 10,
    concurrentRuns: 2,
    sessionsPerHour: 2,
    worktreesPerDay: 5,
    linearWritesPerHour: 30,
    eventsPerHour: 120,
    runMs: 259200000,
  },
  events: { namespace: 'acme', workflow: 'tell-me' },
};

/** The workflow as the event service holds it once it is saved: the empty canvas's trigger, and the flow above. */
const TELL_ME = {
  ruleId: 'tell-me',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  // The empty canvas's own condition, which the person may narrow in the trigger's settings.
  condition: { path: '/subject', op: 'contains', value: '', caseSensitive: false },
  mapping: { from: { $path: '/from' }, subject: { $path: '/subject' }, snippet: { $path: '/snippet' } },
  targets: [],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 604800000,
    holdMs: 604800000,
    deliveryMs: 604800000,
    dryrunMs: 86400000,
    sseReplayMs: 604800000,
    deadLetterMs: 604800000,
    decisionMetadataMs: 7776000000,
  },
  flow: FLOW,
};

const ROW = {
  rule_id: 'tell-me',
  version: 1,
  digest: DIGEST,
  state: 'active',
  approval_id: APPROVAL,
  authorization_activation_id: 'act_abc238ade1f281e860491b9ebbc1385d',
};

const RUN_ID = 'wfr_0123456789abcdefghjkmnpqrs';
const STARTED = 1792915200000;

const RUN = {
  runId: RUN_ID,
  ruleId: 'tell-me',
  ruleVersion: 1,
  state: 'done',
  startedAt: STARTED,
  updatedAt: STARTED + 3601000,
  endCode: null,
  eventId: '0123456789abcdef0123456789abcdef',
  parentRunId: null,
  depth: 0,
  shadow: false,
  waiting: null,
};

const step = (stepId: string, kind: string, outcome: string, at: number) => ({
  stepId,
  kind,
  state: 'done',
  outcome,
  attempts: 1,
  startedAt: at,
  settledAt: at + 1000,
  output: kind === 'wait' ? { for: 'time', reported: null } : { raised: true },
  lastErrorCode: null,
  deliveryId: null,
  wait: null,
});

/** The run: it waited its hour, and told the person; each ticked event raised, and nobody subscribes. */
const RUN_SHOW = {
  ...RUN,
  path: ['wait-1', 'notify-1'],
  notRaised: 0,
  steps: [step('wait-1', 'wait', 'elapsed', STARTED), step('notify-1', 'notify', 'notified', STARTED + 3600000)],
  events: [
    {
      eventId: 'wfe_0123456789abcdefghjkmnpqrs',
      type: 'acme.tell-me.wait-1.elapsed',
      raisedAt: STARTED + 3600000,
      state: 'done',
      deliveries: [],
    },
    {
      eventId: 'wfe_123456789abcdefghjkmnpqrst',
      type: 'acme.tell-me.notify-1.notified',
      raisedAt: STARTED + 3601000,
      state: 'done',
      deliveries: [],
    },
  ],
};

function scenario(): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.36.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
      home: '/example/home',
    },
    take_deep_link: null,
    app_build: { identifier: 'com.cueplusplus.agentcomms', isTest: false, commit: null, builtAt: null },
    workflow_positions: {},
    set_workflow_positions: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      doctor: { core: { ok: true, checks: [] } },
      accounts: { gmail: [{ alias: 'acme/gmail', id: ACCOUNT, email: 'acme@example.test' }] },
      eventsStatus: { owner: 'running', enabled: true, paused: false },
      // No workflow yet: the name is free.
      eventsRules: [],
      eventsRuleShow: [
        { ...ROW, document: TELL_ME, activatedAt: STARTED - 60000, supersededAt: null, revokedAt: null },
      ],
      eventsRuleShowVersion: [{ ...ROW, document: TELL_ME }],
      eventsDeliveries: [],
      eventsTargetsList: [],
      eventsProjectsList: { projects: [] },
      judgeKindsList: [],
      judgesList: [],
      activitySessions: { since: null, sessions: [] },
      eventsRuleCreate: {
        id: 'tell-me@1',
        kind: 'rule',
        objectId: 'tell-me',
        version: 1,
        digest: DIGEST,
        state: null,
      },
      eventsRuleEnable: {
        intentId: 'act_abc238ade1f281e860491b9ebbc1385d',
        approvalId: APPROVAL,
        binding: {
          digest: DIGEST,
          activationIntentId: 'act_abc238ade1f281e860491b9ebbc1385d',
          activationKind: 'rule',
          versions: [{ kind: 'rule', id: 'tell-me', version: 1 }],
        },
        kind: 'rule',
        status: 'pending',
      },
      // As Rust hands it to the window: the view's own challenge taken out.
      eventsApprovalView: {
        kind: 'READY',
        approvalId: APPROVAL,
        digest: DIGEST,
        preview: { documentVersion: 1, kind: 'rule', rule: TELL_ME },
        pendingTargetSelectors: [],
      },
      eventsRuleApprove: {
        approvalId: APPROVAL,
        ruleId: 'tell-me',
        version: 1,
        approved: true,
        approvedBy: 'desktop-app',
        completion: {
          intentId: 'act_abc238ade1f281e860491b9ebbc1385d',
          status: 'completed',
          usedAt: '2026-10-27T08:00:00.000Z',
        },
      },
      eventsRunsList: { runs: [RUN] },
      eventsRunShow: RUN_SHOW,
    },
    // Once approved, the list names it, as the event service's would.
    cliAfter: { eventsRuleApprove: { eventsRules: [ROW] } },
    cliResults: { version: { status: 'version', version: '0.36.0' } },
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string; document?: typeof TELL_ME } } };

async function calls(page: Page, kind: string): Promise<Recorded[]> {
  const all = await page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
  return all.filter((call) => call.cmd === 'cli' && call.args.call?.kind === kind);
}

/** Drags a palette step onto the canvas, dropped `at` a point of the canvas's own box. */
async function dragOn(editor: Locator, item: string, at: { x: number; y: number }): Promise<void> {
  // The canvas in the middle of the window first: a step's settings, opened by the drop before, can move it so far
  // that the drop point lies outside the window, where the page's scroller takes the drop (CI, 2026-10-27).
  const canvas = editor.locator('.react-flow');
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await editor.locator(`[data-palette="${item}"]`).dragTo(canvas, { targetPosition: at });
}

/** The middle of an element on the page. */
async function middle(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('it has no place on the page');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test('a workflow made on an empty canvas by dragging, two events ticked, approved, and its run lit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  await page.getByRole('tab', { name: /^Workflows\b/ }).click();

  // A new workflow, from an empty canvas.
  await page.getByRole('button', { name: 'New workflow…' }).click();
  const named = page.getByRole('dialog', { name: 'New workflow' });
  await named.getByRole('textbox', { name: 'Name' }).fill('tell-me');
  await named.getByRole('radio', { name: /^An empty canvas/ }).check();
  await named.getByRole('button', { name: 'Start' }).click();
  const editor = page.getByRole('region', { name: 'New workflow tell-me' });
  await expect(editor.locator('.react-flow')).toBeVisible();
  await expect(editor.locator('[data-step]')).toHaveCount(0);

  // Two steps, each dragged from the palette to where it should go.
  await dragOn(editor, 'wait-time', { x: 200, y: 240 });
  await expect(editor.locator('[data-step="wait-1"]')).toBeVisible();
  await dragOn(editor, 'notify', { x: 620, y: 240 });
  const tell = editor.locator('[data-settings="notify-1"]');
  await expect(tell).toBeVisible();
  await tell.getByRole('textbox', { name: 'It says' }).fill('Time to look at it again');

  // A wire drawn from the wait's "elapsed" to the notice's input.
  const from = editor.locator('[data-step="wait-1"] [data-outcome="elapsed"] .react-flow__handle');
  const to = editor.locator('[data-step="notify-1"] .react-flow__handle.target');
  const start = await middle(from);
  const end = await middle(to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await expect(editor.locator('[data-step="wait-1"] [data-outcome="elapsed"] [data-slot="stops"]')).toHaveCount(0);

  // Two events ticked: the wait's elapsed, and the notice's notified. Each step shows the mark.
  await editor.locator('.react-flow__node[data-id="wait-1"]').click();
  await editor.locator('[data-settings="wait-1"] [data-event="elapsed"]').click();
  await expect(editor.locator('[data-settings="wait-1"] [data-slot="event-name"]')).toContainText(
    'acme.tell-me.wait-1.<event>',
  );
  await editor.locator('.react-flow__node[data-id="notify-1"]').click();
  await editor.locator('[data-settings="notify-1"] [data-event="notified"]').click();
  await expect(editor.locator('[data-step="wait-1"] [data-slot="emit-mark"]')).toHaveText('1');
  await expect(editor.locator('[data-step="notify-1"] [data-slot="emit-mark"]')).toHaveText('1');
  await expect(editor.getByText(/to fix before it can be saved/)).toHaveCount(0);

  // Review and approve…: saved as version 1, prepared, and approved in the app by typing its id.
  await editor.getByRole('button', { name: 'Review and approve…' }).click();
  const approval = page.getByRole('dialog', { name: 'Approve version 1 of tell-me' });
  await expect(approval.getByRole('region', { name: 'What it does, step by step' })).toBeVisible();
  const approve = approval.getByRole('button', { name: 'Approve and switch on' });
  await expect(approve).toBeDisabled();
  await approval.getByRole('textbox', { name: 'Type tell-me to approve' }).fill('tell-me');
  await approve.click();
  await expect(approval).toHaveCount(0);
  const created = await calls(page, 'eventsRuleCreate');
  expect(created).toHaveLength(1);
  const flow = created[0]?.args.call?.document?.flow;
  expect(flow?.start).toBe('wait-1');
  expect(flow?.steps).toEqual(FLOW.steps);
  expect(flow?.events).toEqual(FLOW.events);
  // Where the boxes are is the app's own: no position went to the event service.
  expect(JSON.stringify(created[0]?.args.call?.document)).not.toContain('position');
  expect(await calls(page, 'eventsRuleApprove')).toHaveLength(1);

  // Its page, and one of its runs: drawn on its version's canvas, lit along the path it took.
  const workflow = page.getByRole('region', { name: 'Workflow tell-me' });
  await workflow.getByRole('region', { name: 'Runs' }).locator(`[data-run="${RUN_ID}"]`).click();
  const run = page.getByRole('region', { name: 'A run of tell-me' });
  await expect(run.locator('.react-flow [data-step="wait-1"]')).toHaveAttribute('data-run', 'taken');
  await expect(run.locator('.react-flow [data-step="notify-1"]')).toHaveAttribute('data-run', 'taken');
  await expect(run.locator('[data-run-step="wait-1"]')).toHaveAttribute('data-run', 'taken');
  expect(await calls(page, 'eventsRuleShowVersion')).not.toHaveLength(0);
});
