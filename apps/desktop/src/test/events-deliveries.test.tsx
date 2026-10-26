/*
 * Events → Deliveries (owner feedback 0.32.0, §3.5): rows that read "rule → where it went", the owner's 1970 date
 * never shown again, and one delivery's page — the message, why it was passed on, a dry run's would-be record as
 * outside text, a webhook's host, and its tries with Try now and Stop trying. Every answer is a fixture written to the
 * spec's shapes (`deliveries list`, `delivery show`, `dryrun show`), until the event service's own output replaces them.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { recordFields } from '../events-deliveries.ts';
import type { Call } from '../ipc.ts';
import type { Destination } from '../navigation.tsx';
import { messageStoryOpener } from '../screens/events/DeliveryDetail.tsx';
import { STORY_COPY } from '../screens/MessageStory.tsx';
import {
  cliKinds,
  createFakeBridge,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  failed,
} from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import deliveries from './fixtures/events-deliveries.v032.json';
import deliveryShows from './fixtures/events-delivery-show.v032.json';
import dryrunShow from './fixtures/events-dryrun-show.v032.json';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';
import { renderApp } from './render.tsx';

const ID = {
  invoices: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b01',
  david: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b02',
  dry: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b03',
  retry: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b04',
  failed: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b05',
  waiting: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b06',
} as const;

type Shows = Record<string, unknown>;
const deliveryId = (call: Call) => (call as Extract<Call, { kind: 'eventsDeliveryShow' }>).deliveryId;

function deliveriesBridge(fixtures: Partial<Record<Call['kind'], Fixture>> = {}, handlers = {}): FakeBridge {
  return createFakeBridge(handlers, {
    // The events service at 0.32.0, the first whose `delivery show` exists and whose `dryrun show` answers the app.
    version: '0.32.0',
    eventsRules: rules,
    eventsRuleShow: (call: Call) =>
      (shows as Record<string, unknown[]>)[(call as Extract<Call, { kind: 'eventsRuleShow' }>).ruleId] ?? [],
    eventsDeliveries: deliveries,
    eventsDeliveryShow: (call: Call) => (deliveryShows as Shows)[deliveryId(call)],
    eventsDryrunShow: dryrunShow,
    eventsDeliveryRetry: (call: Call) => ({
      kind: 'delivery-retried',
      deliveryId: deliveryId(call),
      nextAt: 1792929100000,
    }),
    eventsDeliveryDrop: (call: Call) => ({ kind: 'delivery-dropped', deliveryId: deliveryId(call) }),
    ...fixtures,
  });
}

async function openTab(name: 'Rules' | 'Deliveries'): Promise<HTMLElement> {
  const tab = await screen.findByRole('tab', { name: new RegExp(`^${name}\\b`) });
  fireEvent.click(tab);
  await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
  return screen.findByRole('region', { name });
}

async function row(id: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(`[data-delivery="${id}"]`);
    if (found === null) throw new Error(`no row for ${id}`);
    return found;
  });
}

const rowIds = (view: HTMLElement) =>
  [...view.querySelectorAll<HTMLElement>('[data-delivery]')].map((each) => each.dataset.delivery);

const title = (element: HTMLElement) => element.querySelector('[data-slot="delivery-title"]')?.textContent;

/** The words the Events screens never use outside the collapsed technical details (§3.8). */
const RAW_WORDS = ['approval id', 'activation', 'digest', 'superseded', 'retryable', 'dead-lettered'];
const rawWordsIn = (element: HTMLElement) =>
  RAW_WORDS.filter((word) => (element.textContent ?? '').toLowerCase().includes(word));

/** No time on the page is the epoch, and no line says 1970: the owner's bug (§3.5). */
function noEpoch(element: HTMLElement) {
  for (const time of element.querySelectorAll('time')) {
    const at = time.getAttribute('datetime') ?? '';
    expect(new Date(at).getTime(), at).toBeGreaterThan(0);
  }
  expect(element.textContent).not.toContain('1970');
}

async function openDelivery(id: string): Promise<HTMLElement> {
  fireEvent.click(await row(id));
  return screen.findByRole('region', { name: 'Delivery' });
}

const cliCalls = (bridge: FakeBridge) =>
  bridge.calls.filter((each) => each.command === 'cli').map((each) => each.args as Call);

