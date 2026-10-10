import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DURABLE_CUTOVER_EDGES } from '../src/runtime/cutover-failpoint.ts';
import { assertSlackMatrixMutationCoverage } from './support/cutover-mutants.ts';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import {
  activateAtSlackDurableEdge,
  assertSlackOccurrences,
  forEachSlackDurableEdge,
  slackMessage as matrixSlackMessage,
  resumeClaimedSlackCompletionAtActivationEdge,
  schedulerTurnThroughSlackDurableEdge,
  slackScope,
  sourceTurnThroughSlackDurableEdge,
} from './support/phase-d-cutover-slack.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const cells = [
  'S:first-enabled-page-and-reply-barrier',
  'S:first-disabled-baselines-without-content',
  'S:replace-old-only-drains-history-and-replies',
  'S:replace-new-only-baselines-at-P',
  'S:replace-shared-one-version-per-occurrence',
  'S:disabled-replacement-marks-drains-complete',
  'S:enable-all-rebaselines-readded-scope',
  'S:tighten-preserves-old-P-and-new-boundary',
  'S:disable-or-remove-cancels-and-purges',
  'S:remove-readd-stays-dark',
  'S:claim-recovery-resumes-same-drain',
  'S:timeout-keeps-watermark-and-retries',
  'S:initial-cursor-is-after-baseline',
  'S:claimed-P-fences-history-and-reply-worker',
  'S:initial-cursor-rechecks-points-under-conversation-lock',
  'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing',
  'S:swap-drops-old-only-history-and-reply-debts',
  'S:deadline-at-P-after-P-and-finalise-settles-without-write',
] as const;

const matrixRuns = new Map<(typeof cells)[number], Set<string>>();

async function forEachSlackMatrixEdge(
  cell: (typeof cells)[number],
  run: (fixture: PhaseDCutoverFixture, edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined) => Promise<void>,
): Promise<void> {
  await forEachSlackDurableEdge(async (fixture, edge) => {
    await run(fixture, edge);
    let runs = matrixRuns.get(cell);
    if (runs === undefined) {
      runs = new Set();
      matrixRuns.set(cell, runs);
    }
    // The edge helpers assert either that the failpoint fired, or that this
    // particular continuation cannot reach it.  Recording only after the
    // scenario returns makes a skipped crash observable to the final oracle.
    runs.add(edge ?? 'no-crash');
  });
}

for (const name of cells) {
  test(name, { skip: WINDOWS_SKIP }, async () => {
    await runRequiredSlackMatrixCell(name);
  });
}

async function runRequiredSlackMatrixCell(name: (typeof cells)[number]): Promise<void> {
  switch (name) {
    case 'S:first-enabled-page-and-reply-barrier':
      await firstEnabledPageAndReplyBarrier();
      return;
    case 'S:first-disabled-baselines-without-content':
      await firstDisabledBaselinesWithoutContent();
      return;
    case 'S:replace-old-only-drains-history-and-replies':
      await replaceOldOnlyDrainsHistoryAndReplies();
      return;
    case 'S:replace-new-only-baselines-at-P':
      await replaceNewOnlyBaselinesAtP();
      return;
    case 'S:replace-shared-one-version-per-occurrence':
      await replaceSharedOneVersionPerOccurrence();
      return;
    case 'S:disabled-replacement-marks-drains-complete':
      await disabledReplacementMarksDrainsComplete();
      return;
    case 'S:enable-all-rebaselines-readded-scope':
      await enableAllRebaselinesReaddedScope();
      return;
    case 'S:tighten-preserves-old-P-and-new-boundary':
      await tightenPreservesOldPAndNewBoundary();
      return;
    case 'S:disable-or-remove-cancels-and-purges':
      await disableOrRemoveCancelsAndPurges();
      return;
    case 'S:remove-readd-stays-dark':
      await removeReaddStaysDark();
      return;
    case 'S:claim-recovery-resumes-same-drain':
      await claimRecoveryResumesSameDrain();
      return;
    case 'S:timeout-keeps-watermark-and-retries':
      await timeoutKeepsWatermarkAndRetries();
      return;
    case 'S:initial-cursor-is-after-baseline':
      await initialCursorIsAfterBaseline();
      return;
    case 'S:claimed-P-fences-history-and-reply-worker':
      await claimedPFencesHistoryAndReplyWorker();
      return;
    case 'S:initial-cursor-rechecks-points-under-conversation-lock':
      await initialCursorRechecksPointsUnderConversationLock();
      return;
    case 'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing':
      await tightenTransfersPageAndReplyDebts();
      return;
    case 'S:swap-drops-old-only-history-and-reply-debts':
      await swapDropsOldOnlyHistoryAndReplyDebts();
      return;
    case 'S:deadline-at-P-after-P-and-finalise-settles-without-write':
      await deadlineAtPAfterPAndFinaliseSettlesWithoutWrite();
      return;
    default:
      return assert.fail(`unimplemented Slack cut-over matrix cell: ${name}`);
  }
}

function emptySlackPages() {
  return {
    history: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
  };
}

async function startExactSlackReplacement(fixture: PhaseDCutoverFixture, options: unknown): Promise<void> {
  let draining = false;
  try {
    await fixture.activate(2, options, 'changed');
  } catch (error: unknown) {
    draining = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
    if (!draining) throw error;
  }
  assert.equal(draining, true, 'the production exact replacement remains claimed until the old Slack drain reaches P');
}

async function establishSlackCursor(
  fixture: PhaseDCutoverFixture,
  options: unknown = fixture.options(),
): Promise<void> {
  fixture.setSlackBaseline('1759999999.000000');
  fixture.setSlackPages(emptySlackPages());
  await fixture.activate(1, options);
  await fixture.enable();
  await fixture.schedulerTurn();
}

