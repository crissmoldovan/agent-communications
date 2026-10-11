import { randomUUID } from 'node:crypto';
import { CommsError, type ConfigStore, canonicalJson } from '@agentcomms/core';
import { TEST_CLOUD_EVENT_BYTES } from '@agentcomms/events';
import { canonicalTarget, type TargetDocument } from '../domain/activation-documents.ts';
import type { EventDatabase } from '../store/database.ts';
import { liveEventAccountIds } from './account-fence.ts';
import type { B3ControlPorts } from './b3-control-ports.ts';
import {
  SYSTEM_RESET_ATTEMPT_LIMIT,
  SYSTEM_RESET_RETENTION_MS,
  systemResetControlData,
} from './system-reset-outbox.ts';
import {
  hasLiveSystemTargetReference,
  liveSystemTargetReferenceAccountBindings,
  purgeUnreferencedSystemTarget,
} from './target-version-references.ts';
import { withEventWriterLease } from './writer-quiescer.ts';

const TARGET_TEST_LIMIT = 10;
const TARGET_TEST_WINDOW_MS = 60 * 60 * 1_000;

export type ActiveTargetTestSelector = {
  readonly kind: 'active';
  readonly targetId: string;
  readonly targetVersion: number;
};

export type PendingTargetTestSelector = {
  readonly kind: 'pending-activation';
  readonly activationId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly approvalId: string;
  readonly digest: string;
  readonly challenge: string;
};

export type TargetTestSelector = ActiveTargetTestSelector | PendingTargetTestSelector;

interface LiveTarget {
  readonly target: TargetDocument;
  readonly switchGeneration: number;
}

function refuse(message: string): never {
  throw new CommsError('APPROVAL_VOID', message);
}

function exactTargetTestSelector(input: unknown): TargetTestSelector {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return refuse('a target test needs an exact selector and accepts no caller content');
  const record = input as Record<string, unknown>;
  const exact = (keys: readonly string[]): boolean =>
    Object.keys(record).every((key) => keys.includes(key)) &&
    typeof record.targetId === 'string' &&
    record.targetId.length > 0 &&
    Number.isSafeInteger(record.targetVersion) &&
    (record.targetVersion as number) > 0;
  if (record.kind === 'active' && exact(['kind', 'targetId', 'targetVersion']))
    return { kind: 'active', targetId: record.targetId as string, targetVersion: record.targetVersion as number };
  if (
    record.kind === 'pending-activation' &&
    exact([
      'kind',
      'activationId',
      'ruleId',
      'ruleVersion',
      'targetId',
      'targetVersion',
      'approvalId',
      'digest',
      'challenge',
    ]) &&
    typeof record.activationId === 'string' &&
    typeof record.ruleId === 'string' &&
    Number.isSafeInteger(record.ruleVersion) &&
    (record.ruleVersion as number) > 0 &&
    typeof record.approvalId === 'string' &&
    typeof record.digest === 'string' &&
    typeof record.challenge === 'string'
  )
    return {
      kind: 'pending-activation',
      activationId: record.activationId,
      ruleId: record.ruleId,
      ruleVersion: record.ruleVersion as number,
      targetId: record.targetId as string,
      targetVersion: record.targetVersion as number,
      approvalId: record.approvalId,
      digest: record.digest,
      challenge: record.challenge,
    };
  return refuse('a target test selector is malformed or contains caller content');
}

function terminalResetState(value: string): boolean {
  return ['dead-lettered', 'cancelled', 'retention-expired', 'content-unreadable'].includes(value);
}

/**
 * Only an injected, sealed transport may receive the test bytes. The caller never supplies a body, address or
 * endpoint; later owner composition supplies the one concrete target transport.
 */
export interface FixedSyntheticTargetTransport {
  send(input: { readonly target: TargetDocument; readonly bytes: string }): Promise<void>;
}

export interface PendingTargetVerifier {
  verify(input: PendingTargetTestSelector): Promise<{
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly targetId: string;
    readonly targetVersion: number;
  }>;
}

/**
 * Task 3 deliberately receives the owner-composed reset sealer rather than reaching into the record cipher itself.
 * That keeps the sole cipher writer inventory closed in Task 2; Task 5 supplies the adapter under the existing
 * owner-wide lease.
 */
export interface ResetRecordSealer {
  seal(input: { readonly id: string; readonly plaintext: Uint8Array }): Promise<Buffer>;
}

/**
 * The ordinary target-test preflight, plus the approval-flow-only pending selector. This component never constructs
 * a URL, recipient, request body, or provider client: it can emit only TEST_CLOUD_EVENT_BYTES through its injected
 * sealed transport.
 */
