import { type ApprovalStore, CommsError, type ConfigStore, type TaintStore } from '@agentcomms/core';
import { conditionPointers } from '@agentcomms/events';
import type { GmailEventSource } from '@agentcomms/gmail';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { GmailReplacementDrains } from '../runtime/replacements.ts';
import { RoundRobinReadyScopes, type SourceScope } from '../sources/contracts.ts';
import type { MailboxLock } from '../sources/mailbox-lock.ts';
import { GmailMaterialiser } from '../sources/materialise.ts';
import { gmailOnlySourceRegistry, type LocalEventSourceRegistry } from '../sources/registry.ts';
import {
  initialCursorStillCurrent,
  isSourceScopeFenced,
  publishedSourcePointSet,
} from '../sources/source-scope-fence.ts';
import { type GmailSourceRule, GmailSourceWorker } from '../sources/source-worker.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventRecordCipher } from '../store/records.ts';
import {
  assertLiveEventAccount,
  isRemovedAccountError,
  liveEventAccountIds,
  purgeRemovedAccountWork,
} from './account-fence.ts';
import type { ActivationRuntime } from './activations.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatcher } from './dispatcher.ts';
import { EventEvaluator } from './evaluate.ts';
import type { EventExpiry } from './expiry.ts';
import type { EventLifecycle } from './lifecycle.ts';
import { requirePhaseDWhatsAppVisibilitySeam } from './phase-d-whatsapp-owner-composition.ts';
import { recoverDeliveryLeases } from './recovery.ts';
import { recordEventTaint } from './untrusted.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

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
  /** Owner-built, read-only source work. Gmail keeps its existing worker; every other source enters through this seam. */
  readonly sourceWorkFor?:
    | ((scope: SourceScope) => Promise<Readonly<{ retryAfterMs?: number | undefined }> | undefined>)
    | undefined;
  readonly mailboxLock: MailboxLock;
  readonly sourceRegistry?: LocalEventSourceRegistry | undefined;
  /** Constructed by the owner before any future WhatsApp source work is admitted. */
  readonly whatsappVisibilityFence?: WhatsAppVisibilityFence | undefined;
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
  readonly #sourceWorkFor: EventSchedulerOptions['sourceWorkFor'];
  readonly #mailboxLock: MailboxLock;
  readonly #sourceRegistry: LocalEventSourceRegistry;
  readonly #whatsappVisibilityFence: WhatsAppVisibilityFence | undefined;
  readonly #tickMs: number;
  readonly #pollIntervalMs: number;
  readonly #deliveryBatchSize: number;
  readonly #now: () => number;
  readonly #ready = new RoundRobinReadyScopes();
  #readyKey = '';
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
    this.#sourceWorkFor = options.sourceWorkFor;
    this.#mailboxLock = options.mailboxLock;
    this.#sourceRegistry = options.sourceRegistry ?? gmailOnlySourceRegistry();
    this.#whatsappVisibilityFence = requirePhaseDWhatsAppVisibilitySeam({
      hasWhatsAppSource: this.#sourceRegistry.sources().includes('whatsapp'),
      visibilityFence: options.whatsappVisibilityFence,
    });
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
    await this.#expiry.sweepAll();
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
          this.#store.immediate(() =>
            purgeRemovedAccountWork(
              this.#store.database,
              { source: 'gmail', accountId: account.accountId },
              this.#now(),
            ),
          );
          continue;
        }
        this.#recordFailure('gmail', account.accountId);
      }
    }

    await this.#pollNonGmailScopes();

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

  /** One fair ready-source turn per owner tick; a source cannot monopolise the loop with pages, drains, or retries. */
  async #pollNonGmailScopes(): Promise<void> {
    if (!this.#sourceWorkFor) return;
    // Rotate the complete bound set, then take the first eligible one. Replacing the wheel with only due scopes
    // would reset it after every successful poll (that poll moves its own next-eligible instant) and starve every
    // scope other than the lexical first one.
    const scopes = this.#boundSourceScopes().filter((scope) => scope.source !== 'gmail');
    const key = scopes.map((scope) => `${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`).join('\n');
    if (key !== this.#readyKey) {
      this.#ready.replace(scopes, this.#lastReadyScope());
      this.#readyKey = key;
    }
    let scope: SourceScope | undefined;
    for (let turn = 0; turn < scopes.length; turn += 1) {
      const candidate = this.#ready.next();
      if (candidate !== undefined && this.#dueScope(candidate)) {
        scope = candidate;
        break;
      }
    }
    if (!scope) return;
    try {
      await assertLiveEventAccount(this.#config, { source: scope.source, accountId: scope.accountId });
      if (isSourceScopeFenced(this.#store.database, scope)) return;
      const source = this.#sourceRegistry.require(scope.source);
      const result = await source.withScopes(this.#mailboxLock.sourceScopeLock, [scope], async () => {
        if (isSourceScopeFenced(this.#store.database, scope)) return { skipped: true as const };
        await assertLiveEventAccount(this.#config, { source: scope.source, accountId: scope.accountId });
        const cursorCurrent = await this.#installInitialSourceCursor(scope);
        if (!cursorCurrent) return { skipped: true as const };
        // The cursor decrypt and source baseline sampling happened before this transaction. One final fence check
        // makes the very first provider call fail closed when a claimed replacement appeared in that interval.
        if (isSourceScopeFenced(this.#store.database, scope)) return { skipped: true as const };
        return this.#sourceWorkFor?.(scope);
      });
      if (result !== undefined && 'skipped' in result && result.skipped) return;
      const retryAfterMs = result !== undefined && 'retryAfterMs' in result ? result.retryAfterMs : undefined;
      // `sourceWorkFor` may have awaited a provider and encryption. Re-read the core registry before persisting its
      // provider-result scheduling state so a removed account cannot be recreated by a stale successful response.
      await assertLiveEventAccount(this.#config, { source: scope.source, accountId: scope.accountId });
      this.#setSourceNextEligible(scope, Math.max(this.#pollIntervalMs, retryAfterMs ?? 0));
      this.#rememberReadyScope(scope);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, scope, this.#now()));
        return;
      }
      this.#setSourceNextEligible(scope, Math.max(this.#pollIntervalMs, retryAfterMs(error) ?? 0));
      this.#rememberReadyScope(scope);
      this.#recordFailure(scope.source, scope.accountId);
    }
  }

  /**
   * Every non-Gmail source starts from encrypted published points, never from a provider's current head.  The read
   * is deliberately outside the insert transaction; that transaction re-reads the canonical set and bails if an
   * activation/replacement changed it while crypto awaited.
   */
  async #installInitialSourceCursor(scope: SourceScope): Promise<boolean> {
    const exists = this.#store.database
      .prepare('SELECT 1 AS present FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
      .get(scope.source, scope.accountId, scope.scopeId);
    if (exists !== undefined) return true;
    const points = this.#publishedSourcePoints(scope);
    const canonical = publishedSourcePointSet(this.#store.database, scope);
    if (points.length === 0) return false;
    const positions = await Promise.all(
      points.map(
        async (point) =>
          JSON.parse(
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
          ) as unknown,
      ),
    );
    const cursor = initialCursorFor(scope, positions);
    await assertLiveEventAccount(this.#config, { source: scope.source, accountId: scope.accountId });
    return this.#store.immediate(() => {
      if (isSourceScopeFenced(this.#store.database, scope)) return false;
      if (!initialCursorStillCurrent(this.#store.database, scope, canonical)) return false;
      const current = this.#store.database
        .prepare('SELECT 1 AS present FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
        .get(scope.source, scope.accountId, scope.scopeId);
      if (current !== undefined) return true;
      const inserted = this.#store.database
        .prepare('INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(scope.source, scope.accountId, scope.scopeId, cursor, this.#now() - this.#pollIntervalMs);
      return Number(inserted.changes) === 1;
    });
  }

  #publishedSourcePoints(scope: SourceScope): Array<{
    activation_id: string;
    rule_id: string;
    rule_version: number;
    account_id: string;
    position_scope: string;
    encrypted_position: Uint8Array;
  }> {
    return this.#store.database
      .prepare(
        `SELECT points.activation_id, points.rule_id, points.rule_version, points.account_id, points.position_scope,
                points.encrypted_position
           FROM rule_activation_points AS points
           JOIN active_versions AS active
             ON active.kind = 'rule' AND active.object_id = points.rule_id AND active.version = points.rule_version
            AND active.current_cutover_id = points.activation_id
          WHERE points.source = ? AND points.account_id = ? AND points.position_scope = ?
          ORDER BY points.rule_id, points.rule_version, points.activation_id`,
      )
      .all(scope.source, scope.accountId, scope.scopeId) as Array<{
      activation_id: string;
      rule_id: string;
      rule_version: number;
      account_id: string;
      position_scope: string;
      encrypted_position: Uint8Array;
    }>;
  }

  #setSourceNextEligible(scope: SourceScope, delayMs: number): void {
    const nextAt = this.#now() + delayMs;
    this.#store.immediate(() => {
      const settings = this.#lifecycle.status();
      if (!settings.enabled || settings.paused) return;
      if (isSourceScopeFenced(this.#store.database, scope)) return;
      this.#store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES (?, ?, ?, '{}', ?)
           ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET updated_at = excluded.updated_at`,
        )
        .run(scope.source, scope.accountId, scope.scopeId, nextAt);
    });
  }

  #lastReadyScope(): string | undefined {
    const stored = (
      this.#store.database
        .prepare(
          "SELECT cursor FROM cursors WHERE source = 'scheduler' AND account_id = 'owner' AND cursor_scope = 'ready-scope'",
        )
        .get() as { cursor: string } | undefined
    )?.cursor;
    if (stored === undefined) return undefined;
    try {
      const value = JSON.parse(stored);
      if (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((part) => typeof part === 'string' && part.length > 0)
      )
        return `${value[0]}\u0000${value[1]}\u0000${value[2]}`;
    } catch {
      // A malformed scheduler marker must never select arbitrary work. Starting at the stable first scope is safe.
    }
    return undefined;
  }

  #rememberReadyScope(scope: SourceScope): void {
    // SQLite C-string bindings truncate NULs. Persist JSON and reconstruct the in-memory lock key when the owner
    // restarts; otherwise a stored `resend` marker would lose account/scope identity and reset fairness.
    const key = JSON.stringify([scope.source, scope.accountId, scope.scopeId]);
    this.#store.immediate(() => {
      this.#store.database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
           VALUES ('scheduler', 'owner', 'ready-scope', ?, ?)
           ON CONFLICT(source, account_id, cursor_scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(key, this.#now());
    });
  }

  async #poll(account: AccountBinding): Promise<void> {
    const gmail = this.#sourceRegistry.require('gmail');
    const rules = () => this.#rulesForAccount(account.accountId);
    const bound = rules();
    if (bound.length === 0) return;
    // The initial cursor is installed under the mailbox lock and never while a claimed activation's unpublished P
    // fences the mailbox: installing it from the points already published could start past that P.
    await gmail.withScopes(
      this.#mailboxLock.sourceScopeLock,
      [{ source: 'gmail', accountId: account.accountId, scopeId: 'mailbox' }],
      async () => {
        if (
          isSourceScopeFenced(this.#store.database, {
            source: 'gmail',
            accountId: account.accountId,
            scopeId: 'mailbox',
          })
        )
          return;
        await this.#installInitialCursor(account.accountId);
      },
    );
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
      accountLive: () => assertLiveEventAccount(this.#config, { source: 'gmail', accountId: account.accountId }),
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
      sourceAdapter: gmail,
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
      accountLive: () => assertLiveEventAccount(this.#config, { source: 'gmail', accountId: account.accountId }),
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
    const scope = { source: 'gmail' as const, accountId, scopeId: 'mailbox' };
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
    // Preserve the whole canonical set, not merely the rules that happened to be eligible before decryption. A
    // finalisation can publish another source point while ciphertext is being opened, and it must make this insert
    // stale even if a stale in-memory rule list would otherwise have filtered it away.
    const canonicalPoints = publishedSourcePointSet(this.#store.database, scope);
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
    await assertLiveEventAccount(this.#config, { source: 'gmail', accountId });
    this.#store.immediate(() => {
      // The decryption awaited, and finalisation does not take the mailbox lock: a point published meanwhile (perhaps
      // lower than every point read) or a new fence means this minimum is stale. Install nothing; the next tick
      // recomputes it from the points published then.
      if (
        !initialCursorStillCurrent(this.#store.database, scope, canonicalPoints) ||
        keyOf(this.#publishedPoints(accountId)) !== read
      )
        return;
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
    return this.#sourceAccountsWithBindings()
      .filter((binding) => binding.source === 'gmail' && aliases.has(binding.accountId))
      .map((binding) => binding.accountId)
      .sort()
      .map((accountId) => ({ accountId, name: aliases.get(accountId) as string }));
  }

  #sourceAccountsWithBindings(): readonly { source: 'gmail' | 'slack' | 'resend' | 'whatsapp'; accountId: string }[] {
    const accounts = new Map<string, { source: 'gmail' | 'slack' | 'resend' | 'whatsapp'; accountId: string }>();
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
      const source = ruleFromRow(row).source;
      for (const accountId of source.accountIds)
        accounts.set(`${source.channel}\u0000${accountId}`, { source: source.channel, accountId });
    }
    return [...accounts.values()];
  }

  /** Active scopes are derived from immutable canonical options each tick; reconnecting an id cannot invent a point. */
  #boundSourceScopes(): readonly SourceScope[] {
    const scopes = new Map<string, SourceScope>();
    for (const row of this.#store.database
      .prepare(
        `SELECT rule_versions.document
         FROM active_versions JOIN rule_versions
           ON rule_versions.rule_id = active_versions.object_id AND rule_versions.version = active_versions.version
         WHERE active_versions.kind = 'rule'`,
      )
      .all() as unknown as StoredRule[]) {
      const rule = ruleFromRow(row);
      const source = this.#sourceRegistry.require(rule.source.channel);
      const options = source.canonicalise(rule.source.options);
      for (const accountId of rule.source.accountIds) {
        for (const scope of source.scopesFor({ accountId, options })) {
          const point = this.#store.database
            .prepare(
              `SELECT 1 AS present FROM active_versions JOIN rule_activation_points
                 ON rule_activation_points.activation_id = active_versions.current_cutover_id
                AND rule_activation_points.rule_id = active_versions.object_id
                AND rule_activation_points.rule_version = active_versions.version
               WHERE active_versions.kind = 'rule' AND active_versions.object_id = ? AND active_versions.version = ?
                 AND rule_activation_points.source = ? AND rule_activation_points.account_id = ?
                 AND rule_activation_points.position_scope = ?`,
            )
            .get(rule.ruleId, rule.version, scope.source, scope.accountId, scope.scopeId);
          if (point === undefined) continue;
          scopes.set(`${scope.source}\u0000${scope.accountId}\u0000${scope.scopeId}`, scope);
        }
      }
    }
    return [...scopes.values()].sort((left, right) =>
      `${left.source}\u0000${left.accountId}\u0000${left.scopeId}`.localeCompare(
        `${right.source}\u0000${right.accountId}\u0000${right.scopeId}`,
      ),
    );
  }

  #dueScope(scope: SourceScope): boolean {
    const row = this.#store.database
      .prepare('SELECT updated_at FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
      .get(scope.source, scope.accountId, scope.scopeId) as { updated_at: number } | undefined;
    return row === undefined || row.updated_at <= this.#now();
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
      if (rule.source.channel !== 'gmail') continue;
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
    const registered = new Set(this.#sourceRegistry.sources());
    const rows = this.#store.database
      .prepare(`SELECT source, account_id FROM source_scan_state UNION SELECT source, account_id FROM cursors`)
      .all()
      .filter((row) => registered.has((row as { source: string }).source as SourceScope['source'])) as Array<{
      source: 'gmail' | 'slack' | 'resend' | 'whatsapp';
      account_id: string;
    }>;
    const accounts = new Map<string, { source: 'gmail' | 'slack' | 'resend' | 'whatsapp'; accountId: string }>();
    for (const account of [
      ...this.#sourceAccountsWithBindings(),
      ...rows.map(({ source, account_id }) => ({ source, accountId: account_id })),
    ])
      accounts.set(`${account.source}\u0000${account.accountId}`, account);
    for (const account of accounts.values()) {
      const live = await liveEventAccountIds(this.#config, account.source);
      if (live.has(account.accountId)) continue;
      this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, account, this.#now()));
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

function initialCursorFor(scope: SourceScope, positions: readonly unknown[]): string {
  if (scope.source === 'slack') {
    const timestamps = positions.map((position) => (position as { timestamp?: unknown }).timestamp);
    if (!timestamps.every((timestamp) => typeof timestamp === 'string' && /^[0-9]+\.[0-9]{6}$/u.test(timestamp)))
      throw new CommsError('BAD_DATA', 'an active Slack point has no exact conversation timestamp');
    return [...(timestamps as string[])].sort((left, right) => {
      const [leftSeconds, leftMicros] = left.split('.') as [string, string];
      const [rightSeconds, rightMicros] = right.split('.') as [string, string];
      const a = BigInt(leftSeconds);
      const b = BigInt(rightSeconds);
      return a === b ? leftMicros.localeCompare(rightMicros) : a < b ? -1 : 1;
    })[0] as string;
  }
  if (scope.source === 'resend') {
    if (scope.scopeId === 'received') {
      const anchors = positions.map((position) => (position as { anchorId?: unknown }).anchorId);
      if (!anchors.every((anchor) => typeof anchor === 'string' && anchor.length > 0))
        throw new CommsError('BAD_DATA', 'an active Resend received point has no anchor');
      // The source's own encrypted state preserves this anchor; the cursor is its durable, content-free initial
      // record used by the owner’s eligibility and restart recovery.
      return anchors[0] as string;
    }
    const starts = positions.map((position) => (position as { startedAt?: unknown }).startedAt);
    if (!starts.every((start) => typeof start === 'string' && Number.isFinite(Date.parse(start))))
      throw new CommsError('BAD_DATA', 'an active Resend status point has no activation start');
    return [...(starts as string[])].sort()[0] as string;
  }
  // WhatsApp's baseline generation and raw identities remain encrypted in the activation point.  The scheduler
  // needs only a content-free scan marker; the worker opens the checked-copy snapshot under the visibility fence.
  return JSON.stringify({ points: positions.length });
}

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof CommsError)) return undefined;
  const seconds = error.details?.retryAfterSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const milliseconds = error.details?.retryAfterMs;
  if (typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0)
    return Math.ceil(milliseconds);
  return undefined;
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
