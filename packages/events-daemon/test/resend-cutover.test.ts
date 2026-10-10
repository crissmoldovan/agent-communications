import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DURABLE_CUTOVER_EDGES } from '../src/runtime/cutover-failpoint.ts';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import {
  activateAtResendDurableEdge,
  assertResendAdmissions,
  forEachResendDurableEdge,
  RESEND_CUTOVER_CELLS,
  type ResendDurableEdgeRun,
} from './support/phase-d-cutover-resend.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const RECEIVED = { channel: 'resend', kinds: ['received'] };
const X0 = '00000000-0000-4000-8000-000000000000';
const P = '11111111-1111-4111-8111-111111111111';
const E0 = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
const E2 = '44444444-4444-4444-8444-444444444444';
const E3 = '55555555-5555-4555-8555-555555555555';
const RECEIVED_AND_STATUS = { channel: 'resend', kinds: ['received', 'status'] };
const OLD_ACCOUNT = 'acc_BBBBBBBBBBBBBBBB';
const SHARED_ACCOUNT = 'acc_CCCCCCCCCCCCCCCC';
const NEW_ACCOUNT = 'acc_DDDDDDDDDDDDDDDD';

function receivedCandidate(emailId: string) {
  return {
    kind: 'candidate' as const,
    candidate: {
      emailId,
      receivedAt: '2026-10-09T12:00:00.000Z',
      subject: 'received cut-over fixture',
      attachments: [],
      attachmentCount: 0,
      from: null,
      replyTo: [],
      to: [],
      cc: [],
      receivedFor: [],
      messageId: null,
      authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
    },
  };
}

const cells = RESEND_CUTOVER_CELLS;

const durableEdgeRuns: ResendDurableEdgeRun[] = [];

for (const name of cells) {
  test(name, { skip: WINDOWS_SKIP }, async () => {
    await forEachResendDurableEdge(
      name,
      async (fixture, edge, report) => runResendCell(name, fixture, edge, report),
      (run) => durableEdgeRuns.push(run),
    );
  });
}

test('R: every matrix cell records the no-crash run and every durable edge', { skip: WINDOWS_SKIP }, () => {
  for (const cell of cells) {
    const runs = durableEdgeRuns.filter((run) => run.cell === cell);
    assert.equal(
      runs.filter((run) => run.edge === undefined && run.outcome === 'no-crash').length,
      1,
      `${cell}: no-crash`,
    );
    for (const edge of DURABLE_CUTOVER_EDGES) {
      const run = runs.find((candidate) => candidate.edge === edge);
      assert.notEqual(run, undefined, `${cell}: ${edge} was not run through the harness`);
      assert.ok(run?.outcome === 'fired' || run?.outcome === 'unreachable', `${cell}: ${edge} records its outcome`);
    }
  }
});

async function runResendCell(
  name: (typeof cells)[number],
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  switch (name) {
    case 'R:first-enabled-received-and-status':
      return firstEnabledReceivedAndStatus(fixture, edge, report);
    case 'R:first-disabled-seeds-anchor-and-status':
      return firstDisabledSeedsAnchorAndStatus(fixture, edge, report);
    case 'R:replace-old-only-drains-received-and-status':
      return replacementOldOnlyDrains(fixture, edge, report);
    case 'R:replace-new-only-baselines-at-anchor':
      return replacementNewOnlyBaselines(fixture, edge, report);
    case 'R:replace-shared-one-version-per-occurrence':
      return replacementSharedAdmitsOneVersion(fixture, edge, report);
    case 'R:disabled-replacement-marks-drains-complete':
      return disabledReplacementMarksDrainsComplete(fixture, edge, report);
    case 'R:enable-all-rebaselines-readded-account':
      return enableAllRebaselinesReaddedAccount(fixture, edge, report);
    case 'R:tighten-preserves-anchor-and-status-seed':
      return tighteningPreservesAnchorAndStatusSeed(fixture, edge, report);
    case 'R:disable-or-remove-cancels-and-purges':
      return disableOrRemoveCancelsAndPurges(fixture, edge, report);
    case 'R:remove-readd-stays-dark':
      return removeReaddStaysDark(fixture, edge, report);
    case 'R:claim-recovery-resumes-same-cycle':
      return claimRecoveryResumesSameCycle(fixture, edge, report);
    case 'R:timeout-keeps-anchor-and-retries':
      return timeoutKeepsAnchorAndRetries(fixture, edge, report);
    case 'R:initial-anchor-and-status-start-atomic':
      return initialAnchorAndStatusStartAtomic(fixture, edge, report);
    case 'R:claimed-P-fences-received-and-status-worker':
      return claimedPFencesReceivedAndStatusWorker(fixture, edge, report);
    case 'R:initial-cursor-rechecks-points-under-received-and-status-locks':
      return initialCursorRechecksPublishedPoints(fixture, edge, report);
    case 'R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing':
      return tighteningTransfersReceivedAndStatusDebts(fixture, edge, report);
    case 'R:swap-drops-old-only-received-and-status-debts':
      return swapDropsOldOnlyDebts(fixture, edge, report);
    case 'R:deadline-at-P-after-P-and-finalise-settles-without-write':
      return deadlineAtPAfterPAndFinaliseSettlesWithoutWrite(fixture, edge, report);
    default:
      return assert.fail(`unimplemented real Resend matrix cell: ${name}`);
  }
}

async function firstEnabledReceivedAndStatus(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:first-enabled-received-and-status',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  assert.equal(fixture.calls.length, 0, 'the disabled first activation calls neither Resend reader');
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));

  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));

  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
  ]);
  fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
}

async function firstDisabledSeedsAnchorAndStatus(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:first-disabled-seeds-anchor-and-status',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  const recorded = fixture.store.database
    .prepare(
      `SELECT position_scope, encrypted_position
         FROM rule_activation_points
        WHERE source = 'resend' AND account_id = ?
        ORDER BY position_scope`,
    )
    .all(fixture.accountId) as Array<{ position_scope: string; encrypted_position: Uint8Array }>;
  assert.deepEqual(
    recorded.map((row) => row.position_scope),
    ['received', 'status'],
    'disabled activation records both the received anchor and status start point',
  );
  assert.ok(
    recorded.every((row) => row.encrypted_position.byteLength > 0),
    'both content-free points are durable',
  );
  fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });

  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
  ]);
}

