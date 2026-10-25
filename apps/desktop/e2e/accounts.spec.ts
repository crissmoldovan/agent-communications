import { expect, type Page, test } from '@playwright/test';
import accountsGmail from '../src/test/fixtures/accounts-gmail.populated.json' with { type: 'json' };
import accountsResend from '../src/test/fixtures/accounts-resend.populated.json' with { type: 'json' };
import accountsSlack from '../src/test/fixtures/accounts-slack.populated.json' with { type: 'json' };
import behaviour from '../src/test/fixtures/behaviour.json' with { type: 'json' };
import doctorWhatsapp from '../src/test/fixtures/doctor-whatsapp.json' with { type: 'json' };
import label from '../src/test/fixtures/label.populated.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

type Recorded = { cmd: string; args: { call?: { kind: string } } };

/**
 * Everything installed, with a second mailbox that needs attention and a WhatsApp account whose chats this Mac may not
 * read: the Gmail and WhatsApp tabs each have one account that needs a look.
 */
function scenario(): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.24.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: null },
    cli: {
      approvalsPending: [],
      updateStatus: null,
      standingList: { approvals: [] },
      eventsStatus: { owner: 'not-running' },
      label,
      behaviour,
      accounts: {
        gmail: [
          ...accountsGmail,
          { ...accountsGmail[0], alias: 'example/gmail-work', email: 'jo@work.example', health: 'needs-attention' },
        ],
        slack: accountsSlack,
        resend: accountsResend,
      },
      doctor: {
        core: { ok: true, checks: [] },
        whatsapp: {
          ...doctorWhatsapp,
          accounts: [
            { ...doctorWhatsapp.accounts[0], access: { state: 'denied', hint: 'Allow it in System Settings.' } },
          ],
        },
      },
    },
  };
}

async function openAccounts(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Accounts' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Accounts' })).toBeVisible();
}

const recorded = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);

test('one tab per channel, each counting what needs a look, and one channel shown at a time', async ({ page }) => {
  await installMockIpc(page, scenario());
  await openAccounts(page);
  const tabs = page.getByRole('tablist', { name: 'Channels' }).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(page.getByRole('tab', { name: 'Gmail, 1 needs a look' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'WhatsApp, 1 needs a look' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Slack', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Resend', exact: true })).toBeVisible();

  const mailboxes = page.getByRole('list', { name: 'Gmail mailboxes' });
  await expect(mailboxes.getByRole('listitem')).toHaveCount(2);
  await expect(mailboxes.getByRole('listitem').filter({ hasText: 'example/gmail-work' })).toContainText(
    'needs attention',
  );
  await expect(page.getByRole('button', { name: 'Add a mailbox' })).toBeVisible();

  // The keyboard moves between the tabs, as a tab bar's should.
  await page.getByRole('tab', { name: 'Gmail, 1 needs a look' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Slack', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Slack workspaces' })).toContainText('example/slack');
  await expect(page.getByRole('list', { name: 'Gmail mailboxes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a workspace' })).toBeVisible();

  await page.getByRole('tab', { name: 'WhatsApp, 1 needs a look' }).click();
  const whatsapp = page.getByRole('list', { name: 'WhatsApp accounts' });
  await expect(whatsapp).toContainText('denied');
  await expect(whatsapp).toContainText('Allow it in System Settings.');
  await expect(page.getByRole('button', { name: /^Add a/ })).toHaveCount(0);

  // Showing the tabs read each channel once and changed nothing.
  const cli = (await recorded(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  for (const kind of cli) {
    expect([
      'approvalsPending',
      'updateStatus',
      'standingList',
      'eventsStatus',
      'doctor',
      'accounts',
      'label',
      'behaviour',
    ]).toContain(kind);
  }
  expect((await recorded(page)).map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('the writing profile hint shows on hover', async ({ page }) => {
  await installMockIpc(page, scenario());
  await openAccounts(page);
  await page.getByRole('button', { name: 'About writing profiles' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText(
    "Your own profile applies to every message an agent writes for you; each account's adds to it.",
  );
});
