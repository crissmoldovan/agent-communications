import { createHash } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore, type TaintStore } from '@agentcomms/core';
import { catalogueEntry, eventId, validateEvent, whatsappMessageKey } from '@agentcomms/events';
import type { ResendEventReader } from '@agentcomms/resend';
import type { SlackEventConversation, SlackEventSource } from '@agentcomms/slack';
import { type ChatKind, chatKindOf, type WhatsAppEventOperations } from '@agentcomms/whatsapp';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import type { SourceOptions } from '../domain/source-options.ts';
import {
  assertSourceWriteStillLive,
  type SourceScope,
  type SourceStageDebt,
  sourceRuleSetSnapshot,
} from '../sources/contracts.ts';
import type { LocalEventSourceRegistry } from '../sources/registry.ts';
import { type ResendReceivedCandidate, ResendReceivedSource } from '../sources/resend.ts';
import { type ResendStatusChange, ResendStatusSource } from '../sources/resend-status.ts';
import { SourceScopeLock } from '../sources/scope-lock.ts';
import {
  assertSlackTimestamp,
  compareSlackTimestamp,
  type SlackCandidate,
  SlackHistorySource,
  type SlackSourceMessage,
} from '../sources/slack.ts';
import { SlackReplyDrains } from '../sources/slack-replies.ts';
import { isSourceScopeFenced } from '../sources/source-scope-fence.ts';
import { rawWhatsAppMessageId, type WhatsAppRawMessage, WhatsAppSourceWorker } from '../sources/whatsapp.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { assertLiveEventAccount } from './account-fence.ts';
import type { CutoverFailpoint } from './cutover-failpoint.ts';
import { EventEvaluator } from './evaluate.ts';
import type { EventLifecycle } from './lifecycle.ts';
import { completeSourceReplacementDrain } from './replacements.ts';
import { recordEventTaint } from './untrusted.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

interface StoredRule {
  readonly document: string;
}

interface RuleDebt extends SourceStageDebt {
  readonly eventType: string;
  readonly activationId: string;
  readonly options: SourceOptions;
}

export interface SourceOwnerWorkOptions {
  readonly store: EventDatabase;
  readonly cipher: EventRecordCipher;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly taint: TaintStore;
  readonly lifecycle: EventLifecycle;
  readonly sourceRegistry: LocalEventSourceRegistry;
  readonly slackSourceFor: (accountId: string) => Promise<SlackEventSource>;
  readonly resendReaderFor: (accountId: string) => Promise<ResendEventReader>;
  readonly whatsappEventOperations: WhatsAppEventOperations;
  readonly whatsappVisibilityFence: WhatsAppVisibilityFence;
  readonly now?: (() => number) | undefined;
  /** Optional D8 crash seam; omitted by production callers. */
  readonly failpoint?: CutoverFailpoint | undefined;
}

/**
 * The owner-owned bridge from a registered source scope to its Batch-2 state machine. Channel packages hand out
 * only their narrow event operations; raw clients and daemon imports never cross this boundary.
 */
