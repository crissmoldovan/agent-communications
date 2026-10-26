/**
 * Where the desktop app's own approvals come from (0.32.0, after the release's security reviews of 2026-10-26).
 *
 * The app answers two kinds of approval as the person's act — adding a server to an app (core's `mcp install
 * --app-approval`) and judge setup and AI provider keys (the event service) — by running a CLI with no terminal. On
 * macOS the CLI checks that the app started this process: codesign verifies the running parent, by its pid, against
 * Agent Comms' requirement. That is a speed bump against agents, not a boundary against code running as you: code
 * running as the person can approve in-process anyway.
 *
 * - **The release** satisfies the owner's requirement: identifier `com.cueplusplus.agentcomms`, Apple's anchor, and the
 *   owner's team (`75K3LTUM8A`, read from the installed app's public signature; not a secret).
 * - **The local test build** (`scripts/local-test-release.sh`) is ad-hoc signed, with no team: its running code must say
 *   `com.cueplusplus.agentcomms.test`, and since any home-made ad-hoc app can say that, it speaks only for a test
 *   profile — a config folder that holds the script's marker, `.agentcomms-test-profile`, and is not the person's real,
 *   default one. Its approvals are audited as the test build's, never as the release's.
 *
 * The parent's path (`ps -o comm=`) is argv[0], which a process sets itself (`exec -a`): it is read only for the
 * refusal's message, and never decides anything. The launchers `exec` Node, so the app is this process's parent.
 * Windows and Linux are not checked (a known limit): there the caller keeps the marker checks, and says the approval
 * was the app's, unattested.
 */
import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolvePaths } from './paths.ts';

export type DesktopOrigin =
  | { ok: true; build: 'release' | 'test'; identifier: string }
  | { ok: false; reason: string; parent?: string };

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
    /** The person's real config folder, as core resolves it with no folder named; worked out when left out. */
    defaultConfigDir?: string | undefined;
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
    // never for the person's real, default folder.
    if (deps.configDir === undefined) return { ok: false, reason: 'test-profile-unknown' };
    const real =
      deps.defaultConfigDir ?? resolvePaths({ env: { ...process.env, AGENT_COMMS_CONFIG_DIR: '' } }).configDir;
    if (sameFolder(deps.configDir, real)) return { ok: false, reason: 'test-app-with-real-profile' };
    if (!isPlainFile(join(deps.configDir, TEST_PROFILE_MARKER))) return { ok: false, reason: 'not-a-test-profile' };
    return { ok: true, build: 'test', identifier: DESKTOP_TEST_IDENTIFIER };
  }
  return { ok: false, reason: 'not-agent-comms', ...(parent === undefined ? {} : { parent }) };
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