async function disabledReplacementMarksDrainsComplete(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(X0);
  await activateAtResendDurableEdge(
    fixture,
    'R:disabled-replacement-marks-drains-complete',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  fixture.setResendReceivedBaseline(P);
  await fixture.replaceWhileDisabled();
  assert.deepEqual(
    fixture.store.database
      .prepare("SELECT 1 FROM replacement_drains WHERE source = 'resend' AND drained_at IS NULL")
      .get(),
    undefined,
    'disabled replacement leaves no owed received/status drain',
  );
  assert.equal(
    (
      fixture.store.database
        .prepare("SELECT version FROM active_versions WHERE kind = 'rule' AND object_id = 'rule-cutover'")
        .get() as { version: number }
    ).version,
    2,
    'disabled replacement publishes the completed successor without collection',
  );
  fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
}

async function tighteningPreservesAnchorAndStatusSeed(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:tighten-preserves-anchor-and-status-seed',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  const callsBeforeTightening = fixture.baselineCalls;
  await fixture.tighten(RECEIVED_AND_STATUS);
  assert.equal(fixture.baselineCalls, callsBeforeTightening, 'derived tightening does not sample a replacement point');
  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 2),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 2),
  ]);
}

async function disableOrRemoveCancelsAndPurges(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:disable-or-remove-cancels-and-purges',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  await fixture.revokeByRule();
  const callsBeforeDisabledPoll = fixture.calls.length;
  await advancePastResendPoll(fixture);
  assert.equal(fixture.calls.length, callsBeforeDisabledPoll, 'a disabled rule polls neither Resend scope');
  assert.equal(
    fixture.store.database.prepare("SELECT 1 FROM rule_activation_points WHERE source = 'resend'").get(),
    undefined,
    'rule disable purges both source points',
  );

  fixture.setResendReceivedBaseline(P);
  await fixture.activate(2, RECEIVED_AND_STATUS);
  await primeResendCursors(fixture, 2);
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.now.value += 1;
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 2),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 2),
  ]);
}

async function removeReaddStaysDark(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:remove-readd-stays-dark',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  fixture.removeAccount();
  const callsBeforeRemovalPoll = fixture.calls.length;
  await advancePastResendPoll(fixture);
  assert.equal(fixture.calls.length, callsBeforeRemovalPoll, 'removed account has no eligible source poll');
  fixture.readdAccount();
  await advancePastResendPoll(fixture);
  await advancePastResendPoll(fixture);
  await advancePastResendPoll(fixture);
  await advancePastResendPoll(fixture);
  await assert.rejects(() => fixture.sourceTurn(), /no installed activation anchor/);
  assert.equal(fixture.calls.length, callsBeforeRemovalPoll, 'K6 keeps a re-added account dark without a fresh point');

  fixture.setResendReceivedBaseline(P);
  await fixture.activate(2, RECEIVED_AND_STATUS);
  await primeResendCursors(fixture, 2);
  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 2),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 2),
  ]);
}

async function claimRecoveryResumesSameCycle(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  fixture.setResendReceivedReader(receivedReader([P]));
  await activateAtResendDurableEdge(
    fixture,
    'R:claim-recovery-resumes-same-cycle',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  assert.equal(
    fixture.store.database.prepare("SELECT 1 FROM activation_intents WHERE status = 'pending-completion'").get(),
    undefined,
    'restart recovery completes the claimed activation before the scheduler gets another turn',
  );
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E1, P, E0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
  ]);
}

async function replacementOldOnlyDrains(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  await beginScopedResendReplacement(fixture, edge, 'R:replace-old-only-drains-received-and-status', {}, report);
  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn(receivedScope(OLD_ACCOUNT));
  await fixture.sourceTurn(statusScopeFor(OLD_ACCOUNT));

  assertResendAdmissions(fixture, [receivedAdmission(OLD_ACCOUNT, P, 1), receivedAdmission(OLD_ACCOUNT, E0, 1)]);
  assertDrained(fixture, OLD_ACCOUNT, 'status', true);
  assertDrained(fixture, OLD_ACCOUNT, 'received', true);
  fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
}

async function replacementNewOnlyBaselines(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  await beginScopedResendReplacement(fixture, edge, 'R:replace-new-only-baselines-at-anchor', {}, report);
  assert.equal(
    fixture.store.database
      .prepare(
        "SELECT 1 FROM activation_baselines WHERE source = 'resend' AND account_id = ? AND position_scope = 'received'",
      )
      .get(NEW_ACCOUNT) !== undefined,
    true,
    'the new-only received account has its independently sampled anchor before the swap',
  );
  await completeScopedReceivedDrain(fixture);
  await fixture.runtime.resumeClaimedCompletions();

  fixture.setResendReceivedReader(receivedReader([P]));
  await primeResendCursors(fixture, 4);
  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  await fixture.sourceTurn(receivedScope(NEW_ACCOUNT));
  await fixture.sourceTurn(statusScopeFor(NEW_ACCOUNT)); // seeds the P status state without admitting it
  fixture.now.value += 1;
  fixture.setResendSentStatus('bounced');
  await fixture.sourceTurn(statusScopeFor(NEW_ACCOUNT));

  assertResendAdmissions(fixture, [
    receivedAdmission(OLD_ACCOUNT, P, 1),
    receivedAdmission(OLD_ACCOUNT, E0, 1),
    receivedAdmission(SHARED_ACCOUNT, P, 1),
    receivedAdmission(SHARED_ACCOUNT, E0, 1),
    statusAdmissionAt(SHARED_ACCOUNT, 'sent', 'delivered', fixture.now.value - 1, 2),
    receivedAdmission(NEW_ACCOUNT, E1, 2),
    statusAdmission(fixture, NEW_ACCOUNT, 'delivered', 'bounced', 2),
  ]);
}

