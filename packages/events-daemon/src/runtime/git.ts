import { execFile as nodeExecFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { CommsError } from '@agentcomms/core';

/**
 * Git, as Agent Comms runs it (workflows design §6.6, §8.1, §10.3): `project scan` reads a checkout's origin and its
 * worktrees, and a workflow's worktree step adds and removes worktrees. Git runs as the person, but never through a
 * shell, never with a `GIT_*` variable the environment carries (one could point it at another repository, another
 * index or another work tree), and never with the repository's hooks — `core.hooksPath` may point into the repository
 * itself, so `-c core.hooksPath=/dev/null` comes first on every command line. It has 60 seconds, and what it prints is
 * read up to 64 KiB, as the relay listener's lookup is bounded (`relay-listener.ts`).
 *
 * A run's worktree shares its checkout's `.git/config`, so a session working in one can write the config git reads the
 * next time Agent Comms runs it there (0.37.0 design §3). Hooks are not the only way that config names a program, so:
 * - the system's gitconfig is never read (`GIT_CONFIG_NOSYSTEM=1`, the one `GIT_*` git is given), and the person's
 *   global one still is — that is where their LFS lives;
 * - every key with a fixed name that runs a program is overridden on the command line, which wins over the
 *   repository's own config, with no race;
 * - a key whose name the repository chooses — a filter, diff or merge driver's, or an include that could pull one in —
 *   cannot be overridden, so the gate (`assertSafeRepoConfig`) refuses a repository whose own config has one before git
 *   runs a command there that would run it.
 */

/** Runs git in `cwd` with `args`, after the fixed options; never throws for git's own failure. */
export interface GitRunner {
  run(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }>;
}

/** How long one git command may take. */
export const GIT_TIMEOUT_MS: number = 60_000;
/** How much of what git prints is read. */
export const GIT_MAX_OUTPUT: number = 64 * 1024;
/**
 * The options every git command line starts with: the repository's hooks never run, and no key with a fixed name that
 * names a program — however the repository sets it — makes git run one (0.37.0 design §3 A).
 */
export const GIT_FIXED_OPTIONS: readonly string[] = Object.freeze([
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.sshCommand=',
  '-c',
  'core.gitProxy=',
  '-c',
  'core.pager=cat',
  '-c',
  'core.editor=false',
  '-c',
  'core.askpass=',
  '-c',
  'core.alternateRefsCommand=',
  '-c',
  'sequence.editor=false',
  '-c',
  'credential.helper=',
  '-c',
  'gpg.program=false',
  '-c',
  'gpg.openpgp.program=false',
  '-c',
  'uploadpack.packObjectsHook=',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
]);

/** The one `GIT_*` variable git is given: the system's gitconfig is never read; the person's global one is. */
export const GIT_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1' });

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
  /** The environment git's own is made from, without its `GIT_*` variables but `GIT_ENVIRONMENT`'s; the process's by default. */
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

/**
 * The git runner the event service uses: no shell, no `GIT_*` but `GIT_CONFIG_NOSYSTEM=1`, no hooks and no fixed-name
 * program, 60 seconds, 64 KiB of output.
 */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  // Past the scrubber, the one variable this runner sets itself; whatever the environment said of it.
  const env = { ...scrubbedGitEnvironment(options.env ?? process.env), ...GIT_ENVIRONMENT };
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

/** Why the gate refuses a repository: a key its own config names that would make git run a program, or no answer. */
export type RepoConfigRefusal =
  | {
      readonly code: 'REPO_CONFIG_UNSAFE';
      /** The key, as git lists it, its subsection folded (`repoConfigKeyShown`); never its value. */
      readonly key: string;
      /** Where it is set: `local` or `worktree`, a scope the repository — and so a session in it — writes. */
      readonly scope: string;
    }
  | { readonly code: 'REPO_CONFIG_UNREADABLE'; readonly key: null; readonly scope: null };

/** The scopes the person's own machine holds: the global config (the system's is not read), and git's command line. */
const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['global', 'system', 'command']);
/** How many characters of a key's subsection a refusal shows. */
const SHOWN_SUBSECTION_MAX = 128;
const UNREADABLE: RepoConfigRefusal = Object.freeze({ code: 'REPO_CONFIG_UNREADABLE', key: null, scope: null });

/**
 * Whether a key names a program git runs under a name the repository chooses: a filter driver's `clean`, `smudge` or
 * `process`, a diff driver's `command` or `textconv`, or a merge driver's `driver`. The fixed-name ones are
 * `GIT_FIXED_OPTIONS`', and are not the gate's: refusing a local `core.editor` would refuse ordinary repositories.
 */
