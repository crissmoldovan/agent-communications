import { expect, test } from '@playwright/test';
import doctorCore from '../src/test/fixtures/doctor-core.json' with { type: 'json' };
import doctorEvents from '../src/test/fixtures/doctor-events-daemon.json' with { type: 'json' };
import doctorResend from '../src/test/fixtures/doctor-resend.json' with { type: 'json' };
import doctorSlack from '../src/test/fixtures/doctor-slack.json' with { type: 'json' };
import doctorWhatsapp from '../src/test/fixtures/doctor-whatsapp.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

test('Doctor puts what to look at first, with its fix to copy, and keeps passing checks quiet', async ({ page }) => {
  await installMockIpc(page, {
    installation: {
      installed: true,
      version: '0.24.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    copy_text: null,
    cli: {
      approvalsPending: [],
      eventsStatus: { owner: 'running', enabled: true, paused: false },
      // Gmail's is left out: it runs only when the person asks.
      doctor: {
        core: doctorCore,
        slack: { ...doctorSlack, healthy: false, checks: [{ ...doctorSlack.checks[0], status: 'fail' }] },
        resend: doctorResend,
        whatsapp: doctorWhatsapp,
        'events-daemon': doctorEvents,
      },
    },
  });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Doctor' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Doctor' })).toBeVisible();

  // One line says how it came out.
  await expect(page.locator('[data-slot="doctor-summary"]')).toHaveText('9 checks pass · 2 to look at');

  // Slack's failure, then core's warning, at the top.
  const lookAt = page.getByRole('region', { name: 'To look at' });
  await expect(lookAt.locator('li')).toHaveCount(2);
  await expect(lookAt.locator('li').nth(0)).toHaveAttribute('data-product', 'slack');
  await expect(lookAt.locator('li').nth(1)).toHaveAttribute('data-product', 'core');
  const core = lookAt.locator('li[data-product="core"]');
  await expect(core).toContainText('Gmail has accounts that no client starts');
  await expect(core).toContainText('connect one with the mcp install command');

  // Copy puts the fix on the clipboard through the app.
  await core.getByRole('button', { name: 'Copy' }).click();
  await expect(core.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() =>
    ((window as unknown as { __calls: { cmd: string; args: { text?: string } }[] }).__calls ?? [])
      .filter((call) => call.cmd === 'copy_text')
      .map((call) => call.args.text),
  );
  expect(copied).toEqual(['connect one with the mcp install command']);

  // Core's passing checks stay in its own list, quiet; the warning is not repeated there.
  const coreList = page.getByRole('region', { name: 'agent-communications' });
  await expect(coreList).toContainText('the login keychain answers');
  await expect(coreList).not.toContainText('Gmail has accounts that no client starts');

  // Gmail's waits to be asked; why is in a hint the pointer reaches.
  const gmail = page.getByRole('region', { name: 'Gmail' });
  await expect(gmail).toContainText('Not checked');
  await gmail.getByRole('button', { name: 'Why Gmail is not checked' }).hover();
  await expect(page.getByRole('tooltip')).toHaveText("Gmail's doctor calls Google, so it runs only when you ask.");

  // Only reads and the copy were asked for, and Gmail's doctor never.
  const calls = await page.evaluate(() =>
    (
      (window as unknown as { __calls: { cmd: string; args: { call?: { kind: string; product?: string } } }[] })
        .__calls ?? []
    ).map((call) =>
      call.cmd === 'cli'
        ? `cli:${call.args.call?.kind}${call.args.call?.product ? `:${call.args.call.product}` : ''}`
        : call.cmd,
    ),
  );
  expect(calls).not.toContain('cli:doctor:gmail');
  for (const call of calls) {
    expect(call).toMatch(
      /^(installation|take_deep_link|event_service_state|copy_text|plugin:event\|listen|cli:(approvalsPending|updateStatus|eventsStatus|standingList|doctor:[a-z-]+))$/,
    );
  }
});
