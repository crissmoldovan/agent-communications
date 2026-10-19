import path from 'node:path';

/**
 * The programs this package starts, named so that no folder it happens to be in can stand in for them.
 *
 * A bare name is looked up, and on Windows the lookup starts in the current folder: libuv tries it before `PATH`, and
 * so does every program that looks a name up with `SearchPath` or `CreateProcess`. The current folder is where a
 * command was run or a server was started — and, since a download asks where to save, one of the three places a
 * stranger's file may be saved into. A `reg.exe` or `rundll32.exe` saved there would then be what runs the next time
 * this package reads the registry or opens a browser. So a Windows program is named by its full path, under the Windows
 * folder, and every process started on Windows is told, by `NoDefaultCurrentDirectoryInExePath`, not to look in its
 * own current folder for the programs it starts in turn.
 */

/** An environment variable by name, whatever its case: Windows's are case-blind, an object passed in is not. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && value) return value;
  }
  return undefined;
}

/**
 * The Windows folder: `%SystemRoot%` (or `%windir%`) when it names a folder on a drive, and `C:\Windows` otherwise.
 * A value that is not a drive's absolute path — relative, a share, a device path — is not taken: it would be looked up
 * against the current folder, or on another machine, which is what naming the program in full is to avoid.
 */
export function windowsFolder(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of ['SystemRoot', 'windir']) {
    const value = envValue(env, name);
    if (value !== undefined && /^[A-Za-z]:[\\/]/.test(value)) return path.win32.resolve(value);
  }
  return 'C:\\Windows';
}

/** A program of Windows's own by its full path: `%SystemRoot%\System32\<name>`, never a bare name to look up. */
export function windowsSystemProgram(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(windowsFolder(env), 'System32', name);
}

/**
 * The environment a child process is started with: `env` as it is, and on Windows also
 * `NoDefaultCurrentDirectoryInExePath=1`, so that the child — `rundll32.exe`, a Node started again — never takes a
 * program from its current folder either. Elsewhere nothing is added: a Unix shell looks in the current folder only
 * when `PATH` says to.
 */
export function childEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32') return env;
  return { ...env, NoDefaultCurrentDirectoryInExePath: '1' };
}

/**
 * The directories of a search path that name a folder on their own: absolute, and on Windows on a drive. An empty
 * entry means the current folder to a Unix shell, and a relative one is read against it; either would make the program
 * found — and run — depend on where this was started, which is where a download may have saved a stranger's file.
 */
export function absoluteSearchPath(entries: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return entries.filter((entry) =>
    platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(entry) : entry !== '' && path.posix.isAbsolute(entry),
  );
}

/**
 * The program that shows a notification on the person's screen (design 2026-10-19-standing-approvals, S10), named as
 * every other program here is: macOS's `osascript` by its full path; Windows PowerShell by its full path under the
 * Windows folder; on Linux the first `notify-send` that `exists` finds in an absolute entry of `PATH`, since it is no
 * part of the system's own folders everywhere. `null` when there is none — on Linux without one, or a system this names
 * no notifier for.
 */
export async function notifierProgram(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (platform === 'darwin') return '/usr/bin/osascript';
  if (platform === 'win32') return windowsSystemProgram('WindowsPowerShell\\v1.0\\powershell.exe', env);
  if (platform !== 'linux') return null;
  for (const directory of absoluteSearchPath((env.PATH ?? '').split(path.posix.delimiter), platform)) {
    const candidate = path.posix.join(directory, 'notify-send');
    try {
      if (await exists(candidate)) return candidate;
    } catch {
      // Not readable here: not found here.
    }
  }
  return null;
}
