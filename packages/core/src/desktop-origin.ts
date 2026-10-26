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
 *   `com.cueplusplus.agentcomms.test`.
 *
 * The parent's path (`ps -o comm=`) is argv[0], which a process sets itself (`exec -a`): it is read only for the
 * refusal's message, and never decides anything. The launchers `exec` Node, so the app is this process's parent.
 * Windows and Linux are not checked (a known limit): there the caller keeps the marker checks, and says the approval
 * was the app's, unattested.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

/** A managed release runtime's folder: `runtime/<version>-<product>/`, as `launcher.ts` lays them out. */
const RELEASE_RUNTIME = /[\\/]runtime[\\/]\d[^\\/]*-[a-z][a-z0-9-]*[\\/]/;

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
    selfPath?: string | undefined;
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
    const self = deps.selfPath ?? fileURLToPath(import.meta.url);
    if (RELEASE_RUNTIME.test(self)) return { ok: false, reason: 'test-app-with-release-runtime' };
    return { ok: true, build: 'test', identifier: DESKTOP_TEST_IDENTIFIER };
  }
  return { ok: false, reason: 'not-agent-comms', ...(parent === undefined ? {} : { parent }) };
}
