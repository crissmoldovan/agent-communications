import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import { isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import { commitHeldDecisionOutbox, type DecisionFailpoint, StaleDecisionError } from './decisions.ts';
import { prepareDeliveries } from './deliveries.ts';
import type { DisclosureSnapshot } from './disclosure-fence.ts';
import { evaluateRuleProjection } from './mapping.ts';
import { EventProjectionStore, type ProjectionCipher, type ProjectionReference } from './projections.ts';
import type { EventTaintRecorder } from './untrusted.ts';
import type { FencedWhatsAppEventVisibility, WhatsAppVisibilityFence } from './whatsapp-visibility.ts';
import { runMessageOf } from './workflow/run-message.ts';
import { prepareFlowRun } from './workflow/runs.ts';

export type HoldBoundBy = 'hold-window' | 'ingest-retention';

export interface HoldDeadline {
  readonly holdExpiresAt: number;
  readonly holdBoundBy: HoldBoundBy;
}

/**
 * SQLite, rather than the process clock, owns every hold deadline and comparison.  `julianday('now')` is available
 * in every SQLite version we support and returns the connection's transaction-time value in UTC milliseconds.
 */
export function sqliteTransactionNow(database: DatabaseSync): number {
  const row = database.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now").get() as
    | { now: number }
    | undefined;
  if (row === undefined || !Number.isSafeInteger(row.now))
    throw new Error('SQLite did not provide a safe transaction clock');
  return row.now;
}

/** Creation and tightening share this monotonic, tie-stable deadline calculation. */
export function holdDeadline(input: {
  readonly holdCreatedAt: number;
  readonly holdMs: number;
  readonly stagedAt: number;
  readonly ingestMs: number;
}): HoldDeadline {
  const holdWindow = fixedDeadline(input.holdCreatedAt, input.holdMs);
  const ingestRetention = fixedDeadline(input.stagedAt, input.ingestMs);
  return ingestRetention <= holdWindow
    ? { holdExpiresAt: ingestRetention, holdBoundBy: 'ingest-retention' }
    : { holdExpiresAt: holdWindow, holdBoundBy: 'hold-window' };
}

export interface HeldDecisionClaim {
  readonly decisionId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly claimToken: Uint8Array;
  readonly claimedAt: number;
  readonly leaseExpiresAt: number;
}

export type ClaimHeldDecisionResult =
  | { readonly kind: 'claimed'; readonly claim: HeldDecisionClaim }
  | { readonly kind: 'busy' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'terminal' };

interface HeldDecisionRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly hold_expires_at: number | null;
  readonly outcome: string;
}

/**
 * Removes abandoned claims using SQLite's current transaction clock.  A recovery never grants a claim across a
 * process restart: it merely makes the still-held decision eligible for one new, decision-bound claimant.
 */
export function recoverExpiredHoldClaims(store: EventDatabase): number {
  return store.immediate(() => recoverExpiredHoldClaimsInTransaction(store.database));
}

export function recoverExpiredHoldClaimsInTransaction(database: DatabaseSync): number {
  const now = sqliteTransactionNow(database);
  return Number(database.prepare('DELETE FROM hold_resolution_claims WHERE lease_expires_at <= ?').run(now).changes);
}

/**
 * Takes the only durable resolver lease for a still-held decision.  Equality belongs to expiry: an insert is
 * attempted only while `hold_expires_at > now`, and no caller-provided/process clock participates.
 */
