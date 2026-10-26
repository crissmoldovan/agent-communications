import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ApprovalStore,
  type AuditLog,
  CommsError,
  type ConfigStore,
  isCommsError,
  openCore,
  resolvePaths,
  sha256Hex,
} from '@agentcomms/core';
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
import type { AuthenticatedControlRequest } from '../control/protocol.ts';
import { type ControlServerOptions, type RunningControlServer, startControlServer } from '../control/server.ts';
import { normaliseActivationDocument } from '../domain/activation-documents.ts';
import { HumanSecret } from '../domain/human-secret.ts';
import {
  type LayaPlatformProbe,
  type LayaReviewedAssetSource,
  layaEnablementInputsFor,
  layaJudgeTermsFor,
  registerLayaEnablementInputs,
} from '../domain/judges.ts';
import { type LaneWindowIdentity, parseLaneWindowIdentity } from '../domain/lanes.ts';
import { EventDomainError, JUDGE_KIND_LAYA } from '../domain/lifecycle.ts';
import { normaliseSourceOptions, type SourceOptions } from '../domain/source-options.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import {
  B3_SECRET_TERMINAL_ORIGIN,
  type B3ApprovalViewResultV1,
  type B3OwnerRequest,
  type B3OwnerService,
  type B3PendingTargetSelectorV1,
  type B3SecretCapabilityUnavailableV1,
  isB3ControlOperation,
  isB3SecretOperation,
} from '../operations/b3-contract.ts';
import { type B3LayaRuleApprovalReadyV3, layaJudgePreviewFor } from '../operations/b3-control-v3.ts';
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
import { assertLiveEventAccount, type ConnectedEventAccount, connectedEventAccounts } from './account-fence.ts';
import { ActivationRuntime } from './activations.ts';
import { type B3ControlPorts, type B3DeliveryWriteFenceRequest, createB3ControlPorts } from './b3-control-ports.ts';
import { projectE2Doctor } from './b3-doctor-projection.ts';
import { B3OperatorControl } from './b3-operator-control.ts';
import { type PendingTargetOrigin, verifyPendingTargetContext } from './b3-pending-activation-context.ts';
import {
  isPendingRuleJudgeTestSelector,
  type PendingRuleJudgeTestOrigin,
  type PendingRuleJudgeTestSelector,
  verifyPendingRuleJudgeTestContext,
} from './b3-pending-rule-judge-test.ts';
import {
  createRetainedRuleTestControl,
  type RetainedRuleTestControl,
  runCatalogueRuleTest,
} from './b3-retained-control.ts';
import { consumeGeneratedTerminalReveal, type SecretReceipt } from './b3-secret-control.ts';
import {
  B3TargetTestControl,
  type FixedSyntheticTargetTransport,
  TargetResumeControl,
} from './b3-target-test-control.ts';
import { isOwnerControlWireOperation, OWNER_CONTROL_WIRES } from './control-operation-registry.ts';
import { DELIVERY_ACTIVITY_INTERVAL_MS, DeliveryActivity } from './delivery-activity.ts';
import { hasLiveDeliveryLineage } from './delivery-claim.ts';
import { DeliveryReader } from './delivery-show.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import { DeliveryDispatcher, DryRunDispatcher } from './dispatcher.ts';
import { EventExpiry, SourceStageExpiryGroup } from './expiry.ts';
import { HoldResolver } from './holds.ts';
import { JudgeKinds } from './judge-kinds.ts';
import { registerJudgeWorkPurgeListener } from './judge-purge.ts';
import { recoverJudgeWork } from './judge-recovery.ts';
import { JudgeSetupService } from './judge-setup.ts';
import { JudgeTestControl } from './judge-test.ts';
import { LaneService } from './lanes.ts';
import { type LayaArtifactFailpoint, LayaArtifactManager, type LayaArtifactNetwork } from './laya/manager.ts';
import { type LayaWorkerStart, LayaWorkerSupervisor, registerLayaJudgeExecutor } from './laya/worker-supervisor.ts';
import { EventLifecycle, type EventLifecycleStatus } from './lifecycle.ts';
import { acquireEventOwnerLock, type EventOwnerLock } from './locks.ts';
import { MessagesStore } from './messages.ts';
import { type EventPaths, ensureEventPaths, ensureEventSocketDirectory, eventPaths } from './paths.ts';
import { createB2RetainedContentParticipants } from './phase-d-b2-retention.ts';
import {
  createPhaseDWhatsAppOwnerComposition,
  requirePhaseDWhatsAppVisibilitySeam,
} from './phase-d-whatsapp-owner-composition.ts';
import { EventProjectionStore } from './projections.ts';
import { type QueueScope, QueueStore } from './queue.ts';
import { QueueDispatcher } from './queue-dispatcher.ts';
import { PERSON, type QueueActor } from './queue-history.ts';
import { tighteningPreviewFor } from './queue-tightening.ts';
import { recoverActivations } from './recovery.ts';
import { GmailReplacementDrains, replacementIntentSummary } from './replacements.ts';
import { disableRule, removeTarget } from './revocations.ts';
import { RuleReader } from './rule-show.ts';
import { EventScheduler } from './scheduler.ts';
import { runSourceOwnerWork, stageWhatsAppBaselineSnapshot } from './source-owner-work.ts';
import { SseDispatcher } from './sse-dispatcher.ts';
import type { SseServer } from './sse-server.ts';
import { recordEventTaint } from './untrusted.ts';
import { WebhookDispatcher } from './webhook-dispatcher.ts';
import { WriterQuiescer, withEventWriterLease } from './writer-quiescer.ts';

export { OWNER_CONTROL_WIRE_OPERATIONS } from './control-operation-registry.ts';

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
  /**
   * Registers a live listener the owner started for one exact immutable subscriber version. The returned cleanup
   * runs when that listener stops, so a later revocation closes only streams held by the matching listener(s).
   */
  registerSseListener(
    input: Pick<SseServer, 'rotate'> & {
      readonly subscriberId: string;
      readonly subscriberVersion: number;
    },
  ): () => void;
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
  /** Test-only deterministic identifiers for contract-vector reproduction. */
  readonly newIntentId?: (() => string) | undefined;
  /**
   * Test-only control transport seam. It receives the production authenticated-request handler without opening a
   * Unix listener, which lets contract tests run in restricted sandboxes while exercising the real owner.
   */
  readonly startControlServer?: ((options: ControlServerOptions) => Promise<RunningControlServer>) | undefined;
  /** Task 1 seam: later B3 requests are owned here, not by a second CLI/MCP path. */
  readonly b3OwnerService?: B3OwnerService | undefined;
  /** Test seam only: the normal production owner opens its own SQLite authority. */
  readonly openDatabase?: typeof openEventDatabase | undefined;
  /**
   * The data directory whose `events/laya` holds Laya's verified runtime and model trees. Production leaves it unset:
   * core's data directory. A test pins it beside its state directory.
   */
  readonly dataDir?: string | undefined;
  /**
   * Test seam only: where `runEventOwner` hears SIGINT and SIGTERM. Production leaves it unset: the process. A test
   * emits them here, so the test runner's own handlers on the process never run.
   */
  readonly signals?: Pick<NodeJS.EventEmitter, 'once' | 'off'> | undefined;
  /**
   * Test seam only: strict-parsed synthetic reviewed Laya bytes, the content-free sandbox probe spawn, the sealed
   * network the production fetcher dials, a free-space probe, artifact failpoints and the worker start (Task 7's
   * frame-compatible stand-in behind the real boundary proof, as E2 Task 8's supervisor tests start it). Production
   * uses the daemon's shipped assets, this process's platform, no failpoint, and launches only the shipped worker
   * under the macOS sandbox.
   */
  readonly laya?:
    | {
        readonly assets?: LayaReviewedAssetSource | undefined;
        readonly platform?: LayaPlatformProbe | undefined;
        readonly network?: LayaArtifactNetwork | undefined;
        readonly freeBytes?: (() => Promise<number>) | undefined;
        readonly failpoint?: LayaArtifactFailpoint | undefined;
        readonly startWorker?: LayaWorkerStart | undefined;
      }
    | undefined;
}

/**
 * The owner owns the live loopback listeners rather than copying their stream state into an operator control. A
 * removal closes only the exact immutable subscriber version, and a listener that unregisters while it is being
 * closed is harmless.
 */
export class OwnerSseStreamRegistry {
  readonly #listeners = new Map<string, Set<Pick<SseServer, 'rotate'>>>();

