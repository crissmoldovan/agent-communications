import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { type CurrentEventVisibility, Visibility } from '@agentcomms/whatsapp';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { ChatListStore } from '../../whatsapp/src/lists.ts';
import { createB2RetainedContentParticipants } from '../src/runtime/phase-d-b2-retention.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import type { SseFrameVisibilityGate } from '../src/runtime/phase-d-whatsapp-seam.ts';
import { StreamReplay } from '../src/runtime/stream-replay.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const ACCOUNT = 'acc_0123456789ABCDEF';
const RULE = 'rule-sse-fence';
const TARGET = 'target-sse-fence';
const SUBSCRIBER = 'subscriber-sse-fence';
const MESSAGE = '["wa-msg","15555550101@s.whatsapp.net","15555550102@s.whatsapp.net","message-1"]';

interface Fixture {
  readonly stateDir: string;
  readonly configDir: string;
  readonly store: EventDatabase;
  readonly lists: ChatListStore;
  readonly replay: StreamReplay;
  readonly visibilityControl: { hideOnNextFence: boolean };
}

function seed(store: EventDatabase, suffix: string): void {
  store.database.exec(`
    UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1 WHERE singleton = 1;
    INSERT OR IGNORE INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
      VALUES ('${ACCOUNT}', 1, '${'a'.repeat(64)}', 1);
    INSERT OR IGNORE INTO whatsapp_occurrences
      (account_id, message_id, first_seen_generation, first_seen_at, visibility_version)
      VALUES ('${ACCOUNT}', '${MESSAGE}', 1, 1, 1);
    INSERT OR IGNORE INTO rule_versions
      (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('${RULE}@1', '${RULE}', 1, '{"source":{"channel":"whatsapp"}}', 'digest', 'active', 'approval', 'activation', 1);
    INSERT OR IGNORE INTO target_versions (id, target_id, version, document, digest)
      VALUES ('${TARGET}@1', '${TARGET}', 1, '{}', 'digest');
    INSERT OR IGNORE INTO subscriber_versions (id, subscriber_id, version, document, digest)
      VALUES ('${SUBSCRIBER}@1', '${SUBSCRIBER}', 1, '{}', 'digest');
    INSERT INTO ingest
      (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
      VALUES ('event-${suffix}', '${store.installationId}', 'whatsapp.message.received', 1, '${ACCOUNT}', 'dedupe-${suffix}', 1, 1, 1);
    INSERT INTO decisions
      (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
      VALUES ('decision-${suffix}', 'event-${suffix}', '${ACCOUNT}', '${RULE}', 1, 'matched', 9999999999999, 'retained');
    INSERT INTO deliveries
      (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
       target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state, switch_generation,
       dead_lettered_at, dead_letter_expires_at, whatsapp_message_id, whatsapp_visibility_version)
      VALUES ('delivery-${suffix}', 'decision-${suffix}', '${ACCOUNT}', '${RULE}', 1,
              'sse:${TARGET}:1:${SUBSCRIBER}:1', '${TARGET}', 1, 'sse', 'plain', '${SUBSCRIBER}', 1,
              X'01', 9999999999999, 'dead-lettered', 1, 1, 9999999999999, '${MESSAGE}', 1);
    INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, event_id,
       account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at, expires_at, switch_generation)
      VALUES ('stream-${suffix}', 'delivery-${suffix}', '${RULE}', 1, '${TARGET}', 1, '${SUBSCRIBER}', 1,
              'event-${suffix}', '${ACCOUNT}', '${MESSAGE}', 1, X'7b7d', 1, 600000, 1);
  `);
}

async function currentVisibility<T>(
  lists: ChatListStore,
  input: { accountId: string },
  work: (visibility: CurrentEventVisibility) => T | Promise<T>,
): Promise<T> {
  return lists.withCurrent(input.accountId, async (current) => {
    const visibility = new Visibility(current.lists);
    return work({
      version: current.version,
      digest: current.digest,
      seesMessage: (chatJid, chatKind, senderJidRaw, fromMe) =>
        visibility.seesMessage(chatJid, chatKind, senderJidRaw, fromMe),
    });
  });
}

function replayFor(store: EventDatabase, visibilityGate: SseFrameVisibilityGate): StreamReplay {
  return new StreamReplay({
    store,
    cipher: { decrypt: async (_location, encrypted) => Buffer.from(encrypted as Uint8Array) },
    approvals: { get: async () => null },
    config: {
      load: async () => ({ inboxes: {}, accounts: { whatsapp: { id: ACCOUNT, platform: 'whatsapp' } } }),
    } as never,
    fence: async () => undefined,
    visibilityGate,
    hasConcreteWhatsAppVisibilityFence: true,
    now: () => 2,
  });
}

