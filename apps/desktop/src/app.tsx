import { ThemeProvider } from '@cueplusplus/ui/system';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ControlModel } from './control-model';
import { createScreenController } from './screen-controller';
import { screens } from './screens';
import { OperationResults } from './screens/shared';
import { type SupervisionView, supervisionCommands, WindowLifecycle } from './supervision';
import type { AppPreferences, DesktopWindowKind, SafeAppResult } from './types';

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> } };
  }
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!window.__TAURI__) return Promise.reject(new Error('Desktop commands are available in the installed app.'));
  return window.__TAURI__.core.invoke<T>(command, args);
}

const commands = supervisionCommands(invoke);

function Workspace() {
  const [screen, setScreen] = useState<keyof typeof screens>('overview');
  const [results, setResults] = useState<Record<string, SafeAppResult>>({});
  const [preferences, setPreferences] = useState<AppPreferences>({
    openAtLogin: false,
    keepCollectingAfterQuit: false,
    revision: 0,
  });
  const [error, setError] = useState('');
  const model = useRef(new ControlModel(invoke));
  const lifecycle = useRef(new WindowLifecycle());
  const Current = screens[screen];
  useEffect(() => {
    const request = lifecycle.current.request();
    void invoke<AppPreferences>('desktop_preferences')
      .then((value) => lifecycle.current.publish(request, () => setPreferences(value)))
      .catch((reason) => lifecycle.current.publish(request, () => setError(String(reason))));
    const clear = () => {
      lifecycle.current.purge();
      model.current.close();
      setResults({});
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    window.addEventListener('pagehide', clear);
    window.addEventListener('agentcomms:purge', clear);
    document.addEventListener('visibilitychange', hide);
    return () => {
      clear();
      window.removeEventListener('pagehide', clear);
      window.removeEventListener('agentcomms:purge', clear);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);
  const controller = createScreenController(model.current, setResults, setError);
  return (
    <div>
      <h1>Local events</h1>
      <nav aria-label="Event screens">
        {(Object.keys(screens) as (keyof typeof screens)[]).map((name) => (
          <button
            type="button"
            key={name}
            aria-current={screen === name ? 'page' : undefined}
            onClick={() => {
              model.current.close();
              setResults({});
              setScreen(name);
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {error && <p role="alert">{error}</p>}
      <Current
        results={results}
        preferences={preferences}
        supervision={<Settings />}
        onOperation={controller.run}
        onSecrets={() => {
          model.current.close();
          setResults({});
          void commands.openSecrets().catch((reason) => setError(String(reason)));
        }}
        onApproval={controller.approval}
        onPreferences={(value) => {
          const request = lifecycle.current.request();
          void invoke<AppPreferences>('desktop_preferences', {
            expectedRevision: preferences.revision,
            openAtLogin: value.openAtLogin,
            keepCollectingAfterQuit: value.keepCollectingAfterQuit,
          })
            .then((next) => lifecycle.current.publish(request, () => setPreferences(next)))
            .catch((reason) => lifecycle.current.publish(request, () => setError(String(reason))));
        }}
      />
      <OperationResults results={results} />
    </div>
  );
}

function Settings() {
  const [view, setView] = useState<SupervisionView | null>(null);
  const [executable, setExecutable] = useState('');
  const [stateDir, setStateDir] = useState('');
  const [configDir, setConfigDir] = useState('');
  const [keepCollectingAfterQuit, setKeepCollectingAfterQuit] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lifecycle = useRef(new WindowLifecycle());

  const refreshStatus = useCallback(() => {
    const request = lifecycle.current.request();
    void commands
      .status()
      .then((next) => {
        lifecycle.current.publish(request, () => {
          setView(next);
          setKeepCollectingAfterQuit(next.keepCollectingAfterQuit);
        });
      })
      .catch((reason: unknown) => lifecycle.current.publish(request, () => setError(String(reason))));
  }, []);

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') lifecycle.current.hide();
    };
    const close = () => lifecycle.current.close();
    const purge = () => lifecycle.current.purge();
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', close);
    window.addEventListener('beforeunload', close);
    window.addEventListener('agentcomms:purge', purge);
    refreshStatus();
    return () => {
      lifecycle.current.close();
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', close);
      window.removeEventListener('beforeunload', close);
      window.removeEventListener('agentcomms:purge', purge);
    };
  }, [refreshStatus]);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = lifecycle.current.request();
    setBusy(true);
    setError('');
    let refresh = false;
    try {
      const next = await commands.start({
        executable,
        stateDir,
        configDir,
        expectedRevision: view?.revision ?? 0,
        keepCollectingAfterQuit,
      });
      lifecycle.current.publish(request, () => setView(next));
    } catch (reason) {
      refresh = lifecycle.current.publish(request, () => setError(String(reason)));
    } finally {
      lifecycle.current.publish(request, () => setBusy(false));
    }
    if (refresh && lifecycle.current.publish(request, () => undefined)) refreshStatus();
  }

  async function stop() {
    const request = lifecycle.current.request();
    setBusy(true);
    setError('');
    try {
      const next = await commands.stop();
      lifecycle.current.publish(request, () => setView(next));
    } catch (reason) {
      lifecycle.current.publish(request, () => setError(String(reason)));
    } finally {
      lifecycle.current.publish(request, () => setBusy(false));
    }
  }

  return (
    <main>
      <h1>Local events</h1>
      <p>
        Daemon: {view?.state ?? 'checking'}
        {view?.attached ? ' (attached)' : ''}
      </p>
      {view?.profileConfigured && <p>A daemon profile is saved. Enter its exact paths again to start it.</p>}
      <form onSubmit={(event) => void start(event)}>
        <label>
          Daemon executable{' '}
          <input value={executable} onChange={(event) => setExecutable(event.target.value)} required />
        </label>
        <label>
          State directory <input value={stateDir} onChange={(event) => setStateDir(event.target.value)} required />
        </label>
        <label>
          Config directory <input value={configDir} onChange={(event) => setConfigDir(event.target.value)} required />
        </label>
        <label>
          <input
            type="checkbox"
            checked={keepCollectingAfterQuit}
            disabled={busy || view?.state !== 'idle'}
            onChange={(event) => setKeepCollectingAfterQuit(event.target.checked)}
          />{' '}
          Keep collecting after tray Quit
        </label>
        <button type="submit" disabled={busy || view?.state !== 'idle'}>
          Start daemon
        </button>
      </form>
      <button type="button" onClick={() => void stop()} disabled={busy || view?.state !== 'running'}>
        Stop daemon
      </button>
      <button
        type="button"
        onClick={() => {
          const request = lifecycle.current.request();
          void commands
            .openSecrets()
            .catch((reason: unknown) => lifecycle.current.publish(request, () => setError(String(reason))));
        }}
      >
        Open Secrets
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

export function App({ kind }: { kind: DesktopWindowKind }) {
  return (
    <ThemeProvider theme="cue" density="normal" mode="system">
      {kind === 'settings' ? (
        <Workspace />
      ) : (
        <main>
          <h1>Secrets</h1>
          <p>Secret entry is not available in this build.</p>
        </main>
      )}
    </ThemeProvider>
  );
}