async function activateAndRecoverAtSlackEdge(
  fixture: PhaseDCutoverFixture,
  cell: (typeof cells)[number],
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  activate: () => Promise<void>,
): Promise<void> {
  await activateAtSlackDurableEdge(fixture, cell, edge, activate);
  await fixture.recover();
}

function activeRuleVersion(fixture: PhaseDCutoverFixture, ruleId = 'rule-cutover'): number | undefined {
  return (
    fixture.store.database
      .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = ?")
      .get(ruleId) as { version: number } | undefined
  )?.version;
}

function hasPendingSlackPoint(fixture: PhaseDCutoverFixture): boolean {
  return (
    (fixture.store.database
      .prepare(
        `SELECT 1 AS present
           FROM activation_baselines
           JOIN activation_intents ON activation_intents.id = activation_baselines.intent_id
          WHERE activation_baselines.source = 'slack'
            AND activation_baselines.account_id = ?
            AND activation_baselines.position_scope = ?
            AND activation_intents.status = 'pending-completion'`,
      )
      .get(fixture.accountId, fixture.scope.scopeId) as { present: number } | undefined) !== undefined
  );
}

async function finishSlackReplacementDrain(fixture: PhaseDCutoverFixture, cell: string): Promise<void> {
  for (let turns = 0; turns < 4; turns += 1) {
    const open = Number(
      (
        fixture.store.database
          .prepare('SELECT COUNT(*) AS count FROM replacement_drains WHERE drained_at IS NULL')
          .get() as { count: number }
      ).count,
    );
    if (open === 0) return;
    await fixture.sourceTurn();
  }
  assert.equal(
    Number(
      (
        fixture.store.database
          .prepare('SELECT COUNT(*) AS count FROM replacement_drains WHERE drained_at IS NULL')
          .get() as { count: number }
      ).count,
    ),
    0,
    `${cell}: the bounded replacement reply drain settles before pointer finalisation`,
  );
}

