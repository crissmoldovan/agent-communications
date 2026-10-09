import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import {
  type DSourceRetentionHooks,
  type DSourceRetentionParticipant,
  NoopDSourceRetentionHooks,
  PassThroughSseFrameVisibilityGate,
  type SseFrameVisibilityGate,
  type WhatsAppListChangeParticipant,
} from '../src/runtime/phase-d-whatsapp-seam.ts';
import { SseDispatcher, writeLiveSseFrame } from '../src/runtime/sse-dispatcher.ts';
import { StreamReplay, writeReplaySseFrame } from '../src/runtime/stream-replay.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

function recordingGate(trace: string[]): SseFrameVisibilityGate {
  return {
    async withCurrentSseFrameVisibility(input, writeFrame) {
      trace.push(`gate:${input.accountId}:${input.whatsappMessageId}`);
      const value = writeFrame();
      trace.push('gate-return');
      return value;
    },
  };
}

test('B2-T8: the pre-D seam has the Phase-D structural participant signatures without importing Phase D', () => {
  const listParticipant: WhatsAppListChangeParticipant = {
    purgeNewlyHiddenInTransaction(_transaction, input) {
      assert.deepEqual(input, {
        accountId: 'account-1',
        newlyHiddenMessageIds: ['message-1'],
        visibilityVersion: 2,
        changedAt: '2026-10-09T00:00:00.000Z',
      });
    },
  };
  const retentionParticipant: DSourceRetentionParticipant = {
    shortenOrPurgeInTransaction(_transaction, input) {
      assert.deepEqual(input.changes, [{ retention: 'sse-replay', durationMs: 1 }]);
    },
  };
  const hooks: DSourceRetentionHooks = new NoopDSourceRetentionHooks();
  hooks.registerWhatsAppListChangeParticipant(listParticipant);
  hooks.registerRetentionTighteningParticipant(retentionParticipant);
});

test('B2-T8: the async pass-through gate invokes its frame writer synchronously exactly once', async () => {
  const trace: string[] = [];
  const gate = new PassThroughSseFrameVisibilityGate();
  const returned = gate.withCurrentSseFrameVisibility(
    { accountId: 'account-1', whatsappMessageId: 'message-1' },
    () => {
      trace.push('write');
      return 'written';
    },
  );
  assert.deepEqual(trace, ['write']);
  assert.equal(await returned, 'written');
  assert.deepEqual(trace, ['write']);
});

test('B2-T9: each actual dispatcher/live and Last-Event-ID replay writer nests a WhatsApp sink write in the injected visibility gate', async () => {
  for (const kind of ['live', 'replay'] as const) {
    const trace: string[] = [];
    const input = {
      frame: 'id: stream-1\ndata: {}\n\n',
      accountId: 'account-1',
      whatsappMessageId: 'message-1',
      visibilityGate: recordingGate(trace),
      hasConcreteWhatsAppVisibilityFence: true,
      writeFrame: (frame: string) => trace.push(`write:${frame}`),
    };
    const accepted = await (kind === 'live'
      ? new SseDispatcher({
          store: {} as never,
          cipher: {} as never,
          approvals: {} as never,
          config: {} as never,
          visibilityGate: input.visibilityGate,
          hasConcreteWhatsAppVisibilityFence: true,
        }).writeLive(input)
      : writeReplaySseFrame(input));
    assert.equal(accepted, true);
    assert.deepEqual(trace, ['gate:account-1:message-1', 'write:id: stream-1\ndata: {}\n\n', 'gate-return']);
  }
});

test('B2-T8: a persisted WhatsApp tuple fails closed when the owner lacks the D concrete seam', async () => {
  const trace: string[] = [];
  const accepted = await writeLiveSseFrame({
    frame: 'id: stream-1\ndata: {}\n\n',
    accountId: 'account-1',
    whatsappMessageId: 'message-1',
    visibilityGate: new PassThroughSseFrameVisibilityGate(),
    hasConcreteWhatsAppVisibilityFence: false,
    writeFrame: () => trace.push('write'),
  });
  assert.equal(accepted, false);
  assert.deepEqual(trace, []);
});