  register(
    input: Pick<SseServer, 'rotate'> & { readonly subscriberId: string; readonly subscriberVersion: number },
  ): () => void {
    const key = `${input.subscriberId}\u0000${input.subscriberVersion}`;
    const listeners = this.#listeners.get(key) ?? new Set<Pick<SseServer, 'rotate'>>();
    listeners.add(input);
    this.#listeners.set(key, listeners);
    return () => {
      listeners.delete(input);
      if (listeners.size === 0) this.#listeners.delete(key);
    };
  }

  closeSubscriberStreams(input: { readonly subscriberId: string; readonly subscriberVersion: number }): void {
    // Generation zero cannot be a stored bearer generation; it invalidates every admitted stream synchronously.
    this.rotate({ ...input, generation: 0 });
  }

  /** For a token rotation, pass the persisted new generation to every live exact-version SSE listener synchronously. */
  rotate(input: {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly generation: number;
  }): void {
    const key = `${input.subscriberId}\u0000${input.subscriberVersion}`;
    const listeners = this.#listeners.get(key);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener.rotate(input);
  }
}

interface OwnerDeliveryFenceOptions {
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly whatsappVisibilityFence: {
    withCurrentDryRunVisibility<T>(
      input: { readonly accountId: string; readonly whatsappMessageId: string },
      recheck: () => Promise<void>,
      commit: () => T,
    ): Promise<T | undefined>;
  };
}

/**
 * D2/D7/D9's one retry/drop fence. Configuration and approval stores are asynchronous, so their fresh reads happen
 * immediately before the one IMMEDIATE transaction; the transaction then repeats every SQLite authority predicate
 * before synchronously running the control work. WhatsApp adds its concrete list lock around that same transaction.
 */
export function createOwnerDeliveryWriteFence(
  options: OwnerDeliveryFenceOptions,
): <T>(request: B3DeliveryWriteFenceRequest, work: () => T) => Promise<T> {
  return async <T>(request: B3DeliveryWriteFenceRequest, work: () => T): Promise<T> => {
    const preflight = async (): Promise<void> => {
      await assertLiveEventAccount(options.config, { source: request.source, accountId: request.accountId });
      await assertDisclosable({
        database: options.store.database,
        approvals: options.approvals,
        config: options.config,
        accountId: request.accountId,
        boundary: 'dispatch',
        ruleId: request.ruleId,
        ruleVersion: request.ruleVersion,
        targetId: request.targetId,
        targetVersion: request.targetVersion,
        switchGeneration: request.switchGeneration,
      });
    };
    const commit = (): T =>
      options.store.immediate(() => {
        assertLiveDeliveryControlAuthority(options.store.database, request);
        return work();
      });
    if (request.source !== 'whatsapp' || request.whatsappMessageId === null) {
      await preflight();
      return commit();
    }
    const result = await options.whatsappVisibilityFence.withCurrentDryRunVisibility(
      { accountId: request.accountId, whatsappMessageId: request.whatsappMessageId },
      preflight,
      commit,
    );
    if (result === undefined)
      throw new CommsError('APPROVAL_VOID', 'the WhatsApp event is no longer visible to this subscriber control');
    return result;
  };
}

function assertLiveDeliveryControlAuthority(
  database: Awaited<ReturnType<typeof openEventDatabase>>['database'],
  request: B3DeliveryWriteFenceRequest,
): void {
  const row = database
    .prepare(
      `SELECT delivery.id, delivery.account_id, delivery.rule_id, delivery.rule_version, delivery.target_id,
              delivery.target_version, delivery.subscriber_id, delivery.subscriber_version, delivery.switch_generation,
              delivery.whatsapp_message_id, rule.document AS rule_document
         FROM deliveries AS delivery
         JOIN rule_versions AS rule ON rule.rule_id = delivery.rule_id AND rule.version = delivery.rule_version
        WHERE delivery.id = ?`,
    )
    .get(request.deliveryId) as
    | {
        id: string;
        account_id: string;
        rule_id: string;
        rule_version: number;
        target_id: string;
        target_version: number;
        subscriber_id: string | null;
        subscriber_version: number | null;
        switch_generation: number;
        whatsapp_message_id: string | null;
        rule_document: string;
      }
    | undefined;
  if (
    row === undefined ||
    row.account_id !== request.accountId ||
    row.rule_id !== request.ruleId ||
    row.rule_version !== request.ruleVersion ||
    row.target_id !== request.targetId ||
    row.target_version !== request.targetVersion ||
    row.subscriber_id !== request.subscriberId ||
    row.subscriber_version !== request.subscriberVersion ||
    row.switch_generation !== request.switchGeneration ||
    row.whatsapp_message_id !== request.whatsappMessageId ||
    sourceOfDeliveryRule(row.rule_document) !== request.source ||
    !hasLiveDeliveryLineage(database, row)
  )
    throw new CommsError('APPROVAL_VOID', 'the delivery authority changed before this control write');
  const settings = database
    .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; switch_generation: number } | undefined;
  if (settings?.enabled !== 1 || settings.switch_generation !== request.switchGeneration)
    throw new CommsError('APPROVAL_VOID', 'the event switch changed before this control write');
  if (request.subscriberId !== null) {
    const subscriber = database
      .prepare(
        'SELECT 1 AS present FROM subscriber_versions WHERE subscriber_id = ? AND version = ? AND revoked_at IS NULL',
      )
      .get(request.subscriberId, request.subscriberVersion);
    if (subscriber === undefined)
      throw new CommsError('APPROVAL_VOID', 'the exact subscriber version changed before this control write');
  }
}

function sourceOfDeliveryRule(document: string): SourceOptions['channel'] {
  try {
    return normaliseSourceOptions((JSON.parse(document) as { source?: { options?: unknown } }).source?.options).channel;
  } catch {
    throw new CommsError('APPROVAL_VOID', 'the delivery rule source is no longer valid');
  }
}

interface OwnerB3ControlServiceOptions {
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly ports: B3ControlPorts;
  /** The production owner gives target resume the same fresh core account registry as disclosure fencing. */
  readonly config: Pick<ConfigStore, 'load'>;
  readonly activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge'> &
    Partial<
      Pick<
        ActivationRuntime,
        | 'prepareJudgeBudget'
        | 'prepareJudgeKind'
        | 'cancelForJudgeKindInTransaction'
        | 'cancelForRevocationInTransaction'
      >
    >;
  readonly cipher: Pick<EventRecordCipher, 'encrypt'>;
  /** A B3 secret command writes only this content-free receipt-shaped audit record. */
  readonly audit?: Pick<AuditLog, 'append'> | undefined;
  readonly targetTestTransport?: FixedSyntheticTargetTransport | undefined;
  /** The production exact-projection reader is composed by the owner, never by a public adapter. */
  readonly retainedRuleTest?: Pick<RetainedRuleTestControl, 'test'> | undefined;
  /** Task 9's fixed synthetic judge tester is composed by the owner alongside the real secret reader. */
  readonly judgeTest?: (Pick<JudgeTestControl, 'test'> & Partial<Pick<JudgeTestControl, 'testPending'>>) | undefined;
  readonly holdResolver?: Pick<HoldResolver, 'resolve'> | undefined;
  /** E2's artifact manager; without it the Laya operations keep B3 v1's frozen typed `E2_REQUIRED` answers. */
  readonly laya?: LayaArtifactManager | undefined;
  readonly now?: (() => number) | undefined;
}

