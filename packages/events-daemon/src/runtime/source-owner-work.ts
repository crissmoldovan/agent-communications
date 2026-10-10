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
import {
  type ResendReceivedCandidate,
  type ResendReceivedCycle,
  type ResendReceivedPosition,
  ResendReceivedSource,
} from '../sources/resend.ts';
import {
  compareResendStatusPositions,
  type ResendStatusChange,
  ResendStatusSource,
  resendStatusPosition,
} from '../sources/resend-status.ts';
import { SourceScopeLock } from '../sources/scope-lock.ts';
import {
  assertSlackTimestamp,
  compareSlackTimestamp,
  type SlackCandidate,
  SlackHistorySource,
  type SlackSourceMessage,
} from '../sources/slack.ts';
import { SlackReplyDrains, SlackReplyReconciler, type SlackReplyStageHooks } from '../sources/slack-replies.ts';
import { isSourceScopeFenced } from '../sources/source-scope-fence.ts';
import {
  rawWhatsAppMessageId,
  type WhatsAppActivationPoint,
  type WhatsAppRawMessage,
  WhatsAppSourceWorker,
} from '../sources/whatsapp.ts';
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

type CandidatePosition =
  | Readonly<{ source: 'slack'; timestamp: string }>
  | Readonly<{ source: 'resend-received'; position: ResendReceivedPosition }>
  | Readonly<{ source: 'resend-status'; observedAt: string; scanGeneration: number }>;

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
 * Runs D-5's candidate/diff/first-representation pass while an activation samples a WhatsApp baseline.  The returned
 * position is deliberately calculated only after the checked-copy keys have become the authoritative head: a tuple
 * seen at P is therefore already owed to the active predecessor before the replacement version excludes it.
 */
export async function stageWhatsAppBaselineSnapshot(
  input: Pick<
    SourceOwnerWorkOptions,
    'store' | 'cipher' | 'sourceRegistry' | 'whatsappEventOperations' | 'whatsappVisibilityFence' | 'now'
  >,
  accountId: string,
): Promise<Readonly<{ capturedAt: string; baselineGeneration: number; baselineIdentities: readonly string[] }>> {
  const captured = await input.whatsappEventOperations.withEventSnapshot({ accountId }, async (value) => value);
  const rules = await sourceRulesForWhatsAppAccount(input as SourceOwnerWorkOptions, accountId);
  const writeScope: SourceScope = { source: 'whatsapp', accountId, scopeId: 'all-allowed' };
  const writeRules = () => sourceRuleVersionsForWhatsAppAccount(input.store, accountId);
  const snapshot = sourceSnapshot(input.store, writeRules);
  const assertWrite = () => assertSourceWriteStillLive(input.store.database, writeScope, snapshot, writeRules);
  await input.whatsappVisibilityFence.withCurrentVisibility({ accountId }, async (visibility) => {
    const worker = new WhatsAppSourceWorker({
      store: input.store,
      accountId,
      snapshot: async (work) => work({ ...captured, visibility }),
      stage: async (message) => {
        const id = whatsappStageId(accountId, message);
        return input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(message)));
      },
      // A disabled exact replacement still advances its authoritative baseline head, but it owes no old-version
      // disclosure work.  Enabled collection freezes every active account rule for the D-5 pass.
      rules: () =>
        snapshot.enabled === 1
          ? rules.map((rule) => ({
              ...rule,
              options: rule.options.channel === 'whatsapp' ? rule.options : undefined,
            }))
          : [],
      scopeIsFenced: (scopeId) => isSourceScopeFenced(input.store.database, { source: 'whatsapp', accountId, scopeId }),
      assertWrite,
      now: input.now,
    });
    await worker.scan();
  });
  const head = input.store.database
    .prepare('SELECT committed_generation FROM whatsapp_snapshot_heads WHERE account_id = ?')
    .get(accountId) as { committed_generation: number } | undefined;
  return input.whatsappVisibilityFence.withCurrentVisibility({ accountId }, async (visibility) => ({
    capturedAt: new Date((input.now ?? Date.now)()).toISOString(),
    baselineGeneration: head?.committed_generation ?? 0,
    baselineIdentities: captured.messages
      .filter(
        (message) =>
          message.fromMe === false &&
          message.chatJid !== null &&
          message.senderJidRaw !== null &&
          message.stanzaId !== null &&
          visibility.seesMessage(message.chatJid, message.chatKind ?? 'unknown', message.senderJidRaw, false),
      )
      .flatMap((message) =>
        message.chatJid === null || message.senderJidRaw === null || message.stanzaId === null
          ? []
          : [rawWhatsAppMessageId(message.chatJid, message.senderJidRaw, message.stanzaId)],
      )
      .sort(),
  }));
}

