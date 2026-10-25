import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import queueTargetSource from '../../../../packages/events-daemon/src/domain/queue-target.ts?raw';
import { COPY } from '../copy.ts';
import type { Call, CliResult } from '../ipc.ts';
import { judgeWords, openableLink, type QueueJudge, queueLink, readQueueCounts, readQueueList } from '../queue.ts';
import { QUEUE_COPY, QUEUE_LIMIT, QUEUE_POLL_MS } from '../screens/Queue.tsx';
import {
  createFakeBridge,
  type FakeBridge,
  type Fixture,
  failed,
  fakeQueue,
  QUEUE_COUNTS,
  QUEUE_INSTALLATION,
  QUEUE_LISTS,
  queueListAnswer,
} from './fake-bridge.ts';
import queueLinks from './fixtures/queue-links.json';
import { renderApp } from './render.tsx';

/** A screen that reads under a loaded machine: each test is given room. */
const SLOW = { timeout: 30_000 };

const main = (): HTMLElement => screen.getByRole('main');

/** The ids of the open fixture's items, newest first. */
const OPEN = QUEUE_LISTS.open.items.map((item) => item.id);
const DONE = QUEUE_LISTS.done.items.map((item) => item.id);
const DISMISSED = QUEUE_LISTS.dismissed.items.map((item) => item.id);

/**
 * A bridge with core and the events service at `events` (0.30.0 by default, the first with the queue), answering from
 * the queue's fixtures over `fixtures`, with any command replaced by `handlers`.
 */
function bridgeAt(
  events = '0.30.0',
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
  handlers: Parameters<typeof createFakeBridge>[0] = {},
): FakeBridge {
  return createFakeBridge(
    { installation: async () => QUEUE_INSTALLATION, ...handlers },
    {
      ...fakeQueue(),
      version: (call: Call) =>
        (call as Extract<Call, { kind: 'version' }>).product === 'events-daemon' ? events : '0.30.0',
      ...fixtures,
    },
  );
}

/** Every queue call made, in order. */
const queueCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli')
    .map((call) => call.args as Call)
    .filter((call) => call.kind.startsWith('queue'));

const lists = (bridge: FakeBridge): Call[] => queueCalls(bridge).filter((call) => call.kind === 'queueList');

/** The Queue screen's tab named `name`, by the start of its name: its count follows it. */
const tab = (name: string): Promise<HTMLElement> =>
  within(main()).findByRole('tab', { name: new RegExp(`^${name}\\b`) });

async function openTab(name: string): Promise<HTMLElement> {
  fireEvent.click(await tab(name));
  await waitFor(async () => expect((await tab(name)).getAttribute('aria-selected')).toBe('true'));
  const view = await within(main()).findByRole('region', { name });
  await waitFor(() => expect(within(view).queryByRole('status', { name: COPY.loading })).toBeNull());
  return view;
}

/** The cards a view shows, by item id, once there are any. */
async function cards(view: HTMLElement): Promise<HTMLElement[]> {
  await waitFor(() => expect(view.querySelector('[data-item]')).not.toBeNull());
  return Array.from(view.querySelectorAll<HTMLElement>('li[data-item]'));
}

function card(view: HTMLElement, id: string): HTMLElement {
  const found = view.querySelector<HTMLElement>(`li[data-item="${id}"]`);
  if (found === null) throw new Error(`no card for ${id}`);
  return found;
}

/** The Open view, once its cards are there. */
async function opened(bridge: FakeBridge): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'queue' });
  await screen.findByRole('heading', { level: 1, name: 'Queue' });
  const view = await within(main()).findByRole('region', { name: 'Open' });
  await cards(view);
  return view;
}

/** Chooses `option` in the filter named `name`, as a pointer does. */
async function choose(name: string, option: string): Promise<void> {
  fireEvent.click(within(main()).getByRole('combobox', { name }));
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerMove(item);
  fireEvent.mouseMove(item);
  fireEvent.click(item);
  await waitFor(() => expect(within(main()).getByRole('combobox', { name }).textContent).toContain(option));
}