export async function runSourceOwnerWork(input: SourceOwnerWorkOptions, scope: SourceScope): Promise<void> {
  if (scope.source === 'gmail') throw new CommsError('BAD_DATA', 'Gmail uses its established source worker');
  const rules = () => sourceRulesForScope(input.store, input.sourceRegistry, scope);
  const snapshot = sourceSnapshot(input.store, rules);
  const assertWrite = () => assertSourceWriteStillLive(input.store.database, scope, snapshot, rules);
  const evaluator = evaluatorFor(input);
  const admit = async (event: Record<string, unknown>, debts: readonly RuleDebt[]): Promise<'terminal' | 'pending'> => {
    input.failpoint?.('before-finalise');
    return admitEvent(input, scope, evaluator, event, debts);
  };
  const accountLive = () => assertLiveEventAccount(input.config, { source: scope.source, accountId: scope.accountId });

  if (scope.source === 'slack') {
    const reader = await input.slackSourceFor(scope.accountId);
    const conversationId = scope.scopeId.slice(`slack:${scope.accountId}:`.length);
    await accountLive();
    const conversation = await reader.conversation({ conversationId });
    await accountLive();
    const replacementDrains = await pendingReplacementDrains(input, scope);
    const replyDrains = await Promise.all(
      replacementDrains.map(async (drain) => {
        const through = slackDrainThrough(drain.position);
        const replies = new SlackReplyDrains({
          database: input.store.database,
          source: {
            replies: async (request) => {
              await accountLive();
              const page = await reader.replies({ ...request, limit: 100 });
              await accountLive();
              return { nextCursor: page.nextCursor };
            },
          },
          assertLive: assertWrite,
          now: input.now,
          encryptState: (value, id) =>
            input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(value))),
          decryptState: async (record, id) =>
            JSON.parse((await input.cipher.decrypt(sourceStateLocation(id), record)).toString('utf8')),
        });
        await replies.begin({ intentId: drain.intentId, accountId: scope.accountId, conversationId, through });
        return { ...drain, through, replies };
      }),
    );
    const source = new SlackHistorySource({
      store: input.store,
      accountId: scope.accountId,
      source: {
        history: async (request) => {
          await accountLive();
          const page = await reader.history({ ...request, limit: 100 });
          await accountLive();
          // The channel operation's closed message type is structurally richer. The daemon source intentionally
          // carries an open field bag so newer channel-normalised facts can remain opaque until event mapping.
          return { ...page, messages: page.messages.map((message) => ({ ...message }) as SlackSourceMessage) };
        },
      },
      // EventScheduler already owns this exact scope lock. The worker's local lock serialises its resumable state
      // machine without attempting to acquire the non-reentrant owner lock a second time.
      lock: new SourceScopeLock(),
      rules,
      accountLive,
      admit: async (candidate) => admit(slackEvent(scope, reader, conversation, candidate), rules()),
      replacementObserver: {
        onTopLevel: async (message) => {
          await Promise.all(
            replyDrains.map(({ intentId, replies }) =>
              replies.discoverParent({
                intentId,
                accountId: scope.accountId,
                conversationId,
                parentTs: message.ts,
              }),
            ),
          );
        },
        // The worker invokes this only after its terminal cursor transaction.  The exact P comparison below is the
        // authoritative history-half proof: the tick's fixed interval can legitimately end before a later drain's P.
        onHistoryCovered: async () => undefined,
      },
      encryptStage: async (value, id) => {
        const encrypted = await input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(value)));
        await accountLive();
        return encrypted;
      },
      decryptStage: async (record, id) => {
        const plaintext = await input.cipher.decrypt(sourceStateLocation(id), record);
        await accountLive();
        return JSON.parse(plaintext.toString('utf8'));
      },
      now: input.now,
      failpoint: input.failpoint,
    });
    // While an old Slack version is draining, cap its fixed history interval at the earliest outstanding P.  That
    // makes a shared scope's first post-P top-level occurrence unavailable to the old rule; once the atomic swap
    // publishes the child, the ordinary next interval begins at P and belongs only to that child.
    const latest = replyDrains
      .slice(1)
      .reduce(
        (earliest, drain) => (compareSlackTimestamp(drain.through, earliest) < 0 ? drain.through : earliest),
        replyDrains[0]?.through ?? slackTimestamp((input.now ?? Date.now)()),
      );
    const result = await source.scan({ conversationId, latest, maxPages: 1 });
    for (const drain of replyDrains) {
      const historyCovered = result.watermark !== null && compareSlackTimestamp(result.watermark, drain.through) >= 0;
      const replyInput = { intentId: drain.intentId, accountId: scope.accountId, conversationId };
      if (historyCovered) await drain.replies.topLevelCovered(replyInput);
      // One reply page per owner turn gives the ordinary scheduler round-robin fairness to a large thread set.
      await drain.replies.resumeOne(replyInput);
      completeSourceReplacementDrain(input.store.database, {
        intentId: drain.intentId,
        scope,
        at: (input.now ?? Date.now)(),
        slack: { historyCovered, repliesCovered: await drain.replies.complete(replyInput) },
      });
    }
    return;
  }

  if (scope.source === 'resend') {
    const raw = await input.resendReaderFor(scope.accountId);
    const reader: ResendEventReader = {
      listReceived: async (after) => {
        await accountLive();
        const page = await raw.listReceived(after);
        await accountLive();
        return page;
      },
      getReceived: async (id) => {
        await accountLive();
        const detail = await raw.getReceived(id);
        await accountLive();
        return detail;
      },
      listSent: async (after) => {
        await accountLive();
        const page = await raw.listSent(after);
        await accountLive();
        return page;
      },
    };
    if (scope.scopeId === 'received') {
      const source = new ResendReceivedSource({
        store: input.store,
        accountId: scope.accountId,
        reader,
        encrypt: async (value, id) => {
          const encrypted = await input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(value)));
          await accountLive();
          return encrypted;
        },
        decrypt: async (record, id) => {
          const plaintext = await input.cipher.decrypt(sourceStateLocation(id), record);
          await accountLive();
          return JSON.parse(plaintext.toString('utf8'));
        },
        debts: rules,
        admit: (candidate) => admit(resendReceivedEvent(scope, candidate), rules()),
        assertWriteStillLive: assertWrite,
        scopeLock: new SourceScopeLock(),
        now: input.now,
        failpoint: input.failpoint,
      });
      const state = input.store.database
        .prepare("SELECT 1 AS present FROM source_scan_state WHERE id = ? AND source = 'resend'")
        .get(`resend-received:${scope.accountId}`);
      if (state === undefined) {
        const cursor = input.store.database
          .prepare(
            "SELECT cursor FROM cursors WHERE source = 'resend' AND account_id = ? AND cursor_scope = 'received'",
          )
          .get(scope.accountId) as { cursor: string } | undefined;
        if (cursor === undefined)
          throw new CommsError('BAD_DATA', 'Resend received work has no installed activation anchor');
        await source.seedAnchor(cursor.cursor);
      }
      const result = await source.scan();
      // A completed received cycle has terminally visited the fixed anchor captured at P (or its empty sentinel).
      // Do not settle after a budget/retry continuation: it may still contain old-version candidates.
      if (!result.pending) completePendingReplacementDrains(input, scope, (input.now ?? Date.now)());
      return;
    }
    const source = new ResendStatusSource({
      store: input.store,
      accountId: scope.accountId,
      reader,
      encrypt: async (value, id) => {
        const encrypted = await input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(value)));
        await accountLive();
        return encrypted;
      },
      decrypt: async (record, id) => {
        const plaintext = await input.cipher.decrypt(sourceStateLocation(id), record);
        await accountLive();
        return JSON.parse(plaintext.toString('utf8'));
      },
      debts: rules,
      admit: (change) => admit(resendStatusEvent(scope, change), rules()),
      assertWriteStillLive: assertWrite,
      scopeLock: new SourceScopeLock(),
      now: input.now,
      failpoint: input.failpoint,
    });
    await source.scan();
    // Status scanning has no provider cursor, so one complete source pass is its content-free P certificate. The
    // scan's per-item state machine has already terminalised every observed pre-P status before this write.
    completePendingReplacementDrains(input, scope, (input.now ?? Date.now)());
    return;
  }

  // Capture raw facts through the channel's checked copy, then enter the daemon fence for the candidate/head write.
  // The latter supplies the current list visibility; a list edit between the copy and this lock is therefore a
  // tightening, never an opportunity to retain a row the new list hides.
  await accountLive();
  const whatsappRules = await sourceRulesForWhatsAppAccount(input, scope.accountId);
  const captured = await input.whatsappEventOperations.withEventSnapshot(
    { accountId: scope.accountId },
    async (value) => value,
  );
  await accountLive();
  await input.whatsappVisibilityFence.withCurrentVisibility({ accountId: scope.accountId }, async (visibility) => {
    await accountLive();
    const source = new WhatsAppSourceWorker({
      store: input.store,
      accountId: scope.accountId,
      snapshot: async (work) => work({ ...captured, visibility }),
      stage: async (message) => {
        const id = whatsappStageId(scope.accountId, message);
        const encrypted = await input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(message)));
        await accountLive();
        return encrypted;
      },
      // A WhatsApp snapshot is account-wide. Freeze debts for every active rule whose selector may cover a tuple,
      // rather than only the scheduler scope that won this turn.
      rules: () =>
        whatsappRules.map((rule) => ({
          ruleId: rule.ruleId,
          ruleVersion: rule.ruleVersion,
          ingestRetentionMs: rule.ingestRetentionMs,
          activationId: rule.activationId,
          options: rule.options.channel === 'whatsapp' ? rule.options : undefined,
          activationPointIdentities: rule.activationPointIdentities,
        })),
      scopeIsFenced: (scopeId) =>
        isSourceScopeFenced(input.store.database, { source: 'whatsapp', accountId: scope.accountId, scopeId }),
      assertWrite,
      now: input.now,
      failpoint: input.failpoint,
    });
    await source.scan();
    await accountLive();
    input.failpoint?.('before-finalise');
    await admitWhatsAppStages(input, scope, evaluator, rules());
    // The checked-copy snapshot is atomic with respect to the local source. Its candidate/head transaction and the
    // rule-admission pass above have settled the P snapshot before this replacement certificate is written.
    completePendingReplacementDrains(input, scope, (input.now ?? Date.now)());
  });
}

