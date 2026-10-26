import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call, Installation } from '../ipc.ts';
import { NavigationProvider, useNavigate } from '../navigation.tsx';
import { STORY_COPY } from '../screens/MessageStory.tsx';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, type Fixture, failed } from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';
import { renderApp } from './render.tsx';

/*
 * A message's story (spec 2026-10-26-owner-feedback-0320 §3.6, prototype row 4, "MessageTimeline"): opened from its
 * card, read from the event service's `message show` and the activity the list read, with when the person approved a
 * reply from the approvals they used. Against the fake bridge: nothing runs, and nothing opens.
 */

const SLOW = { timeout: 30_000 };

const main = (): HTMLElement => screen.getByRole('main');

const at = (version: string): Installation => ({ ...EXAMPLE_INSTALLATION, version });

/** The approval the person used for the invoice's reply, and another's. */
const USED = [
  {
    id: 'ap_01STORY0000000000000000001',
    approvalId: 'ap_01STORY0000000000000000001',
    kind: 'send',
    channel: 'gmail',
    state: 'used',
    draftId: 'r-2000000000000000001',
    approvedAt: '2026-10-25T11:45:12.000Z',
    usedAt: '2026-10-25T11:45:13.000Z',
  },
  {
    id: 'ap_01STORY0000000000000000002',
    approvalId: 'ap_01STORY0000000000000000002',
    kind: 'send',
    channel: 'gmail',
    state: 'used',
    draftId: 'r-9000000000000000009',
    approvedAt: '2026-10-25T09:00:00.000Z',
  },
];

function bridgeAt(
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
  handlers: Parameters<typeof createFakeBridge>[0] = {},
) {
  return createFakeBridge(
    { installation: async () => at('0.32.0'), ...handlers },
    {
      eventsMessagesList: messagesList,
      eventsMessageShow: messageShow,
      activityItems,
      approvalsFinished: (call: Call) =>
        (call as Extract<Call, { kind: 'approvalsFinished' }>).state === 'used' ? USED : [],
      version: '0.32.0',
      ...fixtures,
    },
  );
}

const cliCalls = (bridge: FakeBridge, kind: string): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli')
    .map((call) => call.args as Call)
    .filter((call) => call.kind === kind);

/** Opens the Messages screen and the card whose key starts with `key`, and waits for its story. */
async function story(bridge: FakeBridge, key: string): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'messages' });
  await screen.findByRole('heading', { level: 1, name: 'Messages' });
  await waitFor(() => expect(main().querySelector(`li[data-message^="${key}"]`)).not.toBeNull());
  const card = main().querySelector<HTMLElement>(`li[data-message^="${key}"]`);
  if (card === null) throw new Error(`no card ${key}`);
  fireEvent.click(within(card).getByRole('button'));
  await screen.findByRole('heading', { level: 1, name: /^A .*message/ });
  return within(main()).findByRole('region', { name: STORY_COPY.happened });
}

/** The timeline's entries, each as its words. */
function entries(happened: HTMLElement): string[] {
  return Array.from(happened.querySelectorAll('[data-slot="story-what"]')).map((each) => each.textContent ?? '');
}