export class B3TargetTestControl {
  readonly #store: EventDatabase;
  readonly #ports: B3ControlPorts;
  readonly #transport: FixedSyntheticTargetTransport;
  readonly #pending: PendingTargetVerifier | undefined;
  readonly #now: () => number;

  constructor(options: {
    readonly store: EventDatabase;
    readonly ports: B3ControlPorts;
    readonly transport:
      | FixedSyntheticTargetTransport
      | ((input: { readonly target: TargetDocument; readonly bytes: string }) => Promise<void>);
    readonly pending?: PendingTargetVerifier | undefined;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = options.store;
    this.#ports = options.ports;
    this.#transport = typeof options.transport === 'function' ? { send: options.transport } : options.transport;
    this.#pending = options.pending;
    this.#now = options.now ?? Date.now;
  }

  async test(
    selector: unknown,
  ): Promise<{ readonly attempts: number; readonly targetId: string; readonly targetVersion: number }> {
    const exact = exactTargetTestSelector(selector);
    const authorised = await this.#authorise(exact);
    // Object readiness awaits storage. Re-read immutable authority after that await before any synthetic send.
    if (authorised.target.kind !== 'dry-run')
      await this.#ports.assertObjectSecretReady({
        owner: { kind: 'target', id: authorised.target.targetId, version: authorised.target.version },
      });
    const ready = await this.#authorise(exact);
    // B3_TARGET_TEST_TARGET_WIDE_CAP: versions share one target-id rolling window, charged before transport.
    const attemptAt = this.#now();
    const attempts = this.#chargeTargetTestAttempt(ready.target.targetId, attemptAt);
    // B3_TARGET_TEST_FIXED_SYNTHETIC: no caller-controlled content may reach the transport.
    await this.#transport.send({ target: ready.target, bytes: TEST_CLOUD_EVENT_BYTES });
    // The transport awaited: revocation, switch generation, readiness, or pending approval may have drifted.
    const settled = await this.#authorise(exact);
    if (settled.target.targetId !== ready.target.targetId || settled.target.version !== ready.target.version)
      return refuse('the target changed while its synthetic test was in flight');
    if (settled.target.kind !== 'dry-run')
      await this.#ports.assertObjectSecretReady({
        owner: { kind: 'target', id: settled.target.targetId, version: settled.target.version },
      });
    return { attempts, targetId: settled.target.targetId, targetVersion: settled.target.version };
  }

  /** Commits the target-wide rolling-hour charge before the synthetic transport can begin; failed sends are not refunded. */
  #chargeTargetTestAttempt(targetId: string, chargedAt: number): number {
    return this.#store.immediate(() => {
      const cutoff = chargedAt - TARGET_TEST_WINDOW_MS;
      const database = this.#store.database;
      database.prepare('DELETE FROM target_test_charges WHERE target_id = ? AND charged_at <= ?').run(targetId, cutoff);
      const recent = database
        .prepare('SELECT COUNT(*) AS count FROM target_test_charges WHERE target_id = ? AND charged_at > ?')
        .get(targetId, cutoff) as { count: number };
      if (recent.count >= TARGET_TEST_LIMIT)
        throw new CommsError('RATE_CAPPED', 'the target test limit is exhausted before transport');
      database
        .prepare('INSERT INTO target_test_charges (target_id, charged_at) VALUES (?, ?)')
        .run(targetId, chargedAt);
      return recent.count + 1;
    });
  }

  async #authorise(selector: TargetTestSelector): Promise<LiveTarget> {
    if (selector.kind === 'pending-activation') {
      if (this.#pending === undefined)
        return refuse('a pending target selector is available only from the approval flow');
      const bound = await this.#pending.verify(selector);
      if (
        bound.ruleId !== selector.ruleId ||
        bound.ruleVersion !== selector.ruleVersion ||
        bound.targetId !== selector.targetId ||
        bound.targetVersion !== selector.targetVersion
      )
        return refuse('the pending approval did not bind this exact target');
      return this.#liveTarget(selector.targetId, selector.targetVersion, 'pending');
    }
    return this.#liveTarget(selector.targetId, selector.targetVersion, 'active');
  }

  #liveTarget(targetId: string, targetVersion: number, selectorKind: 'active' | 'pending'): LiveTarget {
    const row = this.#store.database
      .prepare(
        `SELECT target.document, settings.enabled, settings.switch_generation
         FROM target_versions AS target
         JOIN event_settings AS settings ON settings.singleton = 1
         WHERE target.target_id = ? AND target.version = ?
           AND target.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM object_revocations AS revoked
             WHERE revoked.kind = 'target' AND revoked.object_id = target.target_id AND revoked.version = target.version
           )`,
      )
      .get(targetId, targetVersion) as { document: string; enabled: number; switch_generation: number } | undefined;
    if (row === undefined || row.enabled !== 1) return refuse('the exact target version is not live');
    if (selectorKind === 'active') {
      const active = this.#store.database
        .prepare(
          `SELECT 1 AS present
           FROM target_version_references AS reference
           JOIN rule_versions AS rule ON rule.rule_id = reference.rule_id AND rule.version = reference.rule_version
           WHERE reference.reference_kind = 'active-rule' AND reference.target_id = ? AND reference.target_version = ?
             AND rule.state = 'active' AND rule.revoked_at IS NULL
           LIMIT 1`,
        )
        .get(targetId, targetVersion);
      if (active === undefined) return refuse('the target has no active exact rule reference');
    }
    try {
      return { target: canonicalTarget(JSON.parse(row.document)), switchGeneration: row.switch_generation };
    } catch {
      return refuse('the target immutable document is invalid');
    }
  }
}

