import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { readSessions } from '../activity.ts';
import { COPY } from '../copy.ts';
import type { Call, TerminalCommand } from '../ipc.ts';
import {
  filterLanes,
  itemLane,
  type LaneView,
  narrowingRule,
  pickerWindows,
  readLaneList,
  readUnbound,
  shownFolder,
} from '../lanes.ts';
import { readQueueList } from '../queue.ts';
import { QUEUE_LIMIT } from '../screens/Queue.tsx';
import { LANES_COPY, pickerAfterLine, unbindTitle } from '../screens/QueueLanes.tsx';
import {
  createFakeBridge,
  type FakeBridge,
  type Fixture,
  failed,
  fakeLanes,
  fakeQueue,
  LANE_LIST,
  LANES_INSTALLATION,
  QUEUE_LISTS,
  RECENT_SESSIONS,
} from './fake-bridge.ts';
import { renderApp } from './render.tsx';

/** A screen that reads under a loaded machine: each test is given room. */
const SLOW = { timeout: 30_000 };

const main = (): HTMLElement => screen.getByRole('main');

/** The open fixture's items, by the rule each matched. */
const OPEN_BY_RULE = Object.fromEntries(QUEUE_LISTS.open.items.map((item) => [item.rule.id, item.id]));

/** The open item David's rule sent to his lane. */
const DAVID_ITEM = QUEUE_LISTS.open.items.find(
  (item) => item.rule.id === 'david-on-slack',
) as (typeof QUEUE_LISTS.open.items)[number];

/** Another item of David's rule, which it also sent to a plain queue: the event service says it is in no lane. */
const PLAIN_DAVID = 'qi_01JBH7Z3K9000000000000000P';

/** The open items as an events service older than 0.31.0 lists them: with no `lane` at all. */
const OLDER_OPEN = QUEUE_LISTS.open.items.map(({ lane: _lane, ...rest }) => rest);

/**
 * A bridge with core and the events service at `events` (0.31.0 by default, the first with lanes), answering from the
 * queue's and the lanes' fixtures over `fixtures`, with any command replaced by `handlers`.
 */
function bridgeAt(
  events = '0.31.0',
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
  handlers: Parameters<typeof createFakeBridge>[0] = {},
): FakeBridge {
  return createFakeBridge(
    { installation: async () => LANES_INSTALLATION, ...handlers },
    {
      ...fakeQueue(),
      ...fakeLanes(),
      activitySessions: RECENT_SESSIONS,
      version: (call: Call) =>
        (call as Extract<Call, { kind: 'version' }>).product === 'events-daemon' ? events : '0.31.0',
      ...fixtures,
    },
  );
}

/** Every `cli` call made, in order. */
const cliCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls.filter((call) => call.command === 'cli').map((call) => call.args as Call);

const laneCalls = (bridge: FakeBridge): Call[] => cliCalls(bridge).filter((call) => call.kind.startsWith('lane'));

const terminals = (bridge: FakeBridge): TerminalCommand[] =>
  bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args as TerminalCommand);

/** The Queue screen, its Open view's cards there. */
async function openQueue(bridge: FakeBridge): Promise<HTMLElement> {
  renderApp(bridge, { screen: 'queue' });
  await screen.findByRole('heading', { level: 1, name: 'Queue' });
  const view = await within(main()).findByRole('region', { name: 'Open' });
  await waitFor(() => expect(view.querySelector('li[data-item]')).not.toBeNull());
  return view;
}

/** The Lanes view, once it has stopped loading. */
async function openLanes(bridge: FakeBridge): Promise<HTMLElement> {
  await openQueue(bridge);
  fireEvent.click(await within(main()).findByRole('tab', { name: /^Lanes\b/ }));
  const view = await within(main()).findByRole('region', { name: LANES_COPY.tab });
  await waitFor(() => expect(within(view).queryByRole('status', { name: COPY.loading })).toBeNull());
  return view;
}

/** A lane's row, once it is there. */
async function laneRow(view: HTMLElement, name: string): Promise<HTMLElement> {
  await waitFor(() => expect(view.querySelector(`[data-lane="${name}"]`)).not.toBeNull());
  return view.querySelector(`[data-lane="${name}"]`) as HTMLElement;
}

