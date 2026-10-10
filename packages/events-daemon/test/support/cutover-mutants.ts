import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface CutoverMutation {
  readonly id: string;
  /** Path below packages/events-daemon/src in the unmutated production tree. */
  readonly file: string;
  /** Guarded production text; this must match exactly once before mutation. */
  readonly before: string;
  readonly after: string;
  /** The S/R/W matrix cell intended to own the behavioural oracle. */
  readonly cell: string;
  /** One runtime export to load from the copied production module. */
  readonly exportName: string;
}

const guards = {
  pointReread: 'fingerprint(publishedSourcePointSet(database, scope)) === fingerprint(pointsReadBeforeDecrypt)',
  rawKey: "return canonicalJson(['wa-msg', chatJid, senderJidRaw, stanzaId]);",
  deadlineClaim: 'if ((current.completion_deadline ?? deadline) <= this.#now()) {',
  deadlineBaseline:
    'if (afterBaselines.completion_deadline !== null && afterBaselines.completion_deadline <= this.#now()) {',
  deadlineFinalise: 'if (latest.completion_deadline !== null && latest.completion_deadline <= this.#now()) {',
} as const;

/**
 * D8 destructive edits. Each target is intentionally a single guarded string,
 * so moving or renaming a production guard makes the mutation test fail closed
 * instead of silently testing an unmodified copy.
 */
