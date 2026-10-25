import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import judgesContract from '../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json';
import daemonContract from '../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json';
import links from '../../src-tauri/src/links.rs?raw';
import { COPY } from '../copy.ts';
import { POLL_MS } from '../data.tsx';
import type { Bridge, Call, CliResult, EventServiceState, TerminalCommand } from '../ipc.ts';
import { JUDGES_HELP } from '../screens/Events.tsx';
import {
  cliKinds,
  createFakeBridge,
  EVENT_SERVICE,
  EXAMPLE_INSTALLATION,
  type FakeBridge,
  type Fixture,
  failed,
  ok,
} from './fake-bridge.ts';
import deliveries from './fixtures/events-deliveries.json';
import rules from './fixtures/events-rules.json';
import running from './fixtures/events-status.running.json';
import { renderApp } from './render.tsx';

/** A fake bridge whose `cli` answers the kinds in `results` with a whole result, and every other from `fixtures`. */
function bridgeWith(
  results: Partial<Record<Call['kind'], CliResult | Promise<CliResult>>>,
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
): FakeBridge {
  const inner = createFakeBridge({}, fixtures);
  return createFakeBridge(
    {
      cli: (call) => {
        const result = results[call.kind];
        return result === undefined ? inner.cli(call) : Promise.resolve(result);
      },
    },
    fixtures,
  );
}

/** Tests that render the whole app many times: the slowest CI runner has taken more than Vitest's 5 s for one. */
const RENDER_LOOP_MS = 30_000;

const EVENTS_CALLS: Call['kind'][] = [
  'eventsStatus',
  'eventsPause',
  'eventsResume',
  'eventsRules',
  'eventsDeliveries',
  'eventsJudgeModelStatus',
  'eventsJudgeKindDisable',
  'judgeKindsList',
  'judgesList',
  'judgeKindDisable',
];

/** The first events service with phase E2's Laya calls (DA12), and the one before it. */
const WITH_LAYA = '0.25.0';
const BEFORE_LAYA = '0.24.0';

/** Every product at 0.24.0, but the events service at `events`. */
const versions =
  (events: string) =>
  (call: Call): string =>
    call.kind === 'version' && call.product === 'events-daemon' ? events : BEFORE_LAYA;

const region = (name: string): HTMLElement => screen.getByRole('region', { name });

/** The Events screen's tabs, by the name each starts with: its badge, when it has one, follows. */
const TAB_NAMES = ['Service', 'Judges', 'Rules', 'Deliveries'] as const;
type TabName = (typeof TAB_NAMES)[number];

/** A tab, once the screen shows its tabs. */
async function findTab(name: TabName): Promise<HTMLElement> {
  return screen.findByRole('tab', { name: new RegExp(`^${name}\\b`) });
}

/** What a hint says, once its "i" has the keyboard's focus: a hint reachable without a pointer. */
async function hint(trigger: HTMLElement): Promise<string> {
  await act(async () => {
    trigger.focus();
  });
  return (await screen.findByRole('tooltip')).textContent ?? '';
}

/** A tab's dot, when it has one: its tone, and what it says to a screen reader. Each tab has one at most. */
function markOf(tab: HTMLElement): { tone: string | null; says: string | null } | null {
  const dots = within(tab).queryAllByRole('status');
  expect(dots.length).toBeLessThanOrEqual(1);
  const dot = dots[0];
  return dot === undefined ? null : { tone: dot.getAttribute('data-tone'), says: dot.textContent };
}

const FAILED_MARK = { tone: 'danger', says: 'could not be read' };
const UPDATE_MARK = { tone: 'warn', says: 'needs an update' };

/** Opens a tab, as a click on it does. */
async function openTab(name: TabName): Promise<void> {
  fireEvent.click(await findTab(name));
  await waitFor(async () => expect((await findTab(name)).getAttribute('aria-selected')).toBe('true'));
}