/**
 * The owner-owned bridge from a registered source scope to its Batch-2 state machine. Channel packages hand out
 * only their narrow event operations; raw clients and daemon imports never cross this boundary.
 */
export async function runSourceOwnerWork(input: SourceOwnerWorkOptions, scope: SourceScope): Promise<void> {
  if (scope.source === 'gmail') throw new CommsError('BAD_DATA', 'Gmail uses its established source worker');
  // WhatsApp observes and writes an account-wide raw snapshot, even when this scheduler turn was selected for one
  // chat.  Its post-await fence must consequently freeze every account rule version that can receive such a write.
  // Other sources write only their selected durable scope.
  const writeRules = () =>
    scope.source === 'whatsapp'
      ? sourceRuleVersionsForWhatsAppAccount(input.store, scope.accountId)
      : sourceRulesForScope(input.store, input.sourceRegistry, scope);
  const rules = () => sourceRulesForScope(input.store, input.sourceRegistry, scope);
  const snapshot = sourceSnapshot(input.store, writeRules);
  const assertWrite = () => assertSourceWriteStillLive(input.store.database, scope, snapshot, writeRules);
  const evaluator = evaluatorFor(input);
  const admit = async (
    event: Record<string, unknown>,
    debts: readonly RuleDebt[],
    admission?: Readonly<{ stageId?: string | undefined; position?: CandidatePosition | undefined }>,
  ): Promise<'terminal' | 'pending'> => {
    input.failpoint?.('before-finalise');
    return admitEvent(input, scope, evaluator, event, debts, undefined, admission?.stageId, admission?.position);
  };
  const accountLive = () => assertLiveEventAccount(input.config, { source: scope.source, accountId: scope.accountId });

  if (scope.source === 'slack') {
    const reader = await input.slackSourceFor(scope.accountId);
    if (reader.accountId !== scope.accountId)
      throw new CommsError('CONFIG', 'the Slack event source resolved a different stable account id', {
        details: { reason: 'ACCOUNT_CHANGED', accountId: scope.accountId, source: 'slack' },
      });
    const conversationId = scope.scopeId.slice(`slack:${scope.accountId}:`.length);
    await accountLive();
    const conversation = await reader.conversation({ conversationId });
    await accountLive();
    const replacementDrains = await pendingReplacementDrains(input, scope);
    const replyStage: SlackReplyStageHooks = {
      scope,
      debts: rules,
      admit: ({ candidate, stageId }) =>
        admit(slackEvent(scope, reader, conversation, candidate), sourceRulesForStage(input, scope, stageId), {
          stageId,
          position: { source: 'slack', timestamp: candidate.message.ts },
        }),
    };
    const replySource = {
      replies: async (request: {
        conversationId: string;
        parentTs: string;
        latest: string;
        cursor?: string | undefined;
      }) => {
        await accountLive();
        const page = await reader.replies({ ...request, limit: 100 });
        await accountLive();
        return { ...page, messages: page.messages.map((message) => ({ ...message }) as SlackSourceMessage) };
      },
    };
    const replyCipher = {
      encryptState: async (value: unknown, id: string) => {
        const encrypted = await input.cipher.encrypt(sourceStateLocation(id), Buffer.from(JSON.stringify(value)));
        await accountLive();
        return encrypted;
      },
      decryptState: async (record: Uint8Array, id: string) => {
        const plaintext = await input.cipher.decrypt(sourceStateLocation(id), record);
        await accountLive();
        return JSON.parse(plaintext.toString('utf8'));
      },
    };
    const ordinaryReplies = new SlackReplyReconciler({
      database: input.store.database,
      source: replySource,
      assertLive: assertWrite,
      now: input.now,
      ...replyCipher,
      stage: replyStage,
    });
    const replyDrains = await Promise.all(
      replacementDrains.map(async (drain) => {
        const through = slackDrainThrough(drain.position);
        const replies = new SlackReplyDrains({
          database: input.store.database,
          source: replySource,
          assertLive: assertWrite,
          now: input.now,
          ...replyCipher,
          stage: replyStage,
        });
        await replies.begin({ intentId: drain.intentId, accountId: scope.accountId, conversationId, through });
        for (const parentTs of await ordinaryReplies.parentsAtOrBefore({
          accountId: scope.accountId,
          conversationId,
          through,
        })) {
          await replies.discoverParent({
            intentId: drain.intentId,
            accountId: scope.accountId,
            conversationId,
            parentTs,
          });
        }
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
      admit: async (candidate) =>
        admit(slackEvent(scope, reader, conversation, candidate), rules(), {
          position: { source: 'slack', timestamp: candidate.message.ts },
        }),
      replacementObserver: {
        onTopLevel: async (message) => {
          await ordinaryReplies.discoverParent({
            accountId: scope.accountId,
            conversationId,
            parentTs: message.ts,
          });
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
    // Ordinary reconciliation shares the replacement ceiling. An old active version therefore cannot see a reply
    // after P while its exact replacement is still waiting on that same conversation's aggregate barrier.
    await ordinaryReplies.resumeOne({ accountId: scope.accountId, conversationId, latest });
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
      const receivedDrains = await pendingReplacementDrains(input, scope);
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
        mayFetch: async (position) =>
          (
            await debtsAfterActivationPoint(input, scope, rules(), {
              source: 'resend-received',
              position,
            })
          ).length > 0,
        drainCap: resendReceivedDrainCap(receivedDrains),
        admit: (candidate, position) =>
          admit(resendReceivedEvent(scope, candidate), rules(), {
            position: { source: 'resend-received', position },
          }),
        assertWriteStillLive: assertWrite,
        scopeLock: new SourceScopeLock(),
        now: input.now,
        settleCompletedCycle: async (cycle) => settleResendReceivedPoints(input, scope, rules(), cycle, assertWrite),
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
      if (!result.pending)
        await completePendingReplacementDrains(input, scope, (input.now ?? Date.now)(), source.completedCycle());
      return;
    }
    const pendingStatusStarts = await pendingReplacementDrains(input, scope);
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
      admit: async (change, stageId) => {
        const position = {
          source: 'resend-status' as const,
          observedAt: change.observedAt,
          scanGeneration: change.scanGeneration,
        };
        const stagedDebts = sourceRulesForStage(input, scope, stageId);
        // A stage with debts predates P and remains bound to its already-authorised version. A debt-free status
        // stage is an after-P occurrence deliberately withheld until the child pointer is live.
        const debts =
          stagedDebts.length > 0 ? stagedDebts : await debtsAfterActivationPoint(input, scope, rules(), position);
        return admit(resendStatusEvent(scope, change), debts, { stageId, position });
      },
      assertWriteStillLive: assertWrite,
      scopeLock: new SourceScopeLock(),
      now: input.now,
      mayAdmit: (change) => statusObservationBelongsToOldVersion(change, pendingStatusStarts),
      failpoint: input.failpoint,
    });
    const result = await source.scan({ maxPages: 1 });
    // Status scanning has no provider cursor, so one complete source pass is its content-free P certificate. The
    // scan's per-item state machine has already terminalised every observed pre-P status before this write.
    if (!result.pending) await completePendingReplacementDrains(input, scope, (input.now ?? Date.now)());
    return;
  }

  // Capture raw facts through the channel's checked copy, then enter the daemon fence for the candidate/head write.
  // The latter supplies the current list visibility; a list edit between the copy and this lock is therefore a
  // tightening, never an opportunity to retain a row the new list hides.
  await accountLive();
  if (isSourceScopeFenced(input.store.database, scope)) return;
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
          activationPoints: rule.activationPoints,
        })),
      scopeIsFenced: (scopeId) =>
        isSourceScopeFenced(input.store.database, { source: 'whatsapp', accountId: scope.accountId, scopeId }) ||
        hasPendingWhatsAppReplacementDrain(input.store.database, scope.accountId, scopeId),
      assertWrite,
      now: input.now,
      failpoint: input.failpoint,
    });
    await source.scan();
    await accountLive();
    input.failpoint?.('before-finalise');
    // Stage commit and admission share the identical account-wide frozen fan-out.  A rule removed after the checked
    // copy was captured therefore makes this turn stale rather than letting the frozen rule recreate purged work.
    assertWrite();
    await admitWhatsAppStages(input, scope, evaluator, whatsappRules);
    // The checked-copy snapshot is atomic with respect to the local source. Its candidate/head transaction and the
    // rule-admission pass above have settled the P snapshot before this replacement certificate is written.
    await completePendingReplacementDrains(input, scope, (input.now ?? Date.now)());
  });
}

