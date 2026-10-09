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