interface PendingReplacementDrain {
  readonly intentId: string;
  readonly position: unknown;
}

/** Reads only active old-in-scope drains; plaintext positions stay in this owner and never leave a provider boundary. */
async function pendingReplacementDrains(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
): Promise<readonly PendingReplacementDrain[]> {
  const rows = input.store.database
    .prepare(
      `SELECT replacement_drains.intent_id, activation_baselines.encrypted_position
         FROM replacement_drains
         JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
         JOIN activation_baselines
           ON activation_baselines.intent_id = replacement_drains.intent_id
          AND activation_baselines.source = replacement_drains.source
          AND activation_baselines.account_id = replacement_drains.account_id
          AND activation_baselines.position_scope = replacement_drains.position_scope
        WHERE replacement_drains.source = ? AND replacement_drains.account_id = ? AND replacement_drains.position_scope = ?
          AND replacement_drains.old_in_scope = 1 AND replacement_drains.drained_at IS NULL
          AND activation_intents.status = 'pending-completion'`,
    )
    .all(scope.source, scope.accountId, scope.scopeId) as Array<{ intent_id: string; encrypted_position: Uint8Array }>;
  return Promise.all(
    rows.map(async (row) => ({
      intentId: row.intent_id,
      position: JSON.parse(
        (
          await input.cipher.decrypt(
            {
              table: 'activation_baselines',
              column: 'encryptedPosition',
              key: [
                { type: 'text', value: row.intent_id },
                { type: 'text', value: scope.source },
                { type: 'text', value: scope.accountId },
                { type: 'text', value: scope.scopeId },
              ],
            },
            row.encrypted_position,
          )
        ).toString('utf8'),
      ),
    })),
  );
}

