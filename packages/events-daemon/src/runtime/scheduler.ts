import { type ApprovalStore, CommsError, type ConfigStore, type TaintStore } from '@agentcomms/core';
import { conditionPointers } from '@agentcomms/events';
import type { GmailEventSource } from '@agentcomms/gmail';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { GmailReplacementDrains } from '../runtime/replacements.ts';
import { isMailboxFenced } from '../sources/mailbox-fence.ts';
import type { MailboxLock } from '../sources/mailbox-lock.ts';
import { GmailMaterialiser } from '../sources/materialise.ts';
import { type GmailSourceRule, GmailSourceWorker } from '../sources/source-worker.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { assertLiveGmailAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { ActivationRuntime } from './activations.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatcher } from './dispatcher.ts';
import { EventEvaluator } from './evaluate.ts';
import type { EventExpiry } from './expiry.ts';
import type { EventLifecycle } from './lifecycle.ts';
import { recoverDeliveryLeases } from './recovery.ts';
import { recordEventTaint } from './untrusted.ts';

const DEFAULT_TICK_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_DELIVERY_BATCH = 100;

interface StoredRule {
  readonly document: string;
}

interface AccountBinding {
  readonly accountId: string;
  readonly name: string;
}

export interface EventSchedulerOptions {
  readonly store: EventDatabase;
  readonly lifecycle: EventLifecycle;
  readonly activations: ActivationRuntime;
  readonly dispatcher: DeliveryDispatcher;
  readonly expiry: EventExpiry;
  readonly cipher: EventRecordCipher;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly taint: TaintStore;
  readonly gmailSourceFor: (accountId: string) => Promise<GmailEventSource>;
  readonly mailboxLock: MailboxLock;
  readonly tickMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
  readonly deliveryBatchSize?: number | undefined;
  readonly now?: (() => number) | undefined;
}

/** The one owner loop: content expiry always runs; provider and target work runs only under an enabled, unpaused switch. */
export class EventScheduler {
  readonly #store: EventDatabase;
  readonly #lifecycle: EventLifecycle;
  readonly #activations: ActivationRuntime;
  readonly #dispatcher: DeliveryDispatcher;
  readonly #expiry: EventExpiry;
  readonly #cipher: EventRecordCipher;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #taint: TaintStore;
  readonly #gmailSourceFor: EventSchedulerOptions['gmailSourceFor'];
  readonly #mailboxLock: MailboxLock;
  readonly #tickMs: number;
  readonly #pollIntervalMs: number;
  readonly #deliveryBatchSize: number;
  readonly #now: () => number;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;

  constructor(options: EventSchedulerOptions) {
    this.#store = options.store;
    this.#lifecycle = options.lifecycle;
    this.#activations = options.activations;
    this.#dispatcher = options.dispatcher;
    this.#expiry = options.expiry;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#taint = options.taint;
    this.#gmailSourceFor = options.gmailSourceFor;
    this.#mailboxLock = options.mailboxLock;
    this.#tickMs = positiveInterval(options.tickMs ?? DEFAULT_TICK_MS, 'tick interval');
    this.#pollIntervalMs = positiveInterval(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 'poll interval');
    this.#deliveryBatchSize = positiveInterval(
      options.deliveryBatchSize ?? DEFAULT_DELIVERY_BATCH,
      'delivery batch size',
    );
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#tickMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  /** Test and embedding seam: runs one complete serial tick and waits for its account-isolated work. */
  async tick(): Promise<void> {
    if (this.#running !== undefined) return this.#running;
    const work = this.#tick().finally(() => {
      if (this.#running === work) this.#running = undefined;
    });
    this.#running = work;
    return work;
  }

  async #tick(): Promise<void> {
    this.#expiry.sweep();
    await this.#purgeConfiguredAwayAccounts();
    try {
      await this.#activations.resumeClaimedCompletions();
    } catch (error) {
      // An incomplete drain is deliberately retried by the next tick. Other failures remain content-free health.
      if (!(error instanceof CommsError && error.details?.reason === 'REPLACEMENT_DRAINING'))
        this.#recordFailure('activation', 'owner');
    }