async function createFixture(): Promise<Fixture> {
  const stateDir = await shortTempDir('events-post-d-sse-fence-');
  const configDir = join(stateDir, 'config');
  await mkdir(configDir, { recursive: true });
  const store = await openEventDatabase({ stateDir });
  const lists = new ChatListStore(configDir);
  const fixture: Omit<Fixture, 'replay'> = {
    stateDir,
    configDir,
    store,
    lists,
    visibilityControl: { hideOnNextFence: false },
  };
  const composition = createPhaseDWhatsAppOwnerComposition({
    database: store,
    eventOperations: {
      withCurrentEventVisibility: async (input, work) => {
        // The source/account/retained-row/decrypt checks have happened before this final list boundary. The callback
        // then executes synchronously under the actual list lock, so no await can appear between its decision/write.
        if (fixture.visibilityControl.hideOnNextFence) {
          fixture.visibilityControl.hideOnNextFence = false;
          await lists.update(input.accountId, (current) => ({ ...current, deny: ['15555550101@s.whatsapp.net'] }));
        }
        return currentVisibility(lists, input, work);
      },
    },
    createRetainedContentParticipants: createB2RetainedContentParticipants,
  });
  return { ...fixture, replay: replayFor(store, composition.visibilityFence) };
}

function rows(store: EventDatabase, suffix: string): { stream: unknown; payload: Uint8Array | null } {
  return {
    stream: store.database.prepare('SELECT 1 FROM stream_log WHERE id = ?').get(`stream-${suffix}`),
    payload: (
      store.database.prepare('SELECT encrypted_record FROM deliveries WHERE id = ?').get(`delivery-${suffix}`) as {
        encrypted_record: Uint8Array | null;
      }
    ).encrypted_record,
  };
}

test('B2-T9: live and Last-Event-ID writers use D’s concrete list fence, which atomically purges hidden stream and dead-letter bytes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fixture = await createFixture();
  try {
    seed(fixture.store, 'visible');
    const liveFrames: string[] = [];
    assert.equal(
      await fixture.replay.writeLive({
        streamLogId: 'stream-visible',
        frame: 'data: live\n\n',
        isStreamCurrent: () => true,
        writeFrame: (frame) => liveFrames.push(frame),
      }),
      true,
    );
    assert.deepEqual(liveFrames, ['data: live\n\n']);

    seed(fixture.store, 'replay');
    fixture.visibilityControl.hideOnNextFence = true;
    const replayFrames: string[] = [];
    assert.equal(
      await fixture.replay.replay({
        subscriberId: SUBSCRIBER,
        subscriberVersion: 1,
        afterId: null,
        writeFrame: (frame) => replayFrames.push(frame),
      }),
      0,
    );
    assert.deepEqual(replayFrames, []);
    for (const suffix of ['visible', 'replay'])
      assert.deepEqual(
        rows(fixture.store, suffix),
        { stream: undefined, payload: null },
        `${suffix} was purged atomically`,
      );
    assert.ok(
      fixture.store.database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'stream_log_account_whatsapp_message'")
        .get(),
      'the visibility purge index remains after v11 rebuild',
    );
  } finally {
    fixture.store.close();
    await rm(fixture.stateDir, { recursive: true, force: true });
  }
});

test('B2-T9: an interrupted list transaction rolls back B2 cleanup, then the same on-disk list converges after restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  let fixture = await createFixture();
  try {
    seed(fixture.store, 'restart');
    fixture.visibilityControl.hideOnNextFence = true;
    fixture.store.database.exec(`
      CREATE TRIGGER abort_b2_stream_purge BEFORE DELETE ON stream_log
      BEGIN SELECT RAISE(ABORT, 'injected stream purge interruption'); END;
    `);
    await assert.rejects(
      () =>
        fixture.replay.writeLive({
          streamLogId: 'stream-restart',
          frame: 'data: blocked\n\n',
          isStreamCurrent: () => true,
          writeFrame: () => assert.fail('a failed list transaction must never write a frame'),
        }),
      /injected stream purge interruption/u,
    );
    const interrupted = rows(fixture.store, 'restart');
    assert.ok(interrupted.stream, 'the stream row rolls back with the failed list transaction');
    assert.deepEqual(Buffer.from(interrupted.payload ?? []), Buffer.from([1]));
    assert.equal(
      (
        fixture.store.database.prepare('SELECT version FROM whatsapp_visibility WHERE account_id = ?').get(ACCOUNT) as {
          version: number;
        }
      ).version,
      1,
    );

    fixture.store.database.exec('DROP TRIGGER abort_b2_stream_purge');
    fixture.store.close();
    const restartedStore = await openEventDatabase({ stateDir: fixture.stateDir });
    fixture = { ...fixture, store: restartedStore };
    const composition = createPhaseDWhatsAppOwnerComposition({
      database: restartedStore,
      eventOperations: {
        withCurrentEventVisibility: (input, work) => currentVisibility(fixture.lists, input, work),
      },
      createRetainedContentParticipants: createB2RetainedContentParticipants,
    });
    fixture = { ...fixture, replay: replayFor(restartedStore, composition.visibilityFence) };
    const frames: string[] = [];
    assert.equal(
      await fixture.replay.writeLive({
        streamLogId: 'stream-restart',
        frame: 'data: hidden\n\n',
        isStreamCurrent: () => true,
        writeFrame: (frame) => frames.push(frame),
      }),
      false,
    );
    assert.deepEqual(frames, []);
    assert.deepEqual(rows(fixture.store, 'restart'), { stream: undefined, payload: null });
  } finally {
    fixture.store.close();
    await rm(fixture.stateDir, { recursive: true, force: true });
  }
});
