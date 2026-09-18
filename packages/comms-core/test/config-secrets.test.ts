import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigStore,
  duplicateInbox,
  effectiveSendPolicy,
  emptyConfig,
  findInboxById,
  INBOX_ID_PATTERN,
  type InboxConfig,
  newInboxId,
  parseConfig,
  requireInbox,
} from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { withFileLock } from '../src/lock.ts';
import {
  FileSecretStore,
  KeychainSecretStore,
  type KeyringModule,
  keychainNamespace,
  openSecretStore,
  probeKeychain,
} from '../src/secrets.ts';
import { InboxStateStore } from '../src/state.ts';
import { tempDir } from './helpers/temp.ts';

const posix = process.platform !== 'win32';

let nextId = 0;
function inbox(overrides: Partial<InboxConfig> = {}): InboxConfig {
  nextId += 1;
  return {
    id: `ibx_${String(nextId).padStart(16, '0')}`,
    provider: 'gmail',
    email: 'jo@example.com',
    identity: 'oidc',
    sub: '1001',
    client: 'default',
    tier: 'organize',
    contacts: true,
    grantedScopes: [],
    secretRef: 'gmail:client:1001',
    internalDomains: [],
    createdAt: '2026-09-18T00:00:00.000Z',
    ...overrides,
  };
}

test('an empty config has the documented defaults', () => {
  const config = emptyConfig();
  assert.equal(config.version, 1);
  assert.deepEqual(config.inboxes, {});
  assert.equal(config.defaults.sendPolicy, 'chat');
  assert.equal(config.defaults.riskEscalation, true);
  assert.deepEqual(config.defaults.sendCaps, { perHour: 20, perDay: 100 });
  assert.deepEqual(config.defaults.confirm.elicitationClients, [], 'the elicitation allowlist starts empty');
  assert.equal(config.secrets, undefined, 'no backend is chosen until the first secret is stored');
});

test('inbox ids are immutable-looking and unique; duplicates of one account are detected', () => {
  const ids = new Set(Array.from({ length: 200 }, () => newInboxId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, INBOX_ID_PATTERN);
  const config = emptyConfig();
  config.inboxes.work = inbox({ sub: '42', email: 'Jo@Example.com' });
  config.inboxes.legacy = inbox({ sub: undefined, identity: 'legacy', email: 'old@example.com' });
  assert.equal(duplicateInbox(config, { client: 'default', sub: '42', email: 'other@example.com' }), 'work');
  assert.equal(duplicateInbox(config, { client: 'default', email: 'jo@example.COM' }), 'work');
  assert.equal(duplicateInbox(config, { client: 'default', email: 'OLD@example.com' }), 'legacy');
  assert.equal(duplicateInbox(config, { client: 'other', sub: '42', email: 'jo@example.com' }), null);
  assert.equal(findInboxById(config, config.inboxes.work.id)?.alias, 'work');
});

test('parseConfig refuses bad JSON, unknown versions and invalid aliases with CONFIG errors', () => {
  assert.throws(
    () => parseConfig('{'),
    (e: unknown) => e instanceof CommsError && e.code === 'CONFIG',
  );
  assert.throws(() => parseConfig('{"version":2}'), /version 2; this release reads version 1/);
  assert.throws(
    () => parseConfig(JSON.stringify({ version: 1, inboxes: { 'Bad Alias': inbox() } })),
    /lowercase letters, digits or hyphens/,
  );
});

test('effectiveSendPolicy prefers the inbox policy over the default', () => {
  const config = emptyConfig();
  config.inboxes.work = inbox({ sendPolicy: 'confirm' });
  config.inboxes.home = inbox();
  assert.equal(effectiveSendPolicy(config, 'work'), 'confirm');
  assert.equal(effectiveSendPolicy(config, 'home'), 'chat');
});

test('requireInbox names the known aliases when one is missing', () => {
  const config = emptyConfig();
  config.inboxes.work = inbox();
  assert.throws(
    () => requireInbox(config, 'wrok'),
    (e: unknown) => e instanceof CommsError && e.code === 'NOT_FOUND' && /Known inboxes: work/.test(e.hint ?? ''),
  );
});

test('ConfigStore writes owner-only, validates before writing, and reloads changes', async () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  assert.deepEqual((await store.load()).inboxes, {});
  await store.update((config) => ({ ...config, inboxes: { ...config.inboxes, work: inbox() } }));
  assert.equal((await store.load()).inboxes.work?.email, 'jo@example.com');
  if (posix) assert.equal(statSync(store.path).mode & 0o777, 0o600);

  await assert.rejects(
    store.update((config) => ({ ...config, inboxes: { ...config.inboxes, 'NOT OK': inbox() } })),
    /refusing to write invalid config/,
  );
  assert.deepEqual(Object.keys((await store.load()).inboxes), ['work']);

  // An edit by another process is picked up.
  const other = new ConfigStore(dir);
  await other.update((config) => ({ ...config, defaults: { ...config.defaults, sendPolicy: 'never' } }));
  assert.equal((await store.load()).defaults.sendPolicy, 'never');
});