/** Chooses `option` in the filter named `name`, as a pointer does, after `look` sees every option it offers. */
async function choose(name: string, option: string, look?: (options: (string | null)[]) => void): Promise<void> {
  fireEvent.click(await within(main()).findByRole('combobox', { name }));
  const item = await screen.findByRole('option', { name: option });
  look?.((await screen.findAllByRole('option')).map((each) => each.textContent));
  fireEvent.pointerMove(item);
  fireEvent.mouseMove(item);
  fireEvent.click(item);
  await waitFor(() => expect(within(main()).getByRole('combobox', { name }).textContent).toContain(option));
}

/** The ids of the cards a view shows, once they have settled. */
function shown(view: HTMLElement): string[] {
  return Array.from(view.querySelectorAll<HTMLElement>('li[data-item]')).map((each) => each.dataset.item ?? '');
}

const lanes = (): LaneView[] => readLaneList(LANE_LIST, '/example/home') ?? [];

describe('Lanes: what the app reads', () => {
  it("reads `lane list` to the contract: names, rules, channels, open counts and each binding's window", () => {
    const read = readLaneList(LANE_LIST, '/example/home');
    expect(read).toEqual([
      {
        name: 'david',
        actionable: true,
        rules: ['david-on-slack'],
        channels: ['slack'],
        open: 1,
        binding: {
          window: {
            sessionId: '0f8b5c3e-2d41-4a7e-9c11-5b2e8d7f6a90',
            activityKey: '3f9a1c2e7b4d5a60',
            folder: '~/work/acme-site',
            client: { name: 'claude-code', version: '2.1.0' },
          },
          since: '2026-10-25T09:12:03.000Z',
        },
      },
      {
        name: 'billing',
        actionable: true,
        rules: ['invoices', 'receipts'],
        channels: ['gmail', 'resend'],
        open: 2,
        binding: null,
      },
    ]);
    // Not that answer at all.
    expect(readLaneList(null)).toBeNull();
    expect(readLaneList({ items: [] })).toBeNull();
    expect(readLaneList([])).toBeNull();
    // A lane with no name is left out; one outside the grammar is shown, and named in no call.
    expect(readLaneList({ lanes: [{ open: 1 }, { name: 'Has Spaces', rules: [], channels: [], open: 0 }] })).toEqual([
      { name: 'Has Spaces', actionable: false, rules: [], channels: [], open: 0, binding: null },
    ]);
    // A window id outside its grammar is not kept; core's own folderShown, when given, is taken as it is.
    const odd = readLaneList({
      lanes: [
        {
          name: 'odd',
          rules: [],
          channels: [],
          open: 0,
          binding: {
            window: { sessionId: 'NOT A UUID', activityKey: '3F9A', folder: '/x', folderShown: '~/y', client: null },
            since: null,
          },
        },
      ],
    });
    expect(odd?.[0]?.binding?.window).toEqual({ sessionId: null, activityKey: null, folder: '~/y', client: null });
  });

  it('shows a folder with the home as ~, and every other folder as it is', () => {
    expect(shownFolder('/example/home/work/acme-site', '/example/home')).toBe('~/work/acme-site');
    expect(shownFolder('/example/home', '/example/home')).toBe('~');
    expect(shownFolder('/example/home/work', '/example/home/')).toBe('~/work');
    // Another folder that only starts with the same letters is not inside the home.
    expect(shownFolder('/example/homework/x', '/example/home')).toBe('/example/homework/x');
    expect(shownFolder('/srv/work', '/example/home')).toBe('/srv/work');
    expect(shownFolder('C:\\Users\\example\\work', 'C:\\Users\\example')).toBe('~\\work');
    // Already shown, or no home to show it with: as it is.
    expect(shownFolder('~/work', '/example/home')).toBe('~/work');
    expect(shownFolder('/example/home/work', null)).toBe('/example/home/work');
    expect(shownFolder('/example/home/work', undefined)).toBe('/example/home/work');
    expect(shownFolder('/example/home/work', '')).toBe('/example/home/work');
  });

  it("reads `lane unbind`'s answer: the lane it unbound", () => {
    expect(readUnbound({ lane: 'david', unbound: true })).toBe('david');
    expect(readUnbound({ lane: 'david', unbound: false })).toBeNull();
    expect(readUnbound({ lane: 'david' })).toBeNull();
    expect(readUnbound(null)).toBeNull();
  });

  it("an item's lane is the event service's word: a lane's name, or null for a plain queue's, never guessed", () => {
    const items = readQueueList(QUEUE_LISTS.open)?.items ?? [];
    expect(items.map((item) => [item.rule.id, item.lane])).toEqual([
      ['mail-asks', null],
      ['david-on-slack', 'david'],
      ['invoices', 'billing'],
      ['family-chat', null],
      ['receipts', 'billing'],
    ]);
    for (const item of items) expect(itemLane(item, lanes()), item.rule.id).toBe(item.lane);
    // A plain queue's item from a rule that sends to a lane too: null says it is in no lane, whatever its rule.
    const plain = readQueueList({ items: [{ ...DAVID_ITEM, id: PLAIN_DAVID, lane: null }] })?.items[0];
    expect(plain?.lane).toBeNull();
    expect(itemLane(plain as never, lanes())).toBeNull();
    // A lane's name, bare or as `{ name }`; a word that is no lane's name is no lane.
    const named = readQueueList({ items: [{ ...DAVID_ITEM, lane: { name: 'billing' } }] })?.items[0];
    expect(itemLane(named as never, lanes())).toBe('billing');
    const bad = readQueueList({ items: [{ ...DAVID_ITEM, lane: 'Not A Lane' }] })?.items[0];
    expect(bad?.lane).toBeNull();
    expect(itemLane(bad as never, lanes())).toBeNull();
  });

  it("an older service's item, which says nothing of a lane, is told from the one lane its rule sends to, never a guess between two", () => {
    const items = readQueueList({ items: OLDER_OPEN })?.items ?? [];
    expect(items.every((item) => item.lane === undefined)).toBe(true);
    const byRule = (rule: string) => items.find((item) => item.rule.id === rule);
    expect(itemLane(byRule('david-on-slack') as never, lanes())).toBe('david');
    expect(itemLane(byRule('invoices') as never, lanes())).toBe('billing');
    expect(itemLane(byRule('receipts') as never, lanes())).toBe('billing');
    expect(itemLane(byRule('mail-asks') as never, lanes())).toBeNull();
    // Two lanes that a rule sends to: which one an item is in cannot be told from the rule.
    const both = [...lanes(), { ...(lanes()[0] as LaneView), name: 'david-too' }];
    expect(itemLane(byRule('david-on-slack') as never, both)).toBeNull();
  });

  it('a lane narrows the list by its one rule; a lane of two rules narrows nothing', () => {
    const [david, billing] = lanes() as [LaneView, LaneView];
    expect(narrowingRule(david)).toBe('david-on-slack');
    expect(narrowingRule(billing)).toBeNull();
    expect(narrowingRule({ ...david, rules: ['rule 1'] })).toBeNull();
    expect(
      filterLanes([...lanes(), { ...billing, name: 'Bad Name', actionable: false }]).map((lane) => lane.name),
    ).toEqual(['david', 'billing']);
  });

  it('the picker offers the grouped windows only, says which is bound already, and counts the rest', () => {
    const sessions = readSessions(RECENT_SESSIONS)?.sessions ?? [];
    const picker = pickerWindows(sessions, lanes());
    expect(picker.windows.map((each) => [each.session.key, each.boundTo])).toEqual([
      ['7c1e5b9a0d2f4e68', null],
      ['3f9a1c2e7b4d5a60', 'david'],
    ]);
    // The event service's session and a command's: not grouped under one agent window.
    expect(picker.hidden).toBe(2);
    expect(pickerWindows([], lanes())).toEqual({ windows: [], hidden: 0 });
  });
});

