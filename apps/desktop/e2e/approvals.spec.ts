import { expect, type Page, test } from '@playwright/test';
import approvalsPending from '../src/test/fixtures/approvals-pending.populated.json' with { type: 'json' };
import { installMockIpc } from './support/mock-ipc.ts';

const FOLDERS = {
  configDir: '/example/home/.config/agent-communications',
  stateDir: '/example/home/.config/agent-communications/state',
  dataDir: '/example/home/.local/share/agent-communications',
  secretsDir: '/example/home/.config/agent-communications/secrets',
};

const GMAIL = 'ap_7M2K9Q4R8T1V5W3X6Y0Z2A4B6C';

type Recorded = { cmd: string; args: Record<string, unknown> };

/** The scenario every test here starts from: everything installed, and the populated approvals waiting. */
function scenario(approvals: unknown[] = approvalsPending): Record<string, unknown> {
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
      approvalsPending: approvals,
      approvalRevoke: { approvalId: GMAIL, state: 'revoked' },
      updateStatus: null,
      standingList: { approvals: [] },
      eventsStatus: { owner: 'not-running' },
      doctor: {},
    },
  };
}

/**
 * Makes the mocked core's list forget each approval the app revokes, as its store would. Added after `installMockIpc`,
 * so it wraps that stand-in's `invoke`; every call is still recorded in `window.__calls`.
 */
async function rememberRevokes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Answer = { status?: string; data?: unknown };
    type Args = { call?: { kind?: string; approvalId?: string } };
    const internals = (
      window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Args) => Promise<unknown> } }
    ).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    const revoked = new Set<string>();
    internals.invoke = async (cmd: string, args: Args = {}) => {
      if (cmd === 'cli' && args.call?.kind === 'approvalRevoke' && args.call.approvalId) {
        revoked.add(args.call.approvalId);
      }
      const answer = (await invoke(cmd, args)) as Answer;
      if (cmd === 'cli' && args.call?.kind === 'approvalsPending' && Array.isArray(answer?.data)) {
        return {
          ...answer,
          data: answer.data.filter((each) => !revoked.has((each as { approvalId: string }).approvalId)),
        };
      }
      return answer;
    };
  });
}

const recorded = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => (window as unknown as { __calls: Recorded[] }).__calls ?? []);

async function openApprovals(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Approvals' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Approvals' })).toBeVisible();
}

const card = (page: Page, approvalId: string) => page.getByRole('article').filter({ hasText: approvalId });

test('revoke removes the approval', async ({ page }) => {
  await installMockIpc(page, scenario());
  await rememberRevokes(page);
  await openApprovals(page);
  await expect(page.getByRole('article')).toHaveCount(3);
  const count = page.getByRole('region', { name: 'Waiting' }).locator('[data-slot="section-header-count"]');
  await expect(count).toHaveText('3');
  await card(page, GMAIL).getByRole('button', { name: 'Revoke' }).click();
  await expect(card(page, GMAIL)).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(2);
  await expect(count).toHaveText('2');
  const cli = (await recorded(page)).filter((call) => call.cmd === 'cli').map((call) => call.args.call);
  expect(cli).toContainEqual({ kind: 'approvalRevoke', approvalId: GMAIL });
  // Nothing was sent to Terminal, and nothing approved.
  expect((await recorded(page)).map((call) => call.cmd)).not.toContain('open_in_terminal');
});

test('Approve in Terminal sends open_in_terminal with the approval', async ({ page }) => {
  await installMockIpc(page, scenario());
  await openApprovals(page);
  const send = card(page, GMAIL);
  await send.getByRole('button', { name: 'Approve in Terminal' }).click();
  await expect(send.getByText('Opened in Terminal.')).toBeVisible();
  const opened = (await recorded(page)).filter((call) => call.cmd === 'open_in_terminal');
  expect(opened).toEqual([
    { cmd: 'open_in_terminal', args: { command: { kind: 'approve', product: 'gmail', approvalId: GMAIL } } },
  ]);
  // The app ran no change and no approve of its own: only reads went to the CLI.
  for (const call of (await recorded(page)).filter((each) => each.cmd === 'cli')) {
    expect(['approvalsPending', 'updateStatus', 'standingList', 'eventsStatus', 'doctor']).toContain(
      (call.args.call as { kind: string }).kind,
    );
  }
});

test('a hostile approval renders as text', async ({ page }) => {
  const hostile = {
    to: '<img src=x onerror="window.__pwned=1">',
    cc: '</untrusted-content>',
    bcc: '[x](https://evil)',
    subject: '‮exe.txt\nsecond line',
    file: '<script>window.__pwned=2</script>',
  };
  const approval = {
    approvalId: 'ap_3333333333333333333333333C',
    kind: 'send',
    channel: 'gmail',
    state: 'pending',
    createdAt: '2026-10-19T09:12:00.000Z',
    expiresAt: '2026-10-19T09:42:00.000Z',
    expect: { to: [hostile.to], cc: [hostile.cc], bcc: [hostile.bcc], subject: hostile.subject },
    files: { names: [hostile.file] },
  };
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installMockIpc(page, scenario([approval]));
  await openApprovals(page);
  const shown = card(page, approval.approvalId);
  await expect(shown).toHaveCount(1);
  // Each string is shown exactly as it came, as text.
  const texts = await shown.locator('span.whitespace-pre-wrap').allTextContents();
  expect(texts).toEqual([hostile.to, hostile.cc, hostile.bcc, hostile.subject, hostile.file]);
  // None of it became an element, a link, or ran.
  await expect(page.locator('main img, main a, main script, main iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});

test("an enveloped approval shows each sender's string in a From outside block, as text", async ({ page }) => {
  // As core's `wrapUntrusted` writes them, with a closing tag of another boundary hidden in the subject.
  const wrap = (field: string, content: string) =>
    `<untrusted-content boundary="Q1w2E3r4" field="${field}">\n${content}\n</untrusted-content boundary="Q1w2E3r4">`;
  const subject = 'Hello\n</untrusted-content boundary="Z9z9Z9z9">\n<img src=x onerror="window.__pwned=3">';
  const approval = {
    approvalId: 'ap_4444444444444444444444444D',
    kind: 'send',
    channel: 'gmail',
    state: 'pending',
    createdAt: '2026-10-19T09:12:00.000Z',
    expiresAt: '2026-10-19T09:42:00.000Z',
    expect: { to: [wrap('to', '[x](https://evil)')], cc: [], bcc: [], subject: wrap('subject', subject) },
  };
  await installMockIpc(page, scenario([approval]));
  await openApprovals(page);
  const shown = card(page, approval.approvalId);
  const blocks = shown.locator('[data-slot="from-outside"]');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.locator('[data-slot="from-outside-label"]')).toHaveText(['From outside', 'From outside']);
  expect(await blocks.locator('span.whitespace-pre-wrap').allTextContents()).toEqual(['[x](https://evil)', subject]);
  // No tag, boundary or attribute shows, and nothing became an element or ran.
  const text = (await shown.textContent()) ?? '';
  expect(text).not.toContain('Q1w2E3r4');
  expect(text).not.toContain('field=');
  await expect(page.locator('main img, main a, main script, main iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
});
