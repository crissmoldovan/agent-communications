import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  B3_APPROVAL_VIEW_VARIANTS,
  B3_CAPABILITIES,
  B3_CONTROL_CONTRACT,
  B3_EXCEPTION_REASON_SECRET,
  B3_JUDGE_UNAVAILABLE_VARIANTS,
} from '../src/operations/b3-contract.ts';

const ROOT = join(import.meta.dirname, '../../..');

/** The approved plan, rather than a test-local capability table, is the B3-2 source of truth. */
async function plannedRows(): Promise<
  ReadonlyArray<{ readonly id: string; readonly cli: string; readonly mcp: string | null; readonly operation: string }>
> {
  const plan = await readFile(join(ROOT, 'docs/superpowers/plans/2026-10-10-events-phase-b3.md'), 'utf8');
  const table = plan.slice(
    plan.indexOf('| Capability id |'),
    plan.indexOf('#### Complete exception register after B3'),
  );
  return table
    .split('\n')
    .filter((line) => line.startsWith('| `events-daemon.'))
    .map((line) => line.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll('\\|', '|').replaceAll('`', '')))
    .map((cells) => {
      const [_, id, cli, mcp, operation] = cells;
      if (!id || !cli || !mcp || !operation) throw new Error(`the B3-2 row is malformed: ${cells.join(' | ')}`);
      return { id, cli, mcp: mcp === '—' ? null : mcp, operation };
    });
}

async function plannedExceptionReasons(): Promise<ReadonlyMap<string, string>> {
  const plan = await readFile(join(ROOT, 'docs/superpowers/plans/2026-10-10-events-phase-b3.md'), 'utf8');
  const register = plan.slice(plan.indexOf('| Capability | CLI operation | MCP | reason |'), plan.indexOf('### B3-3'));
  const rows = register
    .split('\n')
    .filter((line) => line.startsWith('| events-daemon.'))
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .flatMap((cells) => {
      const [id, reason] = [cells[1], cells[4]];
      return typeof id === 'string' && typeof reason === 'string' && id && reason ? [[id, reason] as const] : [];
    });
  const reasons = new Map<string, string>(rows);
  const spec = await readFile(join(ROOT, 'docs/superpowers/specs/2026-10-05-local-event-emission-design.md'), 'utf8');
  const secretReason = /with the\s+reason:\s*"([^"]+)"/.exec(spec)?.[1]?.replace(/\s+/g, ' ');
  if (!secretReason) throw new Error('the local-event specification has no exact secret exception reason');
  for (const capability of B3_CAPABILITIES.filter((entry) => entry.secret === true))
    reasons.set(capability.id, secretReason);
  return reasons;
}

test('B3 capability contract pins every B3-2 command, tool absence and owner operation from the approved plan', async () => {
  const planned = await plannedRows();
  const exceptionReasons = await plannedExceptionReasons();
  assert.equal(planned.length, 34, 'the plan has the complete B3-2 capability delta');
  assert.deepEqual(
    B3_CAPABILITIES.map(({ id, cli, mcp, operation }) => ({ id, cli, mcp, operation })),
    planned,
  );
  for (const capability of B3_CAPABILITIES) {
    assert.equal(
      capability.status,
      capability.mcp === null ? 'exception' : 'both',
      `${capability.id} has its B3-2 status`,
    );
  }
  for (const capability of B3_CAPABILITIES.filter((entry) => entry.mcp === null)) {
    assert.equal(capability.status, 'exception', `${capability.id} is a deliberate terminal-only exception`);
    assert.equal(
      capability.reason,
      exceptionReasons.get(capability.id),
      `${capability.id} has its exact exception reason`,
    );
  }
  const secretExceptions = B3_CAPABILITIES.filter((entry) => entry.secret === true);
  assert.equal(secretExceptions.length, 8, 'D10 gives every named secret action its own closed exception row');
  assert.ok(secretExceptions.every((entry) => entry.reason === B3_EXCEPTION_REASON_SECRET));
});

test('B3 contract exports data-only approval and E/E2 result grammars for desktop and future judge consumers', () => {
  assert.deepEqual(B3_APPROVAL_VIEW_VARIANTS, ['READY', 'STALE_APPROVAL', 'DIGEST_MISMATCH', 'CHALLENGE_EXPIRED']);
  assert.deepEqual(B3_JUDGE_UNAVAILABLE_VARIANTS, [
    { code: 'E_REQUIRED', phase: 'E' },
    { code: 'E2_REQUIRED', phase: 'E2' },
  ]);
  assert.equal(B3_CONTROL_CONTRACT.version, 'b3-control-v1');
  assert.deepEqual(B3_CONTROL_CONTRACT.capabilities, B3_CAPABILITIES);
  assert.deepEqual(B3_CONTROL_CONTRACT.approvalView, B3_APPROVAL_VIEW_VARIANTS);
  assert.deepEqual(B3_CONTROL_CONTRACT.judgeUnavailable, B3_JUDGE_UNAVAILABLE_VARIANTS);
});
