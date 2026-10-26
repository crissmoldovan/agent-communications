import { expect, test } from '@playwright/test';
import approvalsPending from '../src/test/fixtures/approvals-pending.populated.json' with { type: 'json' };
import doctorCore from '../src/test/fixtures/doctor-core.json' with { type: 'json' };
import doctorEvents from '../src/test/fixtures/doctor-events-daemon.json' with { type: 'json' };
import doctorResend from '../src/test/fixtures/doctor-resend.json' with { type: 'json' };
import doctorSlack from '../src/test/fixtures/doctor-slack.json' with { type: 'json' };
import doctorWhatsapp from '../src/test/fixtures/doctor-whatsapp.json' with { type: 'json' };
import eventsStatus from '../src/test/fixtures/events-status.running.json' with { type: 'json' };
import standingList from '../src/test/fixtures/standing-list.json' with { type: 'json' };
import updateStatus from '../src/test/fixtures/update-status.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

test('Overview shows the version, approvals waiting and each doctor', async ({ page }) => {
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
      approvalsPending,
      updateStatus,
      standingList,
      eventsStatus,
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
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  // The three readings a person looks for first are tiles: each its label, then its reading.
  const reading = (name: string) => page.getByRole('region', { name }).locator('[data-slot="tile-reading"]');
  await expect(reading('agent-communications')).toHaveText('0.24.0');
  const waiting = page.getByRole('region', { name: 'Approvals waiting' });
  await expect(reading('Approvals waiting')).toHaveText('3');

  // A row per doctor, each with its state.
  const doctor = page.getByRole('region', { name: 'Doctor' });
  const tone = (product: string) =>
    doctor.locator(`[data-product="${product}"] [role="status"][data-tone]`).getAttribute('data-tone');
  await expect(doctor.locator('[data-product]')).toHaveCount(6);
  await expect(doctor.locator('[data-product="slack"] [data-tone="danger"]')).toHaveCount(1);
  expect(await tone('core')).toBe('warn');
  expect(await tone('slack')).toBe('danger');
  expect(await tone('resend')).toBe('ok');
  expect(await tone('whatsapp')).toBe('ok');
  expect(await tone('events-daemon')).toBe('ok');
  expect(await tone('gmail')).toBe('idle');

  await expect(page.getByRole('region', { name: 'Updates' })).toContainText('every-14-days');
  await expect(page.getByRole('region', { name: 'Standing approvals' })).toContainText('example/slack');
  await expect(page.getByRole('region', { name: 'Event service' })).toContainText('Running');
  // The queue's tile, beside Approvals waiting, says what an older events service needs.
  await expect(page.getByRole('region', { name: 'Queue' })).toContainText(
    'Needs 0.30.0 or later; this machine has 0.24.0.',
  );

  // Gmail's row says it waits to be asked; why is in a hint the pointer reaches.
  const gmail = doctor.locator('[data-product="gmail"]');
  await expect(gmail).toContainText('Only when you ask');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await gmail.getByRole('button', { name: "Why Gmail's doctor waits" }).hover();
  await expect(page.getByRole('tooltip')).toHaveText('Runs only when you ask, from Doctor, because it calls Google.');

  // The approvals waiting open Approvals.
  await waiting.getByRole('button', { name: 'Open Approvals' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();

  // Only reads were asked for, and Gmail's doctor never.
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
      /^(installation|take_deep_link|event_service_state|app_build|plugin:event\|listen|cli:(approvalsPending|updateStatus|eventsStatus|standingList|doctor:[a-z-]+|version:events-daemon))$/,
    );
  }
});