describe('Lanes: the gate', () => {
  it(
    'an events service older than 0.31.0 gets the update line in Lanes, and no lane call, filter or chip',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.30.0');
      const open = await openQueue(bridge);
      expect(within(main()).queryByRole('combobox', { name: LANES_COPY.lane })).toBeNull();
      expect(open.querySelector('[data-slot="queue-lane"]')).toBeNull();
      fireEvent.click(await within(main()).findByRole('tab', { name: /^Lanes\b/ }));
      const view = await within(main()).findByRole('region', { name: LANES_COPY.tab });
      expect(await within(view).findByText(COPY.updateToUse)).toBeTruthy();
      expect(await within(view).findByText('Needs 0.31.0 or later; this machine has 0.30.0.')).toBeTruthy();
      expect(laneCalls(bridge)).toEqual([]);
      // The queue's own calls are as 0.30.0 makes them.
      for (const call of cliCalls(bridge).filter((each) => each.kind === 'queueList')) {
        expect(Object.keys(call).sort()).toEqual(['kind', 'limit', 'state']);
      }
    },
  );

  it('0.31.0, and a pull request build of it, read the lanes', SLOW, async () => {
    for (const version of ['0.31.0', '0.31.0-feat-0.31']) {
      const bridge = bridgeAt(version);
      const view = await openLanes(bridge);
      expect(await laneRow(view, 'david')).toBeTruthy();
      expect(laneCalls(bridge)).toContainEqual({ kind: 'laneList' });
      // Reading changes nothing: no unbind, no terminal.
      expect(laneCalls(bridge).filter((call) => call.kind !== 'laneList')).toEqual([]);
      expect(terminals(bridge)).toEqual([]);
      cleanup();
    }
  });
});

