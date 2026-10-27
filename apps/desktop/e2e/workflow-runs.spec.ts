import { expect, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * A workflow's runs, Projects and Events → Subscribers (0.36.0, plan F1–F3, spec §11.2) against the built UI, with
 * Tauri's IPC mocked: a run opened from its workflow's Runs, drawn on its version's canvas with the path it took lit,
 * cancelled only after it asks; a project added from the checkouts a scan found, with only the folder ticked; and a
 * subscriber whose pattern names a namespace it was not given, refused as it is typed. Nothing runs, scans or listens.
 */

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const RETENTION = {
  ingestMs: 604800000,
  holdMs: 604800000,
  deliveryMs: 604800000,
  dryrunMs: 86400000,
  sseReplayMs: 604800000,
  deadLetterMs: 604800000,
  decisionMetadataMs: 7776000000,
};

/** Wait an hour, then tell me: the workflow its run is of. */
const REMINDERS = {
  ruleId: 'reminders',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: ['in_01EXAMPLE0000000000000000'],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'contains', value: 'reminder', caseSensitive: false },
  mapping: { subject: { $path: '/subject' } },
  targets: [],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: RETENTION,
  flow: {
    flowVersion: 1,
    start: 'wait',
    steps: {
      wait: { kind: 'wait', for: { time: { afterMs: 3600000 } }, timeoutMs: 3600000, next: { elapsed: 'tell' } },
      tell: { kind: 'notify', text: 'Time to look at it again', next: {} },
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
  },
};

const ROW = {
  rule_id: 'reminders',
  version: 1,
  digest: '7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a',
  state: 'active',
  approval_id: 'ap_1A2B3C4D5E6F7G8H9J0K1M2N3E',
  authorization_activation_id: 'act_example_reminders_1',
};

const RUN_ID = 'wfr_0123456789abcdefghjkmnpqrs';
const STARTED = 1792915200000;

const RUN = {
  runId: RUN_ID,
  ruleId: 'reminders',
  ruleVersion: 1,
  state: 'waiting',
  startedAt: STARTED,
  updatedAt: STARTED + 1000,
  endCode: null,
  eventId: '0123456789abcdef0123456789abcdef',
  parentRunId: null,
  depth: 0,
  shadow: false,
  waiting: { stepId: 'wait', kind: 'time', since: STARTED + 1000, ahead: null, needsYouInClaudeStream: false },
};

const RUN_SHOW = {
  ...RUN,
  path: ['wait'],
  notRaised: 0,
  steps: [
    {
      stepId: 'wait',
      kind: 'wait',
      state: 'waiting',
      outcome: null,
      attempts: 1,
      startedAt: STARTED + 1000,
      settledAt: null,
      output: null,
      lastErrorCode: null,
      deliveryId: null,
      wait: { kind: 'time', since: STARTED + 1000, wakeAt: STARTED + 3601000 },
    },
  ],
  events: [],
};

const PROJECT = {
  projectId: 'acme-site',
  name: 'acme-site',
  repo: 'github.com/example/acme-site',
  profile: 'The Acme site: its pages and its booking form.',
  profileBy: 'person',
  profileAt: 1792828800000,
  hints: { senderDomains: ['acme.example'], slackConversations: [], people: [] },
  folders: [
    {
      folder: '/example/home/work/acme-site',
      kind: 'checkout',
      defaultBranch: 'main',
      worktreeRoot: null,
    },
  ],
  createdAt: 1792828800000,
  updatedAt: 1792828800000,
};

const SCAN = {
  roots: ['/example/home/work', '/example/home/code'],
  repos: [
    {
      repo: 'github.com/example/acme-site',
      known: 'acme-site',
      folders: [{ folder: '/example/home/work/acme-site', kind: 'checkout', defaultBranch: 'main' }],
    },
    {
      repo: 'github.com/example/billing-tool',
      known: null,
      folders: [
        { folder: '/example/home/code/billing-tool', kind: 'checkout', defaultBranch: 'main' },
        { folder: '/example/home/code/billing-tool/.claude/worktrees/fix-1', kind: 'worktree', defaultBranch: null },
      ],
    },
  ],
  skipped: [],
};

const SUBSCRIBERS = [
  {
    subscriberId: 'events-dashboard',
    version: 1,
    digest: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    revokedAt: null,
    kind: 'sse',
    events: { namespaces: ['acme'], patterns: ['acme.reminders.*.*'], content: 'none' },
    state: 'active',
    listening: { host: '127.0.0.1', port: 4801 },
    listenError: null,
    backlog: 0,
    lastDeliveredAt: null,
  },
];

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
      eventsStatus: { owner: 'running', enabled: true, paused: false },
      eventsRules: [ROW],
      eventsRuleShow: [
        { ...ROW, document: REMINDERS, activatedAt: 1792923240000, supersededAt: null, revokedAt: null },
      ],
      eventsRuleShowVersion: [{ ...ROW, document: REMINDERS }],
      eventsDeliveries: [],
      eventsTargetsList: [],
      judgeKindsList: [],
      judgesList: [],
      eventsRunsList: { runs: [RUN] },
      eventsRunShow: RUN_SHOW,
      eventsRunCancel: {
        runId: RUN_ID,
        state: 'cancelled',
        cancelledDeliveries: 0,
        cancelledEvents: 0,
        interrupted: false,
      },
      eventsProjectsList: { projects: [PROJECT] },
      eventsProjectScan: SCAN,
      eventsProjectAdd: { ...PROJECT, projectId: 'billing-tool' },
      activitySessions: { since: null, sessions: [] },
      eventsSubscribersList: SUBSCRIBERS,
    },
    cliResults: { version: { status: 'version', version: '0.36.0' } },
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string; document?: Record<string, unknown> } } };

