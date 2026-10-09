import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import {
  assertSlackOccurrences,
  forEachSlackDurableEdge,
  slackMessage as matrixSlackMessage,
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

for (const name of cells) {
  test(name, { skip: WINDOWS_SKIP }, async () => {
    if (await runRequiredSlackMatrixCell(name)) return;
    const fixture = await PhaseDCutoverFixture.create('slack');
    try {
      if (name === 'S:first-disabled-baselines-without-content') {
        await fixture.activate();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'S:claimed-P-fences-history-and-reply-worker') {
        await fixture.setFailpoint((edge) => {
          if (edge === 'before-finalise') throw new Error('leave P unpublished');
        });
        await assert.rejects(() => fixture.activate(), /leave P unpublished/);
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'S:deadline-at-P-after-P-and-finalise-settles-without-write') {
        for (const [index, deadlineEdge] of [
          'before-claim-deadline',
          'before-baseline-deadline',
          'before-finalise-deadline',
        ].entries()) {
          const attempt = index === 0 ? fixture : await PhaseDCutoverFixture.create('slack');
          await attempt.setDeadlineFailpoint((edge) => {
            if (edge === deadlineEdge) attempt.now.value += 3_600_001;
          });
          await assert.rejects(() => attempt.activate());
          assert.equal(attempt.failedCompletions(), 1, `${deadlineEdge} settles the claimed completion`);
          assert.equal(attempt.baselineCalls, index === 0 ? 0 : 1, `${deadlineEdge} stops at its own deadline gate`);
          assert.equal(attempt.pointEncryptions, index === 2 ? 1 : 0, `${deadlineEdge} writes no later point`);
          attempt.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
          attempt.assertContentFreeSettlement();
          if (attempt !== fixture) await attempt.dispose();
        }
        return;
      }
      if (name.includes('replace-old-only') || name.includes('replace-new-only') || name.includes('replace-shared')) {
        await fixture.activate();
        await fixture.enable();
        await fixture.replace();
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'S:disabled-replacement-marks-drains-complete') {
        await fixture.activate();
        await fixture.replaceWhileDisabled();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'S:tighten-preserves-old-P-and-new-boundary') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.tighten();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'S:disable-or-remove-cancels-and-purges') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.revokeByRule();
        const calls = fixture.calls.length;
        await fixture.schedulerTurn();
        assert.equal(fixture.calls.length, calls, 'a revoked rule leaves no source work to call the provider');
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'S:claim-recovery-resumes-same-drain') {
        await fixture.setFailpoint((edge) => {
          if (edge === 'after-stage') throw new Error('restart after durable baseline');
        });
        await assert.rejects(() => fixture.activate(), /restart after durable baseline/);
        await fixture.restart();
        await fixture.recover();
        await fixture.enable();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'S:remove-readd-stays-dark') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        fixture.removeAccount();
        await fixture.schedulerTurn();
        fixture.readdAccount();
        const calls = fixture.calls.length;
        await fixture.schedulerTurn();
        assert.equal(fixture.calls.length, calls, 're-add has no resurrected source point');
        fixture.oracle({ raw: 1, admissions: 1 });
        return;
      }
      await fixture.activate();
      await fixture.enable();
      await fixture.schedulerTurn();
      await fixture.restart();
      await fixture.sourceTurn();
      fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
      assert.equal(
        (await fixture.journal()).filter((entry) => entry === 'slack.history').length >= 1,
        true,
        'the exact Slack timestamp was obtained through the real source reader',
      );
      const row = fixture.store.database
        .prepare("SELECT dedupe_key FROM ingest WHERE type = 'slack.message.posted'")
        .get() as { dedupe_key: string } | undefined;
      assert.ok(row?.dedupe_key.includes(IDS.slackTs));
    } finally {
      await fixture.dispose();
    }
  });
}

async function runRequiredSlackMatrixCell(name: (typeof cells)[number]): Promise<boolean> {
  switch (name) {
    case 'S:first-enabled-page-and-reply-barrier':
      await firstEnabledPageAndReplyBarrier();
      return true;
    case 'S:replace-old-only-drains-history-and-replies':
      await replaceOldOnlyDrainsHistoryAndReplies();
      return true;
    case 'S:replace-new-only-baselines-at-P':
      await replaceNewOnlyBaselinesAtP();
      return true;
    case 'S:replace-shared-one-version-per-occurrence':
      await replaceSharedOneVersionPerOccurrence();
      return true;
    case 'S:enable-all-rebaselines-readded-scope':
      await enableAllRebaselinesReaddedScope();
      return true;
    case 'S:timeout-keeps-watermark-and-retries':
      await timeoutKeepsWatermarkAndRetries();
      return true;
    case 'S:initial-cursor-is-after-baseline':
      await initialCursorIsAfterBaseline();
      return true;
    case 'S:initial-cursor-rechecks-points-under-conversation-lock':
      await initialCursorRechecksPointsUnderConversationLock();
      return true;
    case 'S:tighten-transfers-page-and-reply-debts-stale-scan-writes-nothing':
      await tightenTransfersPageAndReplyDebts();
      return true;
    case 'S:swap-drops-old-only-history-and-reply-debts':
      await swapDropsOldOnlyHistoryAndReplyDebts();
      return true;
    default:
      return false;
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

async function firstEnabledPageAndReplyBarrier(): Promise<void> {
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
  });
}

async function replaceOldOnlyDrainsHistoryAndReplies(): Promise<void> {
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
    await fixture.sourceTurn();
    await fixture.runtime.resumeClaimedCompletions();
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
    await fixture.runtime.resumeClaimedCompletions();
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
    await fixture.runtime.resumeClaimedCompletions();
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
    const baseline = '1759999999.000000';
    const before = '1760000000.000000';
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
    await fixture.schedulerTurn();
    fixture.now.value += 3_000;
    collect = true;
    await sourceTurnThroughSlackDurableEdge(fixture, edge);
    fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
    assertSlackOccurrences(fixture, [{ ts: after, version: 1 }]);
    assert.equal(
      (
        fixture.store.database
          .prepare("SELECT cursor FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
          .get(fixture.accountId, fixture.scope.scopeId) as { cursor: string } | undefined
      )?.cursor,
      '1760000003.000000',
      'the first durable cursor begins after the published baseline and advances only after its staged page settles',
    );
  });
}

async function initialCursorRechecksPointsUnderConversationLock(): Promise<void> {
  await forEachSlackDurableEdge(async (fixture, edge) => {
    const earlierPoint = '1759999999.000000';
    const laterPoint = '1760000001.000000';
    const between = '1760000000.000000';
    const afterBoth = '1760000002.000000';
    fixture.setSlackBaseline(earlierPoint);
    await fixture.activate();
    await fixture.enable();
    fixture.setSlackBaseline(laterPoint);
    await fixture.activateAdditionalRule('rule-later');
    fixture.setSlackPages({
      history: async () => ({
        messages: [matrixSlackMessage({ ts: between })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    });
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
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
  });
}

async function swapDropsOldOnlyHistoryAndReplyDebts(): Promise<void> {
  await forEachSlackDurableEdge(async (fixture, edge) => {
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
    await fixture.runtime.resumeClaimedCompletions();
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