describe('Lanes: the panel', () => {
  it(
    'each lane: its name, rules and channels, open count, and the window bound to it, or that none is',
    SLOW,
    async () => {
      const view = await openLanes(bridgeAt());
      const david = await laneRow(view, 'david');
      expect(within(david).getByText('david')).toBeTruthy();
      expect(within(david).getByText('1 open')).toBeTruthy();
      // Rules by the names the counts give them, then the channels.
      expect(david.querySelector('[data-slot="lane-rules"]')?.textContent).toBe('David on Slack · Slack');
      // The window: its folder with the home as ~, in mono; its client as it says; since when.
      const folder = david.querySelector<HTMLElement>('[data-slot="lane-folder"]');
      expect(folder?.textContent).toBe('~/work/acme-site');
      expect(folder?.className).toContain('font-mono');
      expect(david.querySelector('[data-slot="lane-client"]')?.textContent).toContain(
        `claude-code 2.1.0, ${LANES_COPY.asTheClientSays}`,
      );
      expect(david.querySelector('[data-slot="lane-since"] time')?.getAttribute('datetime')).toBe(
        '2026-10-25T09:12:03.000Z',
      );
      expect(within(david).getByRole('button', { name: LANES_COPY.unbind })).toBeTruthy();
      expect(within(david).queryByRole('button', { name: LANES_COPY.bind })).toBeNull();
      // An unbound lane: Not bound, and Bind a window….
      const billing = await laneRow(view, 'billing');
      expect(within(billing).getByText('2 open')).toBeTruthy();
      expect(billing.querySelector('[data-slot="lane-rules"]')?.textContent).toBe('Invoices, Receipts · Gmail, Resend');
      expect(billing.querySelector('[data-slot="lane-binding"]')?.textContent).toBe(LANES_COPY.notBound);
      expect(within(billing).getByRole('button', { name: LANES_COPY.bind })).toBeTruthy();
      expect(within(billing).queryByRole('button', { name: LANES_COPY.unbind })).toBeNull();
      // The Lanes tab counts its lanes.
      expect((await within(main()).findByRole('tab', { name: /^Lanes\b/ })).textContent).toContain('2');
    },
  );

  /** Focuses the hint named `name` in `within` and waits for a tooltip that says `text`. */
  async function hint(scope: HTMLElement, name: string, text: string): Promise<void> {
    const trigger = await within(scope).findByRole('button', { name });
    await act(async () => {
      trigger.focus();
    });
    await waitFor(async () => {
      const tips = await screen.findAllByRole('tooltip');
      expect(tips.map((tip) => tip.textContent)).toContain(text);
    });
    await act(async () => {
      trigger.blur();
    });
  }

  it('what a lane is stays reachable beside the tabs, and says other windows never see its items', SLOW, async () => {
    await openLanes(bridgeAt());
    await hint(main(), 'About lanes', LANES_COPY.about);
    // B4: windows not bound to a lane never see its items; the person sees them all.
    expect(LANES_COPY.about).toContain('Other agent windows never see its items');
  });

  it('why binding is at the terminal stays reachable beside Bind a window…, in its exact words', SLOW, async () => {
    expect(LANES_COPY.bindHint).toBe('You bind it at the terminal, so an agent can never bind itself.');
    const view = await openLanes(bridgeAt());
    await hint(
      await laneRow(view, 'billing'),
      'About binding',
      'You bind it at the terminal, so an agent can never bind itself.',
    );
  });

  it('that a client names itself stays reachable beside it', SLOW, async () => {
    const view = await openLanes(bridgeAt());
    await hint(await laneRow(view, 'david'), 'About the client', LANES_COPY.clientHint);
  });

  it('with no lane, it says so and how to make one', SLOW, async () => {
    const view = await openLanes(bridgeAt('0.31.0', { laneList: { lanes: [] } }));
    expect(await within(view).findByText(LANES_COPY.noLanes)).toBeTruthy();
    expect(await within(view).findByText(LANES_COPY.noLanesHint)).toBeTruthy();
    expect(within(main()).queryByRole('combobox', { name: LANES_COPY.lane })).toBeNull();
  });

  it('a lane whose name is outside the grammar is shown, with neither Unbind nor Bind', SLOW, async () => {
    const bridge = bridgeAt('0.31.0', {
      laneList: { lanes: [{ name: 'Odd Lane', rules: [], channels: [], open: 0, binding: null }] },
    });
    const view = await openLanes(bridge);
    const row = await laneRow(view, 'Odd Lane');
    expect(within(row).getByText('Odd Lane')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('a lane list that cannot be read says what went wrong, and the items still show', SLOW, async () => {
    const bridge = bridgeAt();
    const cli = bridge.cli;
    bridge.cli = async (call) =>
      call.kind === 'laneList' ? failed('EVENTS_NOT_RUNNING', 'The event service is not running.') : cli(call);
    const view = await openLanes(bridge);
    expect((await within(view).findByRole('alert')).textContent).toBe('The event service is not running.');
    // No lane is listed, so no filter; the items are as they were, each with the lane the event service says it is in.
    fireEvent.click(await within(main()).findByRole('tab', { name: /^Open\b/ }));
    const open = await within(main()).findByRole('region', { name: 'Open' });
    await waitFor(() => expect(shown(open)).toHaveLength(QUEUE_LISTS.open.items.length));
    expect(
      Array.from(open.querySelectorAll<HTMLElement>('[data-slot="queue-lane"]')).map((chip) => chip.dataset.itemLane),
    ).toEqual(['david', 'billing', 'billing']);
    expect(within(main()).queryByRole('combobox', { name: LANES_COPY.lane })).toBeNull();
  });
});

describe('Lanes: Unbind', () => {
  it(
    'asks first: Cancel runs nothing; Unbind runs exactly `lane unbind <lane>`, once, and the lane is unbound',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await openLanes(bridge);
      const david = await laneRow(view, 'david');
      fireEvent.click(within(david).getByRole('button', { name: LANES_COPY.unbind }));
      const dialog = await screen.findByRole('alertdialog', { name: unbindTitle('david') });
      expect(within(dialog).getByText(LANES_COPY.unbindBody)).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: COPY.cancel }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(laneCalls(bridge).filter((call) => call.kind === 'laneUnbind')).toEqual([]);
      fireEvent.click(within(await laneRow(view, 'david')).getByRole('button', { name: LANES_COPY.unbind }));
      const again = await screen.findByRole('alertdialog', { name: unbindTitle('david') });
      fireEvent.click(within(again).getByRole('button', { name: LANES_COPY.unbind }));
      expect(await within(view).findByText('Unbound david.')).toBeTruthy();
      expect(laneCalls(bridge).filter((call) => call.kind === 'laneUnbind')).toEqual([
        { kind: 'laneUnbind', lane: 'david' },
      ]);
      // The lane is read again, and now has no window.
      await waitFor(async () =>
        expect((await laneRow(view, 'david')).querySelector('[data-slot="lane-binding"]')?.textContent).toBe(
          LANES_COPY.notBound,
        ),
      );
      // A tightening, applied by the app: no terminal, no approval.
      expect(terminals(bridge)).toEqual([]);
      for (const call of laneCalls(bridge)) expect(JSON.stringify(call)).not.toMatch(/approv/i);
    },
  );

  it('a lane that is no longer there says so, and the lanes are read again', SLOW, async () => {
    const bridge = bridgeAt('0.31.0', {}, {});
    const cli = bridge.cli;
    bridge.cli = async (call) =>
      call.kind === 'laneUnbind' ? failed('NOT_FOUND', 'no lane david', null, 66) : cli(call);
    const view = await openLanes(bridge);
    const reads = laneCalls(bridge).filter((call) => call.kind === 'laneList').length;
    fireEvent.click(within(await laneRow(view, 'david')).getByRole('button', { name: LANES_COPY.unbind }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LANES_COPY.unbind }));
    expect(await within(view).findByText(LANES_COPY.gone)).toBeTruthy();
    await waitFor(() =>
      expect(laneCalls(bridge).filter((call) => call.kind === 'laneList').length).toBeGreaterThan(reads),
    );
  });

  it('a refusal says what the event service said', SLOW, async () => {
    const bridge = bridgeAt();
    const cli = bridge.cli;
    bridge.cli = async (call) =>
      call.kind === 'laneUnbind' ? failed('INTERNAL', 'the event service could not unbind it', null, 1) : cli(call);
    const view = await openLanes(bridge);
    fireEvent.click(within(await laneRow(view, 'david')).getByRole('button', { name: LANES_COPY.unbind }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: LANES_COPY.unbind }));
    expect(await within(view).findByText('the event service could not unbind it')).toBeTruthy();
  });
});

