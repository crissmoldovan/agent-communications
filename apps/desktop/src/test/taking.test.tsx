import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAKING_COPY } from '../components/TakingSettings.tsx';
import type { Call, CliResult, Installation } from '../ipc.ts';
import { NOT_TAKEN_COPY } from '../screens/QueueNotTaken.tsx';
import { TAKE_ACTIONS_COPY } from '../screens/TakeActions.tsx';
import {
  createFakeBridge,
  EVENT_SERVICE,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  ok,
  RECENT_SESSIONS,
} from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';
import takesList from './fixtures/takes-list.json';
import taking from './fixtures/taking.json';
import { renderApp } from './render.tsx';

/*
 * Taking messages in the app (design 2026-10-26-taking-messages §9): Messages reads core's takes beside the messages
 * and the activity, with its two filters; a story's Who has it, with Take back, Give to… and I'll handle it, each its
 * `takes` command at once; the Queue's Not taken, counted in the badge; and Settings → Taking messages, mirrored in an
 * account's Agents here, each loosening approved in the app. Against the fake bridge: nothing runs, and nothing reaches
 * a CLI, Gmail or Slack.
 */

// Core takes the app's own approval only where the app is attested (macOS). These tests run as macOS.
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('../platform.ts', () => ({ isMac: () => platform.mac }));
afterEach(() => {
  platform.mac = true;
});

const SLOW = { timeout: 30_000 };
/** A first render reads cold: what it waits for is given room. */
const WAIT = { timeout: 10_000 };
const ID = 'ap_0123456789ABCDEFGHJKMNPQRS';
const main = (): HTMLElement => screen.getByRole('main');

const TAKING_FIXTURES: Partial<Record<Call['kind'], Fixture>> = {
  eventsMessagesList: messagesList,
  eventsMessageShow: messageShow,
  activityItems,
  approvalsFinished: [],
  takesList,
  taking,
  activitySessions: RECENT_SESSIONS,
  takesRelease: { account: 'x', message: 'y', state: 'open', changed: true, take: null },
  takesKeep: { account: 'x', message: 'y', state: 'taken', changed: true, take: null },
  takesGive: { account: 'x', message: 'y', state: 'offered', changed: true, take: null },
};

type Answers = Partial<Record<Call['kind'], (call: Call) => CliResult>>;

/** Core and the events service at `version` (0.35.0 by default), the taking fixtures, and any call answered its way. */
function bridgeAt(
  version = '0.35.0',
  answers: Answers = {},
  handlers: Parameters<typeof createFakeBridge>[0] = {},
): FakeBridge {
  const installation: Installation = { ...EXAMPLE_INSTALLATION, version };
  const base = createFakeBridge({ installation: async () => installation }, { ...TAKING_FIXTURES, version });
  return createFakeBridge({
    installation: async () => installation,
    cli: async (call) => answers[call.kind]?.(call) ?? base.cli(call),
    ...handlers,
  });
}

function asked<K extends Call['kind']>(bridge: FakeBridge, kind: K): Extract<Call, { kind: K }>[] {
  return bridge.calls
    .filter((call) => call.command === 'cli' && (call.args as Call).kind === kind)
    .map((call) => call.args as Extract<Call, { kind: K }>);
}

const TAKING_KINDS = ['takesList', 'takesRelease', 'takesGive', 'takesKeep', 'taking', 'takingChange'];
const takingCalls = (bridge: FakeBridge) =>
  bridge.calls
    .filter((call) => call.command === 'cli' && TAKING_KINDS.includes((call.args as Call).kind))
    .map((call) => (call.args as Call).kind);

/** Opens Messages, and the story of the card whose key starts with `key`. */
async function story(bridge: FakeBridge, key: string): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'messages' });
  await screen.findByRole('heading', { level: 1, name: 'Messages' });
  await waitFor(() => expect(main().querySelector(`li[data-message^="${key}"]`)).not.toBeNull(), WAIT);
  const card = main().querySelector<HTMLElement>(`li[data-message^="${key}"]`) as HTMLElement;
  fireEvent.click(within(card).getByRole('button'));
  return within(main()).findByRole('region', { name: TAKE_ACTIONS_COPY.who });
}

