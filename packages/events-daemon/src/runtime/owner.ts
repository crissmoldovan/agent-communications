import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { CommsError, openCore, resolvePaths } from '@agentcomms/core';
import { CATALOGUE } from '@agentcomms/events';
import { createGmailEventSource, type GmailEventSource } from '@agentcomms/gmail';
import { createResendEventReaderForPaths, type ResendEventReader } from '@agentcomms/resend';
import { openSlackEventSourceForPaths, type SlackEventSource } from '@agentcomms/slack';
import { openWhatsAppEventOperations, type WhatsAppEventOperations } from '@agentcomms/whatsapp';
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
import { type LocalEventSourceRegistry, phaseDSourceRegistry } from '../sources/registry.ts';
import { ResendReceivedStageExpiry } from '../sources/resend.ts';
import { advanceResendStatusHighWater, ResendStatusStageExpiry } from '../sources/resend-status.ts';
import { SourceScopeLock } from '../sources/scope-lock.ts';
import { SlackHistoryStageExpiry } from '../sources/slack.ts';
import { SlackReplyStageExpiry } from '../sources/slack-replies.ts';
import { GmailStageExpiry, type GmailStageRecord } from '../sources/source-worker.ts';
import { openEventDatabase } from '../store/database.ts';
import { openEventSecretStore } from '../store/event-secrets.ts';
import { EventRecordCipher } from '../store/records.ts';
import { ActivationRuntime } from './activations.ts';
import { DeliveryDispatcher, DryRunDispatcher } from './dispatcher.ts';
import { EventExpiry, SourceStageExpiryGroup } from './expiry.ts';
import { EventLifecycle, type EventLifecycleStatus } from './lifecycle.ts';
import { acquireEventOwnerLock, type EventOwnerLock } from './locks.ts';
import { type EventPaths, ensureEventPaths, ensureEventSocketDirectory, eventPaths } from './paths.ts';
import { createB2RetainedContentParticipants } from './phase-d-b2-retention.ts';
import {
  createPhaseDWhatsAppOwnerComposition,
  requirePhaseDWhatsAppVisibilitySeam,
} from './phase-d-whatsapp-owner-composition.ts';
import { recoverActivations } from './recovery.ts';
import { GmailReplacementDrains, replacementIntentSummary } from './replacements.ts';
import { disableRule, removeTarget } from './revocations.ts';
import { EventScheduler } from './scheduler.ts';
import { runSourceOwnerWork, stageWhatsAppBaselineSnapshot } from './source-owner-work.ts';
import { SseDispatcher } from './sse-dispatcher.ts';
import { WebhookDispatcher } from './webhook-dispatcher.ts';

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
  /** Runs one serial owner tick; intended for deterministic local embedding and tests. */
  tick(): Promise<void>;
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
  /** Every Phase-D provider boundary is injectable; tests supply sealed fakes and never reach a real provider. */
  readonly slackSourceFor?:
    | ((input: { readonly accountId: string; readonly alias: string }) => Promise<SlackEventSource>)
    | undefined;
  readonly resendReaderFor?:
    | ((input: { readonly accountId: string; readonly alias: string }) => Promise<ResendEventReader>)
    | undefined;
  readonly whatsappEventOperations?: WhatsAppEventOperations | undefined;
  /** Test seam only: replaces D's composition so the missing-seam refusal can be proven on the real start path. */
  readonly phaseDComposition?: typeof createPhaseDWhatsAppOwnerComposition | undefined;
  readonly tickMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  /** Test/embedding clock; every status P sample must use the same injected clock as the owner loop. */
  readonly now?: (() => number) | undefined;
}

