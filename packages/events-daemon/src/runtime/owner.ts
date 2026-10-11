import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import {
  type ApprovalStore,
  type AuditLog,
  CommsError,
  type ConfigStore,
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
import { EventDomainError } from '../domain/lifecycle.ts';
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
import { assertLiveEventAccount } from './account-fence.ts';
import { ActivationRuntime } from './activations.ts';
import { type B3ControlPorts, type B3DeliveryWriteFenceRequest, createB3ControlPorts } from './b3-control-ports.ts';
import { projectB3Doctor } from './b3-doctor-projection.ts';
import { B3OperatorControl } from './b3-operator-control.ts';
import { type PendingTargetOrigin, verifyPendingTargetContext } from './b3-pending-activation-context.ts';
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
import { hasLiveDeliveryLineage } from './delivery-claim.ts';
import { assertDisclosable } from './disclosure-fence.ts';
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
import { EventProjectionStore } from './projections.ts';
import { recoverActivations } from './recovery.ts';
import { GmailReplacementDrains, replacementIntentSummary } from './replacements.ts';
import { disableRule, removeTarget } from './revocations.ts';
import { EventScheduler } from './scheduler.ts';
import { runSourceOwnerWork, stageWhatsAppBaselineSnapshot } from './source-owner-work.ts';
import { SseDispatcher } from './sse-dispatcher.ts';
import type { SseServer } from './sse-server.ts';
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
  readonly activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge'>;
  readonly cipher: Pick<EventRecordCipher, 'encrypt'>;
  /** A B3 secret command writes only this content-free receipt-shaped audit record. */
  readonly audit?: Pick<AuditLog, 'append'> | undefined;
  readonly targetTestTransport?: FixedSyntheticTargetTransport | undefined;
  /** The production exact-projection reader is composed by the owner, never by a public adapter. */
  readonly retainedRuleTest?: Pick<RetainedRuleTestControl, 'test'> | undefined;
  readonly now?: (() => number) | undefined;
}

/** Composes every Task 3/4 control behind the authenticated owner; public adapters never reach a runtime class. */
export function createOwnerB3ControlService(options: OwnerB3ControlServiceOptions): B3OwnerService {
  const now = options.now ?? Date.now;
  const operator = new B3OperatorControl({ store: options.store, ports: options.ports, now });
  const target = (pendingOrigin?: PendingTargetOrigin) =>
    new B3TargetTestControl({
      store: options.store,
      ports: options.ports,
      // The owner has no target-specific synthetic transport before the real transport owner is selected. Dry-run
      // tests are a sealed local success; a network target cannot be reached by this fallback.
      transport:
        options.targetTestTransport ??
        (async ({ target: selected }: { readonly target: { readonly kind: string } }) => {
          if (selected.kind !== 'dry-run')
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
          return approvalViewFromOwner(options.store, options.activations, now, request.args);
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

async function approvalViewFromOwner(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  activations: Pick<ActivationRuntime, 'issueApprovalViewChallenge'>,
  now: () => number,
  args: Readonly<Record<string, unknown>>,
): Promise<B3ApprovalViewResultV1> {
  const approvalId = requiredText(args.approvalId, 'approval id');
  const digest = requiredText(args.digest, 'approval digest');
  const row = store.database
    .prepare('SELECT id, document, digest, status FROM activation_intents WHERE approval_id = ?')
    .get(approvalId) as { id: string; document: string; digest: string; status: string } | undefined;
  if (row === undefined || row.status !== 'pending') return { kind: 'STALE_APPROVAL' };
  if (row.digest !== digest) return { kind: 'DIGEST_MISMATCH' };
  const nextExpiry = now() + 5 * 60 * 1_000;
  const challenge = await activations.issueApprovalViewChallenge(approvalId, nextExpiry);
  if (challenge === null) return { kind: 'CHALLENGE_EXPIRED' };
  const preview = normaliseActivationDocument(JSON.parse(row.document));
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
  };
}

export interface TerminalApprovalStart {
  readonly challenge: string;
  readonly pendingTargetSelectors: readonly B3PendingTargetSelectorV1[];
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
    assertObjectSecretReady: b3Ports.assertObjectSecretReady,
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
    ...(options.newIntentId === undefined ? {} : { newIntentId: options.newIntentId }),
    assertObjectSecretReady: b3Ports.assertObjectSecretReady,
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
      now,
    });
  // Task 7 is a read-only projection over the same Task 2 control ports used by the mutating B3 control service.
  // It deliberately has no writer capability and never reads a decrypted cursor or provider response.
  const doctorReport = async () => {
    return projectB3Doctor({
      database: database.database,
      installationId: database.installationId,
      lifecycle: lifecycle.status(),
      protocolVersions: [1],
      ports: ownerB3Ports,
      config: core.config,
      approvals: core.approvals,
      decryptSourceState: decryptSourceStage,
      now,
    });
  };
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
    await withEventWriterLease(writerQuiescer, () => expiry.sweepAll());
    // Expired delivery leases are recovered by the scheduler's ticks, which claim nothing while paused or disabled.
    await withEventWriterLease(writerQuiescer, () => recoverActivations(activations));
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
          ownerB3Service,
          doctorReport,
        ),
      verifyEndpoint: () => verifyPrivateSocketDirectory(paths),
    });
    if (options.startControlServer === undefined) {
      await chmod(instance.endpoint, 0o600);
      await verifyControlSocket(instance.endpoint);
    }
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
  database: Awaited<ReturnType<typeof openEventDatabase>>,
  activations: ActivationRuntime,
  dispatcher: DryRunDispatcher,
  sourceRegistry: LocalEventSourceRegistry,
  writerQuiescer: WriterQuiescer,
  request: AuthenticatedControlRequest,
  b3OwnerService: B3OwnerService | undefined,
  doctorReport: () => Promise<unknown>,
): Promise<unknown> {
  if (!isOwnerControlWireOperation(request.operation))
    throw new CommsError('USAGE', 'the local event control operation is not recognised');
  if (isB3ControlOperation(request.operation)) {
    if (!b3OwnerService) throw new CommsError('USAGE', 'the local B3 control operation is not available');
    try {
      return await b3OwnerService.handle({ operation: request.operation, args: request.args, origin: request.origin });
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
    case OWNER_CONTROL_WIRES.catalogueList:
      return CATALOGUE.map((definition) => ({ type: definition.type, version: definition.version }));
    case OWNER_CONTROL_WIRES.catalogueShow: {
      const type = requiredText(request.args.type, 'catalogue type');
      const definition = CATALOGUE.find((candidate) => candidate.type === type);
      if (!definition) throw new CommsError('NOT_FOUND', 'the requested event type is not in the local catalogue');
      return { type: definition.type, version: definition.version, channel: definition.type.split('.')[0] };
    }
    case OWNER_CONTROL_WIRES.sourcesList:
      return sourceRows(database, sourceRegistry);
    case OWNER_CONTROL_WIRES.sourceShow:
      return sourceShow(database, sourceRegistry, requiredText(request.args.source, 'source'));
    case OWNER_CONTROL_WIRES.rulesList:
      return ruleRows(database);
    case OWNER_CONTROL_WIRES.ruleShow:
      return ruleShow(database, requiredText(request.args.ruleId, 'rule id'));
    case OWNER_CONTROL_WIRES.createRule:
    case OWNER_CONTROL_WIRES.updateRule:
      return createRule(database, request.args.document);
    case OWNER_CONTROL_WIRES.enableRule:
      return activations.prepareRule({
        ruleId: requiredText(request.args.ruleId, 'rule id'),
        version: requiredVersion(request.args.version, 'rule version'),
      });
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