describe('Lanes: Bind a window…', () => {
  it(
    'opens a picker of the grouped windows of the last 24 hours, says why others are missing, and Bind in Terminal opens the bind command',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await openLanes(bridge);
      fireEvent.click(within(await laneRow(view, 'billing')).getByRole('button', { name: LANES_COPY.bind }));
      const dialog = await screen.findByRole('dialog', { name: 'Bind a window to billing' });
      // Core's recent sessions, over the last 24 hours, read when the picker opens.
      await waitFor(() => expect(cliCalls(bridge)).toContainEqual({ kind: 'activitySessions', since: '24h' }));
      await waitFor(() => expect(dialog.querySelectorAll('[data-window]')).toHaveLength(2));
      const windows = Array.from(dialog.querySelectorAll<HTMLElement>('[data-window]'));
      expect(windows.map((each) => each.dataset.window)).toEqual(['7c1e5b9a0d2f4e68', '3f9a1c2e7b4d5a60']);
      // The event service's session and a command's are not offered: grouped ones only, and the rest counted.
      expect(dialog.querySelector('[data-window="a1b2c3d4e5f60718"]')).toBeNull();
      expect(dialog.querySelector('[data-window="0c0ffee000000001"]')).toBeNull();
      expect(dialog.querySelector('[data-slot="picker-hidden"]')?.textContent).toContain('2 more not listed');
      const why = within(dialog).getByRole('button', { name: 'Why some are not listed' });
      await act(async () => {
        why.focus();
      });
      await waitFor(async () => expect((await screen.findByRole('tooltip')).textContent).toBe(LANES_COPY.hiddenHint));
      // Each window: its folder in mono, its client as it says; the one bound to david already has no Bind.
      const free = windows[0] as HTMLElement;
      expect(within(free).getByText('~/work/billing-tool').closest('.font-mono')).not.toBeNull();
      expect(free.textContent).toContain(`cursor 1.9.2, ${LANES_COPY.asTheClientSays}`);
      const taken = windows[1] as HTMLElement;
      expect(within(taken).queryByRole('button', { name: LANES_COPY.bindInTerminal })).toBeNull();
      expect(within(taken).getByText('Bound to david')).toBeTruthy();
      // Bind in Terminal opens the person's terminal with the bind command for that window's activity key.
      fireEvent.click(within(free).getByRole('button', { name: LANES_COPY.bindInTerminal }));
      expect(await within(dialog).findByText('Opened in Terminal.')).toBeTruthy();
      // The command is the bind, and nothing else: the person types the lane's name there to confirm it.
      expect(terminals(bridge)).toEqual([{ kind: 'laneBind', lane: 'billing', window: '7c1e5b9a0d2f4e68' }]);
      expect(await within(dialog).findByText('Type billing in Terminal to confirm, then come back here.')).toBeTruthy();
      expect(pickerAfterLine('billing')).toBe('Type billing in Terminal to confirm, then come back here.');
      // The app never binds: no call does, and nothing is approved.
      expect(cliCalls(bridge).map((call) => call.kind)).not.toContain('laneBind');
      for (const call of laneCalls(bridge)) expect(JSON.stringify(call)).not.toMatch(/approv/i);
      expect(laneCalls(bridge).map((call) => call.kind)).toEqual(laneCalls(bridge).map(() => 'laneList'));
    },
  );

  it('with no terminal, the bind command is copied, and the picker says so', SLOW, async () => {
    const bridge = bridgeAt(
      '0.31.0',
      {},
      { openInTerminal: async () => ({ outcome: 'copied', reason: 'noTerminal', revoked: null }) },
    );
    const view = await openLanes(bridge);
    fireEvent.click(within(await laneRow(view, 'billing')).getByRole('button', { name: LANES_COPY.bind }));
    const dialog = await screen.findByRole('dialog', { name: 'Bind a window to billing' });
    fireEvent.click(await within(dialog).findByRole('button', { name: LANES_COPY.bindInTerminal }));
    expect(await within(dialog).findByText(COPY.noTerminal)).toBeTruthy();
  });

  it('with no grouped window in the last 24 hours, it says so and why', SLOW, async () => {
    const lone = { ...RECENT_SESSIONS, sessions: RECENT_SESSIONS.sessions.filter((each) => !each.grouped) };
    const view = await openLanes(bridgeAt('0.31.0', { activitySessions: lone }));
    fireEvent.click(within(await laneRow(view, 'billing')).getByRole('button', { name: LANES_COPY.bind }));
    const dialog = await screen.findByRole('dialog', { name: 'Bind a window to billing' });
    expect(await within(dialog).findByText(LANES_COPY.noWindows)).toBeTruthy();
    expect(dialog.querySelector('[data-slot="picker-hidden"]')?.textContent).toContain('2 more not listed');
  });

  it("before core's activity log, the picker asks for an update and reads nothing", SLOW, async () => {
    const bridge = bridgeAt('0.31.0', {}, { installation: async () => ({ ...LANES_INSTALLATION, version: '0.28.0' }) });
    const view = await openLanes(bridge);
    fireEvent.click(within(await laneRow(view, 'billing')).getByRole('button', { name: LANES_COPY.bind }));
    const dialog = await screen.findByRole('dialog', { name: 'Bind a window to billing' });
    expect(await within(dialog).findByText('Needs 0.29.0 or later; this machine has 0.28.0.')).toBeTruthy();
    expect(cliCalls(bridge).map((call) => call.kind)).not.toContain('activitySessions');
  });
});