async function replacementSharedAdmitsOneVersion(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  await beginScopedResendReplacement(fixture, edge, 'R:replace-shared-one-version-per-occurrence', {}, report);
  await completeScopedReceivedDrain(fixture);
  await fixture.runtime.resumeClaimedCompletions();

  fixture.setResendReceivedReader(receivedReader([E2, E1, P, E0, X0]));
  await fixture.sourceTurn(receivedScope(SHARED_ACCOUNT));
  await fixture.sourceTurn(statusScopeFor(SHARED_ACCOUNT));
  fixture.now.value += 1;
  fixture.setResendSentStatus('bounced');
  await fixture.sourceTurn(statusScopeFor(SHARED_ACCOUNT));

  assertResendAdmissions(fixture, [
    receivedAdmission(OLD_ACCOUNT, P, 1),
    receivedAdmission(OLD_ACCOUNT, E0, 1),
    receivedAdmission(SHARED_ACCOUNT, P, 1),
    receivedAdmission(SHARED_ACCOUNT, E0, 1),
    receivedAdmission(SHARED_ACCOUNT, E1, 2),
    receivedAdmission(SHARED_ACCOUNT, E2, 2),
    statusAdmission(fixture, SHARED_ACCOUNT, 'delivered', 'bounced', 2),
  ]);
}

async function enableAllRebaselinesReaddedAccount(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await fixture.activate(1, RECEIVED_AND_STATUS);
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  await fixture.disableAll();
  fixture.removeAccount();
  fixture.readdAccount();
  fixture.now.value += 1;
  fixture.setResendReceivedBaseline(P);
  await activateAtResendDurableEdge(fixture, 'R:enable-all-rebaselines-readded-account', edge, () => fixture.enable(), {
    providerFenced: false,
    report,
  });

  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  fixture.now.value += 1;
  fixture.setResendSentStatus('delivered');
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
  ]);
}

async function timeoutKeepsAnchorAndRetries(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await fixture.activate(1, RECEIVED_AND_STATUS);
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  fixture.setResendReceivedBaseline(P);
  await beginReplacementAtEdge(fixture, edge, 'R:timeout-keeps-anchor-and-retries', [fixture.accountId], report, false);
  fixture.now.value += 3_600_001;
  const callsBeforeTimeout = fixture.calls.length;
  await fixture.recover();
  assert.equal(fixture.failedCompletions(), 1, 'the incomplete replacement is settled at its original deadline');
  assert.equal(fixture.calls.length, callsBeforeTimeout, 'timeout performs no provider retry before settlement');

  fixture.setResendReceivedReader(receivedReader([E1, P, X0]));
  await fixture.sourceTurn();
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, P, 1),
    receivedAdmission(fixture.accountId, E1, 1),
  ]);
}

async function initialAnchorAndStatusStartAtomic(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(P);
  await activateAtResendDurableEdge(
    fixture,
    'R:initial-anchor-and-status-start-atomic',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  const points = fixture.store.database
    .prepare(
      "SELECT position_scope FROM rule_activation_points WHERE source = 'resend' AND account_id = ? ORDER BY position_scope",
    )
    .all(fixture.accountId)
    .map((row) => (row as { position_scope: string }).position_scope);
  assert.deepEqual(points, ['received', 'status'], 'received anchor and status start publish as one first activation');
  assert.equal(fixture.calls.length, 0, 'the disabled atomic initial publication made no provider call');
  fixture.setResendReceivedReader(receivedReader([P]));
  await fixture.enable();
  await fixture.schedulerTurn();
  await fixture.schedulerTurn();
  const cursors = fixture.store.database
    .prepare("SELECT cursor_scope FROM cursors WHERE source = 'resend' AND account_id = ? ORDER BY cursor_scope")
    .all(fixture.accountId)
    .map((row) => (row as { cursor_scope: string }).cursor_scope);
  assert.deepEqual(cursors, ['received', 'status'], 'both initial cursors are installed with the published points');
}

async function claimedPFencesReceivedAndStatusWorker(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  // Keep v1 active on both scopes.  The new independent rule then owns an
  // unpublished P for exactly the same source scopes, so this is a scheduler
  // path that would otherwise invoke both workers rather than an empty scope.
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await fixture.activate(1, RECEIVED_AND_STATUS);
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));

  fixture.now.value += 1;
  fixture.setResendReceivedBaseline(P);
  await activateAtResendDurableEdge(
    fixture,
    'R:claimed-P-fences-received-and-status-worker',
    edge,
    () => fixture.activateAdditionalRule(`rule-fence-edge-${edge ?? 'none'}`, RECEIVED_AND_STATUS),
    { providerFenced: false, report },
  );

  // Every outer edge additionally proves the claimed-and-unpublished state:
  // `before-stage` has not sampled P yet and `after-move` has already
  // published it, so neither alone can make the source-fence assertion.
  await fixture.setFailpoint((at) => {
    if (at === 'before-finalise') throw new Error('claimed P remains unpublished for fence probe');
  });
  await assert.rejects(
    () => fixture.activateAdditionalRule(`rule-fence-probe-${edge ?? 'none'}`, RECEIVED_AND_STATUS),
    /claimed P remains unpublished for fence probe/,
  );
  await assertResendSchedulerFenced(fixture);
  await fixture.restart();
  await fixture.recover();

  const callsBeforeNormalCollection = fixture.calls.length;
  fixture.now.value += 60_000;
  await fixture.schedulerTurn();
  fixture.now.value += 60_000;
  await fixture.schedulerTurn();
  assert.ok(fixture.calls.length > callsBeforeNormalCollection, 'both workers collect normally after publication');
}

