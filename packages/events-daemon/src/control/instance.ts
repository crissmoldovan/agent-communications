import { createHash, randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { EventPaths } from '../runtime/paths.ts';

export interface EventInstanceRecord {
  readonly instanceId: string;
  readonly pid: number;
  readonly processStart: string;
  readonly endpoint: string;
  readonly tokenFingerprint: string;
}

export interface StaleInstanceCheck {
  readonly record: EventInstanceRecord;
  readonly isProcessLive: (record: EventInstanceRecord) => Promise<boolean>;
  readonly authenticatedProbe: (record: EventInstanceRecord) => Promise<boolean>;
  readonly ownershipMatches: (record: EventInstanceRecord) => Promise<boolean>;
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newInstanceRecord(endpoint: string, token: string): EventInstanceRecord {
  return {
    instanceId: randomBytes(16).toString('hex'),
    pid: process.pid,
    processStart: `${process.pid}:${Math.trunc(process.uptime() * 1_000)}`,
    endpoint,
    tokenFingerprint: tokenFingerprint(token),
  };
}

export async function mayRecoverStaleInstance(check: StaleInstanceCheck): Promise<boolean> {
  if (!(await check.ownershipMatches(check.record))) return false;
  if (await check.isProcessLive(check.record)) return false;
  return !(await check.authenticatedProbe(check.record));
}

export async function readInstance(paths: EventPaths): Promise<EventInstanceRecord | null> {
  let text: string;
  try {
    text = await readFile(paths.instance, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isInstanceRecord(parsed)) throw new Error('invalid local event instance record');
    return parsed;
  } catch {
    throw new Error(`invalid local event instance record ${basename(paths.instance)}`);
  }
}

export async function writeInstance(paths: EventPaths, record: EventInstanceRecord): Promise<void> {
  // A reader polling for readiness must never see a truncated or half-written record, so it is written beside the
  // record and renamed over it, which replaces it in one step.
  const staged = `${paths.instance}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(staged, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(staged, 0o600);
    await rename(staged, paths.instance);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
}

export async function removeInstance(paths: EventPaths, instanceId: string): Promise<void> {
  const record = await readInstance(paths);
  if (record?.instanceId === instanceId) await rm(paths.instance, { force: true });
}

export async function processIsLive(record: EventInstanceRecord): Promise<boolean> {
  try {
    process.kill(record.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isInstanceRecord(value: unknown): value is EventInstanceRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.instanceId === 'string' &&
    /^[0-9a-f]{32}$/.test(record.instanceId) &&
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.processStart === 'string' &&
    record.processStart.length > 0 &&
    typeof record.endpoint === 'string' &&
    record.endpoint.length > 0 &&
    typeof record.tokenFingerprint === 'string' &&
    /^[0-9a-f]{64}$/.test(record.tokenFingerprint)
  );
}
