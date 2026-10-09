import assert from 'node:assert/strict';
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
import { writeReplaySseFrame } from '../src/runtime/stream-replay.ts';

function recordingGate(trace: string[]): SseFrameVisibilityGate {
  return {
    withCurrentSseFrameVisibility(input, writeFrame) {
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

test('B2-T8: the synchronous pass-through gate invokes a frame writer exactly once', () => {
  const trace: string[] = [];
  const gate = new PassThroughSseFrameVisibilityGate();
  const returned = gate.withCurrentSseFrameVisibility(
    { accountId: 'account-1', whatsappMessageId: 'message-1' },
    () => {
      trace.push('write');
      return 'written';
    },
  );
  assert.equal(returned, 'written');
  assert.deepEqual(trace, ['write']);
});

test('B2-T9: each actual dispatcher/live and Last-Event-ID replay writer nests a WhatsApp sink write in the injected visibility gate', () => {
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
    const accepted =
      kind === 'live'
        ? new SseDispatcher({
            store: {} as never,
            cipher: {} as never,
            approvals: {} as never,
            config: {} as never,
            visibilityGate: input.visibilityGate,
            hasConcreteWhatsAppVisibilityFence: true,
          }).writeLive(input)
        : writeReplaySseFrame(input);
    assert.equal(accepted, true);
    assert.deepEqual(trace, ['gate:account-1:message-1', 'write:id: stream-1\ndata: {}\n\n', 'gate-return']);
  }
});

test('B2-T8: a persisted WhatsApp tuple fails closed when the owner lacks the D concrete seam', () => {
  const trace: string[] = [];
  const accepted = writeLiveSseFrame({
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

test('B2-T8: non-WhatsApp frames use the ordinary writer path without entering the visibility gate', () => {
  const trace: string[] = [];
  const accepted = writeReplaySseFrame({
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
