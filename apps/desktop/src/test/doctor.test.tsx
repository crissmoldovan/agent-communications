import { ThemeProvider } from '@cueplusplus/ui/system';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { App } from '../App.tsx';
import { BridgeProvider } from '../bridge-context.tsx';
import { COPY } from '../copy.ts';
import { AppDataProvider } from '../data.tsx';
import { allowedLink, GMAIL_NOT_CHECKED, linksIn } from '../screens/Doctor.tsx';
import { STORAGE_KEY, THEME_DEFAULTS, THEMES } from '../theme.ts';
import { createFakeBridge, doctorsRun, EXAMPLE_INSTALLATION } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

const STARTUP = ['core', 'events-daemon', 'resend', 'slack', 'whatsapp'];

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** What there is to look at, at the top of the screen: each item's product, in the order shown. */
const lookedAt = (): (string | null)[] =>
  Array.from(screen.queryByRole('region', { name: 'To look at' })?.querySelectorAll('li') ?? []).map((item) =>
    item.getAttribute('data-product'),
  );

/** The thing to look at for a product, once it shows (the first, when it has more than one). */
async function issue(product: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = screen
      .getByRole('region', { name: 'To look at' })
      .querySelector<HTMLElement>(`li[data-product="${product}"]`);
    if (found === null) throw new Error(`nothing to look at for ${product}`);
    return found;
  });
}

/** The page's line under its title. */
const summary = (): string | null => document.querySelector('[data-slot="doctor-summary"]')?.textContent ?? null;

/** Opens a section from the sidebar, as a person would. */
async function open(name: string): Promise<void> {
  const navigation = await screen.findByRole('navigation', { name: 'Sections' });
  fireEvent.click(within(navigation).getByRole('button', { name }));
  await screen.findByRole('heading', { level: 1, name });
}