const judge = (given: Partial<QueueJudge>): QueueJudge => ({
  state: 'answered',
  id: null,
  kind: null,
  model: null,
  question: null,
  answer: null,
  confidence: null,
  uncalibrated: false,
  ...given,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Queue', () => {
  it(
    'sits first after Overview, and an older events service gets the update line and none of its calls',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.29.0');
      renderApp(bridge);
      const navigation = await screen.findByRole('navigation', { name: 'Sections' });
      const names = within(navigation)
        .getAllByRole('button')
        .map((button) => button.textContent?.trim());
      expect(names.slice(0, 3)).toEqual(['Overview', 'Queue', 'Accounts']);
      fireEvent.click(within(navigation).getByRole('button', { name: 'Queue' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Queue' })).toBeTruthy();
      expect(await within(main()).findByText(COPY.updateToUse)).toBeTruthy();
      expect(within(main()).getByText('Needs 0.30.0 or later; this machine has 0.29.0.')).toBeTruthy();
      // The gate reads the events service's own version: core at 0.30.0 does not open it.
      expect(bridge.calls).toContainEqual({ command: 'cli', args: { kind: 'version', product: 'events-daemon' } });
      expect(queueCalls(bridge)).toEqual([]);
      // No badge, as nothing was counted.
      expect(navigation.querySelector('[data-slot="queue-badge"]')).toBeNull();
    },
  );

  it('with no events service says so, and asks it nothing', SLOW, async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...QUEUE_INSTALLATION, present: ['core', 'gmail', 'slack'] }),
    });
    renderApp(bridge, { screen: 'queue' });
    expect(await within(await screen.findByRole('main')).findByText(QUEUE_COPY.notInstalled)).toBeTruthy();
    expect(bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args)).not.toContainEqual({
      kind: 'version',
      product: 'events-daemon',
    });
    expect(queueCalls(bridge)).toEqual([]);
  });

  it('a pull request build of 0.30.0 has the queue too', SLOW, async () => {
    const view = await opened(bridgeAt('0.30.0-feat-0.30'));
    expect(await cards(view)).toHaveLength(OPEN.length);
  });

  it(
    'three tabs, Open first with its count, Done and Dismissed with theirs; the sidebar badge is the open count',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await opened(bridge);
      const list = within(main()).getByRole('tablist', { name: 'Queue' });
      const names = within(list)
        .getAllByRole('tab')
        .map((each) => each.textContent?.replace(/\d.*$/, '').trim());
      expect(names).toEqual(['Open', 'Done', 'Dismissed']);
      expect((await tab('Open')).getAttribute('aria-selected')).toBe('true');
      await waitFor(() => expect(within(list).getByRole('tab', { name: 'Open 5 waiting' })).toBeTruthy());
      expect(within(list).getByRole('tab', { name: 'Done 2' })).toBeTruthy();
      expect(within(list).getByRole('tab', { name: 'Dismissed 1' })).toBeTruthy();
      // The sidebar's Queue carries the open count, said in full to a screen reader.
      const navigation = screen.getByRole('navigation', { name: 'Sections' });
      const badge = navigation.querySelector('[data-slot="queue-badge"]');
      expect(badge?.textContent).toBe('5 5 waiting');
      expect(within(navigation).getByRole('button', { name: /^Queue\s*5 waiting$/ })).toBeTruthy();
      // Open: every open item, newest first, each one card.
      expect((await cards(view)).map((each) => each.dataset.item)).toEqual(OPEN);
      // Done and Dismissed each read their own list when opened.
      const done = await openTab('Done');
      expect((await cards(done)).map((each) => each.dataset.item)).toEqual(DONE);
      const dismissed = await openTab('Dismissed');
      expect((await cards(dismissed)).map((each) => each.dataset.item)).toEqual(DISMISSED);
      expect(lists(bridge)).toEqual([
        { kind: 'queueList', state: 'open', limit: QUEUE_LIMIT },
        { kind: 'queueList', state: 'done', limit: QUEUE_LIMIT },
        { kind: 'queueList', state: 'dismissed', limit: QUEUE_LIMIT },
      ]);
      expect(queueCalls(bridge).filter((call) => call.kind === 'queueCounts').length).toBeGreaterThan(0);
    },
  );

  it('what the queue is stays reachable as a hint beside the tabs', SLOW, async () => {
    await opened(bridgeAt());
    const trigger = within(main()).getByRole('button', { name: 'About the queue' });
    await act(async () => {
      trigger.focus();
    });
    expect((await screen.findByRole('tooltip')).textContent).toBe(QUEUE_COPY.about);
  });

  it(
    'a card says where, from whom and what, the rule and when, each sender-written string marked From outside',
    SLOW,
    async () => {
      const view = await opened(bridgeAt());
      const first = card(view, OPEN[0] as string);
      expect(within(first).getByText('Gmail · example/gmail')).toBeTruthy();
      expect(within(first).getByText('David Example')).toBeTruthy();
      expect(within(first).getByText('david@example.com')).toBeTruthy();
      expect(within(first).getByText('Can you send the March invoice?')).toBeTruthy();
      expect(first.querySelector('[data-slot="queue-rule"]')?.textContent).toBe('Mail that asks something');
      expect(first.querySelector('time[datetime="2026-10-25T09:40:00.000Z"]')).not.toBeNull();
      // Each sender-written string is boxed and named From outside, and the card says it once, visibly.
      expect(first.querySelectorAll('[data-slot="from-outside"]')).toHaveLength(3);
      expect(within(first).getByText(COPY.fromOutside, { selector: '[data-slot="from-outside-label"]' })).toBeTruthy();
      // Slack's first words stand where a subject would.
      const slack = card(view, OPEN[1] as string);
      expect(within(slack).getByText('Slack · example/slack')).toBeTruthy();
      expect(within(slack).getByText('Can you look at the deploy before 5? It fails on the second step.')).toBeTruthy();
      expect(within(card(view, OPEN[3] as string)).getByText('WhatsApp · example/whatsapp')).toBeTruthy();
      expect(within(card(view, OPEN[4] as string)).getByText('Resend · example/resend')).toBeTruthy();
      // Nothing of the envelope shows.
      expect(main().textContent).not.toContain('untrusted-content');
      expect(main().textContent).not.toContain('q7Tn2bXa');
    },
  );

  it('untrusted text is never rendered as HTML', SLOW, async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const view = await opened(bridgeAt());
    const hostile = card(view, OPEN[2] as string);
    // The hostile name and subject are text, whole, in their boxes: no element came of them, nothing ran.
    const boxed = Array.from(hostile.querySelectorAll('[data-slot="from-outside"] span.whitespace-pre-wrap')).map(
      (each) => each.textContent,
    );
    expect(boxed).toEqual([
      '<script>alert(1)</script> Accounts',
      'billing@evil.example',
      '<img src=x onerror=alert(1)> Overdue: pay now',
    ]);
    expect(main().querySelector('script, img, iframe, object, embed, a[href]')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    // A text node each, not markup read back.
    const subject = within(hostile).getByText('<img src=x onerror=alert(1)> Overdue: pay now');
    expect(subject.childNodes).toHaveLength(1);
    expect(subject.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    alert.mockRestore();
  });

  it(
    'each judge chip: answered, uncalibrated, no longer kept, let through, and none without a judge',
    SLOW,
    async () => {
      const view = await opened(bridgeAt());
      const chip = (id: string) => card(view, id).querySelector<HTMLElement>('[data-slot="queue-judge"]');
      expect(chip(OPEN[0] as string)?.textContent).toBe('Jev: yes, 0.86');
      expect(chip(OPEN[0] as string)?.dataset.judge).toBe('answered');
      expect(chip(OPEN[1] as string)?.textContent).toBe('Local model: yes, 0.71, uncalibrated');
      expect(chip(OPEN[2] as string)?.textContent).toBe("The judge's answer is no longer kept");
      expect(chip(OPEN[2] as string)?.dataset.judge).toBe('expired');
      expect(chip(OPEN[3] as string)).toBeNull();
      expect(chip(OPEN[4] as string)?.textContent).toBe('You let it through');
      expect(chip(OPEN[4] as string)?.dataset.judge).toBe('released');
      // What the rule asked, and why a score is uncalibrated, are one hint beside the chip; none without a judge.
      const about = (id: string) => within(card(view, id)).queryAllByRole('button', { name: QUEUE_COPY.aboutAnswer });
      expect(about(OPEN[0] as string)).toHaveLength(1);
      expect(about(OPEN[1] as string)).toHaveLength(1);
      for (const id of [OPEN[2], OPEN[3], OPEN[4]] as string[]) expect(about(id), id).toHaveLength(0);
      await act(async () => {
        about(OPEN[1] as string)[0]?.focus();
      });
      const tip = (await screen.findByRole('tooltip')).textContent ?? '';
      expect(tip).toContain(`${QUEUE_COPY.asked} Is David asking me for something?`);
      expect(tip).toContain(QUEUE_COPY.uncalibratedHint);
    },
  );

  it('judgeWords says each answer in a few words', () => {
    expect(judgeWords(judge({ kind: 'typesafe', answer: 'yes', confidence: 0.86 }))).toBe('Jev: yes, 0.86');
    expect(judgeWords(judge({ kind: 'typesafe', answer: 'no', confidence: 0.9 }))).toBe('Jev: no, 0.90');
    expect(judgeWords(judge({ kind: 'laya', answer: 'yes', confidence: 0.5 }))).toBe('Laya: yes, 0.50');
    expect(judgeWords(judge({ kind: 'local-endpoint', answer: 'no', confidence: 2.345, uncalibrated: true }))).toBe(
      'Local model: no, 2.35, uncalibrated',
    );
    expect(judgeWords(judge({ kind: 'typesafe', answer: 'yes' }))).toBe('Jev: yes');
    expect(judgeWords(judge({ kind: 'typesafe' }))).toBe('Jev answered');
    expect(judgeWords(judge({ kind: 'something-new', id: 'my-judge', answer: 'yes', confidence: 0.7 }))).toBe(
      'my-judge: yes, 0.70',
    );
    expect(judgeWords(judge({ state: 'expired', kind: 'typesafe', answer: 'yes', confidence: 0.86 }))).toBe(
      "The judge's answer is no longer kept",
    );
    expect(judgeWords(judge({ state: 'released' }))).toBe('You let it through');
    expect(judgeWords(judge({ state: 'none' }))).toBeNull();
  });

  it('Done and Dismiss apply at once, each its exact call, and the item leaves Open', SLOW, async () => {
    const bridge = bridgeAt();
    const view = await opened(bridge);
    const before = lists(bridge).length;
    fireEvent.click(within(card(view, OPEN[0] as string)).getByRole('button', { name: QUEUE_COPY.done }));
    await waitFor(() => expect(view.querySelector(`li[data-item="${OPEN[0]}"]`)).toBeNull());
    fireEvent.click(within(card(view, OPEN[1] as string)).getByRole('button', { name: QUEUE_COPY.dismiss }));
    await waitFor(() => expect(view.querySelector(`li[data-item="${OPEN[1]}"]`)).toBeNull());
    const changes = queueCalls(bridge).filter((call) => call.kind !== 'queueList' && call.kind !== 'queueCounts');
    expect(changes).toEqual([
      { kind: 'queueDone', itemId: OPEN[0] },
      { kind: 'queueDismiss', itemId: OPEN[1] },
    ]);
    // Each change reads the list and the counts again; the app opened no terminal and approved nothing.
    await waitFor(() => expect(lists(bridge).length).toBeGreaterThanOrEqual(before + 2));
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
    for (const call of queueCalls(bridge)) expect(JSON.stringify(call)).not.toMatch(/approv/i);
  });

  it('Reopen puts a done or dismissed item back, with its exact call', SLOW, async () => {
    const bridge = bridgeAt();
    await opened(bridge);
    const done = await openTab('Done');
    expect(within(card(done, DONE[0] as string)).queryByRole('button', { name: QUEUE_COPY.done })).toBeNull();
    fireEvent.click(within(card(done, DONE[0] as string)).getByRole('button', { name: QUEUE_COPY.reopen }));
    await waitFor(() => expect(done.querySelector(`li[data-item="${DONE[0]}"]`)).toBeNull());
    const dismissed = await openTab('Dismissed');
    fireEvent.click(within(card(dismissed, DISMISSED[0] as string)).getByRole('button', { name: QUEUE_COPY.reopen }));
    await waitFor(() =>
      expect(queueCalls(bridge)).toContainEqual({ kind: 'queueReopen', itemId: DISMISSED[0] as string }),
    );
    expect(queueCalls(bridge).filter((call) => call.kind === 'queueReopen')).toEqual([
      { kind: 'queueReopen', itemId: DONE[0] },
      { kind: 'queueReopen', itemId: DISMISSED[0] },
    ]);
  });

  it('Clear asks first: Cancel runs nothing, Clear purges the done and dismissed and says how many', SLOW, async () => {
    const bridge = bridgeAt();
    await opened(bridge);
    // Not offered under Open, which it never touches.
    expect(within(main()).queryByRole('button', { name: QUEUE_COPY.clear })).toBeNull();
    await openTab('Done');
    fireEvent.click(within(main()).getByRole('button', { name: QUEUE_COPY.clear }));
    const dialog = await screen.findByRole('alertdialog', { name: QUEUE_COPY.clearTitle });
    expect(within(dialog).getByText(QUEUE_COPY.clearBody)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: COPY.cancel }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(queueCalls(bridge).filter((call) => call.kind === 'queueClear')).toEqual([]);
    fireEvent.click(within(main()).getByRole('button', { name: QUEUE_COPY.clear }));
    const again = await screen.findByRole('alertdialog', { name: QUEUE_COPY.clearTitle });
    fireEvent.click(within(again).getByRole('button', { name: QUEUE_COPY.clearAction }));
    expect(await within(main()).findByText('Cleared 3 items.')).toBeTruthy();
    expect(queueCalls(bridge).filter((call) => call.kind === 'queueClear')).toEqual([{ kind: 'queueClear' }]);
  });

  it('Clear is off when nothing is done or dismissed', SLOW, async () => {
    const bridge = bridgeAt('0.30.0', { queueCounts: { ...QUEUE_COUNTS, done: 0, dismissed: 0 } });
    await opened(bridge);
    fireEvent.click(await tab('Done'));
    const button = await within(main()).findByRole('button', { name: QUEUE_COPY.clear });
    expect(button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('an item the queue no longer has says so, and the list is read again', SLOW, async () => {
    const bridge = bridgeAt(
      '0.30.0',
      {},
      {
        cli: async (call: Call): Promise<CliResult> => {
          if (call.kind === 'queueDone') return failed('CLI_FAILED', 'no such queue item', null, 66);
          return bridgeAt().cli(call);
        },
      },
    );
    const view = await opened(bridge);
    const before = lists(bridge).length;
    fireEvent.click(within(card(view, OPEN[0] as string)).getByRole('button', { name: QUEUE_COPY.done }));
    expect(await within(card(view, OPEN[0] as string)).findByText(QUEUE_COPY.gone)).toBeTruthy();
    await waitFor(() => expect(lists(bridge).length).toBeGreaterThan(before));
  });

  it('any other failure is said as the CLI said it, and the item stays', SLOW, async () => {
    const failing = bridgeAt(
      '0.30.0',
      {},
      {
        cli: async (call: Call): Promise<CliResult> =>
          call.kind === 'queueDismiss'
            ? failed('CLI_FAILED', 'the events service is not running')
            : bridgeAt().cli(call),
      },
    );
    const view = await opened(failing);
    fireEvent.click(within(card(view, OPEN[1] as string)).getByRole('button', { name: QUEUE_COPY.dismiss }));
    expect(await within(card(view, OPEN[1] as string)).findByText('the events service is not running')).toBeTruthy();
    expect(card(view, OPEN[1] as string)).toBeTruthy();
  });

  it(
    'opens a Gmail or Slack link through open_link, and offers none for another host or the wrong kind',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await opened(bridge);
      fireEvent.click(within(card(view, OPEN[0] as string)).getByRole('button', { name: 'Open in Gmail' }));
      fireEvent.click(within(card(view, OPEN[1] as string)).getByRole('button', { name: 'Open in Slack' }));
      expect(bridge.calls.filter((call) => call.command === 'openLink')).toEqual([
        { command: 'openLink', args: 'https://mail.google.com/mail/u/0/#all/18c2f0a1b2c3d4e5' },
        {
          command: 'openLink',
          args: 'https://app.slack.com/client/T0123ABCD/C0123ABCD/thread/C0123ABCD-1792921860.000100',
        },
      ]);
      // The hostile item's "Gmail" link is on another host: no button. WhatsApp's and Resend's items have no link.
      for (const id of [OPEN[2], OPEN[3], OPEN[4]] as string[]) {
        expect(within(card(view, id)).queryByRole('button', { name: /^Open in/ }), id).toBeNull();
      }
      // Nothing on the page is a link that would leave the window.
      expect(main().querySelector('a[href]')).toBeNull();
    },
  );

  it('queueLink opens exactly the links the event service makes, and nothing else on their hosts', () => {
    // The same file Rust's `links::queue_link` is tested against (`links.rs`).
    expect(queueLinks.opens.length).toBeGreaterThanOrEqual(10);
    for (const { kind, url } of queueLinks.opens) {
      expect(queueLink(url), url).toBe(true);
      expect(openableLink({ kind: kind as 'gmail' | 'slack', url }), url).toEqual({
        label: kind === 'gmail' ? 'Open in Gmail' : 'Open in Slack',
        url,
      });
    }
    expect(queueLinks.refused.length).toBeGreaterThanOrEqual(40);
    for (const url of queueLinks.refused) {
      expect(queueLink(url), url).toBe(false);
      expect(openableLink({ kind: 'gmail', url }), url).toBeNull();
      expect(openableLink({ kind: 'slack', url }), url).toBeNull();
    }
    for (const url of [
      'https://mail.google.com/mail/?view=cm&body=hello%20there&to=someone%40example.com',
      'https://example.slack.com/signout',
      'https://app.slack.com/admin',
    ]) {
      expect(queueLinks.refused, url).toContain(url);
    }
    // A link of one kind on the other's host is none.
    expect(openableLink({ kind: 'slack', url: 'https://mail.google.com/mail/u/0/#all/x' })).toBeNull();
    expect(openableLink({ kind: 'gmail', url: 'https://app.slack.com/client/T1/C1' })).toBeNull();
    expect(openableLink(null)).toBeNull();
  });

  it("the shapes are the event service's own: its id patterns and its two URL templates", () => {
    // Read from its source, as grammar.test.ts reads core's: a change there fails here, and the allow-list follows it.
    const source = queueTargetSource;
    expect(queueLinks.producer).toHaveLength(7);
    for (const line of queueLinks.producer) {
      expect(source, line).toContain(line);
    }
    // Every link those templates write from ids their patterns take opens.
    const gmail = (account: string | undefined, id: string) =>
      `https://mail.google.com/mail/${account === undefined ? 'u/0/' : `?authuser=${encodeURIComponent(account)}`}#all/${encodeURIComponent(id)}`;
    for (const account of [undefined, 'someone@example.com', 'first.last+tag@example.co.uk', "o'brien@example.com"]) {
      for (const id of ['1', '18c2f0a1b2c3d4e5', 'a-b_C', 'Z'.repeat(128)]) {
        expect(queueLink(gmail(account, id)), gmail(account, id)).toBe(true);
      }
    }
    for (const [team, channel, ts] of [
      ['T0123ABCD', 'C0123ABCD', undefined],
      ['E0123', 'G0123ABCD', '1792921860.000100'],
      ['T1', 'D2', '0.000000'],
      ['T'.repeat(32), 'C'.repeat(32), '1.123456'],
    ] as const) {
      const base = `https://app.slack.com/client/${team}/${channel}`;
      const url = ts === undefined ? base : `${base}/thread/${channel}-${ts}`;
      expect(queueLink(url), url).toBe(true);
    }
  });

  it('with no queue target, says how to add one; with nothing open, that nothing is waiting', SLOW, async () => {
    const none = bridgeAt('0.30.0', {
      queueCounts: { open: 0, done: 0, dismissed: 0, byRule: [] },
      queueList: { items: [], more: false },
    });
    const first = renderApp(none, { screen: 'queue' });
    expect(await within(await screen.findByRole('main')).findByText(QUEUE_COPY.noQueue)).toBeTruthy();
    expect(within(main()).getByText(QUEUE_COPY.noQueueHint)).toBeTruthy();
    expect(within(main()).queryByRole('tablist')).toBeNull();
    first.unmount();

    const quiet = bridgeAt('0.30.0', {
      queueCounts: { ...QUEUE_COUNTS, open: 0, byRule: QUEUE_COUNTS.byRule.map((rule) => ({ ...rule, open: 0 })) },
      queueList: { items: [], more: false },
    });
    renderApp(quiet, { screen: 'queue' });
    const view = await within(await screen.findByRole('main')).findByRole('region', { name: 'Open' });
    expect(await within(view).findByText(QUEUE_COPY.nothingWaiting)).toBeTruthy();
    expect(within(main()).getByRole('tab', { name: 'Open 0 waiting' })).toBeTruthy();
    // No badge when nothing is open.
    expect(screen.getByRole('navigation', { name: 'Sections' }).querySelector('[data-slot="queue-badge"]')).toBeNull();
  });

  it('filters by rule and channel, each passed on as its closed word or checked id', SLOW, async () => {
    const counts = {
      ...QUEUE_COUNTS,
      byRule: [...QUEUE_COUNTS.byRule, { ruleId: 'a rule with spaces', name: 'Not a filter', open: 0 }],
    };
    const bridge = bridgeAt('0.30.0', { queueCounts: counts });
    const view = await opened(bridge);
    await choose(QUEUE_COPY.rule, 'David on Slack');
    await waitFor(() =>
      expect(lists(bridge).at(-1)).toEqual({
        kind: 'queueList',
        state: 'open',
        rule: 'david-on-slack',
        limit: QUEUE_LIMIT,
      }),
    );
    await waitFor(async () => expect((await cards(view)).map((each) => each.dataset.item)).toEqual([OPEN[1]]));
    await choose(QUEUE_COPY.channel, 'Gmail');
    await waitFor(() =>
      expect(lists(bridge).at(-1)).toEqual({
        kind: 'queueList',
        state: 'open',
        rule: 'david-on-slack',
        channel: 'gmail',
        limit: QUEUE_LIMIT,
      }),
    );
    expect(await within(view).findByText(QUEUE_COPY.noMatch)).toBeTruthy();
    // A rule whose id the allow-list would refuse is never offered.
    fireEvent.click(within(main()).getByRole('combobox', { name: QUEUE_COPY.rule }));
    await screen.findByRole('option', { name: 'All rules' });
    expect(screen.queryByRole('option', { name: 'Not a filter' })).toBeNull();
  });

  it('says when more matched than are shown', SLOW, async () => {
    const view = await opened(bridgeAt('0.30.0', { queueList: { ...QUEUE_LISTS.open, more: true } }));
    expect(within(view).getByText(QUEUE_COPY.more)).toBeTruthy();
  });

  it('a list that cannot be read says so', SLOW, async () => {
    renderApp(bridgeAt('0.30.0', { queueList: { nothing: true } }), { screen: 'queue' });
    expect(await within(await screen.findByRole('main')).findByText(QUEUE_COPY.unreadable)).toBeTruthy();
  });

  it(
    'reads the shown list again every 30 seconds while visible, at once on focus, and not while hidden',
    SLOW,
    async () => {
      vi.useFakeTimers();
      const advance = async (ms: number) => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      };
      const bridge = bridgeAt();
      renderApp(bridge, { screen: 'queue' });
      // The installation, then the events service's version, then the counts and the list.
      for (let round = 0; round < 6; round += 1) await advance(0);
      const reads = () => lists(bridge).length;
      expect(reads()).toBe(1);
      await advance(QUEUE_POLL_MS - 1_000);
      expect(reads()).toBe(1);
      await advance(1_000);
      expect(reads()).toBe(2);
      await act(async () => window.dispatchEvent(new Event('focus')));
      await advance(0);
      expect(reads()).toBe(3);
      // Hidden to the tray: nothing more runs.
      await act(async () => bridge.emit('window-visibility', { visible: false }));
      await advance(QUEUE_POLL_MS * 3);
      expect(reads()).toBe(3);
      // Shown again: at once, then every 30 seconds.
      await act(async () => bridge.emit('window-visibility', { visible: true }));
      await advance(0);
      expect(reads()).toBe(4);
      await advance(QUEUE_POLL_MS);
      expect(reads()).toBe(5);
      // Every list read was the shown tab's, unfiltered.
      for (const call of lists(bridge)) expect(call).toEqual({ kind: 'queueList', state: 'open', limit: QUEUE_LIMIT });
    },
  );

  it('each 30-second read of the list reads the counts with it, so a tab never lags its list', SLOW, async () => {
    vi.useFakeTimers();
    const advance = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };
    // An item arrives between two reads: the list and the counts answer with it from then on.
    const [first] = QUEUE_LISTS.open.items;
    const arrived = { ...first, id: 'qi_01JBH7Z3K90000000000000009', arrivedAt: '2026-10-25T11:59:00.000Z' };
    let here = false;
    const bridge = bridgeAt('0.30.0', {
      queueList: (call: Call) => {
        const answer = queueListAnswer(call);
        return here && (call as Extract<Call, { kind: 'queueList' }>).state === 'open'
          ? { ...answer, items: [arrived, ...answer.items] }
          : answer;
      },
      queueCounts: () => ({ ...QUEUE_COUNTS, open: QUEUE_COUNTS.open + (here ? 1 : 0) }),
    });
    // The app opens on Overview, whose shared reads poll every 15 seconds from now; the Queue opens 5 seconds later, so
    // its own 30 seconds fall between theirs.
    renderApp(bridge);
    for (let round = 0; round < 6; round += 1) await advance(0);
    await advance(5_000);
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('button', { name: /^Queue/ }),
    );
    for (let round = 0; round < 6; round += 1) await advance(0);
    const openTab = () => within(main()).getByRole('tab', { name: /^Open/ });
    const cardsShown = () => main().querySelectorAll('li[data-item]').length;
    expect(cardsShown()).toBe(OPEN.length);
    expect(openTab().textContent).toContain(`${OPEN.length} waiting`);
    // Just after the shared read at 30 seconds, the item arrives; the Queue's own read is at 35.
    await advance(26_000);
    here = true;
    const counted = () => queueCalls(bridge).filter((call) => call.kind === 'queueCounts').length;
    const before = { lists: lists(bridge).length, counts: counted() };
    await advance(4_000);
    expect(lists(bridge).length).toBe(before.lists + 1);
    expect(counted()).toBe(before.counts + 1);
    // The list and its tab say the same at once, not 10 seconds apart.
    expect(cardsShown()).toBe(OPEN.length + 1);
    expect(openTab().textContent).toContain(`${OPEN.length + 1} waiting`);
  });

  it('calls nothing but the queue reads and the changes the person asked for', SLOW, async () => {
    const bridge = bridgeAt();
    await opened(bridge);
    await openTab('Done');
    for (const call of bridge.calls.filter((each) => each.command === 'cli').map((each) => each.args as Call)) {
      expect([
        'queueList',
        'queueCounts',
        'version',
        'approvalsPending',
        'updateStatus',
        'eventsStatus',
        'doctor',
      ]).toContain(call.kind);
    }
  });
});

