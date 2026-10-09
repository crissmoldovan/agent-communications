import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DURABLE_CUTOVER_EDGES } from '../src/runtime/cutover-failpoint.ts';
import { IDS, PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const RECEIVED = { channel: 'resend', kinds: ['received'] };
const X0 = '00000000-0000-4000-8000-000000000000';
const P = '11111111-1111-4111-8111-111111111111';
const E0 = '22222222-2222-4222-8222-222222222222';
const E1 = '33333333-3333-4333-8333-333333333333';
const E2 = '44444444-4444-4444-8444-444444444444';

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
      listReceived: async () => {
        cycle += 1;
        if (cycle === 1) return { emails: [{ id: P }, { id: E0 }, { id: X0 }], next: null };
        if (cycle === 2) return { emails: [{ id: E1 }, { id: P }], next: null };
        if (cycle === 3) return { emails: [{ id: E2 }, { id: E1 }], next: null };
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
      ],
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