async function deadlineAtPAfterPAndFinaliseSettlesWithoutWrite(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  // The outer activation is the cell's durable-edge/restart probe.  The three
  // inner rule activations then make each deadline branch settle in the same
  // database without creating source content.
  fixture.setResendReceivedBaseline(P);
  await activateAtResendDurableEdge(
    fixture,
    'R:deadline-at-P-after-P-and-finalise-settles-without-write',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  for (const [index, deadlineEdge] of [
    'before-claim-deadline',
    'before-baseline-deadline',
    'before-finalise-deadline',
  ].entries()) {
    const callsBefore = fixture.baselineCalls;
    const pointEncryptionsBefore = fixture.pointEncryptions;
    await fixture.setDeadlineFailpoint((at) => {
      if (at === deadlineEdge) fixture.now.value += 3_600_001;
    });
    await assert.rejects(() =>
      fixture.activateAdditionalRule(`rule-deadline-${edge ?? 'none'}-${index}`, RECEIVED_AND_STATUS),
    );
    assert.equal(fixture.failedCompletions(), index + 1, `${deadlineEdge} settles its claimed completion`);
    assert.equal(
      fixture.baselineCalls - callsBefore,
      index === 0 ? 0 : 2,
      `${deadlineEdge} stops before its next source baseline write`,
    );
    assert.equal(
      fixture.pointEncryptions - pointEncryptionsBefore,
      index === 2 ? 2 : 0,
      `${deadlineEdge} permits no later point encryption before its own deadline check`,
    );
    fixture.assertContentFreeSettlement();
    await fixture.setDeadlineFailpoint(undefined);
  }
  fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
}

async function initialCursorRechecksPublishedPoints(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await activateAtResendDurableEdge(
    fixture,
    'R:initial-cursor-rechecks-points-under-received-and-status-locks',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  await fixture.enable();
  fixture.setResendReceivedBaseline(P);
  let concurrentPointPublications = 0;
  fixture.setSchedulerPointDecryptHook(async () => {
    if (concurrentPointPublications >= 2) return;
    concurrentPointPublications += 1;
    await fixture.activateAdditionalRule(`rule-later-${concurrentPointPublications}`, RECEIVED_AND_STATUS);
  });
  // A production scheduler source turn obtains its point set, decrypts it, and
  // then lets the concurrent activation publish a newer received/status pair
  // before the cursor insert transaction re-reads that set. Run one turn for
  // each Resend scope so neither installs a stale initial cursor.
  await fixture.schedulerTurn();
  fixture.now.value += 60_000;
  await fixture.schedulerTurn();
  fixture.setSchedulerPointDecryptHook(undefined);
  assert.equal(concurrentPointPublications, 2, 'the received and status cursor attempts both raced a publication');
  const staleCursors = fixture.store.database
    .prepare("SELECT cursor_scope FROM cursors WHERE source = 'resend' AND account_id = ? ORDER BY cursor_scope")
    .all(fixture.accountId);
  assert.deepEqual(staleCursors, [], 'neither scope persists the point set it read before the concurrent publication');

  fixture.setResendReceivedReader(receivedReader([P, X0]));
  await primeResendCursors(fixture, 4);
  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  await fixture.sourceTurn();
  fixture.setResendSentStatus('delivered');
  fixture.now.value += 1;
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, P, 1),
    receivedAdmission(fixture.accountId, E1, 1),
    receivedAdmission(fixture.accountId, E1, 1),
    receivedAdmission(fixture.accountId, E1, 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 1),
  ]);
}

async function tighteningTransfersReceivedAndStatusDebts(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await activateAtResendDurableEdge(
    fixture,
    'R:tighten-transfers-received-and-status-debts-stale-scan-writes-nothing',
    edge,
    () => fixture.activate(1, RECEIVED_AND_STATUS),
    { report },
  );
  await fixture.enable();
  await primeResendCursors(fixture, 2);
  await fixture.sourceTurn(statusScope(fixture));
  fixture.setResendReceivedReader(receivedReader([E1, X0]));
  fixture.setResendSentStatus('delivered');
  await fixture.setFailpoint((at) => {
    if (at === 'after-stage') throw new Error('received debt staged before tightening');
  });
  await assert.rejects(() => fixture.sourceTurn(), /received debt staged before tightening/);
  await assert.rejects(() => fixture.sourceTurn(statusScope(fixture)), /received debt staged before tightening/);
  await fixture.setFailpoint(undefined);
  await fixture.tighten(RECEIVED_AND_STATUS);
  await fixture.sourceTurn();
  await fixture.sourceTurn(statusScope(fixture));
  assertResendAdmissions(fixture, [
    receivedAdmission(fixture.accountId, E1, 2),
    statusAdmission(fixture, fixture.accountId, 'sent', 'delivered', 2),
  ]);
}

async function swapDropsOldOnlyDebts(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  report: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  await beginScopedResendReplacement(
    fixture,
    edge,
    'R:swap-drops-old-only-received-and-status-debts',
    {
      stageOldStatusDebt: true,
    },
    report,
  );
  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  await completeScopedReceivedDrain(fixture, { includeStatus: false });
  assertDrained(fixture, OLD_ACCOUNT, 'received', true);

  // The old cursor has certified P but its pointer has not swapped yet. A
  // later old-only stage is therefore real owed work until finalisation; the
  // swap must discard it, for both Resend representations, rather than retain
  // an unreachable encrypted row forever.
  fixture.now.value += 1;
  fixture.setResendReceivedReader(receivedReader([E2, E1, P, E0, X0]));
  await fixture.setFailpoint((at) => {
    if (at === 'after-stage') throw new Error('old-only debt staged before swap');
  });
  await assert.rejects(() => fixture.sourceTurn(receivedScope(OLD_ACCOUNT)), /old-only debt staged before swap/);
  await fixture.setFailpoint(undefined);
  await fixture.runtime.resumeClaimedCompletions();
  assert.equal(
    fixture.store.database
      .prepare(
        `SELECT 1 FROM source_stage_rule_debts debt
          JOIN source_scan_state stage ON stage.id = debt.stage_id
         WHERE stage.source = 'resend' AND stage.account_id = ?`,
      )
      .get(OLD_ACCOUNT),
    undefined,
    'the completed swap deletes every old-only received and status debt',
  );
}

async function beginScopedResendReplacement(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  cell: string,
  input: Readonly<{ stageOldStatusDebt?: boolean; finishPointerEdges?: boolean }> = {},
  report?: (outcome: ResendDurableEdgeRun['outcome']) => void,
): Promise<void> {
  for (const accountId of [OLD_ACCOUNT, SHARED_ACCOUNT, NEW_ACCOUNT])
    fixture.config.accounts[`replacement-${accountId}`] = { id: accountId, platform: 'resend' } as never;
  fixture.setResendReceivedBaseline(X0);
  fixture.setResendReceivedReader(receivedReader([X0]));
  await fixture.activate(1, RECEIVED_AND_STATUS, 'safe', [OLD_ACCOUNT, SHARED_ACCOUNT]);
  await fixture.enable();
  await primeResendCursors(fixture, 4);
  for (const accountId of [OLD_ACCOUNT, SHARED_ACCOUNT]) {
    await fixture.sourceTurn(receivedScope(accountId));
    await fixture.sourceTurn(statusScopeFor(accountId));
  }
  if (input.stageOldStatusDebt === true) {
    fixture.setResendSentItems([
      { id: IDS.resendId, status: 'sent' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'sent' },
    ]);
    await fixture.sourceTurn(statusScopeFor(OLD_ACCOUNT));
    fixture.setResendSentItems([
      { id: IDS.resendId, status: 'sent' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'delivered' },
    ]);
    await fixture.setFailpoint((at) => {
      if (at === 'after-stage') throw new Error('old-only status debt staged before replacement');
    });
    await assert.rejects(
      () => fixture.sourceTurn(statusScopeFor(OLD_ACCOUNT)),
      /old-only status debt staged before replacement/,
    );
    await fixture.setFailpoint(undefined);
    fixture.setResendSentStatus('sent');
  }
  fixture.now.value += 1;
  fixture.setResendReceivedBaseline(P);
  await beginReplacementAtEdge(
    fixture,
    edge,
    cell,
    [NEW_ACCOUNT, SHARED_ACCOUNT],
    report,
    input.finishPointerEdges !== false,
  );
}

