import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CONNECTION_ID_PATTERN } from '../connections.ts';
import { writeFileAtomic } from '../fs.ts';
import type { PartStatus } from './router.ts';

/**
 * A running gateway's status file (single-server design §4, "Status"): `<state>/gateway/<connection>.<pid>.json`,
 * owner-only. It holds the gateway's start, the client's name and each part's state, pid, version, since when, and how
 * it ended — nothing else: never a part's log line, which can carry sender text, and never the key. Its pid names it;
 * one whose process has gone is ignored. Read by `connection show`, the doctor and the app.
 *
 * Beside it, `<connection>.used.json` says when the connection last served a call, for "last used".
 */

export interface GatewayStatus {
  readonly connection: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly client: { readonly name: string; readonly version?: string | undefined } | null;
  /** Why the gateway serves nothing, when it does not: cut off, removed, its key not the connection's. */
  readonly refused: string | null;
  readonly parts: readonly PartStatus[];
}

export function gatewayDir(stateDir: string): string {
  return join(stateDir, 'gateway');
}

export function statusFile(stateDir: string, connection: string, pid: number = process.pid): string {
  return join(gatewayDir(stateDir), `${connection}.${pid}.json`);
}

function usedFile(stateDir: string, connection: string): string {
  return join(gatewayDir(stateDir), `${connection}.used.json`);
}

export async function writeGatewayStatus(stateDir: string, status: GatewayStatus): Promise<void> {
  await writeFileAtomic(statusFile(stateDir, status.connection, status.pid), `${JSON.stringify(status, null, 2)}\n`);
}

export async function removeGatewayStatus(
  stateDir: string,
  connection: string,
  pid: number = process.pid,
): Promise<void> {
  await rm(statusFile(stateDir, connection, pid), { force: true });
}

/** Records that the connection served a call now. */
export async function markConnectionUsed(stateDir: string, connection: string, at: Date = new Date()): Promise<void> {
  await writeFileAtomic(usedFile(stateDir, connection), `${JSON.stringify({ at: at.toISOString() })}\n`);
}

/** When the connection last served a call, or null when it never has here. */
export async function connectionLastUsed(stateDir: string, connection: string): Promise<string | null> {
  try {
    const held = JSON.parse(await readFile(usedFile(stateDir, connection), 'utf8')) as { at?: unknown };
    return typeof held.at === 'string' && !Number.isNaN(Date.parse(held.at)) ? held.at : null;
  } catch {
    return null;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** The gateways running now for `connection`, from their status files; a file whose process has gone is ignored. */
export async function runningGateways(stateDir: string, connection: string): Promise<GatewayStatus[]> {
  if (!CONNECTION_ID_PATTERN.test(connection)) return [];
  let names: string[];
  try {
    names = await readdir(gatewayDir(stateDir));
  } catch {
    return [];
  }
  const found: GatewayStatus[] = [];
  for (const name of names) {
    const match = /^(cn_[0-9A-HJKMNP-TV-Z]{26})\.([1-9][0-9]{0,9})\.json$/.exec(name);
    if (match === null || match[1] !== connection) continue;
    const pid = Number(match[2]);
    if (!alive(pid)) continue;
    try {
      const held = JSON.parse(await readFile(join(gatewayDir(stateDir), name), 'utf8')) as GatewayStatus;
      if (held.pid === pid && held.connection === connection && Array.isArray(held.parts)) found.push(held);
    } catch {
      // A file being written, or not one of ours: ignored.
    }
  }
  return found;
}
