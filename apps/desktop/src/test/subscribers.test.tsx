/*
 * Events → Subscribers (0.36.0, plan F3, spec W29–W33, §11.2): who receives which events, live on this Mac or by signed
 * webhook; Add a subscriber… with namespaces and patterns checked as they are typed by the event service's own
 * `canonicalEventPattern`; Approve… with the subscription's preview and its digest; tokens and secrets made at a
 * terminal, never shown here; and Remove, at once. Every answer is a fixture; nothing listens or posts.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Call, TerminalCommand } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, type Fixture, SUBSCRIPTION_PREPARED } from './fake-bridge.ts';
import { renderApp } from './render.tsx';

// The app attests the person only on macOS; elsewhere Approve… is approved at a terminal. These run as macOS unless
// one says otherwise.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

// The event service's words for the fixture's crm-hook: its whole URL, the addresses it may reach and its tries (security
// review of 0.36.0, M4), as the terminal's preview prints them.
const WORDS =
  'crm-hook receives acme.client-asks.issue.created in the namespace acme, by signed webhook to ' +
  'https://hooks.example:443/agentcomms, connecting only to the address 192.0.2.10, each event tried at most 5 times. ' +
  'Nothing a sender wrote.';

/** The event service at 0.36.0, its subscribers the fixture's, and a subscription's preview as `approval view` gives it. */
function bridgeAt(events: string, fixtures: Partial<Record<Call['kind'], Fixture>> = {}): FakeBridge {
  return createFakeBridge(
    {},
    {
      version: (call: Call) => (call.kind === 'version' && call.product === 'events-daemon' ? events : '0.24.0'),
      eventsApprovalView: (call: Call) => {
        const { approvalId, digest } = call as Extract<Call, { kind: 'eventsApprovalView' }>;
        return {
          kind: 'READY',
          approvalId,
          digest,
          preview: { kind: 'subscription', subscription: { subscriberId: 'crm-hook', version: 1, digest } },
          subscription: { subscriber: { subscriberId: 'crm-hook', version: 1, kind: 'webhook' }, words: WORDS },
        };
      },
      ...fixtures,
    },
  );
}

const callsOf = (bridge: FakeBridge, kind: Call['kind']): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Call);

async function openSubscribers(): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: /^Subscribers\b/ });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
  return screen.findByRole('region', { name: 'Subscribers' });
}

async function card(id: string): Promise<HTMLElement> {
  return screen.findByRole('region', { name: `Subscriber ${id}` });
}