async function beginReplacementAtEdge(
  fixture: PhaseDCutoverFixture,
  edge: (typeof DURABLE_CUTOVER_EDGES)[number] | undefined,
  cell: string,
  accounts: readonly string[] = [fixture.accountId],
  report?: (outcome: ResendDurableEdgeRun['outcome']) => void,
  finishPointerEdges = true,
): Promise<void> {
  await activateAtResendDurableEdge(
    fixture,
    cell,
    edge,
    async () => {
      try {
        await fixture.activate(2, RECEIVED_AND_STATUS, 'changed', accounts);
      } catch (error: unknown) {
        if ((error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING') return;
        throw error;
      }
    },
    // D12 leaves an enabled replacement's old version running through P;
    // unlike an unpublished first activation, that old drain is not fenced.
    {
      providerFenced: false,
      report,
      ...(finishPointerEdges
        ? {
            finishClaimedCompletion: async () => {
              fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
              fixture.setResendSentStatus('delivered');
              await completeScopedReceivedDrain(fixture);
              await fixture.runtime.resumeClaimedCompletions();
            },
          }
        : {
            assertUnreachable: () => {
              assert.equal(
                edge === 'before-move' || edge === 'after-move' || edge === 'before-finalise',
                true,
                `${cell}: only its deliberately incomplete pointer edges are unreachable`,
              );
            },
          }),
    },
  );
}

async function completeScopedReceivedDrain(
  fixture: PhaseDCutoverFixture,
  input: Readonly<{ includeStatus?: boolean }> = {},
): Promise<void> {
  fixture.setResendReceivedReader(receivedReader([E1, P, E0, X0]));
  if (input.includeStatus !== false) fixture.setResendSentStatus('delivered');
  for (const accountId of [OLD_ACCOUNT, SHARED_ACCOUNT]) {
    await fixture.sourceTurn(receivedScope(accountId));
    if (input.includeStatus !== false) await fixture.sourceTurn(statusScopeFor(accountId));
  }
}

async function primeResendCursors(fixture: PhaseDCutoverFixture, turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    // Resend's declared fair-poll floor is one minute; each turn must become
    // eligible again so the scheduler reaches the next scope instead of
    // repeatedly observing the same not-yet-ready row.
    fixture.now.value += 60_000;
    await fixture.schedulerTurn();
  }
}

async function advancePastResendPoll(fixture: PhaseDCutoverFixture): Promise<void> {
  fixture.now.value += 60_000;
  await fixture.schedulerTurn();
}

async function assertResendSchedulerFenced(fixture: PhaseDCutoverFixture): Promise<void> {
  const callsBefore = fixture.calls.length;
  const rawBefore = Number(
    (
      fixture.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM ingest WHERE type IN ('resend.email.received', 'resend.email.status_changed')",
        )
        .get() as { count: number }
    ).count,
  );
  const stagedBefore = Number(
    (
      fixture.store.database
        .prepare("SELECT COUNT(*) AS count FROM source_scan_state WHERE source = 'resend'")
        .get() as { count: number }
    ).count,
  );
  // The fair scheduler reaches one due scope per tick.  Advance past its
  // declared one-minute floor between ticks so received and status are both
  // eligible opportunities, not a no-op on a future next slot.
  await advancePastResendPoll(fixture);
  await advancePastResendPoll(fixture);
  assert.equal(fixture.calls.length, callsBefore, 'unpublished P fences both scheduler provider calls');
  assert.equal(
    Number(
      (
        fixture.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM ingest WHERE type IN ('resend.email.received', 'resend.email.status_changed')",
          )
          .get() as { count: number }
      ).count,
    ),
    rawBefore,
    'unpublished P writes no received/status occurrence',
  );
  assert.equal(
    Number(
      (
        fixture.store.database
          .prepare("SELECT COUNT(*) AS count FROM source_scan_state WHERE source = 'resend'")
          .get() as { count: number }
      ).count,
    ),
    stagedBefore,
    'unpublished P writes no received/status stage',
  );
}

function receivedReader(ids: readonly string[]) {
  return {
    listReceived: async () => ({ emails: ids.map((id) => ({ id })), next: null }),
    getReceived: async (id: string) => receivedCandidate(id),
  };
}

function receivedScope(accountId: string) {
  return { source: 'resend' as const, accountId, scopeId: 'received' as const };
}

function statusScope(fixture: PhaseDCutoverFixture) {
  return statusScopeFor(fixture.accountId);
}

function statusScopeFor(accountId: string) {
  return { source: 'resend' as const, accountId, scopeId: 'status' as const };
}

function receivedAdmission(accountId: string, dedupeKey: string, ruleVersion: number) {
  return { accountId, dedupeKey, ruleVersion, type: 'resend.email.received' as const };
}

function statusAdmission(
  fixture: PhaseDCutoverFixture,
  accountId: string,
  previous: string,
  current: string,
  ruleVersion: number,
) {
  return statusAdmissionAt(accountId, previous, current, fixture.now.value, ruleVersion);
}

function statusAdmissionAt(
  accountId: string,
  previous: string,
  current: string,
  observedAt: number,
  ruleVersion: number,
) {
  return {
    accountId,
    dedupeKey: JSON.stringify([IDS.resendId, previous, current, new Date(observedAt).toISOString()]),
    ruleVersion,
    type: 'resend.email.status_changed' as const,
  };
}