/** Composes every Task 3/4 control behind the authenticated owner; public adapters never reach a runtime class. */
export function createOwnerB3ControlService(options: OwnerB3ControlServiceOptions): B3OwnerService {
  const now = options.now ?? Date.now;
  const judgeActivations =
    typeof options.activations.prepareJudgeBudget === 'function' &&
    typeof options.activations.prepareJudgeKind === 'function' &&
    typeof options.activations.cancelForJudgeKindInTransaction === 'function' &&
    typeof options.activations.cancelForRevocationInTransaction === 'function'
      ? options.activations
      : undefined;
  const operator = new B3OperatorControl({
    store: options.store,
    ports: options.ports,
    now,
    ...(judgeActivations === undefined
      ? {}
      : {
          activations: judgeActivations as Pick<
            ActivationRuntime,
            | 'prepareJudgeBudget'
            | 'prepareJudgeKind'
            | 'cancelForJudgeKindInTransaction'
            | 'cancelForRevocationInTransaction'
          >,
        }),
    // Only `test` reaches the operator control, still bound to its control: an unbound method loses `this` and its
    // private store, and every CLI/MCP judge test then failed as a generic refusal.
    ...(options.judgeTest === undefined ? {} : { judgeTest: { test: options.judgeTest.test.bind(options.judgeTest) } }),
    ...(options.holdResolver === undefined ? {} : { holdResolver: options.holdResolver }),
    ...(options.laya === undefined ? {} : { laya: options.laya }),
  });
  const target = (pendingOrigin?: PendingTargetOrigin) =>
    new B3TargetTestControl({
      store: options.store,
      ports: options.ports,
      // The owner has no target-specific synthetic transport before the real transport owner is selected. Dry-run
      // tests are a sealed local success; a network target cannot be reached by this fallback.
      transport:
        options.targetTestTransport ??
        (async ({ target: selected }: { readonly target: { readonly kind: string } }) => {
          // A queue target is local too: its test reaches nothing and puts nothing in the person's list.
          if (selected.kind !== 'dry-run' && selected.kind !== 'queue')
            throw new CommsError('CONFIG', 'the selected target has no owner-composed synthetic test transport');
        }),
      ...(pendingOrigin === undefined
        ? {}
        : {
            pending: {
              verify: (selector) =>
                verifyPendingTargetContext({
                  database: options.store.database,
                  selector,
                  origin: pendingOrigin,
                  now,
                  approvalView: () => livePendingTargetChallenge(options.store, selector, pendingOrigin, now),
                }),
            },
          }),
      now,
    });
  const resume = new TargetResumeControl({
    store: options.store,
    ports: options.ports,
    config: options.config,
    // TargetResumeControl holds the shared lease before calling this seal and through its immediate commit.
    resetSealer: ({ id, plaintext }) =>
      options.cipher.encrypt(
        { table: 'system_reset_outbox', column: 'encryptedRecord', key: [{ type: 'text', value: id }] },
        plaintext,
      ),
    now,
  });
  return {
    async handle(request: B3OwnerRequest): Promise<unknown> {
      if (isB3SecretOperation(request.operation)) {
        // C has not supplied its non-forgeable secret-window capability.  The control hello's client name is only a
        // caller assertion, so every value except the terminal origin is refused before parsing secret-shaped args or
        // touching the Task 2 secret control.
        const receipt = secretAuditReceipt(request);
        if (request.origin !== B3_SECRET_TERMINAL_ORIGIN) {
          await appendSecretAudit(options.audit, {
            ...receipt,
            outcome: 'refused',
            reason: 'APP_SECRET_CAPABILITY_UNAVAILABLE',
          });
          return {
            kind: 'unavailable',
            code: 'APP_SECRET_CAPABILITY_UNAVAILABLE',
          } satisfies B3SecretCapabilityUnavailableV1;
        }
        try {
          const result = await handleTerminalSecretOperation(options.ports.secrets, request);
          await appendSecretAudit(options.audit, { ...receipt, outcome: 'ok' });
          return result;
        } catch (error) {
          await appendSecretAudit(options.audit, { ...receipt, outcome: 'failed' });
          throw error;
        }
      }
      switch (request.operation) {
        case 'approvalView':
          return approvalViewFromOwner(
            options.store,
            options.activations,
            now,
            request.args,
            options.laya !== undefined,
          );
        case 'ruleTest':
          return runCatalogueRuleTest({ document: request.args.document, catalogue: request.args.catalogue as never });
        case 'ruleTestRetained':
          if (options.retainedRuleTest === undefined)
            throw new CommsError('CONFIG', 'the owner has no retained rule-test reader');
          return options.retainedRuleTest.test(request.args);
        case 'targetTest': {
          const pendingOrigin = pendingTargetOrigin(request.origin);
          if (pendingOrigin !== undefined) return target(pendingOrigin).test(request.args);
          return target().test({
            kind: 'active',
            targetId: requiredText(request.args.targetId, 'target id'),
            targetVersion: requiredVersion(request.args.targetVersion, 'target version'),
          });
        }
        case 'targetResume':
          return resume.resume({
            targetId: requiredText(request.args.targetId, 'target id'),
            targetVersion: requiredVersion(request.args.targetVersion, 'target version'),
          });
        case 'judgeTest': {
          const selector = request.args;
          if (!isPendingRuleJudgeTestSelector(selector)) return operator.handle(request);
          if (options.judgeTest?.testPending === undefined)
            throw new CommsError('CONFIG', 'judge test is not composed for this operator control');
          const pendingOrigin = pendingRuleJudgeTestOrigin(request.origin);
          if (pendingOrigin === undefined)
            throw new CommsError(
              'APPROVAL_VOID',
              'a pending rule judge test is available only from the terminal approval flow or app approval screen',
            );
          const authority = await verifyPendingRuleJudgeTestContext({
            database: options.store.database,
            selector,
            origin: pendingOrigin,
            now,
            approvalView: () => livePendingTargetChallenge(options.store, selector, pendingOrigin, now),
          });
          return options.judgeTest.testPending(authority);
        }
        case 'decideHeld':
          if (request.origin !== B3_SECRET_TERMINAL_ORIGIN && request.origin !== 'app-approval-screen')
            throw new CommsError('APPROVAL_REQUIRED', 'a held decision can be resolved only from a terminal or app');
          return operator.handle(request);
        default:
          return operator.handle(request);
      }
    },
  };
}

/** The event audit contains only D2's operation, exact safe owner identity, closed outcome, and AuditLog's time. */
async function appendSecretAudit(
  audit: Pick<AuditLog, 'append'> | undefined,
  receipt: Readonly<{
    operation: B3OwnerRequest['operation'];
    outcome: 'ok' | 'failed' | 'refused';
    /** A closed refusal code; core's audit outcome stays its own shared vocabulary. */
    reason?: 'APP_SECRET_CAPABILITY_UNAVAILABLE' | undefined;
    ids?: Readonly<Record<string, string>> | undefined;
  }>,
): Promise<void> {
  if (audit === undefined) return;
  await audit.append({
    inboxId: '',
    operation: `events.${receipt.operation}`,
    outcome: receipt.outcome,
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    ...(receipt.ids === undefined ? {} : { ids: receipt.ids }),
  });
}

/**
 * Extracts only identifiers that D2 permits in an audit row, before either the origin gate or secret control. A
 * refused origin therefore records its closed outcome without parsing hidden material, URL components, migration
 * destination, or any other caller argument.
 */
function secretAuditReceipt(request: B3OwnerRequest): Readonly<{
  operation: B3OwnerRequest['operation'];
  ids?: Readonly<Record<string, string>> | undefined;
}> {
  switch (request.operation) {
    case 'targetSecretCreate':
    case 'targetSecretRotate':
      return {
        operation: request.operation,
        ids: auditOwnerIdentity('targetId', request.args.targetId, request.args.version),
      };
    case 'targetUrlSet':
      return {
        operation: request.operation,
        ids: auditOwnerIdentity('targetId', request.args.targetId, request.args.newVersion),
      };
    case 'subscriberTokenCreate':
    case 'subscriberTokenRotate':
      return {
        operation: request.operation,
        ids: auditOwnerIdentity('subscriberId', request.args.subscriberId, request.args.version),
      };
    case 'judgeKeySet':
    case 'judgeKeyRotate':
      return {
        operation: request.operation,
        ids: auditOwnerIdentity('judgeId', request.args.judgeId, request.args.version),
      };
    case 'migrateSecrets':
      return { operation: request.operation };
    default:
      throw new CommsError('USAGE', 'the local secret operation is not recognised');
  }
}

/** Audit a valid D2 subject id independently, then add its version only if the version is independently valid. */
function auditOwnerIdentity(
  idName: 'targetId' | 'subscriberId' | 'judgeId',
  id: unknown,
  version: unknown,
): Readonly<Record<string, string>> | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return { [idName]: id };
  return { [idName]: id, version: String(version) };
}

function pendingTargetOrigin(origin: string | undefined): PendingTargetOrigin | undefined {
  if (origin === 'terminal-approval' || origin === 'app-approval-screen') return origin;
  return undefined;
}

function pendingRuleJudgeTestOrigin(origin: string | undefined): PendingRuleJudgeTestOrigin | undefined {
  if (origin === 'terminal-approval' || origin === 'app-approval-screen') return origin;
  return undefined;
}