    const status = this.#lifecycle.status();
    if (!status.enabled || status.paused) return;

    for (const account of await this.#boundLiveAccounts()) {
      try {
        if (!this.#due(account.accountId)) continue;
        await this.#poll(account);
      } catch (error) {
        if (isRemovedAccountError(error)) {
          this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, account.accountId, this.#now()));
          continue;
        }
        this.#recordFailure('gmail', account.accountId);
      }
    }

    try {
      await recoverDeliveryLeases(this.#dispatcher);
      const ids = this.#store.database
        .prepare(
          "SELECT id FROM deliveries WHERE state IN ('queued', 'retryable') AND (next_at IS NULL OR next_at <= ?) ORDER BY id LIMIT ?",
        )
        .all(this.#now(), this.#deliveryBatchSize) as Array<{ id: string }>;
      for (const { id } of ids) {
        try {
          await this.#dispatcher.dispatch(id);
        } catch (error) {
          if (isRemovedAccountError(error)) continue;
          this.#recordFailure('dispatch', id);
        }
      }
    } catch (error) {
      this.#recordFailure('dispatch', error instanceof CommsError ? error.code : 'owner');
    }
  }

  async #poll(account: AccountBinding): Promise<void> {
    const rules = () => this.#rulesForAccount(account.accountId);
    const bound = rules();
    if (bound.length === 0) return;
    // The initial cursor is installed under the mailbox lock and never while a claimed activation's unpublished P
    // fences the mailbox: installing it from the points already published could start past that P.
    await this.#mailboxLock.withMailbox(account.accountId, async () => {
      if (isMailboxFenced(this.#store.database, account.accountId)) return;
      await this.#installInitialCursor(account.accountId);
    });
    const source = await this.#gmailSourceFor(account.accountId);
    const evaluator = new EventEvaluator({
      store: this.#store,
      cipher: this.#cipher,
      approvals: this.#approvals,
      config: this.#config,
      taint: {
        record: async (input) => {
          const config = await this.#config.load();
          const inbox = Object.values(config.inboxes).find((candidate) => candidate.id === input.accountId);
          await recordEventTaint(
            this.#taint,
            { ownAddresses: inbox?.email ? [inbox.email] : [], internalDomains: inbox?.internalDomains ?? [] },
            input,
          );
        },
      },
    });
    const fence = async (rule: GmailSourceRule): Promise<void> => {
      await assertDisclosable({
        database: this.#store.database,
        approvals: this.#approvals,
        config: this.#config,
        accountId: account.accountId,
        boundary: 'source',
        ruleId: rule.ruleId,
        ruleVersion: rule.ruleVersion,
        switchGeneration: this.#lifecycle.status().switchGeneration,
      });
    };
    // The materialiser writes inside the worker's scan, so it checks the same scan snapshot (set once both exist).
    let scanning: GmailSourceWorker | undefined;
    const materialiser = new GmailMaterialiser({
      store: this.#store,
      accountId: account.accountId,
      guard: () => scanning?.assertScanLive(),
      accountLive: () => assertLiveGmailAccount(this.#config, account.accountId),
      source,
      assertDisclosable: async () => undefined,
      encryptState: (value, stateId) =>
        this.#cipher.encrypt(sourceStateLocation(requiredStateId(stateId)), Buffer.from(JSON.stringify(value))),
      decryptState: async (stored, stateId) =>
        JSON.parse(
          (await this.#cipher.decrypt(sourceStateLocation(requiredStateId(stateId)), stored)).toString('utf8'),
        ),
    });
    const drains = new GmailReplacementDrains({
      database: this.#store.database,
      decryptPosition: async (input) =>
        JSON.parse(
          (
            await this.#cipher.decrypt(
              input.table === 'activation_baselines'
                ? baselineLocation(input.activationId, input.accountId, input.positionScope)
                : pointLocation(
                    input.activationId,
                    input.ruleId as string,
                    input.ruleVersion as number,
                    input.accountId,
                    input.positionScope,
                  ),
              input.record,
            )
          ).toString('utf8'),
        ),
    });
    const worker = new GmailSourceWorker({
      store: this.#store,
      source,
      mailbox: account,
      mailboxLock: this.#mailboxLock,
      rules,
      assertDisclosable: fence,
      admit: (occurrence) => evaluator.admitGmailOccurrence(occurrence),
      encryptStage: (value, stageId) =>
        this.#cipher.encrypt(sourceStateLocation(requiredStateId(stageId)), Buffer.from(JSON.stringify(value))),
      decryptStage: async (stored, stageId) =>
        JSON.parse(
          (await this.#cipher.decrypt(sourceStateLocation(requiredStateId(stageId)), stored)).toString('utf8'),
        ),
      replacementDrains: drains,
      accountLive: () => assertLiveGmailAccount(this.#config, account.accountId),
      materialise: async (requests) => {
        for (const request of requests) {
          const rule = rules().find(
            (candidate) => candidate.ruleId === request.ruleId && candidate.ruleVersion === request.ruleVersion,
          );
          if (!rule) throw new CommsError('APPROVAL_VOID', 'a lazy Gmail projection no longer has its exact rule');
          await fence(rule);
        }
        return materialiser.materialiseAll(requests);
      },
    });
    scanning = worker;
    await worker.scan();
  }

  #due(accountId: string): boolean {
    const row = this.#store.database
      .prepare("SELECT updated_at FROM cursors WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'")
      .get(accountId) as { updated_at: number } | undefined;
    return row === undefined || row.updated_at + this.#pollIntervalMs <= this.#now();
  }

  /** The published cut-over points of the versions that poll this account now, in a stable order. */
  #publishedPoints(accountId: string): Array<{
    activation_id: string;
    rule_id: string;
    rule_version: number;
    account_id: string;
    position_scope: 'mailbox';
    encrypted_position: Uint8Array;
  }> {
    const rules = this.#rulesForAccount(accountId);
    return (
      this.#store.database
        .prepare(
          `SELECT points.activation_id, points.rule_id, points.rule_version, points.account_id, points.position_scope,
                  points.encrypted_position
           FROM rule_activation_points AS points
           JOIN active_versions AS active
             ON active.kind = 'rule' AND active.object_id = points.rule_id AND active.version = points.rule_version
            AND active.current_cutover_id = points.activation_id
           WHERE points.source = 'gmail' AND points.account_id = ? AND points.position_scope = 'mailbox'
           ORDER BY points.rule_id, points.rule_version, points.activation_id`,
        )
        .all(accountId) as Array<{
        activation_id: string;
        rule_id: string;
        rule_version: number;
        account_id: string;
        position_scope: 'mailbox';
        encrypted_position: Uint8Array;
      }>
    ).filter((point) => rules.some((rule) => rule.ruleId === point.rule_id && rule.ruleVersion === point.rule_version));
  }

  async #installInitialCursor(accountId: string): Promise<void> {
    const exists = this.#store.database
      .prepare(
        "SELECT 1 AS present FROM cursors WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'",
      )
      .get(accountId);
    if (exists !== undefined) return;
    // The mailbox cursor starts at the OLDEST active cut-over point for the account: each rule then admits only what
    // follows its own point, so a rule activated earlier never loses the occurrences between its point and a later
    // rule's, and a later rule is never backfilled.
    const points = this.#publishedPoints(accountId);
    const keyOf = (rows: ReadonlyArray<{ activation_id: string; rule_id: string; rule_version: number }>) =>
      rows.map((row) => `${row.activation_id}:${row.rule_id}@${row.rule_version}`).join(',');
    const read = keyOf(points);
    let historyId: string | undefined;
    for (const point of points) {
      const position = JSON.parse(
        (
          await this.#cipher.decrypt(
            pointLocation(
              point.activation_id,
              point.rule_id,
              point.rule_version,
              point.account_id,
              point.position_scope,
            ),
            point.encrypted_position,
          )
        ).toString('utf8'),
      ) as { historyId?: unknown };
      if (typeof position.historyId !== 'string' || !/^[0-9]+$/u.test(position.historyId))
        throw new CommsError('BAD_DATA', 'an active Gmail point has no history id');
      if (historyId === undefined || BigInt(position.historyId) < BigInt(historyId)) historyId = position.historyId;
    }
    if (historyId === undefined) return;
    await assertLiveGmailAccount(this.#config, accountId);
    this.#store.immediate(() => {
      // The decryption awaited, and finalisation does not take the mailbox lock: a point published meanwhile (perhaps
      // lower than every point read) or a new fence means this minimum is stale. Install nothing; the next tick
      // recomputes it from the points published then.
      if (isMailboxFenced(this.#store.database, accountId) || keyOf(this.#publishedPoints(accountId)) !== read) return;
      const insert = this.#store.database.prepare(
        `INSERT OR IGNORE INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
           VALUES ('gmail', ?, 'mailbox', ?, ?)`,
      ) as unknown as { run(...values: [string, string, number]): unknown };
      insert.run(accountId, historyId as string, this.#now() - this.#pollIntervalMs);
    });
  }

  async #boundLiveAccounts(): Promise<readonly AccountBinding[]> {
    const config = await this.#config.load();
    const aliases = new Map(
      Object.entries(config.inboxes)
        .filter(([, inbox]) => inbox.provider === 'gmail')
        .map(([alias, inbox]) => [inbox.id, alias] as const),
    );
    return [...this.#accountsWithBindings()]
      .filter((accountId) => aliases.has(accountId))
      .sort()
      .map((accountId) => ({ accountId, name: aliases.get(accountId) as string }));
  }

  #accountsWithBindings(): Set<string> {
    const accounts = new Set<string>();
    for (const row of this.#store.database
      .prepare(
        `SELECT rule_versions.document
         FROM active_versions JOIN rule_versions
           ON rule_versions.rule_id = active_versions.object_id AND rule_versions.version = active_versions.version
         WHERE active_versions.kind = 'rule'
         UNION ALL
         SELECT rule_versions.document
         FROM replacement_drains JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
         JOIN rule_versions ON rule_versions.id = activation_intents.replacement_of_version
         WHERE replacement_drains.drained_at IS NULL AND activation_intents.status = 'pending-completion'`,
      )
      .all() as unknown as StoredRule[]) {
      for (const accountId of ruleFromRow(row).source.accountIds) accounts.add(accountId);
    }
    return accounts;
  }

