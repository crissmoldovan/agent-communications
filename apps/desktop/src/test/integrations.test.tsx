/*
 * Settings → Integrations (0.33.0, design 2026-10-26-rules-that-act-0330 §3.4, §3.5, the prototype's Integrations):
 * Linear connected with a personal API key that goes to Rust's `provider_key_set` and never stays in the window, its
 * workspace and teams shown, and Disconnect; agent sessions' relay home, chosen between claude-stream's own and the
 * Pilot app's, and how the relay answers; and what the event service does not do yet, offered as nothing.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { createFakeBridge } from './fake-bridge.ts';
import { renderApp } from './render.tsx';
import { LINEAR, SESSIONS } from './rule-editor-bridge.ts';

/** A fake event service whose Linear is connected once a key is set, and disconnected once it is removed. */
function integrationsBridge(version = '0.33.0') {
  let connected = false;
  let home: string = SESSIONS.home;
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
          : { ...SESSIONS, home },
      providerKeyRemove: (call: Call) => {
        if ((call as Extract<Call, { kind: 'providerKeyRemove' }>).provider === 'linear') connected = false;
        return { provider: 'linear', hasKey: false, judges: 0 };
      },
      integrationSetAgentSessions: (call: Call) => {
        home = (call as Extract<Call, { kind: 'integrationSetAgentSessions' }>).home;
        return { ...SESSIONS, home };
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
    expect(linear.textContent).toContain('Lets a rule add an issue. Nothing reads your Linear on its own.');
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
    expect(linear.textContent).toContain('invoices');
    // Choosing teams is not the event service's yet: offered as nothing.
    expect((within(linear).getByRole('button', { name: 'Change teams…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(linear).getByRole('button', { name: 'Disconnect' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Disconnect Linear?' });
    expect(confirm.textContent).toContain('the rule that uses it adds no issue until you connect it again');
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

  it("names the relay's home, lets the person choose the Pilot app's, and says how the relay answers", async () => {
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const integrations = await section();
    const sessions = await within(integrations).findByRole('region', { name: 'Agent sessions' });
    await within(sessions).findByText('claude-stream: Running');
    expect(sessions.textContent).toContain('0.2.20');
    expect(sessions.textContent).toContain('/example/home/work');
    const homes = within(sessions).getByRole('group', { name: 'Use claude-stream at' });
    const own = within(homes).getByRole('button', { name: /claude-stream’s own home/ });
    expect(own.getAttribute('aria-pressed')).toBe('true');
    const pilot = within(homes).getByRole('button', { name: /The Pilot app’s home.*not found here/ });
    fireEvent.click(pilot);
    await waitFor(() =>
      expect(
        bridge.calls
          .filter((each) => each.command === 'cli' && (each.args as Call).kind === 'integrationSetAgentSessions')
          .map((each) => each.args),
      ).toEqual([{ kind: 'integrationSetAgentSessions', home: 'pilot' }]),
    );
    await waitFor(() =>
      expect(
        within(within(sessions).getByRole('group', { name: 'Use claude-stream at' }))
          .getByRole('button', { name: /The Pilot app’s home/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(sessions.textContent).not.toMatch(/token\b.*[A-Za-z0-9]{20}/);
    expect(integrations.textContent).toContain(
      'Later: GitHub issues, Notion pages, calendars. Comes in a later release.',
    );
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

  it("AI providers still reads a provider list that names Anthropic and Linear, and shows Jev's two", async () => {
    const bridge = integrationsBridge();
    renderApp(bridge, { screen: 'settings' });
    const providers = await screen.findByRole('region', { name: 'AI providers' });
    await within(providers).findByText('OpenRouter');
    expect(providers.textContent).not.toContain('Your keys could not be read.');
    expect(within(providers).queryByText('Linear')).toBeNull();
  });
});
