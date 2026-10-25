import { expect, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';

const BEHAVIOUR = {
  rules: [{ account: 'example/slack', acts: ['reply', 'reaction'], orphan: false }],
  unreadable: [],
  accounts: [{ account: 'example/slack', allowed: ['reply', 'reaction'], conversations: [] }],
};

/** An installation with core and Slack at 0.24.0, the label and the rules as the fixtures have them, and `cliResults`. */
function scenario(cliResults: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.24.0',
      present: ['core', 'slack'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      doctor: { core: { ok: true, checks: [] }, slack: { healthy: true, checks: [] } },
      label: { word: 'agent', words: ['agent'], name: 'Jo Example', rules: [], accounts: [], ignored: [] },
      behaviour: BEHAVIOUR,
      standingList: { approvals: [] },
    },
    cliResults,
    ...extra,
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string }; command?: unknown } };

async function calls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
}

/** Opens Agent on the view its tab `name` shows. */
async function openView(page: Page, name: RegExp): Promise<void> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agent' }).click();
  await page.getByRole('tablist', { name: 'Agent' }).getByRole('tab', { name }).click();
}

/** Opens Agent's behaviour rules, and fills the rule form for example/slack with `acts` ticked. */
async function fillRule(page: Page, acts: string[]): Promise<void> {
  await openView(page, /^Behaviour rules/);
  const form = page.getByRole('form', { name: 'Add or change a rule' });
  await form.getByRole('combobox', { name: 'Account' }).click();
  await page.getByRole('option', { name: 'example/slack' }).click();
  for (const act of acts) await form.getByRole('checkbox', { name: act }).click();
  await form.getByRole('button', { name: 'Save rule' }).click();
}

test('a tightening is applied', async ({ page }) => {
  await installMockIpc(
    page,
    scenario({
      behaviourAllow: {
        status: 'ok',
        exit: 0,
        data: { change: 'setRule', changed: true, note: null, ...BEHAVIOUR },
      },
    }),
  );
  await fillRule(page, ['reply']);
  const rules = page.getByRole('region', { name: 'Behaviour rules' });
  await expect(rules.getByText('Applied.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'behaviourAllow')).toEqual([
    { cmd: 'cli', args: { call: { kind: 'behaviourAllow', account: 'example/slack', acts: 'reply' } } },
  ]);
  // The rules were read again, and nothing went to Terminal.
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.args.call?.kind === 'behaviour').length)
    .toBe(2);
  expect(recorded.map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('a loosening is sent to Terminal', async ({ page }) => {
  await installMockIpc(
    page,
    scenario(
      {
        behaviourAllow: {
          status: 'approvalPending',
          approvalId: ID,
          preview: 'Let an agent only post in example/slack\n<img src=x onerror=alert(1)>',
          expiresAt: '2026-10-19T09:10:00.000Z',
        },
      },
      { open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: true } },
    ),
  );
  await fillRule(page, ['post']);
  const rules = page.getByRole('region', { name: 'Behaviour rules' });
  await expect(rules.getByText('Approve this in Terminal')).toBeVisible();
  await expect(rules.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeVisible();
  await expect(rules.locator('img')).toHaveCount(0);
  await rules.getByRole('button', { name: 'Approve in Terminal' }).click();
  await expect(rules.getByText('Opened in Terminal.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'open_in_terminal')).toEqual([
    {
      cmd: 'open_in_terminal',
      args: {
        command: {
          kind: 'change',
          call: { kind: 'behaviourAllow', account: 'example/slack', acts: 'post' },
          revoke: ID,
        },
      },
    },
  ]);
  // Revoked by Rust as part of that one command: the app sent no revoke of its own, and never approved.
  expect(recorded.some((call) => call.args.call?.kind === 'approvalRevoke')).toBe(false);
  expect(recorded.filter((call) => call.args.call?.kind === 'behaviourAllow')).toHaveLength(1);
});

test('the views are tabs, the label first, each counting what it holds', async ({ page }) => {
  await installMockIpc(page, scenario({}, {}));
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agent' }).click();
  const tabs = page.getByRole('tablist', { name: 'Agent' }).getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'The label' })).toContainText('Jo Example');
  // One rule: its count on its tab, said in full.
  await expect(tabs.nth(1)).toHaveAccessibleName('Behaviour rules 1 rule');
  await expect(tabs.nth(2)).toHaveAccessibleName('Standing approvals');
  await tabs.nth(1).click();
  await expect(page.getByRole('region', { name: 'Behaviour rules' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'The label' })).toBeHidden();
  // The hint beside the conversation's label, on a pointer resting on it.
  await page.getByRole('button', { name: 'About the conversation' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('A Slack channel or person id, or an address or @domain.');
});
