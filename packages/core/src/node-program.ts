import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { absoluteSearchPath } from './system-programs.ts';

/*
 * The path a printed command, or a managed CLI shim, names this Node by (CUE-492).
 *
 * `process.execPath` is this Node as the system reports it, and macOS and Linux report it resolved: a Node reached
 * through `~/.local/bin/node` — a link another tool made into its own private Node — or through Homebrew's
 * `/opt/homebrew/bin/node` reports the file the link points at, inside whatever owns it. A command or a shim naming that
 * file breaks when its owner moves or removes it (`brew upgrade` deletes the Cellar version it names), and reads as
 * though this suite depended on that owner. An MCP registration names the `node` found on PATH, as found
 * (`resolveNode`), and the two disagreed.
 *
 * So a command names this Node as PATH finds it: the first `node` on PATH that is this very Node — the same real file —
 * spelt as PATH has it. The real file is used only for that identity check. The version a target's `engines.node` is
 * checked against stays this process's own, `process.version`, which is that file's; nothing found on PATH is ever run,
 * or asked its version. A `node` on PATH that is another file — another Node, a wrapper, a script — is never named:
 * this process's own path is, as it always was.
 */

/** This Node's real file, or its path as reported when that cannot be resolved. */
function realFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Two real paths are one file: compared without case on Windows, whose paths are. */
function sameRealPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** The names `node` is found by in one folder of PATH, as a shell finds it: with each PATHEXT extension on Windows. */
function nodeNames(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['node'];
  return (env.PATHEXT ?? '.EXE;.CMD;.BAT')
    .split(';')
    .filter(Boolean)
    .map((extension) => `node${extension.toLowerCase()}`);
}

/**
 * The path a command names this Node by: the first `node` on `env`'s PATH that is the same real file as
 * `process.execPath`, as PATH spells it; otherwise `process.execPath`. With no `env`, nothing is looked for.
 *
 * Read when a command is located, as everything else in it is (D6): a link removed or repointed later is what the
 * command then meets. Only absolute folders of PATH are read, as the registrations' own search reads them.
 */
export function nodeProgram(env: NodeJS.ProcessEnv | undefined, platform: NodeJS.Platform = process.platform): string {
  const own = process.execPath;
  if (env === undefined) return own;
  const real = realFile(own);
  const search = env.PATH ?? env.Path ?? '';
  for (const directory of absoluteSearchPath(search.split(delimiter), platform)) {
    for (const name of nodeNames(env, platform)) {
      const candidate = join(directory, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (!sameRealPath(realpathSync(candidate), real, platform)) continue;
        // The same path in another case, on Windows, is this process's own: only a link is spelt otherwise.
        return sameRealPath(candidate, own, platform) ? own : candidate;
      } catch {
        // not here, or not runnable: keep looking
      }
    }
  }
  return own;
}

/**
 * Whether `recorded` — a Node a shim was written with — is the real file that `expected`, the path this Node is found
 * by now, resolves to, and so names that file rather than the link: what a release before CUE-492 wrote. A shim naming
 * the link itself, or another Node altogether, is not this.
 */
export function namesResolvedNode(recorded: string, expected: string, platform: NodeJS.Platform): boolean {
  if (recorded === expected) return false;
  let real: string;
  try {
    real = realpathSync(expected);
  } catch {
    return false;
  }
  return sameRealPath(recorded, real, platform);
}