function assertDrained(
  fixture: PhaseDCutoverFixture,
  accountId: string,
  scope: 'received' | 'status',
  drained: boolean,
): void {
  const row = fixture.store.database
    .prepare(
      "SELECT drained_at FROM replacement_drains WHERE source = 'resend' AND account_id = ? AND position_scope = ?",
    )
    .get(accountId, scope) as { drained_at: number | null } | undefined;
  assert.equal(row !== undefined && (row.drained_at !== null) === drained, true, `${accountId}/${scope} drain state`);
}

test('R: every received/status durable edge reopens the same source state and fake journal', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const edge of DURABLE_CUTOVER_EDGES) {
    const fixture = await PhaseDCutoverFixture.create('resend');
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
      // Resend's first cursor is scheduler-owned; this tick installs the
      // anchor and leaves the actual received/status turn below to cross the seam.
      await fixture.schedulerTurn();
      await fixture.setFailpoint((at) => {
        if (at === edge) throw new Error(`cut-over crash:${edge}`);
      });
      await assert.rejects(() => fixture.sourceTurn(), new RegExp(`cut-over crash:${edge}`), edge);
      const before = await fixture.journal();
      await fixture.restart();
      await fixture.sourceTurn();
      fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
      assert.ok((await fixture.journal()).length >= before.length, `${edge} retains the durable provider journal`);
    } finally {
      await fixture.dispose();
    }
  }
});

test('R: replacement has distinct old-only, new-only and shared received/status accounts', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    await fixture.beginScopedReplacement();
    fixture.assertScopedReplacement();
  } finally {
    await fixture.dispose();
  }
});

