import { ThemeProvider } from '@cueplusplus/ui/system';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { SecretFormState, type SecretResult } from './secret-form-state';

export const secretCommands = [
  ['desktop_target_secret_create', 'Create target signing secret'],
  ['desktop_target_secret_rotate', 'Rotate target signing secret'],
  ['desktop_target_url_set', 'Set secret target URL'],
  ['desktop_subscriber_token_create', 'Create subscriber token'],
  ['desktop_subscriber_token_rotate', 'Rotate subscriber token'],
  ['desktop_judge_key_set', 'Set judge key'],
  ['desktop_judge_key_rotate', 'Rotate judge key'],
  ['desktop_secrets_migrate', 'Migrate secret backend'],
] as const;

function invoke(command: string, args: { input: Record<string, unknown> }): Promise<SecretResult> {
  if (!window.__TAURI__) return Promise.reject(new Error('Secret commands unavailable'));
  return window.__TAURI__.core.invoke<SecretResult>(command, args);
}

export function SecretsApp() {
  const state = useRef(new SecretFormState());
  const form = useRef<HTMLFormElement>(null);
  const hidden = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState(state.current.snapshot());
  const [command, setCommand] = useState<string>('desktop_judge_key_set');
  const clear = useCallback(() => {
    state.current.clear();
    if (hidden.current) hidden.current.value = '';
    setSnapshot(state.current.snapshot());
  }, []);
  useEffect(() => {
    const events = ['blur', 'pagehide', 'beforeunload', 'agentcomms:secret-clear', 'agentcomms:navigation-failure'];
    for (const event of events) window.addEventListener(event, clear);
    const visibility = () => {
      if (document.visibilityState === 'hidden') clear();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      state.current.clear();
      for (const event of events) window.removeEventListener(event, clear);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [clear]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fields: Record<string, unknown> =
      command === 'desktop_secrets_migrate'
        ? { to: data.get('to') }
        : { id: data.get('id'), version: Number(data.get('version')) };
    if (command === 'desktop_target_url_set') {
      if (data.get('predecessorVersion')) fields.predecessorVersion = Number(data.get('predecessorVersion'));
      else {
        try {
          fields.inertDraft = JSON.parse(String(data.get('inertDraft')));
        } catch {
          clear();
          return;
        }
      }
    }
    state.current.hidden = hidden.current?.value ?? '';
    if (hidden.current) hidden.current.value = '';
    const submitted = state.current.submit(command, fields, invoke);
    setSnapshot(state.current.snapshot());
    void submitted.then(() => setSnapshot(state.current.snapshot()));
  };
  const needsHidden = command === 'desktop_target_url_set' || command.startsWith('desktop_judge_key_');
  return (
    <ThemeProvider>
      <main>
        <h1>Secrets</h1>
        <p>Generated material is shown once. Closing or leaving this window clears it.</p>
        <form ref={form} onSubmit={submit} autoComplete="off">
          <label>
            Operation
            <select
              value={command}
              onChange={(event) => {
                clear();
                setCommand(event.target.value);
              }}
            >
              {secretCommands.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {command === 'desktop_secrets_migrate' ? (
            <label>
              Destination
              <select name="to">
                <option value="file">Private file store</option>
                <option value="keychain">System keychain</option>
              </select>
            </label>
          ) : (
            <>
              <label>
                Owner id
                <input name="id" required />
              </label>
              <label>
                Exact version
                <input name="version" type="number" min="1" required />
              </label>
            </>
          )}
          {command === 'desktop_target_url_set' && (
            <>
              <label>
                Predecessor version (for a replacement)
                <input name="predecessorVersion" type="number" min="1" />
              </label>
              <label>
                Inert target draft (for a new target)
                <textarea name="inertDraft" />
              </label>
            </>
          )}
          {needsHidden && (
            <label>
              Hidden value
              <input ref={hidden} type="password" autoComplete="off" spellCheck={false} required />
            </label>
          )}
          <button type="submit" disabled={snapshot.busy}>
            Complete operation
          </button>
          <button type="button" onClick={clear}>
            Clear
          </button>
        </form>
        {snapshot.message && <p role="status">{snapshot.message}</p>}
        {snapshot.result?.kind === 'RevealOnce' && (
          <output aria-label="One-time secret">{snapshot.result.material}</output>
        )}
        {snapshot.result?.kind === 'UrlFingerprint' && (
          <output>
            {snapshot.result.scheme} · {snapshot.result.host} · {snapshot.result.port} · {snapshot.result.sha256}
          </output>
        )}
        {snapshot.result?.kind === 'MigrationStatus' && (
          <output>
            Moved {snapshot.result.moved} references. {snapshot.result.leftovers.length} require cleanup.
          </output>
        )}
      </main>
    </ThemeProvider>
  );
}