/**
 * Re-reads the daemon's durable challenge row instead of trusting a caller label. The raw challenge is never read
 * from storage; its supplied value must hash to the active daemon value, then is passed only to Task 3's exact
 * selector verifier. A terminal prompt has no deadline, while an approval-screen view must retain its live deadline.
 */
async function livePendingTargetChallenge(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  selector: { readonly approvalId: string; readonly digest: string; readonly challenge: string },
  origin: PendingTargetOrigin,
  now: () => number,
): Promise<{
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
  readonly expiresAt: number;
}> {
  const row = store.database
    .prepare(
      `SELECT state, origin, challenge_hash, expires_at
       FROM activation_view_challenges WHERE approval_id = ?`,
    )
    .get(selector.approvalId) as
    | {
        readonly state: string;
        readonly origin: string;
        readonly challenge_hash: string | null;
        readonly expires_at: number | null;
      }
    | undefined;
  const expectedChallengeOrigin = origin === 'terminal-approval' ? 'terminal' : 'view';
  const terminal = expectedChallengeOrigin === 'terminal';
  if (
    row === undefined ||
    row.state !== 'active' ||
    row.origin !== expectedChallengeOrigin ||
    typeof row.challenge_hash !== 'string' ||
    sha256Hex(selector.challenge) !== row.challenge_hash ||
    (terminal
      ? row.expires_at !== null
      : typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at) || row.expires_at <= now())
  )
    throw new CommsError('APPROVAL_VOID', 'the approval challenge is stale or does not bind this pending activation');
  return {
    approvalId: selector.approvalId,
    digest: selector.digest,
    challenge: selector.challenge,
    expiresAt: terminal ? Number.MAX_SAFE_INTEGER : (row.expires_at as number),
  };
}

async function handleTerminalSecretOperation(
  secrets: B3ControlPorts['secrets'],
  request: B3OwnerRequest,
): Promise<unknown> {
  switch (request.operation) {
    case 'targetSecretCreate':
      return terminalSecretResult(
        await secrets.targetSecretCreate({
          targetId: requiredText(request.args.targetId, 'target id'),
          version: requiredVersion(request.args.version, 'target version'),
        }),
      );
    case 'targetSecretRotate':
      return terminalSecretResult(
        await secrets.targetSecretRotate({
          targetId: requiredText(request.args.targetId, 'target id'),
          version: requiredVersion(request.args.version, 'target version'),
        }),
      );
    case 'targetUrlSet':
      return secrets.targetUrlSet({
        targetId: requiredText(request.args.targetId, 'target id'),
        ...(request.args.predecessorVersion === undefined
          ? {}
          : { predecessorVersion: requiredVersion(request.args.predecessorVersion, 'predecessor version') }),
        ...(request.args.inertDraft === undefined
          ? {}
          : { inertDraft: requiredRecord(request.args.inertDraft, 'inert target draft') }),
        newVersion: requiredVersion(request.args.newVersion, 'new target version'),
        hiddenUrl: requiredText(request.args.hidden, 'hidden webhook URL'),
      });
    case 'subscriberTokenCreate':
      return terminalSecretResult(
        await secrets.subscriberTokenCreate({
          subscriberId: requiredText(request.args.subscriberId, 'subscriber id'),
          version: requiredVersion(request.args.version, 'subscriber version'),
        }),
      );
    case 'subscriberTokenRotate':
      return terminalSecretResult(
        await secrets.subscriberTokenRotate({
          subscriberId: requiredText(request.args.subscriberId, 'subscriber id'),
          version: requiredVersion(request.args.version, 'subscriber version'),
        }),
      );
    case 'judgeKeySet':
      return secrets.judgeKeySet({
        judgeId: requiredText(request.args.judgeId, 'judge id'),
        version: requiredVersion(request.args.version, 'judge version'),
        hidden: HumanSecret.fromTrustedInput(requiredText(request.args.hidden, 'hidden judge key')),
      });
    case 'judgeKeyRotate':
      return secrets.judgeKeyRotate({
        judgeId: requiredText(request.args.judgeId, 'judge id'),
        version: requiredVersion(request.args.version, 'judge version'),
        hidden: HumanSecret.fromTrustedInput(requiredText(request.args.hidden, 'hidden judge key')),
      });
    case 'migrateSecrets': {
      const to = request.args.to;
      if (to !== 'file' && to !== 'keychain')
        throw new CommsError('USAGE', 'secret migration destination is file or keychain');
      return secrets.migrateTo(to);
    }
    default:
      throw new CommsError('USAGE', 'the local secret operation is not recognised');
  }
}

/** The only serialization point for generated material; every other secret operation returns a receipt. */
function terminalSecretResult(receipt: SecretReceipt): unknown {
  const reveal = consumeGeneratedTerminalReveal(receipt);
  return reveal === null ? receipt : { receipt, terminalReveal: reveal };
}

/**
 * The authoritative approval view. With E2's artifact manager composed the owner answers B3 control v3, whose view of
 * a rule naming a Laya judge also carries D11's Laya limits, from the same reviewed assets as the enablement.
 */
async function approvalViewFromOwner(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge'>,
  now: () => number,
  args: Readonly<Record<string, unknown>>,
  layaJudges = false,
): Promise<B3ApprovalViewResultV1 | B3LayaRuleApprovalReadyV3> {
  const approvalId = requiredText(args.approvalId, 'approval id');
  const digest = requiredText(args.digest, 'approval digest');
  const row = store.database
    .prepare('SELECT id, document, digest, status FROM activation_intents WHERE approval_id = ?')
    .get(approvalId) as { id: string; document: string; digest: string; status: string } | undefined;
  if (row === undefined || row.status !== 'pending') return { kind: 'STALE_APPROVAL' };
  if (row.digest !== digest) return { kind: 'DIGEST_MISMATCH' };
  const preview = normaliseActivationDocument(JSON.parse(row.document));
  const layaJudge = layaJudges
    ? layaJudgePreviewFor(preview, layaJudgeTermsFor(layaEnablementInputsFor(store.database)))
    : undefined;
  const nextExpiry = now() + 5 * 60 * 1_000;
  const challenge = await activations.issueApprovalViewChallenge(approvalId, nextExpiry);
  if (challenge === null) return { kind: 'CHALLENGE_EXPIRED' };
  return {
    kind: 'READY',
    approvalId,
    digest: row.digest,
    preview,
    pendingTargetSelectors: pendingTargetSelectorsForApproval({
      activationId: row.id,
      approvalId,
      digest: row.digest,
      challenge,
      preview,
    }),
    challenge: { approvalId, digest: row.digest, challenge, expiresAt: nextExpiry },
    ...(layaJudge === undefined ? {} : { layaJudge }),
  };
}

export interface TerminalApprovalStart {
  readonly challenge: string;
  readonly pendingTargetSelectors: readonly B3PendingTargetSelectorV1[];
  /** Sidecar-only; never part of the pinned v1 approval-view result. */
  readonly pendingRuleJudgeTestSelectors: readonly PendingRuleJudgeTestSelector[];
}

/**
 * The interactive terminal receives a selector only after it owns a terminal challenge.  Ordinary raw callers retain
 * the historical string result; the label is not an authority boundary, only the repository's supplied surface.
 */
export async function issueTerminalApprovalChallenge(input: {
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly activations: Pick<ActivationRuntime, 'issueChallenge'>;
  readonly approvalId: string;
  readonly origin: string | undefined;
}): Promise<string | TerminalApprovalStart> {
  const challenge = await input.activations.issueChallenge(input.approvalId);
  if (input.origin !== 'terminal-approval') return challenge;
  const row = input.store.database
    .prepare('SELECT id, document, digest, status FROM activation_intents WHERE approval_id = ?')
    .get(input.approvalId) as { id: string; document: string; digest: string; status: string } | undefined;
  if (row === undefined || row.status !== 'pending')
    throw new CommsError('APPROVAL_VOID', 'the approval is no longer pending');
  const preview = normaliseActivationDocument(JSON.parse(row.document));
  return {
    challenge,
    pendingTargetSelectors: pendingTargetSelectorsForApproval({
      activationId: row.id,
      approvalId: input.approvalId,
      digest: row.digest,
      challenge,
      preview,
    }),
    pendingRuleJudgeTestSelectors: pendingRuleJudgeTestSelectorsForApproval({
      activationId: row.id,
      approvalId: input.approvalId,
      digest: row.digest,
      challenge,
      preview,
    }),
  };
}

