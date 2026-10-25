import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '../copy.ts';
import type { Bridge, Call, CliResult } from '../ipc.ts';
import { cliKinds, createFakeBridge, EXAMPLE_INSTALLATION, failed } from './fake-bridge.ts';
import populated from './fixtures/approvals-pending.populated.json';
import { renderApp } from './render.tsx';

const GMAIL = 'ap_7M2K9Q4R8T1V5W3X6Y0Z2A4B6C';
const CHANGE = 'ap_0123456789ABCDEFGHJKMNPQRS';
const SLACK = 'ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';

/** A bridge whose CLI reads all wait until `release`, then answer from the fixtures. */
function heldBridge(): { bridge: Bridge; release: () => void } {
  const answers = createFakeBridge();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bridge = createFakeBridge({
    cli: async (call: Call): Promise<CliResult> => {
      await gate;
      return answers.cli(call);
    },
  });
  return { bridge, release };
}

/** The card that shows an approval, found by the id it shows. */
async function cardOf(approvalId: string): Promise<HTMLElement> {
  const id = await screen.findByText(approvalId);
  const card = id.closest<HTMLElement>('article');
  if (card === null) throw new Error(`no card for ${approvalId}`);
  return card;
}

/** The sender-controlled strings a card shows, each in its own plain-text span, in order. */
const untrusted = (card: HTMLElement): (string | null)[] =>
  Array.from(card.querySelectorAll('span.whitespace-pre-wrap')).map((span) => span.textContent);

/** What each "From outside" block on a card holds, in order: the CLI's envelopes, with none of their tags. */
const fromOutside = (card: HTMLElement): (string | null)[] =>
  Array.from(card.querySelectorAll('[data-slot="from-outside"] span.whitespace-pre-wrap')).map(
    (span) => span.textContent,
  );

const main = (): HTMLElement => screen.getByRole('main');

/** The Waiting view, and the count its tab shows (0.29.0: Waiting and Recent are tabs, the count on Waiting's). */
function waiting(): { view: HTMLElement; count: string | null } {
  const view = within(main()).getByRole('region', { name: 'Waiting' });
  const tab = within(main()).getByRole('tab', { name: /^Waiting/ });
  return { view, count: tab.querySelector('[data-slot="tab-count"] [aria-hidden="true"]')?.textContent ?? null };
}

/** The page, once the shell is up: the installation is read before anything else shows. */
const opened = (): Promise<HTMLElement> => screen.findByRole('main');

