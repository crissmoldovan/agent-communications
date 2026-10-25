import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import daemonContract from '../../../../packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json';
import { COPY } from '../copy.ts';
import { POLL_MS } from '../data.tsx';
import type { Bridge, Call, CliResult, EventServiceState, TerminalCommand } from '../ipc.ts';
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
    expect(within(main).getAllByRole('status', { name: COPY.loading })).toHaveLength(4);
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

    const ruleTable = await screen.findByRole('table', { name: 'Rules' });
    const ruleRows = within(ruleTable).getAllByRole('row');
    expect(ruleRows).toHaveLength(1 + rules.length);
    expect(within(ruleTable).getAllByText('rule_example')).toHaveLength(2);
    expect(within(ruleTable).getByText('active')).toBeTruthy();
    expect(within(ruleTable).getByText('superseded')).toBeTruthy();
    expect(within(ruleTable).getByText('ap_1A2B3C4D5E6F7G8H9J0K1M2N3P')).toBeTruthy();

    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getAllByRole('row')).toHaveLength(1 + deliveries.length);
    expect(within(deliveryTable).getByText('dlv_example_1')).toBeTruthy();
    expect(within(deliveryTable).getByText('retryable')).toBeTruthy();
    expect(deliveryTable.querySelector(`time[datetime="${new Date(1760950800000).toISOString()}"]`)).not.toBeNull();

    // Pause runs `eventsPause`, the status is read again, and Resume runs `eventsResume`.
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
    expect(await screen.findByText('No rules yet.')).toBeTruthy();
    expect(await screen.findByText('No deliveries yet.')).toBeTruthy();
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
    expect(await screen.findByText('The list could not be read.')).toBeTruthy();
    const deliveryTable = await screen.findByRole('table', { name: 'Recent deliveries' });
    expect(within(deliveryTable).getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(deliveryTable).getByText('</untrusted-content>')).toBeTruthy();
    expect(deliveryTable.querySelector('img')).toBeNull();
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
    await waitFor(() =>
      expect(within(region('Rules')).getByText('the local event service is not running')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(within(region('Recent deliveries')).getByText('the local event service is not running')).toBeTruthy(),
    );

    up = true;
    await act(async () => bridge.emit('event-service:changed', EVENT_SERVICE.running));
    expect(await within(region('Status')).findByText('running')).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Rules' })).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Recent deliveries' })).toBeTruthy();

    // A word that changes nothing of whether it runs reads nothing again.
    const reads = cliKinds(bridge).length;
    await act(async () => bridge.emit('event-service:changed', { ...EVENT_SERVICE.running, restarts: 1 }));
    expect(cliKinds(bridge)).toHaveLength(reads);
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
  });
});

/*
 * Laya, the events service's local judge (E2 Task 11, desktop design DA16). Its status comes only from the daemon's
 * `judge model status`: the app shows the state, byte progress and stable codes as plain text, offers Enable (in the
 * terminal) for `idle` and Disable (at once) for an enabled kind, and never approves. The fixtures are copies of the
 * events daemon's frozen vectors (`packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json`).
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
const BUTTON: Record<string, 'Enable in Terminal' | 'Disable' | null> = {
  idle: 'Enable in Terminal',
  installing: 'Disable',
  downloading: 'Disable',
  verifying: 'Disable',
  ready: 'Disable',
  failed: 'Disable',
  unavailable: null,
};

const LAYA = 'Laya judge';

/** The Events screen with the events service at `version`, Laya's status `status`, and the rest quiet. */
function layaBridge(
  status: unknown,
  options: { version?: string; results?: Partial<Record<Call['kind'], CliResult | Promise<CliResult>>> } = {},
): FakeBridge {
  return bridgeWith(options.results ?? {}, {
    version: versions(options.version ?? WITH_LAYA),
    eventsRules: [],
    eventsDeliveries: [],
    eventsJudgeModelStatus: status,
  });
}

async function layaRegion(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: LAYA });
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
  fireEvent.click(within(region).getByRole('button', { name: 'Enable in Terminal' }));
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

it('E2 desktop Laya contract: Disable applies at once and the status is read again', async () => {
  let state = copy('ready');
  const bridge = bridgeWith(
    {},
    {
      version: versions(WITH_LAYA),
      eventsRules: [],
      eventsDeliveries: [],
      eventsJudgeModelStatus: () => state,
      eventsJudgeKindDisable: () => {
        state = copy('disabled-kept');
        return { kind: 'laya', disabled: true, pointer: 'removed', pendingActivationsCancelled: 0 };
      },
    },
  );
  const first = renderApp(bridge, { screen: 'events' });
  const region = await shownLaya();
  expect(within(region).getByText('ready')).toBeTruthy();
  fireEvent.click(within(region).getByRole('button', { name: 'Disable' }));
  expect(await within(region).findByText('idle')).toBeTruthy();
  expect(await within(region).findByRole('button', { name: 'Enable in Terminal' })).toBeTruthy();
  const disabled = bridge.calls.filter(
    (call) => call.command === 'cli' && (call.args as Call).kind === 'eventsJudgeKindDisable',
  );
  expect(disabled.map((call) => call.args)).toEqual([{ kind: 'eventsJudgeKindDisable' }]);
  expect(bridge.calls.filter((call) => call.command === 'openInTerminal')).toEqual([]);
  first.unmount();
  // A disable the daemon refused says why, as text, and keeps the button.
  const refusing = layaBridge(copy('ready'), {
    results: { eventsJudgeKindDisable: failed('CLI_FAILED', 'the local event service is not running') },
  });
  renderApp(refusing, { screen: 'events' });
  const second = await shownLaya();
  fireEvent.click(within(second).getByRole('button', { name: 'Disable' }));
  expect(await within(second).findByText('the local event service is not running')).toBeTruthy();
  expect(within(second).getByRole('button', { name: 'Disable' })).toBeTruthy();
});

it('E2 desktop Laya contract: an events service older than E2 asks for an update and calls nothing', async () => {
  const older = layaBridge(copy('ready'), { version: BEFORE_LAYA });
  const first = renderApp(older, { screen: 'events' });
  const region = await layaRegion();
  expect(await within(region).findByText(COPY.updateToUse)).toBeTruthy();
  expect(within(region).getByText(`Needs ${WITH_LAYA} or later; this machine has ${BEFORE_LAYA}.`)).toBeTruthy();
  expect(buttons(region)).toEqual([]);
  expect(cliKinds(older)).not.toContain('eventsJudgeModelStatus');
  expect(older.calls.some((call) => call.command === 'cli' && (call.args as Call).kind === 'version')).toBe(true);
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
