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
    before: 'this.commitCandidate(snapshot.visibility, generation, stageable, debts, encrypted);',
    after: 'this.commitCandidate(snapshot.visibility, generation, stageable, debts, new Map());',
    cell: 'W:first-enabled-stages-before-copy-dispose',
    exportName: 'WhatsAppSourceWorker',
  },
  {
    id: 'whatsapp-early-head',
    file: 'sources/whatsapp.ts',
    before: 'const before = this.currentHead();',
    after: `this.commitCandidate(snapshot.visibility, generation, [], debts, encrypted);
      const before = this.currentHead();`,
    cell: 'W:first-enabled-stages-before-copy-dispose',
    exportName: 'WhatsAppSourceWorker',
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
    id: 'whatsapp-raw-z-pk-identity',
    file: 'sources/whatsapp.ts',
    before: guards.rawKey,
    after: `return canonicalJson(['wa-msg', chatJid, senderJidRaw, \`Z_PK:\${stanzaId}\`]);`,
    cell: 'W:replace-shared-raw-key-one-version',
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
];

export interface MutantCopy {
  readonly root: string;
  readonly mutation: CutoverMutation;
  readonly changedLine: number;
  readonly module: Record<string, unknown>;
}

/** Runs the source's focused S/R/W matrix against the copied production tree. */
export async function expectMatrixCellToKillMutant(copy: MutantCopy): Promise<void> {
  const copiedTests = join(copy.root, 'test');
  const sourceTest = (() => {
    switch (copy.mutation.id) {
      case 'slack-top-level-only-finalisation':
        return 'slack-reply-drains.test.ts';
      case 'source-scope-fence':
        return 'source-scope-fence.test.ts';
      case 'initial-cursor-outside-scope-lock':
        return 'd-source-scheduler.test.ts';
      case 'skip-published-point-reread':
        return 'initial-cursor-fence.test.ts';
      case 'leave-transferred-debt-on-parent':
      case 'retain-old-only-debt-at-swap':
        return 'd-source-replacement.test.ts';
      case 'stale-slack-scan-commits':
        return 'slack-write-fence.test.ts';
      default:
        return copy.mutation.cell.startsWith('S:')
          ? 'slack-cutover.test.ts'
          : copy.mutation.cell.startsWith('R:')
            ? 'resend-cutover.test.ts'
            : 'whatsapp-cutover.test.ts';
    }
  })();
  const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--test', join(copiedTests, sourceTest)],
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
