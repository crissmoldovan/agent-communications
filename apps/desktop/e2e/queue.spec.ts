import { expect, type Page, test } from '@playwright/test';
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

const OPEN = queueOpen.items.map((item) => item.id);
const DONE = queueDone.items.map((item) => item.id);

type Recorded = { cmd: string; args: { call?: Record<string, unknown>; url?: string } };

/** Core and the events service at `version`, with the queue's fixtures from the contract. */
function scenario(version: string, cli: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version,
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    open_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      standingList: { approvals: [] },
      eventsStatus: { owner: 'not-running' },
      doctor: {},
      queueCounts,
      queueList: { open: queueOpen, done: queueDone, dismissed: queueDismissed },
      queueDone: { item: { id: OPEN[0], state: 'done', stateAt: '2026-10-25T10:00:00.000Z' } },
      queueDismiss: { item: { id: OPEN[1], state: 'dismissed', stateAt: '2026-10-25T10:00:00.000Z' } },
      queueReopen: { item: { id: DONE[0], state: 'open', stateAt: '2026-10-25T10:00:00.000Z' } },
      queueClear: { cleared: 3 },
      ...cli,
    },
    cliResults: { version: { status: 'version', version } },
  };
}

const recorded = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);

const cliCalls = async (page: Page) =>
  (await recorded(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call ?? {});

const queueCalls = async (page: Page) => (await cliCalls(page)).filter((call) => String(call.kind).startsWith('queue'));

async function openQueue(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Sections' })
    .getByRole('button', { name: /^Queue/ })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Queue' })).toBeVisible();
}

test('Queue lists the open items as cards, the judge as a chip and every sender-written string as text', async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installMockIpc(page, scenario('0.30.0'));
  await openQueue(page);
  // Second in the sidebar, with the open count as its badge.
  const navigation = page.getByRole('navigation', { name: 'Sections' });
  await expect(navigation.getByRole('button').nth(1)).toContainText('Queue');
  await expect(navigation.locator('[data-slot="queue-badge"]')).toContainText('5');
  // The three item tabs, Open first with its count, then Lanes (0.31.0's, which says this service needs an update).
  const tabs = page.getByRole('tablist', { name: 'Queue' });
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  await expect(tabs.getByRole('tab').nth(3)).toHaveText('Lanes');
  await expect(tabs.getByRole('tab', { name: 'Open 5 waiting' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: 'Done 2' })).toBeVisible();
  await expect(tabs.getByRole('tab', { name: 'Dismissed 1' })).toBeVisible();
  const open = page.getByRole('region', { name: 'Open' });
  await expect(open.locator('li[data-item]')).toHaveCount(5);
  const card = (id: string) => open.locator(`li[data-item="${id}"]`);
  await expect(card(OPEN[0] as string)).toContainText('Gmail · example/gmail');
  await expect(card(OPEN[0] as string)).toContainText('Can you send the March invoice?');
  // Each judge's chip.
  const judge = (id: string) => card(id).locator('[data-slot="queue-judge"]');
  await expect(judge(OPEN[0] as string)).toHaveText('Jev: yes, 0.86');
  await expect(judge(OPEN[1] as string)).toHaveText('Local model: yes, 0.71, uncalibrated');
  await expect(judge(OPEN[2] as string)).toHaveText("The judge's answer is no longer kept");
  await expect(judge(OPEN[3] as string)).toHaveCount(0);
  await expect(judge(OPEN[4] as string)).toHaveText('You let it through');
  // The hostile item's sender and subject are boxed text, marked From outside: no element came of them, nothing ran.
  const hostile = card(OPEN[2] as string);
  await expect(hostile.locator('[data-slot="from-outside"] span.whitespace-pre-wrap')).toHaveText([
    '<script>alert(1)</script> Accounts',
    'billing@evil.example',
    '<img src=x onerror=alert(1)> Overdue: pay now',
  ]);
  await expect(hostile.getByText('From outside', { exact: true })).toHaveCount(1);
  await expect(page.locator('main img, main script, main iframe, main a[href]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('untrusted-content boundary');
  // Its link is on another host: it is offered no Open.
  await expect(hostile.getByRole('button', { name: /^Open in/ })).toHaveCount(0);
  expect(dialogs).toEqual([]);
  // Only the queue's reads ran, each with closed words.
  expect(await queueCalls(page)).toEqual(
    expect.arrayContaining([{ kind: 'queueCounts' }, { kind: 'queueList', state: 'open', limit: 100 }]),
  );
  for (const call of await cliCalls(page)) {
    expect([
      'queueList',
      'queueCounts',
      'approvalsPending',
      'updateStatus',
      'eventsStatus',
      'standingList',
      'doctor',
      'version',
      // Once core takes messages (0.35.0), the shared read the Queue's Not taken comes from.
      'taking',
      'takesList',
      'eventsMessagesList',
      'accounts',
    ]).toContain(call.kind);
  }
});

test('Done, Dismiss, Reopen and Clear make exactly their calls, and links open through open_link', async ({ page }) => {
  await installMockIpc(page, scenario('0.30.0'));
  await openQueue(page);
  const open = page.getByRole('region', { name: 'Open' });
  const card = (view: typeof open, id: string) => view.locator(`li[data-item="${id}"]`);
  await card(open, OPEN[0] as string)
    .getByRole('button', { name: 'Open in Gmail' })
    .click();
  await card(open, OPEN[1] as string)
    .getByRole('button', { name: 'Open in Slack' })
    .click();
  await expect
    .poll(async () => (await recorded(page)).filter((call) => call.cmd === 'open_link').map((call) => call.args.url))
    .toEqual([
      'https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5',
      'https://app.slack.com/client/T0123ABCD/C0123ABCD/thread/C0123ABCD-1792921860.000100',
    ]);
  await card(open, OPEN[0] as string)
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await expect
    .poll(async () => (await queueCalls(page)).filter((call) => call.kind === 'queueDone'))
    .toEqual([{ kind: 'queueDone', itemId: OPEN[0] }]);
  await card(open, OPEN[1] as string)
    .getByRole('button', { name: 'Dismiss' })
    .click();
  await expect
    .poll(async () => (await queueCalls(page)).filter((call) => call.kind === 'queueDismiss'))
    .toEqual([{ kind: 'queueDismiss', itemId: OPEN[1] }]);
  // Done: Reopen, and Clear behind its question.
  await page.getByRole('tab', { name: /^Done/ }).click();
  const done = page.getByRole('region', { name: 'Done' });
  await expect(done.locator('li[data-item]')).toHaveCount(2);
  await card(done, DONE[0] as string)
    .getByRole('button', { name: 'Reopen' })
    .click();
  await expect
    .poll(async () => (await queueCalls(page)).filter((call) => call.kind === 'queueReopen'))
    .toEqual([{ kind: 'queueReopen', itemId: DONE[0] }]);
  await page.getByRole('button', { name: 'Clear done and dismissed' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Clear done and dismissed items?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await queueCalls(page)).filter((call) => call.kind === 'queueClear')).toEqual([]);
  await page.getByRole('button', { name: 'Clear done and dismissed' }).click();
  await page
    .getByRole('alertdialog', { name: 'Clear done and dismissed items?' })
    .getByRole('button', { name: 'Clear', exact: true })
    .click();
  await expect(page.getByRole('main').getByText('Cleared 3 items.')).toBeVisible();
  expect((await queueCalls(page)).filter((call) => call.kind === 'queueClear')).toEqual([{ kind: 'queueClear' }]);
  // Every change named the item by its id and nothing else; nothing approved, and no terminal opened.
  for (const call of await queueCalls(page)) {
    expect(Object.keys(call).sort()).toEqual(
      call.kind === 'queueList'
        ? ['kind', 'limit', 'state']
        : call.kind === 'queueCounts' || call.kind === 'queueClear'
          ? ['kind']
          : ['itemId', 'kind'],
    );
  }
  expect((await recorded(page)).map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('an older events service gets the update line, and the Queue reads nothing', async ({ page }) => {
  await installMockIpc(page, scenario('0.29.0'));
  await openQueue(page);
  await expect(page.getByText('Update agent-communications to use this')).toBeVisible();
  await expect(page.getByText('Needs 0.30.0 or later; this machine has 0.29.0.')).toBeVisible();
  expect(await queueCalls(page)).toEqual([]);
});

test('with no rule sending to a queue, it says how to add one', async ({ page }) => {
  await installMockIpc(
    page,
    scenario('0.30.0', {
      queueCounts: { open: 0, done: 0, dismissed: 0, byRule: [] },
      queueList: { items: [], more: false },
    }),
  );
  await openQueue(page);
  await expect(page.getByText('Nothing sends to the queue yet.')).toBeVisible();
  await expect(
    page.getByText('Add a queue target and a workflow that sends to it, then approve both in the terminal.'),
  ).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Queue' })).toHaveCount(0);
});

test('with rules but nothing open, it says nothing is waiting', async ({ page }) => {
  await installMockIpc(
    page,
    scenario('0.30.0', {
      queueCounts: { ...queueCounts, open: 0 },
      queueList: { open: { items: [], more: false }, done: queueDone, dismissed: queueDismissed },
    }),
  );
  await openQueue(page);
  await expect(page.getByRole('region', { name: 'Open' }).getByText('Nothing is waiting.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Open 0 waiting' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' }).locator('[data-slot="queue-badge"]')).toHaveCount(0);
});
