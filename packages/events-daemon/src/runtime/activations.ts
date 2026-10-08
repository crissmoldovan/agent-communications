import { randomBytes } from 'node:crypto';
import {
  type ApprovalStore,
  CommsError,
  type ConfigStore,
  canonicalJson,
  type DisclosureBinding,
} from '@agentcomms/core';
import type { GmailEventSource } from '@agentcomms/gmail';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  disclosureBindingFor,
} from '../domain/activation-documents.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { EventDatabase } from '../store/database.ts';
import { purgeRemovedAccountWork } from './account-fence.ts';
import { gmailBaseline } from './baseline.ts';
import { assertDisclosable } from './disclosure-fence.ts';

type IntentKind = ActivationDocumentV1['kind'];

interface IntentRow {
  readonly id: string;
  readonly kind: IntentKind;
  readonly document: string;
  readonly digest: string;
  readonly effect: string;
  readonly status: 'pending' | 'pending-completion' | 'completed' | 'failed' | 'cancelled';
  readonly approval_id: string | null;
  readonly claimed_at: number | null;
  readonly completion_deadline: number | null;
}

interface PlannedPoint {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly accountId: string;
  readonly source: 'gmail';
  readonly positionScope: 'mailbox';
}

interface ActivationEffect {
  readonly switchGeneration: number;
  readonly currentCutovers?: readonly {
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly cutoverId: string | null;
  }[];
}

export interface PreparedActivation {
  readonly intentId: string;
  readonly approvalId: string;
  readonly binding: DisclosureBinding;
  readonly kind: IntentKind;
  readonly status: 'pending';
}

export interface ActivationCompletion {
  readonly intentId: string;
  readonly status: 'completed';
  readonly usedAt: string;
}

export interface ActivationRuntimeOptions {
  readonly store: EventDatabase;
  readonly approvals: Pick<
    ApprovalStore,
    'createDisclosure' | 'approveDisclosure' | 'claimForDisclosure' | 'get' | 'issueDisclosureChallenge' | 'list'
  >;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly gmailSourceFor: (accountId: string) => Promise<Pick<GmailEventSource, 'getProfile'>>;
  readonly encryptBaseline: (
    intentId: string,
    accountId: string,
    value: { readonly historyId: string },
  ) => Promise<Uint8Array>;
  readonly now?: (() => number) | undefined;
  readonly newIntentId?: (() => string) | undefined;
}

/** D2/D12 recoverable standing-authority activation, deliberately limited to B1 Gmail first activation and enable-all. */
export class ActivationRuntime {
  readonly #store: EventDatabase;
  readonly #approvals: ActivationRuntimeOptions['approvals'];
  readonly #config: ActivationRuntimeOptions['config'];
  readonly #gmailSourceFor: ActivationRuntimeOptions['gmailSourceFor'];
  readonly #encryptBaseline: ActivationRuntimeOptions['encryptBaseline'];
  readonly #now: () => number;
  readonly #newIntentId: () => string;

  constructor(options: ActivationRuntimeOptions) {
    this.#store = options.store;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#gmailSourceFor = options.gmailSourceFor;
    this.#encryptBaseline = options.encryptBaseline;
    this.#now = options.now ?? Date.now;
    this.#newIntentId = options.newIntentId ?? (() => `act_${randomBytes(16).toString('hex')}`);
  }

  async prepareRule(input: { readonly ruleId: string; readonly version: number }): Promise<PreparedActivation> {
    const versions = new ImmutableVersions(this.#store.database);
    const document = versions.prepareRule(input.ruleId, input.version);
    if (versions.activeVersion('rule', input.ruleId) !== null) {
      throw new CommsError('TRANSIENT', 'this rule already has an active version; replacement completion is pending', {
        details: { reason: 'REPLACEMENT_PENDING' },
      });
    }
    const points = pointsForRule(document.rule);
    return this.#prepare(document, points, { switchGeneration: this.#switch().generation });
  }

  async prepareEnableAll(): Promise<PreparedActivation> {
    const current = this.#switch();
    if (current.enabled) throw new CommsError('CONFIG', 'collection is already enabled');
    const rows = this.#store.database
      .prepare(
        "SELECT object_id, version, current_cutover_id FROM active_versions WHERE kind = 'rule' ORDER BY object_id, version",
      )
      .all() as Array<{ object_id: string; version: number; current_cutover_id: string | null }>;
    const document: Extract<ActivationDocumentV1, { kind: 'enable-all' }> = {
      documentVersion: 1,
      kind: 'enable-all',
      switchGeneration: current.generation,
      ruleVersions: rows.map((row) => ({ ruleId: row.object_id, ruleVersion: row.version })),
    };
    const versions = new ImmutableVersions(this.#store.database);
    const points = rows.flatMap((row) => {
      const planned = versions.prepareRule(row.object_id, row.version);
      return pointsForRule(planned.rule);
    });
    return this.#prepare(document, points, {
      switchGeneration: current.generation,
      currentCutovers: rows.map((row) => ({
        ruleId: row.object_id,
        ruleVersion: row.version,
        cutoverId: row.current_cutover_id,
      })),
    });
  }

