import {
  Button,
  DescriptionList,
  Field,
  FieldDescription,
  FieldError,
  type FieldIssue,
  FieldLabel,
  Input,
  Switch,
} from '@cueplusplus/ui';
import { Fragment, useEffect, useState } from 'react';
import { z } from 'zod';
import { useBridge } from '../bridge-context.tsx';
import { ScreenState } from '../components/ScreenState.tsx';
import { SectionPanel } from '../components/SectionPanel.tsx';
import { UntrustedText } from '../components/UntrustedText.tsx';
import { type Loadable, useAppData } from '../data.tsx';
import { type AppSettings, errorMessage, type FolderOverrides, type Folders, type UpdaterState } from '../ipc.ts';
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

/** What Settings say when macOS did not answer whether the app starts at login (`loginItem` null). */
export const LOGIN_ITEM_UNKNOWN =
  "macOS isn't answering whether Agent Comms starts at login: its login-items service is not responding. Restarting the Mac usually brings it back.";

/** Start at login: a switch that takes effect at once, through the app (`set_login_item`). */
function LoginItem({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const bridge = useBridge();
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
    <>
      <Switch
        label="Start at login"
        checked={settings.loginItem === true}
        disabled={!settings.loginItemAvailable || settings.loginItem === null || busy}
        onCheckedChange={(on) => void toggle(on)}
      />
      {settings.loginItemAvailable ? null : <p className="text-fg-muted">Starting at login isn't offered here.</p>}
      {settings.loginItemAvailable && settings.loginItem === null ? (
        <p className="text-fg-muted">{LOGIN_ITEM_UNKNOWN}</p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </>
  );
}

/**
 * The folders: config, state and data, as the `AGENT_COMMS_*` variables a Dock launch cannot see would set them
 * (DA12). Saving re-reads the installation through them, and the four folders every call pins show beneath.
 */
function FolderSettings({ settings, onChange }: { settings: AppSettings; onChange: (next: AppSettings) => void }) {
  const bridge = useBridge();
  const { refresh } = useAppData();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(settings.folders));
  const [issues, setIssues] = useState<Partial<Record<FolderKey, FieldIssue[]>>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

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
      <p className="text-fg-muted">
        An app started from the Dock or the Start menu sees no shell variables. If you keep agent-communications'
        folders elsewhere with AGENT_COMMS_* variables, name the same folders here.
      </p>
      {FOLDER_FIELDS.map(({ key, label, variable }) => (
        <Field key={key} name={key} invalid={(issues[key]?.length ?? 0) > 0}>
          <FieldLabel>{label}</FieldLabel>
          <Input
            value={drafts[key]}
            spellCheck={false}
            autoComplete="off"
            onValueChange={(value: string) => {
              setSaved(false);
              setDrafts((current) => ({ ...current, [key]: value }));
            }}
          />
          <FieldDescription>Leave it empty to use {variable}, or the default.</FieldDescription>
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
      <section aria-label="Folders in use" className="flex flex-col gap-(--cue-space-2)">
        <p className="text-fg-muted">Every call pins these four folders, and starts the launcher in the data folder:</p>
        <DescriptionList.Root>
          {RESOLVED.map(({ key, label }) => (
            <Fragment key={key}>
              <DescriptionList.Term>{label}</DescriptionList.Term>
              <DescriptionList.Detail className="font-mono">
                <UntrustedText text={settings.resolved[key]} />
              </DescriptionList.Detail>
            </Fragment>
          ))}
          <DescriptionList.Term>Launcher</DescriptionList.Term>
          <DescriptionList.Detail className="font-mono">
            <UntrustedText text={settings.launcher} />
          </DescriptionList.Detail>
        </DescriptionList.Root>
        {settings.launcherProblem === null ? null : (
          <p role="alert" className="text-warn">
            <UntrustedText text={settings.launcherProblem} />
          </p>
        )}
      </section>
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
    <SectionPanel
      title="Updates for this app"
      actions={
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
      }
    >
      <ScreenState value={state}>
        {(value) => (
          <>
            <p className="text-fg">
              <UntrustedText text={updaterLine(value)} />
            </p>
            {value.status === 'available' ? (
              <div>
                <Button variant="primary" disabled={busy} onClick={() => void act(() => bridge.installUpdate())}>
                  Install and restart
                </Button>
              </div>
            ) : null}
          </>
        )}
      </ScreenState>
      {problem === null ? null : (
        <p role="alert" className="text-danger">
          <UntrustedText text={problem} />
        </p>
      )}
    </SectionPanel>
  );
}

/**
 * Start at login, the folders the CLI calls pin, and the app's own updater. Nothing here runs a CLI call, so it works
 * before anything is installed, when the person names the folders they keep it in.
 */
export function Settings() {
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
      <SectionPanel title="At login">
        <ScreenState value={settings}>{(value) => <LoginItem settings={value} onChange={changed} />}</ScreenState>
      </SectionPanel>
      <SectionPanel title="Folders">
        <ScreenState value={settings}>{(value) => <FolderSettings settings={value} onChange={changed} />}</ScreenState>
      </SectionPanel>
      <AppUpdater />
    </ScreenFrame>
  );
}
