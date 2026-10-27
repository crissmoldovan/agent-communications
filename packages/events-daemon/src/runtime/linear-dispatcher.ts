import { randomUUID } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore, sha256Hex } from '@agentcomms/core';
import { canonicalLinearChangeTarget, type LinearChangeTargetDocument } from '../domain/linear-change-target.ts';
import { canonicalLinearTarget, type LinearTargetDocument, linearIssueId } from '../domain/linear-target.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventSecretStore, providerSecretOwner } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { assertLiveEventAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { LinearDeliveryRecord } from './deliveries.ts';
import {
  type ClaimedDelivery,
  claimDelivery,
  type DeliveryClaimResult,
  hasLiveDeliveryLineage,
  isCurrentDeliveryClaim,
  releaseDeliveryClaimInTransaction,
} from './delivery-claim.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatchHandler, DispatchResult } from './dispatcher.ts';
import { changeLinearIssue, type LinearChangeDeliveryRecord, linearChangeRecord } from './linear-change-dispatcher.ts';
import {
  type LinearClient,
  LinearGateRefused,
  type LinearGates,
  type LinearPhase,
  linearFailure,
} from './linear-client.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

/*
 * The Linear target's delivery (0.33.0 design §3.4): one `issueCreate` through the pinned connection, with the person's
 * Linear key, of the issue rendered when the rule matched. It keeps the webhook's boundary: an exact claim, every
 * authority fence before each network phase and a synchronous gate right before it, a WhatsApp chat's visibility checked
 * under its lock before the write, and a settlement that only the exact claim can make.
 *
 * A retry cannot add a second issue. The issue's id is chosen from the delivery's (`linearIssueId`), and every try
 * first asks Linear for an issue with that id — archived ones too — and records the one it finds instead of creating
 * another. A rate limit, a 5xx or no usable answer retries, as a webhook's failure does; Linear refusing the request
 * (a 4xx, or a GraphQL error) fails at once with Linear's code. The delivery records the issue's id, its identifier and
 * its address without the title's words — content-free — and nothing Linear said.
 *
 * A workflow's Linear change (0.36, §6.7) is delivered here too, inside this same boundary: a comment on and an
 * update of the issue its run made (`linear-change-dispatcher.ts`), recorded as the issue it changed.
 */

/** How many tries a Linear delivery gets before it fails for good. */
export const LINEAR_RETRY_LIMIT = 10;

const DEFAULT_LEASE_MS = 60_000;
const LEASE_MARGIN_MS = 2_000;
const DEFAULT_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

const LOOKUP_QUERY =
  'query AgentCommsLinearIssueLookup($id: ID!) { viewer { id } issues(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id identifier url } } }';
const CREATE_MUTATION =
  'mutation AgentCommsLinearIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }';

/** The issue a delivery added, as the delivery keeps it: ids and an address, nothing it says. */
export interface LinearIssueRecord {
  readonly id: string;
  readonly identifier: string;
  readonly url: string;
}

/** A settled try: the issue, a failure to try again, or one that will not succeed. */
export type LinearDeliveryOutcome =
  | { readonly kind: 'created'; readonly issue: LinearIssueRecord; readonly status: number }
  | { readonly kind: 'retry'; readonly code: string; readonly status: number | null }
  | { readonly kind: 'failed'; readonly code: string; readonly status: number | null };

/** Test-only durable-boundary interruption points; never configuration or a public surface. */
export type LinearCrashPoint = 'after-claim' | 'after-lookup' | 'after-create' | 'after-outcome';

export interface LinearDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: EventRecordCipher;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly secrets: Pick<EventSecretStore, 'readLiveGenerations'>;
  readonly client: Pick<LinearClient, 'request'>;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  /** D's concrete fence is mandatory before a WhatsApp message's issue may be written. */
  readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentSseFrameVisibility'> | undefined;
  readonly hasConcreteWhatsAppVisibilityFence?: boolean | undefined;
  readonly testFailpoint?: ((point: LinearCrashPoint, claim: ClaimedDelivery) => void) | undefined;
}

interface DeliveryRow {
  readonly id: string;
  readonly account_id: string;
  readonly expires_at: number;
  readonly whatsapp_message_id: string | null;
}

