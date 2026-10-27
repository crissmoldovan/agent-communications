import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * Git, as Agent Comms runs it (workflows design §6.6, §8.1, §10.3): `project scan` reads a checkout's origin and its
 * worktrees, and a workflow's worktree step adds and removes worktrees. Git runs as the person, but never through a
 * shell, never with a `GIT_*` variable the environment carries (one could point it at another repository, another
 * index or another work tree), and never with the repository's hooks — `core.hooksPath` may point into the repository
 * itself, so `-c core.hooksPath=/dev/null` comes first on every command line. It has 60 seconds, and what it prints is
 * read up to 64 KiB, as the relay listener's lookup is bounded (`relay-listener.ts`).
 */

/** Runs git in `cwd` with `args`, after the fixed options; never throws for git's own failure. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

/** How long one git command may take. */
export const GIT_TIMEOUT_MS: number = 60_000;
/** How much of what git prints is read. */
export const GIT_MAX_OUTPUT: number = 64 * 1024;
/** The options every git command line starts with: the repository's hooks are never run. */
export const GIT_FIXED_OPTIONS: readonly ['-c', 'core.hooksPath=/dev/null'] = Object.freeze([
  '-c',
  'core.hooksPath=/dev/null',
] as const);

/** What `execFile` is handed, recorded by a test's stand-in. */
export interface GitExecOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
  readonly windowsHide: true;
}

/** `execFile`'s callback form, the one seam a test replaces. */
export type GitExecFile = (
  file: string,
  args: readonly string[],
  options: GitExecOptions,
  callback: (error: (Error & { code?: unknown }) | null, stdout: string) => void,
) => void;

export interface GitRunnerOptions {
  /** git's absolute path; found on `PATH` (absolute entries only) when not given. */
  readonly gitPath?: string | undefined;
  /** The environment git's own is made from, without its `GIT_*` variables; the process's by default. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly execFile?: GitExecFile | undefined;
}

/** The environment without any variable whose name starts with `GIT_`, in any case. */
export function scrubbedGitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env))
    if (!name.toUpperCase().startsWith('GIT_') && value !== undefined) scrubbed[name] = value;
  return scrubbed;
}

/** git's absolute path: the first executable `git` in an absolute `PATH` entry, or the system's. */
export function findGit(env: NodeJS.ProcessEnv = process.env): string {
  const names = process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git'];
  for (const folder of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!isAbsolute(folder)) continue;
    for (const name of names) {
      const candidate = join(folder, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; the next entry.
      }
    }
  }
  return '/usr/bin/git';
}

/** The git runner the event service uses: no shell, no `GIT_*`, no hooks, 60 seconds, 64 KiB of output. */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const env = scrubbedGitEnvironment(options.env ?? process.env);
  const gitPath = options.gitPath ?? findGit(options.env ?? process.env);
  if (!isAbsolute(gitPath)) throw new TypeError("git's path is absolute");
  const exec: GitExecFile =
    options.execFile ??
    ((file, args, execOptions, callback) =>
      nodeExecFile(file, [...args], { ...execOptions, encoding: 'utf8' }, (error, stdout) =>
        callback(error, String(stdout)),
      ));
  return {
    run(args, cwd) {
      if (!isAbsolute(cwd)) return Promise.resolve({ code: -1, stdout: '' });
      return new Promise((resolve) => {
        try {
          exec(
            gitPath,
            [...GIT_FIXED_OPTIONS, ...args],
            {
              cwd,
              env: { ...env },
              timeout: GIT_TIMEOUT_MS,
              maxBuffer: GIT_MAX_OUTPUT,
              shell: false,
              windowsHide: true,
            },
            (error, stdout) => {
              const text = String(stdout ?? '').slice(0, GIT_MAX_OUTPUT);
              if (error === null) return resolve({ code: 0, stdout: text });
              // git's own exit status; a kill (the timeout), too much output or a failure to start is -1.
              resolve({ code: typeof error.code === 'number' ? error.code : -1, stdout: text });
            },
          );
        } catch {
          resolve({ code: -1, stdout: '' });
        }
      });
    },
  };
}
