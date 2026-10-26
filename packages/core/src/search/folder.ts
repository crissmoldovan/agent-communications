import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, FILE_MODE } from '../fs.ts';
import { childEnvironment } from '../system-programs.ts';

/**
 * Where Search keeps what it keeps (design 2026-10-26-local-search §4, S11): `<state>/search/`, owner-only — the
 * folder 700, every file 600 — holding `search.sqlite` with its WAL, `inbox/` of encrypted captures, and the locks.
 * On Windows the state folder is under `%LOCALAPPDATA%` already (`paths.ts`).
 *
 * On macOS the folder is excluded from Time Machine with `tmutil addexclusion` (sticky, the default kind): a backup
 * would otherwise outlive retention and Delete everything. Done once per folder — the marker beside it says so — and
 * again for a folder made after Delete everything. Doctor and `search status` read FileVault's state with
 * `fdesetup status`. Neither is checked on Windows or Linux, and both say so. Each program is started by its full path.
 */

export interface SearchPaths {
  readonly dir: string;
  readonly database: string;
  readonly inbox: string;
  /** One index run at a time. */
  readonly indexLock: string;
  /** One master made at a time. */
  readonly keyLock: string;
  /** Delete everything's word to a run in progress: stop at the next batch. */
  readonly stop: string;
  /** This folder has been excluded from Time Machine. */
  readonly excluded: string;
}

export function searchPaths(stateDir: string): SearchPaths {
  const dir = join(stateDir, 'search');
  return {
    dir,
    database: join(dir, 'search.sqlite'),
    inbox: join(dir, 'inbox'),
    indexLock: join(dir, 'index.lock'),
    keyLock: join(dir, 'key.lock'),
    stop: join(dir, '.stop'),
    excluded: join(dir, '.backup-excluded'),
  };
}

/** Runs one system program by its full path, and what it said. Injected by tests: CI runs only stand-ins. */
export type SystemRunner = (
  program: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: string }>;

export const systemRunner: SystemRunner = (program, args) =>
  new Promise((resolve) => {
    execFile(
      program,
      [...args],
      { timeout: 5_000, env: childEnvironment(process.env), windowsHide: true },
      (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stdout: String(stdout) });
      },
    );
  });

/** What the platform is and how its programs run: the process's own unless a test brings stand-ins. */
export interface SearchSystem {
  readonly platform: NodeJS.Platform;
  readonly run: SystemRunner;
}

export const TMUTIL = '/usr/bin/tmutil';
export const FDESETUP = '/usr/bin/fdesetup';

export type BackupState = 'excluded' | 'not-excluded' | 'not-checked' | 'unknown';
export type DiskEncryptionState = 'on' | 'off' | 'not-checked' | 'unknown';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes the folder, private, and on macOS excludes it from Time Machine once. Says where backups stand: `excluded`,
 * `not-excluded` when `tmutil` refused (it is tried again next time), `not-checked` elsewhere.
 */
export async function ensureSearchFolder(paths: SearchPaths, system: SearchSystem): Promise<BackupState> {
  await ensurePrivateDir(paths.dir);
  if (system.platform !== 'darwin') return 'not-checked';
  if (await exists(paths.excluded)) return 'excluded';
  const ran = await system.run(TMUTIL, ['addexclusion', paths.dir]);
  if (ran.code !== 0) return 'not-excluded';
  const marker = await open(paths.excluded, 'a', FILE_MODE);
  await marker.close();
  return 'excluded';
}

/** Whether Time Machine leaves the folder out, as `tmutil isexcluded` says; `not-checked` off macOS. */
export async function backupState(paths: SearchPaths, system: SearchSystem): Promise<BackupState> {
  if (system.platform !== 'darwin') return 'not-checked';
  if (!(await exists(paths.dir))) return 'unknown';
  const ran = await system.run(TMUTIL, ['isexcluded', paths.dir]);
  if (ran.code !== 0) return 'unknown';
  if (/\[Excluded\]/.test(ran.stdout)) return 'excluded';
  if (/\[Included\]/.test(ran.stdout)) return 'not-excluded';
  return 'unknown';
}

/** Whether FileVault is on, as `fdesetup status` says; `not-checked` off macOS. */
export async function diskEncryptionState(system: SearchSystem): Promise<DiskEncryptionState> {
  if (system.platform !== 'darwin') return 'not-checked';
  const ran = await system.run(FDESETUP, ['status']);
  if (ran.code !== 0) return 'unknown';
  if (/FileVault is On/.test(ran.stdout)) return 'on';
  if (/FileVault is Off/.test(ran.stdout)) return 'off';
  return 'unknown';
}

/** Whether the folder can be read by anyone but its owner (POSIX only); null when there is no folder. */
export async function folderIsShared(paths: SearchPaths): Promise<boolean | null> {
  try {
    const info = await stat(paths.dir);
    return process.platform !== 'win32' && (info.mode & 0o077) !== 0;
  } catch {
    return null;
  }
}
