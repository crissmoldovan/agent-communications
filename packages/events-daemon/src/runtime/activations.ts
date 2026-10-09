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
  canonicalFullRuleDocument,
  disclosureBindingFor,
} from '../domain/activation-documents.ts';
import type { SourceOptions } from '../domain/source-options.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { SourceScope } from '../sources/contracts.ts';
import type { MailboxLock } from '../sources/mailbox-lock.ts';
import { gmailOnlySourceRegistry, type LocalEventSourceRegistry } from '../sources/registry.ts';
import type { EventDatabase } from '../store/database.ts';
import {
  assertLiveEventAccount,
  isRemovedAccountError,
  liveEventAccountIds,
  purgeRemovedAccountWork,
} from './account-fence.ts';
import { gmailBaseline, persistSourceBaseline } from './baseline.ts';
import type { CutoverFailpoint } from './cutover-failpoint.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import {
  applyDerivedTightening,
  assertReplacementDrained,
  settleOldOnlyStageDebts,
  type TighteningKind,
  tighteningKind,
} from './replacements.ts';
import type { DSourceRetentionTighteningDispatcher } from './retained-content-hooks.ts';
import { addActiveRuleTargetReferences, removeActiveRuleTargetReferences } from './target-version-references.ts';

type IntentKind = ActivationDocumentV1['kind'];

interface IntentRow {
  readonly id: string;
  readonly kind: IntentKind;
  readonly document: string;
  readonly digest: string;
  readonly effect: string;
  readonly status: 'pending' | 'pending-completion' | 'completed' | 'failed' | 'cancelled';
  readonly approval_id: string | null;
  readonly replacement_of_version: string | null;
  readonly claimed_at: number | null;
  readonly completion_deadline: number | null;
}

interface PlannedPoint {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly accountId: string;
  readonly source: SourceOptions['channel'];
  readonly positionScope: string;
}

interface PreparedPoint extends PlannedPoint {
  readonly encryptedPosition: Uint8Array;
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
  readonly replacementOfVersion?: string | undefined;
}

/** A syntactically verified narrowing has no disclosure approval to issue or claim. */
export interface DerivedTighteningCompletion {
  readonly intentId: string;
  readonly kind: 'rule';
  readonly status: 'completed';
  readonly derived: true;
  readonly editKind: TighteningKind;
}

export type PreparedRuleActivation = PreparedActivation | DerivedTighteningCompletion;

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
  /** The owner supplies one read-only baseline factory per registered source; Gmail remains the compatibility default. */
  readonly sourceBaselineFor?:
    | ((input: Readonly<{ source: SourceOptions['channel']; accountId: string; scopeId: string }>) => Promise<unknown>)
    | undefined;
  readonly encryptBaseline: (
    intentId: string,
    accountId: string,
    value: unknown,
    scope?: SourceScope,
  ) => Promise<Uint8Array>;
  /** Baseline and activation-point rows have distinct D8 AAD locations and cannot share ciphertext. */
  readonly decryptBaseline: (
    intentId: string,
    accountId: string,
    stored: Uint8Array,
    scope?: SourceScope,
  ) => Promise<unknown>;
  readonly encryptPoint: (
    input: PlannedPoint & { readonly activationId: string; readonly position: unknown },
  ) => Promise<Uint8Array>;
  readonly decryptPoint: (
    input: PlannedPoint & { readonly activationId: string; readonly stored: Uint8Array },
  ) => Promise<unknown>;
  readonly mailboxLock: MailboxLock;
  readonly sourceRegistry?: LocalEventSourceRegistry | undefined;
  /** D4a's B2-independent seam; Task 7 supplies the normal owner composition. */
  readonly retainedContentHooks?: DSourceRetentionTighteningDispatcher | undefined;
  readonly now?: (() => number) | undefined;
  readonly newIntentId?: (() => string) | undefined;
  /** Optional test seam; absent in production and therefore behaviour-free. */
  readonly failpoint?: CutoverFailpoint | undefined;
  /** Optional test clock seam immediately before each completion-deadline check. */
  readonly deadlineFailpoint?: ActivationDeadlineFailpoint | undefined;
}

export type ActivationDeadlineFailpoint = (
  edge: 'before-claim-deadline' | 'before-baseline-deadline' | 'before-finalise-deadline',
) => void;