test('B2-T8: non-WhatsApp frames use the ordinary writer path without entering the visibility gate', async () => {
  const trace: string[] = [];
  const accepted = await writeReplaySseFrame({
    frame: 'id: stream-1\ndata: {}\n\n',
    accountId: 'account-1',
    whatsappMessageId: null,
    visibilityGate: recordingGate(trace),
    hasConcreteWhatsAppVisibilityFence: false,
    writeFrame: () => trace.push('write'),
  });
  assert.equal(accepted, true);
  assert.deepEqual(trace, ['write']);
});

async function liveFrameFixture() {
  const stateDir = await shortTempDir('events-sse-live-frame-');
  const store = await openEventDatabase({ stateDir });
  const accountId = 'account-live-frame';
  store.database.exec(
    `UPDATE event_settings SET enabled = 1, switch_generation = 1;
     INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES ('rule-live-frame@1', 'rule-live-frame', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
     INSERT INTO target_versions (id, target_id, version, document, digest)
     VALUES ('target-live-frame@1', 'target-live-frame', 1, '{}', 'digest');
     INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest)
     VALUES ('subscriber-live-frame@1', 'subscriber-live-frame', 1, '{}', 'digest');
     INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-live-frame', '${store.installationId}', 'example.event', 1, '${accountId}', 'live-frame', 1, 1, 1);
     INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-live-frame', 'event-live-frame', '${accountId}', 'rule-live-frame', 1, 'matched', 9999999999999, 'retained');
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state, switch_generation)
     VALUES ('delivery-live-frame', 'decision-live-frame', '${accountId}', 'rule-live-frame', 1,
             'sse:target-live-frame:1:subscriber-live-frame:1', 'target-live-frame', 1, 'sse', 'plain',
             'subscriber-live-frame', 1, X'00', 9999999999999, 'delivered', 1);
     INSERT INTO stream_log
       (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, event_id,
        account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at, expires_at, switch_generation)
     VALUES ('stream-live-frame', 'delivery-live-frame', 'rule-live-frame', 1, 'target-live-frame', 1,
             'subscriber-live-frame', 1, 'event-live-frame', '${accountId}', NULL, NULL, X'00', 1, 600000, 1);`,
  );
  let accountLive = true;
  const replay = new StreamReplay({
    store,
    cipher: { decrypt: async () => Buffer.alloc(0) },
    approvals: { get: async () => null },
    config: {
      load: async () => (accountLive ? { inboxes: { inbox: { id: accountId, provider: 'gmail' } } } : { inboxes: {} }),
    } as never,
    fence: async () => undefined,
    now: () => 2,
  });
  return { stateDir, store, replay, removeAccount: () => (accountLive = false) };
}

test('B2-T9: a live SSE frame refuses a lost retained row, lineage, or account immediately before writing', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const lost of ['expired', 'purged', 'rule', 'target', 'account'] as const) {
    const setup = await liveFrameFixture();
    try {
      if (lost === 'expired')
        setup.store.database.exec("UPDATE stream_log SET expires_at = 2 WHERE id = 'stream-live-frame'");
      if (lost === 'purged') setup.store.database.exec("DELETE FROM stream_log WHERE id = 'stream-live-frame'");
      if (lost === 'rule')
        setup.store.database.exec("UPDATE rule_versions SET revoked_at = 2 WHERE id = 'rule-live-frame@1'");
      if (lost === 'target')
        setup.store.database.exec("UPDATE target_versions SET revoked_at = 2 WHERE id = 'target-live-frame@1'");
      if (lost === 'account') setup.removeAccount();
      const frames: string[] = [];
      assert.equal(
        await setup.replay.writeLive({
          streamLogId: 'stream-live-frame',
          frame: 'data: blocked\n\n',
          isStreamCurrent: () => true,
          writeFrame: (frame) => frames.push(frame),
        }),
        false,
        `${lost} authority refuses the physical writer`,
      );
      assert.deepEqual(frames, []);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }
});
