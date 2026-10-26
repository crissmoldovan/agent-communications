/**
 * Where the desktop app's own approvals come from (0.32.0, after the release's security review of 2026-10-26).
 *
 * The app answers two kinds of approval as the person's act — adding a server to an app (core's `mcp install
 * --app-approval`) and judge setup and AI provider keys (the event service) — by running a CLI with no terminal. An
 * agent's marker is only a speed bump against a shell pretending to be the app, so on macOS the CLI checks that the
 * process that started it is Agent Comms itself: its executable inside an app bundle that codesign verifies.
 *
 * - **The release** passes the owner's requirement: identifier `com.cueplusplus.agentcomms`, Apple's anchor, and the
 *   owner's team (`75K3LTUM8A`, read from the installed app's public signature; not a secret).
 * - **The local test build** (`scripts/local-test-release.sh`) is ad-hoc signed, with no team. It is accepted only when
 *   its bundle says `com.cueplusplus.agentcomms.test`, its signature verifies, and this CLI is not a managed release
 *   runtime (`<data>/runtime/<version>-<product>/`): a test app speaks only for a local build of the CLI.
 *
 * The launchers `exec` Node, so the app is this process's parent. Windows and Linux are not attested (known limit):
 * there the caller keeps the marker checks, and says the approval was the app's, unattested.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export type DesktopOrigin = { ok: true; build: 'release' | 'test'; identifier: string } | { ok: false; reason: string };

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

/** An executable inside an app bundle: `<…>.app/Contents/MacOS/<name>`, and the bundle. */
const IN_BUNDLE = /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/;

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
  const ppid = deps.ppid ?? process.ppid;
  let parent: string;
  try {
    parent = (await exec('/bin/ps', ['-p', String(ppid), '-o', 'comm='])).trim();
  } catch {
    return { ok: false, reason: 'parent-unknown' };
  }
  const bundle = IN_BUNDLE.exec(parent)?.[1];
  if (bundle === undefined) return { ok: false, reason: 'parent-not-an-app' };
  const verifies = async (args: readonly string[]): Promise<boolean> => {
    try {
      await exec('/usr/bin/codesign', ['--verify', '--strict', ...args, bundle]);
      return true;
    } catch {
      return false;
    }
  };
  // The release: the owner's team signed it, and it says so.
  if (await verifies(['--test-requirement', DESKTOP_RELEASE_REQUIREMENT])) {
    return { ok: true, build: 'release', identifier: DESKTOP_RELEASE_IDENTIFIER };
  }
  // The local test build: its own identifier, an ad-hoc signature that verifies, and only beside a local build.
  let identifier: string;
  try {
    identifier = (
      await exec('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        '-o',
        '-',
        `${bundle}/Contents/Info.plist`,
      ])
    ).trim();
  } catch {
    return { ok: false, reason: 'not-agent-comms' };
  }
  if (identifier !== DESKTOP_TEST_IDENTIFIER) return { ok: false, reason: 'not-agent-comms' };
  const self = deps.selfPath ?? fileURLToPath(import.meta.url);
  if (RELEASE_RUNTIME.test(self)) return { ok: false, reason: 'test-app-with-release-runtime' };
  if (!(await verifies([]))) return { ok: false, reason: 'signature-not-verified' };
  return { ok: true, build: 'test', identifier };
}
