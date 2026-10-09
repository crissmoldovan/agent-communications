import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CutoverMutation, type MutantCopy, withCutoverMutant } from './support/cutover-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * Task 8 requires a destructive guard for every concrete Resend matrix row.
 * The production source is copied and patched for each one, so this test never
 * writes the working tree or reaches a provider.
 */
const RESEND_MUTATIONS: readonly CutoverMutation[] = [
  {
    id: 'resend-first-received-anchor-prefix',
    file: 'sources/resend.ts',
    before: 'const effectivePageIds = foundAnchor ? pageIds.slice(0, pageIds.indexOf(state.anchorId) + 1) : pageIds;',
    after: 'const effectivePageIds = foundAnchor ? [] : pageIds;',
    cell: 'R:first-enabled-received-and-status',
    exportName: 'ResendReceivedSource',
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
    id: 'resend-enable-readd-live-account-points',
    file: 'runtime/activations.ts',
    before: 'points.push(...this.#pointsForRule(planned.rule).filter((point) => live.has(point.accountId)));',
    after: 'points.push(...this.#pointsForRule(planned.rule).filter(() => false));',
    cell: 'R:enable-all-rebaselines-readded-account',
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
    id: 'resend-initial-status-scope',
    file: 'sources/resend.ts',
    before: "return selected.kinds.map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    after:
      "return selected.kinds.filter((kind) => kind === 'received').map((kind) => ({ source: 'resend', accountId, scopeId: kind }));",
    cell: 'R:initial-anchor-and-status-start-atomic',
    exportName: 'createResendLocalEventSource',
  },
  {
    id: 'resend-initial-cursor-point-reread',
    file: 'sources/source-scope-fence.ts',
    before: 'fingerprint(publishedSourcePointSet(database, scope)) === fingerprint(pointsReadBeforeDecrypt)',
    after: 'true',
    cell: 'R:initial-cursor-rechecks-points-under-received-and-status-locks',
    exportName: 'initialCursorStillCurrent',
  },
  {
    id: 'resend-tighten-received-stage-cas',
    file: 'sources/resend.ts',
    before: 'WHERE id = ? AND encrypted_record = ? AND staged_at IS ? AND stage_expires_at IS ?',
    after: 'WHERE id = ?',
    cell: 'R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing',
    exportName: 'ResendReceivedSource',
  },
  {
    id: 'resend-swap-retains-old-only-debt',
    file: 'runtime/replacements.ts',
    before: 'if (retained) continue;',
    after: 'if (true) continue;',
    cell: 'R:swap-drops-old-only-received-and-status-debts',
    exportName: 'settleOldOnlyStageDebts',
  },
];

test('D8: every real Resend received/status cut-over cell kills its destructive source mutation', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  for (const mutation of RESEND_MUTATIONS) {
    await withCutoverMutant(mutation, async (copy) => {
      await expectNamedResendCellToKillMutant(copy);
      t.diagnostic(`${mutation.id}: src/${mutation.file}:${copy.changedLine} -> ${mutation.cell}`);
    });
  }
});

async function expectNamedResendCellToKillMutant(copy: MutantCopy): Promise<void> {
  const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        '--test-name-pattern',
        `^${escapeRegex(copy.mutation.cell)}$`,
        join(copy.root, 'test', 'resend-cutover.test.ts'),
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
    `${copy.mutation.id}: ${copy.mutation.cell} accepted mutant src/${copy.mutation.file}:${copy.changedLine}\n${result.output}`,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