async function calls(page: Page, kind: string): Promise<Recorded[]> {
  const all = await page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
  return all.filter((call) => call.cmd === 'cli' && call.args.call?.kind === kind);
}

test('a run opens from its workflow, lit along its path, and Cancel asks first', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  await page.getByRole('tab', { name: /^Workflows\b/ }).click();
  await page.locator('[data-rule="reminders"]').click();
  const workflow = page.getByRole('region', { name: 'Workflow reminders' });
  await workflow.getByRole('region', { name: 'Runs' }).locator(`[data-run="${RUN_ID}"]`).click();
  const run = page.getByRole('region', { name: 'A run of reminders' });
  await expect(run.locator('.react-flow [data-step="wait"]')).toHaveAttribute('data-run', 'now');
  await expect(run.locator('.react-flow [data-step="tell"]')).toHaveAttribute('data-run', 'not-yet');
  await expect(run.locator('[data-slot="run-waiting"]')).toContainText('Waiting until');
  expect(await calls(page, 'eventsRuleShowVersion')).not.toHaveLength(0);
  await run.getByRole('button', { name: 'Cancel this run…' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Nothing it already did is undone.');
  expect(await calls(page, 'eventsRunCancel')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel the run' }).click();
  await expect(run.getByText('Cancelled. 0 deliveries and 0 events were cancelled.')).toBeVisible();
  expect(await calls(page, 'eventsRunCancel')).toHaveLength(1);
});

test('a project is added from the checkouts a scan found, with only the folders ticked', async ({ page }) => {
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Projects/ })
    .click();
  await expect(page.getByRole('region', { name: 'Project acme-site' })).toContainText('~/work/acme-site');
  await page.getByRole('button', { name: 'Add a project…' }).click();
  const add = page.getByRole('region', { name: 'Add a project' });
  await add.getByRole('radio', { name: /github\.com\/example\/billing-tool/ }).click();
  const folders = add.getByRole('region', { name: 'Its folders on this Mac' });
  await folders.getByRole('checkbox').nth(1).click();
  await add.getByRole('button', { name: 'Add the project' }).click();
  await expect(page.getByText(/^Added billing-tool\./)).toBeVisible();
  const added = await calls(page, 'eventsProjectAdd');
  expect(added).toHaveLength(1);
  expect(added[0]?.args.call?.document?.folders).toEqual([
    { folder: '/example/home/code/billing-tool', kind: 'checkout', defaultBranch: 'main', worktreeRoot: null },
  ]);
});