describe('Events', () => {
  it('Events: absent, loading, error, populated; Pause and Resume run', { timeout: RENDER_LOOP_MS }, async () => {
    // Absent: no launcher, so the screen says so and nothing of the events service is asked.
    const absent = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    const first = renderApp(absent, { screen: 'events' });
    expect(await screen.findByText("The events service isn't installed.")).toBeTruthy();
    expect(cliKinds(absent).filter((kind) => EVENTS_CALLS.includes(kind))).toEqual([]);
    first.unmount();

    // Loading: nothing has come back yet, Laya's status included.
    const never = new Promise<CliResult>(() => undefined);
    const waiting = bridgeWith(
      { eventsStatus: never, eventsRules: never, eventsDeliveries: never, eventsJudgeModelStatus: never },
      { version: versions(WITH_LAYA) },
    );
    const second = renderApp(waiting, { screen: 'events' });
    const main = await screen.findByRole('main');
    await within(main).findAllByRole('status', { name: COPY.loading });
    await waitFor(() => expect(cliKinds(waiting)).toContain('eventsJudgeModelStatus'));
    // Every view is read when the screen opens, the ones behind a tab too: the status, Laya's, the rules and deliveries.
    expect(within(main).getAllByRole('status', { name: COPY.loading, hidden: true })).toHaveLength(4);
    second.unmount();

    // An error: each part says what went wrong, as text.
    const broken = bridgeWith({
      eventsStatus: failed('CLI_FAILED', 'the events service did not answer'),
      eventsRules: failed('CLI_FAILED', 'the local event service is not running'),
      eventsDeliveries: failed('CLI_FAILED', 'no deliveries could be read'),
    });
    const third = renderApp(broken, { screen: 'events' });
    expect(await screen.findByText('the events service did not answer')).toBeTruthy();
    expect(await screen.findByText('the local event service is not running')).toBeTruthy();
    expect(await screen.findByText('no deliveries could be read')).toBeTruthy();
    third.unmount();

    // Populated, from the fixtures: the status, then each list as a table of its own fields.
    let paused = false;
    const bridge = bridgeWith(
      {},
      {
        eventsStatus: () => ({ ...running, paused }),
        eventsRules: rules,
        eventsDeliveries: deliveries,
        eventsPause: () => {
          paused = true;
          return { enabled: true, paused, switchGeneration: 3 };
        },
        eventsResume: () => {
          paused = false;
          return { enabled: true, paused, switchGeneration: 3 };
        },
      },
    );
    renderApp(bridge, { screen: 'events' });
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(await within(status).findByText('running')).toBeTruthy();
    expect(within(status).getByText('on')).toBeTruthy();

    await openTab('Rules');
    const ruleTable = await screen.findByRole('table', { name: 'Rules' });
    const ruleRows = within(ruleTable).getAllByRole('row');
    expect(ruleRows).toHaveLength(1 + rules.length);
    expect(within(ruleTable).getAllByText('rule_example')).toHaveLength(2);
    expect(within(ruleTable).getByText('active')).toBeTruthy();
    expect(within(ruleTable).getByText('superseded')).toBeTruthy();
    expect(within(ruleTable).getByText('ap_1A2B3C4D5E6F7G8H9J0K1M2N3P')).toBeTruthy();

    await openTab('Deliveries');
    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getAllByRole('row')).toHaveLength(1 + deliveries.length);
    expect(within(deliveryTable).getByText('dlv_example_1')).toBeTruthy();
    expect(within(deliveryTable).getByText('retryable')).toBeTruthy();
    expect(deliveryTable.querySelector(`time[datetime="${new Date(1760950800000).toISOString()}"]`)).not.toBeNull();

    // Pause runs `eventsPause`, the status is read again, and Resume runs `eventsResume`.
    await openTab('Service');
    const resume = within(status).getByRole('button', { name: 'Resume' }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(within(status).getByRole('button', { name: 'Pause' }));
    expect(await within(region('Status')).findByText('paused')).toBeTruthy();
    expect(cliKinds(bridge)).toContain('eventsPause');
    await waitFor(() =>
      expect((within(region('Status')).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(within(region('Status')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(cliKinds(bridge)).toContain('eventsResume'));
    await waitFor(() => expect(within(region('Status')).queryByText('paused')).toBeNull());
  });

  it('a service that is not running offers neither Pause nor Resume, and an empty list says so', async () => {
    const bridge = bridgeWith({}, { eventsStatus: { owner: 'not-running' }, eventsRules: [], eventsDeliveries: [] });
    renderApp(bridge, { screen: 'events' });
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(await within(status).findByText('not running')).toBeTruthy();
    expect((within(status).getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(status).getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    await openTab('Rules');
    expect(await within(region('Rules')).findByText('No rules yet.')).toBeTruthy();
    await openTab('Deliveries');
    expect(await within(region('Recent deliveries')).findByText('No deliveries yet.')).toBeTruthy();
  });

  it('a list in a shape the app does not know says so, and hostile text stays text', async () => {
    const bridge = bridgeWith(
      {},
      {
        eventsRules: { rules: 'not a list' },
        eventsDeliveries: [{ deliveryId: '<img src=x onerror=alert(1)>', state: '</untrusted-content>' }],
      },
    );
    renderApp(bridge, { screen: 'events' });
    await openTab('Rules');
    expect(await within(region('Rules')).findByText('The list could not be read.')).toBeTruthy();
    await openTab('Deliveries');
    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(deliveryTable).getByText('</untrusted-content>')).toBeTruthy();
    expect(deliveryTable.querySelector('img')).toBeNull();
  });

  it('Events: four tabs, Service first; each shows its own view, and every view is read when the screen opens', async () => {
    const bridge = bridgeWith(
      {},
      { version: versions('0.27.0'), eventsRules: rules, eventsDeliveries: deliveries, eventsStatus: running },
    );
    renderApp(bridge, { screen: 'events' });
    const list = await screen.findByRole('tablist', { name: 'Events' });
    const names = within(list)
      .getAllByRole('tab')
      .map((tab) => TAB_NAMES.find((name) => (tab.textContent ?? '').startsWith(name)));
    expect(names).toEqual([...TAB_NAMES]);
    // The view that matters now is the first: the event service and its status.
    expect((await findTab('Service')).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByRole('region', { name: 'Event service' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Status' })).toBeTruthy();
    // The others wait behind their tabs, and are read all the same, as the screen always read them.
    for (const name of ['Judges', 'Rules', 'Recent deliveries']) {
      expect(screen.queryByRole('region', { name }), name).toBeNull();
    }
    await waitFor(() =>
      expect(cliKinds(bridge)).toEqual(
        expect.arrayContaining(['eventsStatus', 'eventsRules', 'eventsDeliveries', 'judgeKindsList', 'judgesList']),
      ),
    );
    const reads = () => cliKinds(bridge).filter((kind) => kind !== 'eventsStatus' && kind !== 'version').length;
    await waitFor(() => expect(screen.getByRole('tab', { name: `Deliveries ${deliveries.length}` })).toBeTruthy());
    const before = reads();
    // Each tab shows its own view, and only it.
    const views: Record<TabName, string[]> = {
      Service: ['Event service', 'Status'],
      Judges: ['Judges'],
      Rules: ['Rules'],
      Deliveries: ['Recent deliveries'],
    };
    for (const tab of ['Judges', 'Rules', 'Deliveries', 'Service'] as const) {
      await openTab(tab);
      for (const [owner, names] of Object.entries(views)) {
        for (const name of names) {
          expect(screen.queryByRole('region', { name }) !== null, `${tab}: ${name}`).toBe(owner === tab);
        }
      }
    }
    // Moving between tabs reads nothing again.
    expect(reads()).toBe(before);
  });

  it('the Rules and Deliveries tabs count exactly the rows their tables show, and nothing when there are none', async () => {
    // A row per version, as the table shows it: two versions of one rule are two rows. A row whose id is not text is a
    // row all the same; an entry that is not a row at all is shown nowhere, and counted nowhere.
    const odd = [...rules, { ...rules[0], rule_id: 7, version: 3 }, 'not a row'];
    const first = renderApp(bridgeWith({}, { eventsRules: odd, eventsDeliveries: deliveries }), { screen: 'events' });
    expect(await screen.findByRole('tab', { name: 'Rules 3' })).toBeTruthy();
    expect(await screen.findByRole('tab', { name: `Deliveries ${deliveries.length}` })).toBeTruthy();
    await openTab('Rules');
    expect(within(screen.getByRole('table', { name: 'Rules' })).getAllByRole('row')).toHaveLength(1 + 3);
    expect(markOf(await findTab('Rules'))).toBeNull();
    first.unmount();

    renderApp(bridgeWith({}, { eventsRules: [], eventsDeliveries: [] }), { screen: 'events' });
    await openTab('Rules');
    expect(await within(region('Rules')).findByText('No rules yet.')).toBeTruthy();
    await openTab('Deliveries');
    expect(await within(region('Recent deliveries')).findByText('No deliveries yet.')).toBeTruthy();
    for (const name of ['Rules', 'Deliveries'] as const) {
      expect(screen.getByRole('tab', { name }), name).toBeTruthy();
      expect(markOf(await findTab(name)), name).toBeNull();
    }
  });

  it('a Rules or Deliveries read that failed, or a list the app cannot read, marks its tab with a danger dot', async () => {
    for (const [what, bridge, rulesSay, deliveriesSay] of [
      [
        'failed',
        bridgeWith({
          eventsRules: failed('CLI_FAILED', 'the rules could not be read'),
          eventsDeliveries: failed('CLI_FAILED', 'the deliveries could not be read'),
        }),
        'the rules could not be read',
        'the deliveries could not be read',
      ],
      [
        'unreadable',
        bridgeWith({}, { eventsRules: { rules: 'not a list' }, eventsDeliveries: 'not a list' }),
        'The list could not be read.',
        'The list could not be read.',
      ],
    ] as const) {
      const view = renderApp(bridge, { screen: 'events' });
      // Marked while another tab is open: what went wrong waits behind it.
      await waitFor(async () => expect(markOf(await findTab('Rules')), what).toEqual(FAILED_MARK));
      await waitFor(async () => expect(markOf(await findTab('Deliveries')), what).toEqual(FAILED_MARK));
      // No count beside it, and the view says what went wrong.
      expect((await findTab('Rules')).textContent, what).toBe('Rules could not be read');
      expect(markOf(await findTab('Service')), what).toBeNull();
      expect(markOf(await findTab('Judges')), what).toBeNull();
      await openTab('Rules');
      expect(await within(region('Rules')).findByText(rulesSay), what).toBeTruthy();
      await openTab('Deliveries');
      expect(await within(region('Recent deliveries')).findByText(deliveriesSay), what).toBeTruthy();
      view.unmount();
    }
  });

  it('beyond the 100 deliveries shown, a line says how many there are, and its hint where every one is listed', async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      ...deliveries[0],
      deliveryId: `dlv_${index}`,
      expiresAt: 1760947200000 + index,
    }));
    renderApp(bridgeWith({}, { eventsRules: [], eventsDeliveries: many }), { screen: 'events' });
    expect(await screen.findByRole('tab', { name: 'Deliveries 120' })).toBeTruthy();
    await openTab('Deliveries');
    const view = region('Recent deliveries');
    expect(await within(view).findByText('The 100 most recent of 120.')).toBeTruthy();
    expect(within(within(view).getByRole('table')).getAllByRole('row')).toHaveLength(101);
    // The newest first: the last made is the first shown.
    expect(within(view).getByText('dlv_119')).toBeTruthy();
    expect(within(view).queryByText('dlv_0')).toBeNull();
    expect(await hint(within(view).getByRole('button', { name: 'Where every one is listed' }))).toBe(
      'The events CLI and MCP list every one.',
    );
  });
});

/*
 * The event service the app runs (design D2, D4, D5, D6; plan P1, Task 3): its switch, where it stands, and what the
 * window offers when it gave up, when a newer version is installed, or when it needs Full Disk Access. The app only
 * shows its supervisor's state and asks it; every state here is one of the fake bridge's `EVENT_SERVICE` fixtures.
 */
describe('The event service', () => {
  const SERVICE = 'Event service';
  const SWITCH = 'Run the event service';

  /** The Events screen's other parts quiet, and the supervisor in `state`, with any command replaced by `handlers`. */
  function serviceBridge(state: EventServiceState, handlers: Partial<Bridge> = {}): FakeBridge {
    return createFakeBridge(
      { eventServiceState: async () => state, ...handlers },
      { eventsRules: [], eventsDeliveries: [] },
    );
  }

  /** The section once the supervisor's state is shown. */
  async function shownService(): Promise<HTMLElement> {
    const section = await screen.findByRole('region', { name: SERVICE });
    await waitFor(() => expect(within(section).queryByRole('status', { name: COPY.loading })).toBeNull());
    return section;
  }

  const commands = (bridge: FakeBridge, command: keyof Bridge) =>
    bridge.calls.filter((call) => call.command === command);

  it('the event service switch shows Running with its since and version, and off calls setEventService(false)', async () => {
    const restartedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const bridge = serviceBridge({ ...EVENT_SERVICE.running, restarts: 1, lastRestartAt: restartedAt });
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    const toggle = within(section).getByRole('switch', { name: SWITCH });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(within(section).getByText('Running')).toBeTruthy();
    expect(section.querySelector(`time[datetime="${EVENT_SERVICE.running.since}"]`)).not.toBeNull();
    expect(within(section).getByText('0.27.0')).toBeTruthy();
    // A restart is one quiet line, its time relative to now.
    const minutesAgo = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-2, 'minute');
    expect(within(section).getByText('Restarted').textContent).toBe(`Restarted ${minutesAgo}`);
    // Nothing else is said of a service that runs as it should.
    expect(within(section).queryByRole('alert')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(commands(bridge, 'setEventService')).toEqual([{ command: 'setEventService', args: false }]),
    );
    await waitFor(() =>
      expect(within(region(SERVICE)).getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('false'),
    );
    expect(within(region(SERVICE)).getByText('Stopped')).toBeTruthy();
    // The switch is the supervisor's: it runs no CLI change, and opens no terminal.
    expect(cliKinds(bridge)).not.toContain('eventsPause');
    expect(bridge.calls.map((call) => call.command)).not.toContain('openInTerminal');
  });

  it('a stop from outside shows "Stopped from outside at" and the switch off', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.running);
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByText('Running')).toBeTruthy();
    // The supervisor says so when it finds the clean stop.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.stoppedFromOutside));
    const line = await within(region(SERVICE)).findByText('Stopped from outside at');
    expect(
      line.querySelector(`time[datetime="${EVENT_SERVICE.stoppedFromOutside.stoppedFromOutsideAt}"]`),
    ).not.toBeNull();
    expect(within(region(SERVICE)).getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('false');
    expect(within(region(SERVICE)).queryByText('Running')).toBeNull();
  });

  it('giving up shows the copy, the last log lines as plain text, and Try again calls eventServiceRetry', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.gaveUp);
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    const alert = within(section).getByRole('alert');
    expect(
      within(alert).getByText('The event service stopped 5 times in 10 minutes, so Agent Comms stopped restarting it.'),
    ).toBeTruthy();
    for (const line of EVENT_SERVICE.gaveUp.logTail) expect(within(alert).getByText(line), line).toBeTruthy();
    // A line of the log is text, never markup.
    expect(alert.querySelector('img')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(commands(bridge, 'eventServiceRetry')).toHaveLength(1));
    await waitFor(() => expect(within(region(SERVICE)).queryByRole('alert')).toBeNull());
    expect(within(region(SERVICE)).getByRole('status', { name: 'Starting the event service…' })).toBeTruthy();
  });

  it('an older adopted version offers Restart to use it', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.olderAdopted, {
      restartEventService: async () => ({ ...EVENT_SERVICE.running, version: '0.27.0' }),
    });
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByText('0.26.2')).toBeTruthy();
    expect(within(section).getByText('Started from a terminal')).toBeTruthy();
    expect(within(section).getByText('A newer event service is installed (0.27.0).')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Restart to use it' }));
    await waitFor(() => expect(commands(bridge, 'restartEventService')).toHaveLength(1));
    await waitFor(() =>
      expect(within(region(SERVICE)).queryByText('A newer event service is installed (0.27.0).')).toBeNull(),
    );
    expect(within(region(SERVICE)).queryByRole('button', { name: 'Restart to use it' })).toBeNull();
    expect(within(region(SERVICE)).getByText('0.27.0')).toBeTruthy();
  });

  it('a service started from a terminal that went away is not restarted, and Start starts it (D4)', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.terminalGone);
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByText('Stopped')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(commands(bridge, 'setEventService')).toEqual([{ command: 'setEventService', args: true }]),
    );
    expect(await within(region(SERVICE)).findByText('Running')).toBeTruthy();
    expect(within(region(SERVICE)).queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('the first-start question shows once with Start and Not now, each calling answerFirstStart', async () => {
    // It is the app's, not a screen's: it shows over Overview.
    const bridge = serviceBridge(EVENT_SERVICE.firstStart);
    const first = renderApp(bridge);
    const dialog = await screen.findByRole('alertdialog', { name: 'Start the event service?' });
    expect(
      within(dialog).getByText(
        'The event service has run on this Mac before. Starting it resumes whatever it was set to do.',
      ),
    ).toBeTruthy();
    // The watchdog's next word, still asking, shows no second one.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.firstStart));
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(commands(bridge, 'answerFirstStart')).toEqual([{ command: 'answerFirstStart', args: true }]),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Answered, it is never asked again, even by a word that left the question in.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.firstStart));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(commands(bridge, 'answerFirstStart')).toHaveLength(1);
    first.unmount();

    const later = serviceBridge(EVENT_SERVICE.firstStart);
    renderApp(later, { screen: 'events' });
    const again = await screen.findByRole('alertdialog', { name: 'Start the event service?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(commands(later, 'answerFirstStart')).toEqual([{ command: 'answerFirstStart', args: false }]),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    // Not now leaves the switch off.
    expect(
      within(await shownService())
        .getByRole('switch', { name: SWITCH })
        .getAttribute('aria-checked'),
    ).toBe('false');
    // A service that is not asking shows no question.
    const quiet = serviceBridge(EVENT_SERVICE.running);
    renderApp(quiet);
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await waitFor(() => expect(quiet.calls.map((call) => call.command)).toContain('eventServiceState'));
    expect(screen.queryByRole('alertdialog', { name: 'Start the event service?' })).toBeNull();
  });

  it('the first-start question closes the moment Start is pressed, before its answer comes back', async () => {
    let answer: (state: EventServiceState) => void = () => undefined;
    const bridge = serviceBridge(EVENT_SERVICE.firstStart, {
      answerFirstStart: () =>
        new Promise<EventServiceState>((resolve) => {
          answer = resolve;
        }),
    });
    renderApp(bridge, { screen: 'events' });
    const dialog = await screen.findByRole('alertdialog', { name: 'Start the event service?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    // Closed while the answer is still on its way.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(commands(bridge, 'answerFirstStart')).toEqual([{ command: 'answerFirstStart', args: true }]);
    // The supervisor's word, still asking, asks nothing again.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.firstStart));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // Its answer, when it comes, is shown: starting.
    await act(async () => answer(EVENT_SERVICE.starting));
    expect(await within(region(SERVICE)).findByText('Starting the event service…')).toBeTruthy();
    expect(commands(bridge, 'answerFirstStart')).toHaveLength(1);
  });

  it("a first-start answer that fails is said in the Events screen's service section, not in a dialog", async () => {
    const bridge = serviceBridge(EVENT_SERVICE.firstStart, {
      answerFirstStart: async () => {
        throw { code: 'APP_IO', message: 'the answer could not be kept' };
      },
    });
    renderApp(bridge, { screen: 'events' });
    const dialog = await screen.findByRole('alertdialog', { name: 'Start the event service?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const problem = await within(region(SERVICE)).findByText('the answer could not be kept');
    expect(problem.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(commands(bridge, 'answerFirstStart')).toHaveLength(1);
  });

  it('while the service starts, a spinner says "Starting the event service…" and the switch stays on', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.starting);
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByRole('status', { name: 'Starting the event service…' })).toBeTruthy();
    expect(within(section).getByText('Starting the event service…')).toBeTruthy();
    expect(within(section).queryByText('Starting…')).toBeNull();
    const toggle = within(section).getByRole('switch', { name: SWITCH });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.hasAttribute('disabled') || toggle.hasAttribute('data-disabled')).toBe(false);
    expect(toggle.getAttribute('aria-disabled')).not.toBe('true');
    // Once the supervisor says it runs, the spinner goes.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.running));
    expect(await within(region(SERVICE)).findByText('Running')).toBeTruthy();
    expect(within(region(SERVICE)).queryByRole('status', { name: 'Starting the event service…' })).toBeNull();
  });

  it("the screen's own reads of the service are read again when the supervisor says it runs", async () => {
    let up = false;
    const down = failed('NOT_FOUND', 'the local event service is not running');
    const inner = createFakeBridge(
      {},
      {
        eventsStatus: () => (up ? running : { owner: 'not-running' }),
        eventsRules: rules,
        eventsDeliveries: deliveries,
      },
    );
    const bridge = createFakeBridge({
      eventServiceState: async () => EVENT_SERVICE.starting,
      cli: async (call) =>
        !up && (call.kind === 'eventsRules' || call.kind === 'eventsDeliveries') ? down : inner.cli(call),
    });
    renderApp(bridge, { screen: 'events' });
    expect(await within(await screen.findByRole('region', { name: 'Status' })).findByText('not running')).toBeTruthy();
    await openTab('Rules');
    await waitFor(() =>
      expect(within(region('Rules')).getByText('the local event service is not running')).toBeTruthy(),
    );
    await openTab('Deliveries');
    await waitFor(() =>
      expect(within(region('Recent deliveries')).getByText('the local event service is not running')).toBeTruthy(),
    );

    up = true;
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.running));
    expect(await screen.findByRole('table', { name: 'Recent deliveries' })).toBeTruthy();
    await openTab('Rules');
    expect(await screen.findByRole('table', { name: 'Rules' })).toBeTruthy();
    await openTab('Service');
    expect(await within(region('Status')).findByText('running')).toBeTruthy();

    // A word that changes nothing of whether it runs reads nothing again.
    const reads = cliKinds(bridge).length;
    await act(async () => bridge.emit('event-service:changed', { ...EVENT_SERVICE.running, restarts: 1 }));
    expect(cliKinds(bridge)).toHaveLength(reads);
  });

  it('switched off, the section says "Stopping the event service…" with a spinner, never Running, until it stops', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.running, {
      setEventService: async (on) => (on ? EVENT_SERVICE.starting : EVENT_SERVICE.stopping),
    });
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    fireEvent.click(within(section).getByRole('switch', { name: SWITCH }));
    expect(await within(region(SERVICE)).findByRole('status', { name: 'Stopping the event service…' })).toBeTruthy();
    expect(within(region(SERVICE)).getByText('Stopping the event service…')).toBeTruthy();
    expect(within(region(SERVICE)).queryByText('Running')).toBeNull();
    const toggle = within(region(SERVICE)).getByRole('switch', { name: SWITCH });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await waitFor(() =>
      expect(within(region(SERVICE)).getByRole('switch', { name: SWITCH }).hasAttribute('data-disabled')).toBe(false),
    );
    // Once the supervisor says it has stopped, the spinner goes.
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.stopped));
    expect(await within(region(SERVICE)).findByText('Stopped')).toBeTruthy();
    expect(within(region(SERVICE)).queryByRole('status', { name: 'Stopping the event service…' })).toBeNull();
  });

  it('Full Disk Access missing shows the line and Open System Settings', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.fullDiskAccessMissing);
    const first = renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByText('Events from WhatsApp need Full Disk Access for Agent Comms.')).toBeTruthy();
    fireEvent.click(within(section).getByRole('button', { name: 'Open System Settings' }));
    await waitFor(() => expect(commands(bridge, 'openFullDiskAccess')).toHaveLength(1));
    first.unmount();
    // Granted, or not needed, it says nothing of it.
    for (const fullDiskAccess of ['granted', 'not-needed'] as const) {
      const view = renderApp(serviceBridge({ ...EVENT_SERVICE.running, fullDiskAccess }), { screen: 'events' });
      const shown = await shownService();
      expect(within(shown).queryByText(/Full Disk Access/), fullDiskAccess).toBeNull();
      expect(within(shown).queryByRole('button', { name: 'Open System Settings' }), fullDiskAccess).toBeNull();
      view.unmount();
    }
  });

  it('on Windows the switch is absent and the line says why', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.windows);
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    expect(within(section).getByText("The event service doesn't run on Windows yet.")).toBeTruthy();
    expect(within(section).queryByRole('switch')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
  });

  it('a state that cannot be read says why, and the rest of the screen is there', async () => {
    const bridge = serviceBridge(EVENT_SERVICE.running, {
      eventServiceState: async () => {
        throw { code: 'APP_NOT_BUILT', message: 'event_service_state is not built yet' };
      },
    });
    const first = renderApp(bridge, { screen: 'events' });
    const section = await screen.findByRole('region', { name: SERVICE });
    expect(await within(section).findByText('event_service_state is not built yet')).toBeTruthy();
    expect(within(section).queryByRole('switch')).toBeNull();
    expect(await screen.findByRole('region', { name: 'Status' })).toBeTruthy();
    first.unmount();
    // A command that fails says why, and the switch stays as the supervisor last said.
    const refusing = serviceBridge(EVENT_SERVICE.running, {
      setEventService: async () => {
        throw { code: 'APP_IO', message: 'the event service could not be stopped' };
      },
    });
    renderApp(refusing, { screen: 'events' });
    const shown = await shownService();
    const toggle = within(shown).getByRole('switch', { name: SWITCH });
    fireEvent.click(toggle);
    expect(await within(shown).findByText('the event service could not be stopped')).toBeTruthy();
    expect(within(shown).getByRole('switch', { name: SWITCH }).getAttribute('aria-checked')).toBe('true');
  });

  it('without the events launcher nothing of the event service is asked', async () => {
    const bridge = createFakeBridge({
      installation: async () => ({ ...EXAMPLE_INSTALLATION, present: ['core', 'gmail'] }),
    });
    renderApp(bridge, { screen: 'events' });
    expect(await screen.findByText("The events service isn't installed.")).toBeTruthy();
    expect(screen.queryByRole('region', { name: SERVICE })).toBeNull();
    expect(bridge.calls.map((call) => call.command)).not.toContain('eventServiceState');
    // Nor are there tabs to hide anything behind.
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('the Service tab counts what waits in it, so it shows from any tab: gave up, a newer version, Full Disk Access', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    const cases: [string, EventServiceState, number][] = [
      ['running', EVENT_SERVICE.running, 0],
      ['gave up', EVENT_SERVICE.gaveUp, 1],
      ['a newer version', EVENT_SERVICE.olderAdopted, 1],
      ['Full Disk Access', EVENT_SERVICE.fullDiskAccessMissing, 1],
      ['gave up, and Full Disk Access', { ...EVENT_SERVICE.gaveUp, fullDiskAccess: 'missing' }, 2],
      // A newer version is offered only to one that runs, as the section offers it; Windows offers nothing.
      ['stopped, with a newer version', { ...EVENT_SERVICE.stopped, newerVersion: '0.27.0' }, 0],
      ['Windows', { ...EVENT_SERVICE.windows, fullDiskAccess: 'missing' }, 0],
      // Wanted and stopped: one started from a terminal went away, and the section offers Start (D4).
      ['wanted and stopped', EVENT_SERVICE.terminalGone, 1],
    ];
    for (const [what, state, count] of cases) {
      const view = renderApp(serviceBridge(state), { screen: 'events' });
      await shownService();
      await openTab('Rules');
      const name = count === 0 ? 'Service' : `Service ${count} to look at`;
      const tab = await screen.findByRole('tab', { name });
      expect(tab, what).toBeTruthy();
      // A caution, said in the shared status vocabulary.
      expect(tab.querySelector('[data-slot="tab-attention"]') !== null, what).toBe(count > 0);
      view.unmount();
    }
    // Until the first-start question is answered, Start is not offered: the question itself is over the screen.
    const asking = renderApp(serviceBridge(EVENT_SERVICE.firstStart), { screen: 'events' });
    expect(await screen.findByRole('alertdialog', { name: 'Start the event service?' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('tab', { hidden: true })).toHaveLength(4));
    expect(screen.getByRole('tab', { name: 'Service', hidden: true })).toBeTruthy();
    asking.unmount();
    // It follows the supervisor: a service that gives up while another tab is open says so on its tab.
    const bridge = serviceBridge(EVENT_SERVICE.running);
    renderApp(bridge, { screen: 'events' });
    await shownService();
    await openTab('Judges');
    expect(screen.getByRole('tab', { name: 'Service' })).toBeTruthy();
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.gaveUp));
    expect(await screen.findByRole('tab', { name: 'Service 1 to look at' })).toBeTruthy();
    await openTab('Service');
    expect(within(region(SERVICE)).getByRole('alert')).toBeTruthy();
  });

  it("the Service tab counts a command's failure, the problem the section says, until the next command clears it", async () => {
    let refuse = true;
    const bridge = serviceBridge(EVENT_SERVICE.running, {
      setEventService: async (on) => {
        if (refuse) throw { code: 'APP_IO', message: 'the event service could not be stopped' };
        return on ? EVENT_SERVICE.running : EVENT_SERVICE.stopped;
      },
    });
    renderApp(bridge, { screen: 'events' });
    const section = await shownService();
    fireEvent.click(within(section).getByRole('switch', { name: SWITCH }));
    expect(await within(region(SERVICE)).findByText('the event service could not be stopped')).toBeTruthy();
    await openTab('Rules');
    expect(await screen.findByRole('tab', { name: 'Service 1 to look at' })).toBeTruthy();
    // The next command clears it, and the tab with it.
    refuse = false;
    await openTab('Service');
    fireEvent.click(within(region(SERVICE)).getByRole('switch', { name: SWITCH }));
    await waitFor(() =>
      expect(within(region(SERVICE)).queryByText('the event service could not be stopped')).toBeNull(),
    );
    expect(await screen.findByRole('tab', { name: 'Service' })).toBeTruthy();
  });

  it("a supervisor's state that cannot be read marks the Service tab with a danger dot", async () => {
    const bridge = serviceBridge(EVENT_SERVICE.running, {
      eventServiceState: async () => {
        throw { code: 'APP_NOT_BUILT', message: 'event_service_state is not built yet' };
      },
    });
    renderApp(bridge, { screen: 'events' });
    expect(
      await within(await screen.findByRole('region', { name: SERVICE })).findByText(
        'event_service_state is not built yet',
      ),
    ).toBeTruthy();
    await openTab('Rules');
    await waitFor(async () => expect(markOf(await findTab('Service'))).toEqual(FAILED_MARK));
  });
});

