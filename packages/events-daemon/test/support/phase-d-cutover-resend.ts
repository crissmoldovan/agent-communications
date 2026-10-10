import assert from 'node:assert/strict';
import type { DurableCutoverEdge } from '../../src/runtime/cutover-failpoint.ts';
import { DURABLE_CUTOVER_EDGES } from '../../src/runtime/cutover-failpoint.ts';
import { PhaseDCutoverFixture } from './phase-d-cutover.ts';

/** The complete Task-8 Resend cut-over matrix; shared with mutation coverage. */
export const RESEND_CUTOVER_CELLS = [
  'R:first-enabled-received-and-status',
  'R:first-disabled-seeds-anchor-and-status',
  'R:replace-old-only-drains-received-and-status',
  'R:replace-new-only-baselines-at-anchor',
  'R:replace-shared-one-version-per-occurrence',
  'R:disabled-replacement-marks-drains-complete',
  'R:enable-all-rebaselines-readded-account',
  'R:tighten-preserves-anchor-and-status-seed',
  'R:disable-or-remove-cancels-and-purges',
  'R:remove-readd-stays-dark',
  'R:claim-recovery-resumes-same-cycle',
  'R:timeout-keeps-anchor-and-retries',
  'R:initial-anchor-and-status-start-atomic',
  'R:claimed-P-fences-received-and-status-worker',
  'R:initial-cursor-rechecks-points-under-received-and-status-locks',
  'R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing',
  'R:swap-drops-old-only-received-and-status-debts',
  'R:deadline-at-P-after-P-and-finalise-settles-without-write',
] as const;

/**
 * The Resend matrix deliberately crashes the production activation path, then
 * reopens its real SQLite state and fake-provider journal.  Keeping that
 * ceremony here makes an omitted edge conspicuous in every named cell.
 */
export async function forEachResendDurableEdge(
  cell: string,
  scenario: (
    fixture: PhaseDCutoverFixture,
    edge: DurableCutoverEdge | undefined,
    report: (outcome: ResendDurableEdgeRun['outcome']) => void,
  ) => Promise<void>,
  record: (input: ResendDurableEdgeRun) => void,
): Promise<void> {
  for (const edge of [undefined, ...DURABLE_CUTOVER_EDGES] as const) {
    const fixture = await PhaseDCutoverFixture.create('resend');
    try {
      let reported = false;
      await scenario(fixture, edge, (outcome) => {
        assert.equal(reported, false, `${cell}: ${edge ?? 'no-crash'} may have only one durable-edge outcome`);
        reported = true;
        record({ cell, edge, outcome });
      });
      assert.equal(reported, true, `${cell}: ${edge ?? 'no-crash'} bypassed the durable-edge harness`);
    } finally {
      await fixture.dispose();
    }
  }
}

/** One independently asserted no-crash/crash-edge outcome for the matrix coverage ledger. */
export type ResendDurableEdgeRun = Readonly<{
  readonly cell: string;
  readonly edge: DurableCutoverEdge | undefined;
  readonly outcome: 'no-crash' | 'fired' | 'unreachable';
}>;

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
  input: Readonly<{
    providerFenced?: boolean;
    /** A derived transition has no durable activation move to crash. */
    assertUnreachable?: (() => void | Promise<void>) | undefined;
    /**
     * Exact replacements first return REPLACEMENT_DRAINING.  Pointer edges
     * belong to that same claimed activation, so finish its real drain while
     * the failpoint is still armed instead of accepting those edges unseen.
     */
    finishClaimedCompletion?: (() => Promise<void>) | undefined;
    whileFenced?: (() => Promise<void>) | undefined;
    report?: ((outcome: ResendDurableEdgeRun['outcome']) => void) | undefined;
  }> = {},
): Promise<void> {
  if (edge === undefined) {
    await activation();
    input.report?.('no-crash');
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
    if (!fired && input.finishClaimedCompletion !== undefined) await input.finishClaimedCompletion();
  } catch (error) {
    if (!new RegExp(`${cell}: crash at ${edge}`).test(String(error))) throw error;
    crashed = true;
  }
  if (!crashed) {
    assert.notEqual(
      input.assertUnreachable,
      undefined,
      `${cell}: ${edge} was expected to crash, or to assert that this transition cannot reach it`,
    );
    assert.equal(fired, false, `${cell}: ${edge} is explicitly unreachable in this transition`);
    await input.assertUnreachable?.();
    await fixture.setFailpoint(undefined);
    input.report?.('unreachable');
    return;
  }
  assert.equal(fired, true, `${cell}: ${edge} must be reached by the real transition`);

  await fixture.restart();
  if (input.whileFenced !== undefined) {
    await input.whileFenced();
  } else if (input.providerFenced !== false) {
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
  input.report?.('fired');
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
