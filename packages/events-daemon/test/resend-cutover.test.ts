import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DURABLE_CUTOVER_EDGES } from '../src/runtime/cutover-failpoint.ts';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const cells = [
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

for (const name of cells) {
  test(name, { skip: WINDOWS_SKIP }, async () => {
    const fixture = await PhaseDCutoverFixture.create('resend');
    try {
      if (name === 'R:first-disabled-seeds-anchor-and-status') {
        await fixture.activate();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'R:claimed-P-fences-received-and-status-worker') {
        await fixture.setFailpoint((edge) => {
          if (edge === 'before-finalise') throw new Error('leave P unpublished');
        });
        await assert.rejects(() => fixture.activate(), /leave P unpublished/);
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'R:deadline-at-P-after-P-and-finalise-settles-without-write') {
        for (const [index, deadlineEdge] of [
          'before-claim-deadline',
          'before-baseline-deadline',
          'before-finalise-deadline',
        ].entries()) {
          const attempt = index === 0 ? fixture : await PhaseDCutoverFixture.create('resend');
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
      if (name === 'R:disabled-replacement-marks-drains-complete') {
        await fixture.activate();
        await fixture.replaceWhileDisabled();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'R:tighten-preserves-anchor-and-status-seed') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.tighten();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'R:disable-or-remove-cancels-and-purges') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.revokeByTarget();
        const calls = fixture.calls.length;
        await fixture.schedulerTurn();
        assert.equal(fixture.calls.length, calls, 'a removed target leaves no source work to call the provider');
        fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
        return;
      }
      if (name === 'R:claim-recovery-resumes-same-cycle') {
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
      if (name === 'R:remove-readd-stays-dark') {
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
      assert.ok((await fixture.journal()).includes('resend.getReceived'));
      const row = fixture.store.database
        .prepare("SELECT dedupe_key FROM ingest WHERE type = 'resend.email.received'")
        .get() as { dedupe_key: string } | undefined;
      assert.ok(row?.dedupe_key.includes(IDS.resendId));
    } finally {
      await fixture.dispose();
    }
  });
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
