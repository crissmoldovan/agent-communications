import { CommsError } from '@agentcomms/core';

/**
 * Node's built-in SQLite, loaded once and only when an operation needs it.
 *
 * Node 22.12 has the module only behind an experimental flag (unflagged since 22.13, complete since 22.16), so a static
 * import would crash every command, `--help` included, before anything could say why. The floor is the one the
 * WhatsApp channel already states, for the same reason (plan amendment B1-F, committee K4): a held service that holds
 * the event keys does not run on an experimental flag. Node prints an ExperimentalWarning the first time the module
 * loads; that one warning is swallowed here, by its text, and only while the import runs.
 */

type SqliteModule = typeof import('node:sqlite');

/** The oldest Node the event daemon runs on. Stated in `engines`, and checked before the module is imported. */
export const MIN_NODE = '22.16.0';

function parts(version: string): number[] {
  return version
    .replace(/^v/, '')
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

/** Whether `version` (default: this Node's) is `MIN_NODE` or newer. */
export function nodeSupportsSqlite(version: string = process.versions.node): boolean {
  const have = parts(version);
  const need = parts(MIN_NODE);
  for (let index = 0; index < 3; index += 1) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}

/** Refuses to go on under a Node too old for its SQLite, saying which Node it is and what it needs. */
export function requireSupportedNode(version: string = process.versions.node): void {
  if (nodeSupportsSqlite(version)) return;
  throw new CommsError(
    'CONFIG',
    `the local event service needs Node ${MIN_NODE} or newer, and this is Node ${version}`,
    {
      hint: `It keeps its state in Node's own SQLite, which Node ${MIN_NODE} is the first to have complete. Install a newer Node — the current 22 or 24 release — and run it again.`,
      details: { reason: 'NODE_TOO_OLD', node: version, needs: MIN_NODE },
    },
  );
}

let loaded: Promise<SqliteModule> | null = null;

export function loadSqlite(): Promise<SqliteModule> {
  try {
    requireSupportedNode();
  } catch (error) {
    return Promise.reject(error);
  }
  if (!loaded) {
    loaded = (async () => {
      const original = process.emitWarning;
      process.emitWarning = function filtered(this: NodeJS.Process, warning: string | Error, ...rest: unknown[]) {
        const text = typeof warning === 'string' ? warning : warning.message;
        if (text.includes('SQLite is an experimental feature')) return;
        return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
      } as typeof process.emitWarning;
      try {
        return await import('node:sqlite');
      } catch (error) {
        throw new CommsError('CONFIG', `this Node (${process.versions.node}) has no usable built-in SQLite`, {
          hint: `The local event service needs Node ${MIN_NODE} or newer, run without flags that turn built-in modules off.`,
          cause: error,
        });
      } finally {
        process.emitWarning = original;
      }
    })();
    // A failed load is not remembered: the next call says the same thing again rather than a stale rejection.
    loaded.catch(() => {
      loaded = null;
    });
  }
  return loaded;
}