interface LoadedTarget {
  /** A Linear target's, or — a workflow's delivery (0.36) — a Linear change's. */
  readonly document: LinearTargetDocument | LinearChangeTargetDocument;
  readonly digest: string;
}

interface LinearKey {
  readonly generation: number;
  readonly secretDigest: string;
  readonly material: string;
}

/** A gate that stopped a try: its result is the dispatch's. */
class GateStop extends Error {
  readonly result: DispatchResult;

  constructor(result: DispatchResult) {
    super(`the Linear delivery stopped: ${result.state}`);
    this.name = 'GateStop';
    this.result = result;
  }
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,32}-[0-9]{1,10}$/u;

/**
 * The issue as the delivery keeps it, or null when Linear's answer is not one. The address loses the title's words
 * Linear appends (`/issue/CUE-12/pay-the-invoice` → `/issue/CUE-12`), so nothing the sender wrote is kept.
 */
export function linearIssueRecord(value: unknown): LinearIssueRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, identifier, url } = value as { id?: unknown; identifier?: unknown; url?: unknown };
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/u.test(id)) return null;
  if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) return null;
  const match =
    typeof url === 'string' ? /^https:\/\/linear\.app\/([A-Za-z0-9_-]{1,64})\/issue\/([^/?#]+)/u.exec(url) : null;
  const address =
    match !== null && match[2] === identifier
      ? `https://linear.app/${match[1]}/issue/${identifier}`
      : `https://linear.app/issue/${identifier}`;
  return { id, identifier, url: address };
}

export class LinearDispatcher implements DeliveryDispatchHandler {
  readonly #store: EventDatabase;
  readonly #cipher: EventRecordCipher;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #secrets: Pick<EventSecretStore, 'readLiveGenerations'>;
  readonly #client: Pick<LinearClient, 'request'>;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #whatsappVisibilityFence: Pick<WhatsAppVisibilityFence, 'withCurrentSseFrameVisibility'> | undefined;
  readonly #hasConcreteWhatsAppVisibilityFence: boolean;
  readonly #testFailpoint: ((point: LinearCrashPoint, claim: ClaimedDelivery) => void) | undefined;

  constructor(options: LinearDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#secrets = options.secrets;
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#fence = options.fence ?? assertDisclosable;
    this.#whatsappVisibilityFence = options.whatsappVisibilityFence;
    this.#hasConcreteWhatsAppVisibilityFence = options.hasConcreteWhatsAppVisibilityFence ?? false;
    this.#testFailpoint = options.testFailpoint;
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    let claimed: DeliveryClaimResult;
    try {
      claimed = await claimDelivery({
        store: this.#store,
        deliveryId,
        now: this.#now(),
        leaseMs: this.#leaseMs,
        newAttemptId: randomUUID,
        newLeaseToken: randomUUID,
        assertAccountLive: (accountId) =>
          assertLiveEventAccount(this.#config, { source: sourceOfDelivery(this.#store, deliveryId), accountId }),
        preflight: async (row) => {
          await this.#fence(this.#fenceRequest(row));
        },
      });
    } catch (error) {
      const row = delivery(this.#store, deliveryId);
      if (row !== undefined && isRemovedAccountError(error)) {
        this.#purgeAccount(deliveryId, row.account_id);
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const claim = claimed.claim;
    this.#testFailpoint?.('after-claim', claim);
    // One deadline for both requests, before the lease ends, so recovery never starts a second try beside this one.
    const deadline =
      Math.min(Date.now() + this.#leaseMs, Date.now() + (claim.leaseUntil - this.#now())) - LEASE_MARGIN_MS;
    let record: LinearDeliveryRecord | LinearChangeDeliveryRecord;
    let target: LoadedTarget;
    try {
      record = parseRecord(await this.#cipher.decrypt(deliveryLocation(claim.id), claim.encryptedRecord));
      target = this.#loadTarget(claim);
    } catch (error) {
      this.#release(claim);
      throw error;
    }
    const key = await this.#key();
    if (key === null) return this.#settle(claim, { kind: 'retry', code: 'LINEAR_KEY_MISSING', status: null });
    const whatsappMessageId = delivery(this.#store, claim.id)?.whatsapp_message_id ?? null;
    if (
      whatsappMessageId !== null &&
      (this.#whatsappVisibilityFence === undefined || !this.#hasConcreteWhatsAppVisibilityFence)
    ) {
      this.#cancelContentFree(claim);
      return { state: 'terminal', deliveryId: claim.id };
    }
    const issueId = linearIssueId(claim.id);
    try {
      // A workflow's Linear change (0.36 §6.7): on the issue its run made, with this boundary's fences on each request.
      if (record.kind === 'linear-change' || target.document.kind === 'linear-change') {
        if (record.kind !== 'linear-change' || target.document.kind !== 'linear-change')
          return this.#settle(claim, { kind: 'failed', code: 'LINEAR_RECORD_MISMATCH', status: null });
        const changed = await changeLinearIssue({
          client: this.#client,
          key: key.material,
          target: target.document,
          record,
          deliveryId: claim.id,
          gates: (write) => this.#gates(claim, target, key, write ? whatsappMessageId : null),
          deadline,
          failpoint: (point) =>
            this.#testFailpoint?.(point === 'after-lookup' ? 'after-lookup' : 'after-create', claim),
        });
        return this.#settle(
          claim,
          changed.kind === 'changed' ? { kind: 'created', issue: changed.issue, status: changed.status } : changed,
        );
      }
      const document = target.document;
      // 1. The issue a try of this delivery made already, if any: found, it is the delivery's, and nothing is created.
      const lookup = await this.#client.request({
        key: key.material,
        query: LOOKUP_QUERY,
        variables: { id: issueId },
        gates: this.#gates(claim, target, key),
        deadline,
      });
      this.#testFailpoint?.('after-lookup', claim);
      if (lookup.kind !== 'data') return this.#settle(claim, linearFailure(lookup));
      const nodes = (lookup.data.issues as { nodes?: unknown } | null)?.nodes;
      const existing = Array.isArray(nodes)
        ? nodes.find((node) => (node as { id?: unknown })?.id === issueId)
        : undefined;
      if (existing !== undefined) {
        const issue = linearIssueRecord(existing);
        if (issue === null)
          return this.#settle(claim, { kind: 'retry', code: 'LINEAR_ANSWER_INVALID', status: lookup.status });
        return this.#settle(claim, { kind: 'created', issue, status: lookup.status });
      }
      const viewer = (lookup.data.viewer as { id?: unknown } | null)?.id;
      if (document.assignee === 'me' && typeof viewer !== 'string')
        return this.#settle(claim, { kind: 'retry', code: 'LINEAR_ANSWER_INVALID', status: lookup.status });
      // 2. The issue, created with its own id: a retry after a lost answer finds it in step 1.
      const assigneeId =
        document.assignee === null ? undefined : document.assignee === 'me' ? (viewer as string) : document.assignee.id;
      const input = {
        id: issueId,
        teamId: document.team.id,
        title: record.title,
        description: record.description,
        ...(document.labels.length === 0 ? {} : { labelIds: document.labels.map((label) => label.id) }),
        ...(assigneeId === undefined ? {} : { assigneeId }),
      };
      const created = await this.#client.request({
        key: key.material,
        query: CREATE_MUTATION,
        variables: { input },
        gates: this.#gates(claim, target, key, whatsappMessageId),
        deadline,
      });
      this.#testFailpoint?.('after-create', claim);
      if (created.kind !== 'data') return this.#settle(claim, linearFailure(created));
      const result = created.data.issueCreate as { success?: unknown; issue?: unknown } | null;
      const issue = result?.success === true ? linearIssueRecord(result.issue) : null;
      if (issue === null || issue.id !== issueId)
        return this.#settle(claim, { kind: 'failed', code: 'LINEAR_NOT_CREATED', status: created.status });
      return this.#settle(claim, { kind: 'created', issue, status: created.status });
    } catch (error) {
      if (error instanceof LinearGateRefused && error.cause instanceof GateStop) return error.cause.result;
      if (error instanceof LinearGateRefused && isRemovedAccountError(error.cause)) {
        this.#purgeAccount(claim.id, claim.accountId);
        return { state: 'terminal', deliveryId: claim.id };
      }
      // An authority that refused and is not a stable state: the claim is released, and the refusal propagates.
      this.#release(claim);
      throw error instanceof LinearGateRefused ? error.cause : error;
    }
  }

  /** Each phase's gates: the awaited fences, then the synchronous re-read right before the phase's action. */
  #gates(
    claim: ClaimedDelivery,
    target: LoadedTarget,
    key: LinearKey,
    whatsappMessageId: string | null = null,
  ): LinearGates {
    const finalGate = (_phase: LinearPhase) => {
      const stopped = this.#store.immediate(() => this.#gateState(claim, target, key));
      if (stopped !== null) throw new GateStop(stopped);
    };
    return {
      beforeGate: (phase) => this.#prepareGate(claim, target, key, phase),
      finalGate,
      ...(whatsappMessageId === null || this.#whatsappVisibilityFence === undefined
        ? {}
        : {
            // The write happens under the WhatsApp chat list's lock, after a fresh authority check: an unlisted chat
            // sends nothing, and the delivery ends content-free.
            write: async (send: () => void) => {
              const fence = this.#whatsappVisibilityFence as Pick<
                WhatsAppVisibilityFence,
                'withCurrentSseFrameVisibility'
              >;
              let sent = false;
              await fence.withCurrentSseFrameVisibility(
                { accountId: claim.accountId, whatsappMessageId },
                () => this.#prepareGate(claim, target, key, 'write'),
                () => {
                  send();
                  sent = true;
                },
              );
              if (!sent) {
                this.#cancelContentFree(claim);
                throw new GateStop({ state: 'terminal', deliveryId: claim.id });
              }
            },
          }),
    };
  }

  /** The awaited policy reads before a phase; a removed account purges, and a stable state stops the try. */
  async #prepareGate(claim: ClaimedDelivery, target: LoadedTarget, key: LinearKey, phase: LinearPhase): Promise<void> {
    try {
      await this.#fence(this.#fenceRequest(claim, `webhook-${phase}`));
      await assertLiveEventAccount(this.#config, {
        source: sourceOfDelivery(this.#store, claim.id),
        accountId: claim.accountId,
      });
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#purgeAccount(claim.id, claim.accountId);
        throw new GateStop({ state: 'terminal', deliveryId: claim.id });
      }
      const stable = this.#store.immediate(() => this.#gateState(claim, target, key));
      if (stable !== null) throw new GateStop(stable);
      throw error;
    }
  }

  /** Every mutable fact, re-read in one immediate transaction: the claim, the switch, the target and the key. */
  #gateState(claim: ClaimedDelivery, target: LoadedTarget, key: LinearKey): DispatchResult | null {
    const database = this.#store.database;
    const row = delivery(this.#store, claim.id);
    if (row === undefined || !isCurrentDeliveryClaim(database, claim))
      return { state: 'terminal', deliveryId: claim.id };
    if (row.expires_at <= this.#now()) return { state: 'expired', deliveryId: claim.id };
    const setting = database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    const lineage = database
      .prepare('SELECT rule_id, rule_version, target_id, target_version FROM deliveries WHERE id = ?')
      .get(claim.id) as { rule_id: string; rule_version: number; target_id: string; target_version: number };
    if (
      setting?.enabled !== 1 ||
      setting.switch_generation !== claim.switchGeneration ||
      !hasLiveDeliveryLineage(database, lineage)
    )
      return { state: 'terminal', deliveryId: claim.id };
    if (setting.paused === 1) {
      releaseDeliveryClaimInTransaction(database, claim);
      return { state: 'paused', deliveryId: claim.id };
    }
    const barrier = database
      .prepare(
        'SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1',
      )
      .get(claim.targetId, claim.targetVersion) as { state: string } | undefined;
    if (barrier && barrier.state !== 'open') {
      releaseDeliveryClaimInTransaction(database, claim);
      return { state: 'waiting-reset', deliveryId: claim.id };
    }
    const stored = database
      .prepare('SELECT document, digest, revoked_at FROM target_versions WHERE target_id = ? AND version = ?')
      .get(claim.targetId, claim.targetVersion) as
      | { document: string; digest: string; revoked_at: number | null }
      | undefined;
    if (
      stored?.revoked_at !== null ||
      stored?.digest !== target.digest ||
      sha256Hex(stored?.document ?? '') !== target.digest
    )
      return { state: 'terminal', deliveryId: claim.id };
    // The person's key, as it was read: removed or replaced since, this try stops before its next phase.
    const owner = providerSecretOwner('linear');
    const current = database
      .prepare(
        `SELECT generation, secret_digest FROM event_secret_generations
          WHERE owner_kind = 'provider' AND owner_id = ? AND owner_version = ? AND purpose = 'provider-key'
            AND lifecycle = 'current'`,
      )
      .get(owner.id, owner.version) as { generation: number; secret_digest: string } | undefined;
    if (current?.generation !== key.generation || current.secret_digest !== key.secretDigest) {
      // The delivery waits for its next try, which reads the key the slot holds then, or finds none.
      releaseDeliveryClaimInTransaction(database, claim);
      return { state: 'busy', deliveryId: claim.id };
    }
    return null;
  }

  async #key(): Promise<LinearKey | null> {
    const generations = await this.#secrets.readLiveGenerations({
      owner: providerSecretOwner('linear'),
      purpose: 'provider-key',
      cipher: this.#cipher,
    });
    const current = generations.find((generation) => generation.lifecycle === 'current');
    return current === undefined
      ? null
      : { generation: current.generation, secretDigest: current.secretDigest, material: current.material };
  }

  #loadTarget(claim: ClaimedDelivery): LoadedTarget {
    const row = this.#store.database
      .prepare('SELECT document, digest, revoked_at FROM target_versions WHERE target_id = ? AND version = ?')
      .get(claim.targetId, claim.targetVersion) as
      | { document: string; digest: string; revoked_at: number | null }
      | undefined;
    if (!row || row.revoked_at !== null) throw new CommsError('APPROVAL_VOID', 'the Linear target is no longer live');
    let document: LinearTargetDocument | LinearChangeTargetDocument;
    try {
      const parsed = JSON.parse(row.document) as Record<string, unknown>;
      document = parsed.kind === 'linear-change' ? canonicalLinearChangeTarget(parsed) : canonicalLinearTarget(parsed);
    } catch {
      throw new CommsError('APPROVAL_VOID', 'the stored Linear target is invalid');
    }
    if (
      document.targetId !== claim.targetId ||
      document.version !== claim.targetVersion ||
      sha256Hex(row.document) !== row.digest
    )
      throw new CommsError('APPROVAL_VOID', 'the stored Linear target no longer has its immutable binding');
    return { document, digest: row.digest };
  }

  /** A settled try, after the authority is read again; only the exact claim's owner can settle it. */
  async #settle(claim: ClaimedDelivery, outcome: LinearDeliveryOutcome): Promise<DispatchResult> {
    let authorityLost = false;
    try {
      await this.#fence(this.#fenceRequest(claim));
      await assertLiveEventAccount(this.#config, {
        source: sourceOfDelivery(this.#store, claim.id),
        accountId: claim.accountId,
      });
    } catch (error) {
      if (isRemovedAccountError(error)) this.#purgeAccount(claim.id, claim.accountId);
      authorityLost = true;
    }
    settleLinearOutcome({ store: this.#store, claim, outcome, now: this.#now(), authorityLost });
    this.#testFailpoint?.('after-outcome', claim);
    const state = this.#store.database.prepare('SELECT state FROM deliveries WHERE id = ?').get(claim.id) as
      | { state: string }
      | undefined;
    return { state: state?.state === 'delivered' ? 'delivered' : 'issued', deliveryId: claim.id };
  }

  #fenceRequest(
    claim: Pick<
      ClaimedDelivery,
      'accountId' | 'ruleId' | 'ruleVersion' | 'targetId' | 'targetVersion' | 'switchGeneration'
    >,
    boundary: ActiveDisclosableRequest['boundary'] = 'dispatch',
  ): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: claim.accountId,
      boundary,
      ruleId: claim.ruleId,
      ruleVersion: claim.ruleVersion,
      targetId: claim.targetId,
      targetVersion: claim.targetVersion,
      switchGeneration: claim.switchGeneration,
    };
  }

  #release(claim: ClaimedDelivery): void {
    this.#store.immediate(() => releaseDeliveryClaimInTransaction(this.#store.database, claim));
  }

  #purgeAccount(deliveryId: string, accountId: string): void {
    this.#store.immediate(() =>
      purgeRemovedAccountWork(
        this.#store.database,
        { source: sourceOfDelivery(this.#store, deliveryId), accountId },
        this.#now(),
      ),
    );
  }

  /** Before any byte of the issue: the claimed record goes, terminal and content-free, never retried. */
  #cancelContentFree(claim: ClaimedDelivery): void {
    this.#store.immediate(() => {
      const cancelled = this.#store.database
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(claim.id, claim.switchGeneration, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
      if (cancelled === 1) dropRetainedTargetReference(this.#store.database, claim.id, this.#now());
    });
  }
}