interface ResumeCandidate {
  readonly resetEpoch: number;
  readonly oldId: string;
  readonly switchGeneration: number;
  readonly target: TargetDocument;
}

/**
 * Reopens a degraded reset barrier by replacing its terminal system record atomically. It never rewrites attempts or
 * deadlines on old work: a resume gets a new outbox identity, twenty attempts, and a new 24-hour retention window.
 */
export class TargetResumeControl {
  readonly #store: EventDatabase;
  readonly #resetSealer: ResetRecordSealer;
  readonly #ports: B3ControlPorts;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: {
    readonly store: EventDatabase;
    readonly resetSealer:
      | ResetRecordSealer
      | ((input: { readonly id: string; readonly plaintext: Uint8Array }) => Promise<Buffer>);
    readonly ports: B3ControlPorts;
    readonly config: Pick<ConfigStore, 'load'>;
    readonly now?: (() => number) | undefined;
    readonly newId?: (() => string) | undefined;
  }) {
    this.#store = options.store;
    this.#resetSealer = typeof options.resetSealer === 'function' ? { seal: options.resetSealer } : options.resetSealer;
    this.#ports = options.ports;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? randomUUID;
  }

  async resume(input: {
    readonly targetId: string;
    readonly targetVersion: number;
  }): Promise<{ readonly id: string; readonly resetEpoch: number }> {
    return withEventWriterLease(this.#ports.quiescer, async () => {
      const before = this.#candidate(input);
      if (before.target.kind !== 'dry-run')
        await this.#ports.assertObjectSecretReady({
          owner: { kind: 'target', id: before.target.targetId, version: before.target.version },
        });
      const id = this.#newId();
      const encrypted = await this.#resetSealer.seal({
        id,
        plaintext: Buffer.from(
          canonicalJson(
            systemResetControlData({
              resetEpoch: before.resetEpoch,
              newInstallationId: this.#store.installationId,
              reasonCode: 'TARGET_RESUME',
            }),
          ),
        ),
      });
      // Read core only after sealing and before the commit. A rule reference does not authorise a reset replacement
      // after every source account it names has left core configuration.
      const liveAccounts = await this.#liveReferenceAccounts({ ...input, resetEpoch: before.resetEpoch });
      if (
        hasLiveSystemTargetReference(this.#store.database, {
          ...input,
          resetEpoch: before.resetEpoch,
          now: this.#now(),
        }) &&
        !this.#hasLiveReferenceAccount({ ...input, resetEpoch: before.resetEpoch, now: this.#now() }, liveAccounts)
      )
        return this.#accountRemoved();
      // Encryption awaited under the owner-wide writer lease; this immediate transaction repeats every mutable
      // barrier/reference/switch check before it touches the old terminal record.
      const result = this.#store.immediate(() => {
        const current = this.#candidate(input);
        if (current.resetEpoch !== before.resetEpoch || current.oldId !== before.oldId)
          return refuse('the degraded reset changed while its replacement was being encrypted');
        const now = this.#now();
        if (
          !hasLiveSystemTargetReference(this.#store.database, {
            resetEpoch: current.resetEpoch,
            targetId: input.targetId,
            targetVersion: input.targetVersion,
            now,
          })
        ) {
          purgeUnreferencedSystemTarget(this.#store.database, {
            resetEpoch: current.resetEpoch,
            targetId: input.targetId,
            targetVersion: input.targetVersion,
            now,
          });
          // Return a sentinel instead of throwing inside the transaction: the exact-reference purge is itself the
          // safety outcome and must commit before the human receives the refusal.
          return null;
        }
        if (!this.#hasLiveReferenceAccount({ ...input, resetEpoch: current.resetEpoch, now }, liveAccounts))
          return 'account-removed' as const;
        const detached = this.#store.database
          .prepare(
            `UPDATE reset_barriers SET system_outbox_id = NULL
             WHERE reset_epoch = ? AND target_id = ? AND target_version = ?
               AND state = 'degraded' AND system_outbox_id = ?`,
          )
          .run(current.resetEpoch, input.targetId, input.targetVersion, current.oldId).changes;
        if (detached !== 1) return refuse('the degraded reset barrier changed before replacement');
        const removed = this.#store.database
          .prepare(
            "DELETE FROM system_reset_outbox WHERE id = ? AND state IN ('dead-lettered', 'cancelled', 'retention-expired', 'content-unreadable')",
          )
          .run(current.oldId).changes;
        if (removed !== 1) return refuse('only terminal reset work can be resumed');
        this.#store.database
          .prepare(
            `INSERT INTO system_reset_outbox
              (id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit, next_at, expires_at,
               state, switch_generation, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(
            id,
            current.resetEpoch,
            input.targetId,
            input.targetVersion,
            encrypted,
            SYSTEM_RESET_ATTEMPT_LIMIT,
            now,
            now + SYSTEM_RESET_RETENTION_MS,
            current.switchGeneration,
            now,
          );
        const closed = this.#store.database
          .prepare(
            `UPDATE reset_barriers SET state = 'closed', degraded_at = NULL, system_outbox_id = ?
             WHERE reset_epoch = ? AND target_id = ? AND target_version = ? AND system_outbox_id IS NULL`,
          )
          .run(id, current.resetEpoch, input.targetId, input.targetVersion).changes;
        if (closed !== 1) throw new Error('the reset barrier disappeared while replacing its terminal work');
        return { id, resetEpoch: current.resetEpoch };
      });
      if (result === null) return refuse('the reset target lost its final exact-version reference');
      if (result === 'account-removed') return this.#accountRemoved();
      return result;
    });
  }

  #candidate(input: { readonly targetId: string; readonly targetVersion: number }): ResumeCandidate {
    const row = this.#store.database
      .prepare(
        `SELECT barrier.reset_epoch, barrier.state AS barrier_state, barrier.system_outbox_id,
                outbox.state AS outbox_state, outbox.switch_generation, target.document,
                settings.enabled, settings.switch_generation AS current_generation
         FROM reset_barriers AS barrier
         JOIN system_reset_outbox AS outbox ON outbox.id = barrier.system_outbox_id
         JOIN target_versions AS target ON target.target_id = barrier.target_id AND target.version = barrier.target_version
         JOIN event_settings AS settings ON settings.singleton = 1
         WHERE barrier.target_id = ? AND barrier.target_version = ?
           AND target.revoked_at IS NULL /* B3_TARGET_RESUME_UNREVOKED */
           AND NOT EXISTS (
             SELECT 1 FROM object_revocations AS revoked
             WHERE revoked.kind = 'target' AND revoked.object_id = target.target_id AND revoked.version = target.version
           )
         ORDER BY barrier.reset_epoch DESC LIMIT 1`,
      )
      .get(input.targetId, input.targetVersion) as
      | {
          reset_epoch: number;
          barrier_state: string;
          system_outbox_id: string;
          outbox_state: string;
          switch_generation: number;
          document: string;
          enabled: number;
          current_generation: number;
        }
      | undefined;
    if (
      row === undefined ||
      row.barrier_state !== 'degraded' ||
      !terminalResetState(row.outbox_state) ||
      row.enabled !== 1 ||
      row.switch_generation !== row.current_generation
    )
      return refuse('the exact target has no resumable degraded terminal reset');
    try {
      return {
        resetEpoch: row.reset_epoch,
        oldId: row.system_outbox_id,
        switchGeneration: row.switch_generation,
        target: canonicalTarget(JSON.parse(row.document)),
      };
    } catch {
      return refuse('the reset target immutable document is invalid');
    }
  }

  async #liveReferenceAccounts(input: {
    readonly targetId: string;
    readonly targetVersion: number;
    readonly resetEpoch: number;
  }): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const bindings = liveSystemTargetReferenceAccountBindings(this.#store.database, { ...input, now: this.#now() });
    const live = new Map<string, ReadonlySet<string>>();
    for (const source of new Set(bindings.map((binding) => binding.source)))
      live.set(source, await liveEventAccountIds(this.#config, source));
    return live;
  }

  #hasLiveReferenceAccount(
    input: {
      readonly targetId: string;
      readonly targetVersion: number;
      readonly resetEpoch: number;
      readonly now: number;
    },
    live: ReadonlyMap<string, ReadonlySet<string>>,
  ): boolean {
    return liveSystemTargetReferenceAccountBindings(this.#store.database, input).some((binding) =>
      live.get(binding.source)?.has(binding.accountId),
    );
  }

  #accountRemoved(): never {
    throw new CommsError('NOT_FOUND', 'the reset target has no source account still connected', {
      details: { reason: 'ACCOUNT_REMOVED' },
    });
  }
}