describe('a message’s story', () => {
  it(
    'a card opens its story: who it is from, its status, what happened, the windows, and the honest line',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const happened = await story(bridge, 'event:e1');
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe('A message from From outside: David Example');
      expect(heading.querySelector('[data-slot="from-outside"]')).not.toBeNull();
      expect(main().querySelector('[data-slot="message-status"]')?.textContent).toBe('Replied');
      // Read from `message show`, whose history is whole, and the approval the person used for the reply.
      expect(cliCalls(bridge, 'eventsMessageShow')).toEqual([
        { kind: 'eventsMessageShow', eventId: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1' },
      ]);
      expect(cliCalls(bridge, 'approvalsFinished')).toEqual([{ kind: 'approvalsFinished', state: 'used' }]);
      await waitFor(() => expect(entries(happened)).toContain('You approved the reply'));
      expect(entries(happened)).toEqual([
        'Arrived in example/gmail',
        'Matched the rule invoices',
        'Jev said yes, 0.86 sure',
        'Put in the Queue, lane billing',
        'Woke the agent window bound to billing',
        'An agent read it from the Queue',
        'An agent read it',
        'An agent drafted a reply',
        'It asked to send the reply',
        'An agent read it from the Queue',
        'You approved the reply',
        'The reply was sent',
        'The agent marked it done in the Queue',
        'An agent read its thread',
      ]);
      // The message: where and when, its subject boxed From outside, and how far it got.
      const message = within(main()).getByRole('region', { name: STORY_COPY.message });
      expect(within(message).getByText('Can you send the March invoice?')).toBeTruthy();
      expect(
        within(message).getByText(
          /^An agent replied in the same thread at .+, after you approved the reply\. It's done in the Queue\.$/,
        ),
      ).toBeTruthy();
      const windows = within(main()).getByRole('region', { name: STORY_COPY.windows });
      expect(within(windows).getByText('~/work/acme')).toBeTruthy();
      expect(
        within(windows).getByText(
          'claude-code 2.1.0 · bound to lane billing · was woken for it, read it 4 times, sent one reply, marked it done',
        ),
      ).toBeTruthy();
      expect(within(main()).getByText(STORY_COPY.honest)).toBeTruthy();
      expect(STORY_COPY.honest).toBe(
        "Built from what Agent Comms saw. Anything an agent did outside Agent Comms isn't here.",
      );
    },
  );

  it(
    'Open in Gmail opens the message in its account; See in Activity opens Activity; Back returns to the list',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      await story(bridge, 'event:e1');
      fireEvent.click(within(main()).getByRole('button', { name: 'Open in Gmail' }));
      await waitFor(() =>
        expect(bridge.calls).toContainEqual({
          command: 'openLink',
          args: 'https://mail.google.com/mail/?authuser=jo%40example.com#all/18c2f0a1b2c3d4e5',
        }),
      );
      fireEvent.click(within(main()).getByRole('button', { name: STORY_COPY.back }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
      await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull());
      // Again, and on to the windows' timelines.
      const card = main().querySelector<HTMLElement>('li[data-message^="event:e1"]');
      if (card === null) throw new Error('no card');
      fireEvent.click(within(card).getByRole('button'));
      const windows = await within(main()).findByRole('region', { name: STORY_COPY.windows });
      fireEvent.click(within(windows).getByRole('button', { name: STORY_COPY.seeInActivity }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Activity' })).toBeTruthy();
    },
  );

  it('a Slack message opens in its workspace, at its thread', SLOW, async () => {
    const bridge = bridgeAt();
    await story(bridge, 'event:e2');
    fireEvent.click(within(main()).getByRole('button', { name: 'Open in Slack' }));
    await waitFor(() =>
      expect(bridge.calls).toContainEqual({
        command: 'openLink',
        args: 'https://app.slack.com/client/T0EXAMPLE/D0EXAMPLE1/thread/D0EXAMPLE1-1792927860.000100',
      }),
    );
  });

  it(
    'a message only an agent read: no event to show, and the story says the event service did not see it',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const happened = await story(bridge, 'item:18c2f0a1b2c3e000');
      expect(cliCalls(bridge, 'eventsMessageShow')).toEqual([]);
      expect(entries(happened)).toEqual([
        "The event service didn't see it arrive",
        'An agent saw it while searching your mail',
      ]);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A message from From outside: Receipts');
      // Its account is not one the app knows: no link to open.
      expect(within(main()).queryByRole('button', { name: /^Open in/ })).toBeNull();
    },
  );

  it('with nothing that kept its sender, the story says what it is; a sender’s markup stays text', SLOW, async () => {
    await story(bridgeAt(), 'event:e4');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('A Gmail message');
    expect(
      within(main()).getByText('A Gmail message. No rule kept its sender or subject, so open it in Gmail to see it.'),
    ).toBeTruthy();
  });

  it('a sender’s markup in the story is text', SLOW, async () => {
    await story(bridgeAt({ eventsMessageShow: messagesList.messages[4] }), 'event:e5');
    expect(within(main()).getByText('<img src=x onerror=alert(1)> Is the deploy done?')).toBeTruthy();
    expect(main().querySelector('img')).toBeNull();
  });

  it('a message the event service no longer keeps shows what the list read, and says so', SLOW, async () => {
    const bridge = bridgeAt(
      {},
      {
        cli: async (call) =>
          call.kind === 'eventsMessageShow'
            ? failed('NOT_FOUND', 'No event e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1.', null, 66)
            : bridgeAt().cli(call),
      },
    );
    const happened = await story(bridge, 'event:e1');
    expect(await within(main()).findByText(STORY_COPY.gone)).toBeTruthy();
    // The list's history, without the read only `message show` has.
    expect(entries(happened).filter((each) => each === 'An agent read it from the Queue')).toHaveLength(1);
  });

  it('a show that fails otherwise says what went wrong, over what the list read', SLOW, async () => {
    const bridge = bridgeAt(
      {},
      {
        cli: async (call) =>
          call.kind === 'eventsMessageShow'
            ? failed('EVENTS_NOT_RUNNING', 'The event service is not running.')
            : bridgeAt().cli(call),
      },
    );
    await story(bridge, 'event:e1');
    expect(await within(main()).findByText('The event service is not running.')).toBeTruthy();
    expect(within(main()).getByRole('region', { name: STORY_COPY.happened })).toBeTruthy();
  });

  /**
   * Another screen opens a message's story as Deliveries does: `navigate({ screen: 'messages', eventId })`, from inside
   * its `NavigationProvider`. Here a button in a provider of its own asks, and the sidebar opens Messages, as the shell's
   * `onScreen` would.
   */
  async function openFromElsewhere(bridge: FakeBridge, eventId: string): Promise<void> {
    function Asker() {
      const navigate = useNavigate();
      return (
        <button type="button" onClick={() => navigate?.({ screen: 'messages', eventId })}>
          See everything that happened to this message
        </button>
      );
    }
    renderApp(bridge, { screen: 'overview' });
    const navigation = await screen.findByRole('navigation', { name: 'Sections' });
    const asker = render(
      <NavigationProvider onScreen={() => undefined}>
        <Asker />
      </NavigationProvider>,
    );
    fireEvent.click(asker.getByRole('button', { name: 'See everything that happened to this message' }));
    asker.unmount();
    fireEvent.click(within(navigation).getByRole('button', { name: /^Messages/ }));
  }

  it('another screen opens a message’s story by its event id, and Back goes to the list', SLOW, async () => {
    const bridge = bridgeAt();
    await openFromElsewhere(bridge, 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1');
    const heading = await screen.findByRole('heading', { level: 1, name: /^A message from/ });
    expect(heading.textContent).toBe('A message from From outside: David Example');
    expect(await within(main()).findByRole('region', { name: STORY_COPY.happened })).toBeTruthy();
    // It is in the list's page: one `message show`, for the story's whole history.
    await waitFor(() => expect(cliCalls(bridge, 'eventsMessageShow')).toHaveLength(1));
    fireEvent.click(within(main()).getByRole('button', { name: STORY_COPY.back }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
    await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull());
    // The destination was read once: opening Messages again shows the list.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: 'Overview' }),
    );
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Messages/ }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
  });

  it('a message older than the list’s page opens from `message show` alone', SLOW, async () => {
    const bridge = bridgeAt({ eventsMessagesList: { messages: messagesList.messages.slice(1), next: null } });
    await openFromElsewhere(bridge, 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1');
    expect(await screen.findByRole('heading', { level: 1, name: /^A message from/ })).toBeTruthy();
    const happened = await within(main()).findByRole('region', { name: STORY_COPY.happened });
    // Joined with the activity the list read: the reply is there, and the full history.
    expect(entries(happened)).toContain('The reply was sent');
    expect(entries(happened).filter((each) => each === 'An agent read it from the Queue')).toHaveLength(2);
    expect(cliCalls(bridge, 'eventsMessageShow')).toEqual([
      { kind: 'eventsMessageShow', eventId: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1' },
    ]);
  });

  it('a message the event service no longer keeps says so, with the way back to the list', SLOW, async () => {
    const bridge = bridgeAt(
      { eventsMessagesList: { messages: [], next: null } },
      {
        cli: async (call) =>
          call.kind === 'eventsMessageShow'
            ? failed('NOT_FOUND', 'No event f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0.', null, 66)
            : bridgeAt({ eventsMessagesList: { messages: [], next: null } }).cli(call),
      },
    );
    await openFromElsewhere(bridge, 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0');
    expect(await within(main()).findByText(STORY_COPY.notKept)).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: STORY_COPY.back }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
  });

  it('an id that is not an event’s opens the list, and asks nothing for it', SLOW, async () => {
    const bridge = bridgeAt();
    await openFromElsewhere(bridge, 'not-an-event');
    expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
    await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull());
    expect(cliCalls(bridge, 'eventsMessageShow')).toEqual([]);
  });
});