/**
 * Settles one Linear try. The exact owner predicate is the first durable decision: a late answer cannot overwrite a
 * recovered lease, a purge or a winner. An issue is recorded only on the claim's own row, with its delivered state.
 */
export function settleLinearOutcome(input: {
  readonly store: EventDatabase;
  readonly claim: ClaimedDelivery;
  readonly outcome: LinearDeliveryOutcome;
  readonly now: number;
  readonly authorityLost?: boolean | undefined;
}): boolean {
  return input.store.immediate(() => {
    const database = input.store.database;
    const { claim } = input;
    const exact = `WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
                     AND attempt_id = ? AND lease_token = ? AND lease_until = ?`;
    const owner = [claim.id, claim.switchGeneration, claim.attemptId, claim.leaseToken, claim.leaseUntil] as const;
    const row = database
      .prepare(
        `SELECT rule_id, rule_version, attempts, expires_at, state, switch_generation, attempt_id, lease_token,
                lease_until, target_id, target_version
           FROM deliveries WHERE id = ?`,
      )
      .get(claim.id) as
      | {
          rule_id: string;
          rule_version: number;
          attempts: number;
          expires_at: number;
          state: string;
          switch_generation: number;
          attempt_id: string | null;
          lease_token: string | null;
          lease_until: number | null;
          target_id: string;
          target_version: number;
        }
      | undefined;
    if (
      row === undefined ||
      row.state !== 'disclosing' ||
      row.switch_generation !== claim.switchGeneration ||
      row.attempt_id !== claim.attemptId ||
      row.lease_token !== claim.leaseToken ||
      row.lease_until !== claim.leaseUntil
    ) {
      recordDiscardedOutcome(database, claim, input.now);
      return false;
    }
    const terminal = (state: string): boolean => {
      const changed = database
        .prepare(
          `UPDATE deliveries SET state = ?, encrypted_record = NULL, lease_until = NULL, next_at = NULL ${exact}`,
        )
        .run(state, ...owner).changes;
      if (changed === 1) dropRetainedTargetReference(database, claim.id, input.now);
      return changed === 1;
    };
    const setting = database
      .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; switch_generation: number } | undefined;
    const lineageLive =
      setting?.enabled === 1 &&
      setting.switch_generation === claim.switchGeneration &&
      hasLiveDeliveryLineage(database, row);
    // A created issue is recorded whenever the claim is still this try's: it exists in Linear either way.
    if (input.outcome.kind === 'created') {
      const { issue, status } = input.outcome;
      const delivered = database
        .prepare(
          `UPDATE deliveries
              SET state = 'delivered', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                  last_error_code = NULL, last_status = ?, linear_issue_id = ?, linear_identifier = ?, linear_url = ?
            ${exact}`,
        )
        .run(status, issue.id, issue.identifier, issue.url, ...owner).changes;
      if (delivered === 1) dropRetainedTargetReference(database, claim.id, input.now);
      return delivered === 1;
    }
    if (input.authorityLost) {
      terminal('cancelled');
      recordDiscardedOutcome(database, claim, input.now);
      return false;
    }
    if (row.expires_at <= input.now) {
      terminal('retention-expired');
      return false;
    }
    if (!lineageLive) {
      terminal(setting?.enabled === 1 ? 'cancelled' : 'in-flight-at-disable');
      return false;
    }
    const { code, status } = input.outcome;
    if (input.outcome.kind === 'failed' || row.attempts >= LINEAR_RETRY_LIMIT) {
      return (
        database
          .prepare(
            `UPDATE deliveries
                SET state = 'dead-lettered', lease_until = NULL, next_at = NULL, last_error_code = ?, last_status = ?,
                    dead_lettered_at = COALESCE(dead_lettered_at, ?),
                    dead_letter_expires_at = COALESCE(dead_letter_expires_at, ?)
              ${exact}`,
          )
          .run(
            code,
            status,
            input.now,
            input.now + deadLetterRetentionFor(database, row.rule_id, row.rule_version),
            ...owner,
          ).changes === 1
      );
    }
    const nextAt = input.now + retryBackoffMs(row.attempts, claim.id);
    if (nextAt >= row.expires_at) {
      const expired = database
        .prepare(
          `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                  last_error_code = ?, last_status = ?
            ${exact}`,
        )
        .run(code, status, ...owner).changes;
      if (expired === 1) dropRetainedTargetReference(database, claim.id, input.now);
      return expired === 1;
    }
    return (
      database
        .prepare(
          `UPDATE deliveries SET state = 'retryable', lease_until = NULL, next_at = ?, last_error_code = ?, last_status = ?
            ${exact}`,
        )
        .run(nextAt, code, status, ...owner).changes === 1
    );
  });
}

