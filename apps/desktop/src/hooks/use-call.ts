import { useCallback, useEffect, useRef, useState } from 'react';
import { useBridge } from '../bridge-context.tsx';
import type { Loadable } from '../data.tsx';
import { type Call, type CliResult, errorMessage } from '../ipc.ts';

/** A call's result as something a screen can show: its data, or what went wrong. */
export function loadableOf<T>(result: CliResult): Loadable<T> {
  switch (result.status) {
    case 'ok':
      return { state: 'ready', value: result.data as T };
    case 'version':
      return { state: 'ready', value: result.version as T };
    case 'failed':
      return { state: 'error', message: result.message };
    case 'approvalPending':
      return { state: 'error', message: 'This needs approval first.' };
  }
}

/**
 * Runs one read from the allow-list when the screen opens, and again on `reload`. `null` runs nothing: a gated section
 * passes it when the CLI is too old. A reply to an earlier call that comes after a later one is dropped.
 */
export function useCall<T>(call: Call | null): { result: Loadable<T>; reload(): Promise<void> } {
  const bridge = useBridge();
  const key = call === null ? null : JSON.stringify(call);
  const [result, setResult] = useState<Loadable<T>>({ state: 'loading' });
  const asked = useRef(0);
  const reload = useCallback(async () => {
    if (key === null) return;
    const ask = ++asked.current;
    let next: Loadable<T>;
    try {
      next = loadableOf<T>(await bridge.cli(JSON.parse(key) as Call));
    } catch (error) {
      next = { state: 'error', message: errorMessage(error) };
    }
    if (ask === asked.current) setResult(next);
  }, [bridge, key]);
  useEffect(() => {
    setResult({ state: 'loading' });
    void reload();
  }, [reload]);
  return { result, reload };
}