function completePendingReplacementDrains(input: SourceOwnerWorkOptions, scope: SourceScope, at: number): void {
  for (const row of input.store.database
    .prepare(
      `SELECT replacement_drains.intent_id
         FROM replacement_drains JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
        WHERE replacement_drains.source = ? AND replacement_drains.account_id = ? AND replacement_drains.position_scope = ?
          AND replacement_drains.old_in_scope = 1 AND replacement_drains.drained_at IS NULL
          AND activation_intents.status = 'pending-completion'`,
    )
    .all(scope.source, scope.accountId, scope.scopeId) as Array<{ intent_id: string }>) {
    completeSourceReplacementDrain(input.store.database, { intentId: row.intent_id, scope, at });
  }
}

function slackDrainThrough(position: unknown): string {
  if (
    typeof position !== 'object' ||
    position === null ||
    typeof (position as { timestamp?: unknown }).timestamp !== 'string'
  )
    throw new CommsError('BAD_DATA', 'a Slack replacement baseline has no timestamp');
  return assertSlackTimestamp((position as { timestamp: string }).timestamp);
}

function evaluatorFor(input: SourceOwnerWorkOptions): EventEvaluator {
  return new EventEvaluator({
    store: input.store,
    cipher: input.cipher,
    approvals: input.approvals,
    config: input.config,
    taint: {
      record: async (taintInput) => {
        await recordEventTaint(input.taint, { ownAddresses: [], internalDomains: [] }, taintInput);
      },
    },
    now: input.now,
  });
}