describe('Messages, with takes', () => {
  it(
    'reads core’s takes and settings beside the messages, and offers Nobody took it and Handed back',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      renderApp(bridge, { screen: 'messages' });
      await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull(), WAIT);
      // The screen's own reads, and the shared read Not taken makes, each the same closed call.
      expect(asked(bridge, 'takesList').length).toBeGreaterThan(0);
      for (const call of asked(bridge, 'takesList')) expect(call).toEqual({ kind: 'takesList', since: '30d' });
      for (const call of asked(bridge, 'taking')) expect(call).toEqual({ kind: 'taking' });
      const show = within(main()).getByRole('group', { name: 'Show' });
      expect(within(show).getByRole('button', { name: /^Nobody took it/ })).toBeTruthy();
      fireEvent.click(within(show).getByRole('button', { name: /^Handed back/ }));
      await waitFor(() =>
        expect(
          Array.from(main().querySelectorAll('li[data-message]')).map((each) => each.getAttribute('data-message')),
        ).toEqual(['event:e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4']),
      );
      const card = main().querySelector('li[data-message]') as HTMLElement;
      expect(card.querySelector('[data-slot="message-status"]')?.textContent).toBe('Handed back');
      expect(card.textContent).toContain('Handed back: not mine');
    },
  );

  it('an older core reads no take, and shows the four views', SLOW, async () => {
    const bridge = bridgeAt('0.34.0');
    renderApp(bridge, { screen: 'messages' });
    await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull(), WAIT);
    const show = within(main()).getByRole('group', { name: 'Show' });
    expect(within(show).queryByRole('button', { name: /^Nobody took it/ })).toBeNull();
    expect(within(main()).queryByRole('region', { name: TAKE_ACTIONS_COPY.who })).toBeNull();
    expect(takingCalls(bridge)).toEqual([]);
  });
});

describe('a story’s Who has it', () => {
  it(
    'a handed-back message: who handed it back and why, its note as an agent’s words, and I’ll handle it',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const who = await story(bridge, 'event:e4');
      expect(within(who).getByText('Nobody has it')).toBeTruthy();
      const backs = within(who)
        .getAllByText(/handed it back at/)
        .map((each) => each.textContent);
      expect(backs).toHaveLength(2);
      expect(backs[0]).toMatch(/^the agent in ~\/work\/billing handed it back at .+: not mine$/);
      expect(backs[1]).toMatch(/^the agent in ~\/work\/docs handed it back at .+: it needs you$/);
      // The note is the agent's, and may carry a sender's words: boxed From outside, and no element came of it.
      const note = who.querySelector('[data-slot="hand-back-note"]') as HTMLElement;
      expect(note.querySelector('[data-slot="from-outside"]')).not.toBeNull();
      expect(note.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(main().querySelector('img')).toBeNull();
      // Nobody has it: nothing to take back.
      expect(within(who).queryByRole('button', { name: TAKE_ACTIONS_COPY.takeBack })).toBeNull();
      const lists = asked(bridge, 'takesList').length;
      fireEvent.click(within(who).getByRole('button', { name: TAKE_ACTIONS_COPY.handle }));
      expect(await within(who).findByText(TAKE_ACTIONS_COPY.kept)).toBeTruthy();
      expect(asked(bridge, 'takesKeep')).toEqual([
        { kind: 'takesKeep', account: 'example/gmail', message: '18c2f0a1b2c3d400' },
      ]);
      // Read again at once, and nothing went to Terminal.
      await waitFor(() => expect(asked(bridge, 'takesList').length).toBe(lists + 1));
      expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
    },
  );

  it('a message an agent window has: who, since when, and Take back runs takes release', SLOW, async () => {
    const bridge = bridgeAt();
    const who = await story(bridge, 'event:e2');
    expect(within(who).getByText('The agent in ~/work/acme has it')).toBeTruthy();
    fireEvent.click(within(who).getByRole('button', { name: TAKE_ACTIONS_COPY.takeBack }));
    expect(await within(who).findByText(TAKE_ACTIONS_COPY.released)).toBeTruthy();
    expect(asked(bridge, 'takesRelease')).toEqual([
      { kind: 'takesRelease', account: 'example/slack', message: 'D0EXAMPLE1/1792927860.000100' },
    ]);
  });

  it('Give to… lists the agent windows of the last day and gives the message to the one chosen', SLOW, async () => {
    const bridge = bridgeAt();
    const who = await story(bridge, 'event:e2');
    fireEvent.click(within(who).getByRole('button', { name: TAKE_ACTIONS_COPY.giveTo }));
    const dialog = await screen.findByRole('dialog', { name: TAKE_ACTIONS_COPY.pickerTitle });
    await waitFor(() => expect(dialog.querySelectorAll('[data-window]')).toHaveLength(2));
    expect(asked(bridge, 'activitySessions')).toEqual([{ kind: 'activitySessions', since: '24h' }]);
    // The command and the event service are counted, never offered.
    expect(dialog.querySelector('[data-slot="give-hidden"]')?.textContent).toMatch(/^2 more not listed/);
    const first = dialog.querySelector('[data-window="7c1e5b9a0d2f4e68"]') as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: TAKE_ACTIONS_COPY.give }));
    expect(await within(who).findByText(/^Given to the agent in/)).toBeTruthy();
    expect(asked(bridge, 'takesGive')).toEqual([
      {
        kind: 'takesGive',
        account: 'example/slack',
        message: 'D0EXAMPLE1/1792927860.000100',
        window: '7c1e5b9a0d2f4e68',
      },
    ]);
  });
});

