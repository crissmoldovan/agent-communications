import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBridge } from './bridge-context.tsx';
import { type ApprovalView, type DoctorProduct, type DoctorView, doctorView, type UpdateStatus } from './cli-types.ts';
import { supports } from './gates.ts';
import { loadableOf } from './hooks/use-call.ts';
import { usePoll } from './hooks/use-poll.ts';
import { type Bridge, type Call, type DeepLinkTarget, errorMessage, type Installation } from './ipc.ts';

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
  /** The approval an `agentcomms://` link asked for, until the screen that showed it clears it. */
  deepLink: DeepLinkTarget | null;
  refresh(what?: 'approvals' | 'updateStatus' | 'events' | 'installation'): Promise<void>;
  runDoctors(products: DoctorProduct[]): Promise<void>;
  clearDeepLink(): void;
}

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
 * status when the CLI has it, and the events service's status when it is here. The doctors run once at start.
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const bridge = useBridge();
  const [installation, setInstallation] = useState<Loadable<Installation>>({ state: 'loading' });
  const [approvals, setApprovals] = useState<Loadable<ApprovalView[]>>({ state: 'loading' });
  const [updateStatus, setUpdateStatus] = useState<Loadable<UpdateStatus> | 'unsupported'>({ state: 'loading' });
  const [events, setEvents] = useState<Loadable<unknown> | 'absent'>({ state: 'loading' });
  const [doctors, setDoctors] = useState<Partial<Record<DoctorProduct, Loadable<DoctorView>>>>({});
  const [deepLink, setDeepLink] = useState<DeepLinkTarget | null>(null);
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

  const ready = installed !== null;
  const refresh = useCallback(
    async (what?: 'approvals' | 'updateStatus' | 'events' | 'installation') => {
      if (what === 'installation') return loadInstallation();
      // Nothing runs without core's launcher.
      if (!ready) return;
      if (what === 'approvals') return loadApprovals();
      if (what === 'updateStatus') return loadUpdateStatus();
      if (what === 'events') return loadEvents();
      await Promise.all([loadApprovals(), loadUpdateStatus(), loadEvents()]);
    },
    [ready, loadInstallation, loadApprovals, loadUpdateStatus, loadEvents],
  );

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

  const clearDeepLink = useCallback(() => setDeepLink(null), []);

  const value = useMemo<AppData>(
    () => ({
      installation,
      approvals,
      updateStatus,
      events,
      doctors,
      deepLink,
      refresh,
      runDoctors,
      clearDeepLink,
    }),
    [installation, approvals, updateStatus, events, doctors, deepLink, refresh, runDoctors, clearDeepLink],
  );
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/** What the nearest `AppDataProvider` holds. */
export function useAppData(): AppData {
  const data = useContext(AppDataContext);
  if (data === null) throw new Error('useAppData needs an AppDataProvider above it');
  return data;
}