function sourceRulesForScope(
  store: EventDatabase,
  registry: LocalEventSourceRegistry,
  scope: SourceScope,
): readonly RuleDebt[] {
  const source = registry.require(scope.source);
  const found = new Map<string, RuleDebt>();
  for (const row of store.database
    .prepare(
      `SELECT rule_versions.document, active_versions.current_cutover_id
         FROM active_versions JOIN rule_versions
           ON rule_versions.rule_id = active_versions.object_id AND rule_versions.version = active_versions.version
        WHERE active_versions.kind = 'rule'`,
    )
    .all() as unknown as Array<StoredRule & { current_cutover_id: string | null }>) {
    const rule = JSON.parse(row.document) as CanonicalFullRuleDocument;
    if (rule.source.channel !== scope.source || !rule.source.accountIds.includes(scope.accountId)) continue;
    const options = source.canonicalise(rule.source.options);
    if (
      !source
        .scopesFor({ accountId: scope.accountId, options })
        .some((candidate) => candidate.scopeId === scope.scopeId)
    )
      continue;
    const point = store.database
      .prepare(
        `SELECT 1 AS present FROM rule_activation_points
          WHERE activation_id = ? AND rule_id = ? AND rule_version = ? AND source = ? AND account_id = ? AND position_scope = ?`,
      )
      .get(row.current_cutover_id, rule.ruleId, rule.version, scope.source, scope.accountId, scope.scopeId);
    if (point === undefined || row.current_cutover_id === null) continue;
    found.set(`${rule.ruleId}@${rule.version}`, {
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ingestRetentionMs: rule.retention.ingestMs,
      eventType: rule.event.type,
      activationId: row.current_cutover_id,
      options,
    });
  }
  return [...found.values()];
}

function sourceSnapshot(store: EventDatabase, rules: () => readonly RuleDebt[]) {
  const settings = store.database
    .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; switch_generation: number };
  return {
    generation: settings.switch_generation,
    enabled: settings.enabled,
    startedAt: Date.now(),
    rules: sourceRuleSetSnapshot(rules()),
  };
}