/*
 * Laya, the events service's local judge (E2 Task 11, desktop design DA16), now the Judges section's Laya row (0.27.1).
 * Its status comes only from the daemon's `judge model status`: the app shows the state, byte progress and stable codes
 * as plain text, offers Turn on in Terminal for `idle` and Turn off (at once, once its dialog is answered) for an
 * enabled kind, and never approves. The fixtures are copies of the events daemon's frozen vectors
 * (`packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json`); the row's Off, On or Unavailable is Laya's
 * entry of `judge kinds list` at the same moment, which each vector names as its `pointer`.
 */

/** The app's copies, each as the bundler reads it: `events-judge-model-status.<vector name>.json`. */
const COPIES: Record<string, unknown> = import.meta.glob('./fixtures/events-judge-model-status.*.json', {
  eager: true,
  import: 'default',
});
const copyName = (path: string): string => path.slice('./fixtures/events-judge-model-status.'.length, -'.json'.length);

interface StatusVector {
  name: string;
  contract: string;
  pointer: string;
  result: Record<string, unknown>;
}

const daemonVectors = (): StatusVector[] => (daemonContract as { statusVectors: StatusVector[] }).statusVectors;

/** The app's copy of one daemon vector's result. */
function copy(name: string): Record<string, unknown> {
  const found = COPIES[`./fixtures/events-judge-model-status.${name}.json`];
  if (found === undefined) throw new Error(`the app has no copy of ${name}`);
  return structuredClone(found) as Record<string, unknown>;
}