async function firstEnabledPageAndReplyBarrier(): Promise<void> {
  await forEachSlackMatrixEdge('S:first-enabled-page-and-reply-barrier', async (fixture, edge) => {
    const parent = '1760000001.100000';
    const reply = '1760000001.200000';
    const post = '1760000002.000000';
    let collect = false;
    fixture.setSlackBaseline('1759999999.000000');
    fixture.setSlackPages({
      history: async () => ({
        messages: collect ? [matrixSlackMessage({ ts: parent, replyCount: 1 }), matrixSlackMessage({ ts: post })] : [],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({
        messages: [matrixSlackMessage({ ts: reply, threadTs: parent })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
    });
    await fixture.activate();
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
    await fixture.enable();
    await fixture.schedulerTurn();
    fixture.now.value += 3_000;
    collect = true;
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    // The production reply reconciler deliberately spends one bounded page per
    // owner turn, after its parent history page has committed.
    await fixture.sourceTurn();
    fixture.oracle({ raw: 3, admissions: 3, versions: [1, 1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: parent, version: 1 },
      { ts: reply, version: 1 },
      { ts: post, version: 1 },
    ]);

    await assertFirstEnabledReplyBarrierAlsoFencesReplacementFinalisation();
  });
}

async function assertFirstEnabledReplyBarrierAlsoFencesReplacementFinalisation(): Promise<void> {
  const replacement = await PhaseDCutoverFixture.create('slack');
  try {
    const parent = '1760000001.000000';
    const reply = '1760000001.500000';
    const point = '1760000002.000000';
    const afterPoint = '1760000003.000000';
    await establishSlackCursor(replacement);
    replacement.now.value += 5_000;
    replacement.setSlackBaseline(point);
    replacement.setSlackPages({
      history: async () => ({
        messages: [
          matrixSlackMessage({ ts: parent, replyCount: 1 }),
          matrixSlackMessage({ ts: point }),
          matrixSlackMessage({ ts: afterPoint }),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async ({ cursor }) =>
        cursor === undefined || cursor === null
          ? {
              messages: [matrixSlackMessage({ ts: reply, threadTs: parent })],
              nextCursor: 'replacement-reply-page-2',
              retainedHistoryBoundary: false,
            }
          : { messages: [], nextCursor: null, retainedHistoryBoundary: false },
    });
    await startExactSlackReplacement(replacement, { channel: 'slack', conversations: ['C-new'] });
    await replacement.sourceTurn();
    await replacement.runtime.resumeClaimedCompletions();
    assert.equal(
      activeRuleVersion(replacement),
      1,
      'top-level coverage alone cannot finalise a replacement before the aggregate reply barrier reaches P',
    );
  } finally {
    await replacement.dispose();
  }
}

async function firstDisabledBaselinesWithoutContent(): Promise<void> {
  await forEachSlackMatrixEdge('S:first-disabled-baselines-without-content', async (fixture, edge) => {
    const point = '1760000002.000000';
    const before = '1760000001.000000';
    const between = '1760000003.000000';
    const laterPoint = '1760000004.000000';
    const after = '1760000005.000000';
    fixture.setSlackBaseline(point);
    await activateAndRecoverAtSlackEdge(fixture, 'S:first-disabled-baselines-without-content', edge, () =>
      fixture.activate(),
    );
    const storedPoint = fixture.store.database
      .prepare(
        `SELECT encrypted_position
           FROM rule_activation_points
          WHERE source = 'slack' AND account_id = ? AND position_scope = ?
            AND rule_id = 'rule-cutover' AND rule_version = 1`,
      )
      .get(fixture.accountId, fixture.scope.scopeId) as { encrypted_position: Uint8Array } | undefined;
    assert.ok(storedPoint?.encrypted_position.byteLength, 'disabled activation records its encrypted Slack P');
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });

    fixture.setSlackPages(emptySlackPages());
    await fixture.enable();
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.setSlackBaseline(laterPoint);
    await fixture.activateAdditionalRule('rule-later');
    fixture.setSlackPages({
      history: async () => ({
        messages: [
          matrixSlackMessage({ ts: before }),
          matrixSlackMessage({ ts: between }),
          matrixSlackMessage({ ts: after }),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 2, admissions: 3, versions: [1, 1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: between, version: 1 },
      { ts: after, version: 1 },
      { ts: after, version: 1 },
    ]);
    assert.equal(
      fixture.store.database.prepare('SELECT 1 FROM ingest WHERE dedupe_key LIKE ?').get(`%${before}%`),
      undefined,
      'enable-all never admits a message strictly before the disabled-time point',
    );
  });
}

async function disabledReplacementMarksDrainsComplete(): Promise<void> {
  await forEachSlackMatrixEdge('S:disabled-replacement-marks-drains-complete', async (fixture, edge) => {
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate();
    await activateAndRecoverAtSlackEdge(fixture, 'S:disabled-replacement-marks-drains-complete', edge, () =>
      fixture.replaceWhileDisabled(),
    );
    assert.equal(activeRuleVersion(fixture), 2, 'a disabled replacement completes without waiting for a worker');
    assert.equal(
      Number(
        (
          fixture.store.database
            .prepare("SELECT COUNT(*) AS count FROM replacement_drains WHERE source = 'slack'")
            .get() as { count: number }
        ).count,
      ),
      0,
      'the disabled replacement leaves no durable Slack drain behind',
    );
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
  });
}

async function tightenPreservesOldPAndNewBoundary(): Promise<void> {
  await forEachSlackMatrixEdge('S:tighten-preserves-old-P-and-new-boundary', async (fixture, edge) => {
    const point = '1760000001.000000';
    const after = '1760000002.000000';
    fixture.setSlackBaseline(point);
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate();
    await fixture.enable();
    await fixture.schedulerTurn();
    const callsBeforeTightening = fixture.calls.length;
    await fixture.tighten();
    assert.equal(fixture.calls.length, callsBeforeTightening, 'a derived tightening makes no Slack provider call');
    assert.equal(activeRuleVersion(fixture), 2, 'the derived pointer publishes the child with the inherited P');
    fixture.now.value += 2_000;
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: after })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    fixture.oracle({ raw: 1, admissions: 1, versions: [2] });
    assertSlackOccurrences(fixture, [{ ts: after, version: 2 }]);
  });
}

async function disableOrRemoveCancelsAndPurges(): Promise<void> {
  await forEachSlackMatrixEdge('S:disable-or-remove-cancels-and-purges', async (fixture, edge) => {
    fixture.setSlackPages(emptySlackPages());
    await activateAndRecoverAtSlackEdge(fixture, 'S:disable-or-remove-cancels-and-purges', edge, () =>
      fixture.activate(),
    );
    await fixture.enable();
    await fixture.schedulerTurn();
    await fixture.revokeByRule();
    const callsBeforeRevokedTurn = fixture.calls.length;
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    assert.equal(
      fixture.calls.length,
      callsBeforeRevokedTurn,
      'a newly due revoked scope makes no Slack provider call',
    );
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: callsBeforeRevokedTurn });
  });
}

async function removeReaddStaysDark(): Promise<void> {
  await forEachSlackMatrixEdge('S:remove-readd-stays-dark', async (fixture, edge) => {
    const oldPoint = '1760000001.000000';
    const newPoint = '1760000003.000000';
    const beforeReapproval = '1760000002.000000';
    const afterReapproval = '1760000004.000000';
    fixture.setSlackBaseline(oldPoint);
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate();
    await fixture.enable();
    await fixture.schedulerTurn();
    fixture.removeAccount();
    const callsBeforeRemoval = fixture.calls.length;
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    assert.equal(fixture.calls.length, callsBeforeRemoval, 'a newly due removed account cannot call Slack');
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: callsBeforeRemoval });

    fixture.readdAccount();
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    assert.equal(
      fixture.calls.length,
      callsBeforeRemoval,
      'a newly due re-added account remains dark without a newly approved point',
    );
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: callsBeforeRemoval });

    fixture.setSlackBaseline(newPoint);
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: beforeReapproval }), matrixSlackMessage({ ts: afterReapproval })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await activateAndRecoverAtSlackEdge(fixture, 'S:remove-readd-stays-dark', edge, () => fixture.activate(2));
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 1, admissions: 1, versions: [2] });
    assertSlackOccurrences(fixture, [{ ts: afterReapproval, version: 2 }]);
    assert.equal(
      fixture.store.database.prepare('SELECT 1 FROM ingest WHERE dedupe_key LIKE ?').get(`%${beforeReapproval}%`),
      undefined,
      'the re-approval starts only at its freshly sampled point',
    );
  });
}

async function claimRecoveryResumesSameDrain(): Promise<void> {
  await forEachSlackMatrixEdge('S:claim-recovery-resumes-same-drain', async (fixture, edge) => {
    fixture.setSlackPages(emptySlackPages());
    await activateAndRecoverAtSlackEdge(fixture, 'S:claim-recovery-resumes-same-drain', edge, () => fixture.activate());
    assert.equal(activeRuleVersion(fixture), 1, 'restart resumes the same claimed activation to its active pointer');
    await fixture.enable();
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: 1 });
  });
}