test('R: a received rule admits one newer email in each completed cycle', { skip: WINDOWS_SKIP }, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    let cycle = 0;
    fixture.setResendReceivedReader({
      listReceived: async () => {
        cycle += 1;
        if (cycle === 1) return { emails: [{ id: E1 }, { id: X0 }], next: null };
        if (cycle === 2) return { emails: [{ id: E2 }, { id: E1 }], next: null };
        throw new Error(`unexpected received cycle ${cycle}`);
      },
      getReceived: async (id) => receivedCandidate(id),
    });

    // The scheduler owns first-cursor installation; it then runs cycle 1 through the production owner path.
    await fixture.schedulerTurn();
    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare('SELECT dedupe_key FROM ingest ORDER BY dedupe_key')
        .all()
        .map((row) => ({ ...row })),
      [{ dedupe_key: E1 }, { dedupe_key: E2 }],
    );
    assert.deepEqual(
      fixture.store.database
        .prepare('SELECT rule_id, rule_version FROM decisions ORDER BY rule_id, rule_version')
        .all()
        .map((row) => ({ ...row })),
      [
        { rule_id: 'rule-cutover', rule_version: 1 },
        { rule_id: 'rule-cutover', rule_version: 1 },
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: independent received points keep their cut-over across three completed cycles', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    fixture.setResendReceivedBaseline(P);
    await fixture.activateAdditionalRule('rule-later', RECEIVED);
    let cycle = 0;
    fixture.setResendReceivedReader({
      listReceived: async (after) => {
        if (after === 'first-page') return { emails: [{ id: P }, { id: E0 }, { id: X0 }], next: null };
        cycle += 1;
        if (cycle === 1) return { emails: [{ id: E1 }], next: 'first-page' };
        if (cycle === 2) return { emails: [{ id: E2 }, { id: E1 }], next: null };
        if (cycle === 3) return { emails: [{ id: E3 }, { id: E2 }], next: null };
        throw new Error(`unexpected received cycle ${cycle}`);
      },
      getReceived: async (id) => (id === P ? { kind: 'vanished' as const } : receivedCandidate(id)),
    });

    await fixture.schedulerTurn();
    await fixture.sourceTurn();
    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: E0, rule_id: 'rule-cutover' },
        { dedupe_key: E1, rule_id: 'rule-cutover' },
        { dedupe_key: E1, rule_id: 'rule-later' },
        { dedupe_key: E2, rule_id: 'rule-cutover' },
        { dedupe_key: E2, rule_id: 'rule-later' },
        { dedupe_key: E3, rule_id: 'rule-cutover' },
        { dedupe_key: E3, rule_id: 'rule-later' },
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: re-approval after the last received rule revokes skips pre-point details and admits each post-point page once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();
    await fixture.revokeByRule();

    fixture.setResendReceivedBaseline(P);
    await fixture.activateAdditionalRule('rule-reapproved', RECEIVED);
    fixture.setResendReceivedReader({
      listReceived: async (after) =>
        after === undefined
          ? { emails: [{ id: E2 }, { id: E1 }], next: 'page-2' }
          : { emails: [{ id: P }, { id: E0 }, { id: X0 }], next: null },
      getReceived: async (id) => receivedCandidate(id),
    });
    const before = fixture.calls.filter((call) => call === 'resend.getReceived').length;

    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: E1, rule_id: 'rule-reapproved' },
        { dedupe_key: E2, rule_id: 'rule-reapproved' },
      ],
    );
    assert.equal(
      fixture.calls.filter((call) => call === 'resend.getReceived').length - before,
      2,
      'the revoked interval and P are content-free only',
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: exact received replacement caps the old drain at P and leaves newer mail for the published child', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();

    fixture.setResendReceivedBaseline(P);
    await assert.rejects(
      () => fixture.activate(2, RECEIVED, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    let phase: 'drain' | 'child' = 'drain';
    fixture.setResendReceivedReader({
      listReceived: async (after) => {
        if (phase === 'child') return { emails: [{ id: E2 }, { id: E1 }, { id: P }], next: null };
        return after === undefined
          ? { emails: [{ id: E2 }, { id: E1 }], next: 'page-2' }
          : { emails: [{ id: P }, { id: E0 }, { id: X0 }], next: null };
      },
      getReceived: async (id) => receivedCandidate(id),
    });
    const before = fixture.calls.filter((call) => call === 'resend.getReceived').length;

    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: P, rule_id: 'rule-cutover', rule_version: 1 },
        { dedupe_key: E0, rule_id: 'rule-cutover', rule_version: 1 },
      ],
      'the old version receives P and its older interval only',
    );
    assert.equal(
      fixture.calls.filter((call) => call === 'resend.getReceived').length - before,
      2,
      'newer post-P items stay content-free while the old version drains',
    );

    await fixture.runtime.resumeClaimedCompletions();
    phase = 'child';
    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: P, rule_id: 'rule-cutover', rule_version: 1 },
        { dedupe_key: E0, rule_id: 'rule-cutover', rule_version: 1 },
        { dedupe_key: E1, rule_id: 'rule-cutover', rule_version: 2 },
        { dedupe_key: E2, rule_id: 'rule-cutover', rule_version: 2 },
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: a cap leaves a later received point unreached until its own anchor is crossed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();

    fixture.now.value += 1;
    fixture.setResendReceivedBaseline(P);
    await assert.rejects(
      () => fixture.activate(2, RECEIVED, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );

    fixture.now.value += 1;
    fixture.setResendReceivedBaseline(E1);
    await fixture.activateAdditionalRule('rule-later', RECEIVED);

    let phase: 'drain' | 'first-child' | 'second-child' = 'drain';
    fixture.setResendReceivedReader({
      listReceived: async () => {
        if (phase === 'drain')
          return { emails: [{ id: E2 }, { id: E1 }, { id: E0 }, { id: P }, { id: X0 }], next: null };
        if (phase === 'first-child') return { emails: [{ id: E2 }, { id: E1 }, { id: E0 }, { id: P }], next: null };
        return { emails: [{ id: E3 }, { id: E2 }], next: null };
      },
      getReceived: async (id) => receivedCandidate(id),
    });

    await fixture.sourceTurn();
    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [{ dedupe_key: P, rule_id: 'rule-cutover', rule_version: 1 }],
      'the later rule receives none of the suffix below its own point before the swap',
    );

    await fixture.runtime.resumeClaimedCompletions();
    phase = 'first-child';
    await fixture.sourceTurn();
    phase = 'second-child';
    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: P, rule_id: 'rule-cutover', rule_version: 1 },
        { dedupe_key: E0, rule_id: 'rule-cutover', rule_version: 2 },
        { dedupe_key: E1, rule_id: 'rule-cutover', rule_version: 2 },
        { dedupe_key: E2, rule_id: 'rule-cutover', rule_version: 2 },
        { dedupe_key: E2, rule_id: 'rule-later', rule_version: 1 },
        { dedupe_key: E3, rule_id: 'rule-cutover', rule_version: 2 },
        { dedupe_key: E3, rule_id: 'rule-later', rule_version: 1 },
      ],
      'the child receives every post-P email once, while the later rule receives only mail after its own point',
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: a lost shared received anchor during a drain re-baselines at P without reading the lost window', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();

    fixture.now.value += 1;
    fixture.setResendReceivedBaseline(P);
    await assert.rejects(
      () => fixture.activate(2, RECEIVED, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );

    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: E2 }, { id: P }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    const detailsBefore = fixture.calls.filter((call) => call === 'resend.getReceived').length;

    await fixture.sourceTurn();

    assert.equal(
      fixture.calls.filter((call) => call === 'resend.getReceived').length - detailsBefore,
      0,
      'the bounded lost window never reaches the detail endpoint',
    );
    assert.equal(
      Number(
        (fixture.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      ),
      0,
    );
    assert.equal(
      Number(
        (
          fixture.store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as { count: number }
        ).count,
      ),
      2,
      'the source loss and incomplete old drain each record one content-free gap',
    );

    await fixture.runtime.resumeClaimedCompletions();
    await fixture.sourceTurn();
    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [{ dedupe_key: E2, rule_version: 2 }],
      'the published child receives the post-P mail once after the capped re-baseline',
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: a received drain waits for a cycle that contains P when P was sampled during an older cycle', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();

    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: E0 }, { id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.setFailpoint((edge) => {
      if (edge === 'after-stage') throw new Error('leave older received cycle in progress');
    });
    await assert.rejects(() => fixture.sourceTurn(), /older received cycle/);
    await fixture.setFailpoint(undefined);

    fixture.now.value += 1;
    fixture.setResendReceivedBaseline(P);
    await assert.rejects(
      () => fixture.activate(2, RECEIVED, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    let reachedP = false;
    fixture.setResendReceivedReader({
      listReceived: async () =>
        reachedP
          ? { emails: [{ id: P }, { id: E1 }, { id: E0 }], next: null }
          : { emails: [{ id: E0 }, { id: X0 }], next: null },
      getReceived: async (id) => receivedCandidate(id),
    });

    await fixture.sourceTurn();

    assert.equal(
      (
        fixture.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM replacement_drains WHERE source = 'resend' AND position_scope = 'received' AND drained_at IS NULL",
          )
          .get() as { count: number }
      ).count,
      1,
      'an older cycle that cannot contain P must not complete the new drain',
    );
    reachedP = true;
    await fixture.sourceTurn();

    assert.equal(
      (
        fixture.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM replacement_drains WHERE source = 'resend' AND position_scope = 'received' AND drained_at IS NULL",
          )
          .get() as { count: number }
      ).count,
      0,
    );
    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_version
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_version`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: P, rule_version: 1 },
        { dedupe_key: E0, rule_version: 1 },
        { dedupe_key: E1, rule_version: 1 },
      ],
      'the pre-swap old version receives every occurrence from its older head through P exactly once',
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: a deleted received drain point fails closed, records one gap, and does not stall the swap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    await fixture.schedulerTurn();

    fixture.now.value += 1;
    fixture.setResendReceivedBaseline(P);
    await assert.rejects(
      () => fixture.activate(2, RECEIVED, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: E1 }, { id: X0 }], next: null }),
      getReceived: async (id) => receivedCandidate(id),
    });

    await fixture.sourceTurn();

    assert.equal(
      Number(
        (fixture.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      ),
      0,
      'the old version cannot admit an email whose position relative to deleted P is unknown',
    );
    assert.equal(
      Number(
        (
          fixture.store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as { count: number }
        ).count,
      ),
      1,
    );
    await fixture.runtime.resumeClaimedCompletions();
    assert.equal(
      Number(
        (
          fixture.store.database
            .prepare("SELECT COUNT(*) AS count FROM activation_intents WHERE status = 'pending-completion'")
            .get() as { count: number }
        ).count,
      ),
      0,
      'the content-free settlement permits the replacement to publish',
    );
  } finally {
    await fixture.dispose();
  }
});

test('R: a missing received point re-baselines that version once and records one content-free gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    fixture.setResendReceivedBaseline(P);
    await fixture.activateAdditionalRule('rule-later', RECEIVED);
    let cycle = 0;
    fixture.setResendReceivedReader({
      listReceived: async () => {
        cycle += 1;
        if (cycle === 1) return { emails: [{ id: E0 }, { id: X0 }], next: null };
        if (cycle === 2) return { emails: [{ id: E1 }, { id: E0 }], next: null };
        throw new Error(`unexpected received cycle ${cycle}`);
      },
      getReceived: async (id) => receivedCandidate(id),
    });

    await fixture.schedulerTurn();
    await fixture.sourceTurn();

    assert.deepEqual(
      fixture.store.database
        .prepare(
          `SELECT ingest.dedupe_key, decisions.rule_id
             FROM decisions JOIN ingest ON ingest.event_id = decisions.event_id
             ORDER BY ingest.dedupe_key, decisions.rule_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      [
        { dedupe_key: E0, rule_id: 'rule-cutover' },
        { dedupe_key: E1, rule_id: 'rule-cutover' },
        { dedupe_key: E1, rule_id: 'rule-later' },
      ],
    );
    const gaps = fixture.store.database
      .prepare("SELECT id, kind FROM operational_records WHERE kind = 'agentcomms.source.gap' ORDER BY id")
      .all()
      .map((row) => ({ ...row }));
    assert.equal(gaps.length, 1, 'the missing later point records exactly one source gap');
    assert.match(String(gaps[0]?.id), /^resend-received-point-gap:/, 'the gap carries no provider content');
  } finally {
    await fixture.dispose();
  }
});

