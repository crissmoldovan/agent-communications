import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Who listens on the relay's port, asked of the system before the relay's control token is sent (security review of
 * 0.33.0, finding 8). The token is the person's; a loopback port is anyone's to bind while the relay is not running, so
 * the token goes only to a port that this user's own process listens on.
 *
 * macOS: `lsof`, at its absolute path, with no shell, lists the listening sockets on the port; run as this user it shows
 * only this user's processes, so a port that only another user listens on shows none. Linux: `/proc/net/tcp` and
 * `/proc/net/tcp6` give each listening socket's owner. Windows, and any other system, is unattested: the token is sent
 * as before, and the README says so.
 */
export type ListenerOwners =
  | { readonly kind: 'owners'; readonly uids: readonly number[] }
  | { readonly kind: 'unattested'; readonly platform: string };

/** Looks up who listens on a loopback TCP port. A seam for tests; the default asks the system. */
export type ListenerAttestor = (port: number) => Promise<ListenerOwners>;

const LSOF = '/usr/sbin/lsof';
const LOOKUP_MS = 5_000;
const MAX_LOOKUP_OUTPUT = 256 * 1024;
const PROC_NET_TABLES = Object.freeze(['/proc/net/tcp', '/proc/net/tcp6']);
/** `/proc/net/tcp`'s `st` for a listening socket. */
const TCP_LISTEN = '0A';

/** The owner uid of each process in `lsof -F u` output: its `u` lines. */
export function parseLsofOwners(output: string): number[] {
  const uids: number[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('u')) continue;
    const uid = Number(line.slice(1));
    if (Number.isSafeInteger(uid) && uid >= 0) uids.push(uid);
  }
  return uids;
}

/** The owner uid of each socket listening on `port` in a `/proc/net/tcp` or `/proc/net/tcp6` table. */
export function parseProcNetTcp(table: string, port: number): number[] {
  const uids: number[] = [];
  for (const line of table.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 8) continue;
    const local = fields[1] ?? '';
    const colon = local.lastIndexOf(':');
    if (colon === -1 || fields[3] !== TCP_LISTEN) continue;
    if (Number.parseInt(local.slice(colon + 1), 16) !== port) continue;
    const uid = Number(fields[7]);
    if (Number.isSafeInteger(uid) && uid >= 0) uids.push(uid);
  }
  return uids;
}

function lsofListeners(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      LSOF,
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fu'],
      { timeout: LOOKUP_MS, maxBuffer: MAX_LOOKUP_OUTPUT, env: {}, windowsHide: true },
      (error, stdout) => {
        // lsof exits 1 when nothing matches: no listener this user can see.
        if (error === null || (typeof error.code === 'number' && error.code === 1)) resolve(String(stdout));
        else reject(error);
      },
    );
  });
}

/** The system's answer: the owners of the sockets listening on `port`, or unattested where it cannot be asked. */
export async function listenerOwners(
  port: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ListenerOwners> {
  if (platform === 'darwin') return { kind: 'owners', uids: parseLsofOwners(await lsofListeners(port)) };
  if (platform === 'linux') {
    const tables = await Promise.all(PROC_NET_TABLES.map((path) => readFile(path, 'utf8').catch(() => '')));
    return { kind: 'owners', uids: tables.flatMap((table) => parseProcNetTcp(table, port)) };
  }
  return { kind: 'unattested', platform };
}

/**
 * Whether the relay's control token may go to `port`: something listens on it, and every listener the system shows
 * is this user's. Unattested systems say yes, as the README says.
 */
export function listenersAreYours(owners: ListenerOwners, uid: number | undefined): boolean {
  if (owners.kind === 'unattested' || uid === undefined) return true;
  return owners.uids.length > 0 && owners.uids.every((owner) => owner === uid);
}