/** An event a rule put in a lane two hours ago, which nobody took. */
const LATE = {
  eventId: 'f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7',
  type: 'gmail.message.received',
  channel: 'gmail',
  accountId: 'in_01EXAMPLE0000000000000000',
  occurredAt: Date.now() - 2 * 60 * 60 * 1000,
  observedAt: Date.now() - 2 * 60 * 60 * 1000,
  source: { channel: 'gmail', messageId: '18c2f0a1b2c3d499' },
  decisions: [{ ruleId: 'invoices', ruleVersion: 1, outcome: 'matched', judge: null }],
  deliveries: [{ deliveryId: 'd7', targetKind: 'queue', targetId: 'billing-q', lane: 'billing', state: 'delivered' }],
  queueItem: null,
  kept: {
    from: {
      name: '<untrusted-content boundary="k1" field="from-name">\nPriya Example\n</untrusted-content boundary="k1">',
    },
  },
};

describe('the Queue’s Not taken', () => {
  it('lists a message nobody took in time, counts it in the badge, and gives it from there', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      eventsMessagesList: () => ok({ messages: [LATE], next: null }),
      takesList: () => ok({ since: null, takes: [], unreadable: [] }),
    });
    renderApp(bridge, { screen: 'queue' });
    const tab = await screen.findByRole('tab', { name: /^Not taken/ });
    // The queue's five open items, and the one nobody took.
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    await waitFor(() => expect(navigation.querySelector('[data-slot="queue-badge"]')?.textContent).toBe('6 6 waiting'));
    fireEvent.click(tab);
    const region = await within(main()).findByRole('region', { name: NOT_TAKEN_COPY.tab });
    const card = await waitFor(() => {
      const found = region.querySelector('li[data-slot="not-taken"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(card.textContent).toContain('No session took it within 15 minutes.');
    expect(card.querySelector('[data-slot="from-outside"]')).not.toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: TAKE_ACTIONS_COPY.handle }));
    await waitFor(() =>
      expect(asked(bridge, 'takesKeep')).toEqual([
        { kind: 'takesKeep', account: 'example/gmail', message: '18c2f0a1b2c3d499' },
      ]),
    );
  });

  it('is not there before core takes messages, and nothing of taking is read', SLOW, async () => {
    const bridge = bridgeAt('0.34.0');
    renderApp(bridge, { screen: 'queue' });
    await screen.findByRole('tab', { name: /^Open/ });
    expect(screen.queryByRole('tab', { name: /^Not taken/ })).toBeNull();
    expect(takingCalls(bridge)).toEqual([]);
  });
});

