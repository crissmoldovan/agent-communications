import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export class EventPathError extends Error {
  readonly code: 'EVENT_PATH_LINK' | 'EVENT_PATH_REPARSE_POINT' | 'EVENT_PATH_PERMISSIONS' | 'EVENT_PATH_TYPE';
  readonly path: string;

  constructor(code: EventPathError['code'], path: string) {
    super(`Event state path is not safe: ${path}`);
    this.name = 'EventPathError';
    this.code = code;
    this.path = path;
  }
}

export interface EventPaths {
  readonly stateDir: string;
  readonly root: string;
  readonly database: string;
  readonly databaseWal: string;
  readonly databaseShm: string;
  readonly lock: string;
  readonly socketDir: string;
  readonly controlToken: string;
  readonly secretsDir: string;
}

export interface EventPathStat {
  readonly mode: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface EventPathIo {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  lstat(path: string): Promise<EventPathStat>;
  chmod(path: string, mode: number): Promise<void>;
  open(path: string, flags: string | number, mode: number): Promise<{ close(): Promise<void> }>;
  isReparsePoint?(path: string): Promise<boolean>;
  isCurrentUserOnly?(path: string): Promise<boolean>;
}

const nodePathIo: EventPathIo = {
  mkdir,
  lstat,
  chmod,
  open,
  async isReparsePoint() {
    return false;
  },
  async isCurrentUserOnly() {
    // Node exposes no ACL reader. Until the Windows-specific owner implementation arrives with the control owner,
    // refusing is safer than accepting a path whose ACL has not been proven current-user-only.
    return false;
  },
};

export function eventPaths(stateDir: string): EventPaths {
  const root = join(stateDir, 'events');
  return {
    stateDir,
    root,
    database: join(root, 'events.sqlite'),
    databaseWal: join(root, 'events.sqlite-wal'),
    databaseShm: join(root, 'events.sqlite-shm'),
    lock: join(root, 'events.lock'),
    socketDir: join(root, 'socket'),
    controlToken: join(root, 'control.token'),
    secretsDir: join(root, 'secrets'),
  };
}

export async function ensureEventPaths(
  paths: EventPaths,
  options: { io?: EventPathIo; platform?: NodeJS.Platform } = {},
): Promise<EventPaths> {
  const io = options.io ?? nodePathIo;
  const platform = options.platform ?? process.platform;
  await ensureOwnerOnlyDirectory(paths.stateDir, { io, platform });
  await ensureOwnerOnlyDirectory(paths.root, { io, platform });
  return paths;
}

export async function ensureOwnerOnlyFile(
  path: string,
  options: { io?: EventPathIo; platform?: NodeJS.Platform } = {},
): Promise<void> {
  const io = options.io ?? nodePathIo;
  const platform = options.platform ?? process.platform;
  let exists = true;
  try {
    await io.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    const noFollow = platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    try {
      const created = await io.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
        FILE_MODE,
      );
      await created.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  await verifyOwnerOnly(path, { io, platform, kind: 'file' });
}

async function ensureOwnerOnlyDirectory(
  path: string,
  options: { io: EventPathIo; platform: NodeJS.Platform },
): Promise<void> {
  await options.io.mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  await verifyOwnerOnly(path, { ...options, kind: 'directory' });
}

async function verifyOwnerOnly(
  path: string,
  options: { io: EventPathIo; platform: NodeJS.Platform; kind: 'directory' | 'file' },
): Promise<void> {
  const info = await options.io.lstat(path);
  if (info.isSymbolicLink()) throw new EventPathError('EVENT_PATH_LINK', path);
  if ((await options.io.isReparsePoint?.(path)) === true) throw new EventPathError('EVENT_PATH_REPARSE_POINT', path);
  if (options.kind === 'directory' && !info.isDirectory()) throw new EventPathError('EVENT_PATH_TYPE', path);
  if (options.kind === 'file' && !info.isFile()) throw new EventPathError('EVENT_PATH_TYPE', path);
  if (options.platform === 'win32') {
    if ((await options.io.isCurrentUserOnly?.(path)) !== true) {
      throw new EventPathError('EVENT_PATH_PERMISSIONS', path);
    }
    return;
  }
  if ((info.mode & 0o077) !== 0) throw new EventPathError('EVENT_PATH_PERMISSIONS', path);
}
