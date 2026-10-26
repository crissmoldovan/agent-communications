/*
 * Events → Deliveries (owner feedback 0.32.0, §3.5): rows that read "rule → where it went", the owner's 1970 date
 * never shown again, and one delivery's page — the message, why it was passed on, a dry run's would-be record as
 * outside text, a webhook's host, and its tries with Try now and Stop trying. Every answer is a fixture written to the
 * spec's shapes (`deliveries list`, `delivery show`, `dryrun show`), until the event service's own output replaces them.
 */
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Call } from '../ipc.ts';
import { cliKinds, createFakeBridge, type FakeBridge, type Fixture, failed } from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.v032.json';
import deliveryShows from './fixtures/events-delivery-show.v032.json';
import dryrunShow from './fixtures/events-dryrun-show.v032.json';
import shows from './fixtures/events-rule-show.v032.json';
import rules from './fixtures/events-rules.v032.json';
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
    expect(within(message).getByText('From outside')).toBeTruthy();
    // No address is known for this account: no link to Gmail. And the message's story, inert until it has a screen.
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
    const fields = Object.fromEntries(
      [...would.querySelectorAll('[data-field]')].map((each) => [
        each.getAttribute('data-field'),
        each.querySelector('[data-slot="from-outside"]') === null ? 'plain' : 'outside',
      ]),
    );
    expect(fields).toEqual({
      specversion: 'plain',
      id: 'plain',
      source: 'outside',
      type: 'plain',
      time: 'plain',
      datacontenttype: 'plain',
      'data.from.name': 'outside',
      'data.from.address': 'outside',
      'data.subject': 'outside',
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
    // A delivery that will try again can be tried now; only a failed one can be stopped.
    expect(within(page).queryByRole('button', { name: 'Stop trying…' })).toBeNull();
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
    expect(within(page).getByRole('region', { name: 'Tries' }).textContent).toContain('gave up');
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
    // What the list knows is still said: its tries, and Try now.
    expect(within(page).getByRole('region', { name: 'Tries' }).textContent).toContain('Tried 3 of 5 times');
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

  it('an empty list says so, and a list in a shape the app does not know says it could not be read', async () => {
    const first = renderApp(deliveriesBridge({ eventsDeliveries: [] }), { screen: 'events' });
    let view = await openTab('Deliveries');
    expect(await within(view).findByText('No deliveries yet.')).toBeTruthy();
    first.unmount();
    renderApp(deliveriesBridge({ eventsDeliveries: 'not a list' }), { screen: 'events' });
    view = await openTab('Deliveries');
    expect(await within(view).findByText('The list could not be read.')).toBeTruthy();
  });
});