function recordDiscardedOutcome(database: EventDatabase['database'], claim: ClaimedDelivery, now: number): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO work_attempts (id, work_id, switch_generation, code, created_at)
       VALUES (?, ?, ?, 'external-outcome-unrecalled-discarded', ?)`,
    )
    .run(
      `linear-outcome:${sha256Hex(`${claim.id}:${claim.attemptId}:${claim.leaseToken}`)}`,
      claim.id,
      claim.switchGeneration,
      now,
    );
}

function dropRetainedTargetReference(database: EventDatabase['database'], deliveryId: string, now: number): void {
  for (const target of removeRetainedDeliveryTargetReference(database, deliveryId))
    purgeUnreferencedSystemTargets(database, { ...target, now });
}

function deadLetterRetentionFor(database: EventDatabase['database'], ruleId: string, ruleVersion: number): number {
  const row = database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as { document: string } | undefined;
  try {
    const value = (JSON.parse(row?.document ?? '{}') as { retention?: { deadLetterMs?: unknown } }).retention
      ?.deadLetterMs;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_DEAD_LETTER_RETENTION_MS;
  } catch {
    return DEFAULT_DEAD_LETTER_RETENTION_MS;
  }
}

/** The webhook's backoff: exponential to an hour, with a stable jitter from the delivery's own id. */
function retryBackoffMs(attempts: number, deliveryId: string): number {
  const exponential = Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_BACKOFF_MS);
  const jitterRange = Math.max(1, Math.floor(exponential / 4));
  const entropy = Number.parseInt(sha256Hex(`${deliveryId}:${attempts}`).slice(0, 8), 16);
  return Math.min(exponential + (entropy % jitterRange), MAX_RETRY_BACKOFF_MS);
}

function sourceOfDelivery(store: EventDatabase, deliveryId: string): 'gmail' | 'slack' | 'resend' | 'whatsapp' {
  const row = store.database
    .prepare(
      `SELECT rule.document FROM deliveries JOIN rule_versions AS rule
           ON rule.rule_id = deliveries.rule_id AND rule.version = deliveries.rule_version
        WHERE deliveries.id = ?`,
    )
    .get(deliveryId) as { document: string } | undefined;
  if (row === undefined) throw new CommsError('APPROVAL_VOID', 'the Linear delivery has no exact rule version');
  try {
    const source = (JSON.parse(row.document) as { source?: { channel?: unknown } }).source?.channel;
    if (source === 'gmail' || source === 'slack' || source === 'resend' || source === 'whatsapp') return source;
  } catch {
    // The closed refusal below is the safe result for a damaged immutable rule row.
  }
  throw new CommsError('APPROVAL_VOID', 'the Linear delivery rule has no recognised event source');
}

function delivery(store: EventDatabase, id: string): DeliveryRow | undefined {
  return store.database
    .prepare('SELECT id, account_id, expires_at, whatsapp_message_id FROM deliveries WHERE id = ?')
    .get(id) as DeliveryRow | undefined;
}

function deliveryLocation(id: string) {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function parseRecord(value: Buffer): LinearDeliveryRecord | LinearChangeDeliveryRecord {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<LinearDeliveryRecord>;
    if ((parsed as { kind?: unknown }).kind === 'linear-change') {
      const change = linearChangeRecord(parsed);
      if (change === null) throw new Error('invalid');
      return change;
    }
    if (parsed.kind !== 'linear-issue' || typeof parsed.title !== 'string' || typeof parsed.description !== 'string')
      throw new Error('invalid');
    return parsed as LinearDeliveryRecord;
  } catch {
    throw new CommsError('BAD_DATA', 'the retained Linear delivery record is invalid');
  }
}
