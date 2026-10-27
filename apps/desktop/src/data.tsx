import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBridge } from './bridge-context.tsx';
import { type ApprovalView, type DoctorProduct, type DoctorView, doctorView, type UpdateStatus } from './cli-types.ts';
import { supports } from './gates.ts';
import { loadableOf } from './hooks/use-call.ts';
import { usePoll } from './hooks/use-poll.ts';
import {
  type Bridge,
  type Call,
  type DeepLinkTarget,
  type EventServiceState,
  type EventServiceStatus,
  errorMessage,
  type Installation,
  type Product,
} from './ipc.ts';
import type { JoinedMessage } from './messages/join.ts';
import { readNotTaken } from './messages/takes.ts';
import { type QueueCounts, readQueueCounts } from './queue.ts';

/** Something a screen waits for: loading, there, or what went wrong. */
export type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

/** What the screens share, read once here rather than by each (DA14). */
export interface AppData {
  installation: Loadable<Installation>;
  approvals: Loadable<ApprovalView[]>;
  /** `unsupported` when the CLI is older than 0.24.0, and nothing was asked. */
  updateStatus: Loadable<UpdateStatus> | 'unsupported';
  /** `absent` when the events service has no launcher here, and nothing was asked. */
  events: Loadable<unknown> | 'absent';
  doctors: Partial<Record<DoctorProduct, Loadable<DoctorView>>>;
  /**
   * The event service as the app runs it, from its supervisor (D2): read once its launcher is here, then kept current
   * by `event-service:changed`. `absent` when there is no launcher, and nothing was asked.
   */
  eventService: Loadable<EventServiceState> | 'absent';
  /** Shows a state the supervisor answered a command with, over any read that started before it. */
  showEventService(state: EventServiceState): void;
  /**
   * Why the last command the window sent the supervisor failed, or null: the Events screen's service section says it,
   * since the first-start question it may come from has closed by then.
   */
  eventServiceProblem: string | null;
  showEventServiceProblem(problem: string | null): void;
  /**
   * How many times the supervisor has said the service started or stopped running. Each time, the reads that show
   * whether it runs are read again, here and on the screens (`useReloadOnServiceTurn`), so none goes on saying "not
   * running" once it is up.
   */
  eventServiceTurns: number;
  /** The approval an `agentcomms://` link asked for, until the screen that showed it clears it. */
  deepLink: DeepLinkTarget | null;
  /**
   * The events service's own version (its `--version`), which gates the queue (DA12): read once its launcher is here,
   * and again each time the supervisor says it started or stopped running. `absent` when there is no launcher.
   */
  eventsVersion: Loadable<string> | 'absent';
  /**
   * `queue counts` (0.30.0): the open count the sidebar and Overview show, and the Queue screen's tabs. Read with the
   * other shared reads once the events service is 0.30.0 or later; `unsupported` before it, and nothing is asked;
   * `absent` when there is no launcher.
   */
  queueCounts: Loadable<QueueCounts> | 'unsupported' | 'absent';
  /**
   * The messages nobody took in time (0.35.0, design 2026-10-26-taking-messages §8): the Queue's Not taken, which counts
   * toward the Queue's badge. Read with the shared reads at most once a minute — as often as the event service's sweep
   * — and at once on `refresh('notTaken')`, once core takes messages and the event service has Messages (0.32.0);
   * `off` before, and nothing is asked.
   */
  notTaken: Loadable<JoinedMessage[]> | 'off';
  /** Whether the window can be seen: a screen's own poll runs only then. */
  visible: boolean;
  refresh(what?: Refreshed): Promise<void>;
  runDoctors(products: DoctorProduct[]): Promise<void>;
  clearDeepLink(): void;
}

/** What `refresh` reads again: one of the shared reads, or every one. */
export type Refreshed =
  | 'approvals'
  | 'updateStatus'
  | 'events'
  | 'installation'
  | 'queue'
  | 'eventsVersion'
  | 'notTaken';

/** How often Not taken is read with the shared reads: once a minute, as the event service's sweep runs. */
export const NOT_TAKEN_EVERY_MS = 60_000;

/** Whether a service in `status` runs: running, or still stopping. */
const runs = (status: EventServiceStatus): boolean => status === 'running' || status === 'stopping';

/** How often the local reads run while the window is visible (DA4, DA14). */
export const POLL_MS = 15_000;

/**
 * The doctors that run once at start, when their launcher is here. Gmail's is left for the person to ask for, because
 * it calls Google (DA14).
 */
const STARTUP_DOCTORS: readonly DoctorProduct[] = ['core', 'slack', 'resend', 'whatsapp', 'events-daemon'];