describe('Events → Subscribers', () => {
  it('each subscriber shows its kind, what it receives, its state, its listener or address and its backlog', async () => {
    renderApp(bridgeAt('0.36.0'), { screen: 'events' });
    await openSubscribers();
    const live = await card('events-dashboard');
    expect(live.querySelector('[data-slot="subscriber-kind"]')?.textContent).toBe('Live on this Mac');
    expect(live.querySelector('[data-slot="subscriber-state"]')?.textContent).toBe('Approved');
    const receives = live.querySelector('[data-slot="subscriber-receives"]')?.textContent ?? '';
    expect(receives).toContain('*.*.*.failed');
    expect(receives).toContain('acme.client-asks.*.*');
    expect(receives).toContain('in the namespace acme');
    expect(receives).toContain('Nothing a sender wrote.');
    expect(live.querySelector('[data-slot="subscriber-where"]')?.textContent).toBe('Listening at 127.0.0.1:4801');
    expect(live.querySelector('[data-slot="subscriber-backlog"]')?.textContent).toBe('0 events waiting');

    const hook = await card('crm-hook');
    expect(hook.querySelector('[data-slot="subscriber-kind"]')?.textContent).toBe('Signed webhook');
    expect(hook.querySelector('[data-slot="subscriber-state"]')?.textContent).toBe('Waiting for your approval');
    expect(hook.querySelector('[data-slot="subscriber-where"]')?.textContent).toBe(
      'Posts each event to its address, signed.',
    );

    // Today's subscriber, with no events of its own, whose port another program holds.
    const page = await card('stream-page');
    expect(page.querySelector('[data-slot="subscriber-state"]')?.textContent).toBe(
      'Receives what a workflow streams to it',
    );
    expect(page.querySelector('[data-slot="subscriber-where"]')?.textContent).toBe(
      'Its port is in use, so it is not listening.',
    );
    expect(page.querySelector('[data-slot="subscriber-backlog"]')?.textContent).toBe('3 events waiting');
    // Only an inert version with events offers Approve….
    expect(within(live).queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Approve…' })).toBeNull();
    expect(within(hook).getByRole('button', { name: 'Approve…' })).toBeTruthy();
  });

  it('Add a subscriber… writes namespaces and patterns, and refuses a pattern outside them', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    const tab = await openSubscribers();
    fireEvent.click(within(tab).getByRole('button', { name: 'Add a subscriber…' }));
    const form = await screen.findByRole('region', { name: 'Add a subscriber' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Its name' }), { target: { value: 'ops-board' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Its port on this Mac' }), {
      target: { value: '4802' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Its namespaces' }), { target: { value: 'acme' } });
    const patterns = within(form).getByRole('textbox', { name: 'What it receives' });
    const add = within(form).getByRole('button', { name: 'Add it' }) as HTMLButtonElement;
    // A pattern naming a namespace it was not given is refused as it is typed.
    fireEvent.change(patterns, { target: { value: 'acme.client-asks.*.*\nglobex.*.*.failed' } });
    expect(form.textContent).toContain('Line 2: the namespace globex is not one this subscriber was given.');
    expect(add.disabled).toBe(true);
    // A partial wildcard is no pattern.
    fireEvent.change(patterns, { target: { value: 'acme.client-*.*.*' } });
    expect(form.textContent).toMatch(/Line 1: "client-\*" is neither a segment nor \*/);
    expect(add.disabled).toBe(true);
    fireEvent.change(patterns, { target: { value: '*.*.*.failed\nacme.client-asks.*.*' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'The pages that may connect' }), {
      target: { value: 'http://localhost:3000' },
    });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(callsOf(bridge, 'eventsSubscriberAdd')).toHaveLength(1));
    expect(callsOf(bridge, 'eventsSubscriberAdd')[0]).toEqual({
      kind: 'eventsSubscriberAdd',
      document: {
        subscriberId: 'ops-board',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 4802 },
        origins: ['http://localhost:3000'],
        retentionMs: 86_400_000,
        events: { namespaces: ['acme'], patterns: ['*.*.*.failed', 'acme.client-asks.*.*'], content: 'none' },
      },
    });
    // It is inert: nothing is approved, nothing is prepared.
    expect(callsOf(bridge, 'eventsSubscriberEnable')).toEqual([]);
    expect(await screen.findByText(/^Added ops-board\. It receives nothing until you approve it/)).toBeTruthy();
  });

  it('a webhook subscriber names its address and the addresses it may resolve to', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    const tab = await openSubscribers();
    fireEvent.click(within(tab).getByRole('button', { name: 'Add a subscriber…' }));
    const form = await screen.findByRole('region', { name: 'Add a subscriber' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Its name' }), { target: { value: 'crm-two' } });
    fireEvent.click(within(form).getByRole('radio', { name: /By signed webhook/ }));
    const url = await within(form).findByRole('textbox', { name: 'Its address' });
    fireEvent.change(url, { target: { value: 'http://hooks.example/in' } });
    expect(form.textContent).toContain('An https address, or http to 127.0.0.1 or [::1].');
    fireEvent.change(url, { target: { value: 'https://hooks.example/agentcomms' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'The addresses it may resolve to' }), {
      target: { value: '192.0.2.10' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Its namespaces' }), { target: { value: 'acme' } });
    fireEvent.change(within(form).getByRole('textbox', { name: 'What it receives' }), {
      target: { value: 'acme.client-asks.issue.created' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add it' }));
    await waitFor(() => expect(callsOf(bridge, 'eventsSubscriberAdd')).toHaveLength(1));
    expect(callsOf(bridge, 'eventsSubscriberAdd')[0]).toEqual({
      kind: 'eventsSubscriberAdd',
      document: {
        subscriberId: 'crm-two',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://hooks.example/agentcomms' },
        approvedAddressSet: ['192.0.2.10'],
        signing: 'standard-webhooks',
        retryLimit: 5,
        events: { namespaces: ['acme'], patterns: ['acme.client-asks.issue.created'], content: 'none' },
      },
    });
  });

  it('Approve… shows the subscription preview and approves with the digest', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    await openSubscribers();
    fireEvent.click(within(await card('crm-hook')).getByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog');
    expect(callsOf(bridge, 'eventsSubscriberEnable')).toEqual([
      { kind: 'eventsSubscriberEnable', subscriberId: 'crm-hook', version: 1 },
    ]);
    expect(dialog.querySelector('[data-slot="subscription-words"]')?.textContent).toBe(WORDS);
    // The words are shown whole: the hook's path, which decides who receives on a shared host, and the address set.
    expect(dialog.textContent).toContain('https://hooks.example:443/agentcomms');
    expect(dialog.textContent).toContain('192.0.2.10');
    expect(dialog.textContent).toContain(SUBSCRIPTION_PREPARED.binding.digest);
    const approve = within(dialog).getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    // Only the subscriber's own name, typed, lets it be approved.
    expect(approve.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'crm-hook' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(callsOf(bridge, 'eventsSubscriberApprove')).toEqual([
        {
          kind: 'eventsSubscriberApprove',
          approvalId: SUBSCRIPTION_PREPARED.approvalId,
          digest: SUBSCRIPTION_PREPARED.binding.digest,
        },
      ]),
    );
    expect(await screen.findByText('crm-hook receives what you approved, from now on.')).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'revokePreview')).toEqual([]);
  });

  it('where the app cannot attest the person, Approve… opens the terminal, and Back revokes', async () => {
    platform.mac = false;
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    await openSubscribers();
    fireEvent.click(within(await card('crm-hook')).getByRole('button', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'revokePreview').map((call) => call.args)).toEqual([
        SUBSCRIPTION_PREPARED.approvalId,
      ]),
    );
    expect(callsOf(bridge, 'eventsSubscriberApprove')).toEqual([]);
    // Again, at the terminal this time.
    fireEvent.click(within(await card('crm-hook')).getByRole('button', { name: 'Approve…' }));
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Approve in Terminal' }));
    await waitFor(() =>
      expect(bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args)).toEqual([
        { kind: 'ruleApprove', approvalId: SUBSCRIPTION_PREPARED.approvalId },
      ]),
    );
  });

  it('Make the token opens the terminal; the app never shows a token', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    await openSubscribers();
    const live = await card('events-dashboard');
    fireEvent.click(within(live).getByRole('button', { name: 'Make its token in Terminal' }));
    const hook = await card('crm-hook');
    fireEvent.click(within(hook).getByRole('button', { name: 'Make its signing secret in Terminal' }));
    fireEvent.click(within(hook).getByRole('button', { name: 'Set a secret address in Terminal' }));
    await waitFor(() =>
      expect(
        bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args as TerminalCommand),
      ).toEqual([
        { kind: 'subscriberToken', subscriberId: 'events-dashboard', version: 2, action: 'create' },
        { kind: 'subscriberSecret', subscriberId: 'crm-hook', version: 1, action: 'create' },
        { kind: 'subscriberUrl', subscriberId: 'crm-hook', version: 1 },
      ]),
    );
    // No call the app makes asks for a token, a secret or a secret address: they are the terminal's.
    expect(
      cliKinds(bridge).filter((kind) => /Token|Secret|UrlSet/.test(kind)),
      'no secret call',
    ).toEqual([]);
    expect(live.textContent).toContain('A token or a secret is shown once, at your terminal: never in this app.');
  });

  it('Remove applies at once', async () => {
    const bridge = bridgeAt('0.36.0');
    renderApp(bridge, { screen: 'events' });
    await openSubscribers();
    fireEvent.click(within(await card('stream-page')).getByRole('button', { name: 'Remove' }));
    // No dialog: removing only tightens.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() =>
      expect(callsOf(bridge, 'eventsSubscriberRemove')).toEqual([
        { kind: 'eventsSubscriberRemove', subscriberId: 'stream-page' },
      ]),
    );
    expect(await screen.findByText(/^Removed stream-page: it receives nothing more/)).toBeTruthy();
    await waitFor(() => expect(callsOf(bridge, 'eventsSubscribersList').length).toBeGreaterThanOrEqual(2));
  });

  it('an events service before 0.36.0 says it needs 0.36.0, and lists nothing', async () => {
    const bridge = bridgeAt('0.35.0');
    renderApp(bridge, { screen: 'events' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Subscribers\b/ }));
    expect(await screen.findByText('Needs 0.36.0 or later; this machine has 0.35.0.')).toBeTruthy();
    expect(callsOf(bridge, 'eventsSubscribersList')).toEqual([]);
  });
});