export const CUTOVER_MUTATIONS: readonly CutoverMutation[] = [
  {
    id: 'stage-after-pointer',
    file: 'sources/whatsapp.ts',
    before: 'this.commitCandidate(snapshot.visibility, generation, candidatesWithDebts, encrypted);',
    after: 'this.commitCandidate(snapshot.visibility, generation, candidatesWithDebts, new Map());',
    cell: 'W:first-enabled-stages-before-copy-dispose',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], encrypted);
      const before = this.currentHead();`,
    cell: 'W:first-enabled-stages-before-copy-dispose',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head-old-only',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], encrypted);
      const before = this.currentHead();`,
    cell: 'W:replace-old-only-admits-by-old-generation',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head-new-only',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], encrypted);
      const before = this.currentHead();`,
    cell: 'W:replace-new-only-baselines-raw-generation',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head-enable-all',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], encrypted);
      const before = this.currentHead();`,
    cell: 'W:enable-all-rebaselines-authoritative-head',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head-generation-recheck',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], encrypted);
      const before = this.currentHead();`,
    cell: 'W:initial-cursor-rechecks-generation-under-chat-lock',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-disabled-baseline-omits-first-head',
    file: 'sources/whatsapp.ts',
    before: 'if (before === undefined) {',
    after: 'if (false) {',
    cell: 'W:first-disabled-head-without-owed-stage',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-disabled-replacement-omits-first-head',
    file: 'sources/whatsapp.ts',
    before: 'if (before === undefined) {',
    after: 'if (false) {',
    cell: 'W:disabled-replacement-no-owed-admission',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-tightening-keeps-parent-pointer',
    file: 'runtime/replacements.ts',
    before:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ?",
    after:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ? AND 0 = 1",
    cell: 'W:tighten-preserves-raw-admission-boundary',
    exportName: 'applyDerivedTightening',
  },
  {
    id: 'whatsapp-target-removal-leaves-rule-work',
    file: 'runtime/revocations.ts',
    before: 'purgeRevokedRuleWork(database.database, rule.rule_id, [rule.version]);',
    after: 'void rule;',
    cell: 'W:disable-or-remove-cancels-and-purges-hidden-tuples',
    exportName: 'removeTarget',
  },
  {
    id: 'whatsapp-account-removal-keeps-raw-occurrence',
    file: 'runtime/account-fence.ts',
    before: "database.prepare('DELETE FROM whatsapp_occurrences WHERE account_id = ?').run(accountId);",
    after: 'void accountId;',
    cell: 'W:remove-readd-stays-dark-and-rechecks-list',
    exportName: 'purgeRemovedAccountWork',
  },
  {
    id: 'whatsapp-recovery-skips-claimed-completion',
    file: 'runtime/activations.ts',
    before:
      "SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE status IN ('pending', 'pending-completion')",
    after:
      'SELECT id, kind, document, digest, effect, replacement_of_version, status, approval_id, claimed_at, completion_deadline FROM activation_intents WHERE 1 = 0',
    cell: 'W:claim-recovery-keeps-authoritative-head',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'whatsapp-fenced-worker-reads-checked-copy',
    file: 'runtime/source-owner-work.ts',
    before: 'if (isSourceScopeFenced(input.store.database, scope)) return;',
    after: 'if (false) return;',
    cell: 'W:claimed-P-fences-snapshot-worker',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'whatsapp-new-only-fence-after-debt',
    file: 'sources/whatsapp.ts',
    before: `return this.#scopeIsFenced(\`chat:\${message.chatJid}\`) || this.#scopeIsFenced('all-allowed');`,
    after: 'return false;',
    cell: 'W:fenced-new-only-tuple-remains-new-after-swap',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-drain-omits-post-p-cap',
    file: 'runtime/source-owner-work.ts',
    before: 'hasPendingWhatsAppReplacementDrain(input.store.database, scope.accountId, scopeId),',
    after: 'false,',
    cell: 'W:replacement-drain-caps-post-P-tuples',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'whatsapp-unowed-visible-key-omits-ledger',
    file: 'sources/whatsapp.ts',
    before: 'for (const { messageId, message, admissions, debts } of committed) {',
    after:
      'for (const { messageId, message, admissions, debts } of committed.filter((item) => item.debts.length > 0)) {',
    cell: 'W:first-disabled-head-without-owed-stage',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-head-switch-keeps-obsolete-snapshots',
    file: 'sources/whatsapp.ts',
    before: 'DELETE FROM whatsapp_snapshot_keys WHERE account_id = ? AND generation < ?',
    after: 'DELETE FROM whatsapp_snapshot_keys WHERE account_id = ? AND generation < ? AND 0 = 1',
    cell: 'W:head-switch-cleans-superseded-snapshot-generations',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-narrowing-keeps-unowed-snapshot-key',
    file: 'runtime/whatsapp-visibility.ts',
    before: 'for (const key of hiddenSnapshotKeys) {',
    after: 'for (const key of hiddenSnapshotKeys.filter(() => false)) {',
    cell: 'W:narrowing-purges-unowed-snapshot-keys',
    exportName: 'WhatsAppVisibilityFence',
  },
  {
    id: 'whatsapp-admission-omits-post-T-check',
    file: 'sources/whatsapp.ts',
    before: 'storedAt <= point.capturedAt ||',
    after: 'false ||',
    cell: 'W:admission-requires-post-T',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-admission-omits-visible-floor',
    file: 'sources/whatsapp.ts',
    before: '(visibleSince !== null && storedAt <= visibleSince)',
    after: 'false',
    cell: 'W:widening-floors-newly-visible-units',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-narrowing-keeps-visible-unit',
    file: 'runtime/whatsapp-visibility.ts',
    before: 'for (const unitKey of newlyHiddenUnits)',
    after: 'for (const unitKey of [] as string[])',
    cell: 'W:narrowing-purges-unowed-snapshot-keys',
    exportName: 'WhatsAppVisibilityFence',
  },
  {
    id: 'unconditional-resend-anchor',
    file: 'sources/resend.ts',
    before: 'WHERE id = ? AND encrypted_record = ? AND staged_at IS ? AND stage_expires_at IS ?',
    after: 'WHERE id = ?',
    cell: 'R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing',
    exportName: 'ResendReceivedSource',
  },
  {
    id: 'slack-top-level-only-finalisation',
    file: 'sources/slack-replies.ts',
    before: `return (
      this.#database
        .prepare(
          \`SELECT 1 AS present FROM slack_reply_drains
           WHERE intent_id = ? AND account_id = ? AND conversation_id = ? AND drained_at IS NULL\`,
        )
        .get(input.intentId, input.accountId, input.conversationId) === undefined
    );`,
    after: 'return barrier.value.topLevelCovered;',
    cell: 'S:first-enabled-page-and-reply-barrier',
    exportName: 'SlackReplyDrains',
  },
  {
    id: 'slack-finalisation-installs-new-only-cursor',
    file: 'runtime/activations.ts',
    before: "this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intent.id);",
    after: `for (const point of points) {
        this.#store.database
          .prepare(
            \`INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
             VALUES (?, ?, ?, '{}', ?)
             ON CONFLICT(source, account_id, cursor_scope)
             DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at\`,
          )
          .run(point.source, point.accountId, point.positionScope, this.#now());
      }
      this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intent.id);`,
    cell: 'S:replace-new-only-baselines-at-P',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'slack-omit-reply-coverage-guard',
    file: 'runtime/replacements.ts',
    before: `if (input.scope.source === 'slack' && (input.slack?.historyCovered !== true || input.slack.repliesCovered !== true))
    return false;`,
    after: 'if (false) return false;',
    cell: 'S:replace-old-only-drains-history-and-replies',
    exportName: 'completeSourceReplacementDrain',
  },
  {
    id: 'slack-derived-debt-keeps-parent-version',
    file: 'runtime/replacements.ts',
    before: '.run(input.childVersion, input.ruleId, input.parentVersion);',
    after: '.run(input.parentVersion, input.ruleId, input.parentVersion);',
    cell: 'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing',
    exportName: 'transferStageDebtToDerivedRule',
  },
  {
    id: 'slack-swap-omits-old-only-debt-settlement',
    file: 'runtime/activations.ts',
    before: 'this.#settleOldOnlyStages(latest.replacement_of_version, points);',
    after: 'void latest;',
    cell: 'S:swap-drops-old-only-history-and-reply-debts',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'slack-initial-cursor-selects-latest-baseline',
    file: 'runtime/scheduler.ts',
    before: `    })[0] as string;
  }
  if (scope.source === 'resend') {`,
    after: `    }).at(-1) as string;
  }
  if (scope.source === 'resend') {`,
    cell: 'S:initial-cursor-is-after-baseline',
    exportName: 'EventScheduler',
  },
  {
    id: 'slack-initial-cursor-selects-latest-under-lock',
    file: 'runtime/scheduler.ts',
    before: `    })[0] as string;
  }
  if (scope.source === 'resend') {`,
    after: `    }).at(-1) as string;
  }
  if (scope.source === 'resend') {`,
    cell: 'S:initial-cursor-rechecks-points-under-conversation-lock',
    exportName: 'EventScheduler',
  },
  {
    id: 'slack-replacement-omits-earliest-history-cap',
    file: 'runtime/source-owner-work.ts',
    before: `const latest = replyDrains
      .slice(1)
      .reduce(
        (earliest, drain) => (compareSlackTimestamp(drain.through, earliest) < 0 ? drain.through : earliest),
        replyDrains[0]?.through ?? slackTimestamp((input.now ?? Date.now)()),
      );`,
    after: 'const latest = slackTimestamp((input.now ?? Date.now)());',
    cell: 'S:replace-shared-one-version-per-occurrence',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'slack-admits-candidates-not-after-p',
    file: 'runtime/source-owner-work.ts',
    before:
      'return compareSlackTimestamp(assertSlackTimestamp(candidate.timestamp), assertSlackTimestamp(timestamp)) > 0;',
    after: 'return true;',
    cell: 'S:enable-all-rebaselines-readded-scope',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'slack-disabled-baseline-later-rule-admits-before-own-point',
    file: 'runtime/source-owner-work.ts',
    before:
      'return compareSlackTimestamp(assertSlackTimestamp(candidate.timestamp), assertSlackTimestamp(timestamp)) > 0;',
    after: 'return true;',
    cell: 'S:first-disabled-baselines-without-content',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'slack-disabled-replacement-leaves-drain-open',
    file: 'runtime/activations.ts',
    before: 'disabled || (statusScope && !statusStageOwedByOld) ? this.#now() : null,',
    after: 'statusScope && !statusStageOwedByOld ? this.#now() : null,',
    cell: 'S:disabled-replacement-marks-drains-complete',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'slack-tightening-skips-child-pointer',
    file: 'runtime/replacements.ts',
    before:
      '"UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = \'rule\' AND object_id = ?",',
    after:
      '"UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = \'rule\' AND object_id = ? AND 0 = 1",',
    cell: 'S:tighten-preserves-old-P-and-new-boundary',
    exportName: 'applyDerivedTightening',
  },
  {
    id: 'slack-revocation-omits-active-scope-purge',
    file: 'runtime/revocations.ts',
    before: `database.database
      .prepare(
        "UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND state IN ('active', 'superseded')",
      )
      .run(Date.now(), ruleId);
    purgeRevokedRuleWork(database.database, ruleId, live);
    database.database.prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ?").run(ruleId);`,
    after: 'void ruleId; void live;',
    cell: 'S:disable-or-remove-cancels-and-purges',
    exportName: 'disableRule',
  },
  {
    id: 'slack-readd-omits-account-purge',
    file: 'runtime/account-fence.ts',
    before:
      "const scope: EventAccountScope = typeof account === 'string' ? { source: 'gmail', accountId: account } : account;",
    after: 'void database; void account; void now; return;',
    cell: 'S:remove-readd-stays-dark',
    exportName: 'purgeRemovedAccountWork',
  },
  {
    id: 'slack-recovery-skips-claimed-completion',
    file: 'runtime/activations.ts',
    before: "WHERE status IN ('pending', 'pending-completion')\",",
    after: 'WHERE 1 = 0",',
    cell: 'S:claim-recovery-resumes-same-drain',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'slack-timeout-omits-deadline-settlement',
    file: 'runtime/activations.ts',
    before: `this.#store.database
      .prepare("UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?")
      .run(code, this.#now(), intentId);
    this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intentId);
    this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intentId);`,
    after: `void intentId;
    void code;`,
    cell: 'S:timeout-keeps-watermark-and-retries',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'slack-omits-ordinary-reply-reconciliation',
    file: 'runtime/source-owner-work.ts',
    before: 'await ordinaryReplies.resumeOne({ accountId: scope.accountId, conversationId, latest });',
    after: 'void latest;',
    cell: 'S:first-enabled-page-and-reply-barrier',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'whatsapp-raw-z-pk-identity',
    file: 'sources/whatsapp.ts',
    before: guards.rawKey,
    after: `return canonicalJson(['wa-msg', chatJid, senderJidRaw, \`Z_PK:\${stanzaId}\`]);`,
    cell: 'W:replace-shared-raw-key-one-version',
    exportName: 'rawWhatsAppMessageId',
  },
  {
    id: 'whatsapp-raw-z-pk-initial-baseline',
    file: 'sources/whatsapp.ts',
    before: guards.rawKey,
    after: `return canonicalJson(['wa-msg', chatJid, senderJidRaw, \`Z_PK:\${stanzaId}\`]);`,
    cell: 'W:initial-baseline-generation-and-identities-atomic',
    exportName: 'rawWhatsAppMessageId',
  },
  {
    id: 'source-scope-fence',
    file: 'sources/source-scope-fence.ts',
    before: "AND activation_intents.status = 'pending-completion'",
    after: 'AND 1 = 0',
    cell: 'S:claimed-P-fences-history-and-reply-worker',
    exportName: 'initialCursorStillCurrent',
  },
  {
    id: 'initial-cursor-outside-scope-lock',
    file: 'runtime/scheduler.ts',
    before: 'if (!initialCursorStillCurrent(this.#store.database, scope, canonical)) return false;',
    after: 'if (false) return false;',
    cell: 'S:initial-cursor-rechecks-points-under-conversation-lock',
    exportName: 'EventScheduler',
  },
  {
    id: 'skip-published-point-reread',
    file: 'sources/source-scope-fence.ts',
    before: guards.pointReread,
    after: 'true',
    cell: 'R:initial-cursor-rechecks-points-under-received-and-status-locks',
    exportName: 'initialCursorStillCurrent',
  },
  {
    id: 'leave-transferred-debt-on-parent',
    file: 'runtime/replacements.ts',
    before: '.run(input.childVersion, input.ruleId, input.parentVersion);',
    after: '.run(input.parentVersion, input.ruleId, input.parentVersion);',
    cell: 'W:tighten-transfers-first-representation-admissions-stale-snapshot-writes-nothing',
    exportName: 'transferStageDebtToDerivedRule',
  },
  {
    id: 'stale-slack-scan-commits',
    file: 'sources/slack.ts',
    before: `const settings = this.#store.database.prepare('SELECT paused FROM event_settings WHERE singleton = 1').get() as
      | { paused: number }
      | undefined;
    if (settings === undefined || settings.paused !== snapshot.paused || settings.paused !== 0)
      throw new StaleSourceWriteError();
    assertSourceWriteStillLive(this.#store.database, scope, snapshot, () => {
      const current = this.#rules();
      // The callback above is the authoritative set. \`rules\` only keeps the input type visible at the write site.
      void rules;
      return current;
    });`,
    after: 'void scope; void snapshot; void rules;',
    cell: 'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing',
    exportName: 'SlackHistorySource',
  },
  {
    id: 'shared-scope-admits-under-both-versions',
    file: 'sources/slack.ts',
    before: 'compareSlackTimestamp(message.ts, scan.state.oldest) <= 0 ||',
    after: 'true ||',
    cell: 'S:replace-shared-one-version-per-occurrence',
    exportName: 'SlackHistorySource',
  },
  {
    id: 'retain-old-only-debt-at-swap',
    file: 'runtime/replacements.ts',
    before: 'if (retained) continue;',
    after: 'if (true) continue;',
    cell: 'R:swap-drops-old-only-received-and-status-debts',
    exportName: 'settleOldOnlyStageDebts',
  },
  {
    id: 'retain-old-only-whatsapp-debt-at-swap',
    file: 'runtime/replacements.ts',
    before: 'if (retained) continue;',
    after: 'if (true) continue;',
    cell: 'W:swap-drops-old-only-first-representation-debt',
    exportName: 'settleOldOnlyStageDebts',
  },
  {
    id: 'deadline-before-claim',
    file: 'runtime/activations.ts',
    before: guards.deadlineClaim,
    after: 'if (false) {',
    cell: 'S:deadline-at-P-after-P-and-finalise-settles-without-write',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'deadline-after-baseline',
    file: 'runtime/activations.ts',
    before: guards.deadlineBaseline,
    after: 'if (false) {',
    cell: 'R:deadline-at-P-after-P-and-finalise-settles-without-write',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'deadline-before-finalise',
    file: 'runtime/activations.ts',
    before: guards.deadlineFinalise,
    after: 'if (false) {',
    cell: 'W:deadline-at-P-after-P-and-finalise-settles-without-head-write',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'deadline-before-finalise-whatsapp-timeout',
    file: 'runtime/activations.ts',
    before: guards.deadlineFinalise,
    after: 'if (false) {',
    cell: 'W:timeout-discards-candidate-not-head',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-first-received-anchor-prefix',
    file: 'sources/resend.ts',
    before: 'const effectivePageIds = foundAnchor ? pageIds.slice(0, pageIds.indexOf(state.anchorId) + 1) : pageIds;',
    after: 'const effectivePageIds = foundAnchor ? [] : pageIds;',
    cell: 'R:first-enabled-received-and-status',
    exportName: 'ResendReceivedSource',
  },
  {
    id: 'resend-disabled-status-scope',
    file: 'sources/resend.ts',
    before: "return selected.kinds.map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    after:
      "return selected.kinds.filter((kind) => kind === 'received').map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    cell: 'R:first-disabled-seeds-anchor-and-status',
    exportName: 'createResendLocalEventSource',
  },
  {
    id: 'resend-old-only-drain-cap',
    file: 'sources/resend.ts',
    before: `const cap = this.#drainCap;
      if (cap !== undefined && state.cycleCapId === undefined) {`,
    after: `const cap = undefined;
      if (cap !== undefined && state.cycleCapId === undefined) {`,
    cell: 'R:replace-old-only-drains-received-and-status',
    exportName: 'ResendReceivedSource',
  },
  {
    id: 'resend-new-only-replacement-plan',
    file: 'runtime/activations.ts',
    before: 'const points = [...this.#pointsForRule(oldRule), ...this.#pointsForRule(newRule)];',
    after: 'const points = [...this.#pointsForRule(oldRule)];',
    cell: 'R:replace-new-only-baselines-at-anchor',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-shared-swap-pointer',
    file: 'runtime/activations.ts',
    before:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ?",
    after:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ? AND 0 = 1",
    cell: 'R:replace-shared-one-version-per-occurrence',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-later-drain-certifies-behind-earlier-cap',
    file: 'runtime/source-owner-work.ts',
    before: 'else if (advancedAnchorIndex < 0 || pointIndex < advancedAnchorIndex) {',
    after: 'else if (advancedAnchorIndex < 0) {',
    cell: 'R:replace-shared-one-version-per-occurrence',
    exportName: 'runSourceOwnerWork',
  },
  {
    id: 'resend-status-replacement-marks-staged-debt-drained',
    file: 'runtime/activations.ts',
    before: 'disabled || (statusScope && !statusStageOwedByOld) ? this.#now() : null,',
    after: 'disabled || statusScope ? this.#now() : null,',
    cell: 'R:swap-drops-old-only-received-and-status-debts',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-status-high-water-uses-raw-wall-clock',
    file: 'sources/resend-status.ts',
    before: 'const startedAt = prior !== undefined && priorAt >= now ? prior.high_water_at : sampledAt;',
    after: 'const startedAt = sampledAt;',
    cell: 'R:claimed-P-fences-received-and-status-worker',
    exportName: 'ResendStatusSource',
  },
  {
    id: 'resend-disabled-replacement-leaves-drain-open',
    file: 'runtime/activations.ts',
    before: 'const disabled = !this.#switch().enabled;',
    after: 'const disabled = false;',
    cell: 'R:disabled-replacement-marks-drains-complete',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-enable-readd-live-account-points',
    file: 'runtime/activations.ts',
    before: 'points.push(...this.#pointsForRule(planned.rule).filter((point) => live.has(point.accountId)));',
    after: 'points.push(...this.#pointsForRule(planned.rule).filter(() => false));',
    cell: 'R:enable-all-rebaselines-readded-account',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-tightening-keeps-old-pointer',
    file: 'runtime/replacements.ts',
    before:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ?",
    after:
      "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ? AND 0 = 1",
    cell: 'R:tighten-preserves-anchor-and-status-seed',
    exportName: 'applyDerivedTightening',
  },
  {
    id: 'resend-disable-retains-source-points',
    file: 'runtime/revocations.ts',
    before: 'purgeRevokedRuleWork(database.database, ruleId, live);',
    after: 'void ruleId; void live;',
    cell: 'R:disable-or-remove-cancels-and-purges',
    exportName: 'disableRule',
  },
  {
    id: 'resend-remove-readd-keeps-old-point',
    file: 'runtime/account-fence.ts',
    before: 'const { accountId, source } = scope;',
    after: "if (scope.source === 'resend') return;\n  const { accountId, source } = scope;",
    cell: 'R:remove-readd-stays-dark',
    exportName: 'purgeRemovedAccountWork',
  },
  {
    id: 'resend-claim-recovery-skips-completion',
    file: 'runtime/activations.ts',
    before: `    for (const storedIntent of rows) {
      let intent = storedIntent;`,
    after: `    for (const storedIntent of [] as IntentRow[]) {
      let intent = storedIntent;`,
    cell: 'R:claim-recovery-resumes-same-cycle',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-timeout-failure-write',
    file: 'runtime/activations.ts',
    before: "UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?",
    after: "UPDATE activation_intents SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ? AND 0 = 1",
    cell: 'R:timeout-keeps-anchor-and-retries',
    exportName: 'ActivationRuntime',
  },
  {
    id: 'resend-source-scope-fence',
    file: 'sources/source-scope-fence.ts',
    before: "AND activation_intents.status = 'pending-completion'",
    after: 'AND 1 = 0',
    cell: 'R:claimed-P-fences-received-and-status-worker',
    exportName: 'initialCursorStillCurrent',
  },
  {
    id: 'resend-initial-status-scope',
    file: 'sources/resend.ts',
    before: "return selected.kinds.map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    after:
      "return selected.kinds.filter((kind) => kind === 'received').map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    cell: 'R:initial-anchor-and-status-start-atomic',
    exportName: 'createResendLocalEventSource',
  },
];