interface PendingReplacementDrain {
  readonly intentId: string;
  readonly oldRuleId: string;
  readonly oldRuleVersion: number;
  readonly position: unknown;
  readonly capturedAt: number;
  readonly drainedAt: number | null;
}

/**
 * Reads every old-in-scope drain held by an unfinalised exact replacement. A completed drain proves P but must keep
 * fencing this source until the same completion transaction publishes the child pointer.
 */
async function pendingReplacementDrains(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
): Promise<readonly PendingReplacementDrain[]> {
  const rows = input.store.database
    .prepare(
      `SELECT replacement_drains.intent_id, replacement_drains.drained_at, activation_baselines.encrypted_position,
              activation_baselines.response_at, old_version.rule_id AS old_rule_id, old_version.version AS old_rule_version
         FROM replacement_drains
         JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
         JOIN rule_versions AS old_version ON old_version.id = activation_intents.replacement_of_version
         JOIN activation_baselines
           ON activation_baselines.intent_id = replacement_drains.intent_id
          AND activation_baselines.source = replacement_drains.source
          AND activation_baselines.account_id = replacement_drains.account_id
          AND activation_baselines.position_scope = replacement_drains.position_scope
        WHERE replacement_drains.source = ? AND replacement_drains.account_id = ? AND replacement_drains.position_scope = ?
          AND replacement_drains.old_in_scope = 1
          AND activation_intents.status = 'pending-completion'
        ORDER BY activation_baselines.response_at ASC, replacement_drains.intent_id ASC`,
    )
    .all(scope.source, scope.accountId, scope.scopeId) as Array<{
    intent_id: string;
    old_rule_id: string;
    old_rule_version: number;
    drained_at: number | null;
    encrypted_position: Uint8Array;
    response_at: number;
  }>;
  return Promise.all(
    rows.map(async (row) => ({
      intentId: row.intent_id,
      oldRuleId: row.old_rule_id,
      oldRuleVersion: row.old_rule_version,
      capturedAt: row.response_at,
      drainedAt: row.drained_at,
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

async function completePendingReplacementDrains(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  at: number,
  cycle?: ResendReceivedCycle | undefined,
): Promise<void> {
  const drains = await pendingReplacementDrains(input, scope);
  for (const drain of drains) {
    if (drain.drainedAt !== null) continue;
    let gap = false;
    if (scope.source === 'resend' && scope.scopeId === 'received') {
      // A Resend received drain is proved by the exact content-free chain, not by merely finishing whichever cycle
      // happened to be in progress when P was sampled. An older cycle must finish first and let the next one reach P.
      if (cycle === undefined) continue;
      const point = resendReceivedAnchor(drain.position);
      if (point === undefined) gap = true;
      else if (point !== 'empty') {
        const pointIndex = cycle.orderedIds.indexOf(point);
        const advancedAnchorIndex = cycle.orderedIds.indexOf(cycle.advancedAnchorId);
        if (pointIndex < 0) {
          if (cycle.startedAt < drain.capturedAt) continue;
          gap = true;
        } else if (advancedAnchorIndex < 0 || pointIndex < advancedAnchorIndex) {
          // A cap may have listed this later P but advanced only to an earlier one. It is not certified until its own
          // cap is reached in a later chain; otherwise mail between the two points is silently skipped at the swap.
          continue;
        } else if (cycle.anchorLost) {
          // The source re-baselined without materialising any part of the old interval, including P when present.
          gap = true;
        }
      }
    }
    if (scope.source === 'resend' && scope.scopeId === 'status' && statusDrainHasStagedDebt(input.store, scope, drain))
      continue;
    input.store.immediate(() => {
      if (gap)
        input.store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(resendReceivedDrainGapRecordId(scope, drain.intentId), 'agentcomms.source.gap', at);
      completeSourceReplacementDrain(input.store.database, { intentId: drain.intentId, scope, at });
    });
  }
}

function statusDrainHasStagedDebt(store: EventDatabase, scope: SourceScope, drain: PendingReplacementDrain): boolean {
  return (
    store.database
      .prepare(
        `SELECT 1 AS present
           FROM source_stage_rule_debts AS debt
           JOIN source_scan_state AS stage ON stage.id = debt.stage_id
          WHERE debt.rule_id = ? AND debt.rule_version = ?
            AND stage.source = ? AND stage.account_id = ? AND stage.cursor_scope = 'status'`,
      )
      .get(drain.oldRuleId, drain.oldRuleVersion, scope.source, scope.accountId) !== undefined
  );
}

/**
 * A WhatsApp old-side drain resolves only the P baseline that the activation's checked-copy pass already staged.
 * Until the same completion publishes the child, a tuple first seen after P must stay out of the account snapshot
 * head so the shared child can observe it as new (and an old-only child can never receive it).
 */
function hasPendingWhatsAppReplacementDrain(
  database: EventDatabase['database'],
  accountId: string,
  scopeId: string,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present
           FROM replacement_drains
           JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
          WHERE replacement_drains.source = 'whatsapp'
            AND replacement_drains.account_id = ?
            AND replacement_drains.position_scope = ?
            AND replacement_drains.old_in_scope = 1
            AND activation_intents.status = 'pending-completion'`,
      )
      .get(accountId, scopeId) !== undefined
  );
}

/** The first sampled Resend P is the oldest (and therefore strictest) cap while several old versions drain. */
function resendReceivedDrainCap(
  drains: readonly PendingReplacementDrain[],
): Readonly<{ anchorId: string; capturedAt: number }> | undefined {
  const earliest = drains
    .filter((drain) => drain.position !== undefined)
    .reduce<PendingReplacementDrain | undefined>(
      (selected, drain) => (selected === undefined || drain.capturedAt < selected.capturedAt ? drain : selected),
      undefined,
    );
  if (earliest === undefined) return undefined;
  const anchorId = resendReceivedAnchor(earliest.position);
  if (anchorId === undefined) throw new CommsError('BAD_DATA', 'a Resend received replacement baseline has no anchor');
  return { anchorId, capturedAt: earliest.capturedAt };
}

function resendReceivedDrainGapRecordId(scope: SourceScope, intentId: string): string {
  return `resend-received-drain-gap:${createHash('sha256')
    .update(JSON.stringify([intentId, scope.source, scope.accountId, scope.scopeId]))
    .digest('hex')}`;
}

/** A Resend status replacement has no ordered backlog: P belongs to its new baseline, never the old version. */
function statusObservationBelongsToOldVersion(
  change: ResendStatusChange,
  drains: readonly PendingReplacementDrain[],
): boolean {
  const observed = resendStatusPosition({ startedAt: change.observedAt, scanGeneration: change.scanGeneration });
  if (observed === undefined) return false;
  for (const drain of drains) {
    const point = resendStatusPosition(drain.position);
    // Missing/malformed P or equality is a closed refusal. First observations at P seed state and emit nothing.
    const comparison = point === undefined ? undefined : compareResendStatusPositions(observed, point);
    if (comparison === undefined || comparison >= 0) return false;
  }
  return true;
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

/** The synchronous account-wide half of the WhatsApp write fence; point decryption happens only after this snapshot. */
function sourceRuleVersionsForWhatsAppAccount(store: EventDatabase, accountId: string): readonly RuleDebt[] {
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
    if (
      rule.source.channel !== 'whatsapp' ||
      !rule.source.accountIds.includes(accountId) ||
      row.current_cutover_id === null
    )
      continue;
    found.set(`${rule.ruleId}@${rule.version}`, {
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ingestRetentionMs: rule.retention.ingestMs,
      eventType: rule.event.type,
      activationId: row.current_cutover_id,
      options: rule.source.options,
    } as RuleDebt);
  }
  return [...found.values()];
}

/**
 * A reply page is owed to the versions frozen into its durable stage, rather than whichever version happens to be
 * active when a restart reaches it. That keeps a pre-P ordinary reply stage from becoming a new-version admission
 * after an exact replacement has already certified the old side of P.
 */
function sourceRulesForStage(
  input: Pick<SourceOwnerWorkOptions, 'store' | 'sourceRegistry'>,
  scope: SourceScope,
  stageId: string,
): readonly RuleDebt[] {
  const source = input.sourceRegistry.require(scope.source);
  const found = new Map<string, RuleDebt>();
  for (const row of input.store.database
    .prepare(
      `SELECT source_stage_rule_debts.rule_id, source_stage_rule_debts.rule_version, rule_versions.document,
              active_versions.current_cutover_id
         FROM source_stage_rule_debts JOIN rule_versions
           ON rule_versions.rule_id = source_stage_rule_debts.rule_id
          AND rule_versions.version = source_stage_rule_debts.rule_version
         JOIN active_versions
           ON active_versions.kind = 'rule' AND active_versions.object_id = source_stage_rule_debts.rule_id
          AND active_versions.version = source_stage_rule_debts.rule_version
        WHERE source_stage_rule_debts.stage_id = ?`,
    )
    .all(stageId) as Array<{
    rule_id: string;
    rule_version: number;
    document: string;
    current_cutover_id: string | null;
  }>) {
    const rule = JSON.parse(row.document) as CanonicalFullRuleDocument;
    if (rule.source.channel !== scope.source || !rule.source.accountIds.includes(scope.accountId)) continue;
    const options = source.canonicalise(rule.source.options);
    if (
      !source
        .scopesFor({ accountId: scope.accountId, options })
        .some((candidate) => candidate.scopeId === scope.scopeId)
    )
      continue;
    if (row.current_cutover_id === null) continue;
    found.set(`${row.rule_id}@${row.rule_version}`, {
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
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
  stageId?: string,
  position?: CandidatePosition,
): Promise<'terminal' | 'pending'> {
  const eligibleDebts = position === undefined ? debts : await debtsAfterActivationPoint(input, scope, debts, position);
  if (eligibleDebts.length === 0) return 'terminal';
  const stagedAt =
    stageId === undefined
      ? (input.now ?? Date.now)()
      : (
          input.store.database.prepare('SELECT staged_at FROM source_scan_state WHERE id = ?').get(stageId) as
            | { staged_at: number | null }
            | undefined
        )?.staged_at;
  if (stagedAt === null || stagedAt === undefined) return 'terminal';
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
        stagedAt,
      );
  });
  for (const rule of eligibleDebts) {
    const result = await evaluator.admit({
      event: checked.value as unknown as Record<string, unknown>,
      eventId: id,
      ruleId: rule.ruleId,
      ruleVersion: rule.ruleVersion,
      stagedAt,
      ...(stageId === undefined ? {} : { stageId }),
      whatsapp,
    });
    if (result === 'pending') return 'pending';
  }
  return 'terminal';
}

/** Each shared source cursor begins at the oldest live point; admission must still honour the exact point of each rule. */
async function debtsAfterActivationPoint(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  debts: readonly RuleDebt[],
  candidate: CandidatePosition,
): Promise<readonly RuleDebt[]> {
  const admitted: RuleDebt[] = [];
  for (const debt of debts) {
    if (candidate.source === 'resend-received' && resendReceivedPointReached(input.store, scope, debt)) {
      admitted.push(debt);
      continue;
    }
    const point = await activationPoint(input, scope, debt);
    // A missing exact current point has no safe ordering relation and therefore cannot receive the candidate.
    if (point === undefined) continue;
    if (candidateFollowsPoint(candidate, point)) admitted.push(debt);
  }
  return admitted;
}

/**
 * A Resend id has only a newest-first order while its cycle is retained. Once that cycle has completed, this durable,
 * content-free record is the per-version absolute position: every later cycle is strictly after it.
 */
async function settleResendReceivedPoints(
  input: SourceOwnerWorkOptions,
  scope: SourceScope,
  debts: readonly RuleDebt[],
  cycle: ResendReceivedCycle,
  assertWrite: () => void,
): Promise<void> {
  const advancedIndex = cycle.orderedIds.indexOf(cycle.advancedAnchorId);
  const settlements = await Promise.all(
    debts.map(async (debt) => {
      if (resendReceivedPointReached(input.store, scope, debt)) return undefined;
      const anchorId = resendReceivedAnchor(await activationPoint(input, scope, debt));
      if (anchorId === undefined) return undefined;
      // `empty` is the durable position before any received message. It is never a provider id, but still means
      // every later cycle follows the point as soon as the cycle itself has settled.
      if (anchorId === 'empty') return { debt, gap: false };
      const pointIndex = cycle.orderedIds.indexOf(anchorId);
      if (pointIndex >= 0 && advancedIndex >= 0) {
        // A capped cycle advances only to P. An anchor above P remains relative to the next cycle's full chain;
        // marking it reached here would silently admit the capped interval as a later backfill.
        if (pointIndex < advancedIndex) return undefined;
        return { debt, gap: cycle.anchorLost };
      }
      // A cap that did not cross this point proves no relation to it. Keep the version closed until an uncapped
      // cycle can either cross the point or apply the one-time anchor-loss settlement.
      if (cycle.capped) return undefined;
      return { debt, gap: true };
    }),
  );
  const at = (input.now ?? Date.now)();
  input.store.immediate(() => {
    assertWrite();
    for (const settlement of settlements) {
      if (settlement === undefined) continue;
      const reachedId = resendReceivedPointRecordId('resend-received-point-reached', scope, settlement.debt);
      input.store.database
        .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
        .run(reachedId, 'agentcomms.source.point-reached', at);
      if (settlement.gap)
        input.store.database
          .prepare('INSERT OR IGNORE INTO operational_records (id, kind, created_at) VALUES (?, ?, ?)')
          .run(
            resendReceivedPointRecordId('resend-received-point-gap', scope, settlement.debt),
            'agentcomms.source.gap',
            at,
          );
    }
  });
}

async function activationPoint(
  input: Pick<SourceOwnerWorkOptions, 'store' | 'cipher'>,
  scope: SourceScope,
  debt: RuleDebt,
): Promise<unknown | undefined> {
  const row = input.store.database
    .prepare(
      `SELECT encrypted_position FROM rule_activation_points
        WHERE activation_id = ? AND rule_id = ? AND rule_version = ? AND source = ? AND account_id = ?
          AND position_scope = ?`,
    )
    .get(debt.activationId, debt.ruleId, debt.ruleVersion, scope.source, scope.accountId, scope.scopeId) as
    | { encrypted_position: Uint8Array }
    | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(
    (
      await input.cipher.decrypt(
        activationPointLocation(debt.activationId, debt.ruleId, debt.ruleVersion, scope.accountId, scope.scopeId),
        row.encrypted_position,
      )
    ).toString('utf8'),
  ) as unknown;
}

function resendReceivedAnchor(point: unknown): string | undefined {
  const anchorId = typeof point === 'object' && point !== null ? (point as { anchorId?: unknown }).anchorId : undefined;
  return typeof anchorId === 'string' && anchorId.length > 0 ? anchorId : undefined;
}

function resendReceivedPointReached(store: EventDatabase, scope: SourceScope, debt: RuleDebt): boolean {
  return (
    store.database
      .prepare('SELECT 1 AS present FROM operational_records WHERE id = ?')
      .get(resendReceivedPointRecordId('resend-received-point-reached', scope, debt)) !== undefined
  );
}

function resendReceivedPointRecordId(prefix: string, scope: SourceScope, debt: RuleDebt): string {
  const identity = JSON.stringify([
    debt.activationId,
    debt.ruleId,
    debt.ruleVersion,
    scope.source,
    scope.accountId,
    scope.scopeId,
  ]);
  return `${prefix}:${createHash('sha256').update(identity).digest('hex')}`;
}

/** Missing or malformed positions never become an implicit backfill. */
function candidateFollowsPoint(candidate: CandidatePosition, point: unknown): boolean {
  if (candidate.source === 'slack') {
    const timestamp =
      typeof point === 'object' && point !== null ? (point as { timestamp?: unknown }).timestamp : undefined;
    if (typeof timestamp !== 'string') return false;
    try {
      return compareSlackTimestamp(assertSlackTimestamp(candidate.timestamp), assertSlackTimestamp(timestamp)) > 0;
    } catch {
      return false;
    }
  }
  if (candidate.source === 'resend-received') {
    const anchorId = resendReceivedAnchor(point);
    if (anchorId === undefined) return false;
    // `empty` is the canonical position before the first received message; every observed item follows it.
    if (anchorId === 'empty') return true;
    const { orderedIds, candidateIndex } = candidate.position;
    if (
      !Number.isSafeInteger(candidateIndex) ||
      candidateIndex < 0 ||
      candidateIndex >= orderedIds.length ||
      typeof orderedIds[candidateIndex] !== 'string'
    )
      return false;
    const pointIndex = orderedIds.indexOf(anchorId);
    return pointIndex > candidateIndex;
  }
  const observed = resendStatusPosition({
    startedAt: candidate.observedAt,
    scanGeneration: candidate.scanGeneration,
  });
  const activation = resendStatusPosition(point);
  const comparison =
    observed === undefined || activation === undefined ? undefined : compareResendStatusPositions(observed, activation);
  return comparison !== undefined && comparison > 0;
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
  readonly activationPoints: ReadonlyMap<string, WhatsAppActivationPoint>;
}

/** Every active WhatsApp rule for this account contributes its own tuple debt, independent of scheduler scope. */
async function sourceRulesForWhatsAppAccount(
  input: SourceOwnerWorkOptions,
  accountId: string,
): Promise<readonly WhatsAppRuleDebt[]> {
  const source = input.sourceRegistry.require('whatsapp');
  const found = new Map<string, WhatsAppRuleDebt>();
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
    const activationPoints = new Map<string, WhatsAppActivationPoint>();
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
      // K6: an account removal deletes that account's points but keeps a multi-account version. The version is dark
      // there until an approval re-samples it, so it owes this scope nothing; aborting would refuse that approval.
      if (point === undefined) continue;
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
      ) as { capturedAt?: unknown; baselineGeneration?: unknown; baselineIdentities?: unknown };
      const capturedAt = parsedUtcInstant(position.capturedAt);
      const baselineGeneration = position.baselineGeneration;
      if (
        capturedAt === null ||
        typeof baselineGeneration !== 'number' ||
        !Number.isSafeInteger(baselineGeneration) ||
        baselineGeneration < 0 ||
        !Array.isArray(position.baselineIdentities) ||
        !position.baselineIdentities.every((identity) => typeof identity === 'string')
      ) {
        malformed = true;
        break;
      }
      activationPoints.set(scope.scopeId, {
        capturedAt,
        baselineGeneration,
        baselineIdentities: new Set(position.baselineIdentities),
      });
    }
    if (malformed) throw new CommsError('BAD_DATA', 'a WhatsApp rule activation point is malformed');
    found.set(`${rule.ruleId}@${rule.version}`, {
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      ingestRetentionMs: rule.retention.ingestMs,
      eventType: rule.event.type,
      activationId: row.current_cutover_id,
      options,
      activationPoints,
    });
  }
  return [...found.values()] as WhatsAppRuleDebt[];
}

function parsedUtcInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
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

function activationPointLocation(
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