/** These bindings are produced from the owner row alone, never reconstructed from a desktop or terminal request. */
function pendingTargetSelectorsForApproval(input: {
  readonly activationId: string;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
  readonly preview: ReturnType<typeof normaliseActivationDocument>;
}): readonly B3PendingTargetSelectorV1[] {
  if (input.preview.kind !== 'rule' || !('rule' in input.preview)) return [];
  const rule = input.preview.rule;
  return rule.targets.map((target) => ({
    kind: 'pending-activation',
    activationId: input.activationId,
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    targetId: target.targetId,
    targetVersion: target.version,
    approvalId: input.approvalId,
    digest: input.digest,
    challenge: input.challenge,
  }));
}

/** This approval-flow-only sidecar derives the exact judge selector from the same owner-held pending preview. */
function pendingRuleJudgeTestSelectorsForApproval(input: {
  readonly activationId: string;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
  readonly preview: ReturnType<typeof normaliseActivationDocument>;
}): readonly PendingRuleJudgeTestSelector[] {
  if (input.preview.kind !== 'rule' || !('rule' in input.preview)) return [];
  const rule = input.preview.rule;
  const agentic = rule.agentic;
  if (agentic === undefined) return [];
  return [
    {
      kind: 'pending-rule-judge-test',
      activationId: input.activationId,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      judgeId: agentic.judge.judgeId,
      judgeVersion: agentic.judge.version,
      approvalId: input.approvalId,
      digest: input.digest,
      challenge: input.challenge,
    },
  ];
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
  const database = await (options.openDatabase ?? openEventDatabase)({ stateDir });
  onDatabase(database);
  const now = options.now ?? Date.now;
  const lifecycle = new EventLifecycle(database, now);
  const core = openCore({
    pathOverrides: {
      stateDir,
      ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    },
    now: () => new Date(now()),
  });
  const eventSecrets = await openEventSecretStore({
    database: database.database,
    paths: database.paths,
    configDir: core.paths.configDir,
  });
  const writerQuiescer = new WriterQuiescer();
  const cipher = new EventRecordCipher(database.database, eventSecrets, writerQuiescer);
  // The same registry backs `registerSseListener` and the secret port. It must exist before the port is made so a
  // production subscriber-token rotation cannot silently omit closing old admitted streams.
  const sseStreams = new OwnerSseStreamRegistry();
  const b3Ports = createB3ControlPorts({
    database: database.database,
    paths: database.paths,
    eventSecrets,
    cipher,
    quiescer: writerQuiescer,
    subscriberStreams: sseStreams,
  });
  const sourceRegistry = phaseDSourceRegistry();
  // The concrete WhatsApp visibility fence is constructed in every production owner (D Task 7).
  const whatsappEventOperations =
    options.whatsappEventOperations ?? openWhatsAppEventOperations({ configDir: core.paths.configDir });
  const whatsappComposition = (options.phaseDComposition ?? createPhaseDWhatsAppOwnerComposition)({
    database,
    eventOperations: whatsappEventOperations,
    createRetainedContentParticipants: createB2RetainedContentParticipants,
    // The visibility-triggered judge purge shares the owner clock with every other immediate lifecycle closure.
    now,
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
  // The action queue's local adapter and read model: dry-run's fences, with no network path (§2's anti-goals).
  let notifyLaneAppend: () => void = () => undefined;
  const queueDispatcher = new QueueDispatcher({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    expiry,
    now,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
    onAppended: () => notifyLaneAppend(),
  });
  const queue = new QueueStore({
    store: database,
    cipher,
    approvals: core.approvals,
    config: core.config,
    expiry,
    now,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
  });
  // Routing's lanes (routing design 2026-10-25): bindings, who the bound window is, and the wake's task store.
  const lanes = new LaneService({ store: database, queue, now });
  // 0.32.0 (owner feedback §3.4, §3.5): one delivery as the person reads it, reached only from the CLI and the app;
  // and each rule version with its times, its plain-words summary and its last 7 days.
  const readers: OwnerReaders = {
    deliveries: new DeliveryReader({ store: database, cipher, now }),
    rules: new RuleReader({ store: database, now, accounts: () => connectedEventAccounts(core.config) }),
  };
  notifyLaneAppend = () => lanes.notifyAppended();
  // A story per message (0.32.0 §3.6): the person's read joining ingest, decisions, deliveries and queue items.
  const messages = new MessagesStore({ store: database, cipher, queue, expiry, now });
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
    queue: queueDispatcher,
    assertObjectSecretReady: b3Ports.assertObjectSecretReady,
  });
  // Activity design S1: one content-free "told" line for what each delivery came to, read back once it is committed.
  const deliveryActivity = new DeliveryActivity({ store: database, core, config: core.config });
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
  // E2's one Laya artifact owner. It touches no file until an approved enablement's claim, and E's purge participant
  // tells it which in-memory work a purge orphaned.
  const layaInputs = {
    ...(options.laya?.assets === undefined ? {} : { layaAssetSource: options.laya.assets }),
    ...(options.laya?.platform === undefined ? {} : { layaPlatformProbe: options.laya.platform }),
  };
  const layaArtifacts = new LayaArtifactManager({
    store: database,
    artifactRoot: join(options.dataDir ?? core.paths.dataDir, 'events', JUDGE_KIND_LAYA),
    inputs: layaInputs,
    network: options.laya?.network,
    freeBytes: options.laya?.freeBytes,
    failpoint: options.laya?.failpoint,
    audit: core.audit,
    now,
  });
  const unregisterLayaPurge = registerJudgeWorkPurgeListener(database.database, layaArtifacts);
  // Every reader of this database's Laya kind document — E's budget fence and settlement among them — validates with
  // the same inputs as its activation path. The one isolated worker supervisor is E's coordinator's only Laya
  // executor; it proves and launches only the shipped worker entry.
  const unregisterLayaInputs = registerLayaEnablementInputs(database.database, layaInputs);
  const layaWorker = new LayaWorkerSupervisor({ artifacts: layaArtifacts, startWorker: options.laya?.startWorker });
  const unregisterLayaWorker = registerLayaJudgeExecutor(database.database, layaWorker);
  onDatabase({
    close: () => {
      unregisterLayaWorker();
      unregisterLayaInputs();
      unregisterLayaPurge();
      void layaWorker.close();
      database.close();
    },
  });
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
    ...(options.newIntentId === undefined ? {} : { newIntentId: options.newIntentId }),
    assertObjectSecretReady: b3Ports.assertObjectSecretReady,
    ...layaInputs,
    onJudgeKindEnabled: ({ kind }) => {
      // The claim committed the pointer; the manager rechecks it before any request, row or file.
      if (kind === JUDGE_KIND_LAYA) void layaArtifacts.ensureInstalled();
    },
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
    hostedJudgeKeyFor: async ({ judgeId, judgeVersion }) => {
      const row = database.database
        .prepare('SELECT digest FROM judge_versions WHERE judge_id = ? AND version = ? AND revoked_at IS NULL')
        .get(judgeId, judgeVersion) as { digest: string } | undefined;
      if (row === undefined) return null;
      const generations = await eventSecrets.readLiveGenerations({
        owner: { kind: 'judge', id: judgeId, version: judgeVersion, digest: row.digest },
        purpose: 'judge-key',
        cipher,
      });
      const current = generations.find((generation) => generation.lifecycle === 'current');
      return current === undefined ? null : { generation: current.generation, material: current.material };
    },
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
          hostedJudgeKeyFor: async ({ judgeId, judgeVersion }) => {
            const row = database.database
              .prepare('SELECT digest FROM judge_versions WHERE judge_id = ? AND version = ? AND revoked_at IS NULL')
              .get(judgeId, judgeVersion) as { digest: string } | undefined;
            if (row === undefined) return null;
            const generations = await eventSecrets.readLiveGenerations({
              owner: { kind: 'judge', id: judgeId, version: judgeVersion, digest: row.digest },
              purpose: 'judge-key',
              cipher,
            });
            const current = generations.find((generation) => generation.lifecycle === 'current');
            return current === undefined ? null : { generation: current.generation, material: current.material };
          },
        },
        scope,
      );
      return undefined;
    },
    mailboxLock,
    sourceRegistry,
    whatsappVisibilityFence: whatsappComposition.visibilityFence,
    writerQuiescer,
    now,
    ...(options.tickMs === undefined ? {} : { tickMs: options.tickMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  // Task 5 is the sole composition point for the operator ports deliberately left unbound in Task 4.  Public
  // adapters can only reach this service through the authenticated control server below.
  const ownerB3Ports: B3ControlPorts = {
    quiescer: b3Ports.quiescer,
    secrets: b3Ports.secrets,
    assertObjectSecretReady: b3Ports.assertObjectSecretReady,
    withDeliveryWriteFence: createOwnerDeliveryWriteFence({
      store: database,
      approvals: core.approvals,
      config: core.config,
      whatsappVisibilityFence: whatsappComposition.visibilityFence,
    }),
    closeSubscriberStreams: (input) => sseStreams.closeSubscriberStreams(input),
  };
  const ownerB3Service =
    options.b3OwnerService ??
    createOwnerB3ControlService({
      store: database,
      ports: ownerB3Ports,
      config: core.config,
      activations,
      cipher,
      audit: core.audit,
      retainedRuleTest: createRetainedRuleTestControl({
        store: database,
        projections: new EventProjectionStore({ store: database, cipher }),
        accountLive: ({ source, accountId }) => assertLiveEventAccount(core.config, { source, accountId }),
        whatsappVisibilityFence: whatsappComposition.visibilityFence,
        now,
      }),
      judgeTest: new JudgeTestControl({
        store: database,
        now,
        taint: {
          record: (input) => recordEventTaint(core.taint, { ownAddresses: [], internalDomains: [] }, input),
        },
        hostedApiKeyFor: async ({ judgeId, judgeVersion }) => {
          const row = database.database
            .prepare('SELECT digest FROM judge_versions WHERE judge_id = ? AND version = ? AND revoked_at IS NULL')
            .get(judgeId, judgeVersion) as { digest: string } | undefined;
          if (row === undefined) return null;
          const generations = await eventSecrets.readLiveGenerations({
            owner: { kind: 'judge', id: judgeId, version: judgeVersion, digest: row.digest },
            purpose: 'judge-key',
            cipher,
          });
          const current = generations.find((generation) => generation.lifecycle === 'current');
          return current === undefined ? null : { generation: current.generation, material: current.material };
        },
      }),
      holdResolver: new HoldResolver({
        store: database,
        cipher,
        taint: {
          record: (input) => recordEventTaint(core.taint, { ownAddresses: [], internalDomains: [] }, input),
        },
        accountLive: ({ source, accountId }) => assertLiveEventAccount(core.config, { source, accountId }),
        authorise: ({ accountId, rule, switchGeneration }) =>
          assertDisclosable({
            database: database.database,
            approvals: core.approvals,
            config: core.config,
            accountId,
            boundary: 'dispatch',
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            switchGeneration,
          }),
        whatsappVisibilityFence: whatsappComposition.visibilityFence,
      }),
      laya: layaArtifacts,
      now,
    });
  // Task 7 is a read-only projection over the same Task 2 control ports used by the mutating B3 control service.
  // It deliberately has no writer capability and never reads a decrypted cursor or provider response.
  const doctorReport = async () => {
    return projectE2Doctor({
      database: database.database,
      installationId: database.installationId,
      lifecycle: lifecycle.status(),
      protocolVersions: [1],
      ports: ownerB3Ports,
      config: core.config,
      approvals: core.approvals,
      decryptSourceState: decryptSourceStage,
      laya: layaArtifacts,
      now,
    });
  };
  // The person's own setup (owner decision 2026-10-26): it prepares and approves through the same B3 service and
  // activation runtime as the terminal, and keeps provider keys through the one secret control.
  const judgeSetup = new JudgeSetupService({
    store: database,
    b3: ownerB3Service,
    activations,
    secrets: b3Ports.secrets,
    quiescer: writerQuiescer,
    audit: core.audit,
    now,
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
    tick: () => withEventWriterLease(writerQuiescer, () => scheduler.tick()),
    registerSseListener: (input) => sseStreams.register(input),
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      // A lane's watches and long-polls end with the service (routing §3.4).
      lanes.close();
      try {
        await scheduler.stop();
        await control?.close();
        await layaWorker.close();
        await layaArtifacts.stop();
      } finally {
        unregisterLayaWorker();
        unregisterLayaInputs();
        unregisterLayaPurge();
        // The last work's outcomes are recorded while the database is still open; this never throws.
        await deliveryActivity.stop();
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
    await withEventWriterLease(writerQuiescer, () => expiry.sweepAll());
    // Task 7 is the first production ledger caller, after the E-owned B3 gate.  A fresh all-disabled installation
    // stays inert: there can be no legitimate outstanding judge work before any kind becomes active.
    const hasActiveJudgeKind =
      (
        database.database.prepare("SELECT COUNT(*) AS count FROM active_versions WHERE kind = 'judge-kind'").get() as {
          count: number;
        }
      ).count > 0;
    if (hasActiveJudgeKind) database.immediate(() => recoverJudgeWork({ database: database.database, now: now() }));
    // D11's update rule runs before any Laya work: an enabled entry this release no longer ships is disabled through
    // E's own kind-disable tightening, with its closed audit reason, and waits for a new approval.
    await withEventWriterLease(writerQuiescer, () =>
      layaArtifacts.reconcileRelease(() =>
        new JudgeKinds({ store: database, now, activations }).disable(JUDGE_KIND_LAYA),
      ),
    );
    // Expired delivery leases are recovered by the scheduler's ticks, which claim nothing while paused or disabled.
    await withEventWriterLease(writerQuiescer, () => recoverActivations(activations));
    // An approved install a restart interrupted resumes; it never waits for the control server.
    void layaArtifacts.resume().catch(() => undefined);
    await writeToken(paths, token);
    control = await (options.startControlServer ?? startControlServer)({
      endpoint: instance.endpoint,
      token,
      handle: async (request) =>
        handleControl(
          owner,
          lifecycle,
          database,
          activations,
          dryrun,
          sourceRegistry,
          writerQuiescer,
          request,
          queue,
          lanes,
          messages,
          ownerB3Service,
          doctorReport,
          () => connectedEventAccounts(core.config),
          judgeSetup,
          readers,
        ),
      verifyEndpoint: () => verifyPrivateSocketDirectory(paths),
    });
    if (options.startControlServer === undefined) {
      await chmod(instance.endpoint, 0o600);
      await verifyControlSocket(instance.endpoint);
    }
    await writeInstance(paths, instance);
    scheduler.start();
    deliveryActivity.start(options.tickMs ?? DELIVERY_ACTIVITY_INTERVAL_MS);
    return owner;
  } catch (error) {
    await owner.stop();
    throw error;
  }
}

/** Runs the owner until a local stop request or a terminal signal closes it cleanly. */
export async function runEventOwner(options: EventOwnerOptions = {}): Promise<void> {
  const stateDir = options.stateDir ?? resolvePaths().stateDir;
  const signals = options.signals ?? process;
  const owner = await startEventOwner({ ...options, stateDir });
  // A stop by request — the control socket's `stop`, as `agent-events stop`, the events_stop tool and the desktop app's
  // switch send it — unless a signal stopped it: a logout, a shutdown or a kill is not the person's decision.
  let reason: LastStopReason = 'request';
  const stop = () => {
    reason = 'signal';
    void owner.stop();
  };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    await owner.stopped;
  } finally {
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
    await owner.stop();
  }
  // Reached only after a clean stop: a start that throws never gets here, and neither does a stop that does.
  await writeLastStop(eventPaths(stateDir), reason);
}

const LAST_STOP_FILE = 'last-stop.json';

/** Why the owner stopped: a stop request through its control socket, or a signal. */
export type LastStopReason = 'request' | 'signal';

/**
 * The clean-stop marker (desktop 0.27.0, P2): `{"version":1,"pid":…,"at":"<ISO 8601>","reason":"request"|"signal"}`
 * beside the database. A supervisor that no longer has this process as its child reads it to tell a stop from a crash:
 * a marker for the service's PID, newer than its start, with reason `request`, means the person stopped it; reason
 * `signal` — a logout, a shutdown, a kill — is not their decision, and the desktop app restarts it as after a crash.
 * Owner-only like the instance record, and written atomically, so a reader sees the previous marker or this one, never
 * a part of either.
 */
async function writeLastStop(paths: EventPaths, reason: LastStopReason): Promise<void> {
  const target = join(paths.root, LAST_STOP_FILE);
  const temporary = join(paths.root, `${LAST_STOP_FILE}.${randomBytes(8).toString('hex')}.tmp`);
  const marker = { version: 1, pid: process.pid, at: new Date().toISOString(), reason };
  try {
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** The person's reads that need the owner's clock or cipher (0.32.0). */
interface OwnerReaders {
  readonly deliveries: DeliveryReader;
  readonly rules: RuleReader;
}

async function handleControl(
  owner: EventOwner,
  lifecycle: EventLifecycle,
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  activations: ActivationRuntime,
  dispatcher: DryRunDispatcher,
  sourceRegistry: LocalEventSourceRegistry,
  writerQuiescer: WriterQuiescer,
  request: AuthenticatedControlRequest,
  queue: QueueStore,
  lanes: LaneService,
  messages: MessagesStore,
  b3OwnerService: B3OwnerService | undefined,
  doctorReport: () => Promise<unknown>,
  connectedAccounts: () => Promise<readonly ConnectedEventAccount[]> = async () => [],
  judgeSetup?: JudgeSetupService | undefined,
  readers?: OwnerReaders,
): Promise<unknown> {
  if (!isOwnerControlWireOperation(request.operation))
    throw new CommsError('USAGE', 'the local event control operation is not recognised');
  if (isB3ControlOperation(request.operation)) {
    if (!b3OwnerService) throw new CommsError('USAGE', 'the local B3 control operation is not available');
    // Routing B4 (review of 0.31.0): an agent window's delivery list leaves out every lane it is not bound to; and from
    // 0.32.0, when `delivery drop` can stop a delivery, such a window cannot drop one either: it is not there for it.
    const windowScoped =
      request.operation === OWNER_CONTROL_WIRES.deliveriesList ||
      request.operation === OWNER_CONTROL_WIRES.dropDelivery;
    const { caller, args } = windowScoped ? splitCaller(request.args) : { caller: undefined, args: request.args };
    if (caller !== undefined && request.operation === OWNER_CONTROL_WIRES.dropDelivery)
      assertDeliveryVisibleTo(database, lanes, args.deliveryId, caller);
    try {
      const result = await b3OwnerService.handle({ operation: request.operation, args, origin: request.origin });
      return caller === undefined ? result : lanes.visibleDeliveries(result, caller);
    } catch (error) {
      // A document the domain refuses is the caller's input: its fixed reason goes back, as every other operation's does.
      if (error instanceof EventDomainError)
        throw new CommsError('BAD_DATA', error.message, { details: { reason: error.code } });
      throw error;
    }
  }
  switch (request.operation) {
    case OWNER_CONTROL_WIRES.status:
      return owner.status();
    case OWNER_CONTROL_WIRES.stop:
      setTimeout(() => {
        void owner.stop();
      }, 0);
      return { stopping: true };
    case OWNER_CONTROL_WIRES.pause:
      return lifecycle.pause();
    case OWNER_CONTROL_WIRES.resume:
      return lifecycle.resume();
    case OWNER_CONTROL_WIRES.disableAll:
      return lifecycle.disableAll();
    case OWNER_CONTROL_WIRES.enableAll:
      return activations.prepareEnableAll();
    case OWNER_CONTROL_WIRES.doctor:
      return doctorReport();
    case OWNER_CONTROL_WIRES.dryrunList:
      return dispatcher.list();
    case OWNER_CONTROL_WIRES.dryrunShow:
      return dispatcher.read(requiredText(request.args.deliveryId, 'local delivery id'));
    case OWNER_CONTROL_WIRES.deliveryShow:
      if (readers === undefined) throw new CommsError('USAGE', 'delivery show is not available');
      return readers.deliveries.show(requiredText(personOnly(request.args, 'delivery show').deliveryId, 'delivery id'));
    // The action queue. Content reads are reached only from the CLI (Q1); every state change is the person's own.
    case OWNER_CONTROL_WIRES.queueList:
      return queue.list(request.args);
    case OWNER_CONTROL_WIRES.queueShow:
      return queue.show(request.args.itemId);
    // An agent window's call carries the window it comes from (`caller`), and sees no lane item but its own lane's
    // since it was bound (routing B3, B4); the person's — the CLI and the app — carries none, and sees everything.
    case OWNER_CONTROL_WIRES.queueItems: {
      const { caller, args } = splitCaller(request.args);
      return queue.items(args, callerScope(lanes, caller));
    }
    case OWNER_CONTROL_WIRES.queueCounts:
      return queue.counts(callerScope(lanes, splitCaller(request.args).caller));
    // Who marked it goes into the item's history: the window a call names, or the person, who names none (§3.6).
    case OWNER_CONTROL_WIRES.queueDone: {
      const { caller } = splitCaller(request.args);
      return queue.done(request.args.itemId, callerScope(lanes, caller), actorOf(caller));
    }
    case OWNER_CONTROL_WIRES.queueDismiss: {
      const { caller } = splitCaller(request.args);
      return queue.dismiss(request.args.itemId, callerScope(lanes, caller), actorOf(caller));
    }
    case OWNER_CONTROL_WIRES.queueReopen: {
      const { caller } = splitCaller(request.args);
      return queue.reopen(request.args.itemId, callerScope(lanes, caller), actorOf(caller));
    }
    case OWNER_CONTROL_WIRES.queueClear:
      return queue.clear();
    // Routing's lanes. `lane bind` is the person's (B1) and carries the window to bind, never a caller; `lane list`
    // and `lane unbind` are the person's without a caller, and a window's own with one; the rest are a window's.
    case OWNER_CONTROL_WIRES.laneList: {
      const { caller } = splitCaller(request.args);
      return caller === undefined ? lanes.list() : lanes.listFor(caller);
    }
    case OWNER_CONTROL_WIRES.laneBind:
      if (Object.hasOwn(request.args, 'caller'))
        throw new CommsError('APPROVAL_REQUIRED', 'binding a lane is for a person at a terminal, not an agent window');
      return lanes.bind(request.args.lane, request.args.window);
    case OWNER_CONTROL_WIRES.laneUnbind:
      return lanes.unbind(request.args.lane, splitCaller(request.args).caller);
    case OWNER_CONTROL_WIRES.laneWhoami:
      return lanes.whoami(requiredCaller(request.args));
    case OWNER_CONTROL_WIRES.laneWatch:
      return lanes.watch(request.args.lane, requiredCaller(request.args));
    case OWNER_CONTROL_WIRES.laneTaskGet:
      return lanes.taskGet(request.args.taskId, requiredCaller(request.args));
    case OWNER_CONTROL_WIRES.laneTaskCancel:
      return lanes.taskCancel(request.args.taskId, requiredCaller(request.args));
    case OWNER_CONTROL_WIRES.laneWait:
      return lanes.wait(request.args.lane, request.args.seconds, requiredCaller(request.args), request.signal);
    case OWNER_CONTROL_WIRES.laneItem:
      return lanes.item(request.args.itemId, requiredCaller(request.args));
    // What happened to each message (0.32.0 §3.6): the person's, from the CLI and the app; a caller is refused.
    case OWNER_CONTROL_WIRES.messagesList:
      return messages.list(personOnly(request.args, 'messages list'));
    case OWNER_CONTROL_WIRES.messageShow:
      return messages.show(personOnly(request.args, 'message show').eventId);
    // The person's own setup (owner decision 2026-10-26): its service accepts only the person's setup origin.
    case OWNER_CONTROL_WIRES.judgeSetup:
      return requireJudgeSetup(judgeSetup).setup(request.args, request.origin);
    case OWNER_CONTROL_WIRES.providerList:
      return requireJudgeSetup(judgeSetup).providerList();
    case OWNER_CONTROL_WIRES.providerKeySet:
      return requireJudgeSetup(judgeSetup).providerKeySet(request.args, request.origin);
    case OWNER_CONTROL_WIRES.providerKeyRemove:
      return requireJudgeSetup(judgeSetup).providerKeyRemove(request.args, request.origin);
    case OWNER_CONTROL_WIRES.catalogueList:
      return CATALOGUE.map((definition) => ({ type: definition.type, version: definition.version }));
    case OWNER_CONTROL_WIRES.catalogueShow: {
      const type = requiredText(request.args.type, 'catalogue type');
      const definition = CATALOGUE.find((candidate) => candidate.type === type);
      if (!definition) throw new CommsError('NOT_FOUND', 'the requested event type is not in the local catalogue');
      return { type: definition.type, version: definition.version, channel: definition.type.split('.')[0] };
    }
    case OWNER_CONTROL_WIRES.sourcesList:
      return sourceRows(database, sourceRegistry, await connectedAccounts());
    case OWNER_CONTROL_WIRES.sourceShow:
      return sourceShow(
        database,
        sourceRegistry,
        requiredText(request.args.source, 'source'),
        await connectedAccounts(),
      );
    case OWNER_CONTROL_WIRES.rulesList:
      return ruleRows(database);
    case OWNER_CONTROL_WIRES.ruleShow:
      if (readers === undefined) throw new CommsError('USAGE', 'rule show is not available');
      return readers.rules.show(requiredText(request.args.ruleId, 'rule id'));
    case OWNER_CONTROL_WIRES.createRule:
    case OWNER_CONTROL_WIRES.updateRule:
      return createRule(database, request.args.document);
    case OWNER_CONTROL_WIRES.enableRule:
      // A rule the domain refuses to activate — its judge's kind disabled, or its Laya judge not offered here — is
      // refused with that fixed reason, as rule create's documents are.
      return domainAwaited(() =>
        activations.prepareRule({
          ruleId: requiredText(request.args.ruleId, 'rule id'),
          version: requiredVersion(request.args.version, 'rule version'),
        }),
      );
    case OWNER_CONTROL_WIRES.disableRule:
    case OWNER_CONTROL_WIRES.removeRule:
      return disableRule(database, activations, requiredText(request.args.ruleId, 'rule id'));
    case OWNER_CONTROL_WIRES.targetsList:
      return targetRows(database);
    case OWNER_CONTROL_WIRES.addTarget:
    case OWNER_CONTROL_WIRES.updateTarget:
      return createTarget(database, request.args.document);
    case OWNER_CONTROL_WIRES.removeTarget:
      return removeTarget(database, activations, requiredText(request.args.targetId, 'target id'));
    case OWNER_CONTROL_WIRES.approveChallenge:
      return issueTerminalApprovalChallenge({
        store: database,
        activations,
        approvalId: requiredText(request.args.approvalId, 'approval id'),
        origin: request.origin,
      });
    case OWNER_CONTROL_WIRES.approve:
      return withEventWriterLease(writerQuiescer, () =>
        activations.approve({
          approvalId: requiredText(request.args.approvalId, 'approval id'),
          answer: requiredText(request.args.answer, 'approval answer'),
          via: disclosureApprovalChannel(request.origin),
        }),
      );
    default:
      throw new CommsError('USAGE', 'the local event control operation is not recognised');
  }
}

function requireJudgeSetup(service: JudgeSetupService | undefined): JudgeSetupService {
  if (service === undefined) throw new CommsError('CONFIG', 'judge setup is not composed for this owner');
  return service;
}

/** A control request's calling window, when it is an agent window's, and its other arguments. */
/** A lane target's delivery is not there for a window not bound to the lane (routing B4): the same answer as none. */
function assertDeliveryVisibleTo(
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  lanes: LaneService,
  deliveryId: unknown,
  caller: LaneWindowIdentity,
): void {
  if (typeof deliveryId !== 'string') return;
  const row = database.database
    .prepare('SELECT target_id AS targetId, target_version AS targetVersion FROM deliveries WHERE id = ?')
    .get(deliveryId);
  if (row === undefined) return;
  const visible = lanes.visibleDeliveries([{ ...row }], caller) as readonly unknown[];
  if (visible.length === 0) throw new CommsError('NOT_FOUND', 'the delivery does not exist');
}

function splitCaller(args: Readonly<Record<string, unknown>>): {
  readonly caller: LaneWindowIdentity | undefined;
  readonly args: Record<string, unknown>;
} {
  const { caller, ...rest } = args;
  if (caller === undefined) return { caller: undefined, args: rest };
  const parsed = parseLaneWindowIdentity(caller);
  if (parsed === null) throw new CommsError('USAGE', 'the calling window is not one the event service can read');
  return { caller: parsed, args: rest };
}

function requiredCaller(args: Readonly<Record<string, unknown>>): LaneWindowIdentity {
  const { caller } = splitCaller(args);
  if (caller === undefined) throw new CommsError('USAGE', 'this lane operation is an agent window’s, and names it');
  return caller;
}

/** What a caller may see of the queue: everything for the person, and an agent window's lane scope for a window. */
function callerScope(lanes: LaneService, caller: LaneWindowIdentity | undefined): QueueScope | undefined {
  if (caller === undefined) return undefined;
  try {
    lanes.seen(caller);
  } catch (error) {
    // A report the lanes refuse (it names other ids for a recorded window) is not recorded; the scope still holds.
    if (!isCommsError(error)) throw error;
  }
  return lanes.scopeFor(caller);
}

/**
 * The person's reads take no calling window: the CLI and the app send none, and the event service's MCP server, which
 * sends one with every call it makes, has no tool that asks for these. A request that names one is refused.
 */
function personOnly(args: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> {
  if (Object.hasOwn(args, 'caller'))
    throw new CommsError(
      'APPROVAL_REQUIRED',
      `${name} is for a person, at a terminal or in the app, not an agent window`,
    );
  return args;
}

/** A queue change's actor: the agent window a call names, by its activity session key, or else the person. */
function actorOf(caller: LaneWindowIdentity | undefined): QueueActor {
  return caller === undefined ? PERSON : { actor: 'window', windowKey: caller.activityKey };
}

/** The client name chooses only the receipt channel; same-user token holders remain inside B3's trust boundary. */
export function disclosureApprovalChannel(origin: string | undefined): 'terminal' | 'app' {
  return origin === 'app-approval-screen' ? 'app' : 'terminal';
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CommsError('USAGE', `${name} is required`);
  return value;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CommsError('USAGE', `${name} is required`);
  return value as Record<string, unknown>;
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

/** `domain` for an operation that awaits: a refusal is the caller's input, with the same fixed reason. */
async function domainAwaited<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
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

/**
 * The owner composes E2's artifact manager, so the rules it keeps carry B3 control v3's judge documents. A version that
 * narrows the active one carries its tightening's preview: what enabling it removes at once (action queue Q6).
 */
function createRule(database: Awaited<ReturnType<typeof openEventDatabase>>, document: unknown): unknown {
  return domain(() => {
    const created = ImmutableVersions.forJudgeContract(database.database, 'b3-control-v3').createRule(document);
    const tightening = tighteningPreviewFor(database.database, created.document);
    return tightening === undefined ? created : { ...created, tightening };
  });
}

function targetRows(database: Awaited<ReturnType<typeof openEventDatabase>>): unknown[] {
  return database.database
    .prepare('SELECT target_id, version, digest, revoked_at FROM target_versions ORDER BY target_id, version')
    .all();
}

function createTarget(database: Awaited<ReturnType<typeof openEventDatabase>>, document: unknown): unknown {
  return domain(() => new ImmutableVersions(database.database).createTarget(document as never));
}

/**
 * Each source's accounts: the scopes active rules read, and every connected account a rule may name, which has no
 * cursor scope until a rule reads it. Each carries the name it was connected under, so a person, or an agent writing
 * a first rule, can tell `ibx_…` from `ibx_…` (CUE-474).
 */
function sourceRows(
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  sourceRegistry: LocalEventSourceRegistry,
  connected: readonly ConnectedEventAccount[] = [],
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
  const nameOf = new Map(connected.map((entry) => [`${entry.source}\u0000${entry.accountId}`, entry.account]));
  const accounts: { source: string; accountId: string; account: string | null; cursorScope: string | null }[] = [
    ...scopes.values(),
  ].map((scope) => ({ ...scope, account: nameOf.get(`${scope.source}\u0000${scope.accountId}`) ?? null }));
  for (const entry of connected)
    if (!accounts.some((row) => row.source === entry.source && row.accountId === entry.accountId))
      accounts.push({ source: entry.source, accountId: entry.accountId, account: entry.account, cursorScope: null });
  const ordered = accounts.sort((left, right) =>
    `${left.source}\u0000${left.accountId}\u0000${left.cursorScope ?? ''}`.localeCompare(
      `${right.source}\u0000${right.accountId}\u0000${right.cursorScope ?? ''}`,
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
  connected: readonly ConnectedEventAccount[] = [],
): unknown {
  if (!sourceRegistry.sources().includes(source as Parameters<LocalEventSourceRegistry['require']>[0]))
    throw new CommsError('NOT_FOUND', 'the requested source is not configured');
  return {
    source,
    accounts: (
      sourceRows(database, sourceRegistry, connected).find((row) => (row as { source: string }).source === source) as {
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