test('concurrent updates from separate stores never lose each other', async () => {
  const dir = tempDir();
  const writers = Array.from({ length: 12 }, (_, i) =>
    new ConfigStore(dir).update((config) => ({
      ...config,
      inboxes: { ...config.inboxes, [`in-${i}`]: inbox({ secretRef: `r${i}` }) },
    })),
  );
  await Promise.all(writers);
  assert.equal(Object.keys((await new ConfigStore(dir).load()).inboxes).length, 12);
});

test('withFileLock serialises critical sections and clears a stale lock', async () => {
  const dir = tempDir();
  const lock = join(dir, 'x.lock');
  let inside = 0;
  let maxInside = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      withFileLock(lock, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inside -= 1;
      }),
    ),
  );
  assert.equal(maxInside, 1);

  writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date(Date.now() - 60_000).toISOString(), token: 'dead' }));
  assert.equal(await withFileLock(lock, async () => 'ran', { staleMs: 1000 }), 'ran');
  // A live lock is never taken over, however many waiters look at it.
  writeFileSync(lock, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'alive' }));
  await assert.rejects(
    withFileLock(lock, async () => 'stolen', { staleMs: 1000, timeoutMs: 150 }),
    /holding/,
  );
  assert.match(readFileSync(lock, 'utf8'), /alive/);
});

test('withFileLock times out with LOCK_TIMEOUT while another holder is alive', async () => {
  const dir = tempDir();
  const lock = join(dir, 'held.lock');
  writeFileSync(lock, 'held');
  await assert.rejects(
    withFileLock(lock, async () => 'never', { timeoutMs: 100 }),
    (e: unknown) => e instanceof CommsError && e.code === 'LOCK_TIMEOUT' && e.exitCode === 75,
  );
});

test('FileSecretStore stores one owner-only file per secret, keyed by a hash of the ref', async () => {
  const dir = tempDir();
  const store = new FileSecretStore(join(dir, 'secrets'));
  assert.equal(await store.get('gmail:a'), null);
  await store.set('gmail:a', 'value-a');
  await store.set('gmail:b', 'value-b');
  assert.equal(await store.get('gmail:a'), 'value-a');
  const files = readdirSync(join(dir, 'secrets'));
  assert.equal(files.length, 2);
  assert.ok(
    files.every((name) => /^[0-9a-f]{32}\.json$/.test(name)),
    'file names reveal nothing about the ref',
  );
  if (posix) assert.equal(statSync(join(dir, 'secrets', files[0] ?? '')).mode & 0o777, 0o600);
  assert.equal(await store.delete('gmail:a'), true);
  assert.equal(await store.delete('gmail:a'), false);
  assert.equal(await store.get('gmail:a'), null);
});

function fakeKeyring(behaviour: 'ok' | 'locked' | 'hang' = 'ok'): { module: KeyringModule; data: Map<string, string> } {
  const data = new Map<string, string>();
  class AsyncEntry {
    readonly key: string;
    constructor(service: string, username: string, options?: { linux?: { store?: string } } | null) {
      assert.equal(service, 'agent-communications');
      assert.equal(options?.linux?.store, 'secret-service', 'Linux must be pinned to Secret Service');
      this.key = username;
    }
    async #act<T>(signal: AbortSignal | null | undefined, fn: () => T): Promise<T> {
      if (behaviour === 'locked') throw new Error('Platform secure storage failure: locked');
      if (behaviour === 'hang') {
        // Like a native call stuck behind an OS dialog: never settles and ignores any signal.
        void signal;
        await new Promise(() => {});
      }
      return fn();
    }
    getPassword(signal?: AbortSignal | null) {
      return this.#act(signal, () => data.get(this.key));
    }
    setPassword(value: string, signal?: AbortSignal | null) {
      return this.#act(signal, () => {
        data.set(this.key, value);
      });
    }
    deletePassword(signal?: AbortSignal | null) {
      return this.#act(signal, () => data.delete(this.key));
    }
  }
  return { module: { AsyncEntry } as unknown as KeyringModule, data };
}

