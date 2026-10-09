import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
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
