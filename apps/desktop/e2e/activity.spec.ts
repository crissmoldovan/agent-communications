import { expect, type Page, test } from '@playwright/test';
import activitySessions from '../src/test/fixtures/activity-sessions.json' with { type: 'json' };
import activityShow from '../src/test/fixtures/activity-show.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const WINDOW = '3f9a1c2e7b4d5a60';

type Recorded = { cmd: string; args: { call?: Record<string, unknown> } };

function scenario(version: string): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version,
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      standingList: { approvals: [] },
      eventsStatus: { owner: 'not-running' },
      doctor: {},
      activitySessions,
      activityShow,
    },
  };
}

const recorded = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);

const cliCalls = async (page: Page) =>
  (await recorded(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call ?? {});

async function openActivity(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Activity' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
}

test('Activity lists the sessions and opens one on its timeline, every sender-written string as text', async ({
  page,
}) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installMockIpc(page, scenario('0.29.0'));
  await openActivity(page);
  const sessions = page.getByRole('region', { name: 'Sessions' });
  await expect(sessions.locator('[data-session]')).toHaveCount(3);
  await expect(sessions.locator(`[data-session="${WINDOW}"]`)).toContainText('~/work/acme-site');
  await expect(sessions.locator(`[data-session="${WINDOW}"]`)).toContainText('claude-code 2.1.0, as the client says');
  await sessions.locator(`[data-session="${WINDOW}"]`).click();
  const timeline = page.getByRole('region', { name: 'Timeline' });
  await expect(timeline.locator('li[data-kind]')).toHaveCount(10);
  await expect(timeline).toContainText('Searched Gmail (example/gmail) for ‘invoice’ — 12 results');
  await expect(timeline).toContainText('Refused: the policy says confirm');
  // The hostile subject and sender are boxed text, marked From outside: no element came of them, nothing ran.
  const hostile = timeline.locator('li[data-kind]').nth(2);
  await expect(hostile.locator('[data-slot="from-outside"]')).toHaveCount(2);
  await expect(hostile.locator('[data-slot="from-outside"] span.whitespace-pre-wrap').first()).toHaveText(
    '<img src=x onerror=alert(1)> Re: payment',
  );
  await expect(hostile.getByText('From outside', { exact: true })).toHaveCount(1);
  await expect(page.locator('main img, main script, main iframe, main a[href]')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('untrusted-content boundary');
  expect(dialogs).toEqual([]);
  // The calls carried only closed words and the session's own key.
  const activity = (await cliCalls(page)).filter((call) => String(call.kind).startsWith('activity'));
  expect(activity).toEqual([
    { kind: 'activitySessions', since: '7d' },
    { kind: 'activityShow', session: WINDOW, since: '7d' },
  ]);
  // A filter is passed on as the closed word it is.
  await page.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Wrote' }).click();
  await expect
    .poll(async () => (await cliCalls(page)).at(-1))
    .toEqual({ kind: 'activityShow', session: WINDOW, since: '7d', activityKind: 'write' });
  // Read-only: nothing but reads ran, and no terminal opened.
  for (const call of await cliCalls(page)) {
    expect([
      'activitySessions',
      'activityShow',
      'approvalsPending',
      'updateStatus',
      'standingList',
      'eventsStatus',
      'doctor',
      'version',
    ]).toContain(call.kind);
  }
  expect((await recorded(page)).map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('an older core gets the update line, and Activity reads nothing', async ({ page }) => {
  await installMockIpc(page, scenario('0.28.0'));
  await openActivity(page);
  await expect(page.getByText('Update agent-communications to use this')).toBeVisible();
  await expect(page.getByText('Needs 0.29.0 or later; this machine has 0.28.0.')).toBeVisible();
  expect((await cliCalls(page)).filter((call) => String(call.kind).startsWith('activity'))).toEqual([]);
});
