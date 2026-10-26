import {
  Button,
  DescriptionList,
  Field,
  FieldDescription,
  FieldError,
  type FieldIssue,
  FieldLabel,
  InfoTip,
  Input,
  Row as Line,
  Panel,
  SectionHeader,
  Switch,
} from '@cueplusplus/ui';
import { Fragment, type ReactNode, useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { useBridge } from '../bridge-context.tsx';
import { AiProviders } from '../components/AiProviders.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import type { Screen } from '../copy.ts';
import { type Loadable, useAppData } from '../data.tsx';
import { type AppSettings, errorMessage, type FolderOverrides, type Folders, type UpdaterState } from '../ipc.ts';
import { NavigationProvider } from '../navigation.tsx';
import { ScreenFrame } from './Screen.tsx';

type FolderKey = keyof Required<FolderOverrides>;

/** The three folders Settings may name, each as the variable it stands for (DA12). */
const FOLDER_FIELDS: readonly { key: FolderKey; label: string; variable: string }[] = [
  { key: 'configDir', label: 'Config folder', variable: 'AGENT_COMMS_CONFIG_DIR' },
  { key: 'stateDir', label: 'State folder', variable: 'AGENT_COMMS_STATE_DIR' },
  { key: 'dataDir', label: 'Data folder', variable: 'AGENT_COMMS_DATA_DIR' },
];

/** The four folders every call pins, as `resolved` names them. */
const RESOLVED: readonly { key: keyof Folders; label: string }[] = [
  { key: 'configDir', label: 'Config' },
  { key: 'stateDir', label: 'State' },
  { key: 'dataDir', label: 'Data' },
  { key: 'secretsDir', label: 'Secrets' },
];

/** A whole path on this machine's disks: from `/` on macOS and Linux, from a drive (`C:\`) on Windows. */
const WHOLE_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
/**
 * A network share, in any of its forms: two separators first (`\\server\share`, `//server/share`, `\\?\UNC\…`), or
 * an address (`smb://…`). Its owner would decide what the app runs: the launchers are read from the data folder.
 */
const NETWORK_SHARE = /^(?:[\\/]{2}|[A-Za-z][A-Za-z0-9+.-]+:\/\/)/;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

/** A folder override: empty leaves it to the environment and the defaults; otherwise a whole path. Rust checks again. */
const folder = z
  .string()
  .trim()
  .refine((value) => !NETWORK_SHARE.test(value), {
    message: "Give a folder on this machine's own disks: never a network share.",
  })
  .refine((value) => value === '' || NETWORK_SHARE.test(value) || WHOLE_PATH.test(value), {
    message: 'Give the whole path, from the root: /… on macOS and Linux, C:\\… on Windows.',
  })
  .refine((value) => !CONTROL_OR_FORMAT.test(value), { message: "A folder's path cannot hold control characters." });

const FOLDERS = z.object({ configDir: folder, stateDir: folder, dataDir: folder });

type Drafts = Record<FolderKey, string>;

function draftsOf(overrides: FolderOverrides): Drafts {
  return {
    configDir: overrides.configDir ?? '',
    stateDir: overrides.stateDir ?? '',
    dataDir: overrides.dataDir ?? '',
  };
}

/** The padding of what a panel holds that is not one of its rows, so it lines up with them. */
const INSET = 'px-(--cue-pad-row-x) py-(--cue-space-3)';

/** What Settings say when macOS did not answer whether the app starts at login (`loginItem` null). */
export const LOGIN_ITEM_UNKNOWN = "macOS isn't answering. Restarting the Mac usually brings it back.";

/** The screen's words: its groups and rows, and each explanation moved into a hint beside what it explains. */
export const SETTINGS_COPY = {
  thisApp: 'This app',
  updates: 'Updates',
  updatesRegion: 'Updates for this app',
  startAtLogin: 'Start at login',
  loginItemNotOffered: "Starting at login isn't offered here.",
  loginItemUnknownWhy:
    "macOS's login-items service is not responding, so whether Agent Comms starts at login can't be read or changed.",
  loginItemUnknownLabel: 'Why macOS is not answering',
  folders: 'Folders',
  inUse: 'Folders in use',
  inUseWhy: 'Every call pins these four folders, and starts the launcher in the data folder.',
  inUseLabel: 'What these folders are',
  changeFolders: 'Change folders…',
  elsewhereWhy:
    'An app started from the Dock or the Start menu sees no shell variables, so it needs the same folders named here.',
  elsewhereLabel: 'Why name them here',
} as const;

/** A row's name, and a quiet line or more beneath it: the shape of each row of This app. */
function RowText({ id, title, children }: { id?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-(--cue-space-1)">
      <span id={id} className="text-(length:--cue-text-body) font-medium text-fg">
        {title}
      </span>
      {children}
    </div>
  );
}

/** A line and its hint: the line says what is true, the hint (a focusable "i") why. */
function Hinted({ children, hint, label }: { children: ReactNode; hint: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-(--cue-space-2)">
      <span>{children}</span>
      <InfoTip text={hint} label={label} />
    </span>
  );
}

/** Start at login: a switch that takes effect at once, through the app (`set_login_item`). */
function LoginItem({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const bridge = useBridge();
  const labelId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = async (on: boolean) => {
    setBusy(true);
    setProblem(null);
    try {
      onChange(await bridge.setLoginItem(on));
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Line className="items-start py-(--cue-space-3)">
      <RowText id={labelId} title={SETTINGS_COPY.startAtLogin}>
        {settings.loginItemAvailable ? null : <p className="text-fg-muted">{SETTINGS_COPY.loginItemNotOffered}</p>}
        {settings.loginItemAvailable && settings.loginItem === null ? (
          <p className="text-fg-muted">
            <Hinted hint={SETTINGS_COPY.loginItemUnknownWhy} label={SETTINGS_COPY.loginItemUnknownLabel}>
              {LOGIN_ITEM_UNKNOWN}
            </Hinted>
          </p>
        ) : null}
        {problem === null ? null : (
          <p role="alert" className="text-danger">
            <UntrustedText text={problem} />
          </p>
        )}
      </RowText>
      <Switch
        aria-labelledby={labelId}
        size="lg"
        checked={settings.loginItem === true}
        disabled={!settings.loginItemAvailable || settings.loginItem === null || busy}
        onCheckedChange={(on) => void toggle(on)}
      />
    </Line>
  );
}

/**
 * The folders: the four every call pins, as literal paths, with the launcher; and, behind "Change folders…", the config,
 * state and data folders as the `AGENT_COMMS_*` variables a Dock launch cannot see would set them (DA12). Those are
 * needed only by someone who keeps agent-communications' folders elsewhere, so they are open from the start only when
 * one is set. Saving re-reads the installation through them, and the folders in use show what they came to.
 */
function FolderSettings({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const bridge = useBridge();
  const { refresh } = useAppData();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(settings.folders));
  const [issues, setIssues] = useState<Partial<Record<FolderKey, FieldIssue[]>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Open from the start only for someone who has named a folder: then what they named is in view.
  const [open, setOpen] = useState(() => FOLDER_FIELDS.some(({ key }) => draftsOf(settings.folders)[key] !== ''));
  const formId = useId();

  const save = async () => {
    setSaved(false);
    setProblem(null);
    const checked = FOLDERS.safeParse(drafts);
    if (!checked.success) {
      const found: Partial<Record<FolderKey, FieldIssue[]>> = {};
      for (const issue of checked.error.issues) {
        const key = issue.path[0] as FolderKey;
        found[key] = [...(found[key] ?? []), { message: issue.message }];
      }
      setIssues(found);
      return;
    }
    setIssues({});
    const folders: FolderOverrides = {
      configDir: checked.data.configDir === '' ? null : checked.data.configDir,
      stateDir: checked.data.stateDir === '' ? null : checked.data.stateDir,
      dataDir: checked.data.dataDir === '' ? null : checked.data.dataDir,
    };
    setBusy(true);
    try {
      const next = await bridge.setFolders(folders);
      onChange(next);
      setDrafts(draftsOf(next.folders));
      setSaved(true);
      // The calls pin the folders just saved: what is installed there is read again.
      await refresh('installation');
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section aria-label={SETTINGS_COPY.inUse}>
        <SectionHeader
          label={
            <Hinted hint={SETTINGS_COPY.inUseWhy} label={SETTINGS_COPY.inUseLabel}>
              {SETTINGS_COPY.inUse}
            </Hinted>
          }
          action={
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={open ? formId : undefined}
              onClick={() => setOpen((shown) => !shown)}
            >
              {SETTINGS_COPY.changeFolders}
            </Button>
          }
        >
          <Panel>
            <div className={INSET}>
              <DescriptionList.Root>
                {RESOLVED.map(({ key, label }) => (
                  <Fragment key={key}>
                    <DescriptionList.Term>{label}</DescriptionList.Term>
                    <DescriptionList.Detail>
                      <span className="font-mono">
                        <UntrustedText text={settings.resolved[key]} />
                      </span>
                    </DescriptionList.Detail>
                  </Fragment>
                ))}
                <DescriptionList.Term>Launcher</DescriptionList.Term>
                <DescriptionList.Detail>
                  <span className="font-mono">
                    <UntrustedText text={settings.launcher} />
                  </span>
                </DescriptionList.Detail>
              </DescriptionList.Root>
            </div>
            {settings.launcherProblem === null ? null : (
              <p role="alert" className={`${INSET} text-warn`}>
                <UntrustedText text={settings.launcherProblem} />
              </p>
            )}
          </Panel>
        </SectionHeader>
      </section>
      {open ? (
        <Panel id={formId}>
          <div className="flex flex-col gap-(--cue-space-4) p-(--cue-space-4)">
            <p className="text-fg-muted">
              <Hinted hint={SETTINGS_COPY.elsewhereWhy} label={SETTINGS_COPY.elsewhereLabel}>
                Only if you keep agent-communications' folders elsewhere, with{' '}
                <span className="font-mono">AGENT_COMMS_*</span> variables.
              </Hinted>
            </p>
            {FOLDER_FIELDS.map(({ key, label, variable }) => (
              <Field key={key} name={key} invalid={(issues[key]?.length ?? 0) > 0}>
                <FieldLabel>{label}</FieldLabel>
                <Input
                  value={drafts[key]}
                  placeholder="Default"
                  spellCheck={false}
                  autoComplete="off"
                  onValueChange={(value: string) => {
                    setSaved(false);
                    setDrafts((current) => ({ ...current, [key]: value }));
                  }}
                />
                <FieldDescription>
                  Leave it empty to use <span className="font-mono">{variable}</span>, or the default.
                </FieldDescription>
                <FieldError issues={issues[key] ?? []} />
              </Field>
            ))}
            <div className="flex items-center gap-(--cue-space-3)">
              <Button variant="primary" loading={busy} onClick={() => void save()}>
                Save
              </Button>
              {saved ? (
                <p role="status" className="text-fg-muted">
                  Saved.
                </p>
              ) : null}
            </div>
            {problem === null ? null : (
              <p role="alert" className="text-danger">
                <UntrustedText text={problem} />
              </p>
            )}
          </div>
        </Panel>
      ) : null}
    </>
  );
}

/** What the app's own updater says, in words. */
function updaterLine(state: UpdaterState): string {
  switch (state.status) {
    case 'off':
      return state.message ?? 'Updates for this app are off.';
    case 'idle':
      return 'Not checked yet.';
    case 'checking':
      return 'Checking…';
    case 'available':
      return state.version === null ? 'An update is available.' : `Agent Comms ${state.version} is available.`;
    case 'none':
      return 'This is the latest version.';
    case 'downloading':
      return state.version === null ? 'Downloading the update…' : `Downloading Agent Comms ${state.version}…`;
    case 'ready':
      return 'The update is ready: the app restarts to finish it.';
    case 'error':
      return state.message ?? 'The check for updates did not work.';
  }
}

/** The states whose line is news to act on, said in the page's ink rather than its quiet one. */
const NEWS: ReadonlySet<UpdaterState['status']> = new Set(['available', 'ready', 'error']);

/**
 * The app's own updater (DA8): where it stands, Check for Updates, and Install and restart when an update is
 * available. A copy built without the updater key says its updater is off.
 */
function AppUpdater() {
  const bridge = useBridge();
  const [state, setState] = useState<Loadable<UpdaterState>>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    bridge
      .updaterState()
      .then((value) => {
        if (live) setState({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (live) setState({ state: 'error', message: errorMessage(error) });
      });
    // The silent check says when it finds one.
    const stop = bridge.on('updater', (value) => setState({ state: 'ready', value }));
    return () => {
      live = false;
      void stop.then((unlisten) => unlisten()).catch(() => undefined);
    };
  }, [bridge]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const current = state.state === 'ready' ? state.value : null;
  const working = current?.status === 'checking' || current?.status === 'downloading';
  return (
    <section aria-label={SETTINGS_COPY.updatesRegion}>
      <Line className="flex-wrap py-(--cue-space-3)">
        <RowText title={SETTINGS_COPY.updates}>
          <div className={current !== null && NEWS.has(current.status) ? 'text-fg' : 'text-fg-muted'}>
            <ScreenState value={state}>{(value) => <UntrustedText text={updaterLine(value)} />}</ScreenState>
          </div>
        </RowText>
        {current?.status === 'available' ? (
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void act(() => bridge.installUpdate())}>
            Install and restart
          </Button>
        ) : null}
        <Button
          size="sm"
          loading={busy}
          disabled={current === null || !current.on || working}
          onClick={() =>
            void act(async () => {
              setState({ state: 'ready', value: await bridge.checkForUpdates() });
            })
          }
        >
          Check for Updates
        </Button>
      </Line>
      {problem === null ? null : (
        <p role="alert" className={`${INSET} text-danger`}>
          <UntrustedText text={problem} />
        </p>
      )}
    </section>
  );
}

/**
 * This app first (its updater and Start at login, design D3), then the folders the CLI calls pin. Nothing here runs a
 * CLI call, so it works before anything is installed, when the person names the folders they keep it in. The appearance
 * menu stays in the window's bar.
 */
export function Settings({ onScreen }: { onScreen?: ((screen: Screen) => void) | undefined } = {}) {
  const bridge = useBridge();
  const [settings, setSettings] = useState<Loadable<AppSettings>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    bridge
      .getSettings()
      .then((value) => {
        if (live) setSettings({ state: 'ready', value });
      })
      .catch((error: unknown) => {
        if (live) setSettings({ state: 'error', message: errorMessage(error) });
      });
    return () => {
      live = false;
    };
  }, [bridge]);
  const changed = (value: AppSettings) => setSettings({ state: 'ready', value });

  return (
    <ScreenFrame title="Settings">
      <div className="flex flex-col gap-(--cue-space-6)">
        <section aria-label={SETTINGS_COPY.thisApp}>
          <SectionHeader label={SETTINGS_COPY.thisApp}>
            <Panel>
              <AppUpdater />
              {settings.state === 'ready' ? (
                <LoginItem settings={settings.value} onChange={changed} />
              ) : (
                <div className={INSET}>
                  <ScreenState value={settings}>{() => null}</ScreenState>
                </div>
              )}
            </Panel>
          </SectionHeader>
        </section>
        <section aria-label={SETTINGS_COPY.folders} className="flex flex-col gap-(--cue-space-3)">
          {settings.state === 'ready' ? (
            <FolderSettings settings={settings.value} onChange={changed} />
          ) : (
            <ScreenState value={settings}>{() => null}</ScreenState>
          )}
        </section>
        {/* AI providers (0.32.0): the keys Jev uses, once the events service is installed. */}
        <NavigationProvider onScreen={onScreen}>
          <AiProviders />
        </NavigationProvider>
      </div>
    </ScreenFrame>
  );
}
