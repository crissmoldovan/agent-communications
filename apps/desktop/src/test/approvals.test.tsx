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

const main = (): HTMLElement => screen.getByRole('main');

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
    expect(untrusted(send)).toEqual([populated[0]?.expect?.to[0], populated[0]?.expect?.subject]);

    const change = await cardOf(CHANGE);
    expect(within(change).getByText('Change · agent-communications')).toBeTruthy();
    expect(within(change).getByText('Summary')).toBeTruthy();
    expect(untrusted(change)).toEqual([populated[1]?.expect?.subject]);

    const download = await cardOf(SLACK);
    expect(within(download).getByText('Download · Slack')).toBeTruthy();
    expect(within(download).getByText('Files')).toBeTruthy();
    expect(untrusted(download)).toEqual(populated[2]?.files?.names);

    // Nothing in any card is markup.
    expect(main().querySelector('img,a,script,iframe')).toBeNull();
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
    const before = bridge.calls.length;
    fireEvent.click(within(card).getByRole('button', { name: COPY.revoke }));
    await waitFor(() => expect(screen.queryByText(GMAIL)).toBeNull());
    // Revoked, then the list read again: nothing else, and nothing sent to Terminal.
    expect(bridge.calls.slice(before)).toEqual([
      { command: 'cli', args: { kind: 'approvalRevoke', approvalId: GMAIL } },
      { command: 'cli', args: { kind: 'approvalsPending' } },
    ]);
    expect(within(main()).getAllByRole('article')).toHaveLength(2);
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
    // The app approved nothing and changed nothing itself: only reads went to the CLI.
    for (const kind of cliKinds(bridge))
      expect(['approvalsPending', 'updateStatus', 'eventsStatus', 'doctor']).toContain(kind);
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

  it('an answer in no shape the app knows is an error, not a crash', async () => {
    renderApp(createFakeBridge({}, { approvalsPending: { approvals: 'none' } }), { screen: 'approvals' });
    expect((await within(await opened()).findByRole('alert')).textContent).toBe(
      'The approvals list could not be read.',
    );
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