test('KeychainSecretStore round-trips through the keyring pinned to Secret Service, reading each secret once', async () => {
  const { module, data } = fakeKeyring();
  const store = new KeychainSecretStore(module, 'ns1');
  await store.set('gmail:x', 'v');
  assert.equal(data.get('ns1:gmail:x'), 'v', 'entries are namespaced by config directory');
  assert.equal(await store.get('gmail:x'), 'v');
  assert.equal(await store.get('missing'), null);
  data.set('ns1:gmail:x', 'changed-behind-our-back');
  assert.equal(await store.get('gmail:x'), 'v', 'served from the per-process cache: one prompt per secret per start');
  assert.equal(await store.delete('gmail:x'), true);
  assert.equal(await store.get('gmail:x'), null);
});

test('a locked or hanging keychain fails fast with a CONFIG error, never a silent fallback', async () => {
  const locked = new KeychainSecretStore(fakeKeyring('locked').module, 'ns');
  await assert.rejects(locked.get('a'), /refused to read a stored secret/);
  const hanging = new KeychainSecretStore(fakeKeyring('hang').module, 'ns', 50);
  await assert.rejects(
    hanging.get('a'),
    (e: unknown) =>
      e instanceof CommsError && /did not answer/.test(e.message) && e.details?.reason === 'KEYCHAIN_APPROVAL_PENDING',
  );
});

test('probeKeychain reports ok only after a full round trip through the keychain itself', async () => {
  const { module, data } = fakeKeyring();
  assert.deepEqual(await probeKeychain(module), { ok: true });
  assert.equal(data.size, 0, 'the probe entry is removed');
  // A keychain that accepts writes but returns nothing must fail the probe, not pass via a cache.
  const forgetful = fakeKeyring();
  const originalGet = forgetful.data.get.bind(forgetful.data);
  forgetful.data.get = (key: string) => (key.includes(':probe:') ? undefined : originalGet(key));
  assert.equal((await probeKeychain(forgetful.module)).ok, false);
  const result = await probeKeychain(fakeKeyring('locked').module);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /refused/);
});

test('openSecretStore refuses a keychain inbox when the keyring module is missing', async () => {
  const dir = tempDir();
  assert.equal((await openSecretStore('file', { secretsDir: dir, namespace: 'n' })).kind, 'file');
  await assert.rejects(
    openSecretStore('keychain', { secretsDir: dir, namespace: 'n', keyring: null }),
    /keychain module is missing/,
  );
  assert.equal(
    (await openSecretStore('keychain', { secretsDir: dir, namespace: 'n', keyring: fakeKeyring().module })).kind,
    'keychain',
  );
  assert.notEqual(keychainNamespace('/a/config'), keychainNamespace('/b/config'));
});

test('runtime state lives outside config and merges under a lock', async () => {
  const dir = tempDir();
  const states = new InboxStateStore(dir);
  const id = newInboxId();
  assert.deepEqual(await states.get(id), {});
  await Promise.all([
    states.update(id, { lastRefreshOkAt: '2026-09-18T10:00:00.000Z' }),
    states.update(id, { lastUsedAt: '2026-09-18T10:00:01.000Z' }),
  ]);
  assert.deepEqual(await states.get(id), {
    lastRefreshOkAt: '2026-09-18T10:00:00.000Z',
    lastUsedAt: '2026-09-18T10:00:01.000Z',
  });
  await assert.rejects(states.get('../../etc/passwd'), /not an inbox id/);
});

test('the secret store can be chosen once, and not quietly moved afterwards', async () => {
  const store = new ConfigStore(tempDir());

  // Setup: nothing has ever been stored, so choosing files is a choice, not a downgrade. A machine with no keychain
  // has no other option, and a typed challenge cannot be asked for in the middle of an unattended install.
  await store.update((config) => ({ ...config, secrets: { store: 'file' } }));
  assert.equal((await store.load()).secrets?.store, 'file');

  // Tightening afterwards is free.
  await store.update((config) => ({ ...config, secrets: { store: 'keychain' } }));

  // Moving away from a recorded keychain is refused…
  await assert.rejects(
    store.update((config) => ({ ...config, secrets: { store: 'file' } })),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );

  // …including by erasing the record so the next write can choose freely.
  await assert.rejects(
    store.update((config) => {
      const next = { ...config };
      delete next.secrets;
      return next;
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'LOOSENING_REFUSED',
  );

  await store.update((config) => ({ ...config, secrets: { store: 'file' } }), {
    consent: { kind: 'loosening-consent', paths: ['secrets.store'] },
  });
  assert.equal((await store.load()).secrets?.store, 'file');
});
