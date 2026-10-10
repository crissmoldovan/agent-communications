import { randomBytes } from 'node:crypto';
import {
  type ApprovalStore,
  CommsError,
  type ConfigStore,
  canonicalJson,
  type DisclosureBinding,
  hashChallenge,
} from '@agentcomms/core';
import type { GmailEventSource } from '@agentcomms/gmail';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  canonicalFullRuleDocument,
  disclosureBindingFor,
} from '../domain/activation-documents.ts';
import { ACTIVATION_FAILURE, type ActivationFailureCode } from '../domain/activation-failure-codes.ts';
import { assertJudgeKindEnabled } from '../domain/lifecycle.ts';
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
import type { AsyncSourceStageExpiry } from './expiry.ts';
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

interface ApprovalViewChallengeRow {
  readonly state: string;
  readonly origin: string;
  readonly challenge_hash: string | null;
  readonly expires_at: number | null;
}

interface RecoveryApprovalChallenge {
  readonly challenge: ApprovalChallenge | undefined;
  /** A previous un-serialised issuer overwrote an app answer after core accepted it; it is not an answerable row. */
  readonly issuingResidue: boolean;
}

interface ApprovalChallenge {
  readonly origin: 'view' | 'terminal';
  readonly expiresAt?: number | undefined;
  readonly challengeHash: string;
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
  /** D4a: source-specific expiry prepares the content-free terminalisation before the derived pointer write. */
  readonly sourceStageExpiry?: AsyncSourceStageExpiry | undefined;
  readonly now?: (() => number) | undefined;
  readonly newIntentId?: (() => string) | undefined;
  /** Optional test seam; absent in production and therefore behaviour-free. */
  readonly failpoint?: CutoverFailpoint | undefined;
  /** Optional test clock seam immediately before each completion-deadline check. */
  readonly deadlineFailpoint?: ActivationDeadlineFailpoint | undefined;
  /** B3's exact immutable secret-slot fence, supplied only by the owner composition. */
  readonly assertObjectSecretReady?:
    | ((input: {
        readonly owner: {
          readonly kind: 'target' | 'subscriber' | 'judge';
          readonly id: string;
          readonly version: number;
        };
      }) => Promise<unknown>)
    | undefined;
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
  readonly #sourceStageExpiry: AsyncSourceStageExpiry | undefined;
  readonly #now: () => number;
  readonly #newIntentId: () => string;
  readonly #failpoint: CutoverFailpoint | undefined;
  readonly #deadlineFailpoint: ActivationDeadlineFailpoint | undefined;
  readonly #assertObjectSecretReady: ActivationRuntimeOptions['assertObjectSecretReady'];
  /** One owner process writes this state directory, so this in-memory queue is enough to serialise one approval. */
  readonly #approvalOperations = new Map<string, Promise<void>>();
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
    this.#sourceStageExpiry = options.sourceStageExpiry;
    this.#now = options.now ?? Date.now;
    this.#newIntentId = options.newIntentId ?? (() => `act_${randomBytes(16).toString('hex')}`);
    this.#failpoint = options.failpoint;
    this.#deadlineFailpoint = options.deadlineFailpoint;
    this.#assertObjectSecretReady = options.assertObjectSecretReady;
  }

  async prepareRule(input: { readonly ruleId: string; readonly version: number }): Promise<PreparedRuleActivation> {
    // A tightening swaps the pointer at once and an exact replacement plans against it: neither may move a pointer a
    // claimed completion is still working against (it would wedge that completion and its drain for good).
    await this.assertNoCompletingMutation(input.ruleId);
    const versions = new ImmutableVersions(this.#store.database);
    const document = versions.prepareRule(input.ruleId, input.version);
    await this.#assertDocumentSecretsReady(document.rule);
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
          prepareSourceStageRetentionTightening: this.#sourceStageExpiry?.prepareRetentionTightening?.bind(
            this.#sourceStageExpiry,
          ),
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
      await this.#assertDocumentSecretsReady(planned.rule);
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

  async approve(input: {
    readonly approvalId: string;
    readonly answer: string;
    /** The authenticated owner picks this recording channel from its control connection's client name. */
    readonly via?: 'terminal' | 'app' | undefined;
  }): Promise<ActivationCompletion> {
    return this.#withApprovalOperation(input.approvalId, () => this.#approve(input));
  }

  async #approve(input: {
    readonly approvalId: string;
    readonly answer: string;
    readonly via?: 'terminal' | 'app' | undefined;
  }): Promise<ActivationCompletion> {
    const via = input.via ?? 'terminal';
    this.#assertApprovalChannel(this.#assertApprovalViewChallengeCurrent(input.approvalId, input.answer), via);
    const intent = this.#intentForApproval(input.approvalId);
    const binding = this.#liveBinding(intent);
    await this.#approvals.approveDisclosure(input.approvalId, binding, input.answer, via);
    // Approving persisted an await boundary: bind the exact current plan again before this process can spend it, so a
    // judge kind disabled meanwhile, like any other changed pointer, cannot spend this disclosure approval.
    const finalIntent = this.#intentForApproval(input.approvalId);
    const finalBinding = this.#liveBinding(finalIntent);
    // This is the final event-store fence before the core claim. It re-reads the durable, challenge-bound deadline
    // after the approval store await, so an owner restart or a slow terminal answer cannot spend an expired view.
    const challenge = this.#assertApprovalChannel(
      this.#assertApprovalViewChallengeCurrent(input.approvalId, input.answer),
      via,
    );
    const used = await this.#approvals.claimForDisclosure(
      input.approvalId,
      finalBinding,
      this.#claimOptions(challenge),
    );
    if (used.usedAt === undefined) throw new CommsError('BAD_DATA', 'the used disclosure approval has no usedAt value');
    return this.#claimAndComplete(finalIntent, used.usedAt);
  }

  /** Issues the terminal's ordinary disclosure challenge, explicitly superseding any previously viewed short challenge. */
  async issueChallenge(approvalId: string): Promise<string> {
    return this.#withApprovalOperation(approvalId, () => this.#issueChallenge(approvalId));
  }

  async #issueChallenge(approvalId: string): Promise<string> {
    const intent = this.#intentForApproval(approvalId);
    this.#liveBinding(intent);
    this.#beginApprovalChallenge(approvalId, 'terminal');
    try {
      const challenge = await this.#approvals.issueDisclosureChallenge(approvalId);
      this.#activateApprovalChallenge(approvalId, 'terminal', hashChallenge(challenge));
      return challenge;
    } catch (error) {
      this.#settleFailedApprovalChallengeIssuance(approvalId, 'terminal');
      throw error;
    }
  }

  /**
   * Issues the challenge returned from B3 `approval view`. The database sentinel is intentionally written before the
   * core challenge: if either half of that cross-store operation is interrupted, neither approval nor recovery can
   * mistake the unresolved challenge for an unrestricted terminal one.
   */
  async issueApprovalViewChallenge(approvalId: string, expiresAt: number): Promise<string | null> {
    return this.#withApprovalOperation(approvalId, () => this.#issueApprovalViewChallenge(approvalId, expiresAt));
  }

  async #issueApprovalViewChallenge(approvalId: string, expiresAt: number): Promise<string | null> {
    const intent = this.#intentForApproval(approvalId);
    this.#liveBinding(intent);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#now())
      throw new CommsError('CONFIG', 'an approval-view challenge needs a future, readable deadline');
    const existing = this.#approvalViewChallenge(approvalId);
    if (existing !== undefined) {
      if (existing.state === 'issuing') return null;
      const current = this.#readApprovalChallenge(existing);
      if (
        existing.state === 'active' &&
        current.origin === 'view' &&
        current.expiresAt !== undefined &&
        current.expiresAt <= this.#now()
      ) {
        this.#expireApprovalViewChallenge(approvalId);
        return null;
      }
      if (existing.state !== 'active' && existing.state !== 'expired') throw this.#challengeExpired();
    }
    this.#beginApprovalChallenge(approvalId, 'view');
    try {
      const challenge = await this.#approvals.issueDisclosureChallenge(approvalId);
      this.#activateApprovalChallenge(approvalId, 'view', hashChallenge(challenge), expiresAt);
      return challenge;
    } catch (error) {
      this.#settleFailedApprovalChallengeIssuance(approvalId, 'view', expiresAt);
      throw error;
    }
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
      for (const intentId of cancelled) this.#cancel(intentId, ACTIVATION_FAILURE.AUTHORIZATION_REVOKED);
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
          this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_ABSENT);
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
        this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_ABSENT);
        continue;
      }
      if (record.record.state === 'approved') {
        const binding = this.#settleOnDrift(intent);
        if (binding === null) continue;
        const recoveryChallenge = this.#approvalViewChallengeMayRecover(intent.approval_id);
        if (recoveryChallenge === undefined) continue;
        try {
          const used = await this.#approvals.claimForDisclosure(
            intent.approval_id,
            binding,
            recoveryChallenge.challenge === undefined ? {} : this.#claimOptions(recoveryChallenge.challenge),
          );
          if (used.usedAt === undefined)
            throw new CommsError('BAD_DATA', 'the used disclosure approval has no usedAt value');
          await this.#claimAndComplete(intent, used.usedAt, recoveryChallenge.issuingResidue);
        } catch (error) {
          if (this.#isChallengeExpired(error)) continue;
          throw error;
        }
        continue;
      }
      if (record.record.state !== 'used' || record.record.usedAt === undefined) continue;
      const binding = this.#settleOnDrift(intent);
      if (binding === null) continue;
      if (canonicalJson(record.record.disclosure) !== canonicalJson(binding)) {
        this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_BINDING_DRIFT);
        continue;
      }
      const completion = this.#usedApprovalCompletion(intent.approval_id, record.record.usedAt);
      if (completion === undefined) continue;
      try {
        await this.#claimAndComplete(intent, record.record.usedAt, completion.issuingResidue);
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
        this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_ABSENT);
        continue;
      }
      const record = await this.#approvals.get(intent.approval_id);
      if (record?.form !== 'v2' || record.record.kind !== 'disclosure' || record.record.state !== 'used') {
        this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_ABSENT);
        continue;
      }
      const binding = this.#settleOnDrift(intent);
      if (binding === null) continue;
      if (record.record.usedAt === undefined || canonicalJson(record.record.disclosure) !== canonicalJson(binding)) {
        this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_BINDING_DRIFT);
        continue;
      }
      const completion = this.#usedApprovalCompletion(intent.approval_id, record.record.usedAt);
      if (completion === undefined) continue;
      try {
        await this.#claimAndComplete(intent, record.record.usedAt, completion.issuingResidue);
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
      this.#store.immediate(() => this.#cancel(intent.id, ACTIVATION_FAILURE.APPROVAL_BINDING_DRIFT));
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
    const plannedAccountIds = [...new Set(points.map((point) => point.accountId))];
    this.#store.immediate(() => {
      // `revoked_at >= created_at` is deliberately inclusive: an intent planned before a same-millisecond removal
      // must lose its authority.  Give an intent made after a re-add a logically later creation instant even when a
      // low-resolution clock has not ticked.  This records the ordering needed to distinguish its fresh approval
      // from an old approval that named the removed account.
      const latestRevocation =
        plannedAccountIds.length === 0
          ? undefined
          : ((
              this.#store.database
                .prepare(
                  `SELECT MAX(revoked_at) AS revoked_at
                 FROM account_revocations
                 WHERE account_id IN (${plannedAccountIds.map(() => '?').join(', ')})`,
                )
                .get(...plannedAccountIds) as { revoked_at: number | null }
            ).revoked_at ?? undefined);
      const createdAt = Math.max(now, latestRevocation === undefined ? now : latestRevocation + 1);
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
          createdAt,
          createdAt,
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

  async #claimAndComplete(
    intent: IntentRow,
    usedAt: string,
    allowIssuingChallengeResidue = false,
  ): Promise<ActivationCompletion> {
    // Recovery reaches this method from a core record already marked used. Compare its immutable core timestamp with
    // the persisted view deadline, rather than the recovery clock: a claim made before expiry may finish after a
    // restart, but an approved view may never be claimed after expiry.
    if (allowIssuingChallengeResidue) this.#assertApprovalIssuingChallengeResidue(intent.approval_id);
    else this.#assertApprovalViewChallengeClaimedInTime(intent.approval_id, usedAt);
    const claimedAt = Date.parse(usedAt);
    if (!Number.isFinite(claimedAt)) throw new CommsError('BAD_DATA', 'the disclosure usedAt is not an instant');
    const deadline = claimedAt + 3_600_000;
    let revokedPlannedAccount = false;
    this.#store.immediate(() => {
      const row = this.#intent(intent.id);
      // The core claim above is an await. A residual sentinel is usable only by recovery, only while it is still the
      // same non-answerable issuer residue, and only in this transaction that starts completion.
      if (allowIssuingChallengeResidue) this.#assertApprovalIssuingChallengeResidue(intent.approval_id);
      if (row.status === 'cancelled')
        throw new CommsError('APPROVAL_VOID', 'the activation was cancelled before completion');
      // Core claiming is another await boundary.  This transaction owns the local claim, so it must fence a judge
      // kind disabled after the core claim but before any provider baseline or local state mutation.
      this.#assertRuleJudgeKindEnabled(this.#document(row));
      // A stable id can be configured again after removal. The approval predates that removal, so it can never
      // authorise the re-added account even if an interrupted purge left this intent pending.
      const revoked = this.#store.database
        .prepare(
          `SELECT 1 AS present
           FROM activation_intents AS planned
           JOIN json_each(planned.required_points) AS point
           JOIN account_revocations AS revocation ON revocation.account_id = json_extract(point.value, '$.accountId')
           WHERE planned.id = ? AND revocation.revoked_at >= planned.created_at
           LIMIT 1`,
        )
        .get(intent.id) as { present: number } | undefined;
      if (revoked !== undefined) {
        this.#cancel(intent.id, ACTIVATION_FAILURE.ACCOUNT_REMOVED);
        revokedPlannedAccount = true;
        return;
      }
      if (row.claimed_at === null) {
        this.#store.database
          .prepare(
            "UPDATE activation_intents SET status = 'pending-completion', claimed_at = ?, completion_deadline = ?, updated_at = ? WHERE id = ?",
          )
          .run(claimedAt, deadline, this.#now(), intent.id);
      }
    });
    if (revokedPlannedAccount)
      throw new CommsError('APPROVAL_VOID', 'an account planned by this activation was removed after its approval');
    const current = this.#intent(intent.id);
    this.#deadlineFailpoint?.('before-claim-deadline');
    if ((current.completion_deadline ?? deadline) <= this.#now()) {
      this.#fail(intent.id, ACTIVATION_FAILURE.COMPLETION_TIMEOUT);
      return Promise.reject(new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed'));
    }
    const document = this.#document(current);
    if (document.kind === 'rule') await this.#assertDocumentSecretsReady(document.rule);
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
                // A Resend status observer has no cursor range to drain. Its durable P instant is the boundary:
                // pre-P observations belong to the old rule, and the new status state seeds at P without emitting.
                const statusScope = scope.source === 'resend' && scope.scopeId === 'status';
                const statusStageOwedByOld =
                  statusScope &&
                  this.#store.database
                    .prepare(
                      `SELECT 1 AS present
                         FROM source_stage_rule_debts AS debt
                         JOIN source_scan_state AS stage ON stage.id = debt.stage_id
                         JOIN rule_versions AS old_version ON old_version.id = ?
                        WHERE debt.rule_id = old_version.rule_id AND debt.rule_version = old_version.version
                          AND stage.source = ? AND stage.account_id = ? AND stage.cursor_scope = 'status'`,
                    )
                    .get(current.replacement_of_version, scope.source, scope.accountId) !== undefined;
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
                      disabled || (statusScope && !statusStageOwedByOld) ? this.#now() : null,
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
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, scope, this.#now()));
        }
        throw error;
      }
    }
    // A baseline call that ended past the completion deadline wrote nothing; settle the timeout now rather than
    // leaving the intent waiting for a baseline that will never be written.
    const afterBaselines = this.#intent(current.id);
    this.#deadlineFailpoint?.('before-baseline-deadline');
    if (afterBaselines.completion_deadline !== null && afterBaselines.completion_deadline <= this.#now()) {
      this.#fail(current.id, ACTIVATION_FAILURE.COMPLETION_TIMEOUT);
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
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, scope, this.#now()));
        }
        throw error;
      }
    }
    this.#failpoint?.('before-finalise');
    // All provider/baseline/encryption awaits are now behind us; re-read the
    // exact immutable slot immediately before the pointer transaction.
    if (document.kind === 'rule') await this.#assertDocumentSecretsReady(document.rule);
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
        this.#failWithin(intent.id, ACTIVATION_FAILURE.COMPLETION_TIMEOUT);
        settled = new CommsError('APPROVAL_VOID', 'the activation completion deadline has passed');
        return;
      }
      // Baseline and point encryption have awaited.  Check under the pointer-write transaction, not only when the
      // rule was prepared or approved, so a disabled kind can never become effective through this final swap.
      this.#assertRuleJudgeKindEnabled(document);
      const effect = JSON.parse(latest.effect) as ActivationEffect;
      const settings = this.#switch();
      if (settings.generation !== effect.switchGeneration) {
        this.#cancel(intent.id, ACTIVATION_FAILURE.STALE_GENERATION);
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
          this.#cancel(intent.id, ACTIVATION_FAILURE.STALE_POINTER);
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
          this.#cancel(intent.id, ACTIVATION_FAILURE.STALE_POINTER);
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
      if (intent.approval_id !== null)
        this.#store.database
          .prepare('DELETE FROM activation_view_challenges WHERE approval_id = ?')
          .run(intent.approval_id);
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

  /** The absence of the sole judge-kind pointer is disabled; deterministic-only rules need no kind check. */
  #assertRuleJudgeKindEnabled(document: ActivationDocumentV1): void {
    if (document.kind !== 'rule' || document.rule.agentic === undefined) return;
    const kind = document.rule.agentic.judge.kind;
    const versions = new ImmutableVersions(this.#store.database);
    assertJudgeKindEnabled(kind, versions.activeVersion('judge-kind', kind) !== null);
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

  /** Read the exact immutable secret slots; callers repeat this after every await-heavy activation phase. */
  async #assertDocumentSecretsReady(rule: Extract<ActivationDocumentV1, { kind: 'rule' }>['rule']): Promise<void> {
    if (this.#assertObjectSecretReady === undefined) return;
    for (const target of rule.targets) {
      if (target.kind === 'webhook')
        await this.#assertObjectSecretReady({
          owner: { kind: 'target', id: target.targetId, version: target.version },
        });
    }
    for (const subscriber of rule.subscribers) {
      await this.#assertObjectSecretReady({
        owner: { kind: 'subscriber', id: subscriber.subscriberId, version: subscriber.version },
      });
    }
    for (const judge of rule.judges) {
      if (judge.kind === 'typesafe')
        await this.#assertObjectSecretReady({ owner: { kind: 'judge', id: judge.judgeId, version: judge.version } });
    }
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

  #cancel(intentId: string, code: ActivationFailureCode): void {
    this.#store.database
      .prepare("UPDATE activation_intents SET status = 'cancelled', failure_code = ?, updated_at = ? WHERE id = ?")
      .run(code, this.#now(), intentId);
    this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
    this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intentId);
  }

  /** Every issued core challenge has an origin row; its absence or invalid shape is never a terminal-prompt fallback. */
  #assertApprovalViewChallengeCurrent(approvalId: string, answer?: string): ApprovalChallenge {
    const row = this.#approvalViewChallenge(approvalId);
    if (row === undefined) throw this.#challengeExpired();
    const challenge = this.#readApprovalChallenge(row);
    if (
      row.state !== 'active' ||
      (challenge.origin === 'view' && this.#viewChallengeDeadline(challenge) <= this.#now())
    ) {
      if (row.state === 'active' && challenge.origin === 'view') this.#expireApprovalViewChallenge(approvalId);
      throw this.#challengeExpired();
    }
    if (answer !== undefined && hashChallenge(answer) !== challenge.challengeHash) throw this.#challengeExpired();
    return challenge;
  }

  /** An app approval records only a view challenge; an ordinary terminal answer remains the terminal channel. */
  #assertApprovalChannel(challenge: ApprovalChallenge, via: 'terminal' | 'app'): ApprovalChallenge {
    if (via === 'app' && challenge.origin !== 'view') throw this.#challengeExpired();
    return challenge;
  }

  #assertApprovalViewChallengeClaimedInTime(approvalId: string | null, usedAt: string): void {
    if (approvalId === null) throw this.#challengeExpired();
    const row = this.#approvalViewChallenge(approvalId);
    if (row === undefined) throw this.#challengeExpired();
    const challenge = this.#readApprovalChallenge(row);
    const claimedAt = Date.parse(usedAt);
    if (
      row.state !== 'active' ||
      !Number.isFinite(claimedAt) ||
      (challenge.origin === 'view' && claimedAt >= this.#viewChallengeDeadline(challenge))
    )
      throw this.#challengeExpired();
  }

  #approvalViewChallengeMayClaim(approvalId: string): ApprovalChallenge | undefined {
    try {
      return this.#assertApprovalViewChallengeCurrent(approvalId);
    } catch (error) {
      if (this.#isChallengeExpired(error)) return undefined;
      throw error;
    }
  }

  /** Recovery may spend core's already-approved record when only the old issuer race left this non-answerable row. */
  #approvalViewChallengeMayRecover(approvalId: string): RecoveryApprovalChallenge | undefined {
    const challenge = this.#approvalViewChallengeMayClaim(approvalId);
    if (challenge !== undefined) return { challenge, issuingResidue: false };
    if (!this.#isApprovalIssuingChallengeResidue(approvalId)) return undefined;
    return { challenge: undefined, issuingResidue: true };
  }

  /**
   * Whether work core has already claimed may finish: its view challenge was claimed in time or, core having spent the
   * approval for exactly this binding, only an issuer's non-answerable `issuing` row remains — the residue an owner
   * from before the per-approval serialisation could leave — which completes through the same residue path an
   * approved record takes. Otherwise the claimed activation would stay neither completed nor re-approvable.
   */
  #usedApprovalCompletion(approvalId: string, usedAt: string): { readonly issuingResidue: boolean } | undefined {
    if (this.#isApprovalIssuingChallengeResidue(approvalId)) return { issuingResidue: true };
    return this.#approvalViewChallengeMayComplete(approvalId, usedAt) ? { issuingResidue: false } : undefined;
  }

  #approvalViewChallengeMayComplete(approvalId: string, usedAt: string): boolean {
    try {
      this.#assertApprovalViewChallengeClaimedInTime(approvalId, usedAt);
      return true;
    } catch (error) {
      if (this.#isChallengeExpired(error)) return false;
      throw error;
    }
  }

  #approvalViewChallenge(approvalId: string): ApprovalViewChallengeRow | undefined {
    return this.#store.database
      .prepare('SELECT state, origin, challenge_hash, expires_at FROM activation_view_challenges WHERE approval_id = ?')
      .get(approvalId) as ApprovalViewChallengeRow | undefined;
  }

  /** An interrupted issuance remains deliberately non-answerable; only recovery after a core approval can consume it. */
  #isApprovalIssuingChallengeResidue(approvalId: string | null): boolean {
    if (approvalId === null) return false;
    const row = this.#approvalViewChallenge(approvalId);
    return row?.state === 'issuing' && (row.origin === 'terminal' || row.origin === 'view');
  }

  #assertApprovalIssuingChallengeResidue(approvalId: string | null): void {
    if (!this.#isApprovalIssuingChallengeResidue(approvalId)) throw this.#challengeExpired();
  }

  #readApprovalChallenge(row: ApprovalViewChallengeRow): ApprovalChallenge {
    if (
      (row.state !== 'active' && row.state !== 'expired') ||
      typeof row.challenge_hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(row.challenge_hash) ||
      (row.origin !== 'view' && row.origin !== 'terminal')
    )
      throw this.#challengeExpired();
    if (row.origin === 'view') {
      if (typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at) || row.expires_at <= 0)
        throw this.#challengeExpired();
      return { origin: 'view', challengeHash: row.challenge_hash, expiresAt: row.expires_at };
    }
    if (row.state !== 'active' || row.expires_at !== null) throw this.#challengeExpired();
    return { origin: 'terminal', challengeHash: row.challenge_hash };
  }

  #claimOptions(challenge: ApprovalChallenge): { readonly deadlineMs?: number | undefined } {
    return challenge.origin === 'view' ? { deadlineMs: this.#viewChallengeDeadline(challenge) } : {};
  }

  #viewChallengeDeadline(challenge: ApprovalChallenge): number {
    if (challenge.origin !== 'view' || challenge.expiresAt === undefined) throw this.#challengeExpired();
    return challenge.expiresAt;
  }

  #isChallengeExpired(error: unknown): boolean {
    return (
      error instanceof CommsError && error.code === 'APPROVAL_VOID' && error.details?.reason === 'CHALLENGE_EXPIRED'
    );
  }

  #beginApprovalChallenge(approvalId: string, origin: ApprovalChallenge['origin']): void {
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO activation_view_challenges (approval_id, state, origin, challenge_hash, expires_at, updated_at)
           VALUES (?, 'issuing', ?, NULL, NULL, ?)
           ON CONFLICT(approval_id) DO UPDATE SET state = 'issuing', origin = excluded.origin, challenge_hash = NULL, expires_at = NULL,
             updated_at = excluded.updated_at`,
        )
        .run(approvalId, origin, this.#now());
    });
  }

  #activateApprovalChallenge(
    approvalId: string,
    origin: ApprovalChallenge['origin'],
    challengeHash: string,
    expiresAt?: number,
  ): void {
    if ((origin === 'view' && expiresAt === undefined) || (origin === 'terminal' && expiresAt !== undefined))
      throw this.#challengeExpired();
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          "UPDATE activation_view_challenges SET state = 'active', challenge_hash = ?, expires_at = ?, updated_at = ? WHERE approval_id = ? AND state = 'issuing' AND origin = ?",
        )
        .run(challengeHash, expiresAt ?? null, this.#now(), approvalId, origin);
      const current = this.#approvalViewChallenge(approvalId);
      if (
        current?.state !== 'active' ||
        current.origin !== origin ||
        current.challenge_hash !== challengeHash ||
        current.expires_at !== (expiresAt ?? null)
      )
        throw this.#challengeExpired();
    });
  }

  /** A core failure cannot leave a durable `issuing` row that suppresses all future views. */
  #settleFailedApprovalChallengeIssuance(
    approvalId: string,
    origin: ApprovalChallenge['origin'],
    expiresAt?: number,
  ): void {
    this.#store.immediate(() => {
      const issuing = this.#approvalViewChallenge(approvalId);
      // A distinct writer can only have settled/replaced it; never overwrite that newer state while reporting core's
      // original failure. The owner queue makes this a defensive cross-process/crash guard rather than the normal path.
      if (issuing?.state !== 'issuing' || issuing.origin !== origin) return;
      if (origin === 'terminal') {
        this.#store.database
          .prepare(
            "DELETE FROM activation_view_challenges WHERE approval_id = ? AND state = 'issuing' AND origin = 'terminal'",
          )
          .run(approvalId);
        if (this.#approvalViewChallenge(approvalId) !== undefined) throw this.#challengeExpired();
        return;
      }
      if (expiresAt === undefined) throw this.#challengeExpired();
      this.#store.database
        .prepare(
          "UPDATE activation_view_challenges SET state = 'expired', challenge_hash = ?, expires_at = ?, updated_at = ? WHERE approval_id = ? AND state = 'issuing' AND origin = 'view'",
        )
        .run(hashChallenge(`issuance-failed:${approvalId}:${this.#now()}`), expiresAt, this.#now(), approvalId);
      const settled = this.#approvalViewChallenge(approvalId);
      if (
        settled?.state !== 'expired' ||
        settled.origin !== origin ||
        typeof settled.challenge_hash !== 'string' ||
        settled.expires_at !== expiresAt
      )
        throw this.#challengeExpired();
    });
  }

  #expireApprovalViewChallenge(approvalId: string): void {
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          "UPDATE activation_view_challenges SET state = 'expired', updated_at = ? WHERE approval_id = ? AND origin = 'view'",
        )
        .run(this.#now(), approvalId);
    });
  }

  /** Serialises only one approval id; unrelated approvals retain full concurrency through every core await. */
  async #withApprovalOperation<T>(approvalId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#approvalOperations.get(approvalId);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#approvalOperations.set(approvalId, current);
    await previous;
    try {
      return await work();
    } finally {
      release?.();
      if (this.#approvalOperations.get(approvalId) === current) this.#approvalOperations.delete(approvalId);
    }
  }

  #challengeExpired(): CommsError {
    return new CommsError('APPROVAL_VOID', 'the approval-view challenge expired before it could be approved', {
      details: { reason: 'CHALLENGE_EXPIRED' },
    });
  }

  #fail(intentId: string, code: ActivationFailureCode): void {
    this.#store.immediate(() => this.#failWithin(intentId, code));
  }

  /** The failure's writes, for a caller already inside a transaction. */
  #failWithin(intentId: string, code: ActivationFailureCode): void {
    this.#store.database
      .prepare("UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
      .run(code, this.#now(), intentId);
    this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
    this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intentId);
  }
}
