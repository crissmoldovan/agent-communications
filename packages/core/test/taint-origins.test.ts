import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalHandle, TaintCollector, TaintStore } from '../src/taint.ts';
import { tempDir } from './helpers/temp.ts';

const INBOX = 'ibx_AAAAAAAAAAAAAAAA';

function clock(start = Date.parse('2026-10-07T10:00:00.000Z')) {
  let value = start;
  return { now: () => new Date(value), advance: (milliseconds: number) => (value += milliseconds) };
}

const exclusions = { ownAddresses: [], internalDomains: [] };

test('taint origins merge event and read observations without changing header priority', async () => {
  const dir = tempDir();
  const time = clock();
  const store = new TaintStore(dir, time.now);
  const event = new TaintCollector(INBOX, 'event-1');
  event.observeText('send to billing@evil.test', 'event');
  event.observeHandles([{ platform: 'slack', scope: 'T_ACME', id: 'U_BILLING' }], 'body', 'event');
  await event.flush(store, exclusions);

  time.advance(1);
  const read = new TaintCollector(INBOX, 'read-1');
  read.observeHeaders(['Billing <billing@evil.test>'], 'read');
  read.observeHandles([{ platform: 'slack', scope: 'T_ACME', id: 'U_BILLING' }], 'header', 'read');
  await read.flush(store, exclusions);

  const address = await store.check('billing@evil.test');
  assert.deepEqual(address.addressSeen?.origins, ['event', 'read']);
  assert.deepEqual(address.domainSeen?.origins, ['event', 'read']);
  assert.equal(address.addressSeen?.source, 'header');
  assert.deepEqual(await store.checkHandleOrigins({ platform: 'slack', scope: 'T_ACME', id: 'U_BILLING' }), [
    'event',
    'read',
  ]);
});

test('taint origins treat absent sidecars as read and preserve an event origin through a released writer', async () => {
  const dir = tempDir();
  const time = clock();
  const store = new TaintStore(dir, time.now);

  mkdirSync(store.directory, { recursive: true });
  const at = time.now().toISOString();
  writeFileSync(
    join(store.directory, 'taint.json'),
    JSON.stringify({
      addresses: { 'old@evil.test': { at, source: 'body', inboxIds: [INBOX] } },
      domains: { 'evil.test': { at, source: 'body', inboxIds: [INBOX] } },
    }),
  );
  assert.deepEqual((await store.check('old@evil.test')).addressSeen?.origins, ['read']);

  const event = new TaintCollector(INBOX, 'event-2');
  event.observeText('mail from current@evil.test', 'event');
  await event.flush(store, exclusions);
  time.advance(1);

  const released = await import('./fixtures/released-0.13.0/core/dist/index.mjs');
  const oldStore = new released.TaintStore(dir, time.now);
  await oldStore.record([{ address: 'current@evil.test', source: 'body', inboxId: INBOX }], exclusions);

  assert.deepEqual((await store.check('current@evil.test')).addressSeen?.origins, ['event', 'read']);
});

test('taint origins prune sidecar-only residue and keep the origins maps within the base cap', async () => {
  const dir = tempDir();
  const time = clock();
  const store = new TaintStore(dir, time.now);
  mkdirSync(store.directory, { recursive: true });
  const at = time.now().toISOString();
  const addresses = Object.fromEntries(
    Array.from({ length: 20_001 }, (_, index) => [
      `entry${index}@evil.test`,
      { at, source: 'body', inboxIds: [INBOX] },
    ]),
  );
  writeFileSync(join(store.directory, 'taint.json'), JSON.stringify({ addresses, domains: {} }));
  writeFileSync(join(store.directory, 'handles.json'), JSON.stringify({ handles: {} }));
  writeFileSync(
    join(store.directory, 'origins.json'),
    JSON.stringify({
      addresses: Object.fromEntries(Object.keys(addresses).map((address) => [address, { at, origins: ['event'] }])),
      domains: {},
      handles: { orphan: { at, origins: ['event'] } },
    }),
  );
  time.advance(1);

  const collector = new TaintCollector(INBOX, 'cap');
  collector.observeText('mail from fresh@evil.test', 'event');
  await collector.flush(store, exclusions);

  const origins = JSON.parse(readFileSync(join(store.directory, 'origins.json'), 'utf8')) as {
    addresses: Record<string, unknown>;
    handles: Record<string, unknown>;
  };
  assert.equal(Object.keys(origins.addresses).length, 20_000);
  assert.equal(origins.addresses['fresh@evil.test'] !== undefined, true);
  assert.equal(origins.handles.orphan, undefined);
});