export async function startEventOwner(options: EventOwnerOptions = {}): Promise<EventOwner> {
  assertControlSupported();
  const stateDir = options.stateDir ?? resolvePaths().stateDir;
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureEventSocketDirectory(paths);
  assertSocketPathFits(controlEndpoint(paths));
  await verifyPrivateSocketDirectory(paths);
  const lock = await acquireWithStaleRecovery(paths);
  const started = { owner: false };
  let opened: { close(): void } | undefined;
  try {
    return await startOwnerWithLock(options, stateDir, paths, lock, started, (database) => {
      opened = database;
    });
  } catch (error) {
    // A start refused before the owner existed — a database, secret-store, composition or seam failure — releases
    // what it took, so the next start is not blocked by this process; once the owner exists its stop() does that.
    if (!started.owner) {
      opened?.close();
      await lock.release();
    }
    throw error;
  }
}

async function startOwnerWithLock(
  options: EventOwnerOptions,
  stateDir: string,
  paths: EventPaths,
  lock: EventOwnerLock,
  started: { owner: boolean },
  onDatabase: (database: { close(): void }) => void,
): Promise<EventOwner> {
  const database = await openEventDatabase({ stateDir });
  onDatabase(database);
  const now = options.now ?? Date.now;
  const lifecycle = new EventLifecycle(database, now);
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
  const sourceRegistry = phaseDSourceRegistry();
  // The concrete WhatsApp visibility fence is constructed in every production owner (D Task 7).
  const whatsappEventOperations =
    options.whatsappEventOperations ?? openWhatsAppEventOperations({ configDir: core.paths.configDir });
  const whatsappComposition = (options.phaseDComposition ?? createPhaseDWhatsAppOwnerComposition)({
    database,
    eventOperations: whatsappEventOperations,
    createRetainedContentParticipants: createB2RetainedContentParticipants,
  });
  // D7: with D's WhatsApp source registered, a missing concrete fence refuses start here — before any dispatcher,
  // scheduler or listener exists — and never falls back to B2's pre-D pass-through gate.
  requirePhaseDWhatsAppVisibilitySeam({
    hasWhatsAppSource: sourceRegistry.sources().includes('whatsapp'),
    visibilityFence: whatsappComposition.visibilityFence,
  });
  const mailboxLock = new MailboxLock(new SourceScopeLock());
  const replacementDrains = new GmailReplacementDrains({
    database: database.database,
    decryptPosition: async (input) =>
      JSON.parse(
        (
          await cipher.decrypt(
            input.table === 'activation_baselines'
              ? {
                  table: 'activation_baselines',
                  column: 'encryptedPosition',
                  key: [
                    { type: 'text', value: input.activationId },
                    { type: 'text', value: 'gmail' },
                    { type: 'text', value: input.accountId },
                    { type: 'text', value: input.positionScope },
                  ],
                }
              : {
                  table: 'rule_activation_points',
                  column: 'encryptedPosition',
                  key: [
                    { type: 'text', value: input.activationId },
                    { type: 'text', value: input.ruleId as string },
                    { type: 'integer', value: input.ruleVersion as number },
                    { type: 'text', value: input.accountId },
                    { type: 'text', value: input.positionScope },
                  ],
                },
            input.record,
          )
        ).toString('utf8'),
      ),
  });
  const decryptSourceStage = async (stored: Uint8Array, stageId: string): Promise<unknown> =>
    JSON.parse(
      (
        await cipher.decrypt(
          { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: stageId }] },
          stored,
        )
      ).toString('utf8'),
    );
  const encryptSourceStage = async (value: unknown, stageId: string): Promise<Uint8Array> =>
    cipher.encrypt(
      { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: stageId }] },
      Buffer.from(JSON.stringify(value)),
    );
  const sourceStageExpiry = new SourceStageExpiryGroup([
    new GmailStageExpiry({
      store: database,
      mailboxLock,
      decryptStage: async (stored, stageId): Promise<GmailStageRecord> =>
        (await decryptSourceStage(stored, stageId)) as GmailStageRecord,
      encryptStage: encryptSourceStage,
      replacementDrains,
      now,
    }),
    new SlackHistoryStageExpiry({
      store: database,
      lock: mailboxLock.sourceScopeLock,
      decrypt: decryptSourceStage,
      encrypt: encryptSourceStage,
      now,
    }),
    new SlackReplyStageExpiry({
      database: database.database,
      lock: mailboxLock.sourceScopeLock,
      decrypt: decryptSourceStage,
      encrypt: encryptSourceStage,
      now,
    }),
    new ResendReceivedStageExpiry({
      store: database,
      lock: mailboxLock.sourceScopeLock,
      decrypt: decryptSourceStage,
      encrypt: encryptSourceStage,
      now,
    }),
    new ResendStatusStageExpiry({
      store: database,
      lock: mailboxLock.sourceScopeLock,
      decrypt: decryptSourceStage,
      now,
    }),
  ]);
  const expiry = new EventExpiry(database, now, sourceStageExpiry);
  const dryrun = new DryRunDispatcher({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    expiry,
    now,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
  });
  const webhook = new WebhookDispatcher({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
    hasConcreteWhatsAppVisibilityFence: true,
    now,
    secretReader: async ({ targetId, targetVersion, targetDigest, purpose }) =>
      (
        await eventSecrets.readLiveGenerations({
          owner: { kind: 'target', id: targetId, version: targetVersion, digest: targetDigest },
          purpose,
          cipher,
        })
      ).map(({ generation, lifecycle, secretDigest, material }) => ({
        generation,
        lifecycle,
        secretDigest,
        material,
      })),
  });
  const sse = new SseDispatcher({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    visibilityGate: whatsappComposition.visibilityFence,
    hasConcreteWhatsAppVisibilityFence: true,
    retentionHooks: whatsappComposition.retainedContentHooks,
    now,
  });
  const dispatcher = new DeliveryDispatcher({
    store: database,
    dryrun,
    webhook,
    sse,
  });
  const gmailSourceFor = async (accountId: string): Promise<GmailEventSource> => {
    const config = await core.config.load();
    const alias = Object.entries(config.inboxes).find(
      ([, inbox]) => inbox.id === accountId && inbox.provider === 'gmail',
    )?.[0];
    if (!alias)
      throw new CommsError('NOT_FOUND', 'the Gmail account bound to this activation is no longer connected', {
        details: { reason: 'ACCOUNT_REMOVED', accountId },
      });
    // Gmail opens its own context, and so its own core with Gmail's caller, for the same folders: the commands its
    // errors tell a person to run are located from Gmail's installation. Handing it the daemon's core instead fails
    // before the first provider call, since only a suite package may be a caller.
    const source = options.gmailSourceFor
      ? await options.gmailSourceFor({ accountId, alias })
      : await createGmailEventSource({
          alias,
          pathOverrides: {
            stateDir,
            ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
          },
        });
    if (source.inboxId !== accountId)
      throw new CommsError('CONFIG', 'the Gmail event source resolved a different stable mailbox id', {
        details: { reason: 'ACCOUNT_CHANGED', accountId, source: 'gmail' },
      });
    return source;
  };
  const sourceAliasFor = async (source: 'slack' | 'resend' | 'whatsapp', accountId: string): Promise<string> => {
    const config = await core.config.load();
    const alias = Object.entries(config.accounts).find(
      ([, account]) => account.id === accountId && account.platform === source,
    )?.[0];
    if (!alias)
      throw new CommsError('NOT_FOUND', 'the event account bound to this source is no longer connected', {
        details: { reason: 'ACCOUNT_REMOVED', accountId, source },
      });
    return alias;
  };
  const slackSourceFor = async (accountId: string): Promise<SlackEventSource> => {
    const alias = await sourceAliasFor('slack', accountId);
    const source = options.slackSourceFor
      ? await options.slackSourceFor({ accountId, alias })
      : await openSlackEventSourceForPaths({
          alias,
          pathOverrides: { stateDir, ...(options.configDir === undefined ? {} : { configDir: options.configDir }) },
        });
    if (source.accountId !== accountId)
      throw new CommsError('CONFIG', 'the Slack event source resolved a different stable account id', {
        details: { reason: 'ACCOUNT_CHANGED', accountId, source: 'slack' },
      });
    return source;
  };
  const resendReaderFor = async (accountId: string): Promise<ResendEventReader> => {
    const alias = await sourceAliasFor('resend', accountId);
    if (options.resendReaderFor) return options.resendReaderFor({ accountId, alias });
    return createResendEventReaderForPaths({
      account: alias,
      accountId,
      pathOverrides: { stateDir, ...(options.configDir === undefined ? {} : { configDir: options.configDir }) },
    });
  };
  const activations = new ActivationRuntime({
    store: database,
    approvals: core.approvals,
    config: core.config,
    gmailSourceFor,
    sourceStageExpiry,
    sourceBaselineFor: async ({ source, accountId, scopeId }) => {
      if (source === 'gmail') {
        const profile = await (await gmailSourceFor(accountId)).getProfile();
        return { historyId: profile.historyId };
      }
      if (source === 'slack') {
        const conversationId = scopeId.slice(`slack:${accountId}:`.length);
        const page = await (await slackSourceFor(accountId)).history({
          conversationId,
          oldest: '0.000000',
          latest: '9999999999.999999',
          limit: 1,
        });
        const timestamp = page.messages[0]?.ts ?? '0.000000';
        return { timestamp, replyDrain: { through: timestamp, topLevelCovered: false } };
      }
      if (source === 'resend') {
        const reader = await resendReaderFor(accountId);
        if (scopeId === 'received') return { anchorId: (await reader.listReceived()).emails[0]?.id ?? 'empty' };
        return advanceResendStatusHighWater(database, accountId, now());
      }
      return stageWhatsAppBaselineSnapshot(
        {
          store: database,
          cipher,
          sourceRegistry,
          whatsappEventOperations,
          whatsappVisibilityFence: whatsappComposition.visibilityFence,
        },
        accountId,
      );
    },
    encryptBaseline: async (intentId, accountId, position, scope) =>
      cipher.encrypt(
        {
          table: 'activation_baselines',
          column: 'encryptedPosition',
          key: [
            { type: 'text', value: intentId },
            { type: 'text', value: scope?.source ?? 'gmail' },
            { type: 'text', value: accountId },
            { type: 'text', value: scope?.scopeId ?? 'mailbox' },
          ],
        },
        Buffer.from(JSON.stringify(position)),
      ),
    decryptBaseline: async (intentId, accountId, stored, scope) =>
      JSON.parse(
        (
          await cipher.decrypt(
            {
              table: 'activation_baselines',
              column: 'encryptedPosition',
              key: [
                { type: 'text', value: intentId },
                { type: 'text', value: scope?.source ?? 'gmail' },
                { type: 'text', value: accountId },
                { type: 'text', value: scope?.scopeId ?? 'mailbox' },
              ],
            },
            stored,
          )
        ).toString('utf8'),
      ),
    encryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, position }) =>
      cipher.encrypt(
        {
          table: 'rule_activation_points',
          column: 'encryptedPosition',
          key: [
            { type: 'text', value: activationId },
            { type: 'text', value: ruleId },
            { type: 'integer', value: ruleVersion },
            { type: 'text', value: accountId },
            { type: 'text', value: positionScope },
          ],
        },
        Buffer.from(JSON.stringify(position)),
      ),
    decryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, stored }) =>
      JSON.parse(
        (
          await cipher.decrypt(
            {
              table: 'rule_activation_points',
              column: 'encryptedPosition',
              key: [
                { type: 'text', value: activationId },
                { type: 'text', value: ruleId },
                { type: 'integer', value: ruleVersion },
                { type: 'text', value: accountId },
                { type: 'text', value: positionScope },
              ],
            },
            stored,
          )
        ).toString('utf8'),
      ) as { readonly historyId: string },
    mailboxLock,
    sourceRegistry,
    retainedContentHooks: whatsappComposition.retainedContentHooks,
    now,
  });
  const scheduler = new EventScheduler({
    store: database,
    lifecycle,
    activations,
    dispatcher,
    expiry,
    cipher,
    approvals: core.approvals,
    config: core.config,
    taint: core.taint,
    gmailSourceFor,
    sourceWorkFor: async (scope) => {
      await runSourceOwnerWork(
        {
          store: database,
          cipher,
          approvals: core.approvals,
          config: core.config,
          taint: core.taint,
          lifecycle,
          sourceRegistry,
          slackSourceFor,
          resendReaderFor,
          whatsappEventOperations,
          whatsappVisibilityFence: whatsappComposition.visibilityFence,
          now,
        },
        scope,
      );
      return undefined;
    },
    mailboxLock,
    sourceRegistry,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
    now,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
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
    tick: () => scheduler.tick(),
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        await scheduler.stop();
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

  started.owner = true;
  try {
    await expiry.sweepAll();
    // Expired delivery leases are recovered by the scheduler's ticks, which claim nothing while paused or disabled.
    await recoverActivations(activations);
    await writeToken(paths, token);
    control = await startControlServer({
      endpoint: instance.endpoint,
      token,
      handle: async (request) =>
        handleControl(
          owner,
          lifecycle,
          database.installationId,
          database,
          activations,
          dryrun,
          sourceRegistry,
          request,
        ),
      verifyEndpoint: () => verifyPrivateSocketDirectory(paths),
    });
    await chmod(instance.endpoint, 0o600);
    await verifyControlSocket(instance.endpoint);
    await writeInstance(paths, instance);
    scheduler.start();
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
  sourceRegistry: LocalEventSourceRegistry,
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
      return sourceRows(database, sourceRegistry);
    case 'source-show':
      return sourceShow(database, sourceRegistry, requiredText(request.args.source, 'source'));
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

function sourceRows(
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  sourceRegistry: LocalEventSourceRegistry,
): unknown[] {
  const rows = database.database
    .prepare("SELECT document FROM rule_versions WHERE state IN ('active', 'superseded')")
    .all() as Array<{ document: string }>;
  const scopes = new Map<string, { source: string; accountId: string; cursorScope: string }>();
  for (const row of rows) {
    const document = JSON.parse(row.document) as {
      source?: { channel?: string; accountIds?: unknown; options?: unknown };
    };
    if (!Array.isArray(document.source?.accountIds) || document.source.options === undefined) continue;
    for (const accountId of document.source.accountIds) {
      if (typeof accountId !== 'string') continue;
      try {
        const source = sourceRegistry.require(
          document.source.channel as Parameters<LocalEventSourceRegistry['require']>[0],
        );
        const options = source.canonicalise(document.source.options);
        for (const scope of source.scopesFor({ accountId, options })) {
          scopes.set(`${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`, {
            source: scope.source,
            accountId: scope.accountId,
            cursorScope: scope.scopeId,
          });
        }
      } catch {
        // Immutable-version validation rejects invalid documents. This only keeps a manually damaged local database
        // from inventing a source row.
      }
    }
  }
  const ordered = [...scopes.values()].sort((left, right) =>
    `${left.source}\u0000${left.accountId}\u0000${left.cursorScope}`.localeCompare(
      `${right.source}\u0000${right.accountId}\u0000${right.cursorScope}`,
    ),
  );
  return sourceRegistry.sources().map((source) => ({
    source,
    accounts: ordered.filter((scope) => scope.source === source),
  }));
}

function sourceShow(
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  sourceRegistry: LocalEventSourceRegistry,
  source: string,
): unknown {
  if (!sourceRegistry.sources().includes(source as Parameters<LocalEventSourceRegistry['require']>[0]))
    throw new CommsError('NOT_FOUND', 'the requested source is not configured');
  return {
    source,
    accounts: (
      sourceRows(database, sourceRegistry).find((row) => (row as { source: string }).source === source) as {
        accounts: unknown[];
      }
    ).accounts,
  };
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