  #rulesForAccount(accountId: string): readonly GmailSourceRule[] {
    // K6: an active version polls an account only where it holds a cut-over point there. One whose point a removal
    // purged is dark for that account — even after the same id is added back — until an approved activation (a
    // replacement or enable-all) takes a fresh point (D9: it "can no longer poll, judge or disclose the missing one").
    const rows = this.#store.database
      .prepare(
        `SELECT rule_versions.document
         FROM active_versions JOIN rule_versions
           ON rule_versions.rule_id = active_versions.object_id AND rule_versions.version = active_versions.version
         WHERE active_versions.kind = 'rule'
           AND EXISTS (
             SELECT 1 FROM rule_activation_points
             WHERE rule_activation_points.activation_id = active_versions.current_cutover_id
               AND rule_activation_points.rule_id = active_versions.object_id
               AND rule_activation_points.rule_version = active_versions.version
               AND rule_activation_points.account_id = ?
               AND rule_activation_points.position_scope = 'mailbox'
           )
         UNION ALL
         SELECT rule_versions.document
         FROM replacement_drains JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
         JOIN rule_versions ON rule_versions.id = activation_intents.replacement_of_version
         WHERE replacement_drains.account_id = ? AND replacement_drains.drained_at IS NULL
           AND activation_intents.status = 'pending-completion'`,
      )
      .all(accountId, accountId) as unknown as StoredRule[];
    const rules = new Map<string, GmailSourceRule>();
    for (const row of rows) {
      const rule = ruleFromRow(row);
      if (!rule.source.accountIds.includes(accountId)) continue;
      rules.set(`${rule.ruleId}@${rule.version}`, {
        ruleId: rule.ruleId,
        ruleVersion: rule.version,
        eventType: rule.event.type as GmailSourceRule['eventType'],
        options: rule.source.options,
        ingestRetentionMs: rule.retention.ingestMs,
        lazyFields: lazyFields(rule),
      });
    }
    return [...rules.values()];
  }

  async #purgeConfiguredAwayAccounts(): Promise<void> {
    const config = await this.#config.load();
    const live = new Set(
      Object.values(config.inboxes)
        .filter((inbox) => inbox.provider === 'gmail')
        .map((inbox) => inbox.id),
    );
    const rows = this.#store.database
      .prepare(
        `SELECT account_id FROM source_scan_state UNION SELECT account_id FROM cursors UNION SELECT account_id FROM ingest
         UNION SELECT account_id FROM deliveries UNION SELECT account_id FROM dryrun_log`,
      )
      .all() as Array<{ account_id: string }>;
    const accounts = new Set([...this.#accountsWithBindings(), ...rows.map((row) => row.account_id)]);
    for (const accountId of accounts) {
      if (live.has(accountId)) continue;
      this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, accountId, this.#now()));
    }
  }

  /** One content-free health row per failing kind and subject, refreshed in place: a lasting failure stays bounded. */
  #recordFailure(kind: string, subject: string): void {
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at`,
        )
        .run(`scheduler:${kind}:${subject}`, 'agentcomms.source.degraded', this.#now());
    });
  }
}

function positiveInterval(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new CommsError('CONFIG', `${name} is a positive integer`);
  return value;
}

function requiredStateId(value: string | undefined): string {
  if (!value) throw new CommsError('BAD_DATA', 'a durable Gmail source state has no id');
  return value;
}

function sourceStateLocation(id: string) {
  return { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function baselineLocation(intentId: string, accountId: string, positionScope: string) {
  return {
    table: 'activation_baselines',
    column: 'encryptedPosition',
    key: [
      { type: 'text' as const, value: intentId },
      { type: 'text' as const, value: 'gmail' },
      { type: 'text' as const, value: accountId },
      { type: 'text' as const, value: positionScope },
    ],
  };
}

function pointLocation(
  activationId: string,
  ruleId: string,
  ruleVersion: number,
  accountId: string,
  positionScope: string,
) {
  return {
    table: 'rule_activation_points',
    column: 'encryptedPosition',
    key: [
      { type: 'text' as const, value: activationId },
      { type: 'text' as const, value: ruleId },
      { type: 'integer' as const, value: ruleVersion },
      { type: 'text' as const, value: accountId },
      { type: 'text' as const, value: positionScope },
    ],
  };
}

function ruleFromRow(row: StoredRule): CanonicalFullRuleDocument {
  return JSON.parse(row.document) as CanonicalFullRuleDocument;
}

function lazyFields(rule: CanonicalFullRuleDocument): readonly string[] {
  const pointers = new Set(conditionPointers(rule.condition));
  collectMappingPointers(rule.mapping, pointers);
  return [...pointers].some((pointer) => pointer === '/body' || pointer.startsWith('/body/')) ? ['body'] : [];
}

function collectMappingPointers(value: unknown, into: Set<string>): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectMappingPointers(item, into);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.$path === 'string') into.add(record.$path);
  for (const child of Object.values(record)) collectMappingPointers(child, into);
}