const AppDataContext = createContext<AppData | null>(null);

/** Runs a read and turns what it came to into something to show. */
async function read<T>(bridge: Bridge, call: Call): Promise<Loadable<T>> {
  try {
    return loadableOf<T>(await bridge.cli(call));
  } catch (error) {
    return { state: 'error', message: errorMessage(error) };
  }
}

/**
 * Keeps only the answer of the read asked last: each read takes a ticket as it starts, and its answer is kept only if
 * no read started after it. So a slow poll that answers late cannot put back an approval a later read found revoked.
 */
function useLatestOnly(): () => () => boolean {
  const asked = useRef(0);
  return useCallback(() => {
    asked.current += 1;
    const ticket = asked.current;
    return () => ticket === asked.current;
  }, []);
}

/**
 * Whether the window can be seen: the document is visible, and the app's last word on its window was not "hidden"
 * (closing hides it to the tray).
 */
function useVisible(bridge: Bridge): boolean {
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState === 'visible');
  const [windowVisible, setWindowVisible] = useState(true);
  useEffect(() => {
    const changed = () => setDocumentVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', changed);
    const stop = bridge.on('window-visibility', ({ visible }) => setWindowVisible(visible));
    return () => {
      document.removeEventListener('visibilitychange', changed);
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge]);
  return documentVisible && windowVisible;
}