describe('Lanes: the Queue screen', () => {
  it("shows each item's lane as a quiet chip, and none on an item in no lane", SLOW, async () => {
    const view = await openQueue(bridgeAt());
    const chip = (rule: string) =>
      view.querySelector<HTMLElement>(`li[data-item="${OPEN_BY_RULE[rule]}"] [data-slot="queue-lane"]`);
    await waitFor(() => expect(chip('david-on-slack')).not.toBeNull());
    expect(chip('david-on-slack')?.textContent).toBe(`${LANES_COPY.lane} david`);
    expect(chip('invoices')?.textContent).toBe(`${LANES_COPY.lane} billing`);
    expect(chip('receipts')?.textContent).toBe(`${LANES_COPY.lane} billing`);
    expect(chip('mail-asks')).toBeNull();
    expect(chip('family-chat')).toBeNull();
  });

  it(
    "a plain queue's item says it is in no lane though its rule sends to one too: no chip, and not under that lane's filter",
    SLOW,
    async () => {
      const plain = { ...DAVID_ITEM, id: PLAIN_DAVID, lane: null };
      const view = await openQueue(bridgeAt('0.31.0', { queueList: { items: [DAVID_ITEM, plain], more: false } }));
      const chip = (id: string) => view.querySelector(`li[data-item="${id}"] [data-slot="queue-lane"]`);
      await waitFor(() => expect(chip(DAVID_ITEM.id)?.textContent).toBe(`${LANES_COPY.lane} david`));
      expect(view.querySelector(`li[data-item="${PLAIN_DAVID}"]`)).not.toBeNull();
      expect(chip(PLAIN_DAVID)).toBeNull();
      await choose(LANES_COPY.lane, 'david');
      await waitFor(() => expect(shown(view)).toEqual([DAVID_ITEM.id]));
    },
  );

  it("an older service's items, which say nothing of a lane, show the one lane their rule sends to", SLOW, async () => {
    const view = await openQueue(bridgeAt('0.31.0', { queueList: { items: OLDER_OPEN, more: false } }));
    const chip = (rule: string) =>
      view.querySelector<HTMLElement>(`li[data-item="${OPEN_BY_RULE[rule]}"] [data-slot="queue-lane"]`);
    await waitFor(() => expect(chip('david-on-slack')?.textContent).toBe(`${LANES_COPY.lane} david`));
    expect(chip('invoices')?.textContent).toBe(`${LANES_COPY.lane} billing`);
    expect(chip('mail-asks')).toBeNull();
    await choose(LANES_COPY.lane, 'billing');
    await waitFor(() => expect(shown(view)).toEqual([OPEN_BY_RULE.invoices, OPEN_BY_RULE.receipts]));
  });

  it(
    'the lane filter: a lane of one rule narrows the read by it; a lane of two filters what was read; All lanes undoes it',
    SLOW,
    async () => {
      const bridge = bridgeAt();
      const view = await openQueue(bridge);
      await choose(LANES_COPY.lane, 'david', (options) =>
        expect(options).toEqual([LANES_COPY.allLanes, 'david', 'billing']),
      );
      await waitFor(() => expect(shown(view)).toEqual([OPEN_BY_RULE['david-on-slack']]));
      expect(cliCalls(bridge).filter((call) => call.kind === 'queueList')).toContainEqual({
        kind: 'queueList',
        state: 'open',
        rule: 'david-on-slack',
        limit: QUEUE_LIMIT,
      });
      await choose(LANES_COPY.lane, 'billing');
      await waitFor(() => expect(shown(view)).toEqual([OPEN_BY_RULE.invoices, OPEN_BY_RULE.receipts]));
      // Billing has two rules: the read is the tab's own, filtered here.
      expect(
        cliCalls(bridge)
          .filter((call) => call.kind === 'queueList')
          .at(-1),
      ).toEqual({
        kind: 'queueList',
        state: 'open',
        limit: QUEUE_LIMIT,
      });
      await choose(LANES_COPY.lane, LANES_COPY.allLanes);
      await waitFor(() => expect(shown(view)).toHaveLength(QUEUE_LISTS.open.items.length));
    },
  );

  it('a lane with nothing in this tab says no items match', SLOW, async () => {
    const view = await openQueue(
      bridgeAt('0.31.0', { queueList: { items: [QUEUE_LISTS.open.items[0]], more: false } }),
    );
    await choose(LANES_COPY.lane, 'billing');
    expect(await within(view).findByText('No items match these filters.')).toBeTruthy();
  });

  it('Lanes offers no filters and no Clear; the item tabs keep theirs', SLOW, async () => {
    const bridge = bridgeAt();
    await openLanes(bridge);
    expect(within(main()).queryByRole('region', { name: 'Filters' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Clear done and dismissed' })).toBeNull();
    fireEvent.click(await within(main()).findByRole('tab', { name: /^Done\b/ }));
    expect(await within(main()).findByRole('region', { name: 'Filters' })).toBeTruthy();
    expect(await within(main()).findByRole('button', { name: 'Clear done and dismissed' })).toBeTruthy();
  });
});
