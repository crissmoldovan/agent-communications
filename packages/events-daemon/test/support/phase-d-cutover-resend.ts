import assert from 'node:assert/strict';
import type { DurableCutoverEdge } from '../../src/runtime/cutover-failpoint.ts';
import { DURABLE_CUTOVER_EDGES } from '../../src/runtime/cutover-failpoint.ts';
import { PhaseDCutoverFixture } from './phase-d-cutover.ts';

/**
 * The Resend matrix deliberately crashes the production activation path, then
 * reopens its real SQLite state and fake-provider journal.  Keeping that
 * ceremony here makes an omitted edge conspicuous in every named cell.
 */
export async function forEachResendDurableEdge(
  _cell: string,
  scenario: (fixture: PhaseDCutoverFixture, edge: DurableCutoverEdge | undefined) => Promise<void>,
): Promise<void> {
  for (const edge of [undefined, ...DURABLE_CUTOVER_EDGES] as const) {
    const fixture = await PhaseDCutoverFixture.create('resend');
    try {
      await scenario(fixture, edge);
    } finally {
      await fixture.dispose();
    }
  }
}

/**
 * Complete one real activation at a durable edge.  Before recovery we run a
 * scheduler turn: an unpublished point must fence both Resend scopes before a
 * provider call can be made.  A selected edge that the operation never
 * reaches is an assertion failure, not a silently skipped crash case.
 */
export async function activateAtResendDurableEdge(
  fixture: PhaseDCutoverFixture,
  cell: string,
  edge: DurableCutoverEdge | undefined,
  activation: () => Promise<void>,
  input: Readonly<{ providerFenced?: boolean; allowUnreachedEdge?: boolean }> = {},
): Promise<void> {
  if (edge === undefined) {
    await activation();
    return;
  }

  let fired = false;
  await fixture.setFailpoint((at) => {
    if (at === edge) {
      fired = true;
      throw new Error(`${cell}: crash at ${edge}`);
    }
  });
  let crashed = false;
  try {
    await activation();
  } catch (error) {
    if (!new RegExp(`${cell}: crash at ${edge}`).test(String(error))) throw error;
    crashed = true;
  }
  if (!crashed) {
    assert.equal(
      input.allowUnreachedEdge,
      true,
      `${cell}: ${edge} was expected to crash, or to assert that this transition cannot reach it`,
    );
    assert.equal(fired, false, `${cell}: ${edge} is explicitly unreachable in this transition`);
    await fixture.setFailpoint(undefined);
    return;
  }
  assert.equal(fired, true, `${cell}: ${edge} must be reached by the real transition`);

  await fixture.restart();
  if (input.providerFenced !== false) {
    const callsBeforeFenceProbe = fixture.calls.length;
    await assert.rejects(
      () => fixture.sourceTurn(),
      /fenced by an unpublished activation|no installed activation anchor/,
    );
    assert.equal(
      fixture.calls.length,
      callsBeforeFenceProbe,
      `${cell}: ${edge} leaves received and status provider calls fenced before recovery`,
    );
  }
  await fixture.recover();
}

export type ResendAdmission = Readonly<{
  readonly accountId?: string;
  readonly dedupeKey: string;
  readonly ruleVersion: number;
  readonly type?: 'resend.email.received' | 'resend.email.status_changed';
}>;

/** Exact durable occurrence/version oracle, rather than a cursor-only check. */
export function assertResendAdmissions(fixture: PhaseDCutoverFixture, expected: readonly ResendAdmission[]): void {
  const rows = fixture.store.database
    .prepare(
      `SELECT ingest.account_id AS accountId, ingest.dedupe_key AS dedupeKey, ingest.type AS type,
              decisions.rule_version AS ruleVersion
         FROM decisions
         JOIN ingest ON ingest.event_id = decisions.event_id
        WHERE ingest.type IN ('resend.email.received', 'resend.email.status_changed')
        ORDER BY ingest.account_id, ingest.dedupe_key, decisions.rule_version, ingest.type`,
    )
    .all()
    .map((row) => ({ ...row })) as ResendAdmission[];
  const canonical = (values: readonly ResendAdmission[]) =>
    values
      .map((value) => ({
        accountId: value.accountId,
        dedupeKey: value.dedupeKey,
        ruleVersion: value.ruleVersion,
        type: value.type,
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  assert.deepEqual(canonical(rows), canonical(expected), 'each Resend id has exactly one expected version admission');

  const raw = fixture.store.database
    .prepare(
      `SELECT account_id AS accountId, dedupe_key AS dedupeKey, type
         FROM ingest
        WHERE type IN ('resend.email.received', 'resend.email.status_changed')
        ORDER BY account_id, dedupe_key, type`,
    )
    .all()
    .map((row) => ({ ...row }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const expectedRaw = [
    ...new Map(
      canonical(expected)
        .map(({ accountId, dedupeKey, type }) => ({ accountId, dedupeKey, type }))
        .map((row) => [`${row.accountId}\u0000${row.dedupeKey}\u0000${row.type}`, row]),
    ).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  assert.deepEqual(raw, expectedRaw, 'the raw Resend id ledger has no loss, backfill, or duplicate identity');
}
