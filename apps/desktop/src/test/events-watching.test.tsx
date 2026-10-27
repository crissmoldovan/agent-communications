/*
 * Events → Service, in plain words (0.34.0 design B4) and Events → Deliveries' dry-run log (B5). Switching on is
 * prepared with `enable-all`, its preview read without a challenge, and approved only by the person's press: in the app
 * on macOS (`collection approve <approval> --digest <digest>`), at a terminal elsewhere (`approve <approval>`). Switch
 * off applies at once once confirmed, and says what the service said. Every answer is a fixture written to the shapes
 * the event service's own tests print (`enable-all-app-approval.test.ts`).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call, CliResult, TerminalCommand } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, type Fixture, failed, ok } from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.v032.json';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
import { renderApp } from './render.tsx';

// The event service takes the app's own approval only where the app is attested (macOS). These tests run as macOS
// unless one says otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

/** A screen that reads under a loaded machine: each test is given room. */
const SLOW = { timeout: 30_000 };

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const DIGEST = '0f'.repeat(32);
const WATCH = 'Watching your accounts';
const ASK = 'Switch on watching? Approve it';
const SAID =
  "Switched off: the event service is still running but no longer watches your accounts, so no rule does anything. Your rules are kept. Cleared: deliveries not yet sent and what failed ones kept, the Queue's items, the dry-run log and approvals not yet given; each lane's window is unbound. Switching on again needs your approval.";

/** `enable-all --json`: the approval, and the digest its preview binds. */
const PREPARED = {
  intentId: 'in_switch',
  approvalId: ID,
  binding: {
    digest: DIGEST,
    activationKind: 'enable-all',
    versions: [{ kind: 'rule', id: 'mail-subject', version: 1 }],
  },
  kind: 'enable-all',
  status: 'pending',
};

/** `approval view <id> --digest <digest> --json`, as the window gets it: its challenge already taken out by Rust. */
function view(ruleVersions: { ruleId: string; ruleVersion: number }[]) {
  return {
    kind: 'READY',
    approvalId: ID,
    digest: DIGEST,
    preview: { documentVersion: 1, kind: 'enable-all', switchGeneration: 3, ruleVersions },
    pendingTargetSelectors: [],
    challenge: { approvalId: ID, digest: DIGEST, expiresAt: 1792929600000 },
  };
}

const START = [
  { ruleId: 'mail-subject', ruleVersion: 1 },
  { ruleId: 'david-on-slack', ruleVersion: 1 },
];

/**
 * The event service at `version` (0.34.0 by default), switched off until the app approves switching on, with the
 * 0.32.0 rules and deliveries. `approve` answers `collection approve`.
 */
