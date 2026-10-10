import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWhatsAppCutoverMutationContract } from './support/cutover-mutants.ts';
import { PhaseDCutoverFixture } from './support/phase-d-cutover.ts';
import {
  assertWhatsAppDurableEdgeCoverage,
  assertWhatsAppMultiset,
  forEachWhatsAppDurableEdge,
  headGeneration,
  whatsappMessage,
  whatsappRawKey,
} from './support/phase-d-cutover-whatsapp.ts';
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

type WhatsAppCell = (typeof cells)[number];

function options(chats: readonly string[]) {
  return { channel: 'whatsapp' as const, chats };
}

function scope(fixture: PhaseDCutoverFixture, chat: string) {
  return { source: 'whatsapp' as const, accountId: fixture.accountId, scopeId: `chat:${chat}` };
}

async function beginReplacement(fixture: PhaseDCutoverFixture, next: readonly string[]): Promise<void> {
  let waiting = false;
  try {
    await fixture.activate(2, options(next), 'changed');
  } catch (error: unknown) {
    waiting = (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING';
    if (!waiting) throw error;
  }
  assert.equal(waiting, true, 'the real exact replacement keeps the old pointer until its P drain completes');
}

async function finishReplacement(
  fixture: PhaseDCutoverFixture,
  chat: string,
  attempt: Readonly<{ edge: string | undefined }>,
): Promise<void> {
  await fixture.sourceTurn(scope(fixture, chat));
  await resumeClaimedCompletion(fixture, attempt);
}

/** The completion pointer has its own durable edges after the source drain reaches P. */
async function resumeClaimedCompletion(
  fixture: PhaseDCutoverFixture,
  attempt: Readonly<{ edge: string | undefined }>,
): Promise<void> {
  if (attempt.edge === undefined || !['before-move', 'after-move', 'before-finalise'].includes(attempt.edge)) {
    await fixture.runtime.resumeClaimedCompletions();
    return;
  }
  const edge = attempt.edge;
  let fired = false;
  await fixture.setFailpoint((at) => {
    if (at !== edge) return;
    fired = true;
    throw new Error(`activation pointer crash at ${edge}`);
  });
  await assert.rejects(
    () => fixture.runtime.resumeClaimedCompletions(),
    new RegExp(`activation pointer crash at ${edge}`),
  );
  assert.equal(fired, true, `replacement completion reaches its ${edge} pointer edge`);
  const journal = await fixture.journal();
  await fixture.restart();
  await fixture.runtime.resumeClaimedCompletions();
  assert.ok((await fixture.journal()).length >= journal.length, `restart at ${edge} keeps the fake provider journal`);
}

async function settle(fixture: PhaseDCutoverFixture): Promise<void> {
  // The first scheduler tick creates dispatch work after source evaluation; the second is the real dry-run dispatch.
  // Both repeated checked copies must add no raw tuple.
  await fixture.schedulerTurn();
  await fixture.schedulerTurn();
}

/** Models a process death after D-5 persisted candidate keys and before it switched the authoritative head. */
function writeCandidateWithoutHead(fixture: PhaseDCutoverFixture, message: ReturnType<typeof whatsappMessage>): number {
  const prior = headGeneration(fixture);
  assert.notEqual(prior, undefined, 'the stranded candidate has an authoritative predecessor head');
  const visibility = fixture.store.database
    .prepare('SELECT version FROM whatsapp_visibility WHERE account_id = ?')
    .get(fixture.accountId) as { version: number } | undefined;
  assert.notEqual(visibility, undefined, 'the candidate belongs to the persisted visibility journal');
  if (visibility === undefined) throw new Error('the candidate has no persisted visibility journal');
  const generation = (prior ?? 0) + 1;
  fixture.store.database
    .prepare(
      `INSERT INTO whatsapp_snapshot_keys
        (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
       VALUES ($accountId, $generation, $visibilityVersion, $chatJid, $senderJidRaw, $stanzaId)`,
    )
    .run({
      $accountId: fixture.accountId,
      $generation: generation,
      $visibilityVersion: visibility.version,
      $chatJid: message.chatJid,
      $senderJidRaw: message.senderJidRaw,
      $stanzaId: message.stanzaId,
    });
  return generation;
}

function latestFailedIntent(fixture: PhaseDCutoverFixture): { id: string; status: string; failure_code: string } {
  const row = fixture.store.database
    .prepare(
      `SELECT id, status, failure_code FROM activation_intents
        WHERE status = 'failed' AND failure_code = 'COMPLETION_TIMEOUT'
        ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .get() as { id: string; status: string; failure_code: string } | undefined;
  assert.notEqual(row, undefined, 'the completion failure is durable');
  return row as { id: string; status: string; failure_code: string };
}

function assertFailedIntentPublishedNoPoints(fixture: PhaseDCutoverFixture): void {
  const intent = latestFailedIntent(fixture);
  assert.deepEqual(
    { status: intent.status, failure_code: intent.failure_code },
    { status: 'failed', failure_code: 'COMPLETION_TIMEOUT' },
    'the intent settles terminally with the stable timeout code',
  );
  const points = fixture.store.database
    .prepare('SELECT COUNT(*) AS count FROM rule_activation_points WHERE activation_id = ?')
    .get(intent.id) as { count: number };
  assert.equal(points.count, 0, 'a timed-out intent publishes no rule activation point');
}

const scenarios: Record<WhatsAppCell, () => Promise<void>> = {
  async 'W:first-enabled-stages-before-copy-dispose'() {
    const after = whatsappMessage('after-first-point');
    await forEachWhatsAppDurableEdge('W:first-enabled-stages-before-copy-dispose', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate();
      await fixture.enable();
      fixture.setWhatsAppMessages([after]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [after],
        admissions: [{ message: after, version: 1 }],
        decisions: [{ message: after, version: 1 }],
      });
    });
  },

  async 'W:first-disabled-head-without-owed-stage'() {
    const before = whatsappMessage('before-disabled-point');
    const after = whatsappMessage('after-enable-point');
    await forEachWhatsAppDurableEdge('W:first-disabled-head-without-owed-stage', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([before]);
      await fixture.activate();
      assert.equal(headGeneration(fixture), 1, 'disabled first activation atomically persists its authoritative head');
      fixture.oracle({ raw: 0, admissions: 0 });
      await fixture.enable();
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [after],
        admissions: [{ message: after, version: 1 }],
        decisions: [{ message: after, version: 1 }],
      });
    });
  },

  async 'W:replace-old-only-admits-by-old-generation'() {
    const old = whatsappMessage('old-only-P', 'chat-old');
    await forEachWhatsAppDurableEdge('W:replace-old-only-admits-by-old-generation', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate(1, options(['chat-old']));
      await fixture.enable();
      fixture.setWhatsAppMessages([old]);
      await fixture.setFailpoint((edge) => {
        if (edge === 'after-move') throw new Error('old tuple staged before replacement');
      });
      await assert.rejects(() => fixture.sourceTurn(scope(fixture, 'chat-old')), /old tuple staged before replacement/);
      await fixture.setFailpoint(undefined);
      await beginReplacement(fixture, ['chat-new']);
      await attempt.sourceAtDurableEdge('chat-old');
      await resumeClaimedCompletion(fixture, attempt);
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [old],
        admissions: [{ message: old, version: 1 }],
        decisions: [{ message: old, version: 1 }],
      });
    });
  },

  async 'W:replace-new-only-baselines-raw-generation'() {
    const before = whatsappMessage('new-only-before-P', 'chat-new');
    const after = whatsappMessage('new-only-after-P', 'chat-new');
    await forEachWhatsAppDurableEdge('W:replace-new-only-baselines-raw-generation', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate(1, options(['chat-old']));
      await fixture.enable();
      fixture.setWhatsAppMessages([before]);
      await beginReplacement(fixture, ['chat-new']);
      await finishReplacement(fixture, 'chat-old', attempt);
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge('chat-new');
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [after],
        admissions: [{ message: after, version: 2 }],
        decisions: [{ message: after, version: 2 }],
      });
    });
  },

  async 'W:replace-shared-raw-key-one-version'() {
    const before = whatsappMessage('shared-before-P', 'chat-shared');
    const after = whatsappMessage('shared-after-P', 'chat-shared');
    await forEachWhatsAppDurableEdge('W:replace-shared-raw-key-one-version', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate(1, options(['chat-shared']));
      await fixture.enable();
      fixture.setWhatsAppMessages([before]);
      await fixture.sourceTurn(scope(fixture, 'chat-shared'));
      await beginReplacement(fixture, ['chat-shared']);
      await finishReplacement(fixture, 'chat-shared', attempt);
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge('chat-shared');
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [before, after],
        admissions: [
          { message: before, version: 1 },
          { message: after, version: 2 },
        ],
        decisions: [
          { message: before, version: 1 },
          { message: after, version: 2 },
        ],
      });
    });
  },

  async 'W:disabled-replacement-no-owed-admission'() {
    const before = whatsappMessage('disabled-replacement', 'chat-replaced');
    await forEachWhatsAppDurableEdge('W:disabled-replacement-no-owed-admission', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([before]);
      await fixture.activate(1, options(['chat-old']));
      await fixture.replaceWhileDisabled();
      await attempt.sourceAtDurableEdge('chat-replaced');
      fixture.oracle({ raw: 0, admissions: 0 });
      assert.equal(headGeneration(fixture) !== undefined, true, 'disabled replacement advances an authoritative head');
    });
  },

  async 'W:enable-all-rebaselines-authoritative-head'() {
    const duringDisabled = whatsappMessage('while-disabled');
    const afterEnable = whatsappMessage('after-enable');
    await forEachWhatsAppDurableEdge('W:enable-all-rebaselines-authoritative-head', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([duringDisabled]);
      await fixture.activate();
      const firstHead = headGeneration(fixture);
      fixture.setWhatsAppMessages([duringDisabled]);
      await fixture.enable();
      assert.equal(
        headGeneration(fixture),
        (firstHead ?? 0) + 1,
        'enable-all re-baselines the authoritative head after its disabled interval',
      );
      assert.equal(firstHead, 1, 'the original disabled head existed before enable-all');
      fixture.setWhatsAppMessages([duringDisabled, afterEnable]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [afterEnable],
        admissions: [{ message: afterEnable, version: 1 }],
        decisions: [{ message: afterEnable, version: 1 }],
      });
    });
  },

  async 'W:tighten-preserves-raw-admission-boundary'() {
    const before = whatsappMessage('before-tighten');
    const after = whatsappMessage('after-tighten');
    await forEachWhatsAppDurableEdge('W:tighten-preserves-raw-admission-boundary', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate();
      await fixture.enable();
      fixture.setWhatsAppMessages([before]);
      await fixture.sourceTurn();
      await fixture.tighten();
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [before, after],
        admissions: [{ message: after, version: 2 }],
        decisions: [
          { message: before, version: 1 },
          { message: after, version: 2 },
        ],
      });
    });
  },

  async 'W:disable-or-remove-cancels-and-purges-hidden-tuples'() {
    const before = whatsappMessage('before-target-removal');
    const after = whatsappMessage('after-target-removal');
    await forEachWhatsAppDurableEdge(
      'W:disable-or-remove-cancels-and-purges-hidden-tuples',
      async (fixture, attempt) => {
        fixture.setWhatsAppMessages([]);
        await fixture.activate();
        await fixture.enable();
        fixture.setWhatsAppMessages([before]);
        await fixture.sourceTurn();
        await fixture.revokeByTarget();
        const calls = fixture.calls.length;
        fixture.setWhatsAppMessages([before, after]);
        await attempt.sourceAtDurableEdge();
        assert.equal(
          fixture.calls.length,
          calls + (attempt.edge === undefined ? 1 : 2),
          'only the explicit fenced probe reads',
        );
        fixture.oracle({ raw: 1, admissions: 0 });
      },
    );
  },

  async 'W:remove-readd-stays-dark-and-rechecks-list'() {
    const before = whatsappMessage('before-removal');
    const after = whatsappMessage('after-readd');
    await forEachWhatsAppDurableEdge('W:remove-readd-stays-dark-and-rechecks-list', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate();
      await fixture.enable();
      fixture.setWhatsAppMessages([before]);
      await fixture.sourceTurn();
      fixture.removeAccount();
      await fixture.schedulerTurn();
      fixture.readdAccount();
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge();
      fixture.oracle({ raw: 0, admissions: 0 });
    });
  },

  async 'W:claim-recovery-keeps-authoritative-head'() {
    const before = whatsappMessage('recovery-before-P');
    const after = whatsappMessage('recovery-after-P');
    await forEachWhatsAppDurableEdge('W:claim-recovery-keeps-authoritative-head', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([before]);
      await fixture.setFailpoint((edge) => {
        if (edge === 'after-stage') throw new Error('restart after durable baseline');
      });
      await assert.rejects(() => fixture.activate(), /restart after durable baseline/);
      await fixture.restart();
      await fixture.recover();
      await fixture.enable();
      fixture.setWhatsAppMessages([before, after]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [after],
        admissions: [{ message: after, version: 1 }],
        decisions: [{ message: after, version: 1 }],
      });
    });
  },

  async 'W:timeout-discards-candidate-not-head'() {
    const stranded = whatsappMessage('deadline-candidate');
    const afterRecovery = whatsappMessage('deadline-candidate-after-recovery');
    await forEachWhatsAppDurableEdge('W:timeout-discards-candidate-not-head', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate();
      await fixture.enable();
      const priorHead = headGeneration(fixture);
      const candidateGeneration = writeCandidateWithoutHead(fixture, stranded);
      assert.equal(headGeneration(fixture), priorHead, 'candidate persistence alone never changes the head');
      await fixture.setDeadlineFailpoint((edge) => {
        if (edge === 'before-claim-deadline') fixture.now.value += 3_600_001;
      });
      await assert.rejects(() => fixture.activate(2, options(['chat-cutover']), 'changed'));
      assert.equal(fixture.failedCompletions(), 1, 'the expired completion is terminal before source work resumes');
      assertFailedIntentPublishedNoPoints(fixture);
      assert.equal(headGeneration(fixture), priorHead, 'the deadline never rolls back an existing source head');
      assert.ok(
        fixture.store.database
          .prepare('SELECT 1 FROM whatsapp_snapshot_keys WHERE account_id = ? AND generation = ?')
          .get(fixture.accountId, candidateGeneration),
        'the unheaded candidate survives only until the source recovery pass',
      );
      await fixture.setDeadlineFailpoint(undefined);

      // The next real worker pass is the recovery boundary: make its commit fail after prepareCandidate() so the
      // assertion observes cleanup independently from any new authoritative snapshot generation.
      fixture.setWhatsAppMessages([]);
      await fixture.setFailpoint((edge) => {
        if (edge === 'before-move') throw new Error('stop after candidate recovery');
      });
      await assert.rejects(() => fixture.sourceTurn(), /stop after candidate recovery/);
      await fixture.setFailpoint(undefined);
      assert.equal(headGeneration(fixture), priorHead, 'discarding an unheaded candidate preserves the prior head');
      assert.equal(
        fixture.store.database
          .prepare('SELECT 1 FROM whatsapp_snapshot_keys WHERE account_id = ? AND generation = ?')
          .get(fixture.accountId, candidateGeneration),
        undefined,
        'recovery discards exactly the generation that never became authoritative',
      );

      fixture.setWhatsAppMessages([afterRecovery]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [afterRecovery],
        admissions: [{ message: afterRecovery, version: 1 }],
        decisions: [{ message: afterRecovery, version: 1 }],
      });
    });

    const atP = whatsappMessage('replacement-timeout-at-P');
    await forEachWhatsAppDurableEdge('W:timeout-discards-candidate-not-head:replacement', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate();
      await fixture.enable();
      const headBeforeReplacementP = headGeneration(fixture);
      fixture.setWhatsAppMessages([atP]);
      await fixture.setDeadlineFailpoint((edge) => {
        if (edge === 'before-finalise-deadline') fixture.now.value += 3_600_001;
      });
      await assert.rejects(() => fixture.activate(2, options(['chat-cutover']), 'changed'));
      assertFailedIntentPublishedNoPoints(fixture);
      assert.equal(
        headGeneration(fixture),
        (headBeforeReplacementP ?? 0) + 1,
        'timeout settlement retains the baseline head exactly as the replacement switched it',
      );
      assertWhatsAppMultiset(fixture, {
        raw: [atP],
        admissions: [{ message: atP, version: 1 }],
      });
      await fixture.setDeadlineFailpoint(undefined);
      fixture.setWhatsAppMessages([]);
      await attempt.sourceAtDurableEdge();
      await settle(fixture);
      assertWhatsAppMultiset(fixture, {
        raw: [atP],
        admissions: [{ message: atP, version: 1 }],
        decisions: [{ message: atP, version: 1 }],
      });
    });
  },

  async 'W:initial-baseline-generation-and-identities-atomic'() {
    const beforeA = whatsappMessage('baseline-a');
    const beforeB = whatsappMessage('baseline-b');
    const after = whatsappMessage('after-identity-baseline');
    await forEachWhatsAppDurableEdge(
      'W:initial-baseline-generation-and-identities-atomic',
      async (fixture, attempt) => {
        fixture.setWhatsAppMessages([beforeA, beforeB]);
        await fixture.activate();
        assert.equal(headGeneration(fixture), 1, 'the P generation is committed with its identities');
        const keys = fixture.store.database
          .prepare('SELECT chat_jid, sender_jid_raw, stanza_id FROM whatsapp_snapshot_keys ORDER BY stanza_id')
          .all()
          .map((row) => {
            const key = row as { chat_jid: string; sender_jid_raw: string; stanza_id: string };
            return JSON.stringify(['wa-msg', key.chat_jid, key.sender_jid_raw, key.stanza_id]);
          });
        assert.deepEqual(
          keys,
          [whatsappRawKey(beforeA), whatsappRawKey(beforeB)],
          'baseline identities use canonical raw keys',
        );
        await fixture.enable();
        fixture.setWhatsAppMessages([beforeA, beforeB, after]);
        await attempt.sourceAtDurableEdge();
        await settle(fixture);
        assertWhatsAppMultiset(fixture, {
          raw: [after],
          admissions: [{ message: after, version: 1 }],
          decisions: [{ message: after, version: 1 }],
        });
      },
    );
  },

  async 'W:claimed-P-fences-snapshot-worker'() {
    const unseen = whatsappMessage('must-remain-fenced');
    await forEachWhatsAppDurableEdge('W:claimed-P-fences-snapshot-worker', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([unseen]);
      await fixture.setFailpoint((edge) => {
        if (edge === 'before-finalise') throw new Error('leave P unpublished');
      });
      await assert.rejects(() => fixture.activate(), /leave P unpublished/);
      await fixture.setFailpoint(undefined);
      await attempt.assertSourceEdgeUnreachable();
      fixture.oracle({ raw: 0, admissions: 0 });
    });
  },

  async 'W:initial-cursor-rechecks-generation-under-chat-lock'() {
    const before = whatsappMessage('locked-baseline');
    const after = whatsappMessage('after-locked-generation');
    await forEachWhatsAppDurableEdge(
      'W:initial-cursor-rechecks-generation-under-chat-lock',
      async (fixture, attempt) => {
        fixture.setWhatsAppMessages([before]);
        await fixture.activate();
        await fixture.enable();
        const generation = headGeneration(fixture);
        fixture.setWhatsAppMessages([before, after]);
        await attempt.sourceAtDurableEdge();
        assert.ok(
          (headGeneration(fixture) ?? 0) > (generation ?? 0),
          'the checked-copy commit rechecks and advances generation',
        );
        await settle(fixture);
        assertWhatsAppMultiset(fixture, {
          raw: [after],
          admissions: [{ message: after, version: 1 }],
          decisions: [{ message: after, version: 1 }],
        });
      },
    );
  },

  async 'W:tighten-transfers-first-representation-admissions-stale-snapshot-writes-nothing'() {
    const owed = whatsappMessage('transferred-debt');
    await forEachWhatsAppDurableEdge(
      'W:tighten-transfers-first-representation-admissions-stale-snapshot-writes-nothing',
      async (fixture, attempt) => {
        fixture.setWhatsAppMessages([]);
        await fixture.activate();
        await fixture.enable();
        fixture.setWhatsAppMessages([owed]);
        await fixture.setFailpoint((edge) => {
          if (edge === 'after-move') throw new Error('stop before evaluation');
        });
        await assert.rejects(() => fixture.sourceTurn(), /stop before evaluation/);
        await fixture.setFailpoint(undefined);
        await fixture.tighten();
        await attempt.sourceAtDurableEdge();
        await settle(fixture);
        assertWhatsAppMultiset(fixture, {
          raw: [owed],
          admissions: [{ message: owed, version: 2 }],
          decisions: [{ message: owed, version: 2 }],
        });
      },
    );
  },

  async 'W:swap-drops-old-only-first-representation-debt'() {
    const old = whatsappMessage('old-only-debt', 'chat-old');
    await forEachWhatsAppDurableEdge('W:swap-drops-old-only-first-representation-debt', async (fixture, attempt) => {
      fixture.setWhatsAppMessages([]);
      await fixture.activate(1, options(['chat-old']));
      await fixture.enable();
      fixture.setWhatsAppMessages([old]);
      await fixture.setFailpoint((edge) => {
        if (edge === 'after-move') throw new Error('leave old-only debt staged');
      });
      await assert.rejects(() => fixture.sourceTurn(scope(fixture, 'chat-old')), /leave old-only debt staged/);
      await fixture.setFailpoint(undefined);
      await beginReplacement(fixture, ['chat-new']);
      await attempt.sourceAtDurableEdge('chat-old');
      await resumeClaimedCompletion(fixture, attempt);
      await settle(fixture);
      assert.equal(
        fixture.store.database
          .prepare('SELECT 1 FROM source_stage_rule_debts WHERE rule_id = ? AND rule_version = 1')
          .get('rule-cutover'),
        undefined,
        'the swap leaves no unowed old-only first-representation debt',
      );
      assertWhatsAppMultiset(fixture, {
        raw: [old],
        admissions: [{ message: old, version: 1 }],
        decisions: [{ message: old, version: 1 }],
      });
    });
  },

  async 'W:deadline-at-P-after-P-and-finalise-settles-without-head-write'() {
    for (const deadlineEdge of [
      'before-claim-deadline',
      'before-baseline-deadline',
      'before-finalise-deadline',
    ] as const) {
      await forEachWhatsAppDurableEdge(
        `W:deadline-at-P-after-P-and-finalise-settles-without-head-write:${deadlineEdge}`,
        async (fixture, attempt) => {
          fixture.setWhatsAppMessages([whatsappMessage(`deadline-${deadlineEdge}`)]);
          let headAtDeadline: number | undefined;
          let callsAtDeadline: number | undefined;
          await fixture.setDeadlineFailpoint((edge) => {
            if (edge !== deadlineEdge) return;
            headAtDeadline = headGeneration(fixture);
            callsAtDeadline = fixture.calls.length;
            fixture.now.value += 3_600_001;
          });
          await assert.rejects(() => fixture.activate());
          assert.equal(fixture.failedCompletions(), 1, `${deadlineEdge} settles the claimed completion`);
          assertFailedIntentPublishedNoPoints(fixture);
          if (deadlineEdge === 'before-claim-deadline') {
            assert.equal(callsAtDeadline, 0, 'the pre-claim deadline calls no baseline');
            assert.equal(headAtDeadline, undefined, 'the pre-claim deadline has no source head');
            assert.equal(headGeneration(fixture), undefined, 'the pre-claim deadline writes no source head');
          } else {
            assert.ok((callsAtDeadline ?? 0) > 0, `${deadlineEdge} lands at or after the baseline call`);
            assert.equal(headAtDeadline, 1, `${deadlineEdge} observes the baseline-switched head`);
            assert.equal(
              headGeneration(fixture),
              headAtDeadline,
              `${deadlineEdge} settlement neither rolls back nor advances the switched head`,
            );
          }
          fixture.assertContentFreeSettlement();
          // Keep the shared every-durable-edge runner honest after the settlement oracle has frozen the head.
          await fixture.setDeadlineFailpoint(undefined);
          fixture.setWhatsAppMessages([]);
          await attempt.sourceAtDurableEdge();
          fixture.oracle({ raw: 0, admissions: 0 });
        },
        { cell: 'W:deadline-at-P-after-P-and-finalise-settles-without-head-write' },
      );
    }
  },
};

for (const name of cells) test(name, { skip: WINDOWS_SKIP }, scenarios[name]);

test('W: every matrix cell records its no-crash and durable-edge probe', { skip: WINDOWS_SKIP }, () => {
  assertWhatsAppDurableEdgeCoverage(cells);
});

test('W: every matrix cell owns a mutation run by its exact cut-over test name', { skip: WINDOWS_SKIP }, () => {
  assertWhatsAppCutoverMutationContract(cells);
});

test('W: replacement has distinct old-only, new-only and shared chats', { skip: WINDOWS_SKIP }, async () => {
  const fixture = await PhaseDCutoverFixture.create('whatsapp');
  try {
    fixture.setWhatsAppMessages([]);
    await fixture.beginScopedReplacement();
    fixture.assertScopedReplacement();
  } finally {
    await fixture.dispose();
  }
});
