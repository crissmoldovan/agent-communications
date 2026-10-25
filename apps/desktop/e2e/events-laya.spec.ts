import { expect, type Page, test } from '@playwright/test';
import disabled from '../src/test/fixtures/events-judge-model-status.disabled.json' with { type: 'json' };
import downloading from '../src/test/fixtures/events-judge-model-status.downloading.json' with { type: 'json' };
import placeholder from '../src/test/fixtures/events-judge-model-status.unavailable-placeholder.json' with {
  type: 'json',
};
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * Laya on the Events screen (E2 Task 11, desktop design DA16), now the Judges section's Laya row (0.27.1), against the
 * built UI with Tauri's IPC mocked: its status is the events daemon's, Turn on in Terminal opens the terminal with the
 * terminal-only shape, Turn off runs at once once its dialog is answered, and the placeholder release says Laya is not
 * offered. Nothing approves.
 */

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

/** Laya's entry of `judge kinds list` beside `status`, as the daemon pairs them, with Jev and a local server off. */
function kinds(status: { state: string; reason?: string | null }): unknown[] {
  const laya =
    status.state === 'unavailable'
      ? { kind: 'laya', state: 'unavailable', code: status.reason }
      : status.state === 'idle'
        ? { kind: 'laya', state: 'disabled', version: null }
        : { kind: 'laya', state: 'enabled', version: 1 };
  return [
    { kind: 'typesafe', state: 'disabled', version: null },
    laya,
    { kind: 'local-endpoint', state: 'disabled', version: null },
  ];
}

/** Every product installed; the events service at the first version with Laya's calls, and Laya's status `status`. */
function scenario(
  status: { state: string; reason?: string | null },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    installation: {
      installed: true,
      version: '0.25.0',
      present: ['core', 'gmail', 'slack', 'resend', 'whatsapp', 'events-daemon'],
      folders: FOLDERS,
      problem: null,
    },
    take_deep_link: null,
    cli: {
      approvalsPending: [],
      updateStatus: null,
      doctor: { core: { ok: true, checks: [] } },
      eventsStatus: { owner: 'running', enabled: true, paused: false },
      eventsRules: [],
      eventsDeliveries: [],
      eventsJudgeModelStatus: status,
      eventsJudgeKindDisable: { kind: 'laya', disabled: true, pointer: 'removed', pendingActivationsCancelled: 0 },
      judgeKindsList: kinds(status),
      judgesList: [],
    },
    cliResults: { version: { status: 'version', version: '0.25.0' } },
    ...extra,
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string }; command?: unknown } };

async function calls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
}

async function openLaya(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  return page.getByRole('region', { name: 'Laya', exact: true });
}

test('Laya: a disabled kind offers Turn on in Terminal, which opens the terminal and approves nothing', async ({
  page,
}) => {
  await installMockIpc(
    page,
    scenario(disabled, { open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: null } }),
  );
  const laya = await openLaya(page);
  await expect(laya.getByText('idle', { exact: true })).toBeVisible();
  await expect(laya.getByText('0 of 154 bytes')).toBeVisible();
  await expect(laya.getByText('Off', { exact: true })).toBeVisible();
  await expect(laya.getByRole('button')).toHaveText(['Turn on in Terminal']);
  await laya.getByRole('button', { name: 'Turn on in Terminal' }).click();
  await expect(laya.getByText('Opened in Terminal.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'open_in_terminal')).toEqual([
    { cmd: 'open_in_terminal', args: { command: { kind: 'eventsJudgeKindEnable' } } },
  ]);
  // The app ran no change and revoked nothing: the preview and the approval are the terminal's.
  const kinds = recorded.filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  expect(kinds).not.toContain('eventsJudgeKindDisable');
  expect(kinds).not.toContain('approvalRevoke');
  expect(recorded.map((call) => call.cmd)).not.toContain('revoke_preview');
});

test('Laya: a download shows its bytes as the daemon sent them, and Turn off applies at once', async ({ page }) => {
  await installMockIpc(page, scenario(downloading));
  const laya = await openLaya(page);
  await expect(laya.getByText('downloading', { exact: true })).toBeVisible();
  await expect(laya.getByText('81 of 154 bytes')).toBeVisible();
  await expect(laya.getByText('On', { exact: true })).toBeVisible();
  await expect(laya.getByRole('button')).toHaveText(['Turn off']);
  const reads = async () =>
    (await calls(page)).filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'eventsJudgeModelStatus')
      .length;
  const before = await reads();
  await laya.getByRole('button', { name: 'Turn off' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Turn off Laya?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect.poll(reads).toBeGreaterThan(before);
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'eventsJudgeKindDisable')).toEqual([
    { cmd: 'cli', args: { call: { kind: 'eventsJudgeKindDisable' } } },
  ]);
  expect(recorded.map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('Laya: the placeholder release says Laya is not offered, with no button', async ({ page }) => {
  await installMockIpc(page, scenario(placeholder));
  const laya = await openLaya(page);
  await expect(laya.getByText("Laya isn't offered in this release.")).toBeVisible();
  await expect(laya.getByText('E2_EXTERNAL_REFERENCE_BLOCKED')).toBeVisible();
  await expect(laya.getByText('unavailable', { exact: true })).toBeVisible();
  await expect(laya.getByText('Unavailable', { exact: true })).toBeVisible();
  // Its details already say it is not offered, so the row does not say it again.
  await expect(laya.getByText('Not offered in this release yet.')).toHaveCount(0);
  await expect(laya.getByRole('button')).toHaveCount(0);
});

test('Laya: an events service from before E2 asks for an update and reads nothing', async ({ page }) => {
  const older = scenario(downloading);
  await installMockIpc(page, {
    ...older,
    // Its kinds list names Laya as B3 did before E2.
    cli: {
      ...(older.cli as Record<string, unknown>),
      judgeKindsList: [
        { kind: 'typesafe', state: 'disabled', version: null },
        { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' },
        { kind: 'local-endpoint', state: 'disabled', version: null },
      ],
    },
    cliResults: { version: { status: 'version', version: '0.24.0' } },
  });
  const laya = await openLaya(page);
  await expect(laya.getByText('Update agent-communications to use this')).toBeVisible();
  await expect(laya.getByText('Needs 0.25.0 or later; this machine has 0.24.0.')).toBeVisible();
  await expect(laya.getByRole('button')).toHaveCount(0);
  const kinds = (await calls(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  expect(kinds).not.toContain('eventsJudgeModelStatus');
});