/** D2/D12 recoverable standing-authority activation for Gmail first activations, exact replacements and enable-all. */
export class ActivationRuntime {
  readonly #store: EventDatabase;
  readonly #approvals: ActivationRuntimeOptions['approvals'];
  readonly #config: ActivationRuntimeOptions['config'];
  readonly #gmailSourceFor: ActivationRuntimeOptions['gmailSourceFor'];
  readonly #sourceBaselineFor: NonNullable<ActivationRuntimeOptions['sourceBaselineFor']>;
  readonly #encryptBaseline: ActivationRuntimeOptions['encryptBaseline'];
  readonly #decryptBaseline: ActivationRuntimeOptions['decryptBaseline'];
  readonly #encryptPoint: ActivationRuntimeOptions['encryptPoint'];
  readonly #decryptPoint: ActivationRuntimeOptions['decryptPoint'];
  readonly #mailboxLock: MailboxLock;
  readonly #sourceRegistry: LocalEventSourceRegistry;
  readonly #retainedContentHooks: DSourceRetentionTighteningDispatcher | undefined;
  readonly #now: () => number;
  readonly #newIntentId: () => string;
  readonly #failpoint: CutoverFailpoint | undefined;
  readonly #deadlineFailpoint: ActivationDeadlineFailpoint | undefined;

