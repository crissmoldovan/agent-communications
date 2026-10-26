import { expect, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';

const KINDS = (identity: 'agent' | 'me', kinds: string[]) =>
  kinds.map((kind) => ({ kind, identity, source: 'default', appearsAs: 'Jo Example (agent)' }));

/** Your agents' reads: the label with one exception, what agents may do, and a Gmail and a Slack account. */
const LABEL = {
  word: 'agent',
  words: ['agent', 'assistant', 'twin', 'minion', 'bot', 'fake', 'AI'],
  name: 'Jo Example',
  rules: [{ rule: { account: 'example/gmail', as: 'me' }, text: 'example/gmail: me', matches: true }],
  accounts: [
    {
      account: 'example/gmail',
      platform: 'gmail',
      channel: 'Gmail',
      phrase: 'Jo Example (agent)',
      kinds: KINDS('me', ['send', 'reply']),
      conversations: [],
    },
    {
      account: 'example/slack',
      platform: 'slack',
      channel: 'Slack',
      phrase: 'Jo Example (agent)',
      kinds: KINDS('agent', ['post', 'reply', 'reaction', 'edit', 'file']),
      conversations: [],
      style: 'app',
      appRoute: true,
    },
  ],
  ignored: [],
};

/** An installation with core, Gmail and Slack at `version`, Your agents' reads, and `cliResults`. */
function scenario(
  version: string,
  cliResults: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    installation: { installed: true, version, present: ['core', 'gmail', 'slack'], folders: FOLDERS, problem: null },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      doctor: { core: { ok: true, checks: [] }, gmail: { ok: true, checks: [] }, slack: { healthy: true, checks: [] } },
      label: LABEL,
      behaviour: {
        rules: [],
        unreadable: [],
        accounts: [
          { account: 'example/gmail', allowed: 'all', conversations: [] },
          { account: 'example/slack', allowed: ['reply', 'reaction'], conversations: [] },
        ],
      },
      accounts: {
        gmail: [{ alias: 'example/gmail', email: 'jo@example.com', health: 'ok' }],
        slack: [{ alias: 'example/slack', workspaceName: 'Example', mode: 'send' }],
      },
      standingList: { approvals: [] },
    },
    cliResults,
    ...extra,
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string }; approvalId?: string } };

async function calls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
}

async function openYourAgents(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Your agents' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Your agents' })).toBeVisible();
}

test('what people see, from the label; an older core shows it read-only and changes nothing', async ({ page }) => {
  await installMockIpc(page, scenario('0.24.0'));
  await openYourAgents(page);
  const seen = page.getByRole('region', { name: 'When an agent writes for you, people see this' });
  await expect(seen.getByRole('figure', { name: 'In Slack' })).toContainText('Jo Example (agent):');
  await expect(seen.getByRole('figure', { name: 'In mail' })).toContainText('"Jo Example (agent)" <jo@example.com>');
  await expect(page.getByText('Needs 0.34.0 or later; this machine has 0.24.0.')).toBeVisible();
  await expect(seen.getByRole('button', { name: /Change/ })).toHaveCount(0);
  const per = page.getByRole('region', { name: 'Per account' });
  await expect(per.getByRole('button', { name: 'example/slack: open in Accounts' })).toContainText(
    'Agents may reply and react.',
  );
  // Nothing was changed: no label change was asked.
  expect((await calls(page)).filter((call) => /^label[A-Z]/.test(call.args.call?.kind ?? ''))).toEqual([]);
});

test('removing an exception that sends messages as you applies at once', async ({ page }) => {
  await installMockIpc(
    page,
    scenario('0.34.0', {
      labelRuleRemove: { status: 'ok', exit: 0, data: { change: 'removeRule', changed: true, note: null, ...LABEL } },
    }),
  );
  await openYourAgents(page);
  const exceptions = page.getByRole('region', { name: 'Exceptions' });
  await exceptions.getByRole('button', { name: 'Remove' }).click();
  await expect(exceptions.getByText('Removed at once. Those messages carry the tag again.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'labelRuleRemove')).toEqual([
    { cmd: 'cli', args: { call: { kind: 'labelRuleRemove', account: 'example/gmail', as: 'me' } } },
  ]);
  expect(recorded.map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('a new word shows core’s preview as text, and Cancel revokes it', async ({ page }) => {
  await installMockIpc(
    page,
    scenario(
      '0.34.0',
      {
        labelWord: {
          status: 'approvalPending',
          approvalId: ID,
          preview: 'Change the word\n  agent → twin\n<img src=x onerror=alert(1)>',
          expiresAt: '2026-10-26T23:10:00.000Z',
        },
      },
      { revoke_preview: { status: 'ok', exit: 0, data: { approvalId: ID, state: 'revoked' } } },
    ),
  );
  await openYourAgents(page);
  const seen = page.getByRole('region', { name: 'When an agent writes for you, people see this' });
  await seen.getByRole('button', { name: 'Change… the word' }).click();
  const ask = seen.getByRole('region', { name: 'This changes what everyone you write to sees' });
  await ask.getByRole('combobox', { name: 'The word after your name' }).click();
  await page.getByRole('option', { name: 'twin' }).click();
  await ask.getByRole('button', { name: 'Continue' }).click();
  await expect(seen.getByText('This changes what everyone you write to sees. Approve it')).toBeVisible();
  await expect(seen.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
  await expect(seen.locator('img')).toHaveCount(0);
  await seen.getByRole('button', { name: 'Cancel' }).click();
  await expect(seen.getByText('Cancelled: nothing was changed.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'labelWord')).toEqual([
    { cmd: 'cli', args: { call: { kind: 'labelWord', word: 'twin' } } },
  ]);
  expect(recorded.filter((call) => call.cmd === 'revoke_preview')).toEqual([
    { cmd: 'revoke_preview', args: { approvalId: ID } },
  ]);
});
