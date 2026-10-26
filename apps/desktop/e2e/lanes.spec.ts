import { expect, type Page, test } from '@playwright/test';
import activityRecent from '../src/test/fixtures/activity-sessions-recent.json' with { type: 'json' };
import laneList from '../src/test/fixtures/lane-list.json' with { type: 'json' };
import queueCounts from '../src/test/fixtures/queue-counts.json' with { type: 'json' };
import queueDismissed from '../src/test/fixtures/queue-list-dismissed.json' with { type: 'json' };
import queueDone from '../src/test/fixtures/queue-list-done.json' with { type: 'json' };
import queueOpen from '../src/test/fixtures/queue-list-open.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

/** The open fixture's items, by the rule each matched. */
const OPEN_BY_RULE = Object.fromEntries(queueOpen.items.map((item) => [item.rule.id, item.id]));

type Recorded = { cmd: string; args: { call?: Record<string, unknown>; command?: Record<string, unknown> } };

/** Core and the events service at `version`, with the queue's and the lanes' fixtures from the contract. */
function scenario(version: string, cli: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version,
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
      home: '/example/home',
    },
    take_deep_link: null,
    open_link: null,
    open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: null },
    cli: {
      approvalsPending: [],
      updateStatus: null,
      standingList: { approvals: [] },
      eventsStatus: { owner: 'not-running' },
      doctor: {},
      queueCounts,
      queueList: { open: queueOpen, done: queueDone, dismissed: queueDismissed },
      laneList,
      laneUnbind: { lane: 'david', unbound: true },
      activitySessions: activityRecent,
      ...cli,
    },
    cliResults: { version: { status: 'version', version } },
  };
}

const recorded = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);

const cliCalls = async (page: Page) =>
  (await recorded(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call ?? {});

const laneCalls = async (page: Page) => (await cliCalls(page)).filter((call) => String(call.kind).startsWith('lane'));

const terminals = async (page: Page) =>
  (await recorded(page)).filter((call) => call.cmd === 'open_in_terminal').map((call) => call.args.command ?? {});

async function openQueue(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Queue/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Queue' })).toBeVisible();
}

async function openLanes(page: Page): Promise<void> {
  await openQueue(page);
  await page.getByRole('tab', { name: /^Lanes/ }).click();
  await expect(page.getByRole('region', { name: 'Lanes' })).toBeVisible();
}

test("Queue shows each item's lane as a quiet chip, and filters by lane", async ({ page }) => {
  await installMockIpc(page, scenario('0.31.0'));
  await openQueue(page);
  const open = page.getByRole('region', { name: 'Open' });
  const chip = (rule: string) => open.locator(`li[data-item="${OPEN_BY_RULE[rule]}"] [data-slot="queue-lane"]`);
  await expect(chip('david-on-slack')).toHaveText('Lane david');
  await expect(chip('invoices')).toHaveText('Lane billing');
  await expect(chip('receipts')).toHaveText('Lane billing');
  await expect(chip('mail-asks')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Lanes/ })).toContainText('2');
  // The lane filter: the lanes by name; a lane of one rule narrows the read by that rule.
  await page.getByRole('combobox', { name: 'Lane' }).click();
  await expect(page.getByRole('option')).toHaveText(['All lanes', 'david', 'billing']);
  await page.getByRole('option', { name: 'billing' }).click();
  await expect(open.locator('li[data-item]')).toHaveCount(2);
  await expect(open.locator(`li[data-item="${OPEN_BY_RULE.invoices}"]`)).toBeVisible();
  await expect(open.locator(`li[data-item="${OPEN_BY_RULE.receipts}"]`)).toBeVisible();
  await page.getByRole('combobox', { name: 'Lane' }).click();
  await page.getByRole('option', { name: 'david' }).click();
  await expect(open.locator('li[data-item]')).toHaveCount(1);
  await expect
    .poll(async () => (await cliCalls(page)).filter((call) => call.kind === 'queueList'))
    .toContainEqual({ kind: 'queueList', state: 'open', rule: 'david-on-slack', limit: 100 });
});

test("a plain queue's item from a rule that sends to a lane too shows no lane, and no lane filter keeps it", async ({
  page,
}) => {
  const david = queueOpen.items.find((item) => item.rule.id === 'david-on-slack') as (typeof queueOpen.items)[number];
  const plain = { ...david, id: 'qi_01JBH7Z3K9000000000000000P', lane: null };
  await installMockIpc(page, scenario('0.31.0', { queueList: { open: { items: [david, plain], more: false } } }));
  await openQueue(page);
  const open = page.getByRole('region', { name: 'Open' });
  await expect(open.locator('li[data-item]')).toHaveCount(2);
  await expect(open.locator(`li[data-item="${david.id}"] [data-slot="queue-lane"]`)).toHaveText('Lane david');
  await expect(open.locator(`li[data-item="${plain.id}"] [data-slot="queue-lane"]`)).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Lane' }).click();
  await page.getByRole('option', { name: 'david' }).click();
  await expect(open.locator('li[data-item]')).toHaveCount(1);
  await expect(open.locator(`li[data-item="${david.id}"]`)).toBeVisible();
});

