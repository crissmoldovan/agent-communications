/*
 * Settings → Integrations (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4, §3.5, the prototype's Integrations):
 * Linear connected with a personal API key that goes to Rust's `provider_key_set` and never stays in the window, its
 * workspace and teams shown, and Disconnect; agent sessions' relay — where it was found, how it answers, and a folder the
 * person names for it — and what the event service does not do yet, offered as nothing. The answers are the event
 * service's builders' shapes (`linear-integration.ts`, `agent-sessions.ts`).
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call } from '../ipc.ts';
import { createFakeBridge } from './fake-bridge.ts';
import { renderApp } from './render.tsx';
import { LINEAR, SESSIONS } from './rule-editor-bridge.ts';

// The app acts as the person only on macOS, which attests it; elsewhere each setup is offered at the terminal. These
// tests run as macOS unless one says otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

/** A fake event service whose Linear is connected once a key is set, and disconnected once it is removed. */
function integrationsBridge(version = '0.33.0') {
  let connected = false;
  let relayHome: string | null = null;
  const bridge = createFakeBridge(
    {
      async providerKeySet(provider) {
        if (provider === 'linear') connected = true;
        return { status: 'ok', exit: 0, data: { provider, hasKey: true, judges: 0 } };
      },
    },
    {
      version,
      providerList: {
        providers: [
          { id: 'typesafe', name: 'TypeSafe', hasKey: false },
          { id: 'openrouter', name: 'OpenRouter', hasKey: true },
          { id: 'anthropic', name: 'Anthropic', hasKey: false },
          { id: 'linear', name: 'Linear', hasKey: false },
        ],
      },
      judgesList: [],
      integrationShow: (call: Call) =>
        (call as Extract<Call, { kind: 'integrationShow' }>).integration === 'linear'
          ? connected
            ? LINEAR.connected
            : LINEAR.disconnected
          : { ...SESSIONS, settings: { ...SESSIONS.settings, relayHome } },
      providerKeyRemove: (call: Call) => {
        if ((call as Extract<Call, { kind: 'providerKeyRemove' }>).provider === 'linear') connected = false;
        return { provider: 'linear', hasKey: false, judges: 0 };
      },
      integrationSetAgentSessions: (call: Call) => {
        const asked = (call as Extract<Call, { kind: 'integrationSetAgentSessions' }>).relayHome;
        relayHome = asked === 'default' ? null : asked;
        return { ...SESSIONS, settings: { ...SESSIONS.settings, relayHome } };
      },
    },
  );
  return bridge;
}

async function section(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Integrations' });
}