describe('Approvals', () => {
  it('Approvals is empty, loading, error and populated from the fixtures', async () => {
    // Loading: the list has not come back yet.
    const held = heldBridge();
    const loading = renderApp(held.bridge, { screen: 'approvals' });
    await screen.findByRole('heading', { level: 1, name: 'Approvals' });
    expect(within(main()).getByRole('status', { name: COPY.loading })).toBeTruthy();
    held.release();
    loading.unmount();

    // Empty.
    const empty = renderApp(createFakeBridge({}, { approvalsPending: [] }), { screen: 'approvals' });
    expect(await within(await opened()).findByText('Nothing is waiting for you.')).toBeTruthy();
    expect(within(main()).queryAllByRole('article')).toEqual([]);
    empty.unmount();

    // An error: what went wrong, as text.
    const answers = createFakeBridge();
    const broken = renderApp(
      createFakeBridge({
        cli: async (call: Call) =>
          call.kind === 'approvalsPending'
            ? failed('APP_TIMEOUT', 'core did not answer within 30 seconds', null, -1)
            : answers.cli(call),
      }),
      { screen: 'approvals' },
    );
    const alert = await within(await opened()).findByRole('alert');
    expect(alert.textContent).toBe('core did not answer within 30 seconds');
    broken.unmount();

    // Populated: a card each, with its kind, channel and times, and every string a sender wrote as plain text.
    renderApp(createFakeBridge(), { screen: 'approvals' });
    const send = await cardOf(GMAIL);
    expect(within(main()).getAllByRole('article')).toHaveLength(3);
    expect(within(send).getByText('Send · Gmail')).toBeTruthy();
    expect(send.querySelector('time[datetime="2026-10-19T09:12:00.000Z"]')).not.toBeNull();
    expect(send.querySelector('time[datetime="2026-10-19T09:42:00.000Z"]')).not.toBeNull();
    expect(within(send).getByText('Created')).toBeTruthy();
    expect(within(send).getByText('Expires')).toBeTruthy();
    expect(within(send).getByText('To')).toBeTruthy();
    expect(within(send).getByText('Subject')).toBeTruthy();
    // Each string the CLI enveloped shows as a block from outside, its content as text, none of its tag.
    expect(untrusted(send)).toEqual(['jo@example.com', 'The figures you asked for']);
    expect(fromOutside(send)).toEqual(['jo@example.com', 'The figures you asked for']);
    expect(within(send).getAllByText(COPY.fromOutside)).toHaveLength(2);

    const change = await cardOf(CHANGE);
    expect(within(change).getByText('Change · agent-communications')).toBeTruthy();
    expect(within(change).getByText('Summary')).toBeTruthy();
    expect(fromOutside(change)).toEqual(['updates: every-14-days → never']);

    const download = await cardOf(SLACK);
    expect(within(download).getByText('Download · Slack')).toBeTruthy();
    expect(within(download).getByText('Files')).toBeTruthy();
    expect(fromOutside(download)).toEqual(['plan.pdf']);

    // Nothing in any card is markup, and no envelope's tag or boundary shows.
    expect(main().querySelector('img,a,script,iframe')).toBeNull();
    for (const hidden of ['untrusted-content', 'boundary', 'Q1w2E3r4', 'T5y6U7i8', 'O9p0A1s2']) {
      expect(main().textContent).not.toContain(hidden);
    }
  });

  it('Revoke runs approvalRevoke with that id and refreshes', async () => {
    const revoked = new Set<string>();
    const bridge = createFakeBridge(
      {},
      {
        approvalsPending: () => populated.filter((approval) => !revoked.has(approval.approvalId)),
        approvalRevoke: (call: Call) => {
          const { approvalId } = call as Extract<Call, { kind: 'approvalRevoke' }>;
          revoked.add(approvalId);
          return { approvalId, state: 'revoked' };
        },
      },
    );
    renderApp(bridge, { screen: 'approvals' });
    const card = await cardOf(GMAIL);
    expect(waiting().count).toBe('3');
    const before = bridge.calls.length;
    fireEvent.click(within(card).getByRole('button', { name: COPY.revoke }));
    await waitFor(() => expect(screen.queryByText(GMAIL)).toBeNull());
    // Revoked, then the list read again: nothing else, and nothing sent to Terminal.
    expect(bridge.calls.slice(before)).toEqual([
      { command: 'cli', args: { kind: 'approvalRevoke', approvalId: GMAIL } },
      { command: 'cli', args: { kind: 'approvalsPending' } },
    ]);
    expect(within(main()).getAllByRole('article')).toHaveLength(2);
    expect(waiting().count).toBe('2');
  });

  it('a revoke that fails says why and keeps the card', async () => {
    const answers = createFakeBridge();
    const bridge = createFakeBridge({
      cli: async (call: Call) =>
        call.kind === 'approvalRevoke'
          ? failed('NOT_FOUND', 'no approval has that id', 'It may have expired.')
          : answers.cli(call),
    });
    renderApp(bridge, { screen: 'approvals' });
    const card = await cardOf(SLACK);
    fireEvent.click(within(card).getByRole('button', { name: COPY.revoke }));
    const alert = await within(card).findByRole('alert');
    expect(alert.textContent).toContain('no approval has that id');
    expect(alert.textContent).toContain('It may have expired.');
    expect(cliKinds(bridge).filter((kind) => kind === 'approvalsPending')).toHaveLength(1);
  });

  it("Approve in Terminal opens that channel's approve", async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'approvals' });
    const send = await cardOf(GMAIL);
    fireEvent.click(within(send).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(send).findByText('Opened in Terminal.')).toBeTruthy();
    // A change core prepared is approved through core's own launcher.
    const change = await cardOf(CHANGE);
    fireEvent.click(within(change).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(change).findByText('Opened in Terminal.')).toBeTruthy();
    const slack = await cardOf(SLACK);
    fireEvent.click(within(slack).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(slack).findByText('Opened in Terminal.')).toBeTruthy();

    expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([
      { command: 'openInTerminal', args: { kind: 'approve', product: 'gmail', approvalId: GMAIL } },
      { command: 'openInTerminal', args: { kind: 'approve', product: 'core', approvalId: CHANGE } },
      { command: 'openInTerminal', args: { kind: 'approve', product: 'slack', approvalId: SLACK } },
    ]);
    // The app approved nothing and changed nothing itself: only reads went to the CLI — with the events service's own
    // version, which says whether it has the queue (0.30.0).
    for (const kind of cliKinds(bridge))
      expect(['approvalsPending', 'updateStatus', 'eventsStatus', 'doctor', 'version']).toContain(kind);
  });

  it('says so when no terminal opens and the command is copied', async () => {
    const bridge = createFakeBridge({
      openInTerminal: async () => ({ outcome: 'copied', reason: 'noTerminal', revoked: null }),
    });
    renderApp(bridge, { screen: 'approvals' });
    const send = await cardOf(GMAIL);
    fireEvent.click(within(send).getByRole('button', { name: COPY.approveInTerminal }));
    expect(await within(send).findByText(COPY.noTerminal)).toBeTruthy();
  });

  it("no Approve in Terminal when the channel's launcher is missing", async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    renderApp(bridge, { screen: 'approvals' });
    const slack = await cardOf(SLACK);
    expect(within(slack).queryByRole('button', { name: COPY.approveInTerminal })).toBeNull();
    // It can still be revoked.
    expect(within(slack).getByRole('button', { name: COPY.revoke })).toBeTruthy();
    // The channels that are here keep theirs.
    expect(within(await cardOf(GMAIL)).getByRole('button', { name: COPY.approveInTerminal })).toBeTruthy();
    expect(within(await cardOf(CHANGE)).getByRole('button', { name: COPY.approveInTerminal })).toBeTruthy();
  });

  it("an earlier release's approval, or one for a channel the app has no launcher for, is shown and never sent to Terminal", async () => {
    const legacy = {
      approvalId: 'ap_1111111111111111111111111A',
      kind: 'send',
      channel: 'gmail',
      state: 'pending',
      legacy: true,
      said: 'an earlier release’s Gmail approval: shown, and never used here',
    };
    const unknown = { approvalId: 'ap_2222222222222222222222222B', kind: 'change', channel: 'teams', state: 'pending' };
    renderApp(createFakeBridge({}, { approvalsPending: [legacy, unknown] }), { screen: 'approvals' });
    const old = await cardOf(legacy.approvalId);
    expect(within(old).getByText(legacy.said)).toBeTruthy();
    expect(within(old).queryByRole('button', { name: COPY.approveInTerminal })).toBeNull();
    expect(within(old).getByRole('button', { name: COPY.revoke })).toBeTruthy();
    const other = await cardOf(unknown.approvalId);
    expect(within(other).getByText('Change · teams')).toBeTruthy();
    expect(within(other).queryByRole('button', { name: COPY.approveInTerminal })).toBeNull();
  });

  it('Waiting comes first, with its count on its tab; Recent is read only when it is opened', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'approvals' });
    await cardOf(GMAIL);
    const tabs = within(main()).getByRole('tablist', { name: 'Approvals' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => [tab.textContent, tab.getAttribute('aria-selected')]),
    ).toEqual([
      ['Waiting 33 waiting', 'true'],
      ['Recent', 'false'],
    ]);
    const { view, count } = waiting();
    expect(count).toBe('3');
    expect(within(view).getAllByRole('article')).toHaveLength(3);
    // Until Recent is opened, only what waits is read.
    expect(new Set(cliKinds(bridge).filter((kind) => kind.startsWith('approval')))).toEqual(
      new Set(['approvalsPending']),
    );
  });

  it('nothing waiting says so beside a count of none', async () => {
    renderApp(createFakeBridge({}, { approvalsPending: [] }), { screen: 'approvals' });
    expect(await within(await opened()).findByText('Nothing is waiting for you.')).toBeTruthy();
    expect(waiting().count).toBe('0');
  });

  it("a card's buttons come after everything it shows, Revoke first and Approve in Terminal last", async () => {
    renderApp(createFakeBridge(), { screen: 'approvals' });
    const send = await cardOf(GMAIL);
    const buttons = within(send).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([COPY.revoke, COPY.approveInTerminal]);
    // What a sender wrote, and the times, are all read before either button is reached.
    const last = Array.from(send.querySelectorAll('[data-slot="from-outside"], time')).at(-1);
    expect(last).toBeTruthy();
    expect(last?.compareDocumentPosition(buttons[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The id stays as it came, in mono beside the title.
    expect(within(send).getByText(GMAIL).className).toContain('font-mono');
    // An address, and a file name, are checked letter by letter, so they are in mono; a subject is prose. (The
    // detail's own `font-mono` is the face soft sets back to sans; the screen marks a literal on what it holds.)
    const lettered = (text: HTMLElement): boolean | undefined =>
      text.closest('dd')?.firstElementChild?.classList.contains('font-mono');
    expect(lettered(within(send).getByText('jo@example.com'))).toBe(true);
    expect(lettered(within(send).getByText('The figures you asked for'))).toBe(false);
    expect(lettered(within(await cardOf(SLACK)).getByText('plan.pdf'))).toBe(true);
  });

  it('an answer in no shape the app knows is an error, not a crash', async () => {
    renderApp(createFakeBridge({}, { approvalsPending: { approvals: 'none' } }), { screen: 'approvals' });
    expect((await within(await opened()).findByRole('alert')).textContent).toBe(
      'The approvals list could not be read.',
    );
  });
});

/** Opens Recent, as a person would, and waits for what it read. */
async function openRecent(): Promise<HTMLElement> {
  fireEvent.click(await within(await opened()).findByRole('tab', { name: 'Recent' }));
  const view = await within(main()).findByRole('region', { name: 'Recent' });
  await waitFor(() => expect(within(view).queryByRole('status', { name: COPY.loading })).toBeNull());
  return view;
}

/** The rows Recent shows, by id. */
const recentRows = (view: HTMLElement): HTMLElement[] =>
  Array.from(view.querySelectorAll<HTMLElement>('[data-approval]'));

describe('Approvals → Recent (S5)', () => {
  // Only the clock is held, at noon on the fixtures' last day: the 30 days are counted back from it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists what no longer waits from the last 30 days, newest first: kind, channel, account, decision, when, id', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'approvals' });
    const view = await openRecent();
    // One list for each finished state, and no other state, read only once Recent is open.
    const asked = bridge.calls
      .filter((call) => call.command === 'cli' && (call.args as Call).kind === 'approvalsFinished')
      .map((call) => (call.args as Extract<Call, { kind: 'approvalsFinished' }>).state);
    expect(asked).toEqual(['approved', 'used', 'failed', 'unknown', 'expired', 'revoked']);
    const rows = recentRows(view);
    // The one decided in September is past the 30 days.
    expect(rows.map((row) => [row.dataset.approval, row.dataset.state])).toEqual([
      ['ap_01RECENT000000000000000004', 'approved'],
      ['ap_01RECENT000000000000000001', 'used'],
      ['ap_01RECENT000000000000000002', 'revoked'],
      ['ap_01RECENT000000000000000003', 'expired'],
      ['ap_01RECENT000000000000000005', 'failed'],
      ['ap_01RECENT000000000000000006', 'unknown'],
    ]);
    const decision = (row: HTMLElement | undefined) =>
      row?.querySelector('[data-slot="decision"]')?.textContent ?? null;
    expect(rows.map(decision)).toEqual(['Approved', 'Sent', 'Revoked', 'Expired', 'Failed', 'Outcome unknown']);
    const sent = rows[1] as HTMLElement;
    expect(within(sent).getByText('Send · Gmail')).toBeTruthy();
    expect(within(sent).getByText('ap_01RECENT000000000000000001').className).toContain('font-mono');
    expect(within(sent).getByText('in_01EXAMPLE0000000000000000').className).toContain('font-mono');
    expect(sent.querySelector('time[datetime="2026-10-25T09:24:02.000Z"]')).not.toBeNull();
    expect(within(rows[2] as HTMLElement).getByText('Change · agent-communications')).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('revoked by the user')).toBeTruthy();
    expect(rows[3]?.querySelector('time[datetime="2026-10-23T11:30:00.000Z"]')).not.toBeNull();
    expect(within(rows[4] as HTMLElement).getByText('Send · Resend')).toBeTruthy();
    expect(within(rows[4] as HTMLElement).getByText(/the domain is not verified/)).toBeTruthy();
    expect(rows[5]?.querySelector('time[datetime="2026-10-21T19:05:00.000Z"]')).not.toBeNull();
    // Read-only: no button anywhere in it, and nothing a sender wrote — no subject, no recipient — and no markup.
    expect(within(view).queryAllByRole('button')).toEqual([]);
    expect(view.textContent).not.toContain('The figures you asked for');
    expect(view.textContent).not.toContain('jo@example.com');
    expect(view.querySelector('img,script,iframe,[data-slot="from-outside"]')).toBeNull();
    // Nothing but reads went to the CLI.
    for (const kind of cliKinds(bridge)) {
      expect(['approvalsPending', 'approvalsFinished', 'updateStatus', 'eventsStatus', 'doctor', 'version']).toContain(
        kind,
      );
    }
  });

  it('nothing finished says so; a list that fails is said beside what the others found', async () => {
    const empty = renderApp(createFakeBridge({}, { approvalsFinished: [] }), { screen: 'approvals' });
    expect(await within(await openRecent()).findByText('Nothing finished in the last 30 days.')).toBeTruthy();
    empty.unmount();

    const answers = createFakeBridge();
    renderApp(
      createFakeBridge({
        cli: async (call: Call) =>
          call.kind === 'approvalsFinished' && call.state === 'expired'
            ? failed('IO', 'the approvals folder could not be read')
            : answers.cli(call),
      }),
      { screen: 'approvals' },
    );
    const view = await openRecent();
    expect((await within(view).findByRole('alert')).textContent).toBe(
      'Some finished approvals could not be read: the approvals folder could not be read',
    );
    expect(recentRows(view).map((row) => row.dataset.state)).toEqual([
      'approved',
      'used',
      'revoked',
      'failed',
      'unknown',
    ]);
  });

  it('every list failing is an error, as text', async () => {
    renderApp(createFakeBridge({}, { approvalsFinished: { approvals: 'none' } }), { screen: 'approvals' });
    const view = await openRecent();
    expect((await within(view).findByRole('alert')).textContent).toBe('The approvals list could not be read.');
  });

  it('a deep link opens Waiting again, over Recent', async () => {
    const bridge = createFakeBridge();
    renderApp(bridge, { screen: 'approvals' });
    await openRecent();
    await act(async () => bridge.emit('deep-link', { approvalId: SLACK }));
    await waitFor(() =>
      expect(
        within(main())
          .getByRole('tab', { name: /^Waiting/ })
          .getAttribute('aria-selected'),
      ).toBe('true'),
    );
    const card = await cardOf(SLACK);
    await waitFor(() => expect(card.getAttribute('aria-current')).toBe('true'));
  });
});

describe('a deep link on Approvals', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('a deep link selects its approval, and an unknown id says it is no longer waiting', async () => {
    const bridge = createFakeBridge({ takeDeepLink: async () => ({ approvalId: SLACK }) });
    renderApp(bridge);
    await screen.findByRole('heading', { level: 1, name: 'Approvals' });
    const card = await cardOf(SLACK);
    await waitFor(() => expect(card.getAttribute('aria-current')).toBe('true'));
    // Only that one is selected, it is scrolled to, and it has the focus.
    for (const other of [GMAIL, CHANGE]) expect((await cardOf(other)).getAttribute('aria-current')).toBeNull();
    expect(scrollIntoView.mock.contexts).toContain(card);
    expect(document.activeElement).toBe(card);
    expect(screen.queryByText('This approval is no longer waiting.')).toBeNull();

    // A link to an approval that is not waiting any more.
    await act(async () => bridge.emit('deep-link', { approvalId: 'ap_9999999999999999999999999Z' }));
    expect(await screen.findByText('This approval is no longer waiting.')).toBeTruthy();
    expect(
      within(main())
        .getAllByRole('article')
        .filter((each) => each.getAttribute('aria-current') !== null),
    ).toEqual([]);
  });
});