test('Lanes lists each lane with its binding; Unbind asks first and runs exactly its call', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installMockIpc(page, scenario('0.31.0'));
  await openLanes(page);
  const david = page.locator('[data-lane="david"]');
  await expect(david).toContainText('david');
  await expect(david).toContainText('1 open');
  await expect(david.locator('[data-slot="lane-rules"]')).toHaveText('David on Slack · Slack');
  await expect(david.locator('[data-slot="lane-folder"]')).toHaveText('~/work/acme-site');
  await expect(david.locator('[data-slot="lane-client"]')).toContainText('claude-code 2.1.0, as the client says');
  await expect(david.locator('[data-slot="lane-since"] time')).toHaveAttribute('datetime', '2026-10-25T09:12:03.000Z');
  const billing = page.locator('[data-lane="billing"]');
  await expect(billing.locator('[data-slot="lane-binding"]')).toHaveText('Not bound');
  await expect(billing.getByRole('button', { name: 'Bind a window…' })).toBeVisible();
  // Unbind: Cancel runs nothing; Unbind runs `lane unbind david`, once.
  await david.getByRole('button', { name: 'Unbind' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Unbind david?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toHaveCount(0);
  expect((await laneCalls(page)).filter((call) => call.kind === 'laneUnbind')).toEqual([]);
  await david.getByRole('button', { name: 'Unbind' }).click();
  await page.getByRole('alertdialog', { name: 'Unbind david?' }).getByRole('button', { name: 'Unbind' }).click();
  await expect(page.getByRole('main').getByText('Unbound david.')).toBeVisible();
  expect((await laneCalls(page)).filter((call) => call.kind === 'laneUnbind')).toEqual([
    { kind: 'laneUnbind', lane: 'david' },
  ]);
  // A tightening the app applies: no terminal opened.
  expect(await terminals(page)).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('Bind a window… offers the grouped windows only, and Bind in Terminal opens the bind command', async ({
  page,
}) => {
  await installMockIpc(page, scenario('0.31.0'));
  await openLanes(page);
  await page.locator('[data-lane="billing"]').getByRole('button', { name: 'Bind a window…' }).click();
  const picker = page.getByRole('dialog', { name: 'Bind a window to billing' });
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-window]')).toHaveCount(2);
  await expect(picker.locator('[data-window="a1b2c3d4e5f60718"]')).toHaveCount(0);
  await expect(picker.locator('[data-window="0c0ffee000000001"]')).toHaveCount(0);
  await expect(picker.locator('[data-slot="picker-hidden"]')).toContainText('2 more not listed');
  await expect(picker.locator('[data-window="3f9a1c2e7b4d5a60"]')).toContainText('Bound to david');
  await expect(
    picker.locator('[data-window="3f9a1c2e7b4d5a60"]').getByRole('button', { name: 'Bind in Terminal' }),
  ).toHaveCount(0);
  expect(await cliCalls(page)).toContainEqual({ kind: 'activitySessions', since: '24h' });
  await picker.locator('[data-window="7c1e5b9a0d2f4e68"]').getByRole('button', { name: 'Bind in Terminal' }).click();
  await expect(picker.getByText('Opened in Terminal.')).toBeVisible();
  expect(await terminals(page)).toEqual([{ kind: 'laneBind', lane: 'billing', window: '7c1e5b9a0d2f4e68' }]);
  // The app never binds itself: every lane call it made was a read.
  for (const call of await laneCalls(page)) expect(call).toEqual({ kind: 'laneList' });
});

test('an events service older than 0.31.0 gets the update line in Lanes, and no lane call', async ({ page }) => {
  await installMockIpc(page, scenario('0.30.0'));
  await openLanes(page);
  await expect(page.getByText('Update agent-communications to use this')).toBeVisible();
  await expect(page.getByText('Needs 0.31.0 or later; this machine has 0.30.0.')).toBeVisible();
  await page.getByRole('tab', { name: /^Open/ }).click();
  await expect(page.getByRole('region', { name: 'Open' }).locator('li[data-item]')).toHaveCount(5);
  await expect(page.locator('[data-slot="queue-lane"]')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Lane' })).toHaveCount(0);
  expect(await laneCalls(page)).toEqual([]);
});
