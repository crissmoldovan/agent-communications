import { expect, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * The workflow designer (0.36.0, plan E2, spec §11.3) against the built UI, with Tauri's IPC mocked: a workflow of two
 * steps — wait an hour, then tell me — whose wait's "timed out" goes nowhere. A wire drawn with the mouse from that
 * outcome's handle to the notice's input writes `next["timed-out"]`, which Save draft stores. React Flow does the
 * drawing; the document only changes through the designer's own check of the arrow.
 */

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

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
  retention: {
    ingestMs: 604800000,
    holdMs: 604800000,
    deliveryMs: 604800000,
    dryrunMs: 86400000,
    sseReplayMs: 604800000,
    deadLetterMs: 604800000,
    decisionMetadataMs: 7776000000,
  },
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

function scenario(): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.36.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
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
      eventsDeliveries: [],
      eventsTargetsList: [],
      judgeKindsList: [],
      judgesList: [],
      eventsRuleUpdate: { id: 'reminders@2', kind: 'rule', objectId: 'reminders', version: 2, state: null },
    },
    cliResults: { version: { status: 'version', version: '0.36.0' } },
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string; document?: typeof REMINDERS } } };

async function calls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
}

test('a wire drawn from timed out on wait to tell writes next.timed-out', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  await page.getByRole('tab', { name: /^Rules\b/ }).click();
  await page.locator('[data-rule="reminders"]').click();
  await page.getByRole('region', { name: 'Rule reminders' }).getByRole('button', { name: 'Edit…' }).click();
  const editor = page.getByRole('region', { name: 'Edit reminders' });
  const from = editor.locator('[data-step="wait"] [data-outcome="timed-out"] .react-flow__handle');
  const to = editor.locator('[data-step="tell"] .react-flow__handle.target');
  await expect(from).toBeVisible();
  await expect(to).toBeVisible();
  // Untouched, there is nothing to save.
  await expect(editor.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (start === null || end === null) throw new Error('the handles have no place');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
  // The wire is drawn, and timed out no longer stops there.
  await expect(editor.locator('[data-step="wait"] [data-outcome="timed-out"] [data-slot="stops"]')).toHaveCount(0);
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(editor.getByText('Saved as version 2. Nothing runs until you approve it.')).toBeVisible();
  const saved = (await calls(page)).filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'eventsRuleUpdate');
  expect(saved).toHaveLength(1);
  expect(saved[0]?.args.call?.document?.flow.steps.wait.next).toEqual({ elapsed: 'tell', 'timed-out': 'tell' });
  // Where the boxes are is the app's own: no position went to the event service.
  expect(JSON.stringify(saved[0]?.args.call?.document)).not.toContain('position');
});