/**
 * Reads what the screens share: the installation first, and nothing else unless `launch/core` is there. Then, every
 * 15 seconds while the window is visible, and at once on focus or `data-changed`: the approvals waiting, the update
 * status when the CLI has it, and the events service's status when it is here. The doctors run once at start. The
 * event service the app runs is read once, and its supervisor says when it changes.
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const [installation, setInstallation] = useState<Loadable<Installation>>({ state: 'loading' });
  const [approvals, setApprovals] = useState<Loadable<ApprovalView[]>>({ state: 'loading' });
  const [updateStatus, setUpdateStatus] = useState<Loadable<UpdateStatus> | 'unsupported'>({ state: 'loading' });
  const [events, setEvents] = useState<Loadable<unknown> | 'absent'>({ state: 'loading' });
  const [doctors, setDoctors] = useState<Partial<Record<DoctorProduct, Loadable<DoctorView>>>>({});
  const [eventService, setEventServiceState] = useState<Loadable<EventServiceState> | 'absent'>({ state: 'loading' });
  const [eventServiceProblem, showEventServiceProblem] = useState<string | null>(null);
  const [eventServiceTurns, setEventServiceTurns] = useState(0);
  const [deepLink, setDeepLink] = useState<DeepLinkTarget | null>(null);
  const [eventsVersion, setEventsVersion] = useState<Loadable<string> | 'absent'>({ state: 'loading' });
  const [queueCounts, setQueueCounts] = useState<Loadable<QueueCounts> | 'unsupported' | 'absent'>({
    state: 'loading',
  });
  const [notTaken, setNotTaken] = useState<Loadable<JoinedMessage[]> | 'off'>('off');
  const visible = useVisible(bridge);

  const installed = installation.state === 'ready' && installation.value.installed ? installation.value : null;
  const updatesSupported = supports(installed?.version ?? null, 'updateStatus');
  const eventsPresent = installed?.present.includes('events-daemon') ?? false;

  const loadInstallation = useCallback(async () => {
    try {
      setInstallation({ state: 'ready', value: await bridge.installation() });
    } catch (error) {
      setInstallation({ state: 'error', message: errorMessage(error) });
    }
  }, [bridge]);

  const approvalsRead = useLatestOnly();
  const updateStatusRead = useLatestOnly();
  const eventsRead = useLatestOnly();
  const eventServiceRead = useLatestOnly();
  const eventsVersionRead = useLatestOnly();
  const queueCountsRead = useLatestOnly();
  const notTakenRead = useLatestOnly();

  const loadApprovals = useCallback(async () => {
    const latest = approvalsRead();
    const value = await read<ApprovalView[]>(bridge, { kind: 'approvalsPending' });
    if (latest()) setApprovals(value);
  }, [bridge, approvalsRead]);

  const loadUpdateStatus = useCallback(async () => {
    const latest = updateStatusRead();
    if (!updatesSupported) {
      setUpdateStatus('unsupported');
      return;
    }
    const value = await read<UpdateStatus>(bridge, { kind: 'updateStatus' });
    if (latest()) setUpdateStatus(value);
  }, [bridge, updatesSupported, updateStatusRead]);

  const loadEvents = useCallback(async () => {
    const latest = eventsRead();
    if (!eventsPresent) {
      setEvents('absent');
      return;
    }
    const value = await read<unknown>(bridge, { kind: 'eventsStatus' });
    if (latest()) setEvents(value);
  }, [bridge, eventsPresent, eventsRead]);

  const loadEventsVersion = useCallback(async () => {
    const latest = eventsVersionRead();
    if (!eventsPresent) {
      setEventsVersion('absent');
      return;
    }
    const value = await read<string>(bridge, { kind: 'version', product: 'events-daemon' });
    if (latest()) setEventsVersion(value);
  }, [bridge, eventsPresent, eventsVersionRead]);

  // The queue's counts, once the events service's own version says it has the queue (0.30.0); nothing is asked before.
  // The version is read through a ref, so the loader, and `refresh` with it, stays one function: the listeners that
  // call it are not taken down and set up again each time the version is read.
  const knownEventsVersion = useRef(eventsVersion);
  knownEventsVersion.current = eventsVersion;
  const loadQueueCounts = useCallback(async () => {
    const latest = queueCountsRead();
    if (!eventsPresent) {
      setQueueCounts('absent');
      return;
    }
    const version = knownEventsVersion.current;
    if (version === 'absent' || version.state === 'loading') return;
    if (version.state === 'error') {
      setQueueCounts(version);
      return;
    }
    if (!supports(version.value, 'queue')) {
      setQueueCounts('unsupported');
      return;
    }
    const result = await read<unknown>(bridge, { kind: 'queueCounts' });
    let counts: Loadable<QueueCounts>;
    if (result.state === 'ready') {
      const value = readQueueCounts(result.value);
      counts =
        value === null
          ? { state: 'error', message: "The queue's counts could not be read." }
          : { state: 'ready', value };
    } else {
      counts = result;
    }
    if (latest()) setQueueCounts(counts);
  }, [bridge, eventsPresent, queueCountsRead]);

  // Not taken (0.35.0): once core takes messages and the event service has Messages, at most once a minute with the
  // shared reads, and at once when asked. The versions are read through refs, as the counts' is.
  const takingOn = supports(installed?.version ?? null, 'taking');
  const presentKey = installed?.present.join(',') ?? '';
  const notTakenAt = useRef(0);
  const loadNotTaken = useCallback(
    async (now: boolean) => {
      const version = knownEventsVersion.current;
      if (!takingOn || !eventsPresent || version === 'absent' || version.state === 'error') {
        notTakenRead();
        setNotTaken('off');
        return;
      }
      if (version.state === 'loading') return;
      if (!supports(version.value, 'messages')) {
        notTakenRead();
        setNotTaken('off');
        return;
      }
      if (!now && Date.now() - notTakenAt.current < NOT_TAKEN_EVERY_MS) return;
      notTakenAt.current = Date.now();
      const latest = notTakenRead();
      const value = await readNotTaken(bridge, presentKey === '' ? [] : (presentKey.split(',') as Product[]));
      if (latest()) setNotTaken(value);
    },
    [bridge, takingOn, eventsPresent, presentKey, notTakenRead],
  );

  const ready = installed !== null;
  const refresh = useCallback(
    async (what?: Refreshed) => {
      if (what === 'installation') return loadInstallation();
      // Nothing runs without core's launcher.
      if (!ready) return;
      if (what === 'approvals') return loadApprovals();
      if (what === 'updateStatus') return loadUpdateStatus();
      if (what === 'events') return loadEvents();
      if (what === 'queue') return loadQueueCounts();
      if (what === 'eventsVersion') return loadEventsVersion();
      if (what === 'notTaken') return loadNotTaken(true);
      await Promise.all([loadApprovals(), loadUpdateStatus(), loadEvents(), loadQueueCounts(), loadNotTaken(false)]);
    },
    [
      ready,
      loadInstallation,
      loadApprovals,
      loadUpdateStatus,
      loadEvents,
      loadQueueCounts,
      loadEventsVersion,
      loadNotTaken,
    ],
  );

  // The events service's own version, once core's launcher and its own are here, and whenever which are here changes.
  useEffect(() => {
    if (!ready) return;
    void loadEventsVersion();
  }, [ready, loadEventsVersion]);

  // The counts, as soon as the version says whether the queue is there, and each time it is read again: the poll then
  // keeps them current.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading of the version is what asks for the counts.
  useEffect(() => {
    if (!ready) return;
    void loadQueueCounts();
    void loadNotTaken(true);
  }, [ready, eventsVersion, loadQueueCounts, loadNotTaken]);

  const runDoctors = useCallback(
    async (products: DoctorProduct[]) => {
      if (!ready) return;
      setDoctors((current) => ({ ...current, ...Object.fromEntries(products.map((p) => [p, { state: 'loading' }])) }));
      await Promise.all(
        products.map(async (product) => {
          const result = await read<unknown>(bridge, { kind: 'doctor', product });
          const shown: Loadable<DoctorView> =
            result.state === 'ready' ? { state: 'ready', value: doctorView(product, result.value) } : result;
          setDoctors((current) => ({ ...current, [product]: shown }));
        }),
      );
    },
    [bridge, ready],
  );

  // The installation, first and alone.
  useEffect(() => {
    void loadInstallation();
  }, [loadInstallation]);

  // A link that launched the app waits to be taken; later ones arrive as events.
  useEffect(() => {
    bridge
      .takeDeepLink()
      .then((target) => {
        if (target !== null) setDeepLink(target);
      })
      .catch(() => undefined);
    const stop = bridge.on('deep-link', (target) => setDeepLink(target));
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge]);

  // Every 15 seconds while the window is visible: local reads only.
  usePoll(() => refresh(), { everyMs: POLL_MS, enabled: ready && visible });

  // At once on focus, and when the tray or Rust says something changed.
  useEffect(() => {
    if (!ready) return;
    const focused = () => void refresh();
    window.addEventListener('focus', focused);
    const stop = bridge.on('data-changed', () => void refresh());
    return () => {
      window.removeEventListener('focus', focused);
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge, ready, refresh]);

  // The doctors, once at start, for each product that is here. Core's never on a timer: each run writes to the keychain.
  const doctorsStarted = useRef(false);
  useEffect(() => {
    if (installed === null || doctorsStarted.current) return;
    doctorsStarted.current = true;
    void runDoctors(STARTUP_DOCTORS.filter((product) => installed.present.includes(product)));
  }, [installed, runDoctors]);

  // The supervisor's word is the latest: a read that started before it is too late to count.
  const showEventService = useCallback(
    (state: EventServiceState) => {
      eventServiceRead();
      setEventServiceState({ state: 'ready', value: state });
    },
    [eventServiceRead],
  );

  // The event service's state, once its launcher is here. The watchdog says when it changes, so it is not polled.
  useEffect(() => {
    const latest = eventServiceRead();
    if (!eventsPresent) {
      setEventServiceState('absent');
      return;
    }
    setEventServiceState({ state: 'loading' });
    bridge
      .eventServiceState()
      .then((value) => {
        if (latest()) setEventServiceState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (latest()) setEventServiceState({ state: 'error', message: errorMessage(error) });
      });
  }, [bridge, eventsPresent, eventServiceRead]);

  useEffect(() => {
    const stop = bridge.on('event-service:changed', showEventService);
    return () => {
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge, showEventService]);

  // When the supervisor says the service started or stopped running, the reads that say whether it runs are read again
  // at once: the events service's status (Overview, the Events screen) and its doctor (Overview, Doctor), rather than at
  // the next poll, or never. Only its doctor: core's writes to the keychain, and Gmail's calls Google. A service that is
  // stopping still runs, so it is read again once it has stopped.
  const lastStatus = useRef<EventServiceStatus | null>(null);
  useEffect(() => {
    if (eventService === 'absent' || eventService.state !== 'ready') return;
    const before = lastStatus.current;
    const now = eventService.value.status;
    lastStatus.current = now;
    if (before === null || runs(before) === runs(now)) return;
    setEventServiceTurns((turns) => turns + 1);
    void refresh('events');
    // A service that started again may be a newer one: its version, which gates the queue, is read again too.
    void refresh('eventsVersion');
    if (eventsPresent) void runDoctors(['events-daemon']);
  }, [eventService, eventsPresent, refresh, runDoctors]);

  const clearDeepLink = useCallback(() => setDeepLink(null), []);

  const value = useMemo<AppData>(
    () => ({
      installation,
      approvals,
      updateStatus,
      events,
      doctors,
      eventService,
      showEventService,
      eventServiceProblem,
      showEventServiceProblem,
      eventServiceTurns,
      deepLink,
      eventsVersion,
      queueCounts,
      notTaken,
      visible,
      refresh,
      runDoctors,
      clearDeepLink,
    }),
    [
      installation,
      approvals,
      updateStatus,
      events,
      doctors,
      eventService,
      showEventService,
      eventServiceProblem,
      eventServiceTurns,
      deepLink,
      eventsVersion,
      queueCounts,
      notTaken,
      visible,
      refresh,
      runDoctors,
      clearDeepLink,
    ],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** What the nearest `AppDataProvider` holds. */
export function useAppData(): AppData {
  const data = useContext(AppDataContext);
  if (data === null) throw new Error('useAppData needs an AppDataProvider above it');
  return data;
}