/** What each vector must show: its state word, its progress line, and its failure and reason codes. */
const SHOWN: Record<string, { state: string; progress: string | null; failure: string | null; reason: string | null }> =
  {
    disabled: { state: 'idle', progress: '0 of 154 bytes', failure: null, reason: null },
    'approval-pending': { state: 'idle', progress: '0 of 154 bytes', failure: null, reason: null },
    installing: { state: 'installing', progress: '0 of 154 bytes', failure: null, reason: null },
    downloading: { state: 'downloading', progress: '81 of 154 bytes', failure: null, reason: null },
    verifying: { state: 'verifying', progress: '154 of 154 bytes', failure: null, reason: null },
    ready: { state: 'ready', progress: '154 of 154 bytes', failure: null, reason: null },
    'disabled-kept': { state: 'idle', progress: '154 of 154 bytes', failure: null, reason: null },
    removed: { state: 'idle', progress: '0 of 154 bytes', failure: null, reason: null },
    'failed-integrity': { state: 'failed', progress: '154 of 154 bytes', failure: 'integrity', reason: null },
    'failed-download': { state: 'failed', progress: '87 of 154 bytes', failure: 'download-failed', reason: null },
    'failed-runtime': { state: 'failed', progress: '0 of 154 bytes', failure: 'runtime-failed', reason: null },
    'failed-boundary': {
      state: 'failed',
      progress: '154 of 154 bytes',
      failure: 'boundary-failed',
      reason: 'LAYA_SANDBOX_UNAVAILABLE',
    },
    'unavailable-sandbox': {
      state: 'unavailable',
      progress: '0 of 75 bytes',
      failure: null,
      reason: 'LAYA_SANDBOX_UNAVAILABLE',
    },
    'unavailable-linux': {
      state: 'unavailable',
      progress: '0 of 75 bytes',
      failure: null,
      reason: 'LAYA_PLATFORM_UNAVAILABLE',
    },
    'unavailable-windows': {
      state: 'unavailable',
      progress: '0 of 75 bytes',
      failure: null,
      reason: 'LAYA_PLATFORM_UNAVAILABLE',
    },
    'unavailable-placeholder': {
      state: 'unavailable',
      progress: '0 of 1692649436 bytes',
      failure: null,
      reason: 'E2_EXTERNAL_REFERENCE_BLOCKED',
    },
  };

/** The one button each state allows. */
const BUTTON: Record<string, 'Turn on in Terminal' | 'Turn off' | null> = {
  idle: 'Turn on in Terminal',
  installing: 'Turn off',
  downloading: 'Turn off',
  verifying: 'Turn off',
  ready: 'Turn off',
  failed: 'Turn off',
  unavailable: null,
};

