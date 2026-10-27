import { expect, test } from '@playwright/test';
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

test('opens on Overview with its sections', async ({ page }) => {
  await installMockIpc(page, {
    installation: {
      installed: true,
      version: '0.24.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      eventsStatus: { owner: 'not-running' },
      doctor: { core: { ok: true, checks: [] } },
    },
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Sections' }).getByRole('button');
  await expect(sections).toHaveText([
    'Overview',
    'Queue',
    'Messages New',
    'People New',
    'Accounts',
    'Connections New',
    'Approvals',
    'Activity',
    'Your agents',
    'Updates',
    'Events',
    'Workflows New',
    'Doctor',
    'Settings',
  ]);
  // Only the allowed commands were invoked, and only reads: the events service's version among them, which says whether
  // it has the queue (0.30.0), and which build the app is (0.32.0); and, once core takes messages (0.35.0), the taking
  // settings, the takes, the messages and the accounts the Queue's Not taken is joined from, and Search's upkeep,
  // which runs while the app is open.
  const commands = await page.evaluate(() =>
    ((window as unknown as { __calls: { cmd: string; args: { call?: { kind: string } } }[] }).__calls ?? []).map(
      (call) => (call.cmd === 'cli' ? `cli:${call.args.call?.kind}` : call.cmd),
    ),
  );
  expect(commands).toContain('installation');
  expect(commands).toContain('cli:approvalsPending');
  for (const command of commands) {
    expect(command).toMatch(
      /^(installation|take_deep_link|event_service_state|app_build|plugin:event\|listen|cli:(approvalsPending|updateStatus|eventsStatus|standingList|doctor|version|taking|takesList|eventsMessagesList|accounts|searchIndex))$/,
    );
  }
});
