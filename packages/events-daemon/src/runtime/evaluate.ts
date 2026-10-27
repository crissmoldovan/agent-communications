import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { senderDomainOf } from '../domain/sender-domain.ts';
import type { EventDatabase } from '../store/database.ts';
import { fixedDeadline } from '../store/retention.ts';
import { assertLiveEventAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import { commitDecisionOutbox, type DecisionFailpoint, StaleDecisionError } from './decisions.ts';
import { prepareDeliveries } from './deliveries.ts';
import type { ActiveDisclosableRequest, DisclosureSnapshot } from './disclosure-fence.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import { type ChainStart, chainRequestFor, chainStartFor, isAwaitingChain } from './events/chains.ts';
import { sqliteTransactionNow } from './holds.ts';
import { JudgeCoordinator } from './judge-coordinator.ts';
import { recoverJudgeReservation } from './judge-recovery.ts';
import type { HostedJudgeCredential } from './judge-transport.ts';
import { evaluateRuleProjection, matchesRuleCondition } from './mapping.ts';
import { EventProjectionStore, type ProjectionCipher } from './projections.ts';
import { keepSenderDomain, senderDomainLocation } from './sender-domains.ts';
import type { EventTaintRecorder } from './untrusted.ts';
import { runMessageOf } from './workflow/run-message.ts';
import { prepareFlowRun } from './workflow/runs.ts';
import { WriterQuiescer, withEventWriterLease } from './writer-quiescer.ts';

type EvaluationFenceRequest = Omit<ActiveDisclosableRequest, 'approvals' | 'config'>;

export interface EventEvaluatorOptions {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  readonly taint: EventTaintRecorder;
  readonly now?: (() => number) | undefined;
  readonly newId?: (() => string) | undefined;
  readonly failpoint?: ((point: DecisionFailpoint) => void) | undefined;
  /** Test injection only; production calls the one shared fence below. */
  readonly fence?: ((request: EvaluationFenceRequest) => Promise<DisclosureSnapshot>) | undefined;
  readonly approvals?: Pick<ApprovalStore, 'get'> | undefined;
  readonly config?: Pick<ConfigStore, 'load'> | undefined;
  /** The production coordinator is injectable only so sealed loopback fixtures can use a real transport. */
  readonly judgeCoordinator?: JudgeCoordinator | undefined;
  /** Read only at the hosted judge boundary; the evaluator neither retains nor exposes this material. */
  readonly hostedJudgeKeyFor?:
    | ((input: { readonly judgeId: string; readonly judgeVersion: number }) => Promise<HostedJudgeCredential | null>)
    | undefined;
  /** The owner-wide writer lease spans projection decryption through every encrypted decision or delivery commit. */
  readonly writerQuiescer?: WriterQuiescer | undefined;
}

interface RuleRow {
  readonly document: string;
}

function ruleFor(store: EventDatabase, ruleId: string, ruleVersion: number): CanonicalFullRuleDocument {
  const row = store.database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as RuleRow | undefined;
  if (!row) throw new CommsError('NOT_FOUND', 'the exact workflow version is unavailable for evaluation');
  return JSON.parse(row.document) as CanonicalFullRuleDocument;
}

function cipherWriterQuiescer(cipher: ProjectionCipher): WriterQuiescer | undefined {
  const candidate = cipher as ProjectionCipher & { readonly writerQuiescer?: unknown };
  return candidate.writerQuiescer instanceof WriterQuiescer ? candidate.writerQuiescer : undefined;
}

/** Evaluates one encrypted per-rule projection and durably completes its local outbox in one transaction. */
export class EventEvaluator {
  readonly #store: EventDatabase;
  readonly #projections: EventProjectionStore;
  readonly #cipher: ProjectionCipher;
  readonly #taint: EventTaintRecorder;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #failpoint: EventEvaluatorOptions['failpoint'];
  readonly #fence: NonNullable<EventEvaluatorOptions['fence']>;
  readonly #config: Pick<ConfigStore, 'load'> | undefined;
  readonly #judgeCoordinator: JudgeCoordinator;
  readonly #writerQuiescer: WriterQuiescer | undefined;

  constructor(options: EventEvaluatorOptions) {
    this.#store = options.store;
    this.#projections = new EventProjectionStore({ store: options.store, cipher: options.cipher });
    this.#cipher = options.cipher;
    this.#taint = options.taint;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    this.#failpoint = options.failpoint;
    this.#config = options.config;
    this.#writerQuiescer = options.writerQuiescer ?? cipherWriterQuiescer(options.cipher);
    this.#judgeCoordinator =
      options.judgeCoordinator ??
      new JudgeCoordinator({
        store: options.store,
        taint: options.taint,
        now: this.#now,
        newId: this.#newId,
        ...(options.hostedJudgeKeyFor === undefined ? {} : { hostedApiKeyFor: options.hostedJudgeKeyFor }),
      });
    if (options.fence) this.#fence = options.fence;
    else {
      if (!options.approvals || !options.config)
        throw new CommsError('CONFIG', 'evaluation needs the shared disclosure fence dependencies');
      this.#fence = (request) =>
        assertDisclosable({
          ...request,
          approvals: options.approvals as Pick<ApprovalStore, 'get'>,
          config: options.config as Pick<ConfigStore, 'load'>,
        });
    }
  }

  async admit(input: {
    readonly event: Record<string, unknown>;
    readonly eventId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly stagedAt: number;
    readonly stageId?: string | undefined;
    readonly whatsapp?: Readonly<{ messageId: string; visibilityVersion: number }> | undefined;
  }): Promise<'terminal' | 'pending'> {
    return this.#withWriterLease(() => this.#admit(input));
  }

  async #admit(input: {
    readonly event: Record<string, unknown>;
    readonly eventId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly stagedAt: number;
    readonly stageId?: string | undefined;
    readonly whatsapp?: Readonly<{ messageId: string; visibilityVersion: number }> | undefined;
  }): Promise<'terminal' | 'pending'> {
    const terminal = this.#store.database
      .prepare('SELECT 1 AS present FROM decisions WHERE event_id = ? AND rule_id = ? AND rule_version = ?')
      .get(input.eventId, input.ruleId, input.ruleVersion);
    if (terminal !== undefined) return 'terminal';
    const rule = ruleFor(this.#store, input.ruleId, input.ruleVersion);
    const config = this.#config;
    const accountId = (
      this.#store.database.prepare('SELECT account_id FROM ingest WHERE event_id = ?').get(input.eventId) as
        | { account_id: string }
        | undefined
    )?.account_id;
    const kept = await this.#projections.insert({
      eventId: input.eventId,
      rule,
      event: input.event,
      stagedAt: input.stagedAt,
      stageId: input.stageId,
      whatsapp: input.whatsapp,
      // D9: a source commit loads the live registry; a removal during the encryption refuses (the scan purges).
      accountLive:
        config === undefined || accountId === undefined
          ? undefined
          : () => assertLiveEventAccount(config, { source: rule.source.channel, accountId }),
    });
    // Purged while it was being encrypted: there is nothing left to decide for this rule version.
    if (!kept) return 'terminal';
    return this.evaluate({ eventId: input.eventId, ruleId: input.ruleId, ruleVersion: input.ruleVersion });
  }

  /** Adapter for the Gmail worker: its durable source stage, not a caller clock, owns the projection deadline. */
  async admitGmailOccurrence(input: {
    readonly event: Record<string, unknown>;
    readonly eventId: string;
    readonly stageId: string;
    readonly rule: { readonly ruleId: string; readonly ruleVersion: number };
  }): Promise<'terminal' | 'pending'> {
    const stage = this.#store.database
      .prepare('SELECT staged_at FROM source_scan_state WHERE id = ?')
      .get(input.stageId) as { staged_at: number | null } | undefined;
    if (stage?.staged_at === null || stage?.staged_at === undefined) {
      throw new CommsError('BAD_DATA', 'a Gmail projection cannot outlive its durable source stage');
    }
    return this.admit({
      event: input.event,
      eventId: input.eventId,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.ruleVersion,
      stagedAt: stage.staged_at,
      stageId: input.stageId,
    });
  }

  async evaluate(input: {
    readonly eventId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
  }): Promise<'terminal' | 'pending'> {
    return this.#withWriterLease(() => this.#evaluate(input));
  }

  async #evaluate(input: {
    readonly eventId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
  }): Promise<'terminal' | 'pending'> {
    const row = this.#projections.row(input.eventId, input.ruleId, input.ruleVersion);
    if (row === null) return 'terminal';
    const rule = ruleFor(this.#store, input.ruleId, input.ruleVersion);
    const ingest = this.#store.database
      .prepare('SELECT account_id FROM ingest WHERE event_id = ?')
      .get(input.eventId) as { account_id: string } | undefined;
    if (!ingest) throw new CommsError('BAD_DATA', 'an encrypted projection has no immutable ingest identity');

    // A projection past its decision deadline is settled content-free, without decryption and without the fence: no
    // authority is needed to stop retaining content, and waiting for one would hold the mailbox cursor indefinitely.
    // E's only retained-continuation path is an agentic hold, so it must use the same SQLite clock as its final hold
    // transaction. Deterministic D decisions retain their established injected-clock semantics.
    const dbNow = this.#store.immediate(() => sqliteTransactionNow(this.#store.database));
    const expiryNow = rule.agentic === undefined ? this.#now() : dbNow;
    // A chained workflow (W34) waits for a run about this message to raise what starts it: its decision replaces the
    // waiting one, and a wait that ran out ends `not-chained`.
    const on = rule.flow?.on;
    const chain = on === undefined ? undefined : { at: expiryNow };
    if (expiryNow >= row.decisionDeadline) {
      return this.#commit(() =>
        commitDecisionOutbox(
          this.#store,
          {
            id: this.#newId(),
            eventId: input.eventId,
            accountId: ingest.account_id,
            ruleId: input.ruleId,
            ruleVersion: input.ruleVersion,
            outcome: on === undefined ? 'retention-expired' : 'not-chained',
            metadataExpiresAt: fixedDeadline(expiryNow, rule.retention.decisionMetadataMs),
            switchGeneration: this.#switchGeneration(),
            deliveries: [],
            ...(chain === undefined ? {} : { chain }),
          },
          this.#failpoint,
        ),
      );
    }

    // The fence is intentionally before projection decryption, mapping and every persistent outbox mutation.
    let authorised: DisclosureSnapshot | undefined;
    // Each bound target, or — a workflow whose flow delivers to none — the version and account alone (0.36 W1).
    const bounds: readonly { readonly targetId?: string; readonly targetVersion?: number }[] =
      rule.targets.length > 0
        ? rule.targets.map((target) => ({ targetId: target.targetId, targetVersion: target.version }))
        : [{}];
    try {
      for (const bound of bounds) {
        const snapshot = await this.#fence({
          database: this.#store.database,
          accountId: ingest.account_id,
          boundary: 'evaluation',
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          switchGeneration: this.#switchGeneration(),
          ...bound,
        });
        if (authorised !== undefined && authorised.switchGeneration !== snapshot.switchGeneration) {
          throw new CommsError('APPROVAL_VOID', 'the disclosure fence changed generations during target evaluation');
        }
        authorised = snapshot;
      }
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            { source: rule.source.channel, accountId: ingest.account_id },
            this.#now(),
          ),
        );
        return 'terminal';
      }
      if (error instanceof CommsError) return 'pending';
      throw error;
    }
    // A chained workflow decides nothing until its chain request comes (§9.3). Until then it keeps the projection under
    // an `awaiting-chain` decision, content-free, so the source moves on: a waiting message holds back no later one.
    let started: ChainStart | undefined;
    if (on !== undefined) {
      const request = chainRequestFor(this.#store.database, input.eventId, input.ruleId, input.ruleVersion);
      if (request === undefined) {
        if (isAwaitingChain(this.#store.database, input.eventId, input.ruleId, input.ruleVersion)) return 'terminal';
        const now = this.#now();
        return this.#commit(() =>
          commitDecisionOutbox(
            this.#store,
            {
              id: this.#newId(),
              eventId: input.eventId,
              accountId: ingest.account_id,
              ruleId: input.ruleId,
              ruleVersion: input.ruleVersion,
              outcome: 'awaiting-chain',
              metadataExpiresAt: fixedDeadline(now, rule.retention.decisionMetadataMs),
              switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
              ...(row.whatsappMessageId === null || row.whatsappVisibilityVersion === null
                ? {}
                : {
                    whatsapp: { messageId: row.whatsappMessageId, visibilityVersion: row.whatsappVisibilityVersion },
                  }),
              deliveries: [],
              retainProjection: true,
              chain: { at: now, until: Math.min(fixedDeadline(now, on.withinMs), row.decisionDeadline) },
            },
            this.#failpoint,
          ),
        );
      }
      // The raised event's closed data, opened for the run's `/trigger`. Gone — its event expired or was cancelled —
      // the chain has nothing to start from, and the wait ends.
      const start = await chainStartFor(this.#store.database, this.#cipher, request);
      if (start === null) {
        const now = this.#now();
        return this.#commit(() =>
          commitDecisionOutbox(
            this.#store,
            {
              id: this.#newId(),
              eventId: input.eventId,
              accountId: ingest.account_id,
              ruleId: input.ruleId,
              ruleVersion: input.ruleVersion,
              outcome: 'not-chained',
              metadataExpiresAt: fixedDeadline(now, rule.retention.decisionMetadataMs),
              switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
              deliveries: [],
              chain: { at: now },
            },
            this.#failpoint,
          ),
        );
      }
      started = start;
    }
    const projection = await this.#projections.read(row);
    const now = this.#now();
    // This is intentionally before input-envelope construction, provenance, taint, reservation and all network I/O.
    if (!matchesRuleCondition(rule, projection.event)) {
      return this.#commit(() =>
        commitDecisionOutbox(this.#store, {
          id: this.#newId(),
          eventId: input.eventId,
          accountId: ingest.account_id,
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          outcome: 'no-match',
          metadataExpiresAt: fixedDeadline(now, rule.retention.decisionMetadataMs),
          switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
          ...(chain === undefined ? {} : { chain: { at: now } }),
          ...(row.whatsappMessageId === null || row.whatsappVisibilityVersion === null
            ? {}
            : { whatsapp: { messageId: row.whatsappMessageId, visibilityVersion: row.whatsappVisibilityVersion } }),
          ...(authorised === undefined
            ? {}
            : {
                disclosure: {
                  approvalId: authorised.approvalId,
                  authorizationActivationId: authorised.authorizationActivationId,
                },
              }),
          deliveries: [],
        }),
      );
    }

    if (rule.agentic !== undefined) {
      const judged = await this.#judgeCoordinator.evaluate({
        eventId: input.eventId,
        accountId: ingest.account_id,
        rule,
        ruleId: input.ruleId,
        ruleVersion: input.ruleVersion,
        event: projection.event,
        switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
      });
      if (judged.kind === 'deferred' || judged.kind === 'owner-held') return 'pending';
      // The shared Task-5 unknown-I/O closure owns its one terminal decision and projection purge.  Other closed
      // failures (notably no budget before I/O) are completed content-free here without a second reservation path.
      if (judged.kind === 'closed') {
        const terminal = this.#store.database
          .prepare(
            "SELECT 1 AS present FROM decisions WHERE event_id = ? AND rule_id = ? AND rule_version = ? AND outcome != 'awaiting-chain'",
          )
          .get(input.eventId, input.ruleId, input.ruleVersion);
        if (terminal !== undefined) return 'terminal';
        return this.#commit(() =>
          commitDecisionOutbox(this.#store, {
            id: this.#newId(),
            eventId: input.eventId,
            accountId: ingest.account_id,
            ruleId: input.ruleId,
            ruleVersion: input.ruleVersion,
            outcome: 'no-match',
            metadataExpiresAt: fixedDeadline(this.#now(), rule.retention.decisionMetadataMs),
            switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
            ...(chain === undefined ? {} : { chain: { at: this.#now() } }),
            ...(row.whatsappMessageId === null || row.whatsappVisibilityVersion === null
              ? {}
              : { whatsapp: { messageId: row.whatsappMessageId, visibilityVersion: row.whatsappVisibilityVersion } }),
            ...(authorised === undefined
              ? {}
              : {
                  disclosure: {
                    approvalId: authorised.approvalId,
                    authorizationActivationId: authorised.authorizationActivationId,
                  },
                }),
            deliveries: [],
          }),
        );
      }
      if (judged.kind === 'completed') {
        let committed = false;
        try {
          const decisionId = this.#newId();
          const result = judged.outcome === 'matched' ? evaluateRuleProjection(rule, projection.event) : null;
          const evaluated = result === null || 'rejected' in result ? null : result;
          const outcome =
            judged.outcome === 'hold'
              ? 'hold'
              : result === null
                ? 'no-match'
                : 'rejected' in result
                  ? 'mapping-rejected'
                  : 'matched';
          const deliveries =
            evaluated === null
              ? []
              : await prepareDeliveries({
                  cipher: this.#cipher,
                  definition: evaluated.definition,
                  event: projection.event,
                  rule,
                  classification: evaluated.classification,
                  installationId: this.#store.installationId,
                  createdAt: this.#now(),
                  newId: this.#newId,
                  data: evaluated.mapped.data,
                });
          // A match of a workflow with a flow is a run, its mapped values sealed here, outside the transaction, as a
          // delivery's are (workflows design §5, W7).
          const run =
            evaluated === null || outcome !== 'matched'
              ? undefined
              : await prepareFlowRun({
                  cipher: this.#cipher,
                  rule,
                  data: evaluated.mapped.data,
                  createdAt: this.#now(),
                  matched: {
                    definition: evaluated.definition,
                    event: projection.event,
                    classification: evaluated.classification,
                  },
                  message: runMessageOf(rule, projection.event),
                  ...(started === undefined ? {} : started),
                });
          // The judge-input taint was flushed before its transport.  A derived delivery can disclose additional
          // mapped fields, so record its exact mapping provenance before the atomic outbox write too.
          if (evaluated !== null)
            await this.#taint.record({
              eventId: input.eventId,
              accountId: ingest.account_id,
              channel: rule.source.channel,
              classification: evaluated.classification,
            });
          const encryptedMetadata = await this.#cipher.encrypt(
            { table: 'decisions', column: 'encryptedRecord', key: [{ type: 'text', value: decisionId }] },
            Buffer.from(JSON.stringify(judged.metadata)),
          );
          // Analyse (0.33.0 §3.3) counts the judge's answers per sending domain: the domain, never the address, is kept
          // on its own, encrypted, until the projection's own deadline — the rule's content retention — and no longer
          // (security review of 0.33.0, finding 9).
          const senderDomain = senderDomainOf(rule.event.type, rule.event.version, projection.event);
          const sealedDomain =
            senderDomain === null
              ? null
              : await this.#cipher.encrypt(senderDomainLocation(decisionId), Buffer.from(senderDomain));
          if (!(await this.#accountStillLive(rule.source.channel, ingest.account_id))) return 'terminal';
          const terminal = this.#commit(() => {
            commitDecisionOutbox(
              this.#store,
              {
                id: decisionId,
                eventId: input.eventId,
                accountId: ingest.account_id,
                ruleId: input.ruleId,
                ruleVersion: input.ruleVersion,
                outcome,
                metadataExpiresAt: fixedDeadline(this.#now(), rule.retention.decisionMetadataMs),
                switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
                ...(row.whatsappMessageId === null || row.whatsappVisibilityVersion === null
                  ? {}
                  : {
                      whatsapp: {
                        messageId: row.whatsappMessageId,
                        visibilityVersion: row.whatsappVisibilityVersion,
                      },
                    }),
                deliveries,
                ...(run === undefined ? {} : { run }),
                ...(chain === undefined ? {} : { chain: { at: this.#now() } }),
                settlement: {
                  reservationId: judged.reservationId,
                  actualInputTokens: judged.actualInputTokens,
                  settledAt: this.#now(),
                },
                ...(authorised === undefined
                  ? {}
                  : {
                      disclosure: {
                        approvalId: authorised.approvalId,
                        authorizationActivationId: authorised.authorizationActivationId,
                      },
                    }),
                encryptedMetadata,
                ...(outcome === 'hold'
                  ? {
                      retainProjection: true,
                      hold: { holdMs: rule.retention.holdMs, ingestMs: rule.retention.ingestMs },
                    }
                  : {}),
              },
              this.#failpoint,
            );
            committed = true;
            if (sealedDomain !== null)
              keepSenderDomain(this.#store.database, {
                decisionId,
                ruleId: input.ruleId,
                ruleVersion: input.ruleVersion,
                expiresAt: row.decisionDeadline,
                sealed: sealedDomain,
              });
          });
          return terminal;
        } finally {
          if (!committed)
            recoverJudgeReservation({ store: this.#store, reservationId: judged.reservationId, now: this.#now() });
        }
      }
    }
    const result = evaluateRuleProjection(rule, projection.event);
    const evaluated = result === null || 'rejected' in result ? null : result;
    const outcome = result === null ? 'no-match' : 'rejected' in result ? 'mapping-rejected' : 'matched';
    const decisionId = this.#newId();
    const deliveries =
      evaluated === null
        ? []
        : await prepareDeliveries({
            cipher: this.#cipher,
            definition: evaluated.definition,
            event: projection.event,
            rule,
            classification: evaluated.classification,
            installationId: this.#store.installationId,
            createdAt: now,
            newId: this.#newId,
            data: evaluated.mapped.data,
          });
    // A match of a workflow with a flow is a run, its mapped values sealed outside the transaction (0.36 §5, W7).
    const run =
      evaluated === null
        ? undefined
        : await prepareFlowRun({
            cipher: this.#cipher,
            rule,
            data: evaluated.mapped.data,
            createdAt: now,
            matched: {
              definition: evaluated.definition,
              event: projection.event,
              classification: evaluated.classification,
            },
            message: runMessageOf(rule, projection.event),
            ...(started === undefined ? {} : started),
          });
    // Taint is part of the disclosure boundary. A failed flush retains the projection and creates no outbox row.
    if (evaluated !== null)
      await this.#taint.record({
        eventId: input.eventId,
        accountId: ingest.account_id,
        channel: rule.source.channel,
        classification: evaluated.classification,
      });
    // D9: the account is read again immediately before the commit; one removed during the decryption, encryption or
    // taint flush is purged here, and its decision and deliveries are never written.
    if (this.#config !== undefined) {
      try {
        await assertLiveEventAccount(this.#config, { source: rule.source.channel, accountId: ingest.account_id });
      } catch (error) {
        if (!isRemovedAccountError(error)) throw error;
        this.#store.immediate(() =>
          purgeRemovedAccountWork(
            this.#store.database,
            { source: rule.source.channel, accountId: ingest.account_id },
            this.#now(),
          ),
        );
        return 'terminal';
      }
    }
    return this.#commit(() =>
      commitDecisionOutbox(
        this.#store,
        {
          id: decisionId,
          eventId: input.eventId,
          accountId: ingest.account_id,
          ruleId: input.ruleId,
          ruleVersion: input.ruleVersion,
          outcome,
          metadataExpiresAt: fixedDeadline(now, rule.retention.decisionMetadataMs),
          switchGeneration: authorised?.switchGeneration ?? this.#switchGeneration(),
          ...(row.whatsappMessageId === null || row.whatsappVisibilityVersion === null
            ? {}
            : { whatsapp: { messageId: row.whatsappMessageId, visibilityVersion: row.whatsappVisibilityVersion } }),
          ...(authorised === undefined
            ? {}
            : {
                disclosure: {
                  approvalId: authorised.approvalId,
                  authorizationActivationId: authorised.authorizationActivationId,
                },
              }),
          deliveries,
          ...(run === undefined ? {} : { run }),
          ...(chain === undefined ? {} : { chain: { at: now } }),
        },
        this.#failpoint,
      ),
    );
  }

  /**
   * A commit refused as stale leaves nothing behind: purged work is terminal (there is nothing left to decide), and a
   * moved switch leaves the retained projection for the next evaluation under the new generation, if any.
   */
  #commit(work: () => void): 'terminal' | 'pending' {
    try {
      work();
      return 'terminal';
    } catch (error) {
      if (!(error instanceof StaleDecisionError)) throw error;
      return error.details?.reason === 'PROJECTION_GONE' ? 'terminal' : 'pending';
    }
  }

  #switchGeneration(): number {
    const settings = this.#store.database
      .prepare('SELECT switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { switch_generation: number } | undefined;
    if (!settings) throw new CommsError('CONFIG', 'the local event switch is unavailable');
    return settings.switch_generation;
  }

  async #accountStillLive(source: CanonicalFullRuleDocument['source']['channel'], accountId: string): Promise<boolean> {
    if (this.#config === undefined) return true;
    try {
      await assertLiveEventAccount(this.#config, { source, accountId });
      return true;
    } catch (error) {
      if (!isRemovedAccountError(error)) throw error;
      this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, { source, accountId }, this.#now()));
      return false;
    }
  }

  #withWriterLease<T>(work: () => Promise<T>): Promise<T> {
    return this.#writerQuiescer === undefined ? work() : withEventWriterLease(this.#writerQuiescer, work);
  }
}