test('a subscriber’s pattern outside its namespaces is refused as it is typed', async ({ page }) => {
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  await page.getByRole('tab', { name: /^Subscribers\b/ }).click();
  const tab = page.getByRole('region', { name: 'Subscribers' });
  await expect(tab.getByRole('region', { name: 'Subscriber events-dashboard' })).toContainText(
    'Listening at 127.0.0.1:4801',
  );
  await tab.getByRole('button', { name: 'Add a subscriber…' }).click();
  const form = page.getByRole('region', { name: 'Add a subscriber' });
  // Exact: "Its name" is also the start of "Its namespaces".
  await form.getByRole('textbox', { name: 'Its name', exact: true }).fill('ops-board');
  await form.getByRole('textbox', { name: 'Its namespaces' }).fill('acme');
  await form.getByRole('textbox', { name: 'What it receives' }).fill('globex.*.*.failed');
  await expect(form).toContainText('Line 1: the namespace globex is not one this subscriber was given.');
  await expect(form.getByRole('button', { name: 'Add it' })).toBeDisabled();
  expect(await calls(page, 'eventsSubscriberAdd')).toHaveLength(0);
});

test('Describe it drafts into the designer, says where each step came from, and saves nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const drafted = {
    text: [
      'workflow reminders, version 1',
      '',
      'when a new message arrives in in_01EXAMPLE0000000000000000, in the inbox',
    ].join('\n'),
    notes: [{ step: 'wait', words: 'wait an hour' }],
    unnoted: ['tell'],
    questions: [{ step: 'tell', question: 'Should it tell you on Slack too?', choices: ['Only here', 'Slack too'] }],
    parse: { ok: false, errors: [{ line: 3, column: 1, message: 'a workflow has a match section' }] },
    check: null,
    model: { provider: 'claude-cli', model: null },
  };
  const base = scenario();
  await installMockIpc(page, {
    ...base,
    cli: { ...(base.cli as Record<string, unknown>), eventsWorkflowDescribe: drafted },
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  await page.getByRole('tab', { name: /^Workflows\b/ }).click();
  await page.locator('[data-rule="reminders"]').click();
  await page.getByRole('region', { name: 'Workflow reminders' }).getByRole('button', { name: 'Edit…' }).click();
  const editor = page.getByRole('region', { name: 'Edit reminders' });
  await editor.getByRole('button', { name: 'Describe it…' }).click();
  const box = editor.getByRole('region', { name: 'Describe it' });
  await expect(box.getByRole('region', { name: 'What is sent' })).toContainText(
    'Never a message, unless you paste one',
  );
  expect(await calls(page, 'eventsWorkflowDescribe')).toHaveLength(0);
  await box.getByRole('textbox', { name: 'Your words' }).fill('When a reminder comes in, wait an hour and tell me.');
  await box.getByRole('button', { name: 'Draft it' }).click();
  await expect(box.locator('[data-describe-step="tell"]')).toContainText('Added by the model, not from your words.');
  await expect(box.locator('[data-describe-step="wait"] [data-slot="from-outside"]')).toContainText('wait an hour');
  await expect(box.getByRole('region', { name: 'The draft does not read as a workflow yet' })).toContainText('Line 3:');
  expect(await calls(page, 'eventsWorkflowDescribe')).toHaveLength(1);
  expect(await calls(page, 'eventsRuleUpdate')).toHaveLength(0);
});