/** Settings → Taking messages, once its accounts are read. */
async function settings(bridge: FakeBridge): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'settings' });
  const section = await screen.findByRole('region', { name: TAKING_COPY.title });
  await within(section).findByRole('region', { name: 'example/gmail' });
  return section;
}

const pending = (preview: string): CliResult => ({
  status: 'approvalPending',
  approvalId: ID,
  preview,
  expiresAt: null,
});

describe('Settings → Taking messages', () => {
  it('each account, its three settings, and what sessions can do', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {}, { eventServiceState: async () => EVENT_SERVICE.stopped });
    const section = await settings(bridge);
    for (const account of ['example/gmail', 'example/resend', 'example/slack']) {
      expect(within(section).getByRole('region', { name: account })).toBeTruthy();
    }
    const slack = within(section).getByRole('region', { name: 'example/slack' });
    expect(within(slack).getByRole('switch', { name: TAKING_COPY.must }).getAttribute('aria-checked')).toBe('true');
    expect(
      within(slack)
        .getByRole('radio', { name: /^Say so to the sender with 👀/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    // No reply approved in advance holds a 👀 here: nothing would be posted, and it says so.
    await waitFor(() =>
      expect(slack.querySelector('[data-slot="eyes-approval"]')?.textContent).toBe(TAKING_COPY.noEyesApproval),
    );
    // Mail has no 👀.
    const gmail = within(section).getByRole('region', { name: 'example/gmail' });
    expect(within(gmail).queryByRole('radio')).toBeNull();
    expect(within(gmail).getByText(TAKING_COPY.mailSays)).toBeTruthy();
    // The reminder needs the event service, which is switched off here.
    expect(gmail.querySelector('[data-slot="needs-service"]')?.textContent).toContain(TAKING_COPY.serviceOff);
    expect(within(section).getByRole('region', { name: TAKING_COPY.sessions })).toBeTruthy();
    expect(asked(bridge, 'takingChange')).toEqual([]);
  });

  it('requiring a take applies at once; letting sessions act without one is approved in the app', SLOW, async () => {
    const bridge = bridgeAt('0.35.0', {
      takingChange: (call) =>
        (call as Extract<Call, { kind: 'takingChange' }>).appApproval === undefined &&
        (call as Extract<Call, { kind: 'takingChange' }>).change.setting === 'require' &&
        !(call as { change: { on: boolean } }).change.on
          ? pending('Let sessions act on messages in example/gmail without taking them first\n<b>more</b>')
          : ok({ ...taking, change: 'required', changed: true, note: null }),
    });
    const section = await settings(bridge);
    const resend = within(section).getByRole('region', { name: 'example/resend' });
    fireEvent.click(within(resend).getByRole('switch', { name: TAKING_COPY.must }));
    expect(
      await within(resend).findByText(
        'Applied at once: in example/resend, a session must take a message before it acts on it.',
      ),
    ).toBeTruthy();
    const gmail = within(section).getByRole('region', { name: 'example/gmail' });
    fireEvent.click(within(gmail).getByRole('switch', { name: TAKING_COPY.must }));
    const asking = await within(gmail).findByRole('region', {
      name: 'Let sessions act without taking, in example/gmail? Approve it',
    });
    // Core's preview, as text: the tag in it is no element.
    expect(asking.textContent).toContain('<b>more</b>');
    expect(asking.querySelector('b')).toBeNull();
    fireEvent.click(within(asking).getByRole('button', { name: 'Approve' }));
    expect(
      await within(gmail).findByText(
        'Approved. In example/gmail, a session no longer needs to take a message before it acts on it.',
      ),
    ).toBeTruthy();
    expect(asked(bridge, 'takingChange')).toEqual([
      { kind: 'takingChange', account: 'example/resend', change: { setting: 'require', on: true } },
      { kind: 'takingChange', account: 'example/gmail', change: { setting: 'require', on: false } },
      {
        kind: 'takingChange',
        account: 'example/gmail',
        change: { setting: 'require', on: false },
        appApproval: ID,
      },
    ]);
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('a longer wait, and no reminder, are approved in the app; a shorter wait applies at once', SLOW, async () => {
    // Security review of 0.35.0 (LOW): each quieted the person's oversight of messages nobody took, at once.
    const bridge = bridgeAt('0.35.0', {
      takingChange: (call) => {
        const { change, appApproval } = call as Extract<Call, { kind: 'takingChange' }>;
        const loosens =
          (change.setting === 'unclaimed' && change.minutes > 15) || (change.setting === 'notify' && !change.on);
        return loosens && appApproval === undefined
          ? pending('In example/gmail, a message nobody takes within 60 minutes counts as not taken')
          : ok({
              ...taking,
              change: change.setting === 'notify' ? 'notify' : 'afterMinutes',
              changed: true,
              note: null,
            });
      },
    });
    const section = await settings(bridge);
    const gmail = within(section).getByRole('region', { name: 'example/gmail' });
    const choose = async (name: string, option: string) => {
      fireEvent.click(within(gmail).getByRole('combobox', { name }));
      const item = await screen.findByRole('option', { name: option });
      fireEvent.pointerMove(item);
      fireEvent.mouseMove(item);
      fireEvent.click(item);
    };
    await choose('How long, in example/gmail', '1 hour');
    const longer = await within(gmail).findByRole('region', {
      name: 'Wait 1 hour before a message nobody takes counts, in example/gmail? Approve it',
    });
    fireEvent.click(within(longer).getByRole('button', { name: 'Approve' }));
    expect(
      await within(gmail).findByText(
        'Approved. In example/gmail, a message nobody takes within 1 hour counts as not taken.',
      ),
    ).toBeTruthy();
    await choose('Then, in example/gmail', TAKING_COPY.queue);
    const silent = await within(gmail).findByRole('region', {
      name: 'Stop reminding you of a message nobody takes, in example/gmail? Approve it',
    });
    fireEvent.click(within(silent).getByRole('button', { name: 'Approve' }));
    expect(
      await within(gmail).findByText(
        'Approved. In example/gmail, a message nobody takes waits under Queue → Not taken, with no notice.',
      ),
    ).toBeTruthy();
    await choose('How long, in example/gmail', '5 minutes');
    expect(
      await within(gmail).findByText(
        'Saved: in example/gmail, a message nobody takes within 5 minutes counts as not taken, and you’re reminded.',
      ),
    ).toBeTruthy();
    expect(asked(bridge, 'takingChange')).toEqual([
      { kind: 'takingChange', account: 'example/gmail', change: { setting: 'unclaimed', minutes: 60 } },
      {
        kind: 'takingChange',
        account: 'example/gmail',
        change: { setting: 'unclaimed', minutes: 60 },
        appApproval: ID,
      },
      { kind: 'takingChange', account: 'example/gmail', change: { setting: 'notify', on: false } },
      { kind: 'takingChange', account: 'example/gmail', change: { setting: 'notify', on: false }, appApproval: ID },
      { kind: 'takingChange', account: 'example/gmail', change: { setting: 'unclaimed', minutes: 5 } },
    ]);
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('an older core gets the update line, and nothing of taking is read', SLOW, async () => {
    const bridge = bridgeAt('0.34.0');
    renderApp(bridge, { screen: 'settings' });
    const section = await screen.findByRole('region', { name: TAKING_COPY.title });
    expect(await within(section).findByText('Needs 0.35.0 or later; this machine has 0.34.0.')).toBeTruthy();
    expect(takingCalls(bridge)).toEqual([]);
  });
});

describe('an account’s Agents here', () => {
  it('has the account’s Taking messages, once core takes messages', SLOW, async () => {
    const bridge = bridgeAt();
    renderApp(bridge, { screen: 'accounts' });
    fireEvent.click(await screen.findByRole('tab', { name: /^Slack(,|$)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open example/slack' }));
    const page = await screen.findByRole('region', { name: 'example/slack' });
    const section = await within(page).findByRole('region', { name: TAKING_COPY.title });
    expect(await within(section).findByRole('switch', { name: TAKING_COPY.must })).toBeTruthy();
  });
});
