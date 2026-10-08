import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CommsError } from '@agentcomms/core';
import type { EventPaths } from '../runtime/paths.ts';

/**
 * Who may reach the local control socket (plan amendment B1-G, committee K5).
 *
 * D12 asks the daemon to verify that a connecting peer has the same uid. Node offers no peer-credential call, so the
 * boundary is the one the kernel enforces on every Unix-domain connect: search permission on each directory of the
 * socket's path. The socket lives in a directory that must be a real directory owned by this uid with mode 0700, under
 * ancestors no other user can rename or replace, and the socket itself is owned by this uid with mode 0600. That admits
 * only this uid and root — and root can impersonate any uid, so a peer-credential check would not exclude it either.
 * The owner verifies it when it listens and again for every connection it accepts; a client verifies it before it
 * sends the token. The random token is the second check, as D12 says.
 *
 * Windows has no equivalent in Node: a named pipe cannot be given an ACL, its namespace is global, and another local
 * user could create the pipe first and receive a client's token. Until an owner that can set the pipe's ACL exists,
 * the event service does not run on Windows and no Windows client sends a token.
 */

export interface EndpointStat {
  readonly mode: number;
  readonly uid: number;
  isDirectory(): boolean;
  isSocket(): boolean;
  isSymbolicLink(): boolean;
}

export interface EndpointIo {
  lstat(path: string): Promise<EndpointStat>;
  realpath(path: string): Promise<string>;
}

export interface EndpointOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly uid?: number | undefined;
  readonly io?: EndpointIo | undefined;
}

const nodeEndpointIo: EndpointIo = { lstat, realpath };

/** The longest Unix socket path the platform's `sun_path` holds, in bytes, leaving room for its terminating NUL. */
export function maxSocketPathBytes(platform: NodeJS.Platform = process.platform): number {
  return platform === 'linux' || platform === 'android' ? 107 : 103;
}

/** The control endpoint for this state directory. */
export function controlEndpoint(paths: EventPaths, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return paths.controlSocket;
  // Kept so a later ACL-capable owner names the same pipe; the full digest, so two users' paths never share a name.
  return `\\\\.\\pipe\\agent-communications-events-${createHash('sha256').update(paths.root).digest('hex')}`;
}

/** Refuses on a platform where the control boundary D12 requires cannot be built. */
export function assertControlSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') return;
  throw new CommsError('CONFIG', 'the local event service does not run on Windows in this release', {
    hint: 'Its control channel needs a named pipe that only your Windows account can open, which Node cannot create. Run it on macOS or Linux for now.',
    details: { reason: 'WINDOWS_CONTROL_UNAVAILABLE' },
  });
}

function refused(reason: string, path: string, message: string): CommsError {
  return new CommsError('CONFIG', message, {
    hint: 'Pin a private state directory with --state-dir, one only your account can reach, and run it again.',
    details: { reason, path },
  });
}

function currentUid(options: EndpointOptions): number {
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);
  if (uid === undefined) {
    throw new CommsError('CONFIG', 'this platform reports no user id for the local event service to check');
  }
  return uid;
}

/** The socket path fits the platform's limit, or a named refusal — never a silently truncated path. */
export function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform = process.platform): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8');
  if (bytes <= maxSocketPathBytes(platform)) return;
  throw new CommsError(
    'CONFIG',
    `the local event control socket path is ${bytes} bytes; this system allows ${maxSocketPathBytes(platform)}`,
    {
      hint: 'Pin a shorter state directory with --state-dir and run it again.',
      details: { reason: 'SOCKET_PATH_TOO_LONG', bytes, limit: maxSocketPathBytes(platform) },
    },
  );
}

/**
 * The socket directory is a real directory owned by this uid with mode 0700, and every ancestor is owned by this uid
 * or root and is either not writable by others or sticky — so nobody else can reach, rename or replace it.
 */
export async function verifyPrivateSocketDirectory(paths: EventPaths, options: EndpointOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  assertControlSupported(platform);
  const io = options.io ?? nodeEndpointIo;
  const uid = currentUid(options);
  const directory = paths.socketDir;
  const info = await statOrRefuse(io, directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw refused('SOCKET_DIRECTORY_NOT_DIRECTORY', directory, 'the local event socket directory is not a directory');
  }
  if (info.uid !== uid) {
    throw refused('SOCKET_DIRECTORY_OWNER', directory, 'the local event socket directory belongs to another user');
  }
  if ((info.mode & 0o777) !== 0o700) {
    throw refused('SOCKET_DIRECTORY_MODE', directory, 'the local event socket directory is reachable by other users');
  }
  // The ancestors the kernel actually walks: a symlinked one (macOS's /var) is checked at its target.
  for (let ancestor = await io.realpath(dirname(directory)); ; ancestor = dirname(ancestor)) {
    const parent = await statOrRefuse(io, ancestor);
    if (parent.uid !== uid && parent.uid !== 0) {
      throw refused(
        'SOCKET_ANCESTOR_OWNER',
        ancestor,
        'a directory above the local event socket belongs to another user',
      );
    }
    if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) {
      throw refused(
        'SOCKET_ANCESTOR_WRITABLE',
        ancestor,
        'a directory above the local event socket can be changed by other users',
      );
    }
    if (dirname(ancestor) === ancestor) break;
  }
}

/** The socket itself is this uid's, mode 0600, and a socket — checked by a client before it sends the token. */
export async function verifyControlSocket(socketPath: string, options: EndpointOptions = {}): Promise<void> {
  const io = options.io ?? nodeEndpointIo;
  const uid = currentUid(options);
  const info = await statOrRefuse(io, socketPath);
  if (info.isSymbolicLink() || !info.isSocket()) {
    throw refused('SOCKET_NOT_SOCKET', socketPath, 'the local event control endpoint is not a socket');
  }
  if (info.uid !== uid)
    throw refused('SOCKET_OWNER', socketPath, 'the local event control socket belongs to another user');
  if ((info.mode & 0o077) !== 0) {
    throw refused('SOCKET_MODE', socketPath, 'the local event control socket is reachable by other users');
  }
}

async function statOrRefuse(io: EndpointIo, path: string): Promise<EndpointStat> {
  try {
    return await io.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommsError('NOT_FOUND', 'the local event service is not running', {
        hint: 'Start the local event service in a terminal before requesting its runtime controls.',
      });
    }
    throw error;
  }
}