  async approve(input: { readonly approvalId: string; readonly answer: string }): Promise<ActivationCompletion> {
    const intent = this.#intentForApproval(input.approvalId);
    const binding = this.#liveBinding(intent);
    await this.#approvals.approveDisclosure(input.approvalId, binding, input.answer, 'terminal');
    const used = await this.#approvals.claimForDisclosure(input.approvalId, binding);
    if (used.usedAt === undefined) throw new CommsError('BAD_DATA', 'the used disclosure approval has no usedAt value');
    return this.#claimAndComplete(intent, used.usedAt);
  }

  async issueChallenge(approvalId: string): Promise<string> {
    const intent = this.#intentForApproval(approvalId);
    this.#liveBinding(intent);
    return this.#approvals.issueDisclosureChallenge(approvalId);
  }

  /** Every pointer mutation joins claimed completion work before it makes a concurrent mutation. */
  async assertNoCompletingMutation(): Promise<void> {
    const rows = this.#store.database
      .prepare(
        "SELECT approval_id FROM activation_intents WHERE status = 'pending-completion' AND approval_id IS NOT NULL",
      )
      .all() as Array<{ approval_id: string }>;
    for (const row of rows) {
      const record = await this.#approvals.get(row.approval_id);
      if (record?.form === 'v2' && record.record.kind === 'disclosure' && record.record.state === 'used') {
        throw new CommsError('TRANSIENT', 'a claimed activation is completing; retry this mutation shortly', {
          details: { reason: 'ACTIVATION_COMPLETING' },
        });
      }
    }
  }

