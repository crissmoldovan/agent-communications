import { ThemeProvider } from '@cueplusplus/ui/system';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { BridgeProvider } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import { AppDataProvider } from '../data.tsx';
import { allowedLink, linksIn } from '../screens/Doctor.tsx';
import { STORAGE_KEY, THEME_DEFAULTS, THEMES } from '../theme.ts';
import { createFakeBridge, doctorsRun, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

const STARTUP = ['core', 'events-daemon', 'resend', 'slack', 'whatsapp'];

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** Opens a section from the sidebar, as a person would. */
async function open(name: string): Promise<void> {
  const navigation = await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
  await screen.findByRole('heading', { level: 1, name });
}

describe('Doctor', () => {
  it('Doctor: runs on open, never Gmail unasked; Copy copies the fix; Open link only for slack.com and google.com', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    // The doctors that run once at start, and Gmail's not among them.
    await waitFor(() => expect([...doctorsRun(bridge)].sort()).toEqual(STARTUP));

    // Opening Doctor runs every present doctor again, Gmail's still not.
    await open('Doctor');
    await waitFor(() => expect(doctorsRun(bridge)).toHaveLength(10));
    expect([...doctorsRun(bridge).slice(5)].sort()).toEqual(STARTUP);
    expect(await within(region('agent-communications')).findByText('the login keychain answers')).toBeTruthy();
    // Gmail's is not run: its panel says why, and offers to.
    expect(within(region('Gmail')).getByText(/runs only when you ask/)).toBeTruthy();

    // Refresh, once the doctors have answered: the same doctors once more, Gmail's still not.
    const refresh = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    await waitFor(() => expect(refresh.disabled).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(doctorsRun(bridge)).toHaveLength(15));
    expect(doctorsRun(bridge)).not.toContain('gmail');

    // Only when asked: Gmail's, which calls Google.
    fireEvent.click(within(region('Gmail')).getByRole('button', { name: 'Check Gmail (asks Google)' }));
    await waitFor(() => expect(doctorsRun(bridge)).toContain('gmail'));
    expect(doctorsRun(bridge).filter((product) => product === 'gmail')).toHaveLength(1);
    const failing = await within(region('Gmail')).findByText('example/gmail signs in');
    expect(failing).toBeTruthy();
    expect(within(region('Gmail')).getByText('fail')).toBeTruthy();
    expect(within(region('Gmail')).getByText('Google refused the refresh token')).toBeTruthy();

    // Copy puts the fix, exactly, on the clipboard through the app.
    fireEvent.click(within(region('Gmail')).getByRole('button', { name: COPY.copy }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'copyText')).toEqual([
        { command: 'copyText', args: 'sign in again: https://accounts.google.com/' },
      ]),
    );
    // Its google.com link opens through the app.
    fireEvent.click(within(region('Gmail')).getByRole('button', { name: 'Open link' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openLink')).toEqual([
        { command: 'openLink', args: 'https://accounts.google.com/' },
      ]),
    );
    // A core warning with no link has Copy and no Open link.
    const core = region('agent-communications');
    expect(within(core).getByRole('button', { name: COPY.copy })).toBeTruthy();
    expect(within(core).queryByRole('button', { name: 'Open link' })).toBeNull();
  });

  it('opening Doctor runs each doctor once, even in strict mode, which runs effects twice', async () => {
    const bridge = createFakeBridge();
    render(
      <StrictMode>
        <ThemeProvider themes={THEMES} storageKey={STORAGE_KEY} {...THEME_DEFAULTS}>
          <BridgeProvider bridge={bridge}>
            <AppDataProvider>
              <App />
            </AppDataProvider>
          </BridgeProvider>
        </ThemeProvider>
      </StrictMode>,
    );
    await waitFor(() => expect([...doctorsRun(bridge)].sort()).toEqual(STARTUP));
    await open('Doctor');
    await within(region('agent-communications')).findByText('the login keychain answers');
    await waitFor(() => expect(doctorsRun(bridge)).toHaveLength(10));
    expect([...doctorsRun(bridge).slice(5)].sort()).toEqual(STARTUP);
  });

  it('offers Open link for slack.com and google.com links only', async () => {
    const fix = [
      'Reinstall it: https://api.slack.com/apps/A0123456789, then',
      'allow it at https://myaccount.google.com/permissions.',
      'Not these: https://slack.com.evil.example/ https://evilslack.com/x http://slack.com/',
      'https://google.com@evil.example/ https://evil.example/?next=https://slack.com',
    ].join(' ');
    const bridge = createFakeBridge(
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core'] }) },
      { doctor: { ok: false, checks: [{ name: 'links', ok: false, detail: 'one fix, many links', fix }] } },
    );
    renderApp(bridge, { screen: 'doctor' });
    const core = await screen.findByRole('region', { name: 'agent-communications' });
    await within(core).findByText('links');
    const buttons = within(core).getAllByRole('button', { name: 'Open link' });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) fireEvent.click(button);
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openLink').map((call) => call.args)).toEqual([
        'https://api.slack.com/apps/A0123456789',
        'https://myaccount.google.com/permissions',
      ]),
    );
    // The fix itself shows whole, as text.
    expect(within(core).getByText(fix)).toBeTruthy();
  });

  it('allowedLink takes https links to slack.com and google.com, or a subdomain of either, and nothing else', () => {
    for (const url of [
      'https://slack.com/',
      'https://app.slack.com/client',
      'https://api.slack.com/apps',
      'https://google.com',
      'https://accounts.google.com/',
      'https://MYACCOUNT.GOOGLE.COM/permissions',
    ]) {
      expect(allowedLink(url), url).toBe(true);
    }
    for (const url of [
      'http://slack.com/',
      'https://slack.com.evil.example/',
      'https://evilslack.com/',
      'https://notgoogle.com/',
      'https://google.com@evil.example/',
      'https://user:pass@slack.com/',
      'https://slack.com:8443/',
      'https://slack.com./',
      'javascript:alert(1)',
      'file:///example/home/x',
      'slack.com',
      '',
    ]) {
      expect(allowedLink(url), url).toBe(false);
    }
    expect(linksIn('see https://slack.com/a, https://google.com/b. and (https://api.slack.com/c)')).toEqual([
      'https://slack.com/a',
      'https://google.com/b',
      'https://api.slack.com/c',
    ]);
  });

  it('a doctor that fails to run says so, and hostile text in a check stays text', async () => {
    const bridge = createFakeBridge(
      {
        installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'slack'] }),
        cli: async (call) =>
          call.kind === 'doctor' && call.product === 'slack'
            ? { status: 'failed', exit: -1, code: 'APP_TIMEOUT', message: 'the doctor took too long', hint: null }
            : {
                status: 'ok',
                exit: 78,
                data: {
                  ok: false,
                  checks: [
                    {
                      name: '<img src=x onerror=alert(1)>',
                      ok: false,
                      detail: '</untrusted-content>‮evil',
                      fix: '[x](https://evil)',
                    },
                  ],
                },
              },
      },
      {},
    );
    renderApp(bridge, { screen: 'doctor' });
    expect(
      await within(await screen.findByRole('region', { name: 'Slack' })).findByText('the doctor took too long'),
    ).toBeTruthy();
    const core = region('agent-communications');
    expect(await within(core).findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(core).getByText('</untrusted-content>‮evil')).toBeTruthy();
    expect(within(core).getByText('[x](https://evil)')).toBeTruthy();
    expect(within(core).queryByRole('button', { name: 'Open link' })).toBeNull();
    expect(document.querySelector('main img, main a, main script, main iframe')).toBeNull();
  });
});