describe('Doctor', () => {
  it('Doctor: runs on open, never Gmail unasked; Copy copies the fix; Open link for the page it names', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge);
    // The doctors that run once at start, and Gmail's not among them.
    await waitFor(() => expect([...doctorsRun(bridge)].sort()).toEqual(STARTUP));

    // Opening Doctor runs every present doctor again, Gmail's still not.
    await open('Doctor');
    await waitFor(() => expect(doctorsRun(bridge)).toHaveLength(10));
    expect([...doctorsRun(bridge).slice(5)].sort()).toEqual(STARTUP);
    expect(await within(region('agent-communications')).findByText('the login keychain answers')).toBeTruthy();
    // Gmail's is not run: its panel says so, offers to, and says why in a hint the keyboard reaches.
    expect(within(region('Gmail')).getByText('Not checked')).toBeTruthy();
    expect(screen.queryByText(GMAIL_NOT_CHECKED)).toBeNull();
    await act(async () => within(region('Gmail')).getByRole('button', { name: 'Why Gmail is not checked' }).focus());
    expect((await screen.findByRole('tooltip')).textContent).toBe(GMAIL_NOT_CHECKED);

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
    // Its failure is at the top, named as Gmail's, before core's warning; its passing check stays in its own list.
    const gmail = await issue('gmail');
    expect(within(gmail).getByText('Gmail')).toBeTruthy();
    expect(within(gmail).getByText('example/gmail signs in')).toBeTruthy();
    expect(within(gmail).getByText('fail')).toBeTruthy();
    expect(within(gmail).getByText('Google refused the refresh token')).toBeTruthy();
    expect(lookedAt()).toEqual(['gmail', 'core']);
    expect(within(region('Gmail')).getByText('Node')).toBeTruthy();
    expect(within(region('Gmail')).queryByText('example/gmail signs in')).toBeNull();
    expect(within(region('Gmail')).getByText('problems')).toBeTruthy();

    // Copy puts the fix, exactly, on the clipboard through the app.
    fireEvent.click(within(gmail).getByRole('button', { name: COPY.copy }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'copyText')).toEqual([
        { command: 'copyText', args: 'Remove the app at https://myaccount.google.com/connections and sign in again.' },
      ]),
    );
    // The page it names opens through the app.
    fireEvent.click(within(gmail).getByRole('button', { name: 'Open link' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openLink')).toEqual([
        { command: 'openLink', args: 'https://myaccount.google.com/connections' },
      ]),
    );
    // A core warning with no link has Copy and no Open link.
    const core = await issue('core');
    expect(within(core).getByText('Gmail has accounts that no client starts')).toBeTruthy();
    expect(within(core).getByText('warn')).toBeTruthy();
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

  it('offers Open link for the pages doctor fixes send a person to, and no others', async () => {
    const fix = [
      'Reinstall it: https://api.slack.com/apps/A0123456789, then',
      'allow it at https://myaccount.google.com/permissions.',
      'Not these: https://slack.com.evil.example/ https://evilslack.com/x http://slack.com/',
      'https://google.com@evil.example/ https://evil.example/?next=https://slack.com',
      'https://www.google.com/url?q=https://evil.example/ https://app.slack.com/client https://accounts.google.com/',
    ].join(' ');
    const bridge = createFakeBridge(
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core'] }) },
      { doctor: { ok: false, checks: [{ name: 'links', ok: false, detail: 'one fix, many links', fix }] } },
    );
    renderApp(bridge, { screen: 'doctor' });
    const core = await issue('core');
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

  it('allowedLink takes https links to the three hosts doctor fixes name, and nothing else', () => {
    for (const url of [
      'https://api.slack.com/apps',
      'https://api.slack.com/apps/A0123/app-manifest',
      'https://MYACCOUNT.GOOGLE.COM/permissions',
      'https://myaccount.google.com/connections',
      'https://console.cloud.google.com/auth/clients?project=example',
    ]) {
      expect(allowedLink(url), url).toBe(true);
    }
    for (const url of [
      // Slack's and Google's other hosts: no doctor fix sends a person there.
      'https://slack.com/',
      'https://app.slack.com/client',
      'https://example.slack.com/admin',
      'https://google.com',
      'https://www.google.com/',
      'https://accounts.google.com/',
      'https://support.google.com/accounts',
      // Google's redirect, which would open anywhere, on any of its hosts.
      'https://www.google.com/url?q=https://evil.example/',
      'https://console.cloud.google.com/url?q=https://evil.example/',
      'https://myaccount.google.com/url?q=https%3A%2F%2Fevil.example',
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
    // A doctor that did not run is something to look at, and its header says so.
    const slack = await issue('slack');
    expect(within(slack).getByRole('alert').textContent).toBe('the doctor took too long');
    expect(within(region('Slack')).getByText('did not run')).toBeTruthy();
    const core = await issue('core');
    expect(await within(core).findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(core).getByText('</untrusted-content>‮evil')).toBeTruthy();
    expect(within(core).getByText('[x](https://evil)')).toBeTruthy();
    expect(within(core).queryByRole('button', { name: 'Open link' })).toBeNull();
    expect(document.querySelector('main img, main a, main script, main iframe')).toBeNull();
  });

  it('says how the checks came out in one line, and keeps passing and skipped checks quiet in their own lists', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'doctor' });
    await issue('core');
    await waitFor(() => expect(summary()).toBe('10 checks pass · 1 to look at · 1 skipped'));
    // Only core's warning is at the top; its passing checks stay in its list, each marked as passing.
    expect(lookedAt()).toEqual(['core']);
    const core = region('agent-communications');
    for (const title of ['node', 'folders', 'keychain']) expect(within(core).getByText(title)).toBeTruthy();
    expect(within(core).queryByText('clients')).toBeNull();
    expect(within(core).getAllByText('ok')).toHaveLength(3);
    expect(within(core).getByText('warnings')).toBeTruthy();
    // A skipped check says so in words, quietly, with its detail.
    const slack = region('Slack');
    expect(within(slack).getByText('example/slack signs in')).toBeTruthy();
    expect(within(slack).getByText('skipped')).toBeTruthy();
    expect(within(slack).getByText('not checked: --offline')).toBeTruthy();
    expect(within(slack).getByText('healthy')).toBeTruthy();

    // While the doctors run again, the line says so.
    const refresh = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    await waitFor(() => expect(refresh.disabled).toBe(false));
    fireEvent.click(refresh);
    expect(summary()).toBe('Checking…');
    await waitFor(() => expect(summary()).toBe('10 checks pass · 1 to look at · 1 skipped'));
  });

  it('a report that says it is not healthy, with no failing check, is something to look at', async () => {
    const bridge = createFakeBridge(
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'slack'] }) },
      {
        doctor: (call: { product?: string }) =>
          call.product === 'slack'
            ? {
                healthy: false,
                checks: [{ id: 'config', title: 'Configuration', status: 'ok', detail: 'one workspace' }],
              }
            : { ok: true, checks: [{ name: 'node', ok: true, detail: 'Node 22.18.0' }] },
      },
    );
    renderApp(bridge, { screen: 'doctor' });
    const slack = await issue('slack');
    expect(within(slack).getByText('Not healthy')).toBeTruthy();
    expect(lookedAt()).toEqual(['slack']);
    expect(within(region('Slack')).getByText('Configuration')).toBeTruthy();
    expect(within(region('Slack')).getByText('problems')).toBeTruthy();
    expect(summary()).toBe('2 checks pass · 1 to look at');
  });

  it('with nothing to look at, there is no list of it, and a doctor that ran no checks says so', async () => {
    const bridge = createFakeBridge(
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core'] }) },
      { doctor: { ok: true, checks: [] } },
    );
    renderApp(bridge, { screen: 'doctor' });
    const core = await screen.findByRole('region', { name: 'agent-communications' });
    expect(await within(core).findByText('This doctor ran no checks.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'To look at' })).toBeNull();
    expect(summary()).toBe('0 checks pass');
  });
});