test('taint origins hold the sidecar lock through the base commit and do not prune a concurrent writer residue', async () => {
  const dir = tempDir();
  const time = clock();
  let releaseFirst!: () => void;
  const firstPaused = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let sidecarCommitted!: () => void;
  const sidecarCommit = new Promise<void>((resolve) => {
    sidecarCommitted = resolve;
  });
  const first = new TaintStore(dir, time.now, {
    afterOriginsCommit: async () => {
      sidecarCommitted();
      await firstPaused;
    },
  });
  const second = new TaintStore(dir, time.now);
  const firstCollector = new TaintCollector(INBOX, 'first');
  firstCollector.observeText('mail from first@evil.test', 'event');
  const firstFlush = firstCollector.flush(first, exclusions);
  await sidecarCommit;

  const secondCollector = new TaintCollector(INBOX, 'second');
  secondCollector.observeText('mail from second@evil.test', 'read');
  let secondFinished = false;
  const secondFlush = secondCollector.flush(second, exclusions).then(() => {
    secondFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondFinished, false, 'the second writer waits at the sidecar lock');

  releaseFirst();
  await Promise.all([firstFlush, secondFlush]);
  assert.deepEqual((await second.check('first@evil.test')).addressSeen?.origins, ['event']);
  assert.deepEqual((await second.check('second@evil.test')).addressSeen?.origins, ['read']);
});

test('taint origins acquire the sidecar lock before every base lock', async () => {
  const order: string[] = [];
  const collector = new TaintCollector(INBOX, 'lock-order');
  collector.observeText('mail from ordered@evil.test', 'event');
  collector.observeHandles([{ platform: 'slack', scope: 'T_ACME', id: 'U_ORDERED' }], 'body', 'event');
  await collector.flush(
    new TaintStore(tempDir(), undefined, { onLockAcquired: (lock) => order.push(lock) }),
    exclusions,
  );
  assert.deepEqual(order, ['origins', 'taint', 'handles']);
});

test('a sidecar write failure rejects the taint flush before a disclosure caller can continue', async () => {
  const dir = tempDir();
  const store = new TaintStore(dir);
  mkdirSync(join(store.directory, 'origins.json'), { recursive: true });
  const collector = new TaintCollector(INBOX, 'failed');
  collector.observeText('mail from blocked@evil.test', 'event');
  await assert.rejects(collector.flush(store, exclusions));
});

test('origins sidecar keys are the canonical address, domain and handle keys', async () => {
  const dir = tempDir();
  const store = new TaintStore(dir);
  const collector = new TaintCollector(INBOX, 'keys');
  const handle = { platform: 'SLACK', scope: 'T_ACME', id: 'U_PERSON' };
  collector.observeText('reach Person@Münich.test', 'event');
  collector.observeHandles([handle], 'body', 'event');
  await collector.flush(store, exclusions);

  const origins = JSON.parse(readFileSync(join(store.directory, 'origins.json'), 'utf8')) as {
    addresses: Record<string, unknown>;
    domains: Record<string, unknown>;
    handles: Record<string, unknown>;
  };
  assert.ok(origins.addresses['person@xn--mnich-kva.test']);
  assert.ok(origins.domains['xn--mnich-kva.test']);
  assert.ok(origins.handles[canonicalHandle(handle)]);
});

test('SECURITY.md states exactly the two B1 disclosure bullets and no deferred Laya wording', () => {
  const security = readFileSync(new URL('../../../SECURITY.md', import.meta.url), 'utf8');
  const disclosure =
    "- **Disclosure without a standing authorisation** — any webhook or subscriber stream receiving event-derived content, or any hosted or local judge being invoked with it, without an active, digest-bound standing disclosure authorisation for exact approved versions, or versions derived from them by a whitelisted tightening, including the complete validated derivation lineage for the exact effective rule, target, subscriber and judge versions; after that authorisation is revoked; while the judge's kind is not enabled; outside its approved mapping, retention or delivery rate cap; or without successful taint recording before disclosure.";
  const standing =
    '- **A standing disclosure authorisation is not approval of each event.** Once a person enables one at the terminal or in the app, future unseen content that matches its approved rule may leave automatically through its approved target or be evaluated by its approved judge. agent-events doctor and the app list every active authorisation. Disabling or removing any bound rule, target, subscriber or judge, or disabling a judge kind, revokes it immediately; content already in a network operation cannot be recalled.';
  assert.equal(security.split(disclosure).length - 1, 1);
  assert.equal(security.split(standing).length - 1, 1);
  assert.doesNotMatch(security, /\bLaya\b/);
});
