import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUTOVER_MUTATIONS, expectMatrixCellToKillMutant, withCutoverMutant } from './support/cutover-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('D8: every destructive cut-over mutation is a one-edit imported production copy with a named matrix oracle', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  for (const mutation of CUTOVER_MUTATIONS) {
    await withCutoverMutant(mutation, async (copy) => {
      assert.ok(copy.changedLine > 0, `${mutation.id}: changed production line is recorded`);
      await expectMatrixCellToKillMutant(copy);
      t.diagnostic(`${mutation.id}: src/${mutation.file}:${copy.changedLine} -> ${mutation.cell}`);
    });
  }
});