describe('Events → Deliveries', () => {
  it('each row reads "rule → where it went", with its channel, its account, its state in words and its time', async () => {
    renderApp(deliveriesBridge(), { screen: 'events' });
    const view = await openTab('Deliveries');
    expect(view.textContent).toContain('A delivery is one message a rule passed on');
    expect(view.textContent).toContain(
      'The dry-run log is a private record on this Mac of what a rule would have delivered',
    );
    expect(view.textContent).toContain('each entry is deleted after 24 hours');

    // Newest first, each one's time read from when it was made.
    await waitFor(() => expect(rowIds(view)).toEqual([ID.waiting, ID.retry, ID.invoices, ID.david, ID.dry, ID.failed]));
    const invoices = await row(ID.invoices);
    expect(title(invoices)).toBe('invoices → Queue, lane billing');
    expect(invoices.textContent).toContain('Gmail · example/gmail');
    expect(within(invoices).getByText('Delivered')).toBeTruthy();
    expect(invoices.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-25T11:40:00.000Z');

    const david = await row(ID.david);
    expect(title(david)).toBe('david-on-slack → Queue, lane david');
    expect(david.textContent).toContain('Slack · example/slack');

    const dry = await row(ID.dry);
    expect(title(dry)).toBe('mail-subject → Dry-run log');
    expect(within(dry).getByText('Recorded')).toBeTruthy();
    expect(dry.textContent).toContain('in_01EXAMPLE0000000000000099');
    expect(dry.textContent).toContain('nothing was sent');

    const retry = await row(ID.retry);
    expect(title(retry)).toBe('build-alerts → Webhook, hooks.ci.example');
    expect(within(retry).getByText('Will try again')).toBeTruthy();
    expect(retry.textContent).toContain('tried 3 times');
    expect(retry.textContent).toContain('next try');
    expect(retry.querySelector('[data-slot="next-try"] time')?.getAttribute('datetime')).toBe(
      '2026-10-25T12:10:00.000Z',
    );
    expect(retry.querySelector('[data-slot="made-at"] time')?.getAttribute('datetime')).toBe(
      '2026-10-25T11:52:00.000Z',
    );

    const gaveUp = await row(ID.failed);
    expect(within(gaveUp).getByText('Failed')).toBeTruthy();
    expect(gaveUp.textContent).toContain('gave up after 5 tries');

    const waiting = await row(ID.waiting);
    expect(within(waiting).getByText('Waiting')).toBeTruthy();
    expect(waiting.textContent).toContain('not tried yet');

    for (const id of Object.values(ID)) {
      const each = await row(id);
      expect(each.tagName, id).toBe('BUTTON');
      expect(each.querySelector('[data-slot="opens"]'), id).not.toBeNull();
    }
    expect(rawWordsIn(view)).toEqual([]);
  });

  it('never shows a date for a next try of 0 or none, and says "next try" only while it waits (the 1970 bug)', async () => {
    // A delivered row the event service left at 0, a queued one due now (0), a retryable one at 0 and one at -1, and a
    // delivered one that still carries a time: none of them is a next try.
    const odd = [
      { ...deliveries[0], deliveryId: 'dlv-delivered-zero', state: 'delivered', nextAt: 0 },
      { ...deliveries[0], deliveryId: 'dlv-queued-zero', state: 'queued', nextAt: 0, deliveredAt: null },
      { ...deliveries[3], deliveryId: 'dlv-retry-zero', state: 'retryable', nextAt: 0 },
      { ...deliveries[3], deliveryId: 'dlv-retry-negative', state: 'retryable', nextAt: -1 },
      { ...deliveries[0], deliveryId: 'dlv-delivered-later', state: 'delivered', nextAt: 1792929600000 },
      { ...deliveries[4], deliveryId: 'dlv-failed-zero', state: 'dead-lettered', nextAt: 0 },
    ];
    renderApp(deliveriesBridge({ eventsDeliveries: odd }), { screen: 'events' });
    const view = await openTab('Deliveries');
    await waitFor(() => expect(rowIds(view)).toHaveLength(odd.length));
    for (const each of odd) {
      const shown = await row(each.deliveryId);
      expect(shown.querySelector('[data-slot="next-try"]'), each.deliveryId).toBeNull();
      expect(shown.textContent, each.deliveryId).not.toContain('next try');
    }
    noEpoch(view);
    // Opened, the same: no next try, no 1970.
    const page = await openDelivery('dlv-delivered-zero');
    await waitFor(() => expect(within(page).getByRole('region', { name: 'Tries' })).toBeTruthy());
    expect(within(page).getByRole('region', { name: 'Tries' }).textContent).not.toContain('Next try');
    noEpoch(page);
  });

  it('filters by All, Will try again, Failed and Done, each with its count', async () => {
    renderApp(deliveriesBridge(), { screen: 'events' });
    const view = await openTab('Deliveries');
    const show = within(view).getByRole('group', { name: 'Show' });
    expect(
      within(show)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['All 6', 'Will try again 2', 'Failed 1', 'Done 3']);
    fireEvent.click(within(show).getByRole('button', { name: 'Will try again 2' }));
    await waitFor(() => expect(rowIds(view).sort()).toEqual([ID.retry, ID.waiting].sort()));
    fireEvent.click(within(show).getByRole('button', { name: 'Failed 1' }));
    await waitFor(() => expect(rowIds(view)).toEqual([ID.failed]));
    fireEvent.click(within(show).getByRole('button', { name: 'Done 3' }));
    await waitFor(() => expect(rowIds(view).sort()).toEqual([ID.invoices, ID.david, ID.dry].sort()));
  });

  it("a dry run's page: the message, why it was passed on, and the would-be record, every sender field outside text", async () => {
    const bridge = deliveriesBridge();
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.dry);
    expect(within(page).getByRole('heading', { name: 'mail-subject → Dry-run log' })).toBeTruthy();
    expect(await within(page).findByText('Recorded · nothing sent')).toBeTruthy();
    await waitFor(() =>
      expect(cliCalls(bridge)).toEqual(
        expect.arrayContaining([
          { kind: 'eventsDeliveryShow', deliveryId: ID.dry },
          { kind: 'eventsDryrunShow', deliveryId: ID.dry },
        ]),
      ),
    );

    const message = await within(page).findByRole('region', { name: 'The message' });
    expect(message.textContent).toContain('Gmail · in_01EXAMPLE0000000000000099');
    await waitFor(() => expect(message.textContent).toContain('Jo Example <jo@example.com>'));
    const boxed = [...message.querySelectorAll('[data-slot="from-outside"]')].map((each) => each.textContent);
    expect(boxed).toEqual(['From outside: Jo Example <jo@example.com>', 'From outside: test: does the rule fire?']);
    // Every field the sender controls comes enveloped, an address too (review of 0.32.0, finding 2): the page shows the
    // envelope's content, boxed, never its tags.
    expect(page.textContent).not.toContain('untrusted-content');
    expect(within(message).getByText('From outside')).toBeTruthy();
    // No address is known for this account: no link to Gmail. And the message's story is inert: `evt-03` is no event id
    // the event service makes, so there is no story to open (one with a real id opens it: below).
    expect(within(message).queryByRole('button', { name: 'Open in Gmail' })).toBeNull();
    const story = within(message).getByText('See everything that happened to this message');
    expect(story.closest('button')).toBeNull();

    const why = within(page).getByRole('region', { name: 'Why it was passed on' });
    expect(why.textContent).toBe(
      'Why it was passed onRule mail-subject, version 1: the subject contains testNo judge on this rule.',
    );
    expect([...why.querySelectorAll('[data-part="untrusted"]')].map((each) => each.textContent)).toEqual(['test']);

    const would = await within(page).findByRole('region', { name: 'What it would have delivered' });
    await waitFor(() => expect(would.textContent).toContain('data.subject'));
    // Who wrote each field: the CloudEvent's own attributes are the event service's, shown plain; the fields its
    // `agentcommsuntrusted` names are the sender's; the rest of `data` is unlisted, and boxed all the same.
    const fields = Object.fromEntries(
      [...would.querySelectorAll('[data-field]')].map((each) => [
        each.getAttribute('data-field'),
        `${each.getAttribute('data-source')} ${each.querySelector('[data-slot="from-outside"]') === null ? 'plain' : 'boxed'}`,
      ]),
    );
    expect(would.querySelector('[data-field="data.from.address"] [data-slot="from-outside"]')?.textContent).toBe(
      'From outside: jo@example.com',
    );
    expect(fields).toEqual({
      agentcommsrule: 'attribute plain',
      agentcommsuntrusted: 'attribute plain',
      'data.from.address': 'unlisted boxed',
      'data.from.name': 'sender boxed',
      'data.messageId': 'unlisted boxed',
      'data.subject': 'sender boxed',
      datacontenttype: 'attribute plain',
      dataschema: 'attribute plain',
      id: 'attribute plain',
      source: 'attribute plain',
      specversion: 'attribute plain',
      subject: 'attribute plain',
      time: 'attribute plain',
      type: 'attribute plain',
    });
    expect(would.textContent).toContain('Text the sender wrote is shown as plain text');

    const tries = within(page).getByRole('region', { name: 'Tries' });
    expect(tries.textContent).toContain('Written to the dry-run log on this Mac');
    expect(tries.textContent).toContain('deletes it');
    expect(within(page).queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(rawWordsIn(page)).toEqual([]);
    noEpoch(page);

    fireEvent.click(within(page).getByRole('button', { name: 'All deliveries' }));
    expect(await row(ID.dry)).toBeTruthy();
  });

  it("a webhook's page: where it sends, its tries, and Try now, which tries it again and reads it again", async () => {
    const bridge = deliveriesBridge();
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.retry);
    expect(within(page).getByRole('heading', { name: 'build-alerts → Webhook, hooks.ci.example' })).toBeTruthy();
    expect(await within(page).findByText(/^Will try again at/)).toBeTruthy();
    const sends = await within(page).findByRole('region', { name: 'Where it sends' });
    expect(sends.textContent).toContain('To hooks.ci.example');
    expect(sends.textContent).not.toContain('/agentcomms');

    const tries = within(page).getByRole('region', { name: 'Tries' });
    expect(tries.textContent).toContain('Tried 3 of 5 times');
    expect(tries.textContent).toContain('Its last try: the webhook answered 503, it is unavailable.');
    expect(tries.querySelector('[data-slot="next-try"] time')?.getAttribute('datetime')).toBe(
      '2026-10-25T12:10:00.000Z',
    );
    expect(tries.textContent).toContain('Earlier tries are counted, not kept one by one.');
    // A delivery that will try again can be tried now, or stopped (0.32.0).
    expect(within(page).getByRole('button', { name: 'Stop trying…' })).toBeTruthy();
    // Its message: Open in Gmail, in the mailbox's own shape.
    const message = within(page).getByRole('region', { name: 'The message' });
    fireEvent.click(await within(message).findByRole('button', { name: 'Open in Gmail' }));
    await waitFor(() =>
      expect(bridge.calls.filter((each) => each.command === 'openLink').map((each) => each.args)).toEqual([
        'https://mail.google.com/mail/?authuser=jo%40example.com#all/18c0ffee00example4',
      ]),
    );

    const reads = () => cliCalls(bridge).filter((each) => each.kind === 'eventsDeliveryShow').length;
    const lists = () => cliKinds(bridge).filter((kind) => kind === 'eventsDeliveries').length;
    const [readsBefore, listsBefore] = [reads(), lists()];
    fireEvent.click(within(page).getByRole('button', { name: 'Try now' }));
    await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'eventsDeliveryRetry', deliveryId: ID.retry }));
    await waitFor(() => expect(reads()).toBe(readsBefore + 1));
    await waitFor(() => expect(lists()).toBe(listsBefore + 1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    noEpoch(page);
  });

  it('a failed delivery: Stop trying… asks first; Cancel runs nothing, and Stop trying drops it', async () => {
    const bridge = deliveriesBridge();
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.failed);
    expect(await within(page).findByText('Failed')).toBeTruthy();
    const tries = within(page).getByRole('region', { name: 'Tries' });
    expect(tries.textContent).toContain('It gave up after 5 tries, at');
    expect(tries.querySelector('time[datetime="2026-10-25T09:00:00.000Z"]')).not.toBeNull();
    expect(within(page).queryByRole('button', { name: 'Try now' })).toBeNull();
    const drops = () => cliCalls(bridge).filter((each) => each.kind === 'eventsDeliveryDrop');
    fireEvent.click(await within(page).findByRole('button', { name: 'Stop trying…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Stop trying this delivery?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(drops()).toEqual([]);
    fireEvent.click(within(page).getByRole('button', { name: 'Stop trying…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop trying' }));
    await waitFor(() => expect(drops()).toEqual([{ kind: 'eventsDeliveryDrop', deliveryId: ID.failed }]));
  });

  it('Stop trying… on a delivery that will try again, or waits to be tried: asked first, then it is dropped', async () => {
    const bridge = deliveriesBridge();
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const drops = () => cliCalls(bridge).filter((each) => each.kind === 'eventsDeliveryDrop');
    let page = await openDelivery(ID.retry);
    fireEvent.click(await within(page).findByRole('button', { name: 'Stop trying…' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Stop trying this delivery?')).toBeTruthy();
    expect(dialog.textContent).toContain('It is not tried again.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(drops()).toEqual([]);
    fireEvent.click(within(page).getByRole('button', { name: 'Stop trying…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop trying' }));
    await waitFor(() => expect(drops()).toEqual([{ kind: 'eventsDeliveryDrop', deliveryId: ID.retry }]));
    fireEvent.click(within(page).getByRole('button', { name: 'All deliveries' }));

    // One not tried yet: Stop trying…, and no Try now.
    page = await openDelivery(ID.waiting);
    expect(within(page).queryByRole('button', { name: 'Try now' })).toBeNull();
    fireEvent.click(await within(page).findByRole('button', { name: 'Stop trying…' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop trying' }));
    await waitFor(() => expect(drops()).toContainEqual({ kind: 'eventsDeliveryDrop', deliveryId: ID.waiting }));
  });

  it('a match waiting for a busy session (0.33.0): "Waiting for a session", since when, and Drop… asked first', async () => {
    // As the session target writes it (`session-dispatcher.ts`, #busy): retryable, due only at its own expiry, its last
    // answer the relay's 409; and its busy-queue item as `session-queue list` gives it (SESSION-O3).
    const busy = '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b07';
    const busyRow = {
      ...(deliveries as Array<Record<string, unknown>>)[3],
      deliveryId: busy,
      ruleId: 'acme',
      targetId: 'acme-session',
      attempts: 1,
      nextAt: 1793101920000,
      expiresAt: 1793101920000,
      targetKind: 'session',
      lastErrorCode: 'SESSION_BUSY',
      lastStatus: 409,
      decisionId: 'dec-07',
      eventId: 'evt-07',
    };
    const busyShow = {
      ...(deliveryShows as Record<string, Record<string, unknown>>)[ID.retry],
      delivery: busyRow,
      target: { kind: 'session', id: 'acme-session', version: 1, host: null },
    };
    const item = {
      deliveryId: busy,
      relaySessionId: 'sess_example_0001',
      ruleId: 'acme',
      ruleVersion: 1,
      targetId: 'acme-session',
      targetVersion: 1,
      lane: null,
      queuedAt: '2026-10-25T12:00:00.000Z',
      released: false,
      expiresAt: '2026-10-27T11:12:00.000Z',
    };
    let dropped = false;
    const bridge = deliveriesBridge({
      version: '0.33.0',
      eventsDeliveries: () => [
        dropped ? { ...busyRow, state: 'cancelled', nextAt: null, lastErrorCode: 'DROPPED_BY_PERSON' } : busyRow,
        ...(deliveries as unknown[]),
      ],
      eventsDeliveryShow: (call: Call) =>
        deliveryId(call) === busy
          ? dropped
            ? {
                ...busyShow,
                delivery: { ...busyRow, state: 'cancelled', nextAt: null, lastErrorCode: 'DROPPED_BY_PERSON' },
              }
            : busyShow
          : (deliveryShows as Shows)[deliveryId(call)],
      sessionQueueList: () => ({ items: dropped ? [] : [item] }),
      sessionQueueDrop: (call: Call) => {
        dropped = true;
        return { deliveryId: (call as Extract<Call, { kind: 'sessionQueueDrop' }>).deliveryId, dropped: true };
      },
    });
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const line = await row(busy);
    expect(title(line)).toBe('acme → Agent session');
    expect(within(line).getByText('Waiting for a session')).toBeTruthy();
    expect(line.textContent).toContain("passed on when the session's run ends");
    // Due only at its expiry: no next try is shown for it.
    expect(line.querySelector('[data-slot="next-try"]')).toBeNull();

    const page = await openDelivery(busy);
    expect(await within(page).findByText('Waiting for a session')).toBeTruthy();
    const tries = within(page).getByRole('region', { name: 'Tries' });
    expect(tries.textContent).toContain('Its last try: the session was busy.');
    await waitFor(() => expect(tries.textContent).toContain("Waiting for the session's run to end since"));
    expect(tries.querySelector('[data-slot="waiting"] time')?.getAttribute('datetime')).toBe(
      '2026-10-25T12:00:00.000Z',
    );
    expect(tries.textContent).toContain('It waits at most until');
    expect(tries.querySelector('[data-slot="next-try"]')).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Stop trying…' })).toBeNull();
    expect(rawWordsIn(page)).toEqual([]);
    noEpoch(page);

    const drops = () => cliCalls(bridge).filter((each) => each.kind === 'sessionQueueDrop');
    fireEvent.click(await within(page).findByRole('button', { name: 'Drop…' }));
    let dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Drop this waiting match?')).toBeTruthy();
    expect(dialog.textContent).toContain('it is never passed on');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(drops()).toEqual([]);
    fireEvent.click(within(page).getByRole('button', { name: 'Drop…' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Drop it' }));
    await waitFor(() => expect(drops()).toEqual([{ kind: 'sessionQueueDrop', deliveryId: busy }]));
    expect(cliCalls(bridge).filter((each) => each.kind === 'eventsDeliveryDrop')).toEqual([]);
    // Read again: cancelled, its last answer that it was dropped, and nothing more to do.
    expect(await within(page).findByText('Cancelled')).toBeTruthy();
    await waitFor(() =>
      expect(within(page).getByRole('region', { name: 'Tries' }).textContent).toContain(
        'Its last try: the session was busy, and it was dropped while it waited.',
      ),
    );
    expect(within(page).queryByRole('button', { name: 'Drop…' })).toBeNull();
  }, 15_000);

  it('a busy match on an events service before 0.33.0 offers no Drop…, and does not read the busy queue', async () => {
    const busyRow = {
      ...(deliveries as Array<Record<string, unknown>>)[3],
      targetKind: 'session',
      lastErrorCode: 'SESSION_BUSY',
      lastStatus: 409,
    };
    const bridge = deliveriesBridge({
      eventsDeliveries: [busyRow],
      eventsDeliveryShow: {
        ...(deliveryShows as Record<string, Record<string, unknown>>)[ID.retry],
        delivery: busyRow,
        target: { kind: 'session', id: 'ci-hook', version: 1, host: null },
      },
    });
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.retry);
    expect(await within(page).findByText('Waiting for a session')).toBeTruthy();
    expect(within(page).queryByRole('button', { name: 'Drop…' })).toBeNull();
    expect(within(page).queryByRole('button', { name: 'Try now' })).toBeNull();
    expect(cliKinds(bridge)).not.toContain('sessionQueueList');
  });

  it('a delivery being sent right now cannot be stopped: the page says so plainly, and reads it again', async () => {
    const inner = deliveriesBridge();
    const bridge = deliveriesBridge(
      {},
      {
        cli: (call: Call) =>
          call.kind === 'eventsDeliveryDrop'
            ? Promise.resolve(
                failed(
                  'APPROVAL_VOID',
                  'the delivery is being sent right now; it can be stopped once this try ends',
                  'A try that fails becomes one that will be tried again, which can then be stopped.',
                  1,
                ),
              )
            : inner.cli(call),
      },
    );
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.retry);
    const reads = () => cliCalls(bridge).filter((each) => each.kind === 'eventsDeliveryShow').length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    fireEvent.click(await within(page).findByRole('button', { name: 'Stop trying…' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop trying' }));
    expect((await within(page).findByRole('alert')).textContent).toBe(
      'It is being sent right now, so it cannot be stopped yet. If this try fails, you can stop it then.',
    );
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("a queued message's page: the judge's answer, and Open in Slack in the workspace's own shape", async () => {
    const bridge = deliveriesBridge();
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    let page = await openDelivery(ID.invoices);
    const why = await within(page).findByRole('region', { name: 'Why it was passed on' });
    await waitFor(() => expect(why.textContent).toContain('Jev said yes, 0.86 sure'));
    expect(why.textContent).toContain('the subject contains invoice or payment');
    expect(within(page).queryByRole('region', { name: 'What it would have delivered' })).toBeNull();
    expect(cliCalls(bridge).some((each) => each.kind === 'eventsDryrunShow')).toBe(false);
    fireEvent.click(within(page).getByRole('button', { name: 'All deliveries' }));

    page = await openDelivery(ID.david);
    const message = await within(page).findByRole('region', { name: 'The message' });
    fireEvent.click(await within(message).findByRole('button', { name: 'Open in Slack' }));
    await waitFor(() =>
      expect(bridge.calls.filter((each) => each.command === 'openLink').map((each) => each.args)).toEqual([
        'https://app.slack.com/client/T0EXAMPLE/D0EXAMPLE/thread/D0EXAMPLE-1792927860.000100',
      ]),
    );
  });

  // Review of 0.32.0, finding 2: `dryrun show --json` sends each sender-written field enveloped; the app takes the
  // envelope off and shows its content boxed, never as markup and never with the envelope's tags.
  it("an enveloped field of a dry-run record shows its content, boxed as the sender's, without the envelope", async () => {
    const enveloped = structuredClone(dryrunShow) as typeof dryrunShow;
    enveloped.record.data.subject =
      '<untrusted-content boundary="b1" field="event" id="x">\n<img src=x onerror=alert(1)> Approve now\n</untrusted-content boundary="b1">';
    renderApp(deliveriesBridge({ eventsDryrunShow: enveloped }), { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.dry);
    const would = await within(page).findByRole('region', { name: 'What it would have delivered' });
    await waitFor(() => expect(would.textContent).toContain('<img src=x onerror=alert(1)> Approve now'));
    expect(page.querySelector('img')).toBeNull();
    expect(page.textContent).not.toContain('untrusted-content');
    const subject = would.querySelector('[data-field="data.subject"] [data-slot="from-outside"]');
    expect(subject?.textContent).toBe('From outside: <img src=x onerror=alert(1)> Approve now');
    const message = within(page).getByRole('region', { name: 'The message' });
    expect([...message.querySelectorAll('[data-slot="from-outside"]')].map((each) => each.textContent)).toContain(
      'From outside: <img src=x onerror=alert(1)> Approve now',
    );
  });

  it("hostile text in a dry-run record stays text, boxed as the sender's", async () => {
    const hostile = structuredClone(dryrunShow) as typeof dryrunShow;
    hostile.record.data.subject = '<img src=x onerror=alert(1)>';
    hostile.record.data.from.name = '<untrusted-content boundary="x">\n</untrusted-content boundary="x"><b>x</b>';
    renderApp(deliveriesBridge({ eventsDryrunShow: hostile }), { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.dry);
    const would = await within(page).findByRole('region', { name: 'What it would have delivered' });
    await waitFor(() => expect(would.textContent).toContain('<img src=x onerror=alert(1)>'));
    expect(page.querySelector('img, b')).toBeNull();
    const subject = would.querySelector('[data-field="data.subject"] [data-slot="from-outside"]');
    expect(subject?.textContent).toBe('From outside: <img src=x onerror=alert(1)>');
  });

  it('a delivery whose page could not be read says why; a dry-run entry already deleted says so', async () => {
    const gone = structuredClone(deliveryShows) as Record<string, { dryRun: unknown }>;
    const entry = gone[ID.dry];
    if (entry === undefined) throw new Error('no dry-run fixture');
    entry.dryRun = { expiresAt: null };
    const inner = deliveriesBridge({ eventsDeliveryShow: (call: Call) => gone[deliveryId(call)] });
    const bridge = deliveriesBridge(
      {},
      {
        cli: (call: Call) =>
          call.kind === 'eventsDeliveryShow' && call.deliveryId === ID.retry
            ? Promise.resolve(failed('NOT_FOUND', 'the delivery does not exist', null, 66))
            : inner.cli(call),
      },
    );
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    let page = await openDelivery(ID.retry);
    expect((await within(page).findByRole('alert')).textContent).toBe('the delivery does not exist');
    fireEvent.click(within(page).getByRole('button', { name: 'All deliveries' }));
    page = await openDelivery(ID.dry);
    const would = await within(page).findByRole('region', { name: 'What it would have delivered' });
    expect(would.textContent).toContain('no longer has this entry');
    expect(cliCalls(bridge).some((each) => each.kind === 'eventsDryrunShow')).toBe(false);
  });

  it('an events service older than 0.32.0 lists its deliveries, and their pages ask for an update', async () => {
    const older = deliveries.map(
      ({ targetKind: _k, lastErrorCode: _e, lastStatus: _s, decisionId: _d, eventId: _v, deliveredAt: _a, ...rest }) =>
        rest,
    );
    const bridge = deliveriesBridge({ version: '0.31.0', eventsDeliveries: older });
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    // The rule's document still says where each went.
    await waitFor(async () => expect(title(await row(ID.invoices))).toBe('invoices → Queue, lane billing'));
    expect(title(await row(ID.dry))).toBe('mail-subject → Dry-run log');
    const page = await openDelivery(ID.retry);
    expect(await within(page).findByText('Update agent-communications to use this')).toBeTruthy();
    expect(page.textContent).toContain('Needs 0.32.0 or later; this machine has 0.31.0.');
    expect(
      cliCalls(bridge).some((each) => each.kind === 'eventsDeliveryShow' || each.kind === 'eventsDryrunShow'),
    ).toBe(false);
    // What the list knows is still said: its tries, and Try now. Stopping one that will try again is 0.32.0's.
    expect(within(page).getByRole('region', { name: 'Tries' }).textContent).toContain('Tried 3 of 5 times');
    expect(within(page).getByRole('button', { name: 'Try now' })).toBeTruthy();
    expect(within(page).queryByRole('button', { name: 'Stop trying…' })).toBeNull();
  });

  it("a rule's See its deliveries opens the Deliveries tab narrowed to that rule, and Show all widens it", async () => {
    renderApp(deliveriesBridge(), { screen: 'events' });
    await openTab('Rules');
    fireEvent.click(
      await waitFor(() => {
        const found = document.querySelector<HTMLElement>('[data-rule="build-alerts"]');
        if (found === null) throw new Error('no card');
        return found;
      }),
    );
    const rulePage = await screen.findByRole('region', { name: 'Rule build-alerts' });
    fireEvent.click(await within(rulePage).findByRole('button', { name: 'See its deliveries' }));
    const view = await screen.findByRole('region', { name: 'Deliveries' });
    expect((await screen.findByRole('tab', { name: /^Deliveries\b/ })).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(rowIds(view).sort()).toEqual([ID.retry, ID.failed].sort()));
    expect(view.textContent).toContain("Only build-alerts's deliveries");
    fireEvent.click(within(view).getByRole('button', { name: 'Show all' }));
    await waitFor(() => expect(rowIds(view)).toHaveLength(6));
  });

  it("a rule the app cannot name is shown as text on a delivery's page, never as a link to open", async () => {
    const odd = [{ ...deliveries[1], deliveryId: 'dlv-odd', ruleId: 'rule with spaces' }];
    renderApp(deliveriesBridge({ eventsDeliveries: odd }), { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery('dlv-odd');
    const why = within(page).getByRole('region', { name: 'Why it was passed on' });
    expect(why.textContent).toContain('Rule rule with spaces');
    expect(within(why).queryByRole('button')).toBeNull();
  });

  it("a record's agentcommsuntrusted names its sender's fields by percent-encoded pointers; '' names all of data", () => {
    const sources = (record: unknown) =>
      Object.fromEntries(recordFields(record).map((field) => [field.name, field.source]));
    const data = { to: [{ name: 'Jo', address: 'jo@example.com' }], 'a/b': 'slashed', note: 'kept' };
    expect(sources({ id: 'x', agentcommsuntrusted: '%2Fa~1b,%2Fto%2F0%2Fname', data })).toEqual({
      id: 'attribute',
      agentcommsuntrusted: 'attribute',
      'data.to[0].name': 'sender',
      'data.to[0].address': 'unlisted',
      'data.a/b': 'sender',
      'data.note': 'unlisted',
    });
    expect(sources({ agentcommsuntrusted: '', data: 'all of it' })).toEqual({
      agentcommsuntrusted: 'attribute',
      data: 'sender',
    });
    // No list, or one that cannot be read, names nothing: every field of data is still boxed, as unlisted.
    expect(sources({ data: { subject: 's' } })).toEqual({ 'data.subject': 'unlisted' });
    expect(sources({ agentcommsuntrusted: '%E0%A4%A', data: { subject: 's' } })).toEqual({
      agentcommsuntrusted: 'attribute',
      'data.subject': 'unlisted',
    });
    // The bytes of an older answer are read as the event they hold.
    expect(
      sources({ cloudEventBytes: JSON.stringify({ agentcommsuntrusted: '%2Fsubject', data: { subject: 's' } }) }),
    ).toEqual({ agentcommsuntrusted: 'attribute', 'data.subject': 'sender' });
  });

  it('an empty list says so, and a list in a shape the app does not know says it could not be read', async () => {
    const first = renderApp(deliveriesBridge({ eventsDeliveries: [] }), { screen: 'events' });
    let view = await openTab('Deliveries');
    expect(await within(view).findByText('No deliveries yet.')).toBeTruthy();
    first.unmount();
    renderApp(deliveriesBridge({ eventsDeliveries: 'not a list' }), { screen: 'events' });
    view = await openTab('Deliveries');
    expect(await within(view).findByText('The list could not be read.')).toBeTruthy();
  });

  it("a delivery's page opens its message's story on the Messages screen: See everything that happened to this message", async () => {
    // The dry run's page, its event the one whose story the Messages fixtures tell.
    const eventId = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
    const shown = (deliveryShows as Record<string, { delivery: object; event: object }>)[ID.dry];
    if (shown === undefined) throw new Error('the dry run has its page');
    const bridge = deliveriesBridge(
      {
        eventsDeliveryShow: (call: Call) =>
          deliveryId(call) === ID.dry
            ? {
                ...shown,
                delivery: { ...shown.delivery, eventId },
                event: { ...shown.event, eventId },
              }
            : (deliveryShows as Shows)[deliveryId(call)],
        eventsMessagesList: messagesList,
        eventsMessageShow: messageShow,
        activityItems,
        approvalsFinished: [],
      },
      { installation: async () => ({ ...EXAMPLE_INSTALLATION, version: '0.32.0' }) },
    );
    renderApp(bridge, { screen: 'events' });
    await openTab('Deliveries');
    const page = await openDelivery(ID.dry);
    const message = await within(page).findByRole('region', { name: 'The message' });
    fireEvent.click(
      await within(message).findByRole('button', { name: 'See everything that happened to this message' }),
    );
    // Messages opens at that message's story.
    const heading = await screen.findByRole('heading', { level: 1, name: /^A message from/ });
    expect(heading.textContent).toBe('A message from From outside: David Example');
    const navigation = screen.getByRole('navigation', { name: 'Sections' });
    expect(
      within(navigation)
        .getByRole('button', { name: /^Messages/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('region', { name: STORY_COPY.happened })).toBeTruthy();
    await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'eventsMessageShow', eventId }));
  });

  it('the story opener is navigation to Messages at an event id, and nothing for an id that is none', () => {
    const asked: Destination[] = [];
    const navigate = (to: Destination) => asked.push(to);
    messageStoryOpener('e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', navigate)?.();
    expect(asked).toEqual([{ screen: 'messages', eventId: 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1' }]);
    expect(messageStoryOpener(null, navigate)).toBeNull();
    expect(messageStoryOpener('evt-03', navigate)).toBeNull();
    expect(messageStoryOpener('E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1', navigate)).toBeNull();
    // Shown without the shell, there is nowhere to go.
    expect(messageStoryOpener('e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', null)).toBeNull();
  });
});
