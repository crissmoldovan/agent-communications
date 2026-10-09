import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DURABLE_CUTOVER_EDGES } from '../src/runtime/cutover-failpoint.ts';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const cells = [
  'W:first-enabled-stages-before-copy-dispose',
  'W:first-disabled-head-without-owed-stage',
  'W:replace-old-only-admits-by-old-generation',
  'W:replace-new-only-baselines-raw-generation',
  'W:replace-shared-raw-key-one-version',
  'W:disabled-replacement-no-owed-admission',
  'W:enable-all-rebaselines-authoritative-head',
  'W:tighten-preserves-raw-admission-boundary',
  'W:disable-or-remove-cancels-and-purges-hidden-tuples',
  'W:remove-readd-stays-dark-and-rechecks-list',
  'W:claim-recovery-keeps-authoritative-head',
  'W:timeout-discards-candidate-not-head',
  'W:initial-baseline-generation-and-identities-atomic',
  'W:claimed-P-fences-snapshot-worker',
  'W:initial-cursor-rechecks-generation-under-chat-lock',
  'W:tighten-transfers-first-representation-admissions-stale-snapshot-writes-nothing',
  'W:swap-drops-old-only-first-representation-debt',
  'W:deadline-at-P-after-P-and-finalise-settles-without-head-write',
] as const;

for (const name of cells) {
  test(name, { skip: WINDOWS_SKIP }, async () => {
    const fixture = await PhaseDCutoverFixture.create('whatsapp');
    try {
      if (name === 'W:first-disabled-head-without-owed-stage') {
        await fixture.activate();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'W:claimed-P-fences-snapshot-worker') {
        await fixture.setFailpoint((edge) => {
          if (edge === 'before-finalise') throw new Error('leave P unpublished');
        });
        await assert.rejects(() => fixture.activate(), /leave P unpublished/);
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'W:deadline-at-P-after-P-and-finalise-settles-without-head-write') {
        for (const [index, deadlineEdge] of [
          'before-claim-deadline',
          'before-baseline-deadline',
          'before-finalise-deadline',
        ].entries()) {
          const attempt = index === 0 ? fixture : await PhaseDCutoverFixture.create('whatsapp');
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
      if (name === 'W:disabled-replacement-no-owed-admission') {
        await fixture.activate();
        await fixture.replaceWhileDisabled();
        fixture.oracle({ raw: 0, admissions: 0, providerCalls: 0 });
        return;
      }
      if (name === 'W:tighten-preserves-raw-admission-boundary') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.tighten();
        await fixture.schedulerTurn();
        fixture.oracle({ raw: 1, admissions: 0 });
        return;
      }
      if (name === 'W:disable-or-remove-cancels-and-purges-hidden-tuples') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        await fixture.revokeByTarget();
        const calls = fixture.calls.length;
        await fixture.schedulerTurn();
        assert.equal(fixture.calls.length, calls, 'a removed target leaves no source work to call the provider');
        fixture.oracle({ raw: 1, admissions: 0 });
        return;
      }
      if (name === 'W:claim-recovery-keeps-authoritative-head') {
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
      if (name === 'W:remove-readd-stays-dark-and-rechecks-list') {
        await fixture.activate();
        await fixture.enable();
        await fixture.schedulerTurn();
        fixture.removeAccount();
        await fixture.schedulerTurn();
        fixture.readdAccount();
        const calls = fixture.calls.length;
        await fixture.schedulerTurn();
        assert.equal(fixture.calls.length, calls, 're-add has no resurrected source point');
        fixture.oracle({ raw: 0, admissions: 0 });
        return;
      }
      await fixture.activate();
      await fixture.enable();
      await fixture.schedulerTurn();
      await fixture.restart();
      await fixture.sourceTurn();
      fixture.oracle({ raw: 1, admissions: 1, versions: [1] });
      assert.ok((await fixture.journal()).includes('whatsapp.snapshot'));
      const row = fixture.store.database.prepare('SELECT message_id FROM whatsapp_occurrences').get() as
        | { message_id: string }
        | undefined;
      assert.equal(row?.message_id, IDS.whatsappRawKey);
    } finally {
      await fixture.dispose();
    }
  });
}

test('W: every snapshot durable edge reopens the authoritative head and fake journal', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const edge of DURABLE_CUTOVER_EDGES) {
    const fixture = await PhaseDCutoverFixture.create('whatsapp');
    try {
      await fixture.activate();
      await fixture.enable();
      await fixture.setFailpoint((at) => {
        if (at === edge) throw new Error(`cut-over crash:${edge}`);
      });
      await assert.rejects(() => fixture.sourceTurn(), new RegExp(`cut-over crash:${edge}`));
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

test('W: replacement has distinct old-only, new-only and shared chats', { skip: WINDOWS_SKIP }, async () => {
  const fixture = await PhaseDCutoverFixture.create('whatsapp');
  try {
    await fixture.beginScopedReplacement();
    fixture.assertScopedReplacement();
  } finally {
    await fixture.dispose();
  }
});