  /** A narrowing revocation is allowed to win over a claimed completion, but no other pointer mutation is. */
  async cancelForRevocation(input: { readonly ruleId?: string; readonly targetId?: string }): Promise<void> {
    const rows = this.#store.database
      .prepare(
        "SELECT id, document FROM activation_intents WHERE status IN ('pending', 'pending-completion') ORDER BY id",
      )
      .all() as Array<{ id: string; document: string }>;
    const cancelled: string[] = [];
    for (const row of rows) {
      if (!this.#isRevokedBinding(JSON.parse(row.document) as ActivationDocumentV1, input)) continue;
      cancelled.push(row.id);
    }
    if (cancelled.length === 0) return;
    this.#store.immediate(() => {
      for (const intentId of cancelled) this.#cancel(intentId, 'AUTHORIZATION_REVOKED');
    });
  }

  /** Startup path: a used core approval is never reclaimed; its original usedAt remains the deadline origin. */
  async recover(): Promise<void> {
    const rows = this.#store.database
      .prepare(
        "SELECT id, kind, document, digest, effect, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE status IN ('pending', 'pending-completion')",
      )
      .all() as unknown as IntentRow[];
    for (const storedIntent of rows) {
      let intent = storedIntent;
      if (!intent.approval_id) {
        const binding = this.#liveBinding(intent);
        const matches = (await this.#approvals.list()).filter(
          (candidate) =>
            candidate.form === 'v2' &&
            candidate.record.kind === 'disclosure' &&
            canonicalJson(candidate.record.disclosure) === canonicalJson(binding),
        );
        if (matches.length !== 1) {
          this.#cancel(intent.id, 'APPROVAL_ABSENT');
          continue;
        }
        const candidate = matches[0] as Extract<(typeof matches)[number], { form: 'v2' }>;
        this.#store.immediate(() => {
          this.#store.database
            .prepare(
              'UPDATE activation_intents SET approval_id = ?, updated_at = ? WHERE id = ? AND approval_id IS NULL',
            )
            .run(candidate.record.approvalId, this.#now(), intent.id);
        });
        intent = { ...intent, approval_id: candidate.record.approvalId };
      }
      if (!intent.approval_id) continue;
      const record = await this.#approvals.get(intent.approval_id);
      if (record?.form !== 'v2' || record.record.kind !== 'disclosure') {
        this.#cancel(intent.id, 'APPROVAL_ABSENT');
        continue;
      }
      if (record.record.state === 'approved') {
        const binding = this.#liveBinding(intent);
        const used = await this.#approvals.claimForDisclosure(intent.approval_id, binding);
        if (used.usedAt === undefined)
          throw new CommsError('BAD_DATA', 'the used disclosure approval has no usedAt value');
        await this.#claimAndComplete(intent, used.usedAt);
        continue;
      }
      if (record.record.state !== 'used' || record.record.usedAt === undefined) continue;
      const binding = this.#liveBinding(intent);
      if (canonicalJson(record.record.disclosure) !== canonicalJson(binding)) {
        this.#cancel(intent.id, 'APPROVAL_BINDING_DRIFT');
        continue;
      }
      try {
        await this.#claimAndComplete(intent, record.record.usedAt);
      } catch (error) {
        // Expiry is terminal settlement, not a retryable recovery failure. The intent now carries its content-free code.
        if (!(error instanceof CommsError) || error.code !== 'APPROVAL_VOID') throw error;
      }
    }
  }

  async #prepare(
    document: ActivationDocumentV1,
    points: readonly PlannedPoint[],
    effect: ActivationEffect,
  ): Promise<PreparedActivation> {
    const intentId = this.#newIntentId();
    const binding = disclosureBindingFor(intentId, document);
    const now = this.#now();
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO activation_intents
            (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          intentId,
          document.kind,
          canonicalJson(document),
          binding.digest,
          canonicalJson(effect),
          canonicalJson(points),
          canonicalJson([...new Set(points.map((point) => `${point.accountId}:${point.positionScope}`))]),
          now,
          now,
        );
    });
    const approval = await this.#approvals.createDisclosure(binding);
    this.#store.immediate(() => {
      this.#store.database
        .prepare('UPDATE activation_intents SET approval_id = ?, updated_at = ? WHERE id = ? AND approval_id IS NULL')
        .run(approval.approvalId, this.#now(), intentId);
    });
    return { intentId, approvalId: approval.approvalId, binding, kind: document.kind, status: 'pending' };
  }

  async #claimAndComplete(intent: IntentRow, usedAt: string): Promise<ActivationCompletion> {
    const claimedAt = Date.parse(usedAt);
    if (!Number.isFinite(claimedAt)) throw new CommsError('BAD_DATA', 'the disclosure usedAt is not an instant');
    const deadline = claimedAt + 3_600_000;
    this.#store.immediate(() => {
      const row = this.#intent(intent.id);
      if (row.status === 'cancelled')
        throw new CommsError('APPROVAL_VOID', 'the activation was cancelled before completion');
      if (row.claimed_at === null) {
        this.#store.database
          .prepare(
            "UPDATE activation_intents SET status = 'pending-completion', claimed_at = ?, completion_deadline = ?, updated_at = ? WHERE id = ?",
          )
          .run(claimedAt, deadline, this.#now(), intent.id);
      }
    });
    const current = this.#intent(intent.id);
    if ((current.completion_deadline ?? deadline) <= this.#now()) {
      this.#fail(intent.id, 'COMPLETION_TIMEOUT');
      return Promise.reject(new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed'));
    }
    const document = this.#document(current);
    const points = this.#points(current);
    for (const accountId of [...new Set(points.map((point) => point.accountId))]) {
      const committed = this.#store.database
        .prepare(
          "SELECT 1 AS present FROM activation_baselines WHERE intent_id = ? AND source = 'gmail' AND account_id = ? AND position_scope = 'mailbox'",
        )
        .get(current.id, accountId) as { present: number } | undefined;
      if (committed !== undefined) continue;
      // A disabled switch is permitted only for this claimed, not-yet-effective activation. The account itself is
      // always re-read from core configuration immediately before the provider boundary.
      try {
        await assertDisclosable({
          database: this.#store.database,
          approvals: this.#approvals,
          config: this.#config,
          activationIntentId: current.id,
          accountId,
          boundary: 'recovery',
        });
      } catch (error) {
        if (error instanceof CommsError && error.code === 'NOT_FOUND') {
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, accountId, this.#now()));
          this.#cancel(current.id, 'ACCOUNT_REMOVED');
        }
        throw error;
      }
      const source = await this.#gmailSourceFor(accountId);
      const position = await gmailBaseline(source);
      // Encryption (in production EventRecordCipher) completes before this write transaction reserves its own nonce.
      const encrypted = await this.#encryptBaseline(current.id, accountId, position);
      this.#store.immediate(() => {
        this.#store.database
          .prepare(
            `INSERT OR IGNORE INTO activation_baselines
             (intent_id, source, account_id, position_scope, encrypted_position, response_at)
             VALUES (?, 'gmail', ?, 'mailbox', ?, ?)`,
          )
          .run(current.id, accountId, encrypted, this.#now());
      });
    }
    this.#finalise(current, document, points, usedAt);
    return { intentId: current.id, status: 'completed', usedAt };
  }

  #finalise(intent: IntentRow, document: ActivationDocumentV1, points: readonly PlannedPoint[], usedAt: string): void {
    this.#store.immediate(() => {
      const latest = this.#intent(intent.id);
      if (latest.status !== 'pending-completion')
        throw new CommsError('APPROVAL_VOID', 'the activation was cancelled before its pointer effect committed');
      const effect = JSON.parse(latest.effect) as ActivationEffect;
      const settings = this.#switch();
      if (settings.generation !== effect.switchGeneration) {
        this.#cancel(intent.id, 'STALE_GENERATION');
        throw new CommsError('APPROVAL_VOID', 'the global event switch changed before activation completed');
      }
      if (effect.currentCutovers !== undefined) {
        const currentCutovers = this.#store.database
          .prepare(
            "SELECT object_id, version, current_cutover_id FROM active_versions WHERE kind = 'rule' ORDER BY object_id, version",
          )
          .all()
          .map((row) => {
            const value = row as { object_id: string; version: number; current_cutover_id: string | null };
            return { ruleId: value.object_id, ruleVersion: value.version, cutoverId: value.current_cutover_id };
          });
        if (canonicalJson(currentCutovers) !== canonicalJson(effect.currentCutovers)) {
          this.#cancel(intent.id, 'STALE_POINTER');
          throw new CommsError('APPROVAL_VOID', 'an enabled rule pointer changed before global activation completed');
        }
      }
      for (const point of points) {
        const baseline = this.#store.database
          .prepare(
            'SELECT encrypted_position FROM activation_baselines WHERE intent_id = ? AND source = ? AND account_id = ? AND position_scope = ?',
          )
          .get(intent.id, point.source, point.accountId, point.positionScope) as
          | { encrypted_position: Uint8Array }
          | undefined;
        if (!baseline) throw new CommsError('TRANSIENT', 'the activation is waiting for a Gmail baseline');
        this.#store.database
          .prepare(
            `INSERT INTO rule_activation_points
             (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            intent.id,
            point.ruleId,
            point.ruleVersion,
            point.source,
            point.accountId,
            point.positionScope,
            baseline.encrypted_position,
            this.#now(),
          );
      }
      if (document.kind === 'rule') {
        const active = new ImmutableVersions(this.#store.database).activeVersion('rule', document.rule.ruleId);
        if (active !== null)
          throw new CommsError('TRANSIENT', 'the active rule pointer changed during activation', {
            details: { reason: 'ACTIVATION_COMPLETING' },
          });
        this.#store.database
          .prepare(
            "UPDATE rule_versions SET state = 'active', approval_id = ?, authorization_activation_id = ?, activated_at = ? WHERE rule_id = ? AND version = ?",
          )
          .run(intent.approval_id, intent.id, Date.parse(usedAt), document.rule.ruleId, document.rule.version);
        this.#store.database
          .prepare(
            "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, ?, ?, ?)",
          )
          .run(document.rule.ruleId, document.rule.version, intent.id, Date.parse(usedAt));
      } else if (document.kind === 'enable-all') {
        if (settings.enabled)
          throw new CommsError('CONFIG', 'collection became enabled before this approval completed');
        for (const entry of document.ruleVersions) {
          this.#store.database
            .prepare(
              "UPDATE active_versions SET current_cutover_id = ? WHERE kind = 'rule' AND object_id = ? AND version = ?",
            )
            .run(intent.id, entry.ruleId, entry.ruleVersion);
        }
        this.#store.database
          .prepare('UPDATE event_settings SET enabled = 1, activation_id = ?, changed_at = ? WHERE singleton = 1')
          .run(intent.id, this.#now());
      } else {
        throw new CommsError('CONFIG', 'this activation kind is not enabled in B1');
      }
      this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intent.id);
      this.#store.database
        .prepare("UPDATE activation_intents SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(this.#now(), intent.id);
    });
  }

  #intentForApproval(approvalId: string): IntentRow {
    const row = this.#store.database
      .prepare(
        'SELECT id, kind, document, digest, effect, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE approval_id = ?',
      )
      .get(approvalId) as IntentRow | undefined;
    if (!row) throw new CommsError('NOT_FOUND', 'no event activation has this disclosure approval');
    return row;
  }

  #intent(id: string): IntentRow {
    const row = this.#store.database
      .prepare(
        'SELECT id, kind, document, digest, effect, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE id = ?',
      )
      .get(id) as IntentRow | undefined;
    if (!row) throw new CommsError('NOT_FOUND', 'the activation intent no longer exists');
    return row;
  }

  #liveBinding(intent: IntentRow): DisclosureBinding {
    const document = this.#document(intent);
    const binding = disclosureBindingFor(intent.id, document);
    if (binding.digest !== intent.digest || activationDocumentDigest(document) !== intent.digest) {
      throw new CommsError('APPROVAL_VOID', 'the activation document changed after preparation');
    }
    if (document.kind === 'rule') {
      const versions = new ImmutableVersions(this.#store.database);
      if (versions.activeVersion('rule', document.rule.ruleId) !== null)
        throw new CommsError('APPROVAL_VOID', 'the rule gained an active pointer after preparation');
      const live = versions.prepareRule(document.rule.ruleId, document.rule.version);
      if (canonicalJson(live) !== canonicalJson(document))
        throw new CommsError('APPROVAL_VOID', 'the rule changed after preparation');
    } else if (document.kind === 'enable-all') {
      const current = this.#switch();
      const live = this.#store.database
        .prepare(
          "SELECT object_id, version, current_cutover_id FROM active_versions WHERE kind = 'rule' ORDER BY object_id, version",
        )
        .all() as Array<{ object_id: string; version: number; current_cutover_id: string | null }>;
      const effect = JSON.parse(intent.effect) as ActivationEffect;
      if (
        current.enabled ||
        current.generation !== document.switchGeneration ||
        canonicalJson(live.map((row) => ({ ruleId: row.object_id, ruleVersion: row.version }))) !==
          canonicalJson(document.ruleVersions) ||
        canonicalJson(
          live.map((row) => ({ ruleId: row.object_id, ruleVersion: row.version, cutoverId: row.current_cutover_id })),
        ) !== canonicalJson(effect.currentCutovers ?? [])
      ) {
        throw new CommsError('APPROVAL_VOID', 'the global enablement plan changed after preparation');
      }
    }
    return binding;
  }

  #document(intent: IntentRow): ActivationDocumentV1 {
    return JSON.parse(intent.document) as ActivationDocumentV1;
  }

  #points(intent: IntentRow): readonly PlannedPoint[] {
    const row = this.#store.database
      .prepare('SELECT required_points FROM activation_intents WHERE id = ?')
      .get(intent.id) as { required_points: string } | undefined;
    return row ? (JSON.parse(row.required_points) as PlannedPoint[]) : [];
  }

  #isRevokedBinding(
    document: ActivationDocumentV1,
    input: { readonly ruleId?: string; readonly targetId?: string },
  ): boolean {
    if (document.kind === 'rule') {
      return (
        document.rule.ruleId === input.ruleId ||
        (input.targetId !== undefined && document.rule.targets.some((target) => target.targetId === input.targetId))
      );
    }
    if (document.kind !== 'enable-all') return false;
    if (input.ruleId !== undefined) return document.ruleVersions.some((entry) => entry.ruleId === input.ruleId);
    if (input.targetId === undefined) return false;
    for (const entry of document.ruleVersions) {
      const row = this.#store.database
        .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
        .get(entry.ruleId, entry.ruleVersion) as { document: string } | undefined;
      if (!row) continue;
      const rule = JSON.parse(row.document) as { targets?: Array<{ targetId?: unknown }> };
      if (rule.targets?.some((target) => target.targetId === input.targetId)) return true;
    }
    return false;
  }

  #switch(): { enabled: boolean; generation: number } {
    const row = this.#store.database
      .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; switch_generation: number } | undefined;
    if (!row) throw new CommsError('CONFIG', 'the local event settings are missing');
    return { enabled: row.enabled === 1, generation: row.switch_generation };
  }

  #cancel(intentId: string, code: string): void {
    this.#store.database
      .prepare("UPDATE activation_intents SET status = 'cancelled', failure_code = ?, updated_at = ? WHERE id = ?")
      .run(code, this.#now(), intentId);
    this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
  }

  #fail(intentId: string, code: string): void {
    this.#store.immediate(() => {
      this.#store.database
        .prepare("UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
        .run(code, this.#now(), intentId);
      this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
    });
  }
}

function pointsForRule(rule: Extract<ActivationDocumentV1, { kind: 'rule' }>['rule']): readonly PlannedPoint[] {
  return rule.source.accountIds.map((accountId) => ({
    ruleId: rule.ruleId,
    ruleVersion: rule.version,
    accountId,
    source: 'gmail',
    positionScope: 'mailbox',
  }));
}
