import { endLiveOracleGroups } from './strict-mutation-child.ts';

let installed = false;

/**
 * Each strict oracle leads a process group of its own (`strict-mutation-child.ts`), so it no longer hears the
 * terminal's Ctrl-C with the runner. A runner that calls this ends every oracle it started when it exits or is told
 * to stop. A signal is passed on afterwards only when nothing else listens for it, which is when Node would have ended
 * anyway. This lives apart from the child runner, which phase E's adversarial scanner allows no `process` hook.
 */
export function endOracleGroupsWithThisRunner(): void {
  if (installed || process.platform === 'win32') return;
  installed = true;
  process.once('exit', endLiveOracleGroups);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(signal, () => {
      endLiveOracleGroups();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
}