describe('reading the queue', () => {
  it("reads the contract's list and counts, and keeps nothing it cannot read", () => {
    const read = readQueueList(QUEUE_LISTS.open);
    expect(read?.items.map((item) => item.id)).toEqual(OPEN);
    expect(read?.items.every((item) => item.actionable)).toBe(true);
    expect(read?.items[0]?.judge).toEqual({
      state: 'answered',
      id: 'jev',
      kind: 'typesafe',
      model: 'jev-1',
      question: 'Does this message ask me to do something?',
      answer: 'yes',
      confidence: 0.86,
      uncalibrated: false,
    });
    expect(readQueueList({ items: 'no' })).toBeNull();
    expect(readQueueList(null)).toBeNull();
    const odd = readQueueList({
      items: [
        { id: 'qi_01JBH7Z3K90000000000000001', state: 'open', arrivedAt: '2026-10-25T09:40:00.000Z' },
        { id: 'not an id', state: 'open', arrivedAt: '2026-10-25T09:40:00.000Z' },
        { id: 'qi_01JBH7Z3K90000000000000002', state: 'snoozed', arrivedAt: '2026-10-25T09:40:00.000Z' },
        { id: 'qi_01JBH7Z3K90000000000000003', state: 'open' },
        'nothing',
      ],
      more: 'yes',
    });
    expect(odd?.items.map((item) => [item.id, item.actionable])).toEqual([
      ['qi_01JBH7Z3K90000000000000001', true],
      ['not an id', false],
    ]);
    expect(odd?.more).toBe(false);
    expect(odd?.items[0]?.judge.state).toBe('none');
    expect(odd?.items[0]?.link).toBeNull();
    expect(readQueueCounts(QUEUE_COUNTS)).toEqual(QUEUE_COUNTS);
    expect(readQueueCounts({ open: 1, done: 0 })).toBeNull();
    expect(readQueueCounts({ open: -1, done: 0, dismissed: 0 })).toBeNull();
  });

  it('an item whose id the allow-list would refuse is shown without its actions', SLOW, async () => {
    const [first] = QUEUE_LISTS.open.items;
    const view = await opened(bridgeAt('0.30.0', { queueList: { items: [{ ...first, id: 'qi_bad' }], more: false } }));
    const only = card(view, 'qi_bad');
    expect(within(only).getByText('Can you send the March invoice?')).toBeTruthy();
    expect(within(only).queryByRole('button', { name: QUEUE_COPY.done })).toBeNull();
    expect(within(only).queryByRole('button', { name: QUEUE_COPY.dismiss })).toBeNull();
  });
});
