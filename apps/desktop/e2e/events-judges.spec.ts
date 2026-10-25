import { expect, type Page, test } from '@playwright/test';
import contract from '../../../packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json' with {
  type: 'json',
};
import placeholder from '../src/test/fixtures/events-judge-model-status.unavailable-placeholder.json' with {
  type: 'json',
};
import { installMockIpc } from './support/mock-ipc.ts';

/*
 * The Judges section (0.27.1) on the Events screen, against the built UI with Tauri's IPC mocked: Jev, Laya and a local
 * model server, each with where its messages go and its state, from the events daemon's own answers
 * (`desktop-contract-judges-v1.json`). A kind that is off turns on in the terminal; one that is on turns off at once,
 * once its dialog is answered. Nothing approves.
 */

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const README =
  'https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges';

/** One of the daemon's vectors. */
function at(name: string): { kinds: unknown[]; judges: unknown[] } {
  const found = (contract as { vectors: { name: string; kinds: unknown[]; judges: unknown[] }[] }).vectors.find(
    (vector) => vector.name === name,
  );
  if (found === undefined) throw new Error(`no vector ${name}`);
  return found;
}

/** Every product installed, the events service at 0.27.0, and its kinds and judges as the vector `name` has them. */
function scenario(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const vector = at(name);
  return {
    installation: {
      installed: true,
      version: '0.27.0',
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
      eventsJudgeModelStatus: placeholder,
      judgeKindsList: vector.kinds,
      judgesList: vector.judges,
      judgeKindDisable: (contract as { disable: Record<string, unknown> }).disable.typesafe,
    },
    cliResults: { version: { status: 'version', version: '0.27.0' } },
    open_link: null,
    ...extra,
  };
}

type Recorded = { cmd: string; args: { call?: { kind: string }; command?: unknown; url?: string } };

async function calls(page: Page): Promise<Recorded[]> {
  return page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls);
}

async function openJudges(page: Page) {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Events' }).click();
  return page.getByRole('region', { name: 'Judges' });
}

test('Judges: the owner’s Mac, where Jev and a local model server are off and Laya is not offered', async ({
  page,
}) => {
  await installMockIpc(page, scenario('fresh'));
  const judges = await openJudges(page);
  const jev = judges.getByRole('region', { name: 'Jev, by TypeSafe' });
  await expect(
    jev.getByText('A hosted judge. The fields a rule names are sent to TypeSafe, with your TypeSafe API key.'),
  ).toBeVisible();
  await expect(jev.getByText('Off', { exact: true })).toBeVisible();
  await expect(jev.getByRole('button')).toHaveText(['Turn on in Terminal']);
  const laya = judges.getByRole('region', { name: 'Laya', exact: true });
  await expect(laya.getByText('A judge that runs on this Mac. Nothing leaves it.')).toBeVisible();
  await expect(laya.getByText('Unavailable', { exact: true })).toBeVisible();
  await expect(laya.getByText('Not offered in this release yet.')).toBeVisible();
  await expect(laya.getByText('E2_EXTERNAL_REFERENCE_BLOCKED')).toBeVisible();
  await expect(laya.getByRole('button')).toHaveCount(0);
  const local = judges.getByRole('region', { name: 'A local model server' });
  await expect(
    local.getByText('A model server you run on this machine, at 127.0.0.1 or ::1. Nothing leaves this machine.'),
  ).toBeVisible();
  await expect(local.getByText('Off', { exact: true })).toBeVisible();
  await expect(local.getByRole('button')).toHaveText(['Turn on in Terminal']);
});

test('Judges: Turn on in Terminal opens the terminal with judge kind enable, and approves nothing', async ({
  page,
}) => {
  await installMockIpc(
    page,
    scenario('fresh', { open_in_terminal: { outcome: 'opened', via: 'Terminal', revoked: null } }),
  );
  const judges = await openJudges(page);
  const local = judges.getByRole('region', { name: 'A local model server' });
  await local.getByRole('button', { name: 'Turn on in Terminal' }).click();
  await expect(local.getByText('Opened in Terminal.')).toBeVisible();
  const recorded = await calls(page);
  expect(recorded.filter((call) => call.cmd === 'open_in_terminal')).toEqual([
    { cmd: 'open_in_terminal', args: { command: { kind: 'judgeKindEnable', judgeKind: 'local-endpoint' } } },
  ]);
  const kinds = recorded.filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  expect(kinds).not.toContain('judgeKindDisable');
  expect(kinds).not.toContain('approvalRevoke');
  expect(recorded.map((call) => call.cmd)).not.toContain('revoke_preview');
});

test('Judges: Turn off asks first; Cancel runs nothing, and its Turn off runs that kind’s disable', async ({
  page,
}) => {
  await installMockIpc(page, scenario('typesafe-on-with-jev'));
  const judges = await openJudges(page);
  const jev = judges.getByRole('region', { name: 'Jev, by TypeSafe' });
  await expect(jev.getByText('On', { exact: true })).toBeVisible();
  await expect(jev.getByRole('cell', { name: 'jev-1.13.0' })).toBeVisible();
  const disables = async () =>
    (await calls(page)).filter((call) => call.cmd === 'cli' && call.args.call?.kind === 'judgeKindDisable');
  await jev.getByRole('button', { name: 'Turn off' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Turn off Jev, by TypeSafe?' });
  await expect(
    dialog.getByText(
      "Decisions waiting on its judges are cancelled, and its rules can't call it until it is turned on again.",
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(await disables()).toEqual([]);
  await jev.getByRole('button', { name: 'Turn off' }).click();
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect
    .poll(disables)
    .toEqual([{ cmd: 'cli', args: { call: { kind: 'judgeKindDisable', judgeKind: 'typesafe' } } }]);
  expect((await calls(page)).map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('Judges: a kind on with no judge says what is next, and How to set it up opens the README', async ({ page }) => {
  await installMockIpc(page, scenario('typesafe-on'));
  const judges = await openJudges(page);
  const jev = judges.getByRole('region', { name: 'Jev, by TypeSafe' });
  await expect(jev.getByText('Next: add a judge and its key at the terminal.')).toBeVisible();
  await jev.getByRole('link', { name: 'How to set it up' }).click();
  await expect
    .poll(async () => (await calls(page)).filter((call) => call.cmd === 'open_link'))
    .toEqual([{ cmd: 'open_link', args: { url: README } }]);
  // The window stays on the app: the link opens through open_link, never in the webview.
  expect(new URL(page.url()).hostname).toBe('localhost');
  await expect(judges.getByRole('region', { name: 'A local model server' }).getByText('Next:')).toHaveCount(0);
});

test('Judges: an events service older than judges asks for an update and reads nothing', async ({ page }) => {
  await installMockIpc(page, {
    ...scenario('fresh'),
    cliResults: { version: { status: 'version', version: '0.16.0' } },
  });
  const judges = await openJudges(page);
  await expect(judges.getByText('Update agent-communications to use this')).toBeVisible();
  await expect(judges.getByText('Needs 0.17.0 or later; this machine has 0.16.0.')).toBeVisible();
  await expect(judges.getByRole('button')).toHaveCount(0);
  const kinds = (await calls(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call?.kind);
  expect(kinds).not.toContain('judgeKindsList');
  expect(kinds).not.toContain('judgesList');
});
