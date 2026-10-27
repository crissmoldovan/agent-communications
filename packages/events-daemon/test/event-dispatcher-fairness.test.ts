import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventDispatcher } from '../src/runtime/events/event-dispatcher.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInSecrets } from './support/stand-ins.ts';
import { seedEvent, seedRun } from './support/workflow-event-rows.ts';

/*
 * Security review of 0.36.0, L5: the dispatcher takes the head of each subscriber version's queue, 64 at a time. The
 * heads that are due are chosen before that limit, so 64 subscriber versions that are backing off, being sent, or
 * already started by `pump` never hide a later one whose event is due.
 */

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const RULE = 'client-asks';
const ACCOUNT = 'acme/slack';

function subscriberId(index: number): string {
  return `subscriber-${String(index).padStart(3, '0')}`;
}

async function withDispatcherStore(
  count: number,
  work: (store: EventDatabase, eventId: string) => Promise<void>,
): Promise<void> {
  const root = await shortTempDir('aev-l5-fairness-');
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    await standInSecrets(store.database);
    const runId = seedRun(store.database, { ruleId: RULE, ruleVersion: 1, accountId: ACCOUNT, now: NOW });
    const eventId = seedEvent(store.database, {
      runId,
      ruleId: RULE,
      ruleVersion: 1,
      accountId: ACCOUNT,
      now: NOW,
      deliveries: Array.from({ length: count }, (_, index) => ({
        subscriberId: subscriberId(index),
        version: 1,
        kind: 'sse' as const,
      })),
    });
    await work(store, eventId);
  } finally {
    store.close();
  }
}

function dispatcher(store: EventDatabase, apart?: <T>(work: () => Promise<T>) => Promise<T>): EventDispatcher {
  return new EventDispatcher({
    store,
    cipher: {
      encrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
      decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
    },
    approvals: { get: async () => null },
    config: { load: async () => ({ inboxes: {} }) } as never,
    listeners: { push: async () => 0 },
    secretReader: async () => [],
    now: () => NOW,
    ...(apart === undefined ? {} : { apart }),
  });
}

function attempts(store: EventDatabase, eventId: string, subscriber: string): number {
  return (
    store.database
      .prepare('SELECT attempts FROM event_deliveries WHERE event_id = ? AND subscriber_id = ?')
      .get(eventId, subscriber) as { attempts: number }
  ).attempts;
}

test('L5: 64 subscriber versions backing off or being sent do not hide the 65th, whose event is due', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withDispatcherStore(66, async (store, eventId) => {
    // The first 64 by subscriber order: half wait out a retry's backoff, half are being sent under a lease.
    for (let index = 0; index < 64; index += 1) {
      const sending = index % 2 === 1;
      store.database
        .prepare(
          `UPDATE event_deliveries
              SET state = ?, attempts = 1, next_at = ?, lease_until = ?, attempt_id = ?, lease_token = ?
            WHERE event_id = ? AND subscriber_id = ?`,
        )
        .run(
          sending ? 'disclosing' : 'retryable',
          sending ? null : NOW + 3_600_000,
          sending ? NOW + 30_000 : null,
          sending ? `attempt-${index}` : null,
          sending ? `lease-${index}` : null,
          eventId,
          subscriberId(index),
        );
    }
    const attempted = await dispatcher(store).tick();
    assert.equal(attempted, 2, 'the two due heads after the first 64 are attempted');
    assert.equal(attempts(store, eventId, subscriberId(64)), 1);
    assert.equal(attempts(store, eventId, subscriberId(65)), 1);
    assert.equal(attempts(store, eventId, subscriberId(0)), 1, 'one backing off is left to its backoff');
  });
});

test('L5: 64 subscriber versions pump has started and not yet claimed do not hide a later one', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withDispatcherStore(66, async (store, eventId) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each attempt waits for a writer lease of its own that is not free yet: until then its head stays queued.
    const events = dispatcher(store, async (work) => {
      await gate;
      return work();
    });
    try {
      assert.equal(events.pump(), 64, 'the first pass starts one batch');
      assert.equal(events.pump(), 2, 'the next pass starts the two heads the first batch did not reach');
      assert.equal(events.pump(), 0, 'and none twice');
    } finally {
      release();
      await events.stop();
    }
    assert.equal(attempts(store, eventId, subscriberId(65)), 1);
  });
});