const LAYA = 'Laya';

/**
 * Laya's entry of `judge kinds list` beside a status, as the daemon's vectors pair them: unavailable with the status's
 * reason (B3's `E2_REQUIRED` before E2), disabled while it is idle, and enabled otherwise.
 */
function layaKind(status: unknown): Record<string, unknown> {
  const value = (typeof status === 'object' && status !== null ? status : {}) as Record<string, unknown>;
  if (value.code === 'E2_REQUIRED') return { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' };
  if (value.state === 'unavailable') return { kind: 'laya', state: 'unavailable', code: value.reason };
  if (value.state === 'idle') return { kind: 'laya', state: 'disabled', version: null };
  return { kind: 'laya', state: 'enabled', version: 1 };
}

/** `judge kinds list` with Jev and a local model server off, and Laya's entry beside `status`. */
function kindsBeside(status: unknown): Record<string, unknown>[] {
  return [
    { kind: 'typesafe', state: 'disabled', version: null },
    layaKind(status),
    { kind: 'local-endpoint', state: 'disabled', version: null },
  ];
}

/** The Events screen with the events service at `version`, Laya's status `status`, and the rest quiet. */
function layaBridge(
  status: unknown,
  options: {
    version?: string;
    kinds?: unknown;
    results?: Partial<Record<Call['kind'], CliResult | Promise<CliResult>>>;
  } = {},
): FakeBridge {
  return bridgeWith(options.results ?? {}, {
    version: versions(options.version ?? WITH_LAYA),
    eventsRules: [],
    eventsDeliveries: [],
    eventsJudgeModelStatus: status,
    judgeKindsList: options.kinds ?? kindsBeside(status),
    judgesList: [],
  });
}

/**
 * How long a test waits for the Judges section's rows: they come after two reads (the events service's version, then
 * its kinds), and the slowest runner has taken more than Testing Library's one second for that.
 */
const ROWS_MS = 10_000;

async function layaRegion(): Promise<HTMLElement> {
  await openTab('Judges');
  return screen.findByRole('region', { name: LAYA }, { timeout: ROWS_MS });
}

/** The region once its status has been read and shown. */
async function shownLaya(): Promise<HTMLElement> {
  const region = await layaRegion();
  await waitFor(() => expect(within(region).queryByRole('status', { name: COPY.loading })).toBeNull());
  return region;
}

function buttons(region: HTMLElement): string[] {
  return within(region)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');
}

it('E2 desktop Laya contract: the app fixtures are copies of the daemon status vectors', () => {
  const vectors = daemonVectors();
  expect(vectors.length).toBeGreaterThan(10);
  for (const vector of vectors) expect(copy(vector.name), vector.name).toEqual(vector.result);
  const copies = Object.keys(COPIES).map(copyName).sort();
  expect(copies).toEqual(vectors.map((vector) => vector.name).sort());
  // Every vector the screen is checked against below is one of them, and every one of them is checked.
  expect(Object.keys(SHOWN).sort()).toEqual(
    vectors
      .filter((vector) => vector.contract === 'laya-model-status-v1')
      .map((vector) => vector.name)
      .sort(),
  );
  // The kinds entry each test pairs with a status is the one the daemon gave beside it.
  for (const vector of vectors) expect(layaKind(vector.result).state, vector.name).toBe(vector.pointer);
});

it('E2 desktop Laya contract: each state is shown as the daemon sent it, with its byte progress', {
  timeout: RENDER_LOOP_MS,
}, async () => {
  for (const [name, shown] of Object.entries(SHOWN)) {
    const view = renderApp(layaBridge(copy(name)), { screen: 'events' });
    const region = await shownLaya();
    expect(within(region).getByText(shown.state), name).toBeTruthy();
    if (shown.progress !== null) expect(within(region).getByText(shown.progress), name).toBeTruthy();
    // No state, percentage or estimate the daemon did not send.
    for (const other of Object.keys(BUTTON)) {
      if (other !== shown.state) expect(within(region).queryByText(other), `${name}: ${other}`).toBeNull();
    }
    expect(region.textContent, name).not.toMatch(/%/);
    view.unmount();
  }
});

it('E2 desktop Laya contract: every failure code and reason is shown as plain text', {
  timeout: RENDER_LOOP_MS,
}, async () => {
  for (const [name, shown] of Object.entries(SHOWN)) {
    const view = renderApp(layaBridge(copy(name)), { screen: 'events' });
    const region = await shownLaya();
    if (shown.failure !== null) expect(within(region).getByText(shown.failure), name).toBeTruthy();
    if (shown.reason !== null) expect(within(region).getByText(shown.reason), name).toBeTruthy();
    for (const code of ['integrity', 'download-failed', 'runtime-failed', 'boundary-failed']) {
      if (code !== shown.failure) expect(within(region).queryByText(code), `${name}: ${code}`).toBeNull();
    }
    for (const code of ['E2_EXTERNAL_REFERENCE_BLOCKED', 'LAYA_PLATFORM_UNAVAILABLE', 'LAYA_SANDBOX_UNAVAILABLE']) {
      if (code !== shown.reason) expect(within(region).queryByText(code), `${name}: ${code}`).toBeNull();
    }
    // The placeholder lock's reason reads as what it means for a person.
    expect(
      within(region).queryByText("Laya isn't offered in this release.") !== null,
      `${name}: not offered in this release`,
    ).toBe(shown.reason === 'E2_EXTERNAL_REFERENCE_BLOCKED');
    view.unmount();
  }
});

it('E2 desktop Laya contract: Enable shows only for idle and Disable only for an enabled kind', {
  timeout: RENDER_LOOP_MS,
}, async () => {
  for (const [name, shown] of Object.entries(SHOWN)) {
    const view = renderApp(layaBridge(copy(name)), { screen: 'events' });
    const region = await shownLaya();
    const button = BUTTON[shown.state];
    expect(buttons(region), name).toEqual(button === null || button === undefined ? [] : [button]);
    view.unmount();
  }
});

it('E2 desktop Laya contract: an unknown state, field or code is refused, not guessed at', {
  timeout: RENDER_LOOP_MS,
}, async () => {
  const ready = copy('ready');
  for (const [name, value] of [
    ['a path', { ...ready, modelPath: '/example/home/.local/share/agent-communications/events/laya' }],
    ['an unknown field', { ...ready, progress: 0.5 }],
    ['a missing field', Object.fromEntries(Object.entries(ready).filter(([key]) => key !== 'updatedAt'))],
    ['an unknown state', { ...ready, state: 'paused' }],
    ['an unknown failure code', { ...ready, state: 'failed', failureCode: 'disk-full' }],
    ['an unknown reason', { ...ready, state: 'unavailable', reason: 'LAYA_GPU_UNAVAILABLE' }],
    ['a failure without its code', { ...ready, state: 'failed' }],
    ['an unavailable status without its reason', { ...ready, state: 'unavailable' }],
    ['a working state with a reason', { ...ready, reason: 'LAYA_SANDBOX_UNAVAILABLE' }],
    [
      'a reason on an integrity failure',
      { ...ready, state: 'failed', failureCode: 'integrity', reason: 'LAYA_PLATFORM_UNAVAILABLE' },
    ],
    ['bytes as text', { ...ready, bytesVerified: '154' }],
    ['negative bytes', { ...ready, bytesVerified: -1 }],
    ['a list', [ready]],
    ['nothing', null],
  ] as const) {
    const view = renderApp(layaBridge(value), { screen: 'events' });
    const region = await shownLaya();
    expect(within(region).getByText("Laya's status could not be read."), name).toBeTruthy();
    expect(buttons(region), name).toEqual([]);
    expect(region.textContent, name).not.toMatch(/\/example\//);
    view.unmount();
  }
});

it('E2 desktop Laya contract: Enable opens the terminal with the terminal-only shape and approves nothing', async () => {
  const bridge = layaBridge(copy('disabled'));
  renderApp(bridge, { screen: 'events' });
  const region = await shownLaya();
  fireEvent.click(within(region).getByRole('button', { name: 'Turn on in Terminal' }));
  expect(await within(region).findByText('Opened in Terminal.')).toBeTruthy();
  const opened = bridge.calls.filter((call) => call.command === 'openInTerminal').map((call) => call.args);
  expect(opened).toEqual([{ kind: 'eventsJudgeKindEnable' } satisfies TerminalCommand]);
  // The app prepared nothing, revoked nothing and ran no change: the enablement and its approval are the terminal's.
  expect(cliKinds(bridge)).not.toContain('eventsJudgeKindDisable');
  expect(cliKinds(bridge)).not.toContain('approvalRevoke');
  expect(bridge.calls.filter((call) => call.command === 'revokePreview')).toEqual([]);
  // Coming back to the window reads the status again.
  const before = cliKinds(bridge).filter((kind) => kind === 'eventsJudgeModelStatus').length;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() =>
    expect(cliKinds(bridge).filter((kind) => kind === 'eventsJudgeModelStatus').length).toBeGreaterThan(before),
  );
});

/** Turn off, then the dialog's own Turn off: the one way a kind is turned off from the app. */
async function turnOff(region: HTMLElement, name: string): Promise<void> {
  fireEvent.click(within(region).getByRole('button', { name: 'Turn off' }));
  const dialog = await screen.findByRole('alertdialog', { name: `Turn off ${name}?` });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
}

it('E2 desktop Laya contract: Disable applies at once and the status is read again', async () => {
  let state = copy('ready');
  const bridge = bridgeWith(
    {},
    {
      version: versions(WITH_LAYA),
      eventsRules: [],
      eventsDeliveries: [],
      eventsJudgeModelStatus: () => state,
      judgeKindsList: () => kindsBeside(state),
      judgesList: [],
      eventsJudgeKindDisable: () => {
        state = copy('disabled-kept');
        return { kind: 'laya', disabled: true, pointer: 'removed', pendingActivationsCancelled: 0 };
      },
    },
  );
  const first = renderApp(bridge, { screen: 'events' });
  const region = await shownLaya();
  expect(within(region).getByText('ready')).toBeTruthy();
  expect(within(region).getByText('On')).toBeTruthy();
  // Turn off asks first; nothing runs until its dialog's Turn off.
  fireEvent.click(within(region).getByRole('button', { name: 'Turn off' }));
  expect(await screen.findByRole('alertdialog', { name: 'Turn off Laya?' })).toBeTruthy();
  expect(cliKinds(bridge)).not.toContain('eventsJudgeKindDisable');
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
  expect(await within(region).findByText('idle')).toBeTruthy();
  expect(await within(region).findByRole('button', { name: 'Turn on in Terminal' })).toBeTruthy();
  expect(await within(region).findByText('Off')).toBeTruthy();
  const disabled = bridge.calls.filter(
    (call) => call.command === 'cli' && (call.args as Call).kind === 'eventsJudgeKindDisable',
  );
  expect(disabled.map((call) => call.args)).toEqual([{ kind: 'eventsJudgeKindDisable' }]);
  expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([]);
  // Laya is turned off by its own call alone, never by a kind's.
  expect(cliKinds(bridge)).not.toContain('judgeKindDisable');
  first.unmount();
  // A disable the daemon refused says why, as text, and keeps the button.
  const refusing = layaBridge(copy('ready'), {
    results: { eventsJudgeKindDisable: failed('CLI_FAILED', 'the local event service is not running') },
  });
  renderApp(refusing, { screen: 'events' });
  const second = await shownLaya();
  await turnOff(second, 'Laya');
  expect(await within(second).findByText('the local event service is not running')).toBeTruthy();
  expect(within(second).getByRole('button', { name: 'Turn off' })).toBeTruthy();
});

it('E2 desktop Laya contract: an events service older than E2 asks for an update and calls nothing', async () => {
  const older = layaBridge(copy('ready'), { version: BEFORE_LAYA, kinds: kindsBeside(copy('before-e2')) });
  const first = renderApp(older, { screen: 'events' });
  const region = await layaRegion();
  expect(await within(region).findByText(COPY.updateToUse)).toBeTruthy();
  expect(within(region).getByText(`Needs ${WITH_LAYA} or later; this machine has ${BEFORE_LAYA}.`)).toBeTruthy();
  expect(buttons(region)).toEqual([]);
  expect(cliKinds(older)).not.toContain('eventsJudgeModelStatus');
  expect(older.calls.some((call) => call.command === 'cli' && (call.args as Call).kind === 'version')).toBe(true);
  // Its kinds list still names Laya as B3 did before E2: unavailable, with that code as plain text.
  expect(within(region).getByText('Unavailable')).toBeTruthy();
  expect(within(region).getByText('E2_REQUIRED')).toBeTruthy();
  expect(within(region).getByText('Not offered in this release yet.')).toBeTruthy();
  first.unmount();
  // A pre-release of E2's own version has it; and a daemon that still answers B3's E2_REQUIRED placeholder is one
  // from before E2 whatever it says its version is: it asks for an update too, with no button.
  const placeholder = layaBridge(copy('before-e2'), { version: `${WITH_LAYA}-feat-e2` });
  renderApp(placeholder, { screen: 'events' });
  const shown = await shownLaya();
  expect(within(shown).getByText(COPY.updateToUse)).toBeTruthy();
  expect(buttons(shown)).toEqual([]);
  expect(cliKinds(placeholder)).toContain('eventsJudgeModelStatus');
});

it('E2 desktop Laya contract: a download in progress follows the screen poll, and only the latest-started read is kept', async () => {
  vi.useFakeTimers();
  try {
    let answers: ((result: CliResult) => void)[] = [];
    const bridge = createFakeBridge(
      {
        cli: (call) => {
          if (call.kind === 'version')
            return Promise.resolve({ status: 'version', version: versions(WITH_LAYA)(call) });
          if (call.kind === 'eventsJudgeModelStatus') {
            return new Promise<CliResult>((resolve) => {
              answers.push(resolve);
            });
          }
          return inner.cli(call);
        },
      },
      {},
    );
    const inner = createFakeBridge({}, { eventsRules: [], eventsDeliveries: [] });
    renderApp(bridge, { screen: 'events' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const reads = () => cliKinds(bridge).filter((kind) => kind === 'eventsJudgeModelStatus').length;
    expect(reads()).toBe(1);
    await act(async () => {
      answers.shift()?.(ok(copy('downloading')));
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole('tab', { name: /^Judges\b/ }));
    const region = screen.getByRole('region', { name: LAYA });
    expect(within(region).getByText('81 of 154 bytes')).toBeTruthy();
    // The screen's next poll reads it again, while the download goes on.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(reads()).toBe(2);
    const slow = answers.shift();
    // A later read, started on focus, answers first; the slow poll's answer, when it comes, is not put back.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads()).toBeGreaterThanOrEqual(3);
    await act(async () => {
      for (const answer of answers.splice(0)) answer(ok(copy('ready')));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(region).getByText('ready')).toBeTruthy();
    await act(async () => {
      slow?.(ok(copy('downloading')));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(region).getByText('ready')).toBeTruthy();
    expect(within(region).queryByText('downloading')).toBeNull();
    // Ready is not in progress: the next polls do not read it again.
    const settled = reads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(reads()).toBe(settled);
    answers = [];
  } finally {
    vi.useRealTimers();
  }
});

/*
 * The Judges section (0.27.1): every judge kind the events service has, read from its `judge kinds list` and `judges
 * list`, each with its name, where messages go and its state. A kind that is off turns on in the terminal, where the
 * events service's preview and the person's approval happen; one that is on turns off at once, once its dialog is
 * answered. Every answer here is one the real owner gave through the events CLI
 * (`packages/events-daemon/test/fixtures/judges/desktop-contract-judges-v1.json`).
 */
describe('Judges', () => {
  interface JudgesVector {
    name: string;
    kinds: Record<string, unknown>[];
    judges: Record<string, unknown>[];
  }

  const JEV = 'Jev, by TypeSafe';
  const LOCAL = 'A local model server';
  const NEXT = 'Next: add a judge and its key at the terminal.';
  const NEXT_LOCAL = 'Next: add a judge at the terminal.';
  const HOW = 'How to set it up';
  const README =
    'https://github.com/crissmoldovan/agent-communications/blob/main/packages/events-daemon/README.md#judges';

  /** One of the daemon's vectors, as its own copy. */
  function at(name: string): JudgesVector {
    const found = (judgesContract as { vectors: JudgesVector[] }).vectors.find((vector) => vector.name === name);
    if (found === undefined) throw new Error(`the daemon's judges contract has no vector ${name}`);
    return structuredClone(found);
  }

  /** The Events screen with the events service at `version`, its kinds and judges as `vector` has them. */
  function judgesBridge(
    vector: JudgesVector | (() => JudgesVector),
    options: {
      version?: string;
      results?: Partial<Record<Call['kind'], CliResult | Promise<CliResult>>>;
      fixtures?: Partial<Record<Call['kind'], Fixture>>;
    } = {},
  ): FakeBridge {
    const current = typeof vector === 'function' ? vector : () => vector;
    return bridgeWith(options.results ?? {}, {
      version: versions(options.version ?? '0.27.0'),
      eventsRules: [],
      eventsDeliveries: [],
      eventsJudgeModelStatus: copy('unavailable-placeholder'),
      judgeKindsList: () => current().kinds,
      judgesList: () => current().judges,
      ...options.fixtures,
    });
  }

  /** The section once its kinds are shown. */
  async function shownJudges(): Promise<HTMLElement> {
    await openTab('Judges');
    const section = await screen.findByRole('region', { name: 'Judges' }, { timeout: ROWS_MS });
    await waitFor(() => expect(within(section).getByRole('region', { name: JEV })).toBeTruthy(), {
      timeout: ROWS_MS,
    });
    return section;
  }

  /** Each row's name, in the order the section shows them. */
  function rowNames(section: HTMLElement): string[] {
    return within(section)
      .getAllByRole('region')
      .map((row) => document.getElementById(row.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
  }

  const row = (section: HTMLElement, name: string) => within(section).getByRole('region', { name });

  const commands = (bridge: FakeBridge, command: keyof Bridge) =>
    bridge.calls.filter((call) => call.command === command).map((call) => call.args);

  it('Judges: the three kinds are listed, each with its name, where messages go and its state', async () => {
    const bridge = judgesBridge(at('fresh'));
    renderApp(bridge, { screen: 'events' });
    const section = await shownJudges();
    expect(rowNames(section)).toEqual([JEV, 'Laya', LOCAL]);
    const jev = row(section, JEV);
    expect(
      within(jev).getByText(
        'A hosted judge. The fields a rule names are sent to TypeSafe, with your TypeSafe API key.',
      ),
    ).toBeTruthy();
    expect(within(jev).getByText('Off')).toBeTruthy();
    expect(buttons(jev)).toEqual(['Turn on in Terminal']);
    const laya = row(section, 'Laya');
    expect(within(laya).getByText('A judge that runs on this Mac. Nothing leaves it.')).toBeTruthy();
    expect(within(laya).getByText('Unavailable')).toBeTruthy();
    expect(within(laya).getByText('E2_EXTERNAL_REFERENCE_BLOCKED')).toBeTruthy();
    // Laya's own details are still there, as Task 11 shows them, and they say it is not offered: the row does not say
    // it again.
    await waitFor(() => expect(within(laya).getByText('unavailable')).toBeTruthy());
    expect(within(laya).getByText("Laya isn't offered in this release.")).toBeTruthy();
    expect(within(laya).getByText('0 of 1692649436 bytes')).toBeTruthy();
    expect(within(laya).queryByText('Not offered in this release yet.')).toBeNull();
    expect(buttons(laya)).toEqual([]);
    const local = row(section, LOCAL);
    expect(
      within(local).getByText(
        'A model server you run on this machine, at 127.0.0.1 or ::1. Nothing leaves this machine.',
      ),
    ).toBeTruthy();
    expect(within(local).getByText('Off')).toBeTruthy();
    expect(buttons(local)).toEqual(['Turn on in Terminal']);
    // Read-only: reading the section ran no change.
    expect(cliKinds(bridge)).toEqual(expect.arrayContaining(['judgeKindsList', 'judgesList']));
    expect(cliKinds(bridge)).not.toContain('judgeKindDisable');
    expect(commands(bridge, 'openInTerminal')).toEqual([]);
  });

  it('Judges: an enabled kind says On, and offers Turn off', async () => {
    renderApp(judgesBridge(at('both-on-with-local')), { screen: 'events' });
    const section = await shownJudges();
    for (const name of [JEV, LOCAL]) {
      expect(within(row(section, name)).getByText('On'), name).toBeTruthy();
      expect(buttons(row(section, name)), name).toEqual(['Turn off']);
    }
  });

  it('Judges: Off, then Turn on in Terminal, opens the terminal with judge kind enable and approves nothing', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    for (const [name, judgeKind] of [
      [JEV, 'typesafe'],
      [LOCAL, 'local-endpoint'],
    ] as const) {
      const bridge = judgesBridge(at('fresh'));
      const view = renderApp(bridge, { screen: 'events' });
      const kind = row(await shownJudges(), name);
      fireEvent.click(within(kind).getByRole('button', { name: 'Turn on in Terminal' }));
      expect(await within(kind).findByText('Opened in Terminal.'), name).toBeTruthy();
      expect(within(kind).getByText('Its preview and its approval are in the terminal.'), name).toBeTruthy();
      expect(commands(bridge, 'openInTerminal'), name).toEqual([
        { kind: 'judgeKindEnable', judgeKind } satisfies TerminalCommand,
      ]);
      // The app prepared nothing, revoked nothing and ran no change: the enablement and its approval are the terminal's.
      expect(cliKinds(bridge), name).not.toContain('judgeKindDisable');
      expect(cliKinds(bridge), name).not.toContain('approvalRevoke');
      expect(commands(bridge, 'revokePreview'), name).toEqual([]);
      // Coming back to the window reads the kinds again: the person may have approved it there.
      const before = cliKinds(bridge).filter((each) => each === 'judgeKindsList').length;
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
      });
      await waitFor(() =>
        expect(cliKinds(bridge).filter((each) => each === 'judgeKindsList').length).toBeGreaterThan(before),
      );
      view.unmount();
    }
  });

  it('Judges: On, then Turn off, asks first; only its Turn off runs the disable, and Cancel runs nothing', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    // The daemon's own steps: both on, then Jev off, then the local model server off.
    let vector = at('local-removed');
    const bridge = judgesBridge(() => vector, {
      fixtures: {
        judgeKindDisable: (call: Call) => {
          const { judgeKind } = call as Extract<Call, { kind: 'judgeKindDisable' }>;
          vector = at(judgeKind === 'typesafe' ? 'typesafe-off' : 'all-off');
          return (judgesContract as { disable: Record<string, unknown> }).disable[judgeKind];
        },
      },
    });
    renderApp(bridge, { screen: 'events' });
    const section = await shownJudges();
    const disables = () => commands(bridge, 'cli').filter((call) => (call as Call).kind === 'judgeKindDisable');

    // Cancel: the dialog goes, and nothing runs.
    fireEvent.click(within(row(section, JEV)).getByRole('button', { name: 'Turn off' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Turn off Jev, by TypeSafe?' });
    expect(
      within(dialog).getByText(
        "Decisions waiting on its judges are cancelled, and its rules can't call it until it is turned on again.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Cancel', 'Turn off']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(disables()).toEqual([]);
    expect(within(row(section, JEV)).getByText('On')).toBeTruthy();

    // Turn off: that kind's disable, once, then the kinds are read again.
    await turnOff(row(section, JEV), JEV);
    expect(await within(row(section, JEV)).findByText('Off')).toBeTruthy();
    expect(disables()).toEqual([{ kind: 'judgeKindDisable', judgeKind: 'typesafe' }]);
    expect(within(row(section, LOCAL)).getByText('On')).toBeTruthy();
    await turnOff(row(section, LOCAL), LOCAL);
    expect(await within(row(section, LOCAL)).findByText('Off')).toBeTruthy();
    expect(disables()).toEqual([
      { kind: 'judgeKindDisable', judgeKind: 'typesafe' },
      { kind: 'judgeKindDisable', judgeKind: 'local-endpoint' },
    ]);
    // Turning off is the app's own tightening: nothing opened a terminal, and Laya's call never ran.
    expect(commands(bridge, 'openInTerminal')).toEqual([]);
    expect(cliKinds(bridge)).not.toContain('eventsJudgeKindDisable');
  });

  it('Judges: a turn-off the events service refused says why, as text, and keeps the button', async () => {
    const bridge = judgesBridge(at('both-on'), {
      results: { judgeKindDisable: failed('CLI_FAILED', 'the local event service is not running') },
    });
    renderApp(bridge, { screen: 'events' });
    const jev = row(await shownJudges(), JEV);
    await turnOff(jev, JEV);
    expect(await within(jev).findByText('the local event service is not running')).toBeTruthy();
    expect(within(jev).getByText('On')).toBeTruthy();
    expect(buttons(jev)).toEqual(['Turn off']);
  });

  it('Judges: a kind on with no judge says what is next, with a link to how to set it up, and only then', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    // [vector, the rows that say what is next]
    for (const [name, next] of [
      ['fresh', []],
      ['typesafe-on', [JEV]],
      ['typesafe-on-with-jev', []],
      ['both-on', [LOCAL]],
      ['both-on-with-local', []],
      // A removed judge is no judge: its kind needs one again.
      ['local-removed', [LOCAL]],
      ['typesafe-off', [LOCAL]],
      ['all-off', []],
    ] as const) {
      const view = renderApp(judgesBridge(at(name)), { screen: 'events' });
      const section = await shownJudges();
      for (const kind of [JEV, 'Laya', LOCAL]) {
        const shown = (next as readonly string[]).includes(kind);
        const words = kind === LOCAL ? NEXT_LOCAL : NEXT;
        expect(within(row(section, kind)).queryByText(words) !== null, `${name}: ${kind}`).toBe(shown);
        expect(within(row(section, kind)).queryByRole('link', { name: HOW }) !== null, `${name}: ${kind}`).toBe(shown);
      }
      view.unmount();
    }
    // The link opens the events service's README at its Judges section, through the allow-listed open_link.
    const bridge = judgesBridge(at('typesafe-on'));
    renderApp(bridge, { screen: 'events' });
    const jev = row(await shownJudges(), JEV);
    fireEvent.click(within(jev).getByRole('link', { name: HOW }));
    await waitFor(() => expect(commands(bridge, 'openLink')).toEqual([README]));
    expect(JUDGES_HELP).toBe(README);
    // Rust opens exactly that one fixed URL (`links.rs`, `JUDGES_HELP`).
    expect(links).toContain(`pub const JUDGES_HELP: &str =\n    "${README}";`);
  });

  it('Judges: each judge shows under its kind, with its id, version and model; a removed one does not', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    const first = renderApp(judgesBridge(at('both-on-with-local')), { screen: 'events' });
    let section = await shownJudges();
    const jevJudges = within(row(section, JEV)).getByRole('table', { name: `${JEV} judges` });
    expect(
      within(jevJudges)
        .getAllByRole('row')
        .map((each) => [...each.children].map((cell) => cell.textContent)),
    ).toEqual([
      ['Judge', 'Version', 'Model'],
      ['jev', '1', 'jev-1.13.0'],
    ]);
    const localJudges = within(row(section, LOCAL)).getByRole('table', { name: `${LOCAL} judges` });
    expect(within(localJudges).getByText('local')).toBeTruthy();
    expect(within(localJudges).getByText('example-model')).toBeTruthy();
    expect(within(row(section, 'Laya')).queryByRole('table')).toBeNull();
    first.unmount();
    renderApp(judgesBridge(at('local-removed')), { screen: 'events' });
    section = await shownJudges();
    expect(within(row(section, LOCAL)).queryByRole('table')).toBeNull();
    expect(within(row(section, LOCAL)).queryByText('example-model')).toBeNull();
    expect(within(row(section, JEV)).getByRole('table', { name: `${JEV} judges` })).toBeTruthy();
  });

  it('Judges: an events service older than judges says it needs a newer one, and reads nothing', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    const bridge = judgesBridge(at('both-on'), { version: '0.16.0' });
    const older = renderApp(bridge, { screen: 'events' });
    await openTab('Judges');
    const section = await screen.findByRole('region', { name: 'Judges' });
    expect(await within(section).findByText(COPY.updateToUse)).toBeTruthy();
    expect(within(section).getByText('Needs 0.17.0 or later; this machine has 0.16.0.')).toBeTruthy();
    expect(within(section).queryAllByRole('button')).toEqual([]);
    expect(within(section).queryAllByRole('region')).toEqual([]);
    for (const kind of ['judgeKindsList', 'judgesList', 'eventsJudgeModelStatus'] as const) {
      expect(cliKinds(bridge)).not.toContain(kind);
    }
    older.unmount();
    // 0.17.0 is the first with judges, and a pre-release of it has them.
    for (const version of ['0.17.0', '0.17.0-feat-judges', '0.24.0']) {
      const newer = judgesBridge(at('both-on'), { version });
      const view = renderApp(newer, { screen: 'events' });
      expect(within(await shownJudges()).getAllByText('On'), version).toHaveLength(2);
      view.unmount();
    }
  });

  it('Judges: an answer in a shape the app does not know is refused, not guessed at, and hostile text stays text', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    const fresh = at('fresh');
    // The whole list unreadable: the section says so, and offers nothing.
    for (const kinds of [{ kinds: [] }, null, 'typesafe']) {
      const view = renderApp(judgesBridge({ ...fresh, kinds: kinds as never }), { screen: 'events' });
      await openTab('Judges');
      const section = await screen.findByRole('region', { name: 'Judges' });
      expect(await within(section).findByText('The judge kinds could not be read.')).toBeTruthy();
      expect(within(section).queryAllByRole('button')).toEqual([]);
      view.unmount();
    }
    // One entry unreadable: only its row says so, with no button.
    const jev = fresh.kinds[0] as Record<string, unknown>;
    for (const [what, entry] of [
      ['an unknown state', { ...jev, state: 'paused' }],
      ['an unknown field', { ...jev, extra: true }],
      ['a missing version', { kind: 'typesafe', state: 'enabled' }],
      ['on without a version', { ...jev, state: 'enabled', version: null }],
      ['off with a version', { ...jev, version: 2 }],
      ['a code it may not have', { kind: 'typesafe', state: 'unavailable', code: 'E2_REQUIRED' }],
      ['a version as text', { ...jev, state: 'enabled', version: '1' }],
    ] as const) {
      const kinds = [entry, ...fresh.kinds.slice(1)];
      const view = renderApp(judgesBridge({ ...fresh, kinds }), { screen: 'events' });
      const section = await shownJudges();
      expect(within(row(section, JEV)).getByText('Its state could not be read.'), what).toBeTruthy();
      expect(buttons(row(section, JEV)), what).toEqual([]);
      expect(buttons(row(section, LOCAL)), what).toEqual(['Turn on in Terminal']);
      view.unmount();
    }
    // A kind named twice, or not at all, is not read either.
    for (const kinds of [[...fresh.kinds, fresh.kinds[0]], fresh.kinds.slice(1)]) {
      const view = renderApp(judgesBridge({ ...fresh, kinds: kinds as Record<string, unknown>[] }), {
        screen: 'events',
      });
      const section = await shownJudges();
      expect(within(row(section, JEV)).getByText('Its state could not be read.')).toBeTruthy();
      view.unmount();
    }
    // An unknown Laya code is refused too.
    const strangeLaya = [fresh.kinds[0], { kind: 'laya', state: 'unavailable', code: 'LAYA_GPU_UNAVAILABLE' }];
    const strange = renderApp(judgesBridge({ ...fresh, kinds: [...strangeLaya, fresh.kinds[2]] as never }), {
      screen: 'events',
    });
    expect(within(row(await shownJudges(), 'Laya')).getByText('Its state could not be read.')).toBeTruthy();
    strange.unmount();
    // A judges list the app cannot read says so, and claims nothing about what is next.
    const on = at('typesafe-on');
    for (const judges of [
      { judges: [] },
      [{ judgeId: 'jev', version: 1, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0' }],
      [{ judgeId: 'jev', version: 0, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0', revokedAt: null }],
      [{ judgeId: '', version: 1, kind: 'typesafe', provider: 'typesafe', model: 'jev-1.13.0', revokedAt: null }],
      [{ judgeId: 'x', version: 1, kind: 'other', provider: 'x', model: 'x', revokedAt: null }],
      [{ judgeId: 'x', version: 1, kind: 'typesafe', provider: 'x', model: 'x', revokedAt: null, endpoint: 'x' }],
    ]) {
      const view = renderApp(judgesBridge({ ...on, judges: judges as never }), { screen: 'events' });
      const section = await shownJudges();
      expect(await within(section).findByText('The judges could not be read.')).toBeTruthy();
      expect(within(section).queryByText(NEXT)).toBeNull();
      expect(within(section).queryByText(NEXT_LOCAL)).toBeNull();
      view.unmount();
    }
    // A judge's id and model are the person's own words: shown as text, never as markup.
    const hostile = '<img src=x onerror=alert(1)>';
    renderApp(
      judgesBridge({
        ...on,
        judges: [
          {
            judgeId: hostile,
            version: 1,
            kind: 'typesafe',
            provider: 'typesafe',
            model: '</untrusted-content>',
            revokedAt: null,
          },
        ],
      }),
      { screen: 'events' },
    );
    const section = await shownJudges();
    const table = within(row(section, JEV)).getByRole('table');
    expect(within(table).getByText(hostile)).toBeTruthy();
    expect(within(table).getByText('</untrusted-content>')).toBeTruthy();
    expect(section.querySelector('img')).toBeNull();
  });

  it('Judges: a read that failed says why, as text, and the rest of the screen is there', async () => {
    renderApp(
      judgesBridge(at('fresh'), { results: { judgeKindsList: failed('CLI_FAILED', 'the kinds could not be listed') } }),
      { screen: 'events' },
    );
    await openTab('Judges');
    const section = await screen.findByRole('region', { name: 'Judges' });
    expect(await within(section).findByText('the kinds could not be listed')).toBeTruthy();
    await openTab('Rules');
    expect(await screen.findByRole('region', { name: 'Rules' })).toBeTruthy();
  });

  it('Judges: the tab counts the kinds on with no judge, the rows that say what is next, and claims nothing unread', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    for (const [name, count] of [
      ['fresh', 0],
      ['typesafe-on', 1],
      ['typesafe-on-with-jev', 0],
      ['both-on', 1],
      ['both-on-with-local', 0],
      ['local-removed', 1],
      ['typesafe-off', 1],
      ['all-off', 0],
    ] as const) {
      const view = renderApp(judgesBridge(at(name)), { screen: 'events' });
      const tab = count === 0 ? 'Judges' : `Judges ${count} to look at`;
      expect(await screen.findByRole('tab', { name: tab }, { timeout: ROWS_MS }), name).toBeTruthy();
      const section = await shownJudges();
      await waitFor(() => expect(within(section).queryAllByText(/^Next: /), name).toHaveLength(count));
      expect(screen.getByRole('tab', { name: tab }), name).toBeTruthy();
      view.unmount();
    }
    // An events service older than judges, or a judges list the app cannot read: the rows claim nothing, nor does the tab.
    for (const [what, bridge] of [
      ['older', judgesBridge(at('typesafe-on'), { version: '0.16.0' })],
      ['unreadable', judgesBridge({ ...at('typesafe-on'), judges: { judges: [] } as never })],
    ] as const) {
      const view = renderApp(bridge, { screen: 'events' });
      await openTab('Judges');
      const section = await screen.findByRole('region', { name: 'Judges' });
      await within(section).findByText(what === 'older' ? COPY.updateToUse : 'The judges could not be read.');
      expect((await findTab('Judges')).textContent, what).toMatch(/^Judges(?!\s*\d)/);
      view.unmount();
    }
  });

  it('Judges: a read that failed or cannot be read marks the tab with a danger dot; an older events service, with a warn dot', {
    timeout: RENDER_LOOP_MS,
  }, async () => {
    const fresh = at('fresh');
    const jev = fresh.kinds[0] as Record<string, unknown>;
    const cases: [string, FakeBridge, string, { tone: string; says: string } | null][] = [
      ['every read as it should be', judgesBridge(fresh), 'Jev, by TypeSafe', null],
      [
        'its version',
        judgesBridge(fresh, { results: { version: failed('CLI_FAILED', 'the version could not be read') } }),
        'the version could not be read',
        FAILED_MARK,
      ],
      [
        'its kinds',
        judgesBridge(fresh, { results: { judgeKindsList: failed('CLI_FAILED', 'the kinds could not be listed') } }),
        'the kinds could not be listed',
        FAILED_MARK,
      ],
      [
        'its kinds, not a list',
        judgesBridge({ ...fresh, kinds: { kinds: [] } as never }),
        'The judge kinds could not be read.',
        FAILED_MARK,
      ],
      [
        'one kind',
        judgesBridge({ ...fresh, kinds: [{ ...jev, state: 'paused' }, ...fresh.kinds.slice(1)] }),
        'Its state could not be read.',
        FAILED_MARK,
      ],
      [
        'its judges',
        judgesBridge(fresh, { results: { judgesList: failed('CLI_FAILED', 'the judges could not be listed') } }),
        'the judges could not be listed',
        FAILED_MARK,
      ],
      [
        'its judges, not a list',
        judgesBridge({ ...fresh, judges: { judges: [] } as never }),
        'The judges could not be read.',
        FAILED_MARK,
      ],
      [
        "Laya's status",
        judgesBridge(fresh, {
          results: { eventsJudgeModelStatus: failed('CLI_FAILED', 'the model status could not be read') },
        }),
        'the model status could not be read',
        FAILED_MARK,
      ],
      [
        "Laya's status, in a shape the app does not know",
        judgesBridge(fresh, { fixtures: { eventsJudgeModelStatus: { state: 'paused' } } }),
        "Laya's status could not be read.",
        FAILED_MARK,
      ],
      [
        'an events service older than judges',
        judgesBridge(fresh, { version: '0.16.0' }),
        COPY.updateToUse,
        UPDATE_MARK,
      ],
    ];
    for (const [what, bridge, says, mark] of cases) {
      const view = renderApp(bridge, { screen: 'events' });
      // Marked before the tab is opened, so nothing waits unseen behind it.
      await waitFor(async () => expect(markOf(await findTab('Judges')), what).toEqual(mark), { timeout: ROWS_MS });
      await openTab('Judges');
      expect(await within(region('Judges')).findByText(says, {}, { timeout: ROWS_MS }), what).toBeTruthy();
      expect(markOf(await findTab('Judges')), what).toEqual(mark);
      view.unmount();
    }
  });
});