/** Keeps a new Slack matrix name from silently falling back to no destructive oracle. */
export function assertSlackMatrixMutationCoverage(cells: readonly string[]): void {
  const declared = new Set(cells);
  const slack = CUTOVER_MUTATIONS.filter((mutation) => mutation.cell.startsWith('S:'));
  for (const mutation of slack)
    assert.equal(
      declared.has(mutation.cell),
      true,
      `${mutation.id}: Slack mutations must name one of this source's matrix cells`,
    );
  const covered = new Set(slack.map((mutation) => mutation.cell));
  for (const cell of cells)
    assert.equal(covered.has(cell), true, `${cell}: every Slack matrix cell needs a destructive mutation`);
}

export interface MutantCopy {
  readonly root: string;
  readonly mutation: CutoverMutation;
  readonly changedLine: number;
  readonly module: Record<string, unknown>;
}

/**
 * Task 8 makes a named matrix cell the only oracle for each Resend mutation.
 * Keeping this beside the runner prevents a future R: cell from silently
 * escaping mutation coverage or a mutation from being redirected to a smaller
 * unit test.
 */
export function assertResendMutationCoverage(cells: readonly string[]): void {
  const resendCells = cells.filter((cell) => cell.startsWith('R:'));
  const resendMutations = CUTOVER_MUTATIONS.filter((mutation) => mutation.cell.startsWith('R:'));
  const named = new Set(resendCells);
  for (const mutation of resendMutations)
    assert.ok(named.has(mutation.cell), `${mutation.id}: names a real Resend matrix cell`);
  for (const cell of resendCells)
    assert.ok(
      resendMutations.some((mutation) => mutation.cell === cell),
      `${cell}: needs at least one destructive Resend mutation`,
    );
}

