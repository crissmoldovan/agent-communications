import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { CommsError, resolvePaths } from '@agentcomms/core';
import { probeControl } from '../control/client.ts';
import {
  assertControlSupported,
  assertSocketPathFits,
  controlEndpoint,
  verifyControlSocket,
  verifyPrivateSocketDirectory,
} from '../control/endpoint.ts';
import {
  type EventInstanceRecord,
  mayRecoverStaleInstance,
  newInstanceRecord,
  processIsLive,
  readInstance,
  removeInstance,
  writeInstance,
} from '../control/instance.ts';
import type { ControlRequest } from '../control/protocol.ts';
import { type RunningControlServer, startControlServer } from '../control/server.ts';
import { openEventDatabase } from '../store/database.ts';
import { EventLifecycle, type EventLifecycleStatus } from './lifecycle.ts';
import { acquireEventOwnerLock, type EventOwnerLock } from './locks.ts';
import { type EventPaths, ensureEventPaths, ensureEventSocketDirectory, eventPaths } from './paths.ts';

export interface EventOwnerStatus extends EventLifecycleStatus {
  readonly owner: 'running';
}

export interface EventOwner {
  status(): EventOwnerStatus;
  stop(): Promise<void>;
  readonly stopped: Promise<void>;
}

interface StartedOwner extends EventOwner {
  readonly paths: EventPaths;
  readonly instance: EventInstanceRecord;
}

export async function startEventOwner(options: { readonly stateDir?: string | undefined } = {}): Promise<EventOwner> {
  assertControlSupported();
  const stateDir = options.stateDir ?? resolvePaths().stateDir;
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureEventSocketDirectory(paths);
  assertSocketPathFits(controlEndpoint(paths));
  await verifyPrivateSocketDirectory(paths);
  const lock = await acquireWithStaleRecovery(paths);
  const database = await openEventDatabase({ stateDir });
  const lifecycle = new EventLifecycle(database);
  const token = randomBytes(32).toString('hex');
  const instance = newInstanceRecord(controlEndpoint(paths), token);
  let control: RunningControlServer | undefined;
  let stopped = false;
  let settleStopped: () => void = () => undefined;
  const stoppedPromise = new Promise<void>((resolve) => {
    settleStopped = resolve;
  });

  const owner: StartedOwner = {
    paths,
    instance,
    status: () => ({ owner: 'running', ...lifecycle.status() }),
    stopped: stoppedPromise,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await control?.close();
      } finally {
        database.close();
        await removeInstance(paths, instance.instanceId);
        await rm(paths.controlToken, { force: true });
        if (process.platform !== 'win32') await rm(instance.endpoint, { force: true });
        await lock.release();
        settleStopped();
      }
    },
  };

  try {
    await writeToken(paths, token);
    control = await startControlServer({
      endpoint: instance.endpoint,
      token,
      handle: async (request) => handleControl(owner, lifecycle, database.installationId, request),
      verifyEndpoint: () => verifyPrivateSocketDirectory(paths),
    });
    await chmod(instance.endpoint, 0o600);
    await verifyControlSocket(instance.endpoint);
    await writeInstance(paths, instance);
    return owner;
  } catch (error) {
    await owner.stop();
    throw error;
  }
}

/** Runs the owner until a local stop request or a terminal signal closes it cleanly. */
export async function runEventOwner(options: { readonly stateDir?: string | undefined } = {}): Promise<void> {
  const owner = await startEventOwner(options);
  const stop = () => {
    void owner.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await owner.stopped;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await owner.stop();
  }
}

async function handleControl(
  owner: EventOwner,
  lifecycle: EventLifecycle,
  installationId: string,
  request: ControlRequest,
): Promise<unknown> {
  switch (request.operation) {
    case 'status':
      return owner.status();
    case 'stop':
      setTimeout(() => {
        void owner.stop();
      }, 0);
      return { stopping: true };
    case 'pause':
      return lifecycle.pause();
    case 'resume':
      return lifecycle.resume();
    case 'disable-all':
      return lifecycle.disableAll();
    case 'enable-all':
      return lifecycle.enableAll();
    case 'doctor':
      return { ...owner.status(), protocolVersions: [1], installationId };
    default:
      throw new CommsError('USAGE', 'the local event control operation is not recognised');
  }
}

async function acquireWithStaleRecovery(paths: EventPaths): Promise<EventOwnerLock> {
  const first = await acquireEventOwnerLock(paths.lock);
  if (first) return first;
  const record = await readInstance(paths);
  if (!record) throw ownerExists();
  const recoverable = await mayRecoverStaleInstance({
    record,
    isProcessLive: processIsLive,
    ownershipMatches: async () => stateIsOwnedByCurrentUser(paths.instance),
    authenticatedProbe: async (instance) => probeStale(paths, instance),
  });
  if (!recoverable) throw ownerExists();
  await removeStaleFiles(paths, record);
  const recovered = await acquireEventOwnerLock(paths.lock);
  if (!recovered) throw ownerExists();
  return recovered;
}

async function stateIsOwnedByCurrentUser(path: string): Promise<boolean> {
  if (typeof process.getuid !== 'function') return false;
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid();
  } catch {
    return false;
  }
}

async function probeStale(paths: EventPaths, record: EventInstanceRecord): Promise<boolean> {
  try {
    const value = (await readFile(paths.controlToken, 'utf8')).trim();
    return probeControl(paths, record, value);
  } catch {
    return false;
  }
}

async function removeStaleFiles(paths: EventPaths, record: EventInstanceRecord): Promise<void> {
  const current = await readInstance(paths);
  if (current?.instanceId !== record.instanceId) throw ownerExists();
  if (process.platform !== 'win32') await rm(record.endpoint, { force: true });
  await rm(paths.controlToken, { force: true });
  await rm(paths.instance, { force: true });
  await rm(paths.lock, { force: true });
}

async function writeToken(paths: EventPaths, token: string): Promise<void> {
  await writeFile(paths.controlToken, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(paths.controlToken, 0o600);
}

function ownerExists(): CommsError {
  return new CommsError('CONFIG', 'another local event service owner is already running', {
    hint: 'Stop the existing local event service before starting another owner.',
  });
}
