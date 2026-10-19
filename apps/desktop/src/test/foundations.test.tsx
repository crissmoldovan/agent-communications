import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeProvider } from '../bridge-context.tsx';
import { ChangePreview } from '../components/ChangePreview.tsx';
import { TerminalResult } from '../components/TerminalResult.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { COPY } from '../copy.ts';
import { AppDataProvider, useAppData } from '../data.tsx';
import { INSTALL_COMMAND } from '../install.ts';
import type { Call, Installation } from '../ipc.ts';
import { cliKinds, createFakeBridge, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';

/** Lets every pending promise settle, and React render what they set. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('the app before anything is installed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with no core launcher only the install screen shows and nothing runs', async () => {
    const notInstalled: Installation = { ...EXAMPLE_INSTALLATION, installed: false, version: null, present: [] };
    const bridge = createFakeBridge({ installation: async () => notInstalled });
    renderApp(bridge);
    await settle();
    const lines = [
      "agent-communications isn't installed for this user.",
      'Run this in a terminal, then come back to this window:',
      'If you keep its folders elsewhere with AGENT_COMMS_* variables, set the same folders in Settings.',
    ];
    for (const line of lines) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getByText(INSTALL_COMMAND)).toBeTruthy();
    // In that order.
    const text = document.body.textContent ?? '';
    const positions = [lines[0], lines[1], INSTALL_COMMAND, lines[2]].map((line) => text.indexOf(line ?? ''));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // No sections: only the install screen.
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Overview')).toBeNull();
    // And nothing runs, now or later.
    await advance(60_000);
    expect(bridge.calls.filter((call) => call.command === 'cli')).toEqual([]);
  });
});

describe('the data the screens share', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls every 15 seconds while visible and stops when hidden', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    await settle();
    const count = (kind: Call['kind']) => cliKinds(bridge).filter((each) => each === kind).length;
    expect(count('approvalsPending')).toBe(1);
    expect(count('updateStatus')).toBe(1);
    expect(count('eventsStatus')).toBe(1);
    await advance(14_000);
    expect(count('approvalsPending')).toBe(1);
    await advance(1_000);
    expect(count('approvalsPending')).toBe(2);
    expect(count('updateStatus')).toBe(2);
    expect(count('eventsStatus')).toBe(2);
    // Hidden to the tray: nothing more runs.
    await act(async () => bridge.emit('window-visibility', { visible: false }));
    await advance(60_000);
    expect(count('approvalsPending')).toBe(2);
    // Shown again: at once, then every 15 seconds.
    await act(async () => bridge.emit('window-visibility', { visible: true }));
    await settle();
    expect(count('approvalsPending')).toBe(3);
    await advance(15_000);
    expect(count('approvalsPending')).toBe(4);
    // A document the browser hides counts as hidden too.
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await advance(45_000);
    expect(count('approvalsPending')).toBe(4);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await settle();
    expect(count('approvalsPending')).toBe(5);
    // A change the tray made, and the window's focus, each refresh at once.
    await act(async () => bridge.emit('data-changed', null));
    await settle();
    expect(count('approvalsPending')).toBe(6);
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(count('approvalsPending')).toBe(7);
  });

  it('polls only the reads this machine has: no events without its launcher', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    renderApp(bridge);
    await settle();
    await advance(15_000);
    expect(cliKinds(bridge).filter((kind) => kind === 'eventsStatus')).toEqual([]);
    expect(cliKinds(bridge).filter((kind) => kind === 'approvalsPending')).toHaveLength(2);
  });

  it("runs the doctors once at start, Gmail's never unasked", async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    await settle();
    await advance(120_000);
    const doctors = bridge.calls
      .filter((call) => call.command === 'cli' && (call.args as Call).kind === 'doctor')
      .map((call) => (call.args as Extract<Call, { kind: 'doctor' }>).product)
      .sort();
    expect(doctors).toEqual(['core', 'events-daemon', 'resend', 'slack', 'whatsapp']);
  });

  it('runs a doctor that is not present never, even at start', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'slack'] }),
    });
    renderApp(bridge);
    await settle();
    const doctors = bridge.calls
      .filter((call) => call.command === 'cli' && (call.args as Call).kind === 'doctor')
      .map((call) => (call.args as Extract<Call, { kind: 'doctor' }>).product)
      .sort();
    expect(doctors).toEqual(['core', 'slack']);
  });

  it('a deep link opens Approvals with that id', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeTruthy();
    await act(async () => bridge.emit('deep-link', { approvalId: ID }));
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    // The screen is handed the id: the shared data holds it until the screen clears it.
    let seen: string | null = null;
    function Probe() {
      seen = useAppData().deepLink?.approvalId ?? null;
      return null;
    }
    const launched = createFakeBridge({ takeDeepLink: async () => ({ approvalId: ID }) });
    render(
      <BridgeProvider bridge={launched}>
        <AppDataProvider>
          <Probe />
        </AppDataProvider>
      </BridgeProvider>,
    );
    await settle();
    expect(seen).toBe(ID);
  });

  it('a link that launched the app opens Approvals too', async () => {
    const bridge = createFakeBridge({ takeDeepLink: async () => ({ approvalId: ID }) });
    renderApp(bridge);
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
  });
});

describe('the shell', () => {
  it('the sidebar has the seven sections in order, then Settings', async () => {
    renderApp(createFakeBridge());
    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    const items = within(navigation)
      .getAllByRole('button')
      .map((button) => button.textContent?.trim());
    expect(items).toEqual(['Overview', 'Accounts', 'Approvals', 'Agent', 'Updates', 'Events', 'Doctor', 'Settings']);
    // Each opens its screen.
    fireEvent.click(within(navigation).getByRole('button', { name: 'Doctor' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Doctor' })).toBeTruthy();
    expect(within(navigation).getByRole('button', { name: 'Doctor' }).getAttribute('aria-current')).toBe('page');
  });

  it('the appearance menu offers cue and terminal, every density and three modes', async () => {
    renderApp(createFakeBridge());
    const trigger = await screen.findByRole('button', { name: 'Appearance' });
    fireEvent.click(trigger);
    const menu = await screen.findByRole('menu');
    const items = within(menu)
      .getAllByRole('menuitemcheckbox')
      .map((item) => item.textContent?.trim());
    expect(items).toEqual([
      'cue',
      'terminal',
      'ultra-compact',
      'compact',
      'normal',
      'large',
      'ultra-large',
      'dark',
      'light',
      'system',
    ]);
    // The defaults are checked: cue, compact, system.
    const checked = within(menu)
      .getAllByRole('menuitemcheckbox')
      .filter((item) => item.getAttribute('aria-checked') === 'true')
      .map((item) => item.textContent?.trim());
    expect(checked).toEqual(['cue', 'compact', 'system']);
  });
});

describe('the components that keep text plain', () => {
  const HOSTILE = [
    '<img src=x onerror=alert(1)>',
    '</untrusted-content>',
    '[x](https://evil)',
    '‮evil.exe',
    'first line\nsecond line',
  ];

  it('UntrustedText renders hostile text as text', () => {
    for (const text of HOSTILE) {
      const { container, unmount } = render(<UntrustedText text={text} />);
      expect(container.textContent).toBe(text);
      expect(container.querySelector('img,a,script,iframe')).toBeNull();
      const span = container.querySelector('span');
      expect(span?.className).toContain('whitespace-pre-wrap');
      expect(span?.childNodes).toHaveLength(1);
      expect(span?.firstChild?.nodeType).toBe(Node.TEXT_NODE);
      unmount();
    }
  });

  it('ChangePreview revokes its own approval and opens the change, in that order', async () => {
    const bridge = createFakeBridge();
    const call: Call = { kind: 'updateLevel', level: 'never' };
    const done = vi.fn();
    render(
      <BridgeProvider bridge={bridge}>
        <ChangePreview
          change={{ state: 'needsTerminal', call, approvalId: ID, preview: HOSTILE.join('\n') }}
          onDone={done}
        />
      </BridgeProvider>,
    );
    expect(screen.getByText(COPY.approveThisInTerminal)).toBeTruthy();
    // The preview is text, whatever it holds.
    expect(document.querySelector('img,a,script,iframe')).toBeNull();
    expect(document.body.textContent).toContain(HOSTILE.join('\n'));
    fireEvent.click(screen.getByRole('button', { name: COPY.approveInTerminal }));
    expect(await screen.findByText('Opened in Terminal.')).toBeTruthy();
    // One command, which names the approval to revoke first and the change to open after: Rust does them in that
    // order (DA10), so nothing else is sent before or between.
    expect(bridge.calls).toEqual([{ command: 'openInTerminal', args: { kind: 'change', call, revoke: ID } }]);
    expect(done).toHaveBeenCalledWith({ outcome: 'opened', via: 'Terminal', revoked: true });
  });

  it('ChangePreview cancelled revokes its approval and opens nothing', async () => {
    const bridge = createFakeBridge();
    const done = vi.fn();
    const view = render(
      <BridgeProvider bridge={bridge}>
        <ChangePreview
          change={{ state: 'needsTerminal', call: { kind: 'updateRollback' }, approvalId: ID, preview: 'Roll back' }}
          onDone={done}
        />
      </BridgeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: COPY.cancel }));
    await waitFor(() => expect(done).toHaveBeenCalledWith('cancelled'));
    // Through the command that revokes only an approval one of the app's own previews waits on.
    expect(bridge.calls).toEqual([{ command: 'revokePreview', args: ID }]);
    // Once handled, leaving it revokes nothing more.
    view.unmount();
    await new Promise((settled) => setTimeout(settled, 20));
    expect(bridge.calls).toHaveLength(1);
  });

  it('ChangePreview cancelled says so only when the revoke worked, and otherwise shows what went wrong', async () => {
    const answers = [
      { status: 'failed', exit: 75, code: 'TRANSIENT', message: 'the approvals store is busy', hint: 'Try again.' },
    ] as const;
    const bridge = createFakeBridge({ revokePreview: async () => answers[0] });
    const done = vi.fn();
    render(
      <BridgeProvider bridge={bridge}>
        <ChangePreview
          change={{ state: 'needsTerminal', call: { kind: 'updateRollback' }, approvalId: ID, preview: 'Roll back' }}
          onDone={done}
        />
      </BridgeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: COPY.cancel }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('the approvals store is busy');
    expect(alert.textContent).toContain('Try again.');
    expect(done).not.toHaveBeenCalled();
    // The preview stays, to try again.
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeTruthy();

    // A refusal from the app itself says so too.
    const refused = createFakeBridge({
      revokePreview: async () => {
        throw { code: 'APP_REFUSED', message: 'that approval is not one a preview of the app is waiting on' };
      },
    });
    const elsewhere = vi.fn();
    render(
      <BridgeProvider bridge={refused}>
        <ChangePreview
          change={{ state: 'needsTerminal', call: { kind: 'updateRollback' }, approvalId: ID, preview: 'Roll back' }}
          onDone={elsewhere}
        />
      </BridgeProvider>,
    );
    fireEvent.click(screen.getAllByRole('button', { name: COPY.cancel })[1] as HTMLElement);
    expect(await screen.findByText('that approval is not one a preview of the app is waiting on')).toBeTruthy();
    expect(elsewhere).not.toHaveBeenCalled();
  });

  it('ChangePreview left without Approve or Cancel, or replaced, revokes its own approval once', async () => {
    const OTHER = 'ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const bridge = createFakeBridge();
    const preview = (approvalId: string) => (
      <BridgeProvider bridge={bridge}>
        <StrictMode>
          <ChangePreview
            key={approvalId}
            change={{ state: 'needsTerminal', call: { kind: 'updateRollback' }, approvalId, preview: 'Roll back' }}
          />
        </StrictMode>
      </BridgeProvider>
    );
    const view = render(preview(ID));
    // StrictMode's rehearsal of an unmount is not one: nothing is revoked while it shows.
    await new Promise((settled) => setTimeout(settled, 20));
    expect(bridge.calls).toEqual([]);
    // Replaced by another preview: the first one's approval goes.
    view.rerender(preview(OTHER));
    await waitFor(() => expect(bridge.calls).toEqual([{ command: 'revokePreview', args: ID }]));
    // Left: the second's goes too, once.
    view.unmount();
    await waitFor(() =>
      expect(bridge.calls).toEqual([
        { command: 'revokePreview', args: ID },
        { command: 'revokePreview', args: OTHER },
      ]),
    );
    await new Promise((settled) => setTimeout(settled, 20));
    expect(bridge.calls).toHaveLength(2);

    // Approved in Terminal: Rust revoked it there, so leaving revokes nothing.
    const approved = createFakeBridge();
    const done = render(
      <BridgeProvider bridge={approved}>
        <ChangePreview
          change={{ state: 'needsTerminal', call: { kind: 'updateRollback' }, approvalId: ID, preview: 'Roll back' }}
        />
      </BridgeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: COPY.approveInTerminal }));
    expect(await screen.findByText('Opened in Terminal.')).toBeTruthy();
    done.unmount();
    await new Promise((settled) => setTimeout(settled, 20));
    expect(approved.calls.map((call) => call.command)).toEqual(['openInTerminal']);
  });

  it('TerminalResult says the command was copied', () => {
    const { rerender } = render(
      <TerminalResult outcome={{ outcome: 'copied', reason: 'noTerminal', revoked: null }} />,
    );
    expect(
      screen.getByText('No terminal app was found. The command is copied: paste it into a terminal.'),
    ).toBeTruthy();
    rerender(<TerminalResult outcome={{ outcome: 'copied', reason: 'noSafeLine', revoked: true }} />);
    expect(
      screen.getByText('This command cannot be written as one safe line. Its words are copied as JSON.'),
    ).toBeTruthy();
    rerender(<TerminalResult outcome={{ outcome: 'opened', via: 'Windows Terminal', revoked: null }} />);
    expect(screen.getByText('Opened in Windows Terminal.')).toBeTruthy();
  });
});