async function claimedPFencesHistoryAndReplyWorker(): Promise<void> {
  await forEachSlackMatrixEdge('S:claimed-P-fences-history-and-reply-worker', async (fixture, edge) => {
    const oldPoint = '1760000000.000000';
    const pendingPoint = '1760000002.000000';
    const after = '1760000003.000000';
    fixture.setSlackBaseline(oldPoint);
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate();
    await fixture.enable();
    await fixture.schedulerTurn();
    fixture.setSlackBaseline(pendingPoint);
    // The no-source-crash control still needs a durable, unpublished P to
    // exercise the fence. Pause that setup activation just after staging P;
    // the actual source-edge probe below must remain unreachable while fenced.
    await activateAtSlackDurableEdge(fixture, 'S:claimed-P-fences-history-and-reply-worker', 'after-stage', () =>
      fixture.activateAdditionalRule('rule-pending'),
    );

    fixture.now.value += 2_000;
    assert.equal(hasPendingSlackPoint(fixture), true, 'the additional rule retains its unpublished Slack P');
    const callsBeforeFenceProbe = fixture.calls.length;
    let sourceEdgeFired = false;
    if (edge !== undefined)
      await fixture.setFailpoint((at) => {
        if (at === edge) sourceEdgeFired = true;
      });
    await fixture.schedulerTurn({ skipActivationRecovery: true });
    assert.equal(
      fixture.calls.length,
      callsBeforeFenceProbe,
      'an active scope is fenced before the scheduler can invoke its history/reply worker while P is unpublished',
    );
    assert.equal(sourceEdgeFired, false, `${edge ?? 'no-crash'} is unreachable because the fenced worker never starts`);
    await fixture.setFailpoint(undefined);
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: callsBeforeFenceProbe });

    await fixture.recover();
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: after })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    fixture.now.value += 2_000;
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 1, admissions: 2, versions: [1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: after, version: 1 },
      { ts: after, version: 1 },
    ]);
  });
}

async function deadlineAtPAfterPAndFinaliseSettlesWithoutWrite(): Promise<void> {
  await forEachSlackMatrixEdge('S:deadline-at-P-after-P-and-finalise-settles-without-write', async (fixture, edge) => {
    await activateAndRecoverAtSlackEdge(
      fixture,
      'S:deadline-at-P-after-P-and-finalise-settles-without-write',
      edge,
      () => fixture.activate(),
    );
    for (const [index, deadlineEdge] of [
      'before-claim-deadline',
      'before-baseline-deadline',
      'before-finalise-deadline',
    ].entries()) {
      const baselineCallsBefore = fixture.baselineCalls;
      await fixture.setDeadlineFailpoint((at) => {
        if (at === deadlineEdge) fixture.now.value += 3_600_001;
      });
      await assert.rejects(() => fixture.activateAdditionalRule(`rule-deadline-${index}`));
      if (deadlineEdge === 'before-claim-deadline')
        assert.equal(
          fixture.baselineCalls,
          baselineCallsBefore,
          'a completion expired before its claim cannot sample a Slack baseline before settling content-free',
        );
      assert.equal(
        fixture.failedCompletions(),
        index + 1,
        `${deadlineEdge} settles its claimed completion rather than retaining P`,
      );
      fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
      fixture.assertContentFreeSettlement();
      await fixture.setDeadlineFailpoint(undefined);
    }
  });
}

async function replaceOldOnlyDrainsHistoryAndReplies(): Promise<void> {
  await forEachSlackMatrixEdge('S:replace-old-only-drains-history-and-replies', async (fixture, edge) => {
    await establishSlackCursor(fixture);
    fixture.now.value += 5_000;
    const preP = '1760000001.000000';
    const replyAtP = '1760000001.500000';
    const atP = '1760000002.000000';
    const postP = '1760000003.000000';
    fixture.setSlackBaseline(atP);
    fixture.setSlackPages({
      history: async () => ({
        messages: [
          matrixSlackMessage({ ts: preP, replyCount: 1 }),
          matrixSlackMessage({ ts: atP }),
          matrixSlackMessage({ ts: postP }),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async ({ cursor }) =>
        cursor === undefined || cursor === null
          ? {
              messages: [matrixSlackMessage({ ts: replyAtP, threadTs: preP })],
              nextCursor: 'reply-page-2',
              retainedHistoryBoundary: false,
            }
          : { messages: [], nextCursor: null, retainedHistoryBoundary: false },
    });
    await startExactSlackReplacement(fixture, { channel: 'slack', conversations: ['C-new'] });
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    await fixture.runtime.resumeClaimedCompletions();
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number } | undefined
      )?.version,
      1,
      'top-level coverage alone cannot swap an old-only conversation past its reply barrier',
    );
    await finishSlackReplacementDrain(fixture, 'S:replace-old-only-drains-history-and-replies');
    await resumeClaimedSlackCompletionAtActivationEdge(fixture, 'S:replace-old-only-drains-history-and-replies', edge);
    fixture.oracle({ raw: 3, admissions: 3, versions: [1, 1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: preP, version: 1 },
      { ts: replyAtP, version: 1 },
      { ts: atP, version: 1 },
    ]);
    assert.equal(
      fixture.store.database.prepare("SELECT 1 FROM ingest WHERE dedupe_key LIKE '%1760000003.000000%'").get(),
      undefined,
      'an old-only occurrence strictly after P is not projected before its scope ends',
    );
  });
}