export function claimHeldDecision(input: {
  readonly store: EventDatabase;
  readonly decisionId: string;
  readonly leaseMs: number;
  readonly claimToken?: Uint8Array | undefined;
}): ClaimHeldDecisionResult {
  return input.store.immediate(() => {
    const database = input.store.database;
    const now = sqliteTransactionNow(database);
    database.prepare('DELETE FROM hold_resolution_claims WHERE lease_expires_at <= ?').run(now);
    const row = database
      .prepare(
        `SELECT id, account_id, rule_id, rule_version, hold_expires_at, outcome
           FROM decisions WHERE id = ?`,
      )
      .get(input.decisionId) as HeldDecisionRow | undefined;
    if (row === undefined) return { kind: 'terminal' };
    if (row.outcome !== 'hold')
      return row.outcome === 'hold-expired' || row.outcome === 'retention-expired'
        ? { kind: 'expired' }
        : { kind: 'terminal' };
    if (row.hold_expires_at === null || row.hold_expires_at <= now) {
      // Claiming is itself a hold boundary: an idle scheduler cannot leave an expired hold retained merely because a
      // resolver arrived first. The terminalisation runs in this same IMMEDIATE transaction.
      expireHeldDecisionsInTransaction(database);
      return { kind: 'expired' };
    }
    const claimToken = input.claimToken ?? randomBytes(32);
    if (claimToken.byteLength !== 32) throw new Error('a hold claim token must contain exactly 32 random bytes');
    const leaseExpiresAt = fixedDeadline(now, input.leaseMs);
    const inserted = database
      .prepare(
        `INSERT OR IGNORE INTO hold_resolution_claims
           (decision_id, account_id, rule_id, rule_version, claim_token, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.account_id, row.rule_id, row.rule_version, claimToken, now, leaseExpiresAt);
    if (inserted.changes !== 1) return { kind: 'busy' };
    return {
      kind: 'claimed',
      claim: {
        decisionId: row.id,
        accountId: row.account_id,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        claimToken,
        claimedAt: now,
        leaseExpiresAt,
      },
    };
  });
}

/**
 * Terminalises every due hold content-free before other expiry/control/replay work can inspect its projection.  The
 * hold's stored bound determines the stable outcome; claimed and unclaimed holds deliberately follow this one path.
 */
export function expireHeldDecisions(store: EventDatabase): number {
  return store.immediate(() => expireHeldDecisionsInTransaction(store.database));
}

export function expireHeldDecisionsInTransaction(database: DatabaseSync): number {
  const now = sqliteTransactionNow(database);
  const due = database
    .prepare(
      `SELECT id, event_id, rule_id, rule_version, hold_bound_by
         FROM decisions
        WHERE outcome = 'hold' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`,
    )
    .all(now) as Array<{
    id: string;
    event_id: string;
    rule_id: string;
    rule_version: number;
    hold_bound_by: HoldBoundBy | null;
  }>;
  for (const held of due) {
    const outcome = held.hold_bound_by === 'ingest-retention' ? 'retention-expired' : 'hold-expired';
    database
      .prepare(
        `UPDATE decisions
            SET outcome = ?, hold_created_at = NULL, hold_expires_at = NULL, hold_bound_by = NULL,
                encrypted_record = NULL
          WHERE id = ? AND outcome = 'hold' AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?`,
      )
      .run(outcome, held.id, now);
    database.prepare('DELETE FROM hold_resolution_claims WHERE decision_id = ?').run(held.id);
    database
      .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .run(held.event_id, held.rule_id, held.rule_version);
  }
  return due.length;
}

/** The shared judge purge participant owns this selector vocabulary; each source selector stays account-bound. */
export type HeldDecisionPurgeSelector =
  | { readonly scope: 'all' }
  | { readonly scope: 'judge-kind'; readonly judgeKind: string }
  | { readonly scope: 'source-account'; readonly source: string; readonly accountId: string }
  | { readonly scope: 'source-event'; readonly source: string; readonly accountId: string; readonly eventId: string }
  | {
      readonly scope: 'source-event-rule';
      readonly source: string;
      readonly accountId: string;
      readonly eventId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
    };

/**
 * Purge terminalises, rather than deletes, a held decision and removes its resolver lease and retained projection in
 * the caller's transaction. The source/account predicates deliberately live beside every non-global selector.
 */
export function purgeHeldDecisionsInTransaction(database: DatabaseSync, selector: HeldDecisionPurgeSelector): number {
  let where = "decision.outcome = 'hold'";
  const values: Array<string | number> = [];
  switch (selector.scope) {
    case 'all':
      break;
    case 'judge-kind':
      where += " AND json_extract(rule.document, '$.agentic.judge.kind') = ?";
      values.push(selector.judgeKind);
      break;
    case 'source-account':
      where += " AND decision.account_id = ? AND json_extract(rule.document, '$.source.channel') = ?";
      values.push(selector.accountId, selector.source);
      break;
    case 'source-event':
      where +=
        " AND decision.account_id = ? AND decision.event_id = ? AND json_extract(rule.document, '$.source.channel') = ?";
      values.push(selector.accountId, selector.eventId, selector.source);
      break;
    case 'source-event-rule':
      where +=
        " AND decision.account_id = ? AND decision.event_id = ? AND decision.rule_id = ? AND decision.rule_version = ? AND json_extract(rule.document, '$.source.channel') = ?";
      values.push(selector.accountId, selector.eventId, selector.ruleId, selector.ruleVersion, selector.source);
      break;
  }
  const held = database
    .prepare(
      `SELECT decision.id, decision.event_id, decision.rule_id, decision.rule_version
         FROM decisions AS decision
         JOIN rule_versions AS rule ON rule.rule_id = decision.rule_id AND rule.version = decision.rule_version
        WHERE ${where}`,
    )
    .all(...values) as Array<{ id: string; event_id: string; rule_id: string; rule_version: number }>;
  for (const decision of held) {
    database
      .prepare(
        `UPDATE decisions
            SET outcome = 'cancelled', hold_created_at = NULL, hold_expires_at = NULL, hold_bound_by = NULL,
                encrypted_record = NULL
          WHERE id = ? AND outcome = 'hold'`,
      )
      .run(decision.id);
    database.prepare('DELETE FROM hold_resolution_claims WHERE decision_id = ?').run(decision.id);
    database
      .prepare('DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .run(decision.event_id, decision.rule_id, decision.rule_version);
  }
  return held.length;
}

interface HeldResolutionSnapshot {
  readonly reference: ProjectionReference;
  readonly accountId: string;
  readonly rule: CanonicalFullRuleDocument;
  readonly switchGeneration: number;
}

/**
 * Identifies whether a held decision is WhatsApp-bound without selecting the retained projection.  The live-list
 * fence must be acquired before the ciphertext-bearing snapshot below is read.
 */
interface HeldResolutionVisibilitySnapshot {
  readonly accountId: string;
  readonly whatsappMessageId: string | null;
}

function heldResolutionVisibilitySnapshot(
  store: EventDatabase,
  decisionId: string,
): HeldResolutionVisibilitySnapshot | null {
  const row = store.database
    .prepare(
      `SELECT decision.account_id, projection.whatsapp_message_id
         FROM decisions AS decision
         JOIN ingest_rules AS projection
           ON projection.event_id = decision.event_id
          AND projection.rule_id = decision.rule_id
          AND projection.rule_version = decision.rule_version
        WHERE decision.id = ? AND decision.outcome = 'hold'`,
    )
    .get(decisionId) as { account_id: string; whatsapp_message_id: string | null } | undefined;
  return row === undefined ? null : { accountId: row.account_id, whatsappMessageId: row.whatsapp_message_id };
}

function heldResolutionSnapshot(store: EventDatabase, decisionId: string): HeldResolutionSnapshot | null {
  const row = store.database
    .prepare(
      `SELECT decision.event_id, decision.account_id, decision.rule_id, decision.rule_version,
              projection.decision_deadline, projection.encrypted_projection,
              projection.whatsapp_message_id, projection.whatsapp_visibility_version,
              rule.document, settings.switch_generation
         FROM decisions AS decision
         JOIN ingest_rules AS projection
           ON projection.event_id = decision.event_id
          AND projection.rule_id = decision.rule_id
          AND projection.rule_version = decision.rule_version
         JOIN rule_versions AS rule ON rule.rule_id = decision.rule_id AND rule.version = decision.rule_version
         JOIN event_settings AS settings ON settings.singleton = 1
        WHERE decision.id = ? AND decision.outcome = 'hold'`,
    )
    .get(decisionId) as
    | {
        event_id: string;
        account_id: string;
        rule_id: string;
        rule_version: number;
        decision_deadline: number;
        encrypted_projection: Uint8Array;
        whatsapp_message_id: string | null;
        whatsapp_visibility_version: number | null;
        document: string;
        switch_generation: number;
      }
    | undefined;
  if (row === undefined) return null;
  try {
    const rule = JSON.parse(row.document) as CanonicalFullRuleDocument;
    return {
      accountId: row.account_id,
      rule,
      switchGeneration: row.switch_generation,
      reference: {
        eventId: row.event_id,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        decisionDeadline: row.decision_deadline,
        encryptedProjection: row.encrypted_projection,
        whatsappMessageId: row.whatsapp_message_id,
        whatsappVisibilityVersion: row.whatsapp_visibility_version,
      },
    };
  } catch {
    return null;
  }
}

export type HeldResolutionResult =
  | { readonly kind: 'resolved'; readonly outcome: 'matched' | 'no-match' | 'mapping-rejected' }
  | { readonly kind: 'busy' | 'expired' | 'terminal' | 'stale' };

/**
 * The terminal/app resolver. It makes no judge call: the stored uncertain answer is final and the person chooses
 * accept/reject. It only decrypts the already retained projection to run normal mapping and delivery encryption,
 * then gives the existing decision owner the final atomic write.
 */
export class HoldResolver {
  readonly #store: EventDatabase;
  readonly #cipher: ProjectionCipher;
  readonly #taint: EventTaintRecorder;
  readonly #leaseMs: number;
  readonly #newId: () => string;
  readonly #decisionFailpoint: ((point: DecisionFailpoint) => void) | undefined;
  readonly #accountLive: (input: {
    readonly source: CanonicalFullRuleDocument['source']['channel'];
    readonly accountId: string;
  }) => Promise<void>;
  readonly #authorise: (input: {
    readonly accountId: string;
    readonly rule: CanonicalFullRuleDocument;
    readonly switchGeneration: number;
  }) => Promise<DisclosureSnapshot>;
  readonly #whatsappVisibilityFence: Pick<WhatsAppVisibilityFence, 'withCurrentVisibleRead'> | undefined;

  constructor(options: {
    readonly store: EventDatabase;
    readonly cipher: ProjectionCipher;
    readonly taint: EventTaintRecorder;
    readonly leaseMs?: number | undefined;
    readonly newId?: (() => string) | undefined;
    /** Test-only crash seam shared with the sole decision transaction; production callers leave it absent. */
    readonly decisionFailpoint?: ((point: DecisionFailpoint) => void) | undefined;
    readonly accountLive: (input: {
      readonly source: CanonicalFullRuleDocument['source']['channel'];
      readonly accountId: string;
    }) => Promise<void>;
    /** Reads the shared disclosure fence for each bound target before and after retained-content decrypt/mapping. */
    readonly authorise: (input: {
      readonly accountId: string;
      readonly rule: CanonicalFullRuleDocument;
      readonly switchGeneration: number;
    }) => Promise<DisclosureSnapshot>;
    /** The D9 live-list lock/journal gate is mandatory before held WhatsApp content is read. */
    readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentVisibleRead'> | undefined;
  }) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#taint = options.taint;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#decisionFailpoint = options.decisionFailpoint;
    this.#accountLive = options.accountLive;
    this.#authorise = options.authorise;
    this.#whatsappVisibilityFence = options.whatsappVisibilityFence;
  }

  async resolve(input: {
    readonly decisionId: string;
    readonly decision: 'accept' | 'reject';
  }): Promise<HeldResolutionResult> {
    const claimed = claimHeldDecision({ store: this.#store, decisionId: input.decisionId, leaseMs: this.#leaseMs });
    if (claimed.kind !== 'claimed') return claimed;
    const visibilitySnapshot = heldResolutionVisibilitySnapshot(this.#store, input.decisionId);
    if (visibilitySnapshot === null) return { kind: 'stale' };
    let resolvedSnapshot: HeldResolutionSnapshot | undefined;
    try {
      if (visibilitySnapshot.whatsappMessageId !== null) {
        if (this.#whatsappVisibilityFence === undefined) return { kind: 'stale' };
        const resolved = await this.#whatsappVisibilityFence.withCurrentVisibleRead(
          { accountId: visibilitySnapshot.accountId, whatsappMessageId: visibilitySnapshot.whatsappMessageId },
          (visibility) => {
            // The fence applies its journal before this ciphertext-bearing row is selected. A concurrent purge or
            // head change leaves no held row to resolve; a rebinding cannot borrow this claim.
            const before = heldResolutionSnapshot(this.#store, input.decisionId);
            if (
              before === null ||
              before.accountId !== visibilitySnapshot.accountId ||
              before.reference.whatsappMessageId !== visibilitySnapshot.whatsappMessageId
            )
              return { kind: 'stale' } as const;
            resolvedSnapshot = before;
            return this.#resolveClaimed(input, claimed.claim, before, visibility);
          },
        );
        return resolved ?? { kind: 'stale' };
      }
      const before = heldResolutionSnapshot(this.#store, input.decisionId);
      if (before === null) return { kind: 'stale' };
      resolvedSnapshot = before;
      return await this.#resolveClaimed(input, claimed.claim, before);
    } catch (error) {
      if (error instanceof StaleDecisionError) return { kind: 'stale' };
      if (isRemovedAccountError(error)) {
        const snapshot = resolvedSnapshot;
        if (snapshot !== undefined)
          this.#store.immediate(() =>
            purgeRemovedAccountWork(
              this.#store.database,
              { source: snapshot.rule.source.channel, accountId: snapshot.accountId },
              sqliteTransactionNow(this.#store.database),
            ),
          );
        return { kind: 'stale' };
      }
      throw error;
    }
  }

  async #resolveClaimed(
    input: Readonly<{ decisionId: string; decision: 'accept' | 'reject' }>,
    claim: HeldDecisionClaim,
    before: HeldResolutionSnapshot,
    whatsappVisibility?: FencedWhatsAppEventVisibility,
  ): Promise<HeldResolutionResult> {
    await this.#accountLive({ source: before.rule.source.channel, accountId: before.accountId });
    const beforeAuthorisation = await this.#authorise({
      accountId: before.accountId,
      rule: before.rule,
      switchGeneration: before.switchGeneration,
    });
    const projection = await new EventProjectionStore({ store: this.#store, cipher: this.#cipher }).read(
      before.reference,
    );
    // Every await above can race a purge/revoke/list/account change. Re-read the exact held row and asynchronous
    // authorities before deriving any delivery ciphertext; the transaction repeats durable facts once more.
    const after = heldResolutionSnapshot(this.#store, input.decisionId);
    if (after === null) return { kind: 'stale' };
    await this.#accountLive({ source: after.rule.source.channel, accountId: after.accountId });
    const authorisation = await this.#authorise({
      accountId: after.accountId,
      rule: after.rule,
      switchGeneration: after.switchGeneration,
    });
    if (
      before.rule.ruleId !== after.rule.ruleId ||
      before.rule.version !== after.rule.version ||
      before.accountId !== after.accountId ||
      before.reference.whatsappMessageId !== after.reference.whatsappMessageId ||
      beforeAuthorisation.approvalId !== authorisation.approvalId ||
      beforeAuthorisation.authorizationActivationId !== authorisation.authorizationActivationId
    )
      return { kind: 'stale' };
    const evaluated = input.decision === 'accept' ? evaluateRuleProjection(after.rule, projection.event) : null;
    const outcome =
      input.decision === 'reject'
        ? 'no-match'
        : evaluated === null
          ? 'no-match'
          : 'rejected' in evaluated
            ? 'mapping-rejected'
            : 'matched';
    const createdAt = this.#store.immediate(() => sqliteTransactionNow(this.#store.database));
    const deliveries =
      evaluated === null || 'rejected' in evaluated
        ? []
        : await prepareDeliveries({
            cipher: this.#cipher,
            definition: evaluated.definition,
            event: projection.event,
            rule: after.rule,
            classification: evaluated.classification,
            installationId: this.#store.installationId,
            createdAt,
            newId: this.#newId,
            data: evaluated.mapped.data,
            // A person let this held decision through: its queue item says so, not what the judge answered (Q3).
            released: true,
          });
    // A released match of a workflow with a flow is a run, as an evaluated one is (workflows design §5).
    const run =
      evaluated === null || 'rejected' in evaluated
        ? undefined
        : await prepareFlowRun({
            cipher: this.#cipher,
            rule: after.rule,
            data: evaluated.mapped.data,
            createdAt,
            // The message and its thread, for a flow that finds the session that took the conversation (W36).
            message: runMessageOf(after.rule, projection.event),
          });
    if (evaluated !== null && !('rejected' in evaluated))
      await this.#taint.record({
        eventId: after.reference.eventId,
        accountId: after.accountId,
        channel: after.rule.source.channel,
        classification: evaluated.classification,
      });
    // Encryption and taint both await. This repeats the shared live-account fence immediately before the only
    // synchronous final decision transaction, so a removed account cannot gain a delivery between those awaits.
    await this.#accountLive({ source: after.rule.source.channel, accountId: after.accountId });
    commitHeldDecisionOutbox(
      this.#store,
      {
        id: input.decisionId,
        eventId: after.reference.eventId,
        accountId: after.accountId,
        ruleId: after.reference.ruleId,
        ruleVersion: after.reference.ruleVersion,
        claimToken: claim.claimToken,
        outcome,
        switchGeneration: after.switchGeneration,
        deliveries,
        ...(run === undefined ? {} : { run }),
        disclosure: {
          approvalId: authorisation.approvalId,
          authorizationActivationId: authorisation.authorizationActivationId,
        },
        ...(whatsappVisibility === undefined ? {} : { whatsappVisibilityVersion: whatsappVisibility.journalVersion }),
      },
      this.#decisionFailpoint,
    );
    return { kind: 'resolved', outcome };
  }
}
