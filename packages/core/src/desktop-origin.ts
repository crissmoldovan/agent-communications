/**
 * Where the desktop app's own approvals come from (0.32.0, after the release's security reviews of 2026-10-26).
 *
 * The app answers two kinds of approval as the person's act — core's changes (`--app-approval`: adding servers to an
 * app with `mcp install`, and from 0.34.0 the agent label, what agents may do, and `update`) and judge setup and AI
 * provider keys (the event service) — by running a CLI with no terminal. On
 * macOS the CLI checks that the app started this process: codesign verifies the running parent, by its pid, against
 * Agent Comms' requirement. That is a speed bump against agents, not a boundary against code running as you: code
 * running as the person can approve in-process anyway.
 *
 * - **The release** satisfies the owner's requirement: identifier `com.cueplusplus.agentcomms`, Apple's anchor, and the
 *   owner's team (`75K3LTUM8A`, read from the installed app's public signature; not a secret).
 * - **The local test build** (`scripts/local-test-release.sh`) is ad-hoc signed, with no team: its running code must say
 *   `com.cueplusplus.agentcomms.test`, and since any home-made ad-hoc app can say that, it speaks only for a test
 *   profile — a config folder that holds the script's marker, `.agentcomms-test-profile`, and is not the person's real,
 *   default one — and only when every other folder the command touches is inside that profile too: its state, data and
 *   secrets folders, and the home folder the apps' configs are in for one that registers servers (the security review of
 *   0.34.0, finding 1). The person's real folders are found from the account's own home, which no variable moves. Its
 *   approvals are audited as the test build's, never as the release's.
 *
 * The parent's path (`ps -o comm=`) is argv[0], which a process sets itself (`exec -a`): it is read only for the
 * refusal's message, and never decides anything. The launchers `exec` Node, so the app is this process's parent.
 * Windows and Linux are not checked (a known limit): there the caller keeps the marker checks, and says the approval
 * was the app's, unattested. A caller that approves a standing disclosure must not take that for the app: the event
 * service's `rule approve` sends an unattested origin to the terminal (security review of 0.33.0, finding 2).
 */
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { APP_DIR_NAME, accountHome } from './paths.ts';

export type DesktopOrigin =
  | { ok: true; build: 'release' | 'test'; identifier: string }
  | {
      ok: false;
      reason: string;
      parent?: string;
      /** For `outside-test-profile`: which folder the command touches that the test profile does not hold. */
      outside?: string;
    };

/**
 * A folder a command touches, besides its config folder, by what it is to a person — `data folder`, `home folder` —
 * and where it is; a path left undefined is one the command reaches and nothing here names, such as npm's own default.
 */
export interface TouchedFolder {
  readonly what: string;
  readonly path: string | undefined;
}

/** Runs a program, by its full path and never through a shell, and gives back what it printed; rejects on failure. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<string>;

/** The release app's bundle identifier. */
export const DESKTOP_RELEASE_IDENTIFIER = 'com.cueplusplus.agentcomms';

/** The local test build's bundle identifier (`local-test-release.sh`). */
export const DESKTOP_TEST_IDENTIFIER = 'com.cueplusplus.agentcomms.test';

/** The owner's Apple team, as the release app's public signature names it. */
export const DESKTOP_RELEASE_TEAM = '75K3LTUM8A';

/** The code requirement the release app satisfies, as codesign's `--test-requirement` takes it (`=` is inline text). */
export const DESKTOP_RELEASE_REQUIREMENT: string = `=identifier "${DESKTOP_RELEASE_IDENTIFIER}" and anchor apple generic and certificate leaf[subject.OU] = "${DESKTOP_RELEASE_TEAM}"`;

/**
 * The file `scripts/local-test-release.sh` writes into the test profile's config folder, and nowhere else: a test build's
 * approvals speak only for a folder that holds it.
 */
export const TEST_PROFILE_MARKER = '.agentcomms-test-profile';