async function replaceNewOnlyBaselinesAtP(): Promise<void> {
  await forEachSlackMatrixEdge('S:replace-new-only-baselines-at-P', async (fixture, edge) => {
    await establishSlackCursor(fixture, { channel: 'slack', conversations: ['C-old'] });
    const preP = '1760000001.000000';
    const point = '1760000002.000000';
    const postP = '1760000003.000000';
    const historyOldest: string[] = [];
    fixture.setSlackBaseline(point);
    fixture.setSlackPages({
      history: async ({ conversationId, oldest }) => {
        if (conversationId === 'C-old') return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
        historyOldest.push(oldest);
        return {
          messages: [matrixSlackMessage({ ts: preP }), matrixSlackMessage({ ts: postP })],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await startExactSlackReplacement(fixture, fixture.options());
    await fixture.sourceTurn(slackScope(fixture, 'C-old'));
    await resumeClaimedSlackCompletionAtActivationEdge(fixture, 'S:replace-new-only-baselines-at-P', edge);
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number } | undefined
      )?.version,
      2,
      'the new-only P is published before its cursor is allowed to collect',
    );
    assert.equal(
      fixture.store.database
        .prepare("SELECT 1 FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
        .get(fixture.accountId, fixture.scope.scopeId),
      undefined,
      'finalisation publishes the new-only point but leaves the first cursor installation to the scheduler',
    );
    fixture.now.value += 5_000;
    await schedulerTurnThroughSlackDurableEdge(fixture, edge);
    assert.ok(historyOldest.length > 0, 'the first ordinary new-only collection calls Slack history');
    assert.equal(
      historyOldest[0],
      point,
      'the scheduler installs the new-only cursor at P, neither before nor after it',
    );
    fixture.oracle({ raw: 1, admissions: 1, versions: [2] });
    assertSlackOccurrences(fixture, [{ ts: postP, version: 2 }]);
    assert.equal(
      fixture.store.database.prepare("SELECT 1 FROM ingest WHERE dedupe_key LIKE '%1760000001.000000%'").get(),
      undefined,
      'the new-only cursor begins at its own P and never backfills the old interval',
    );
  });
}

async function replaceSharedOneVersionPerOccurrence(): Promise<void> {
  await forEachSlackMatrixEdge('S:replace-shared-one-version-per-occurrence', async (fixture, edge) => {
    await establishSlackCursor(fixture);
    const preP = '1760000001.000000';
    const atP = '1760000002.000000';
    const postP = '1760000003.000000';
    fixture.setSlackBaseline(atP);
    fixture.setSlackPages({
      history: async () => ({
        messages: [
          matrixSlackMessage({ ts: preP }),
          matrixSlackMessage({ ts: atP }),
          matrixSlackMessage({ ts: postP }),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await startExactSlackReplacement(fixture, fixture.options());
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    await resumeClaimedSlackCompletionAtActivationEdge(fixture, 'S:replace-shared-one-version-per-occurrence', edge);
    fixture.now.value += 5_000;
    await fixture.sourceTurn();
    fixture.oracle({ raw: 3, admissions: 3, versions: [1, 1, 2] });
    assertSlackOccurrences(fixture, [
      { ts: preP, version: 1 },
      { ts: atP, version: 1 },
      { ts: postP, version: 2 },
    ]);
  });
}

async function enableAllRebaselinesReaddedScope(): Promise<void> {
  await forEachSlackMatrixEdge('S:enable-all-rebaselines-readded-scope', async (fixture, edge) => {
    await establishSlackCursor(fixture);
    await fixture.disableAll();
    const callsWhileEnabled = fixture.calls.length;
    await fixture.schedulerTurn();
    assert.equal(fixture.calls.length, callsWhileEnabled, 'disable-all fences every Slack provider call');
    fixture.removeAccount();
    fixture.readdAccount();
    fixture.now.value += 3_000;
    const beforeEnable = '1760000001.000000';
    const afterEnable = '1760000002.500000';
    fixture.setSlackBaseline('1760000002.000000');
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: beforeEnable }), matrixSlackMessage({ ts: afterEnable })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await fixture.enable();
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
    assertSlackOccurrences(fixture, [{ ts: afterEnable, version: 1 }]);
  });
}

async function timeoutKeepsWatermarkAndRetries(): Promise<void> {
  await forEachSlackMatrixEdge('S:timeout-keeps-watermark-and-retries', async (fixture, edge) => {
    await establishSlackCursor(fixture);
    const preP = '1760000001.000000';
    const atP = '1760000002.000000';
    const postP = '1760000003.000000';
    fixture.setSlackBaseline(atP);
    fixture.setSlackPages({
      history: async () => ({
        messages: [
          matrixSlackMessage({ ts: preP }),
          matrixSlackMessage({ ts: atP }),
          matrixSlackMessage({ ts: postP }),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await startExactSlackReplacement(fixture, fixture.options());
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    fixture.now.value += 3_600_001;
    await fixture.recover();
    assert.equal(
      fixture.failedCompletions(),
      1,
      'the expired completion settles instead of retaining a permanent P fence',
    );
    await fixture.sourceTurn();
    fixture.oracle({ raw: 3, admissions: 3, versions: [1, 1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: preP, version: 1 },
      { ts: atP, version: 1 },
      { ts: postP, version: 1 },
    ]);
  });
}

async function initialCursorIsAfterBaseline(): Promise<void> {
  await forEachSlackMatrixEdge('S:initial-cursor-is-after-baseline', async (fixture, edge) => {
    const baseline = '1759999999.000000';
    const before = '1760000000.250000';
    const laterBaseline = '1760000000.500000';
    const after = '1760000001.000000';
    let collect = false;
    fixture.setSlackBaseline(baseline);
    fixture.setSlackPages({
      history: async () => ({
        messages: collect ? [matrixSlackMessage({ ts: before }), matrixSlackMessage({ ts: after })] : [],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await fixture.activate();
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
    await fixture.enable();
    fixture.setSlackBaseline(laterBaseline);
    await fixture.activateAdditionalRule('rule-later');
    fixture.now.value += 3_000;
    collect = true;
    await schedulerTurnThroughSlackDurableEdge(fixture, edge);
    fixture.oracle({ raw: 2, admissions: 3, versions: [1, 1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: before, version: 1 },
      { ts: after, version: 1 },
      { ts: after, version: 1 },
    ]);
    assert.match(
      (
        fixture.store.database
          .prepare("SELECT cursor FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
          .get(fixture.accountId, fixture.scope.scopeId) as { cursor: string } | undefined
      )?.cursor ?? '',
      /^1760000003\.00[01]000$/u,
      'the first durable cursor begins at the earliest published baseline and advances only after its staged page settles',
    );
  });
}

async function initialCursorRechecksPointsUnderConversationLock(): Promise<void> {
  await forEachSlackMatrixEdge('S:initial-cursor-rechecks-points-under-conversation-lock', async (fixture, edge) => {
    const earlierPoint = '1759999999.000000';
    const laterPoint = '1760000001.000000';
    const between = '1760000000.000000';
    // The preceding scheduler turn closes an interval at its fake-clock
    // latest (1760000003); keep the shared candidate in the next interval.
    const afterBoth = '1760000004.000000';
    fixture.setSlackBaseline(earlierPoint);
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate();
    await fixture.enable();
    fixture.setSlackBaseline(laterPoint);
    let concurrentPointPublications = 0;
    fixture.setSchedulerPointDecryptHook(async () => {
      if (concurrentPointPublications > 0) return;
      concurrentPointPublications += 1;
      await fixture.activateAdditionalRule('rule-later');
    });
    await fixture.schedulerTurn();
    fixture.setSchedulerPointDecryptHook(undefined);
    assert.equal(concurrentPointPublications, 1, 'the scheduler cursor decrypt raced one new Slack point publication');
    assert.equal(
      fixture.store.database
        .prepare("SELECT 1 FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
        .get(fixture.accountId, fixture.scope.scopeId),
      undefined,
      'the cursor insert abandons the stale point set inside the conversation lock',
    );
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: between })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    fixture.now.value += 3_000;
    await fixture.schedulerTurn();
    fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
    fixture.now.value += 3_000;
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: afterBoth })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    await fixture.sourceTurn();
    fixture.oracle({ raw: 2, admissions: 3, versions: [1, 1, 1] });
    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT rule_id, rule_version, ingest.dedupe_key
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
            ORDER BY ingest.dedupe_key, rule_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { rule_id: 'rule-cutover', rule_version: 1, dedupe_key: `C-cutover/${between}` },
        { rule_id: 'rule-cutover', rule_version: 1, dedupe_key: `C-cutover/${afterBoth}` },
        { rule_id: 'rule-later', rule_version: 1, dedupe_key: `C-cutover/${afterBoth}` },
      ],
      'the under-lock point re-read starts at the earlier point and applies each rule point independently',
    );
  });
}

async function tightenTransfersPageAndReplyDebts(): Promise<void> {
  await forEachSlackMatrixEdge(
    'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing',
    async (fixture, edge) => {
      await establishSlackCursor(fixture);
      fixture.now.value += 5_000;
      const staged = '1760000001.000000';
      fixture.setSlackPages({
        history: async () => ({
          messages: [matrixSlackMessage({ ts: staged })],
          nextCursor: null,
          retainedHistoryBoundary: false,
        }),
        replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
      });
      fixture.now.value += 2_000;
      await fixture.setFailpoint((at) => {
        if (at === 'after-stage') throw new Error('stage is durable before derived pointer moves');
      });
      await assert.rejects(() => fixture.sourceTurn(), /stage is durable before derived pointer moves/);
      await fixture.restart();
      await fixture.tighten();
      await sourceTurnThroughSlackDurableEdge(fixture, edge, undefined, {
        expectFire: edge !== 'before-stage' && edge !== 'after-stage',
      });
      fixture.oracle({ raw: 1, admissions: 1, versions: [2] });
      assertSlackOccurrences(fixture, [{ ts: staged, version: 2 }]);

      // Hold a v2 source worker across the v3 derived-pointer move.  The
      // history reader is awaited after the worker captured its rule snapshot,
      // so a correct source write is refused; only a fresh v3 retry can stage
      // and admit this occurrence.  This is the stale-write half of D12, rather
      // than merely proving that a restart observes the child pointer.
      const racing = '1760000008.000000';
      let movedDuringRead = false;
      fixture.now.value += 2_000;
      fixture.setSlackPages({
        history: async () => {
          if (!movedDuringRead) {
            movedDuringRead = true;
            await fixture.tighten(fixture.options(), 3);
          }
          return {
            messages: [matrixSlackMessage({ ts: racing })],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
        replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
      });
      await assert.rejects(
        () => fixture.sourceTurn(),
        /stale source write/u,
        'the in-flight v2 worker cannot persist after the v3 tightening moves its pointer',
      );
      assert.equal(movedDuringRead, true, 'the derived pointer moves while the source worker holds its old snapshot');
      fixture.oracle({ raw: 1, admissions: 1, versions: [2] });
      await fixture.sourceTurn();
      fixture.oracle({ raw: 2, admissions: 2, versions: [2, 3] });
      assertSlackOccurrences(fixture, [
        { ts: staged, version: 2 },
        { ts: racing, version: 3 },
      ]);
    },
  );
}

async function swapDropsOldOnlyHistoryAndReplyDebts(): Promise<void> {
  await forEachSlackMatrixEdge('S:swap-drops-old-only-history-and-reply-debts', async (fixture, edge) => {
    await establishSlackCursor(fixture);
    fixture.now.value += 5_000;
    const preP = '1760000001.000000';
    const atP = '1760000002.000000';
    const postP = '1760000003.000000';
    let postPage = false;
    fixture.setSlackBaseline(atP);
    fixture.setSlackPages({
      history: async () => ({
        messages: postPage
          ? [matrixSlackMessage({ ts: postP, threadTs: preP })]
          : [matrixSlackMessage({ ts: preP }), matrixSlackMessage({ ts: atP })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await startExactSlackReplacement(fixture, { channel: 'slack', conversations: ['C-new'] });
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    // The production reply reconciler intentionally consumes one eligible
    // parent per turn; both at-or-before-P parents must drain before swap.
    await fixture.sourceTurn();
    postPage = true;
    await fixture.setFailpoint((at) => {
      if (at === 'after-stage') throw new Error('old-only post-P stage is durable before swap');
    });
    await assert.rejects(() => fixture.sourceTurn(), /old-only post-P stage is durable before swap/);
    await fixture.restart();
    await resumeClaimedSlackCompletionAtActivationEdge(fixture, 'S:swap-drops-old-only-history-and-reply-debts', edge);
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number } | undefined
      )?.version,
      2,
      'the old-only source drain is certified before the atomic swap settles its staged debt',
    );
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
    assertSlackOccurrences(fixture, [
      { ts: preP, version: 1 },
      { ts: atP, version: 1 },
    ]);
    assert.equal(
      (
        fixture.store.database
          .prepare(
            `SELECT COUNT(*) AS count FROM source_stage_rule_debts
            WHERE rule_id = 'rule-cutover' AND rule_version = 1`,
          )
          .get() as { count: number } | undefined
      )?.count,
      0,
      'the atomic swap deletes the durable old-only history/reply debt instead of letting it reappear',
    );
  });
}

test('S:new-only replacement keeps the shared cursor at an earlier active rule point', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  try {
    const oldPoint = '1759999999.000000';
    const pointA = '1760000001.000000';
    const pointB = '1760000002.000000';
    const between = '1760000001.500000';
    const after = '1760000003.000000';
    const historyOldest: string[] = [];

    // Rule B's v1 is already active on C-old and has a real scheduler-owned
    // cursor, so its exact replacement can drain without shortcutting an
    // otherwise cursorless scope.
    fixture.setSlackBaseline(oldPoint);
    fixture.setSlackPages(emptySlackPages());
    await fixture.activate(1, { channel: 'slack', conversations: ['C-old'] });
    await fixture.enable();
    await fixture.schedulerTurn();

    // Rule A is active for C but has not yet received its first scheduler
    // turn. Its P_A must therefore remain available when B v2 later adds C.
    fixture.setSlackBaseline(pointA);
    await fixture.activateAdditionalRule('rule-a', fixture.options());

    fixture.setSlackBaseline(pointB);
    fixture.setSlackPages({
      history: async ({ conversationId, oldest }) => {
        if (conversationId === 'C-old') return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
        historyOldest.push(oldest);
        return {
          messages: [matrixSlackMessage({ ts: between }), matrixSlackMessage({ ts: after })],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await startExactSlackReplacement(fixture, fixture.options());
    await fixture.sourceTurn(slackScope(fixture, 'C-old'));
    await fixture.runtime.resumeClaimedCompletions();

    assert.equal(
      fixture.store.database
        .prepare("SELECT 1 FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
        .get(fixture.accountId, fixture.scope.scopeId),
      undefined,
      "B v2 finalisation must not pre-empt C's still-cursorless earlier active point",
    );

    fixture.now.value += 5_000;
    await fixture.schedulerTurn();

    assert.deepEqual(historyOldest, [pointA], "the first C turn begins at rule A's oldest active point");
    fixture.oracle({ raw: 2, admissions: 3, versions: [1, 1, 2] });
    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT decisions.rule_id, decisions.rule_version, ingest.dedupe_key
             FROM decisions
             JOIN ingest ON ingest.event_id = decisions.event_id
            WHERE ingest.type = 'slack.message.posted'
            ORDER BY ingest.dedupe_key, decisions.rule_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { rule_id: 'rule-a', rule_version: 1, dedupe_key: `C-cutover/${between}` },
        { rule_id: 'rule-a', rule_version: 1, dedupe_key: `C-cutover/${after}` },
        { rule_id: 'rule-cutover', rule_version: 2, dedupe_key: `C-cutover/${after}` },
      ],
      'the interval P_A < M <= P_B belongs to A alone; only later M belongs to A and B v2',
    );
  } finally {
    await fixture.dispose();
  }
});

test('S: durable source edges reopen the same activation, scheduler, evaluator, source state and fake journal', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const edge of ['before-stage', 'after-stage', 'before-move', 'after-move', 'before-finalise'] as const) {
    const fixture = await PhaseDCutoverFixture.create('slack');
    try {
      if (edge === 'before-finalise') {
        await fixture.setFailpoint((at) => {
          if (at === edge) throw new Error(`cut-over crash:${edge}`);
        });
        await assert.rejects(() => fixture.activate(), new RegExp(`cut-over crash:${edge}`), edge);
        const before = await fixture.journal();
        await fixture.restart();
        await fixture.recover();
        await fixture.enable();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        assert.ok((await fixture.journal()).length >= before.length, `${edge} retains the durable provider journal`);
        continue;
      }
      await fixture.activate();
      await fixture.enable();
      await fixture.schedulerTurn();
      await fixture.setFailpoint((at) => {
        if (at === edge) throw new Error(`cut-over crash:${edge}`);
      });
      await assert.rejects(() => fixture.sourceTurn(), new RegExp(`cut-over crash:${edge}`), edge);
      const before = await fixture.journal();
      await fixture.restart();
      await fixture.sourceTurn();
      fixture.oracle({ raw: 1, admissions: 1 });
      assert.ok((await fixture.journal()).length >= before.length, `${edge} keeps the durable provider journal`);
    } finally {
      await fixture.dispose();
    }
  }
});

test('S: replacement has distinct old-only, new-only and shared conversations', { skip: WINDOWS_SKIP }, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  try {
    await fixture.beginScopedReplacement();
    fixture.assertScopedReplacement();
  } finally {
    await fixture.dispose();
  }
});

test('P1-D2: a shared Slack cursor admits a pre-later-point message only to the earlier rule', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  try {
    await fixture.activate();
    await fixture.enable();
    fixture.setSlackBaseline('1760000001.000000');
    await fixture.activateAdditionalRule('rule-later');
    fixture.setSlackPages({
      history: async () => ({
        messages: [slackMessage({ ts: IDS.slackTs, threadTs: null, replyCount: 0, text: 'between points' })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });

    await fixture.schedulerTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare('SELECT rule_id FROM decisions ORDER BY rule_id')
        .all()
        .map((row) => ({ ...row })),
      [{ rule_id: 'rule-cutover' }],
    );
  } finally {
    await fixture.dispose();
  }
});

test('P1-D2: enable-all takes a fresh Slack point and does not backfill disabled-interval messages', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  try {
    await fixture.activate();
    await fixture.enable();
    fixture.setSlackPages({
      history: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
    await fixture.schedulerTurn();
    await fixture.disableAll();
    fixture.now.value += 2_000;
    fixture.setSlackBaseline('1760000001.000000');
    await fixture.enable();
    fixture.setSlackPages({
      history: async () => ({
        messages: [slackMessage({ ts: '1760000000.500000', threadTs: null, replyCount: 0, text: 'while disabled' })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });

    await fixture.schedulerTurn();

    fixture.oracle({ raw: 0, admissions: 0 });
  } finally {
    await fixture.dispose();
  }
});

test('P1: a replacement reply at P is admitted once to the old version and holds the swap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  const parentTs = '1759999998.000000';
  const replyTs = '1759999999.000000';
  let postP = false;
  try {
    fixture.setSlackBaseline('1759999997.000000');
    fixture.setSlackPages({
      history: async () => ({
        messages: [
          slackMessage(
            postP
              ? { ts: '1760000000.000000', threadTs: null, replyCount: 0, text: 'post-P parent' }
              : { ts: parentTs, threadTs: null, replyCount: 1, text: 'parent at P' },
          ),
        ],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async (input) =>
        input.cursor === undefined
          ? {
              messages: [slackMessage({ ts: replyTs, threadTs: parentTs, replyCount: 0, text: 'reply at P' })],
              nextCursor: 'reply-page-2',
              retainedHistoryBoundary: false,
            }
          : { messages: [], nextCursor: null, retainedHistoryBoundary: false },
    });
    await fixture.activate();
    await fixture.enable();
    fixture.store.database
      .prepare(
        `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
         VALUES ('slack', ?, ?, '1759999997.000000', ?)`,
      )
      .run(fixture.accountId, fixture.scope.scopeId, fixture.now.value);

    fixture.setSlackBaseline(replyTs);
    let waiting = false;
    try {
      await fixture.activate(2, fixture.options(), 'changed');
    } catch (error: unknown) {
      waiting = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
    }
    assert.equal(waiting, true, 'the exact replacement retains its old rule until the reply drain completes');

    await fixture.sourceTurn();
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number }
      ).version,
      1,
      'the swap cannot overtake a reply page whose final cursor has not yet reached P',
    );
    assert.equal(
      (
        fixture.store.database.prepare('SELECT drained_at FROM slack_reply_drains').get() as {
          drained_at: number | null;
        }
      ).drained_at,
      null,
    );
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });

    await fixture.sourceTurn();
    assert.notEqual(
      (
        fixture.store.database.prepare('SELECT drained_at FROM replacement_drains').get() as {
          drained_at: number | null;
        }
      ).drained_at,
      null,
      'the source drain has certified P but finalisation has not yet published the child',
    );
    postP = true;
    await fixture.sourceTurn();
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });

    await fixture.runtime.resumeClaimedCompletions();
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number }
      ).version,
      2,
      'the swap publishes only after the staged reply page reaches its terminal cursor',
    );
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
  } finally {
    await fixture.dispose();
  }
});

test('P1: a replacement drain inherits a recently observed parent below P after history has passed it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('slack');
  const parentTs = '1759999998.000000';
  const replyTs = '1759999999.000000';
  let replacement = false;
  try {
    fixture.setSlackBaseline('1759999997.000000');
    fixture.setSlackPages({
      history: async () => ({
        messages: replacement
          ? []
          : [slackMessage({ ts: parentTs, threadTs: null, replyCount: 1, text: 'known parent below P' })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({
        messages: replacement
          ? [slackMessage({ ts: replyTs, threadTs: parentTs, replyCount: 0, text: 'reply at frozen P' })]
          : [],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
    });
    await fixture.activate();
    await fixture.enable();
    fixture.store.database
      .prepare(
        `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
         VALUES ('slack', ?, ?, '1759999997.000000', ?)`,
      )
      .run(fixture.accountId, fixture.scope.scopeId, fixture.now.value);
    await fixture.sourceTurn();
    fixture.oracle({ raw: 1, admissions: 1, versions: [1] });

    replacement = true;
    fixture.setSlackBaseline(replyTs);
    let waiting = false;
    try {
      await fixture.activate(2, fixture.options(), 'changed');
    } catch (error: unknown) {
      waiting = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
    }
    assert.equal(waiting, true);

    await fixture.sourceTurn();
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
          .get() as { version: number }
      ).version,
      1,
      'the old version owns the inherited parent reply until the drain is finalised',
    );
  } finally {
    await fixture.dispose();
  }
});

function slackMessage(input: { ts: string; threadTs: string | null; replyCount: number; text: string }) {
  return {
    ...input,
    text: `<untrusted-content>${input.text}</untrusted-content>`,
    author: { name: null, app: false, external: false },
    truncated: false,
    mismatch: false,
    unrenderable: false,
    editedTs: null,
    mentions: [],
    files: [],
  };
}

test('S: every matrix cell records its no-crash and durable-edge run and has a named mutation', {
  skip: WINDOWS_SKIP,
}, () => {
  const expected = new Set(['no-crash', ...DURABLE_CUTOVER_EDGES]);
  for (const cell of cells)
    assert.deepEqual(
      matrixRuns.get(cell),
      expected,
      `${cell}: the matrix must run no-crash plus every durable edge (fired or explicitly unreachable)`,
    );
  assertSlackMatrixMutationCoverage(cells);
});