  constructor(options: ActivationRuntimeOptions) {
    this.#store = options.store;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#gmailSourceFor = options.gmailSourceFor;
    this.#sourceBaselineFor =
      options.sourceBaselineFor ??
      (async ({ source, accountId }) => {
        if (source !== 'gmail')
          throw new CommsError('SOURCE_UNAVAILABLE', 'the source has no activation baseline reader', {
            details: { reason: 'SOURCE_UNAVAILABLE', source },
          });
        return gmailBaseline(await this.#gmailSourceFor(accountId));
      });
    this.#encryptBaseline = options.encryptBaseline;
    this.#decryptBaseline = options.decryptBaseline;
    this.#encryptPoint = options.encryptPoint;
    this.#decryptPoint = options.decryptPoint;
    this.#mailboxLock = options.mailboxLock;
    this.#sourceRegistry = options.sourceRegistry ?? gmailOnlySourceRegistry();
    this.#retainedContentHooks = options.retainedContentHooks;
    this.#now = options.now ?? Date.now;
    this.#newIntentId = options.newIntentId ?? (() => `act_${randomBytes(16).toString('hex')}`);
    this.#failpoint = options.failpoint;
    this.#deadlineFailpoint = options.deadlineFailpoint;
  }

  async prepareRule(input: { readonly ruleId: string; readonly version: number }): Promise<PreparedRuleActivation> {
    // A tightening swaps the pointer at once and an exact replacement plans against it: neither may move a pointer a
    // claimed completion is still working against (it would wedge that completion and its drain for good).
    await this.assertNoCompletingMutation(input.ruleId);
    const versions = new ImmutableVersions(this.#store.database);
    const document = versions.prepareRule(input.ruleId, input.version);
    this.#sourceRegistry.require(document.rule.source.channel);
    const active = versions.activeVersion('rule', input.ruleId);
    if (active !== null) {
      const parentRow = this.#store.database
        .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
        .get(input.ruleId, active.version) as { document: string } | undefined;
      if (!parentRow) throw new CommsError('BAD_DATA', 'the active rule version is missing its immutable document');
      const parent = canonicalFullRuleDocument(JSON.parse(parentRow.document));
      if (tighteningKind(parent, document.rule) !== null) {
        const derived = await applyDerivedTightening({
          database: this.#store.database,
          parent,
          child: document.rule,
          now: this.#now(),
          retainedContentHooks: this.#retainedContentHooks,
          accountLive: async (accountId) => {
            try {
              await assertLiveEventAccount(this.#config, { source: parent.source.channel, accountId });
            } catch (error) {
              if (isRemovedAccountError(error))
                this.#store.immediate(() =>
                  purgeRemovedAccountWork(
                    this.#store.database,
                    { source: parent.source.channel, accountId },
                    this.#now(),
                  ),
                );
              throw error;
            }
          },
          decryptPoint: ({ activationId, ruleId, ruleVersion, accountId, positionScope, encryptedPosition }) =>
            this.#decryptPoint({
              activationId,
              ruleId,
              ruleVersion,
              accountId,
              positionScope,
              source: parent.source.channel,
              stored: encryptedPosition,
            }),
          encryptPoint: ({ activationId, ruleId, ruleVersion, accountId, positionScope, position }) =>
            this.#encryptPoint({
              activationId,
              ruleId,
              ruleVersion,
              accountId,
              positionScope,
              source: parent.source.channel,
              position,
            }),
        });
        return {
          intentId: derived.versionId,
          kind: 'rule',
          status: 'completed',
          derived: true,
          editKind: derived.editKind,
        };
      }
      const oldId = `${input.ruleId}@${active.version}`;
      const pending = this.#store.database
        .prepare(
          "SELECT 1 AS present FROM activation_intents WHERE replacement_of_version = ? AND status IN ('pending', 'pending-completion')",
        )
        .get(oldId) as { present: number } | undefined;
      if (pending !== undefined) {
        throw new CommsError('TRANSIENT', 'this rule already has a replacement completing', {
          details: { reason: 'REPLACEMENT_PENDING' },
        });
      }
      // K6: the old version owes a drain only where it still polls — an account it holds a cut-over point for, still in
      // the configuration. An account removed from it (and purged) is dark for it and owes nothing, so it neither
      // blocks this replacement nor gets a baseline; the new version's own accounts are always planned (a removed one
      // refuses at its baseline).
      const live = await liveEventAccountIds(this.#config, parent.source.channel);
      const points = this.#unionReplacementPoints(parent, document.rule).filter(
        (point) =>
          point.ruleVersion !== parent.version ||
          (live.has(point.accountId) &&
            this.#holdsActivePoint(parent.ruleId, parent.version, {
              source: point.source,
              accountId: point.accountId,
              scopeId: point.positionScope,
            })),
      );
      await this.#assertScopeConfigured(document.rule.source.channel, document.rule.source.accountIds);
      return this.#prepare(document, points, { switchGeneration: this.#switch().generation }, oldId);
    }
    await this.#assertScopeConfigured(document.rule.source.channel, document.rule.source.accountIds);
    const points = this.#pointsForRule(document.rule);
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
    // K6: fresh points for every account still in the configuration; a removed one stays dark (it cannot be sampled),
    // and one re-added since its removal gets a fresh cut-over here, under this approval.
    const liveBySource = new Map<SourceOptions['channel'], ReadonlySet<string>>();
    const points: PlannedPoint[] = [];
    for (const row of rows) {
      const planned = versions.prepareRule(row.object_id, row.version);
      this.#sourceRegistry.require(planned.rule.source.channel);
      const source = planned.rule.source.channel;
      const live = liveBySource.get(source) ?? (await liveEventAccountIds(this.#config, source));
      liveBySource.set(source, live);
      points.push(...this.#pointsForRule(planned.rule).filter((point) => live.has(point.accountId)));
    }
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

  /**
   * Every rule-pointer mutation joins claimed completion work first (D12). With a rule id it is refused only while a
   * completing activation binds that rule (its first activation or replacement) or while an enable-all completes,
   * which fences every rule pointer; without one, while anything completes. Only revoking actions cancel instead.
   */
  async assertNoCompletingMutation(ruleId?: string): Promise<void> {
    const rows = this.#store.database
      .prepare(
        "SELECT approval_id, kind, document FROM activation_intents WHERE status = 'pending-completion' AND approval_id IS NOT NULL",
      )
      .all() as Array<{ approval_id: string; kind: string; document: string }>;
    for (const row of rows) {
      if (ruleId !== undefined && row.kind !== 'enable-all') {
        const bound = (JSON.parse(row.document) as { rule?: { ruleId?: unknown } }).rule?.ruleId;
        if (bound !== ruleId) continue;
      }
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
        "SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE status IN ('pending', 'pending-completion')",
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
        const binding = this.#settleOnDrift(intent);
        if (binding === null) continue;
        const used = await this.#approvals.claimForDisclosure(intent.approval_id, binding);
        if (used.usedAt === undefined)
          throw new CommsError('BAD_DATA', 'the used disclosure approval has no usedAt value');
        await this.#claimAndComplete(intent, used.usedAt);
        continue;
      }
      if (record.record.state !== 'used' || record.record.usedAt === undefined) continue;
      const binding = this.#settleOnDrift(intent);
      if (binding === null) continue;
      if (canonicalJson(record.record.disclosure) !== canonicalJson(binding)) {
        this.#cancel(intent.id, 'APPROVAL_BINDING_DRIFT');
        continue;
      }
      try {
        await this.#claimAndComplete(intent, record.record.usedAt);
      } catch (error) {
        // Expiry is terminal settlement. A replacement drain is deliberately nonterminal: recovery runs before the
        // worker, so it must leave the claimed old pointer live for that worker rather than preventing startup.
        if (
          error instanceof CommsError &&
          (error.code === 'APPROVAL_VOID' || error.details?.reason === 'REPLACEMENT_DRAINING')
        )
          continue;
        throw error;
      }
    }
  }

  /**
   * A live owner retries only work that core has already marked used. Unlike startup recovery this never claims an
   * approved disclosure and it always carries the immutable usedAt back through the ordinary completion path.
   */
  async resumeClaimedCompletions(): Promise<void> {
    const rows = this.#store.database
      .prepare(
        "SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE status = 'pending-completion' ORDER BY id",
      )
      .all() as unknown as IntentRow[];
    for (const intent of rows) {
      if (!intent.approval_id) {
        this.#cancel(intent.id, 'APPROVAL_ABSENT');
        continue;
      }
      const record = await this.#approvals.get(intent.approval_id);
      if (record?.form !== 'v2' || record.record.kind !== 'disclosure' || record.record.state !== 'used') {
        this.#cancel(intent.id, 'APPROVAL_ABSENT');
        continue;
      }
      const binding = this.#settleOnDrift(intent);
      if (binding === null) continue;
      if (record.record.usedAt === undefined || canonicalJson(record.record.disclosure) !== canonicalJson(binding)) {
        this.#cancel(intent.id, 'APPROVAL_BINDING_DRIFT');
        continue;
      }
      try {
        await this.#claimAndComplete(intent, record.record.usedAt);
      } catch (error) {
        // One intent still draining, or settled as void, never holds back the others in this pass.
        if (
          error instanceof CommsError &&
          (error.code === 'APPROVAL_VOID' || error.details?.reason === 'REPLACEMENT_DRAINING')
        )
          continue;
        throw error;
      }
    }
  }

  /**
   * The live binding of a claimed intent, or null after settling it: a binding that no longer holds (its pointer or
   * plan moved) can never complete, so it is cancelled — baselines and drain rows with it — rather than thrown on
   * every tick and at every startup, where it would hold its drain's mailbox and keep the owner from starting.
   */
  #settleOnDrift(intent: IntentRow): DisclosureBinding | null {
    try {
      return this.#liveBinding(intent);
    } catch (error) {
      if (!(error instanceof CommsError) || error.code !== 'APPROVAL_VOID') throw error;
      this.#store.immediate(() => this.#cancel(intent.id, 'APPROVAL_BINDING_DRIFT'));
      return null;
    }
  }

  async #prepare(
    document: ActivationDocumentV1,
    points: readonly PlannedPoint[],
    effect: ActivationEffect,
    replacementOfVersion?: string,
  ): Promise<PreparedActivation> {
    const intentId = this.#newIntentId();
    const binding = disclosureBindingFor(intentId, document);
    const now = this.#now();
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO activation_intents
            (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          intentId,
          document.kind,
          canonicalJson(document),
          binding.digest,
          canonicalJson(effect),
          replacementOfVersion ?? null,
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
    return {
      intentId,
      approvalId: approval.approvalId,
      binding,
      kind: document.kind,
      status: 'pending',
      ...(replacementOfVersion === undefined ? {} : { replacementOfVersion }),
    };
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
    this.#deadlineFailpoint?.('before-claim-deadline');
    if ((current.completion_deadline ?? deadline) <= this.#now()) {
      this.#fail(intent.id, 'COMPLETION_TIMEOUT');
      return Promise.reject(new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed'));
    }
    const document = this.#document(current);
    const points = this.#points(current);
    const baselineScopes = new Map<string, SourceScope>();
    for (const point of points) {
      const scope: SourceScope = { source: point.source, accountId: point.accountId, scopeId: point.positionScope };
      baselineScopes.set(`${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`, scope);
    }
    for (const scope of baselineScopes.values()) {
      const committed = this.#store.database
        .prepare(
          'SELECT 1 AS present FROM activation_baselines WHERE intent_id = ? AND source = ? AND account_id = ? AND position_scope = ?',
        )
        .get(current.id, scope.source, scope.accountId, scope.scopeId) as { present: number } | undefined;
      if (committed !== undefined) continue;
      // A disabled switch is permitted only for this claimed, not-yet-effective activation. The account itself is
      // always re-read from core configuration immediately before the provider boundary.
      try {
        await assertDisclosable({
          database: this.#store.database,
          approvals: this.#approvals,
          config: this.#config,
          activationIntentId: current.id,
          accountId: scope.accountId,
          boundary: 'recovery',
        });
      } catch (error) {
        if (isRemovedAccountError(error)) {
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, scope, this.#now()));
          this.#cancel(current.id, 'ACCOUNT_REMOVED');
        }
        throw error;
      }
      try {
        this.#failpoint?.('before-stage');
        await persistSourceBaseline(
          this.#sourceRegistry.require(scope.source),
          this.#mailboxLock.sourceScopeLock,
          scope,
          () => this.#sourceBaselineFor(scope),
          async (position) => {
            // Encryption (in production EventRecordCipher) completes before this write transaction reserves its own nonce.
            const encrypted = await this.#encryptBaseline(current.id, scope.accountId, position, scope);
            // D9: the account is read again immediately before the baseline is written (a removal during the profile
            // call or the encryption throws the ACCOUNT_REMOVED refusal, which purges and cancels below).
            await assertLiveEventAccount(this.#config, scope);
            this.#store.immediate(() => {
              // The provider call and encryption awaited: a disable-all or revocation may have cancelled this intent
              // and purged its baselines meanwhile. Write only while it is still the claimed work it was, at the same
              // switch generation — never recreate a purged baseline or drain that nothing would ever clean up.
              const live = this.#store.database
                .prepare('SELECT status, effect, completion_deadline FROM activation_intents WHERE id = ?')
                .get(current.id) as { status: string; effect: string; completion_deadline: number | null } | undefined;
              const planned =
                live === undefined ? null : (JSON.parse(live.effect) as ActivationEffect).switchGeneration;
              if (live?.status !== 'pending-completion' || planned !== this.#switch().generation) return;
              // Past the completion deadline nothing more is written; finalisation then settles the timeout.
              if (live.completion_deadline !== null && live.completion_deadline <= this.#now()) return;
              this.#store.database
                .prepare(
                  `INSERT OR IGNORE INTO activation_baselines
                   (intent_id, source, account_id, position_scope, encrypted_position, response_at)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(current.id, scope.source, scope.accountId, scope.scopeId, encrypted, this.#now());
              if (current.replacement_of_version !== null) {
                const oldRule = current.replacement_of_version;
                const oldInScope = this.#replacementIncludesScope(oldRule, scope);
                const newInScope = points.some(
                  (point) =>
                    point.ruleVersion === (document.kind === 'rule' ? document.rule.version : -1) &&
                    point.source === scope.source &&
                    point.accountId === scope.accountId &&
                    point.positionScope === scope.scopeId,
                );
                // D4 step 2: with the global switch disabled no source work runs to drain the old version, and
                // `disable-all` already terminalised its old work — so every union scope is re-baselined to P and its
                // drain is recorded drained in this same transaction.
                const disabled = !this.#switch().enabled;
                // A new-only scope gets its own P activation point but owes no old-version occurrence, so it must not
                // leave an impossible drain open waiting for a worker that never ran the old rule there.
                if (oldInScope) {
                  this.#store.database
                    .prepare(
                      `INSERT OR IGNORE INTO replacement_drains
                       (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope, drained_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                      current.id,
                      scope.source,
                      scope.accountId,
                      scope.scopeId,
                      1,
                      newInScope ? 1 : 0,
                      disabled ? this.#now() : null,
                    );
                }
                if (disabled) {
                  this.#store.database
                    .prepare(
                      `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(source, account_id, cursor_scope)
                       DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
                    )
                    .run(
                      scope.source,
                      scope.accountId,
                      scope.scopeId,
                      scope.source === 'gmail' && typeof (position as { historyId?: unknown }).historyId === 'string'
                        ? (position as { historyId: string }).historyId
                        : canonicalJson(position),
                      this.#now(),
                    );
                }
              }
            });
          },
        );
        this.#failpoint?.('after-stage');
      } catch (error) {
        if (isRemovedAccountError(error)) {
          this.#store.immediate(() => {
            purgeRemovedAccountWork(this.#store.database, scope, this.#now());
            this.#cancel(current.id, 'ACCOUNT_REMOVED');
          });
        }
        throw error;
      }
    }
    // A baseline call that ended past the completion deadline wrote nothing; settle the timeout now rather than
    // leaving the intent waiting for a baseline that will never be written.
    const afterBaselines = this.#intent(current.id);
    this.#deadlineFailpoint?.('before-baseline-deadline');
    if (afterBaselines.completion_deadline !== null && afterBaselines.completion_deadline <= this.#now()) {
      this.#fail(current.id, 'COMPLETION_TIMEOUT');
      throw new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed');
    }
    this.#failpoint?.('before-move');
    const preparedPoints = await Promise.all(
      points
        .filter((point) => document.kind !== 'rule' || point.ruleVersion === document.rule.version)
        .map(async (point): Promise<PreparedPoint> => {
          const baseline = this.#store.database
            .prepare(
              'SELECT encrypted_position FROM activation_baselines WHERE intent_id = ? AND source = ? AND account_id = ? AND position_scope = ?',
            )
            .get(current.id, point.source, point.accountId, point.positionScope) as
            | { encrypted_position: Uint8Array }
            | undefined;
          if (!baseline) throw new CommsError('TRANSIENT', 'the activation is waiting for a Gmail baseline');
          const position = await this.#decryptBaseline(current.id, point.accountId, baseline.encrypted_position, {
            source: point.source,
            accountId: point.accountId,
            scopeId: point.positionScope,
          });
          // EventRecordCipher reserves its nonce in its own BEGIN IMMEDIATE transaction. Prepare each destination
          // record before the synchronous pointer transaction below; ciphertext remains bound to this exact point row.
          const encryptedPosition = await this.#encryptPoint({
            ...point,
            activationId: current.id,
            position,
          });
          return { ...point, encryptedPosition };
        }),
    );
    // D9: every account the points bind is read again immediately before the pointer transaction.
    for (const scope of new Map(
      preparedPoints.map((point) => [
        `${point.source}\u0000${point.accountId}`,
        { source: point.source, accountId: point.accountId },
      ]),
    ).values()) {
      try {
        await assertLiveEventAccount(this.#config, scope);
      } catch (error) {
        if (isRemovedAccountError(error)) {
          this.#store.immediate(() => {
            purgeRemovedAccountWork(this.#store.database, scope, this.#now());
            this.#cancel(current.id, 'ACCOUNT_REMOVED');
          });
        }
        throw error;
      }
    }
    this.#failpoint?.('before-finalise');
    this.#finalise(current, document, preparedPoints, usedAt);
    this.#failpoint?.('after-move');
    return { intentId: current.id, status: 'completed', usedAt };
  }

  #finalise(intent: IntentRow, document: ActivationDocumentV1, points: readonly PreparedPoint[], usedAt: string): void {
    // A settlement found here (a cancel, or a failure at the deadline) must commit, so it is recorded inside the
    // transaction and its refusal is thrown only after the commit: a throw inside would roll the settlement back.
    let settled: CommsError | undefined;
    this.#store.immediate(() => {
      const latest = this.#intent(intent.id);
      if (latest.status !== 'pending-completion')
        throw new CommsError('APPROVAL_VOID', 'the activation was cancelled before its pointer effect committed');
      // The deadline is the completion boundary: a completion that started in time but reached here after it (a
      // slow profile call or encryption) installs nothing.
      this.#deadlineFailpoint?.('before-finalise-deadline');
      if (latest.completion_deadline !== null && latest.completion_deadline <= this.#now()) {
        this.#failWithin(intent.id, 'COMPLETION_TIMEOUT');
        settled = new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed');
        return;
      }
      const effect = JSON.parse(latest.effect) as ActivationEffect;
      const settings = this.#switch();
      if (settings.generation !== effect.switchGeneration) {
        this.#cancel(intent.id, 'STALE_GENERATION');
        settled = new CommsError('APPROVAL_VOID', 'the global event switch changed before activation completed');
        return;
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
          settled = new CommsError(
            'APPROVAL_VOID',
            'an enabled rule pointer changed before global activation completed',
          );
          return;
        }
      }
      if (document.kind === 'rule') {
        const active = new ImmutableVersions(this.#store.database).activeVersion('rule', document.rule.ruleId);
        if (latest.replacement_of_version === null && active !== null)
          throw new CommsError('TRANSIENT', 'the active rule pointer changed during activation', {
            details: { reason: 'ACTIVATION_COMPLETING' },
          });
        if (
          latest.replacement_of_version !== null &&
          (active === null || `${document.rule.ruleId}@${active.version}` !== latest.replacement_of_version)
        ) {
          this.#cancel(intent.id, 'STALE_POINTER');
          settled = new CommsError('APPROVAL_VOID', 'the old rule pointer changed before replacement finalisation');
          return;
        }
      } else if (document.kind === 'enable-all') {
        if (settings.enabled)
          throw new CommsError('CONFIG', 'collection became enabled before this approval completed');
      } else {
        throw new CommsError('CONFIG', 'this activation kind is not enabled in B1');
      }
      if (latest.replacement_of_version !== null) assertReplacementDrained(this.#store.database, latest.id);

      for (const point of points) {
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
            point.encryptedPosition,
            this.#now(),
          );
      }
      if (document.kind === 'rule') {
        if (latest.replacement_of_version !== null) {
          const old = this.#store.database
            .prepare('SELECT rule_id, version FROM rule_versions WHERE id = ?')
            .get(latest.replacement_of_version) as { rule_id: string; version: number } | undefined;
          if (!old)
            throw new CommsError('APPROVAL_VOID', 'the replacement predecessor disappeared before finalisation');
          removeActiveRuleTargetReferences(this.#store.database, old.rule_id, old.version);
          this.#store.database
            .prepare(
              "UPDATE rule_versions SET state = 'superseded', superseded_at = ? WHERE id = ? AND state = 'active'",
            )
            .run(this.#now(), latest.replacement_of_version);
          this.#settleOldOnlyStages(latest.replacement_of_version, points);
        }
        this.#store.database
          .prepare(
            "UPDATE rule_versions SET state = 'active', approval_id = ?, authorization_activation_id = ?, activated_at = ? WHERE rule_id = ? AND version = ?",
          )
          .run(intent.approval_id, intent.id, Date.parse(usedAt), document.rule.ruleId, document.rule.version);
        if (latest.replacement_of_version === null) {
          this.#store.database
            .prepare(
              "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, ?, ?, ?)",
            )
            .run(document.rule.ruleId, document.rule.version, intent.id, Date.parse(usedAt));
        } else {
          this.#store.database
            .prepare(
              "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ?",
            )
            .run(document.rule.version, intent.id, Date.parse(usedAt), document.rule.ruleId);
        }
        addActiveRuleTargetReferences(this.#store.database, {
          ruleId: document.rule.ruleId,
          ruleVersion: document.rule.version,
          targets: document.rule.targets.map((target) => ({
            targetId: target.targetId,
            targetVersion: target.version,
          })),
          createdAt: this.#now(),
        });
      } else {
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
      }
      this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intent.id);
      this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intent.id);
      this.#store.database
        .prepare("UPDATE activation_intents SET status = 'completed', updated_at = ? WHERE id = ?")
        .run(this.#now(), intent.id);
    });
    if (settled !== undefined) throw settled;
  }

  /**
   * At a replacement's swap, an account only the old version named is polled by nothing of this rule any more: the
   * old version's debt on that account's raw pages (its withheld after-P work) is owed to nobody, so it is dropped, and
   * a page left owing nothing is deleted rather than kept for ever.
   */
  #settleOldOnlyStages(oldVersionId: string, newPoints: readonly PlannedPoint[]): void {
    const old = this.#store.database
      .prepare('SELECT rule_id, version, document FROM rule_versions WHERE id = ?')
      .get(oldVersionId) as { rule_id: string; version: number; document: string } | undefined;
    if (!old) return;
    settleOldOnlyStageDebts(this.#store.database, {
      ruleId: old.rule_id,
      oldVersion: old.version,
      newScopes: newPoints.map((point) => ({
        source: point.source,
        accountId: point.accountId,
        scopeId: point.positionScope,
      })),
    });
  }

  #intentForApproval(approvalId: string): IntentRow {
    const row = this.#store.database
      .prepare(
        'SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE approval_id = ?',
      )
      .get(approvalId) as IntentRow | undefined;
    if (!row) throw new CommsError('NOT_FOUND', 'no event activation has this disclosure approval');
    return row;
  }

  #intent(id: string): IntentRow {
    const row = this.#store.database
      .prepare(
        'SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE id = ?',
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
      const active = versions.activeVersion('rule', document.rule.ruleId);
      if (
        active !== null &&
        (intent.replacement_of_version === null ||
          `${document.rule.ruleId}@${active.version}` !== intent.replacement_of_version)
      )
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

  #replacementIncludesScope(versionId: string, scope: SourceScope): boolean {
    const row = this.#store.database
      .prepare('SELECT rule_id, version, document FROM rule_versions WHERE id = ?')
      .get(versionId) as { rule_id: string; version: number; document: string } | undefined;
    if (!row) throw new CommsError('BAD_DATA', 'the exact replacement predecessor no longer exists');
    // K6: named is not enough — a drain waits for the old version's worker, which runs only where it holds a point.
    return (
      canonicalFullRuleDocument(JSON.parse(row.document)).source.accountIds.includes(scope.accountId) &&
      this.#holdsActivePoint(row.rule_id, row.version, scope)
    );
  }

  /**
   * K6: nothing is planned for an account outside core's configuration. A version naming one is refused before any
   * approval exists, rather than approved, claimed and then cancelled at its baseline.
   */
  async #assertScopeConfigured(source: SourceOptions['channel'], accountIds: readonly string[]): Promise<void> {
    const live = await liveEventAccountIds(this.#config, source);
    const missing = accountIds.find((accountId) => !live.has(accountId));
    if (missing !== undefined) {
      throw new CommsError('NOT_FOUND', 'the rule names an account that is not connected for its source', {
        details: { reason: 'ACCOUNT_REMOVED', accountId: missing },
      });
    }
  }

  /** Whether a version is the active one and holds a cut-over point for an account at its current cut-over. */
  #holdsActivePoint(ruleId: string, version: number, scope: SourceScope): boolean {
    return (
      this.#store.database
        .prepare(
          `SELECT 1 AS present
           FROM active_versions JOIN rule_activation_points
             ON rule_activation_points.activation_id = active_versions.current_cutover_id
            AND rule_activation_points.rule_id = active_versions.object_id
            AND rule_activation_points.rule_version = active_versions.version
           WHERE active_versions.kind = 'rule' AND active_versions.object_id = ? AND active_versions.version = ?
             AND rule_activation_points.source = ?
             AND rule_activation_points.account_id = ? AND rule_activation_points.position_scope = ?`,
        )
        .get(ruleId, version, scope.source, scope.accountId, scope.scopeId) !== undefined
    );
  }

  #pointsForRule(rule: Extract<ActivationDocumentV1, { kind: 'rule' }>['rule']): readonly PlannedPoint[] {
    const source = this.#sourceRegistry.require(rule.source.channel);
    const options = source.canonicalise(rule.source.options);
    return rule.source.accountIds.flatMap((accountId) =>
      source.scopesFor({ accountId, options }).map((scope) => ({
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        accountId: scope.accountId,
        source: scope.source,
        positionScope: scope.scopeId,
      })),
    );
  }

  #unionReplacementPoints(
    oldRule: Extract<ActivationDocumentV1, { kind: 'rule' }>['rule'],
    newRule: Extract<ActivationDocumentV1, { kind: 'rule' }>['rule'],
  ): readonly PlannedPoint[] {
    const points = [...this.#pointsForRule(oldRule), ...this.#pointsForRule(newRule)];
    const seen = new Set<string>();
    return points.filter((point) => {
      const key = `${point.ruleId}@${point.ruleVersion}:${point.source}:${point.accountId}:${point.positionScope}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
    this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intentId);
  }

  #fail(intentId: string, code: string): void {
    this.#store.immediate(() => this.#failWithin(intentId, code));
  }

  /** The failure's writes, for a caller already inside a transaction. */
  #failWithin(intentId: string, code: string): void {
    this.#store.database
      .prepare("UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
      .run(code, this.#now(), intentId);
    this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
    this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intentId);
  }
}
