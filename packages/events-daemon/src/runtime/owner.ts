import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { CommsError, openCore, resolvePaths } from '@agentcomms/core';
import { CATALOGUE } from '@agentcomms/events';
import { createGmailEventSource, type GmailEventSource } from '@agentcomms/gmail';
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
import { EventDomainError } from '../domain/lifecycle.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import { MailboxLock } from '../sources/mailbox-lock.ts';
import { openEventDatabase } from '../store/database.ts';
import { openEventSecretStore } from '../store/event-secrets.ts';
import { EventRecordCipher } from '../store/records.ts';
import { ActivationRuntime } from './activations.ts';
import { DryRunDispatcher } from './dispatcher.ts';
import { EventExpiry } from './expiry.ts';
import { EventLifecycle, type EventLifecycleStatus } from './lifecycle.ts';
import { acquireEventOwnerLock, type EventOwnerLock } from './locks.ts';
import { type EventPaths, ensureEventPaths, ensureEventSocketDirectory, eventPaths } from './paths.ts';
import { recoverActivations } from './recovery.ts';
import { replacementIntentSummary } from './replacements.ts';
import { disableRule, removeTarget } from './revocations.ts';

export interface EventOwnerStatus extends EventLifecycleStatus {
  readonly owner: 'running';
  readonly activationIntents: readonly {
    readonly status: string;
    readonly failureCode: string | null;
    readonly count: number;
  }[];
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

export interface EventOwnerOptions {
  readonly stateDir?: string | undefined;
  readonly configDir?: string | undefined;
  /**
   * The Gmail provider boundary for one connected account. Production leaves it unset: the installed Gmail package's
   * own event source, which talks only to Google. An embedding host or a test supplies one — a test must, since the
   * built Gmail package never honours a loopback endpoint override and would reach the real Google.
   */
  readonly gmailSourceFor?:
    | ((input: { readonly accountId: string; readonly alias: string }) => Promise<GmailEventSource>)
    | undefined;
}

export async function startEventOwner(options: EventOwnerOptions = {}): Promise<EventOwner> {
  assertControlSupported();
  const stateDir = options.stateDir ?? resolvePaths().stateDir;
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureEventSocketDirectory(paths);
  assertSocketPathFits(controlEndpoint(paths));
  await verifyPrivateSocketDirectory(paths);
  const lock = await acquireWithStaleRecovery(paths);
  const database = await openEventDatabase({ stateDir });
  const lifecycle = new EventLifecycle(database);
  const core = openCore({
    pathOverrides: {
      stateDir,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    },
  });
  const eventSecrets = await openEventSecretStore({
    database: database.database,
    paths: database.paths,
    configDir: core.paths.configDir,
  });
  const cipher = new EventRecordCipher(database.database, eventSecrets);
  const expiry = new EventExpiry(database);
  const dispatcher = new DryRunDispatcher({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    expiry,
  });
  const mailboxLock = new MailboxLock();
  const activations = new ActivationRuntime({
    store: database,
    approvals: core.approvals,
    config: core.config,
    gmailSourceFor: async (accountId) => {
      const config = await core.config.load();
      const alias = Object.entries(config.inboxes).find(
        ([, inbox]) => inbox.id === accountId && inbox.provider === 'gmail',
      )?.[0];
      if (!alias)
        throw new CommsError('NOT_FOUND', 'the Gmail account bound to this activation is no longer connected');
      // Gmail opens its own context, and so its own core with Gmail's caller, for the same folders: the commands its
      // errors tell a person to run are located from Gmail's installation. Handing it the daemon's core instead fails
      // before the first provider call, since only a suite package may be a caller.
      if (options.gmailSourceFor) return options.gmailSourceFor({ accountId, alias });
      return createGmailEventSource({
        alias,
        pathOverrides: {
          stateDir,
          ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
        },
      });
    },
    encryptBaseline: async (intentId, accountId, position) =>
      cipher.encrypt(
        {
          table: 'activation_baselines',
          column: 'encryptedPosition',
          key: [
            { type: 'text', value: intentId },
            { type: 'text', value: 'gmail' },
            { type: 'text', value: accountId },
            { type: 'text', value: 'mailbox' },
          ],
        },
        Buffer.from(JSON.stringify(position)),
      ),
    mailboxLock,
  });
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
    status: () => ({
      owner: 'running',
      ...lifecycle.status(),
      activationIntents: replacementIntentSummary(database.database),
    }),
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
    expiry.sweep();
    await dispatcher.recoverLeases();
    await recoverActivations(activations);
    await writeToken(paths, token);
    control = await startControlServer({
      endpoint: instance.endpoint,
      token,
      handle: async (request) =>
        handleControl(owner, lifecycle, database.installationId, database, activations, dispatcher, request),
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
export async function runEventOwner(options: EventOwnerOptions = {}): Promise<void> {
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
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  activations: ActivationRuntime,
  dispatcher: DryRunDispatcher,
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
      return activations.prepareEnableAll();
    case 'doctor':
      return { ...owner.status(), protocolVersions: [1], installationId, dryrun: dispatcher.summary() };
    case 'dryrun-list':
      return dispatcher.list();
    case 'dryrun-show':
      return dispatcher.read(requiredText(request.args.deliveryId, 'local delivery id'));
    case 'catalogue-list':
      return CATALOGUE.map((definition) => ({ type: definition.type, version: definition.version }));
    case 'catalogue-show': {
      const type = requiredText(request.args.type, 'catalogue type');
      const definition = CATALOGUE.find((candidate) => candidate.type === type);
      if (!definition) throw new CommsError('NOT_FOUND', 'the requested event type is not in the local catalogue');
      return { type: definition.type, version: definition.version, channel: definition.type.split('.')[0] };
    }
    case 'sources-list':
      return sourceRows(database);
    case 'source-show':
      return sourceShow(database, requiredText(request.args.source, 'source'));
    case 'rules-list':
      return ruleRows(database);
    case 'rule-show':
      return ruleShow(database, requiredText(request.args.ruleId, 'rule id'));
    case 'rule-create':
    case 'rule-update':
      return createRule(database, request.args.document);
    case 'rule-enable':
      return activations.prepareRule({
        ruleId: requiredText(request.args.ruleId, 'rule id'),
        version: requiredVersion(request.args.version, 'rule version'),
      });
    case 'rule-disable':
    case 'rule-remove':
      return disableRule(database, activations, requiredText(request.args.ruleId, 'rule id'));
    case 'targets-list':
      return targetRows(database);
    case 'target-add':
    case 'target-update':
      return createTarget(database, request.args.document);
    case 'target-remove':
      return removeTarget(database, activations, requiredText(request.args.targetId, 'target id'));
    case 'approve-challenge':
      return activations.issueChallenge(requiredText(request.args.approvalId, 'approval id'));
    case 'approve':
      return activations.approve({
        approvalId: requiredText(request.args.approvalId, 'approval id'),
        answer: requiredText(request.args.answer, 'approval answer'),
      });
    default:
      throw new CommsError('USAGE', 'the local event control operation is not recognised');
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CommsError('USAGE', `${name} is required`);
  return value;
}

function requiredVersion(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CommsError('USAGE', `${name} is a positive integer`);
  return value as number;
}

function domain<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof EventDomainError)
      throw new CommsError('BAD_DATA', error.message, { details: { reason: error.code } });
    throw error;
  }
}

function ruleRows(database: Awaited<ReturnType<typeof openEventDatabase>>): unknown[] {
  return database.database
    .prepare(
      'SELECT rule_id, version, digest, state, approval_id, authorization_activation_id FROM rule_versions ORDER BY rule_id, version',
    )
    .all();
}

function ruleShow(database: Awaited<ReturnType<typeof openEventDatabase>>, ruleId: string): unknown[] {
  const rows = database.database
    .prepare(
      'SELECT document, digest, state, approval_id, authorization_activation_id FROM rule_versions WHERE rule_id = ? ORDER BY version',
    )
    .all(ruleId) as Array<{
    document: string;
    digest: string;
    state: string | null;
    approval_id: string | null;
    authorization_activation_id: string | null;
  }>;
  if (rows.length === 0) throw new CommsError('NOT_FOUND', 'the requested rule does not exist');
  return rows.map((row) => ({ ...row, document: JSON.parse(row.document) }));
}

function createRule(database: Awaited<ReturnType<typeof openEventDatabase>>, document: unknown): unknown {
  return domain(() => new ImmutableVersions(database.database).createRule(document));
}

function targetRows(database: Awaited<ReturnType<typeof openEventDatabase>>): unknown[] {
  return database.database
    .prepare('SELECT target_id, version, digest, revoked_at FROM target_versions ORDER BY target_id, version')
    .all();
}

function createTarget(database: Awaited<ReturnType<typeof openEventDatabase>>, document: unknown): unknown {
  return domain(() => new ImmutableVersions(database.database).createTarget(document as never));
}

function sourceRows(database: Awaited<ReturnType<typeof openEventDatabase>>): unknown[] {
  const rows = database.database
    .prepare("SELECT document FROM rule_versions WHERE state IN ('active', 'superseded')")
    .all() as Array<{ document: string }>;
  const accounts = new Set<string>();
  for (const row of rows) {
    const document = JSON.parse(row.document) as { source?: { channel?: string; accountIds?: unknown } };
    if (document.source?.channel !== 'gmail' || !Array.isArray(document.source.accountIds)) continue;
    for (const accountId of document.source.accountIds) if (typeof accountId === 'string') accounts.add(accountId);
  }
  return [...accounts].sort().map((accountId) => ({ source: 'gmail', accountId, cursorScope: 'mailbox' }));
}

function sourceShow(database: Awaited<ReturnType<typeof openEventDatabase>>, source: string): unknown {
  if (source !== 'gmail') throw new CommsError('NOT_FOUND', 'the requested source is not configured');
  return { source, accounts: sourceRows(database) };
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