describe('Settings → Integrations', () => {
  it('connects Linear with a key that only passes through, shows what it sees, and disconnects it', async () => {
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const integrations = await section();
    const linear = await within(integrations).findByRole('region', { name: 'Linear' });
    await within(linear).findByText('Not connected');
    expect(linear.textContent).toContain('Lets a workflow add an issue. Nothing reads your Linear on its own.');
    fireEvent.click(within(linear).getByRole('button', { name: 'Connect Linear…' }));
    const field = (await within(linear).findByLabelText('Linear personal API key')) as HTMLInputElement;
    field.value = 'fake-linear-key';
    fireEvent.click(within(linear).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(bridge.calls.filter((each) => each.command === 'providerKeySet').map((each) => each.args)).toEqual([
        ['linear', 'fake-linear-key'],
      ]),
    );
    // The key is gone from the window at once, and never shown again.
    expect(field.value).toBe('');
    await within(linear).findByText('Connected');
    expect(linear.textContent).not.toContain('fake-linear-key');
    expect(linear.textContent).toContain('Example Co');
    expect(linear.textContent).toContain('CUE, OPS');
    // Choosing teams is not the event service's yet: offered as nothing.
    expect((within(linear).getByRole('button', { name: 'Change teams…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(linear).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Disconnect Linear?' });
    expect(confirm.textContent).toContain('a workflow that adds Linear issues adds none until you connect it again');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(
        bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'providerKeyRemove')
          .map((each) => each.args),
      ).toEqual([{ kind: 'providerKeyRemove', provider: 'linear' }]),
    );
    await within(linear).findByText('Not connected');
  });

  it('says where the relay was found and how it answers, and takes a folder the person names, or the defaults', async () => {
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const integrations = await section();
    const sessions = await within(integrations).findByRole('region', { name: 'Agent sessions' });
    await within(sessions).findByText('claude-stream: Ready');
    expect(sessions.textContent).toContain('/example/home/.local/state/agent-relay (claude-stream’s own home)');
    expect(sessions.textContent).toContain('0.2.20');
    expect(sessions.textContent).toContain('/example/home/work');
    expect(sessions.textContent).toContain('Waiting for a busy session2');
    expect(sessions.querySelector('[data-slot="relay-home"]')?.textContent).toBe(
      'Wherever it is: claude-stream’s own home, then the Pilot app’s.',
    );
    const field = within(sessions).getByRole('textbox', { name: 'Or name its home folder' });
    const use = within(sessions).getByRole('button', { name: 'Use this folder' }) as HTMLButtonElement;
    // Not a whole folder: nothing is sent.
    fireEvent.change(field, { target: { value: '~/relay' } });
    expect(use.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '/example/home/relay' } });
    fireEvent.click(use);
    await waitFor(() =>
      expect(
        bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'integrationSetAgentSessions')
          .map((each) => each.args),
      ).toEqual([{ kind: 'integrationSetAgentSessions', relayHome: '/example/home/relay' }]),
    );
    await waitFor(() =>
      expect(sessions.querySelector('[data-slot="relay-home"]')?.textContent).toBe('/example/home/relay'),
    );
    fireEvent.click(within(sessions).getByRole('button', { name: 'Find it for me instead' }));
    await waitFor(() =>
      expect(
        bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'integrationSetAgentSessions')
          .map((each) => (each.args as Extract<Call, { kind: 'integrationSetAgentSessions' }>).relayHome),
      ).toEqual(['/example/home/relay', 'default']),
    );
    // Never a token.
    expect(sessions.textContent).not.toContain('control.token is');
    expect(integrations.textContent).toContain(
      'Later: GitHub issues, Notion pages, calendars. Comes in a later release.',
    );
  });

  it('on Windows and Linux, Linear and the relay are set at the terminal: no key field, and the app sets nothing', async () => {
    platform.mac = false;
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const integrations = await section();
    const terminal = () => bridge.calls.filter((each) => each.command === 'openInTerminal').map((each) => each.args);
    const linear = await within(integrations).findByRole('region', { name: 'Linear' });
    await within(linear).findByText('Not connected');
    fireEvent.click(within(linear).getByRole('button', { name: 'Connect Linear…' }));
    expect(within(linear).queryByLabelText('Linear personal API key')).toBeNull();
    fireEvent.click(within(linear).getByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() => expect(terminal()).toEqual([{ kind: 'providerKeySet', provider: 'linear' }]));
    const sessions = await within(integrations).findByRole('region', { name: 'Agent sessions' });
    await within(sessions).findByText('claude-stream: Ready');
    fireEvent.change(within(sessions).getByRole('textbox', { name: 'Or name its home folder' }), {
      target: { value: '/example/home/relay' },
    });
    fireEvent.click(within(sessions).getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(await within(sessions).findByRole('button', { name: 'Do it in Terminal' }));
    await waitFor(() =>
      expect(terminal()).toContainEqual({
        kind: 'atTerminal',
        call: { kind: 'integrationSetAgentSessions', relayHome: '/example/home/relay' },
      }),
    );
    expect(bridge.calls.some((each) => each.command === 'providerKeySet')).toBe(false);
    expect(
      bridge.calls.some((each) => each.command === 'cli' && (each.args as Call).kind === 'integrationSetAgentSessions'),
    ).toBe(false);
  });

  it('before 0.33.0 the section says what it needs, and reads nothing', async () => {
    const bridge = integrationsBridge('0.32.0');
    renderApp(bridge, { screen: 'settings' });
    const integrations = await section();
    await within(integrations).findByText('Update agent-communications to use this');
    expect(integrations.textContent).toContain('Needs 0.33.0 or later; this machine has 0.32.0.');
    expect(
      bridge.calls.filter((each) => each.command === 'cli' && (each.args as Call).kind === 'integrationShow'),
    ).toEqual([]);
  });

  it("AI providers reads a list that names Anthropic and Linear: Jev's two, and Anthropic's for Analyse", async () => {
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const providers = await screen.findByRole('region', { name: 'AI providers' });
    await within(providers).findByText('OpenRouter');
    expect(providers.textContent).not.toContain('Your keys could not be read.');
    const anthropic = await within(providers).findByRole('region', { name: 'Anthropic' });
    expect(anthropic.textContent).toContain('No key');
    expect(anthropic.textContent).toContain('Analyse can run on Claude directly');
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Add key…' }));
    const field = (await within(anthropic).findByLabelText('Anthropic key')) as HTMLInputElement;
    field.value = 'fake-anthropic-key';
    fireEvent.click(within(anthropic).getByRole('button', { name: 'Save key' }));
    await waitFor(() =>
      expect(bridge.calls.filter((each) => each.command === 'providerKeySet').map((each) => each.args)).toEqual([
        ['anthropic', 'fake-anthropic-key'],
      ]),
    );
    expect(field.value).toBe('');
    // Linear's key is Integrations' to show, never a row here.
    expect(within(providers).queryByText('Linear')).toBeNull();
  });
});
