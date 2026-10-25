import { expect, type Page, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const STATUS = {
  level: 'every-14-days',
  set: 'every-14-days',
  by: 'setting',
  cap: null,
  pausedUntil: null,
  lastChecked: '2026-10-19T08:00:00.000Z',
  latest: '0.24.1',
  running: '0.24.0',
  security: null,
  lastError: null,
  job: {
    state: 'installed',
    where: 'launchd: com.example.agentcomms.update',
    installedAt: '2026-10-10T08:00:00.000Z',
    lastRun: '2026-10-19T03:00:00.000Z',
    working: true,
  },
};

type Recorded = { cmd: string; args: { call?: { kind: string }; command?: unknown } };

/** A 0.24.0 installation with core alone, on the Updates screen, with `more` over the scenario. */
async function openUpdates(page: Page, more: Record<string, unknown> = {}): Promise<void> {
  await installMockIpc(page, {
    installation: { installed: true, version: '0.24.0', present: ['core'], folders: FOLDERS, problem: null },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: STATUS,
      doctor: { ok: true, checks: [] },
      updatePause: { days: 7, pausedUntil: '2026-10-26T08:00:00.000Z', security: null },
    },
    ...more,
  });
  // The pause is kept, as the CLI keeps it: after `updatePause`, every status read carries it.
  await page.addInitScript(() => {
    type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    let pausedUntil: string | null = null;
    internals.invoke = async (cmd, args = {}) => {
      const result = (await invoke(cmd, args)) as { status?: string; data?: Record<string, unknown> };
      const kind = cmd === 'cli' ? (args.call as { kind: string }).kind : null;
      if (kind === 'updatePause' && result.status === 'ok') pausedUntil = String(result.data?.pausedUntil);
      if (kind === 'updateStatus' && result.status === 'ok' && pausedUntil !== null) {
        return { ...result, data: { ...result.data, pausedUntil } };
      }
      return result;
    };
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Updates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Updates' })).toBeVisible();
}

async function recorded(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);
}

test('pause for 7 days runs update --pause 7 and shows the pause', async ({ page }) => {
  await openUpdates(page);
  const pause = page.getByRole('region', { name: 'Pause' });
  await expect(pause.getByText('Update notices are on.')).toBeVisible();
  await pause.getByRole('button', { name: 'Pause for 7 days' }).click();
  await expect(pause.getByText(/^Update notices are paused until/)).toBeVisible();
  await expect(pause.locator('time[datetime="2026-10-26T08:00:00.000Z"]')).toBeVisible();
  await expect(pause.getByRole('button', { name: 'Resume' })).toBeVisible();
  const calls = await recorded(page);
  // `updatePause` with 7, which Rust's allow-list turns into `update --pause 7`; nothing opened a terminal.
  expect(calls.filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'updatePause')).toEqual([
    { cmd: 'cli', args: { call: { kind: 'updatePause', days: 7 } } },
  ]);
  expect(calls.map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('rollback is sent to Terminal', async ({ page }) => {
  await openUpdates(page, {
    cliResults: {
      updateRollback: {
        status: 'approvalPending',
        approvalId: ID,
        preview: 'Roll back agent-communications from 0.24.0 to 0.23.0',
        expiresAt: null,
      },
    },
    open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: true },
  });
  const rollback = page.getByRole('region', { name: 'Rollback' });
  await rollback.getByRole('button', { name: 'Roll back to the release before' }).click();
  await expect(rollback.getByText('Approve this in Terminal')).toBeVisible();
  await expect(rollback.getByText('Roll back agent-communications from 0.24.0 to 0.23.0')).toBeVisible();
  await rollback.getByRole('button', { name: 'Approve in Terminal' }).click();
  await expect(rollback.getByText('Opened in Terminal.')).toBeVisible();
  const calls = await recorded(page);
  // One command names both halves: the app's own approval, revoked first by Rust, then the change opened in Terminal.
  expect(calls.filter((call) => call.cmd === 'open_in_terminal')).toEqual([
    { cmd: 'open_in_terminal', args: { command: { kind: 'change', call: { kind: 'updateRollback' }, revoke: ID } } },
  ]);
  // The app never approves, and never revokes on its own beside it.
  const kinds = calls.filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  expect(kinds).not.toContain('approvalRevoke');
  expect(kinds.filter((kind) => kind === 'updateRollback')).toHaveLength(1);
});

test('what rolling back does shows on a pointer resting beside its heading', async ({ page }) => {
  await openUpdates(page);
  const rollback = page.getByRole('region', { name: 'Rollback' });
  await expect(rollback.getByText('Puts back the release this machine ran before its last update.')).toHaveCount(0);
  await rollback.getByRole('button', { name: 'About rollback' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Puts back the release this machine ran before its last update.');
});