/** Keeps WhatsApp's matrix ownership total: every cell kills a named mutation in its own cut-over file. */
export function assertWhatsAppCutoverMutationContract(cells: readonly string[]): void {
  const matrixCells = new Set(cells);
  const mutations = CUTOVER_MUTATIONS.filter((mutation) => mutation.cell.startsWith('W:'));
  for (const mutation of mutations)
    assert.ok(
      matrixCells.has(mutation.cell),
      `${mutation.id}: ${mutation.cell} names a WhatsApp matrix cell in whatsapp-cutover.test.ts`,
    );
  for (const cell of cells)
    assert.ok(
      mutations.some((mutation) => mutation.cell === cell),
      `${cell}: owns at least one WhatsApp destructive mutation`,
    );
}

/** Runs the source's focused S/R/W matrix against the copied production tree. */
export async function expectMatrixCellToKillMutant(copy: MutantCopy): Promise<void> {
  const copiedTests = join(copy.root, 'test');
  const sourceTest = copy.mutation.cell.startsWith('S:')
    ? 'slack-cutover.test.ts'
    : copy.mutation.cell.startsWith('R:')
      ? 'resend-cutover.test.ts'
      : 'whatsapp-cutover.test.ts';
  if (copy.mutation.cell.startsWith('S:'))
    assert.equal(
      sourceTest,
      'slack-cutover.test.ts',
      `${copy.mutation.id}: its Slack mutation must run only its named Slack matrix cell`,
    );
  const isMatrixCellTest =
    sourceTest === 'whatsapp-cutover.test.ts' ||
    sourceTest === 'slack-cutover.test.ts' ||
    sourceTest === 'resend-cutover.test.ts';
  if (copy.mutation.cell.startsWith('W:')) {
    assert.equal(sourceTest, 'whatsapp-cutover.test.ts', `${copy.mutation.id}: runs only its WhatsApp matrix file`);
    assert.equal(isMatrixCellTest, true, `${copy.mutation.id}: uses the exact matrix-cell name gate`);
  }
  const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        ...(isMatrixCellTest
          ? ['--test-name-pattern', `^${copy.mutation.cell.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`]
          : []),
        join(copiedTests, sourceTest),
      ],
      { cwd: copy.root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  assert.notEqual(
    result.code,
    0,
    `${copy.mutation.id}: ${copy.mutation.cell} unexpectedly accepted mutant src/${copy.mutation.file}:${copy.changedLine}\n${result.output}`,
  );
}

const packageRoot = join(import.meta.dirname, '..', '..');
const productionSource = join(packageRoot, 'src');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Builds, imports and always removes a one-edit copy of production source. */
export async function withCutoverMutant<T>(
  mutation: CutoverMutation,
  work: (copy: MutantCopy) => Promise<T>,
): Promise<T> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    const copiedSource = join(root, 'src');
    await cp(productionSource, copiedSource, { recursive: true });
    // B2's network modules import checked-in test fixtures at module evaluation time.  Copy the whole test tree
    // before importing the mutant so every production import resolves exactly as it does from the package root.
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    const target = join(copiedSource, mutation.file);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(packageRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const mutated = original.replace(mutation.before, mutation.after);
    assert.notEqual(mutated, original, `${mutation.id}: production mutation must change behaviour-bearing source`);
    await writeFile(target, mutated, 'utf8');
    const module = (await import(`${pathToFileURL(target).href}?mutation=${mutation.id}`)) as Record<string, unknown>;
    assert.equal(typeof module[mutation.exportName], 'function', `${mutation.id}: mutant runtime export loads`);
    return await work({ root, mutation, changedLine, module });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