/** The code requirement the local test build's running code satisfies: its identifier, ad-hoc signed. */
export const DESKTOP_TEST_REQUIREMENT: string = `=identifier "${DESKTOP_TEST_IDENTIFIER}"`;

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/** The process that started this one, as Agent Comms itself (macOS), or why not. */
export async function desktopAppOrigin(
  deps: {
    ppid?: number | undefined;
    platform?: NodeJS.Platform | undefined;
    exec?: ExecFn | undefined;
    /** The config folder the approval is for: a test build speaks only for a marked test profile's. */
    configDir?: string | undefined;
    /**
     * Every other folder the command will touch — its state, data and secrets folders, and for a command that writes
     * the apps' configs or npm's global packages, those too. A test build speaks only when each is inside the marked
     * test profile (the security review of 0.34.0, finding 1). Left out, only the config folder is checked.
     */
    folders?: readonly TouchedFolder[] | undefined;
    /** The person's real config folder; worked out from the account's own home when left out. */
    defaultConfigDir?: string | undefined;
    /** The account's own home (`os.userInfo().homedir`), which no variable moves; a test names one of its own. */
    realHome?: string | undefined;
  } = {},
): Promise<DesktopOrigin> {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, reason: 'unattested-platform' };
  const exec = deps.exec ?? defaultExec;
  const pid = String(deps.ppid ?? process.ppid);
  // What the parent calls itself, for the message only: argv[0], which a process sets itself.
  let parent: string | undefined;
  try {
    parent = (await exec('/bin/ps', ['-p', pid, '-o', 'comm='])).trim() || undefined;
  } catch {
    parent = undefined;
  }
  // The running parent, by its pid: codesign checks the process's own code, not a path anything can name.
  const satisfies = async (requirement: string): Promise<boolean> => {
    try {
      await exec('/usr/bin/codesign', ['--verify', '--strict', '--test-requirement', requirement, pid]);
      return true;
    } catch {
      return false;
    }
  };
  if (await satisfies(DESKTOP_RELEASE_REQUIREMENT)) {
    return { ok: true, build: 'release', identifier: DESKTOP_RELEASE_IDENTIFIER };
  }
  if (await satisfies(DESKTOP_TEST_REQUIREMENT)) {
    // Any home-made ad-hoc app can say the test identifier: it speaks only for a test profile the script marked, and
    // never for the person's real, default folders, nor for anything the command touches outside the profile.
    if (deps.configDir === undefined) return { ok: false, reason: 'test-profile-unknown' };
    return testProfileOrigin(deps.configDir, deps.folders ?? [], deps.realHome ?? accountHome(), deps.defaultConfigDir);
  }
  return { ok: false, reason: 'not-agent-comms', ...(parent === undefined ? {} : { parent }) };
}

/**
 * The test build's origin, for the folders a command touches (the security review of 0.34.0, finding 1).
 *
 * The person's real folders are where core puts them for the account's own home — the config folder (with state and
 * secrets in it) and the data folder — worked out from that home alone: `HOME`, `XDG_CONFIG_HOME` and the rest are set
 * by whoever starts the command, so they can make the real folder look like any other. The test profile is the folder
 * that holds the marked config folder, as `local-test-release.sh` writes it (`<profile>/config`). It must not be the
 * account's home, hold any of the real folders, or sit inside one; and every folder the command touches must be inside
 * it, by its path and by where it really is, links followed. Only paths are compared; nothing in them is read.
 */
function testProfileOrigin(
  configDir: string,
  folders: readonly TouchedFolder[],
  home: string,
  defaultConfigDir: string | undefined,
): DesktopOrigin {
  const realConfig = defaultConfigDir ?? join(home, '.config', APP_DIR_NAME);
  const real = [realConfig, join(home, '.local', 'share', APP_DIR_NAME)];
  if (sameFolder(configDir, realConfig)) return { ok: false, reason: 'test-app-with-real-profile' };
  if (!isPlainFile(join(configDir, TEST_PROFILE_MARKER))) return { ok: false, reason: 'not-a-test-profile' };
  const profile = dirname(resolve(configDir));
  if (overlaps(home, profile) || real.some((folder) => overlaps(folder, profile) || overlaps(profile, folder))) {
    return { ok: false, reason: 'test-profile-holds-real-folders' };
  }
  for (const { what, path } of folders) {
    if (path === undefined || !containedIn(path, profile))
      return { ok: false, reason: 'outside-test-profile', outside: what };
  }
  return { ok: true, build: 'test', identifier: DESKTOP_TEST_IDENTIFIER };
}

/** Whether `child` is `parent` or inside it, as paths. */
function within(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/**
 * Where a path really is, links followed: its nearest folder that is there, resolved, and the rest of it after that. A
 * path that is not there yet is where it would be made.
 */
function whereItIs(path: string): string {
  const absolute = resolve(path);
  let folder = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(folder), ...rest);
    } catch {
      const parent = dirname(folder);
      if (parent === folder) return absolute;
      rest.unshift(basename(folder));
      folder = parent;
    }
  }
}

/** Inside `parent` both by its path and by where it really is: a link out of the profile is not in it. */
function containedIn(child: string, parent: string): boolean {
  return within(resolve(child), resolve(parent)) && within(whereItIs(child), whereItIs(parent));
}

/** Inside `parent` by its path or by where it really is: either way it is the person's. */
function overlaps(child: string, parent: string): boolean {
  return within(resolve(child), resolve(parent)) || within(whereItIs(child), whereItIs(parent));
}

/** Whether two folders are one: by their real paths when both are there, by their resolved paths otherwise. */
function sameFolder(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** Whether `path` is a file of its own: not a link, and not missing. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