function switchBridge(
  options: {
    version?: string;
    enabled?: boolean;
    paused?: boolean;
    approve?: () => CliResult;
    fixtures?: Partial<Record<Call['kind'], Fixture>>;
  } = {},
): FakeBridge {
  let enabled = options.enabled ?? false;
  const paused = options.paused ?? false;
  const fixtures: Partial<Record<Call['kind'], Fixture>> = {
    version: options.version ?? '0.34.0',
    eventsStatus: () => ({ owner: 'running', enabled, paused, switchGeneration: 3, activationIntents: [] }),
    eventsRules: rules,
    eventsRuleShow: (call: Call) =>
      (shows as Record<string, unknown[]>)[(call as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId] ?? [],
    eventsDeliveries: deliveries,
    eventsEnableAll: PREPARED,
    eventsApprovalView: view(START),
    eventsDisableAll: () => {
      enabled = false;
      return { enabled: false, paused: false, switchGeneration: 4, said: SAID };
    },
    ...options.fixtures,
  };
  const inner = createFakeBridge({}, fixtures);
  return createFakeBridge(
    {
      cli: async (call) => {
        if (call.kind !== 'eventsCollectionApprove') return inner.cli(call);
        const answer =
          options.approve?.() ??
          ok({ approvalId: ID, approved: true, approvedBy: 'desktop-app', ruleVersions: START, completion: {} });
        if (answer.status === 'ok') enabled = true;
        return answer;
      },
    },
    fixtures,
  );
}

/** The section, once its state is read. */
async function shown(word: string): Promise<HTMLElement> {
  const section = await screen.findByRole('region', { name: WATCH });
  await waitFor(() => expect(section.querySelector('[data-slot="watch-state"]')?.textContent).toBe(word));
  return section;
}

/** Switch on…, pressed, and its preview, once it shows. */
async function switchOn(section: HTMLElement): Promise<HTMLElement> {
  fireEvent.click(await within(section).findByRole('button', { name: 'Switch on…' }));
  return within(section).findByRole('region', { name: ASK });
}

const calls = (bridge: FakeBridge) =>
  bridge.calls.filter((each) => each.command === 'cli').map((each) => each.args as Call);
const opened = (bridge: FakeBridge) =>
  bridge.calls.filter((each) => each.command === 'openInTerminal').map((each) => each.args as TerminalCommand);
const revoked = (bridge: FakeBridge) =>
  bridge.calls.filter((each) => each.command === 'revokePreview').map((each) => each.args);

describe('Events → Service: whether the event service watches your accounts', () => {
  it(
    'Switched off: Switch on… shows what would start, and only Approve switches it on, for that digest',
    SLOW,
    async () => {
      const bridge = switchBridge();
      renderApp(bridge, { screen: 'events' });
      const section = await shown('Switched off');
      expect(section.textContent).toContain(
        "The event service is running, but it isn't watching your accounts, so no workflow does anything.",
      );
      // Neither Pause nor Resume does anything here, so neither is offered.
      expect(within(section).queryByRole('button', { name: 'Pause' })).toBeNull();
      expect(within(section).queryByRole('button', { name: 'Resume' })).toBeNull();
      const ask = await switchOn(section);
      // The preview is the event service's own: each rule that would start, the account it watches and where its
      // matches go. Nothing is approved yet.
      expect(calls(bridge)).toContainEqual({ kind: 'eventsEnableAll' });
      expect(calls(bridge)).toContainEqual({ kind: 'eventsApprovalView', approvalId: ID, digest: DIGEST });
      expect(cliKinds(bridge)).not.toContain('eventsCollectionApprove');
      await waitFor(() =>
        expect(ask.textContent).toContain(
          'Switching on lets your workflows watch in_01EXAMPLE0000000000000099 and example/slack for new messages.',
        ),
      );
      const lines = [...ask.querySelectorAll('[data-rule-start]')].map((line) => line.textContent);
      expect(lines).toEqual([
        'mail-subject · in_01EXAMPLE0000000000000099 · writes each match to the dry-run log, for you to read',
        'david-on-slack · example/slack · adds each match to the Queue, for an agent to work through',
      ]);
      fireEvent.click(within(ask).getByRole('button', { name: 'Approve' }));
      expect(
        await within(section).findByText(
          'Approved. Your workflows are watching in_01EXAMPLE0000000000000099 and example/slack.',
        ),
      ).toBeTruthy();
      expect(calls(bridge).filter((call) => call.kind === 'eventsCollectionApprove')).toEqual([
        { kind: 'eventsCollectionApprove', approvalId: ID, digest: DIGEST },
      ]);
      // The status is read again: on, watching the accounts its rules name, with Pause and Switch off.
      await shown('On');
      expect(section.textContent).toContain(
        'Watching example/gmail, example/slack and in_01EXAMPLE0000000000000099. 4 workflows active.',
      );
      expect(within(section).getByRole('button', { name: 'Pause' })).toBeTruthy();
      expect(within(section).getByRole('button', { name: 'Switch off' })).toBeTruthy();
      expect(opened(bridge)).toEqual([]);
      expect(revoked(bridge)).toEqual([]);
    },
  );

  it('Cancel revokes the approval and says nothing changed; a hostile rule id stays text', SLOW, async () => {
    const bridge = switchBridge({
      fixtures: { eventsApprovalView: view([{ ruleId: '<img src=x onerror=alert(1)>', ruleVersion: 1 }]) },
    });
    renderApp(bridge, { screen: 'events' });
    const section = await shown('Switched off');
    const ask = await switchOn(section);
    expect(await within(ask).findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(ask.querySelector('img')).toBeNull();
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(await within(section).findByText('Cancelled: nothing was changed. Watching stays off.')).toBeTruthy();
    expect(revoked(bridge)).toEqual([ID]);
    expect(cliKinds(bridge)).not.toContain('eventsCollectionApprove');
    expect(within(section).queryByRole('region', { name: ASK })).toBeNull();
  });

  it(
    'where the app cannot attest the person, the approval is Do it in Terminal: approve <id>, and Done reads again',
    SLOW,
    async () => {
      platform.mac = false;
      const bridge = switchBridge();
      renderApp(bridge, { screen: 'events' });
      const ask = await switchOn(await shown('Switched off'));
      expect(within(ask).queryByRole('button', { name: 'Approve' })).toBeNull();
      fireEvent.click(await within(ask).findByRole('button', { name: 'Do it in Terminal' }));
      await waitFor(() => expect(opened(bridge)).toEqual([{ kind: 'ruleApprove', approvalId: ID }]));
      const reads = cliKinds(bridge).filter((kind) => kind === 'eventsStatus').length;
      fireEvent.click(await within(ask).findByRole('button', { name: 'Done' }));
      await waitFor(() =>
        expect(cliKinds(bridge).filter((kind) => kind === 'eventsStatus').length).toBeGreaterThan(reads),
      );
      // The terminal has it: nothing is revoked, and the app never answers it.
      expect(revoked(bridge)).toEqual([]);
      expect(cliKinds(bridge)).not.toContain('eventsCollectionApprove');
    },
  );

  it(
    'refused in the app as unattested, the same approval goes to the terminal; refused as changed, it is prepared again',
    SLOW,
    async () => {
      const unattested = failed(
        'CLI_FAILED',
        "nothing on this platform attests that the Agent Comms app started this, so switch the event service on at your terminal, with the event service's approve ap_0123456789ABCDEFGHJKMNPQRS, which shows its preview and asks for its challenge",
        null,
        10,
      );
      const first = renderApp(switchBridge({ approve: () => unattested }), { screen: 'events' });
      let ask = await switchOn(await shown('Switched off'));
      fireEvent.click(within(ask).getByRole('button', { name: 'Approve' }));
      expect(await within(ask).findByRole('button', { name: 'Do it in Terminal' })).toBeTruthy();
      expect(within(ask).getByRole('alert').textContent).toContain('Not switched on: nothing on this platform attests');
      first.unmount();

      const changed = failed(
        'CLI_FAILED',
        'what switching on covers changed after you saw its preview: review it again',
        null,
        10,
      );
      const bridge = switchBridge({ approve: () => changed });
      renderApp(bridge, { screen: 'events' });
      const section = await shown('Switched off');
      ask = await switchOn(section);
      fireEvent.click(within(ask).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(within(section).queryByRole('region', { name: ASK })).toBeNull());
      expect(within(section).getByRole('alert').textContent).toBe(
        'Not switched on: what switching on covers changed after you saw its preview: review it again Press Switch on… to see its preview again.',
      );
      await waitFor(() => expect(revoked(bridge)).toEqual([ID]));
      expect(opened(bridge)).toEqual([]);
      expect(within(section).getByRole('button', { name: 'Switch on…' })).toBeTruthy();
    },
  );

  it('On: Switch off asks first, applies at once, and says what the event service said', SLOW, async () => {
    const bridge = switchBridge({ enabled: true });
    renderApp(bridge, { screen: 'events' });
    const section = await shown('On');
    // Asked first: Cancel runs nothing.
    fireEvent.click(within(section).getByRole('button', { name: 'Switch off' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Switch off watching?' });
    expect(dialog.textContent).toContain('Your workflows are kept');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(cliKinds(bridge)).not.toContain('eventsDisableAll');
    fireEvent.click(within(section).getByRole('button', { name: 'Switch off' }));
    dialog = await screen.findByRole('alertdialog', { name: 'Switch off watching?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    expect(await within(section).findByText(SAID)).toBeTruthy();
    expect(cliKinds(bridge).filter((kind) => kind === 'eventsDisableAll')).toHaveLength(1);
    await shown('Switched off');
    expect(within(section).getByRole('button', { name: 'Switch on…' })).toBeTruthy();
  });

  it('Paused: Resume, and Switch off; never Pause', SLOW, async () => {
    renderApp(switchBridge({ enabled: true, paused: true }), { screen: 'events' });
    const section = await shown('Paused');
    expect(section.textContent).toContain('Not watching; nothing new is collected.');
    expect(within(section).getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Switch off' })).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it(
    'an event service before 0.34.0 approves switching on in Terminal and offers no Switch off; before 0.33.0, neither',
    SLOW,
    async () => {
      const older = switchBridge({ version: '0.33.0' });
      const first = renderApp(older, { screen: 'events' });
      const ask = await switchOn(await shown('Switched off'));
      // Even on macOS: that service has no `collection approve`.
      expect(within(ask).queryByRole('button', { name: 'Approve' })).toBeNull();
      fireEvent.click(await within(ask).findByRole('button', { name: 'Do it in Terminal' }));
      await waitFor(() => expect(opened(older)).toEqual([{ kind: 'ruleApprove', approvalId: ID }]));
      first.unmount();

      const on = renderApp(switchBridge({ version: '0.33.0', enabled: true }), { screen: 'events' });
      const section = await shown('On');
      expect(within(section).queryByRole('button', { name: 'Switch off' })).toBeNull();
      expect(within(section).getByRole('button', { name: 'Pause' })).toBeTruthy();
      on.unmount();

      const oldest = switchBridge({ version: '0.32.0' });
      renderApp(oldest, { screen: 'events' });
      const off = await shown('Switched off');
      expect(within(off).queryByRole('button', { name: 'Switch on…' })).toBeNull();
      expect(off.textContent).toContain('Update agent-communications to switch watching on here.');
      expect(off.textContent).toContain('Needs 0.33.0 or later; this machine has 0.32.0.');
      expect(cliKinds(oldest)).not.toContain('eventsEnableAll');
    },
  );
});

/** The 0.32.0 fixtures' morning: the dry run's entry, written at 10:02 UTC, is kept until 10:02 the next day. */
const KEPT = new Date('2026-10-25T12:30:00.000Z');
const GONE = new Date('2026-10-26T12:30:00.000Z');
const DRY = '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b03';

async function deliveriesTab(): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^Deliveries\b/ });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
  return screen.findByRole('region', { name: 'Deliveries' });
}

const rowIds = (view: HTMLElement) =>
  [...view.querySelectorAll<HTMLElement>('[data-delivery]')].map((each) => each.dataset.delivery);

describe('Events → Deliveries: the dry-run log, and who can read it', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a rule in dry-run says so above the rows, and the Dry-run log filter lists what it wrote', SLOW, async () => {
    vi.setSystemTime(KEPT);
    renderApp(switchBridge({ enabled: true }), { screen: 'events' });
    const view = await deliveriesTab();
    const note = await waitFor(() => {
      const found = view.querySelector<HTMLElement>('[data-slot="in-dry-run"]');
      if (found === null) throw new Error('no dry-run line');
      return found;
    });
    expect(note.textContent).toContain(
      "mail-subject is in dry-run: each match is written to the dry-run log instead of being sent anywhere. Agents can't read it through their tools; one with a terminal, such as Claude Code, runs commands as you and can.",
    );
    await waitFor(() => expect(rowIds(view)).toHaveLength(deliveries.length));
    fireEvent.click(within(note).getByRole('button', { name: 'Open the dry-run log ›' }));
    await waitFor(() => expect(rowIds(view)).toEqual([DRY]));
    const show = within(view).getByRole('group', { name: 'Show' });
    expect(within(show).getByRole('button', { name: 'Dry-run log 1' }).getAttribute('aria-pressed')).toBe('true');
    // Its rows still open each record's page.
    expect(view.querySelector(`[data-delivery="${DRY}"]`)?.tagName).toBe('BUTTON');
  });

  it('a dry run whose entry is gone keeps its row, folded as removed after 24 hours', SLOW, async () => {
    vi.setSystemTime(GONE);
    renderApp(switchBridge({ enabled: true }), { screen: 'events' });
    const view = await deliveriesTab();
    await waitFor(() => expect(rowIds(view)).toHaveLength(deliveries.length - 1));
    expect(rowIds(view)).not.toContain(DRY);
    const fold = await waitFor(() => {
      const found = view.querySelector<HTMLElement>('[data-slot="removed-fold"]');
      if (found === null) throw new Error('no fold');
      return found;
    });
    expect(fold.textContent).toContain('1 removed after 24 hours');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(fold);
    await waitFor(() => expect(rowIds(view)).toContain(DRY));
    const dry = view.querySelector<HTMLElement>(`[data-delivery="${DRY}"]`);
    expect(dry?.textContent).toContain('Removed');
    expect(dry?.textContent).toContain('kept 24 hours, then removed');
  });

  it(
    'Something reached your agent? links to the Queue, Settings → Integrations and the dry-run log',
    SLOW,
    async () => {
      vi.setSystemTime(KEPT);
      renderApp(switchBridge({ enabled: true }), { screen: 'events' });
      const view = await deliveriesTab();
      const note = await within(view).findByRole('complementary', { name: 'Something reached your agent?' });
      expect(note.textContent).toContain('Two are meant for an agent; the dry-run log is meant for you.');
      fireEvent.click(within(note).getByRole('button', { name: 'Open the dry-run log ›' }));
      await waitFor(() => expect(rowIds(view)).toEqual([DRY]));
      fireEvent.click(within(note).getByRole('button', { name: 'Settings → Integrations ›' }));
      expect(await screen.findByRole('region', { name: 'Integrations' }, { timeout: SLOW.timeout })).toBeTruthy();
    },
  );

  it('Open the Queue goes to the Queue', SLOW, async () => {
    vi.setSystemTime(KEPT);
    renderApp(switchBridge({ enabled: true }), { screen: 'events' });
    const view = await deliveriesTab();
    const note = await within(view).findByRole('complementary', { name: 'Something reached your agent?' });
    fireEvent.click(within(note).getByRole('button', { name: 'Open the Queue ›' }));
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    await waitFor(() =>
      expect(
        within(navigation)
          .getByRole('button', { name: /^Queue/ })
          .getAttribute('aria-current'),
      ).toBe('page'),
    );
  });
});