function namesAProgram(section: string, name: string): boolean {
  if (section === 'filter') return name === 'clean' || name === 'smudge' || name === 'process';
  if (section === 'diff') return name === 'command' || name === 'textconv';
  return section === 'merge' && name === 'driver';
}

/**
 * A key as a refusal shows it: its section and name as git lists them (lowercase), and its subsection — which the
 * repository chooses, and which may hold anything but a newline — with each character but `A-Z a-z 0-9 . _ - : / ~ *`
 * shown as `?`, at most 128 of them.
 */
export function repoConfigKeyShown(key: string): string {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  if (first === -1 || first === last) return key.replace(/[^A-Za-z0-9._-]/gu, '?');
  const subsection = [...key.slice(first + 1, last).replace(/[^A-Za-z0-9._\-:/~*]/gu, '?')];
  const shown =
    subsection.length > SHOWN_SUBSECTION_MAX
      ? `${subsection.slice(0, SHOWN_SUBSECTION_MAX - 1).join('')}…`
      : subsection.join('');
  const outer = (text: string) => text.replace(/[^A-Za-z0-9-]/gu, '?');
  return `${outer(key.slice(0, first))}.${shown}.${outer(key.slice(last + 1))}`;
}

/**
 * What the gate finds in `git config --list --show-scope -z`: each record is its scope, then its key, a newline and its
 * value (none for a bare key), each ended by a NUL. A key at a scope the repository writes (`local`, `worktree`, or one
 * git names that is not the person's) that names a program, or is an include (`include.path`, any `includeIf.*`), is
 * refused. A key that names a program is named before an include, so a filter pulled in through `include.path` is
 * refused by its own name. Output that does not parse is no answer, and refused as one. Null when nothing is refused.
 */
export function unsafeRepoConfig(listing: string): RepoConfigRefusal | null {
  const tokens = listing.split('\0');
  if (tokens.pop() !== '' || tokens.length % 2 !== 0) return UNREADABLE;
  let include: RepoConfigRefusal | null = null;
  for (let at = 0; at < tokens.length; at += 2) {
    const scope = tokens[at] as string;
    const entry = tokens[at + 1] as string;
    if (TRUSTED_SCOPES.has(scope)) continue;
    const newline = entry.indexOf('\n');
    const key = newline === -1 ? entry : entry.slice(0, newline);
    const lower = key.toLowerCase();
    const first = lower.indexOf('.');
    if (first === -1) continue;
    const section = lower.slice(0, first);
    const name = lower.slice(lower.lastIndexOf('.') + 1);
    if (namesAProgram(section, name))
      return { code: 'REPO_CONFIG_UNSAFE', key: repoConfigKeyShown(key), scope: repoConfigKeyShown(scope) };
    // A conditional include may not apply where this is read and still apply where git runs — a worktree's
    // `gitdir:`, say — so the directive itself is refused, whatever it pulls in here.
    if (include === null && (section === 'include' || section === 'includeif'))
      include = { code: 'REPO_CONFIG_UNSAFE', key: repoConfigKeyShown(key), scope: repoConfigKeyShown(scope) };
  }
  return include;
}

/**
 * The gate (0.37.0 design §3 B): what git's config in `folder` says, through the hardened runner, and why it is refused,
 * or null when it is not. Run before every `worktree add`, checkout, `status` and `worktree remove` the event service
 * runs for a run, on each folder `project scan` lists, and on each folder a project is given. `--list` resolves
 * includes, and lists what one pulls in at the including scope. A config git cannot read, or one too long to read
 * whole, is no answer, and is refused.
 */
export async function repoConfigRefusal(git: GitRunner, folder: string): Promise<RepoConfigRefusal | null> {
  const listed = await git.run(['config', '--list', '--show-scope', '-z'], folder);
  if (listed.code !== 0) return UNREADABLE;
  return unsafeRepoConfig(listed.stdout);
}

/** The words for a refusal: the key and its scope, never the value — a value may hold a path or a command. */
export function repoConfigRefusalWords(refusal: RepoConfigRefusal): string {
  return refusal.code === 'REPO_CONFIG_UNSAFE'
    ? `the repository's own config names a program git would run (${refusal.key}, ${refusal.scope}): move it to your global git config (~/.gitconfig), or remove it`
    : "the repository's git config could not be read";
}

/**
 * The gate, for a person's act: `folder`'s own config names no program git would run, or this throws `BAD_DATA` with
 * the refusal's code as its reason, and the key and its scope.
 */
export async function assertSafeRepoConfig(git: GitRunner, folder: string): Promise<void> {
  const refusal = await repoConfigRefusal(git, folder);
  if (refusal === null) return;
  throw new CommsError('BAD_DATA', `the folder ${folder} cannot be used: ${repoConfigRefusalWords(refusal)}`, {
    details: { reason: refusal.code, key: refusal.key, scope: refusal.scope },
  });
}