async function admitEvent(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  evaluator: EventEvaluator,
  event: Record<string, unknown>,
  debts: readonly RuleDebt[],
  whatsapp?: Readonly<{ messageId: string; visibilityVersion: number }>,
): Promise<'terminal' | 'pending'> {
  if (debts.length === 0) return 'terminal';
  const entry = catalogueEntry(String(event.type), Number(event.version));
  if (!entry.ok) throw new CommsError('BAD_DATA', entry.issues[0]?.message ?? 'a source event is unknown');
  const identity = {
    installationId: input.store.installationId,
    accountId: scope.accountId,
    eventType: entry.value.type,
    typeVersion: entry.value.version,
    dedupeKey: entry.value.dedupeKey(event as never, {} as never),
  };
  const id = await eventId(identity);
  const checked = validateEvent(entry.value as never, { ...event, id });
  if (!checked.ok)
    throw new CommsError('BAD_DATA', checked.issues[0]?.message ?? 'a source candidate is not a catalogue event');
  await assertLiveEventAccount(input.config, { source: scope.source, accountId: scope.accountId });
  input.store.immediate(() => {
    input.store.database
      .prepare(
        `INSERT OR IGNORE INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        identity.installationId,
        identity.eventType,
        identity.typeVersion,
        identity.accountId,
        identity.dedupeKey,
        instant(String((checked.value as unknown as Record<string, unknown>).occurredAt)),
        instant(String((checked.value as unknown as Record<string, unknown>).observedAt)),
        (input.now ?? Date.now)(),
      );
  });
  for (const rule of debts) {
    const result = await evaluator.admit({
      event: checked.value as unknown as Record<string, unknown>,
      eventId: id,
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      stagedAt: (input.now ?? Date.now)(),
      whatsapp,
    });
    if (result === 'pending') return 'pending';
  }
  return 'terminal';
}

function slackEvent(
  scope: SourceScope,
  source: SlackEventSource,
  conversation: SlackEventConversation,
  candidate: SlackCandidate,
): Record<string, unknown> {
  const at = slackInstant(candidate.message.ts);
  return {
    id: '',
    type: 'slack.message.posted',
    version: 1,
    occurredAt: at,
    observedAt: at,
    account: { name: source.accountAlias, id: scope.accountId, channel: 'slack' },
    workspaceId: source.workspaceId,
    ts: candidate.message.ts,
    threadTs: candidate.message.threadTs,
    channel: conversation,
    author: candidate.message.author ?? { name: null, app: false, external: false },
    text: candidate.message.text,
    truncated: candidate.message.truncated ?? false,
    mismatch: candidate.message.mismatch ?? false,
    unrenderable: candidate.message.unrenderable ?? false,
    editedTs: candidate.message.editedTs ?? null,
    mentions: candidate.message.mentions ?? [],
    files: candidate.message.files ?? [],
  };
}

function resendReceivedEvent(scope: SourceScope, candidate: ResendReceivedCandidate): Record<string, unknown> {
  return {
    id: '',
    type: 'resend.email.received',
    version: 1,
    occurredAt: candidate.receivedAt,
    observedAt: candidate.receivedAt,
    account: { name: scope.accountId, id: scope.accountId, channel: 'resend' },
    emailId: candidate.emailId,
    receivedAt: candidate.receivedAt,
    from: candidate.from ?? null,
    replyTo: candidate.replyTo ?? [],
    to: candidate.to ?? [],
    cc: candidate.cc ?? [],
    receivedFor: candidate.receivedFor ?? [],
    subject: candidate.subject,
    messageId: candidate.messageId ?? null,
    attachmentCount: candidate.attachmentCount ?? candidate.attachments?.length ?? 0,
    authentication: candidate.authentication ?? { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
    ...(candidate.attachments === undefined ? {} : { attachments: candidate.attachments }),
    ...(candidate.body === undefined ? {} : { body: candidate.body, bodyTruncated: candidate.bodyTruncated === true }),
  };
}

function resendStatusEvent(scope: SourceScope, change: ResendStatusChange): Record<string, unknown> {
  return {
    id: '',
    type: 'resend.email.status_changed',
    version: 1,
    occurredAt: change.observedAt,
    observedAt: change.observedAt,
    account: { name: scope.accountId, id: scope.accountId, channel: 'resend' },
    emailId: change.emailId,
    from: change.from,
    to: change.to,
    cc: change.cc,
    bcc: change.bcc,
    subject: change.subject,
    createdAt: change.createdAt,
    scheduledAt: change.scheduledAt,
    messageId: change.messageId,
    previous: change.previous,
    current: change.current,
    at: change.observedAt,
  };
}

async function admitWhatsAppStages(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  evaluator: EventEvaluator,
  rules: readonly RuleDebt[],
): Promise<void> {
  const current = new Map(rules.map((rule) => [`${rule.ruleId}@${rule.ruleVersion}`, rule]));
  const rows = input.store.database
    .prepare(
      `SELECT admissions.message_id, admissions.rule_id, admissions.rule_version, occurrences.visibility_version,
              occurrences.staged_payload_ref,
              state.encrypted_record
         FROM whatsapp_rule_admissions AS admissions
         JOIN whatsapp_occurrences AS occurrences
           ON occurrences.account_id = admissions.account_id AND occurrences.message_id = admissions.message_id
         JOIN source_scan_state AS state ON state.id = occurrences.staged_payload_ref
        WHERE admissions.account_id = ? AND admissions.admission = 'admitted'
          AND occurrences.staged_payload_ref IS NOT NULL`,
    )
    .all(scope.accountId) as unknown as Array<{
    message_id: string;
    rule_id: string;
    rule_version: number;
    visibility_version: number;
    staged_payload_ref: string;
    encrypted_record: Uint8Array;
  }>;
  for (const row of rows) {
    const rule = current.get(`${row.rule_id}@${row.rule_version}`);
    if (rule === undefined) continue;
    const message = JSON.parse(
      (await input.cipher.decrypt(sourceStateLocation(row.staged_payload_ref), row.encrypted_record)).toString('utf8'),
    ) as WhatsAppRawMessage;
    const event = whatsappEvent(scope, message, (input.now ?? Date.now)());
    const outcome = await admitEvent(input, scope, evaluator, event, [rule], {
      messageId: row.message_id,
      visibilityVersion: row.visibility_version,
    });
    if (outcome !== 'terminal') continue;
    const id = await eventIdentifier(input, scope, event);
    input.store.immediate(() => {
      input.store.database
        .prepare('UPDATE whatsapp_occurrences SET event_id = ? WHERE account_id = ? AND message_id = ?')
        .run(id, scope.accountId, row.message_id);
    });
  }
}

interface WhatsAppRuleDebt extends RuleDebt {
  readonly activationPointIdentities: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Every active WhatsApp rule for this account contributes its own tuple debt, independent of scheduler scope. */
async function sourceRulesForWhatsAppAccount(
  input: SourceOwnerWorkOptions,
  accountId: string,
): Promise<readonly WhatsAppRuleDebt[]> {
  const source = input.sourceRegistry.require('whatsapp');
  const found = new Map<string, RuleDebt>();
  for (const row of input.store.database
    .prepare(
      `SELECT rule_versions.document, active_versions.current_cutover_id
         FROM active_versions JOIN rule_versions
           ON rule_versions.rule_id = active_versions.object_id AND rule_versions.version = active_versions.version
        WHERE active_versions.kind = 'rule'`,
    )
    .all() as unknown as Array<StoredRule & { current_cutover_id: string | null }>) {
    const rule = JSON.parse(row.document) as CanonicalFullRuleDocument;
    if (
      rule.source.channel !== 'whatsapp' ||
      !rule.source.accountIds.includes(accountId) ||
      row.current_cutover_id === null
    )
      continue;
    const options = source.canonicalise(rule.source.options);
    const pointIdentities = new Map<string, ReadonlySet<string>>();
    let malformed = false;
    for (const scope of source.scopesFor({ accountId, options })) {
      const point = input.store.database
        .prepare(
          `SELECT encrypted_position FROM rule_activation_points
            WHERE activation_id = ? AND rule_id = ? AND rule_version = ? AND source = 'whatsapp'
              AND account_id = ? AND position_scope = ?`,
        )
        .get(row.current_cutover_id, rule.ruleId, rule.version, accountId, scope.scopeId) as
        | { encrypted_position: Uint8Array }
        | undefined;
      if (point === undefined) {
        malformed = true;
        break;
      }
      const position = JSON.parse(
        (
          await input.cipher.decrypt(
            whatsappActivationPointLocation(
              row.current_cutover_id,
              rule.ruleId,
              rule.version,
              accountId,
              scope.scopeId,
            ),
            point.encrypted_position,
          )
        ).toString('utf8'),
      ) as { baselineIdentities?: unknown };
      if (
        !Array.isArray(position.baselineIdentities) ||
        !position.baselineIdentities.every((identity) => typeof identity === 'string')
      ) {
        malformed = true;
        break;
      }
      pointIdentities.set(scope.scopeId, new Set(position.baselineIdentities));
    }
    if (malformed) throw new CommsError('BAD_DATA', 'a WhatsApp rule activation point is malformed');
    found.set(`${rule.ruleId}@${rule.version}`, {
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ingestRetentionMs: rule.retention.ingestMs,
      eventType: rule.event.type,
      activationId: row.current_cutover_id,
      options,
      activationPointIdentities: pointIdentities,
    } as WhatsAppRuleDebt);
  }
  return [...found.values()] as WhatsAppRuleDebt[];
}

function whatsappActivationPointLocation(
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

function whatsappEvent(scope: SourceScope, message: WhatsAppRawMessage, now: number): Record<string, unknown> {
  if (
    message.chatJid === null ||
    message.chatKind === null ||
    message.chatKind === undefined ||
    message.senderJidRaw === null ||
    message.stanzaId === null ||
    message.fromMe !== false
  )
    throw new CommsError('BAD_DATA', 'a staged WhatsApp message lost its raw identity');
  const at = message.at ?? new Date(now).toISOString();
  return {
    id: '',
    type: 'whatsapp.message.received',
    version: 1,
    occurredAt: at,
    observedAt: at,
    account: { name: scope.accountId, id: scope.accountId, channel: 'whatsapp' },
    workspaceId: scope.accountId,
    messageId: whatsappMessageKey(message.chatJid, message.senderJidRaw, message.stanzaId),
    chat: { id: message.chatJid, name: null, kind: catalogueWhatsAppChatKind(message.chatJid) },
    sender: { id: message.senderJidRaw, name: null },
    text: message.body ?? null,
    at,
    fromMe: false,
    kind: 'unknown',
    viewOnce: false,
    groupEvent: null,
    media: null,
  };
}

/** The channel package owns the JID vocabulary; malformed or future inputs become the catalogue's safe unknown kind. */
function catalogueWhatsAppChatKind(chatJid: string): ChatKind {
  try {
    return chatKindOf(chatJid);
  } catch {
    return 'unknown';
  }
}

async function eventIdentifier(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  event: Record<string, unknown>,
): Promise<string> {
  const entry = catalogueEntry(String(event.type), Number(event.version));
  if (!entry.ok) throw new CommsError('BAD_DATA', entry.issues[0]?.message ?? 'a source event is unknown');
  return eventId({
    installationId: input.store.installationId,
    accountId: scope.accountId,
    eventType: entry.value.type,
    typeVersion: entry.value.version,
    dedupeKey: entry.value.dedupeKey(event as never, {} as never),
  });
}

function whatsappStageId(accountId: string, message: WhatsAppRawMessage): string {
  if (message.chatJid === null || message.senderJidRaw === null || message.stanzaId === null)
    throw new CommsError('BAD_DATA', 'a WhatsApp source stage has no raw identity');
  return `whatsapp:${accountId}:${createHash('sha256')
    .update(rawWhatsAppMessageId(message.chatJid, message.senderJidRaw, message.stanzaId), 'utf8')
    .digest('hex')}`;
}

function slackTimestamp(now: number): string {
  const seconds = Math.floor(now / 1_000);
  const micros = (now % 1_000) * 1_000;
  return `${seconds}.${String(micros).padStart(6, '0')}`;
}

function slackInstant(timestamp: string): string {
  const [seconds, micros] = timestamp.split('.') as [string, string];
  return new Date(Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000)).toISOString();
}

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new CommsError('BAD_DATA', 'a source event has no exact timestamp');
  return parsed;
}

function sourceStateLocation(id: string) {
  return { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}
