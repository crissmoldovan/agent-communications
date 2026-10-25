import { expect, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * Settings (0.28.0, desktop design D3) against the built UI with Tauri's IPC mocked: the app's updater and Start at
 * login first, then the four folders in use as literal paths, with the folder fields behind "Change folders…".
 */

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

function scenario(more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.27.1',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    get_settings: {
      folders: {},
      resolved: FOLDERS,
      launcher: `${FOLDERS.dataDir}/launch/core`,
      launcherProblem: null,
      loginItem: false,
      loginItemAvailable: true,
    },
    updater_state: { on: true, status: 'available', version: '0.28.0', message: null },
    cli: {
      approvalsPending: [],
      updateStatus: null,
      eventsStatus: { owner: 'not-running' },
      doctor: { core: { ok: true, checks: [] } },
    },
    ...more,
  };
}

test('Settings: the updater and Start at login first, then the folders in use, their fields behind Change folders…', async ({
  page,
}) => {
  await installMockIpc(page, scenario());
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Settings' }).click();
  const app = page.getByRole('region', { name: 'This app' });
  const updater = app.getByRole('region', { name: 'Updates for this app' });
  await expect(updater.getByText('Agent Comms 0.28.0 is available.')).toBeVisible();
  await expect(updater.getByRole('button', { name: 'Install and restart' })).toBeVisible();
  await expect(updater.getByRole('button', { name: 'Check for Updates' })).toBeEnabled();
  await expect(app.getByRole('switch', { name: 'Start at login' })).toBeVisible();

  const folders = page.getByRole('region', { name: 'Folders', exact: true });
  const inUse = folders.getByRole('region', { name: 'Folders in use' });
  for (const folder of Object.values(FOLDERS)) await expect(inUse.getByText(folder, { exact: true })).toBeVisible();
  await expect(inUse.getByText(`${FOLDERS.dataDir}/launch/core`)).toBeVisible();
  // The paths are literal values, in the mono face.
  const face = await inUse
    .getByText(FOLDERS.configDir, { exact: true })
    .evaluate((element) => getComputedStyle(element).fontFamily);
  expect(face).toMatch(/mono|Menlo|Consolas|Courier/i);

  await expect(folders.getByRole('textbox')).toHaveCount(0);
  const change = folders.getByRole('button', { name: 'Change folders…' });
  await expect(change).toHaveAttribute('aria-expanded', 'false');
  await change.click();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await expect(folders.getByLabel('Config folder')).toBeVisible();
  await expect(folders.getByLabel('State folder')).toBeVisible();
  await expect(folders.getByLabel('Data folder')).toBeVisible();
  // Its explanation is a hint beside it, the next stop from the keyboard.
  await page.keyboard.press('Tab');
  await expect(folders.getByRole('button', { name: 'Why name them here' })).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(
    'An app started from the Dock or the Start menu sees no shell variables, so it needs the same folders named here.',
  );
});

test('Settings: when macOS does not answer about the login item, the switch is off and disabled, and the line says so', async ({
  page,
}) => {
  const base = scenario();
  await installMockIpc(page, {
    ...base,
    get_settings: { ...(base.get_settings as Record<string, unknown>), loginItem: null },
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Settings' }).click();
  const login = page.getByRole('switch', { name: 'Start at login' });
  await expect(login).toBeDisabled();
  await expect(login).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText("macOS isn't answering. Restarting the Mac usually brings it back.")).toBeVisible();
});