test('R: a reached received point survives restart between completed cycles', { skip: WINDOWS_SKIP }, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline(X0);
    await fixture.activate(1, RECEIVED);
    await fixture.enable();
    let cycle = 0;
    fixture.setResendReceivedReader({
      listReceived: async () => {
        cycle += 1;
        if (cycle === 1) return { emails: [{ id: E1 }, { id: X0 }], next: null };
        if (cycle === 2) return { emails: [{ id: E2 }, { id: E1 }], next: null };
        throw new Error(`unexpected received cycle ${cycle}`);
      },
      getReceived: async (id) => receivedCandidate(id),
    });

    await fixture.schedulerTurn();
    await fixture.restart();
    await fixture.sourceTurn();

    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 1] });
  } finally {
    await fixture.dispose();
  }
});

test('P1-D2: a shared Resend received anchor admits a pre-later-point message only to the earlier rule', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline('watermark');
    await fixture.activate();
    await fixture.enable();
    fixture.setResendReceivedBaseline('point');
    await fixture.activateAdditionalRule('rule-later');
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: 'point' }, { id: IDS.resendId }, { id: 'watermark' }], next: null }),
      getReceived: async (id) =>
        id === 'point'
          ? { kind: 'vanished' as const }
          : {
              kind: 'candidate' as const,
              candidate: {
                emailId: IDS.resendId,
                receivedAt: '2026-10-09T12:00:00.000Z',
                subject: 'between anchors',
                attachments: [],
                attachmentCount: 0,
                from: null,
                replyTo: [],
                to: [],
                cc: [],
                receivedFor: [],
                messageId: null,
                authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
              },
            },
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

test('P1-D2: enable-all takes a fresh Resend received anchor and does not backfill disabled-interval messages', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  try {
    fixture.setResendReceivedBaseline('watermark');
    await fixture.activate();
    await fixture.enable();
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: 'watermark' }], next: null }),
      getReceived: async () => ({ kind: 'vanished' as const }),
    });
    await fixture.schedulerTurn();
    await fixture.disableAll();
    fixture.now.value += 1;
    fixture.setResendReceivedBaseline('point');
    await fixture.enable();
    fixture.setResendReceivedReader({
      listReceived: async () => ({ emails: [{ id: 'point' }, { id: IDS.resendId }, { id: 'watermark' }], next: null }),
      getReceived: async (id) =>
        id === 'point'
          ? { kind: 'vanished' as const }
          : {
              kind: 'candidate' as const,
              candidate: {
                emailId: IDS.resendId,
                receivedAt: '2026-10-09T12:00:00.000Z',
                subject: 'while disabled',
                attachments: [],
                attachmentCount: 0,
                from: null,
                replyTo: [],
                to: [],
                cc: [],
                receivedFor: [],
                messageId: null,
                authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
              },
            },
    });

    await fixture.schedulerTurn();

    fixture.oracle({ raw: 0, admissions: 0 });
  } finally {
    await fixture.dispose();
  }
});

test('R: a status change before P belongs to the old version and one after P belongs only to the new version', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  const statusOptions = { channel: 'resend', kinds: ['status'] };
  try {
    await fixture.activate(1, statusOptions);
    await fixture.enable();
    await fixture.schedulerTurn();
    fixture.now.value += 1;
    fixture.setResendSentStatus('delivered');
    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'status' });

    fixture.now.value += 1;
    let draining = false;
    try {
      await fixture.activate(2, statusOptions, 'changed');
    } catch (error: unknown) {
      draining = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
      if (!draining) throw error;
    }
    fixture.now.value += 1;
    fixture.setResendSentStatus('bounced');
    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'status' });
    if (draining) await fixture.runtime.resumeClaimedCompletions();

    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 2] });
  } finally {
    await fixture.dispose();
  }
});

test('R: a post-P status change waits for the new version while a received drain still completes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await PhaseDCutoverFixture.create('resend');
  const options = { channel: 'resend', kinds: ['received', 'status'] };
  try {
    await fixture.activate(1, options);
    await fixture.enable();
    await fixture.schedulerTurn();
    fixture.now.value += 1;
    fixture.setResendSentStatus('delivered');
    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'status' });

    fixture.now.value += 1;
    await assert.rejects(
      () => fixture.activate(2, options, 'changed'),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
    );
    fixture.now.value += 1;
    fixture.setResendSentStatus('bounced');
    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'status' });
    fixture.oracle({ raw: 1, admissions: 1, versions: [1] });

    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'received' });
    await fixture.runtime.resumeClaimedCompletions();
    await fixture.sourceTurn({ source: 'resend', accountId: fixture.accountId, scopeId: 'status' });
    fixture.oracle({ raw: 2, admissions: 2, versions: [1, 2] });
  } finally {
    await fixture.dispose();
  }
});
