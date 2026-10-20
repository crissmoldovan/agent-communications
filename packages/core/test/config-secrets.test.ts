import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigStore,
  committedSecretsStore,
  duplicateInbox,
  effectiveSendPolicy,
  emptyConfig,
  findInboxById,
  INBOX_ID_PATTERN,
  type InboxConfig,
  newInboxId,
  parseConfig,
} from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { withFileLock } from '../src/lock.ts';
import { requireInbox } from '../src/names.ts';
import {
  FileSecretStore,
  KeychainSecretStore,
  type KeyringModule,
  keychainNamespace,
  openSecretStore,
  probeKeychain,
} from '../src/secrets.ts';
import { InboxStateStore } from '../src/state.ts';
import { coreHandoffs } from './helpers/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/** Core's own handoffs, as `openCore({ caller })` hands its stores: a refusal that names a command needs them. */
const HANDOFFS = coreHandoffs({
  configDir: '/pins/config',
  stateDir: '/pins/state',
  dataDir: '/pins/data',
  secretsDir: '/pins/secrets',
  downloadsDir: '/pins/downloads',
});

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
  assert.equal(config.version, 2, 'new configs name accounts organisation/platform');
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
  config.inboxes['acme/gmail'] = inbox({ sub: '42', email: 'Jo@Example.com' });
  config.inboxes['old/gmail'] = inbox({ sub: undefined, identity: 'legacy', email: 'old@example.com' });
  assert.equal(duplicateInbox(config, { client: 'default', sub: '42', email: 'other@example.com' }), 'acme/gmail');
  assert.equal(duplicateInbox(config, { client: 'default', email: 'jo@example.COM' }), 'acme/gmail');
  assert.equal(duplicateInbox(config, { client: 'default', email: 'OLD@example.com' }), 'old/gmail');
  assert.equal(duplicateInbox(config, { client: 'other', sub: '42', email: 'jo@example.com' }), null);
  assert.equal(findInboxById(config, config.inboxes['acme/gmail'].id)?.alias, 'acme/gmail');
});

test('parseConfig refuses bad JSON, unknown versions and invalid aliases with CONFIG errors', () => {
  assert.throws(
    () => parseConfig('{'),
    (e: unknown) => e instanceof CommsError && e.code === 'CONFIG',
  );
  assert.throws(() => parseConfig('{"version":4}'), /version 4; this release reads versions 1, 2 and 3/);
  // Version 3 says how its accounts are named; without it, there is no body to validate.
  assert.throws(() => parseConfig('{"version":3}'), /naming: version 3 names its accounts by naming 1 or 2/);
  assert.throws(
    () => parseConfig(JSON.stringify({ version: 1, inboxes: { 'Bad Alias': inbox() } })),
    /lowercase letters, digits or hyphens/,
  );
});

test('version 3 reads the names its naming says, refuses the other kind, and validates its epochs and its drain', () => {
  const plain = parseConfig(JSON.stringify({ version: 3, naming: 1, inboxes: { work: inbox() } }));
  assert.equal(plain.version, 3);
  assert.deepEqual(Object.keys(plain.inboxes), ['work']);
  const named = parseConfig(JSON.stringify({ version: 3, naming: 2, inboxes: { 'acme/gmail': inbox() } }));
  assert.deepEqual(Object.keys(named.inboxes), ['acme/gmail']);
  assert.throws(() => parseConfig(JSON.stringify({ version: 3, naming: 1, inboxes: { 'acme/gmail': inbox() } })), {
    name: 'CommsError',
  });
  assert.throws(() => parseConfig(JSON.stringify({ version: 3, naming: 2, inboxes: { work: inbox() } })), {
    name: 'CommsError',
  });
  assert.throws(() => parseConfig(JSON.stringify({ version: 3, naming: 3 })), /naming 1 or 2/);
  // An epoch is a count that only grows from 0; a drain names when it opened and what it tracks.
  for (const sendEpochs of [{ ibx_A: -1 }, { ibx_A: 1.5 }, { ibx_A: '1' }]) {
    assert.throws(() => parseConfig(JSON.stringify({ version: 3, naming: 2, sendEpochs })), { name: 'CommsError' });
  }
  for (const legacyDrain of [
    { tracked: {} },
    { since: '2026-10-05T10:00:00.000Z', tracked: { [`ap_${'0'.repeat(26)}`]: 'gone' } },
  ]) {
    assert.throws(() => parseConfig(JSON.stringify({ version: 3, naming: 2, legacyDrain })), { name: 'CommsError' });
  }
  const tracked = { [`ap_${'0'.repeat(26)}`]: 'open', [`ap_${'0'.repeat(25)}1`]: 'used' };
  const drained = parseConfig(
    JSON.stringify({
      version: 3,
      naming: 2,
      sendEpochs: { ibx_A: 3 },
      legacyDrain: { since: '2026-10-05T10:00:00.000Z', tracked },
    }),
  );
  assert.ok(drained.version === 3);
  assert.deepEqual(drained.sendEpochs, { ibx_A: 3 });
  assert.deepEqual(drained.legacyDrain?.tracked, tracked);
});

const pendingRevocation = {
  ref: 'slack:token:old',
  store: 'file',
  platform: 'slack',
  workspace: 'TACME0001',
  createdAt: '2026-10-04T10:00:00.000Z',
  tokens: {
    access: { status: 'pending', deadline: '2026-10-04T11:00:00.000Z' },
    refresh: { status: 'revoked', deadline: '2026-11-03T10:00:00.000Z' },
  },
};

function slackAccount(provenance: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'acc_AAAAAAAAAAAAAAAA',
    platform: 'slack',
    workspace: 'TACME0001',
    userId: 'U1',
    tier: 'read',
    grantedScopes: [],
    secretRef: 'slack:token:current',
    createdAt: '2026-10-04T10:00:00.000Z',
    ...provenance,
  };
}

function configWithSlackState(version: 1 | 2, account: Record<string, unknown>, ledger: unknown = pendingRevocation) {
  return {
    version,
    accounts: { [version === 1 ? 'work' : 'acme/slack']: account },
    pendingRevocations: [ledger],
  };
}

test('both config versions type Slack profile provenance and the pending-revocation ledger', () => {
  for (const version of [1, 2] as const) {
    const parsed = parseConfig(
      JSON.stringify(configWithSlackState(version, slackAccount({ organisation: 'acme', profileApp: 'read' }))),
    );
    const account = Object.values(parsed.accounts)[0];
    assert.equal(account?.organisation, 'acme');
    assert.equal(account?.profileApp, 'read');
    assert.deepEqual(parsed.pendingRevocations, [pendingRevocation]);
  }
});

test('profile provenance is validated instead of surviving as an unknown account field', () => {
  for (const version of [1, 2] as const) {
    assert.throws(
      () => parseConfig(JSON.stringify(configWithSlackState(version, slackAccount({ organisation: 7 })))),
      /accounts.*organisation/s,
      `version ${version}: organisation`,
    );
    assert.throws(
      () => parseConfig(JSON.stringify(configWithSlackState(version, slackAccount({ profileApp: 'admin' })))),
      /accounts.*profileApp/s,
      `version ${version}: profile app`,
    );
  }
});

test('the pending-revocation ledger requires its recorded store, access state, status and absolute deadlines', () => {
  const invalid = [
    { ...pendingRevocation, store: 'elsewhere' },
    { ...pendingRevocation, tokens: {} },
    {
      ...pendingRevocation,
      tokens: { ...pendingRevocation.tokens, access: { ...pendingRevocation.tokens.access, status: 'done' } },
    },
    {
      ...pendingRevocation,
      tokens: { ...pendingRevocation.tokens, access: { ...pendingRevocation.tokens.access, deadline: 'tomorrow' } },
    },
  ];
  for (const [index, ledger] of invalid.entries()) {
    for (const version of [1, 2] as const) {
      assert.throws(
        () => parseConfig(JSON.stringify(configWithSlackState(version, slackAccount(), ledger))),
        /pendingRevocations/,
        `case ${index}, version ${version}`,
      );
    }
  }
});

test('a pending-only configuration has committed to the store recorded by its ledger', () => {
  for (const version of [1, 2] as const) {
    const parsed = parseConfig(JSON.stringify({ version, pendingRevocations: [pendingRevocation] }));
    assert.equal(committedSecretsStore(parsed), 'keychain', `version ${version}`);
  }
});

test('effectiveSendPolicy prefers the inbox policy over the default', () => {
  const config = emptyConfig();
  config.inboxes['acme/gmail'] = inbox({ sendPolicy: 'confirm' });
  config.inboxes['acme/gmail-home'] = inbox();
  assert.equal(effectiveSendPolicy(config, 'acme/gmail'), 'confirm');
  assert.equal(effectiveSendPolicy(config, 'acme/gmail-home'), 'chat');
});

test('requireInbox names the known aliases when one is missing', () => {
  const config = emptyConfig();
  config.inboxes['acme/gmail'] = inbox();
  assert.throws(
    () => requireInbox(config, 'acme/gmial'),
    (e: unknown) =>
      e instanceof CommsError && e.code === 'NOT_FOUND' && /Known inboxes: acme\/gmail/.test(e.hint ?? ''),
  );
});

test('ConfigStore writes owner-only, validates before writing, and reloads changes', async () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  assert.deepEqual((await store.load()).inboxes, {});
  await store.update((config) => ({ ...config, inboxes: { ...config.inboxes, 'acme/gmail': inbox() } }));
  assert.equal((await store.load()).inboxes['acme/gmail']?.email, 'jo@example.com');
  if (posix) assert.equal(statSync(store.path).mode & 0o777, 0o600);

  await assert.rejects(
    store.update((config) => ({ ...config, inboxes: { ...config.inboxes, 'NOT OK': inbox() } })),
    /refusing to write invalid config/,
  );
  assert.deepEqual(Object.keys((await store.load()).inboxes), ['acme/gmail']);

  // An edit by another process is picked up.
  const other = new ConfigStore(dir);
  await other.update((config) => ({ ...config, defaults: { ...config.defaults, timezone: 'Europe/Bucharest' } }));
  assert.equal((await store.load()).defaults.timezone, 'Europe/Bucharest');
});

test('concurrent updates from separate stores never lose each other', async () => {
  /*
   * Twelve writers at once, each holding the config lock for half a second: the slow file system this failed on, on the
   * Windows runner, where each write's read, check and fsynced rename took about that long. The half second is spent
   * inside the lock, in the mutator, so on any machine the line lasts six seconds or more, past the lock's five-second
   * timeout. A write has to count that timeout per holder, not from when it began to wait, or the last in line is
   * refused with LOCK_TIMEOUT while the lock is handed on as it should be. A lost update would leave fewer than twelve.
   */
  const dir = tempDir();
  const holdMs = 500;
  const started = Date.now();
  const writers = Array.from({ length: 12 }, (_, i) =>
    new ConfigStore(dir).update(async (config) => {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      return { ...config, inboxes: { ...config.inboxes, [`acme/gmail-${i}`]: inbox({ secretRef: `r${i}` }) } };
    }),
  );
  await Promise.all(writers);
  assert.equal(Object.keys((await new ConfigStore(dir).load()).inboxes).length, 12);
  const line = Date.now() - started;
  assert.ok(line > 5_000, `one writer at a time, so the line outlasted the lock's five-second timeout: ${line}ms`);
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

test('a permissions problem fails immediately; it is not reported as contention', async () => {
  // Contention is worth waiting out; a directory we cannot write to never becomes writable, and announcing "another
  // process is holding it" five seconds later would be both slower and untrue. Root ignores the mode, and Windows
  // does not have these semantics at all.
  if (platform() === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0)) return;
  const dir = tempDir();
  const lock = join(dir, 'sealed', 'x.lock');
  mkdirSync(join(dir, 'sealed'));
  chmodSync(join(dir, 'sealed'), 0o500);
  try {
    const started = Date.now();
    await assert.rejects(
      withFileLock(lock, async () => 'never', { timeoutMs: 5000 }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
    );
    assert.ok(Date.now() - started < 2000, 'it should not have waited out the timeout');
  } finally {
    chmodSync(join(dir, 'sealed'), 0o700);
  }
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
  const locked = new KeychainSecretStore(fakeKeyring('locked').module, 'ns', undefined, { handoffs: HANDOFFS });
  await assert.rejects(locked.get('a'), /refused to read a stored secret/);
  const hanging = new KeychainSecretStore(fakeKeyring('hang').module, 'ns', 50, { handoffs: HANDOFFS });
  await assert.rejects(
    hanging.get('a'),
    (e: unknown) =>
      e instanceof CommsError && /did not answer/.test(e.message) && e.details?.reason === 'KEYCHAIN_APPROVAL_PENDING',
  );
});

test('settled() waits out a keychain call that outlived its timeout, so the next write can succeed', async () => {
  /*
   * The refresh path's one unrepeatable write depends on this. After a timeout the store fails every call fast
   * until the stuck native call finishes, so a caller retrying on a timer spends every attempt against the same
   * dialog. `settled()` is the moment asking again can work.
   */
  const { module, data } = fakeKeyring();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stall = true;
  const original = module.AsyncEntry;
  const Stalling = class extends (original as unknown as new (
    ...args: unknown[]
  ) => {
    setPassword(value: string): Promise<void>;
  }) {
    override async setPassword(value: string): Promise<void> {
      if (stall) {
        stall = false;
        await held;
      }
      return super.setPassword(value);
    }
  };
  const store = new KeychainSecretStore({ AsyncEntry: Stalling } as unknown as KeyringModule, 'ns', 30, {
    handoffs: HANDOFFS,
  });
  await assert.rejects(store.set('a', 'first'), /did not answer/);
  await assert.rejects(store.set('a', 'second'), /did not answer/, 'a stuck call makes the next one fail fast');

  let done = false;
  const waiting = store.settled().then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false, 'settled() resolved while the native call was still held');
  release();
  await waiting;
  await store.set('a', 'third');
  assert.equal(data.get('ns:a'), 'third', 'the write after settling reached the keychain');
  // Nothing stuck: resolves at once.
  await new KeychainSecretStore(fakeKeyring().module, 'ns').settled();
});

test('probeKeychain reports ok only after a full round trip through the keychain itself', async () => {
  const { module, data } = fakeKeyring();
  assert.deepEqual(await probeKeychain(module, 'probe', HANDOFFS), { ok: true });
  assert.equal(data.size, 0, 'the probe entry is removed');
  // A keychain that accepts writes but returns nothing must fail the probe, not pass via a cache.
  const forgetful = fakeKeyring();
  const originalGet = forgetful.data.get.bind(forgetful.data);
  forgetful.data.get = (key: string) => (key.includes(':probe:') ? undefined : originalGet(key));
  assert.equal((await probeKeychain(forgetful.module, 'probe', HANDOFFS)).ok, false);
  const result = await probeKeychain(fakeKeyring('locked').module, 'probe', HANDOFFS);
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

test('settings a newer version wrote survive an older reader, instead of being silently dropped', async () => {
  const dir = tempDir();
  const store = new ConfigStore(dir);
  await store.update((config) => ({
    ...config,
    secrets: { store: 'file' },
    inboxes: {
      'acme/gmail': {
        id: newInboxId(),
        provider: 'gmail',
        email: 'jo@example.test',
        identity: 'legacy',
        client: 'default',
        tier: 'read',
        contacts: false,
        grantedScopes: [],
        secretRef: 'gmail:refresh:x',
        internalDomains: [],
        createdAt: '2026-09-18T10:00:00.000Z',
      },
    },
  }));

  // A later version adds fields this one has never heard of, at each level of the file.
  const path = join(dir, 'config.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  raw.futureTopLevel = { enabled: true };
  (raw.defaults as Record<string, unknown>).futureDefault = 42;
  ((raw.inboxes as Record<string, Record<string, unknown>>)['acme/gmail'] as Record<string, unknown>).futureInboxField =
    'keep';
  writeFileSync(path, JSON.stringify(raw, null, 2));

  // Reading keeps them...
  const loaded = (await store.load()) as unknown as Record<string, unknown>;
  assert.deepEqual(loaded.futureTopLevel, { enabled: true });

  // ...and so does a write by this version, which is what stops one process undoing another's settings.
  await store.update((config) => ({ ...config, defaults: { ...config.defaults, timezone: 'Europe/London' } }));
  const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
  assert.deepEqual(after.futureTopLevel, { enabled: true });
  assert.equal(after.defaults?.futureDefault, 42);
  assert.equal((after.inboxes?.['acme/gmail'] as Record<string, unknown>)?.futureInboxField, 'keep');
  assert.equal(after.defaults?.timezone, 'Europe/London');
});

test('a zero-byte or corrupt lock is taken over by its age, not left to wedge the file for ever', async () => {
  // `withFileLock` creates the lock file and writes its body in two separate awaits with no fsync between them, so a
  // SIGKILL, an OOM kill or a power cut in between leaves a zero-byte lock behind. `isStale` read "no body" as "not
  // stale", so that file blocked config, the approval ledger and the send ledger permanently, for every process,
  // with no way out but finding and deleting it by hand.
  const dir = tempDir();

  const empty = join(dir, 'empty.lock');
  writeFileSync(empty, '');
  assert.equal(
    await withFileLock(empty, async () => 'ran', { staleMs: 1, timeoutMs: 2000 }),
    'ran',
    'a zero-byte lock must be taken over once it is older than staleMs',
  );

  // Same trap, different hat: a readable body whose timestamp does not parse gives `Date.now() - NaN > staleMs`,
  // which is false for ever.
  const corrupt = join(dir, 'corrupt.lock');
  writeFileSync(corrupt, JSON.stringify({ pid: 1, at: 'not a date', token: 'x' }));
  assert.equal(await withFileLock(corrupt, async () => 'ran', { staleMs: 1, timeoutMs: 2000 }), 'ran');

  // And a fresh empty lock is still respected: age is what decides, exactly as for a readable one.
  const fresh = join(dir, 'fresh.lock');
  writeFileSync(fresh, '');
  await assert.rejects(
    withFileLock(fresh, async () => 'ran', { staleMs: 60_000, timeoutMs: 300 }),
    (error: unknown) => error instanceof CommsError && error.code === 'LOCK_TIMEOUT',
    'a lock younger than staleMs is never taken over, body or no body',
  );
});

test('a renewing holder that runs past the stale window is not overtaken', async () => {
  /*
   * Staleness was judged from a time written once, at acquisition. A holder still working past `staleMs` — a
   * migration of many credentials, each waiting on a keychain — could be taken over mid-operation, recreating the
   * race the lock exists to prevent. Scaled down: a 150ms stale window, renewed every 40ms, held for 500ms.
   */
  const path = join(tempDir(), 'held.lock');
  const events: string[] = [];
  const first = withFileLock(
    path,
    async () => {
      events.push('first:start');
      await new Promise((settle) => setTimeout(settle, 500));
      events.push('first:end');
    },
    { staleMs: 150, renewMs: 40 },
  );
  await new Promise((settle) => setTimeout(settle, 250)); // past the stale window, while the first still holds
  const second = withFileLock(
    path,
    async () => {
      events.push('second:start');
    },
    { staleMs: 150, timeoutMs: 2_000 },
  );
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'], 'a live holder was overtaken');
});

test('a holder that stopped renewing is still taken over, so a crash does not wedge the lock', async () => {
  // The other half: renewal must not make a dead holder immortal. A lock file nobody is touching goes stale.
  const path = join(tempDir(), 'abandoned.lock');
  writeFileSync(path, JSON.stringify({ pid: 999_999, at: new Date(Date.now() - 1_000).toISOString(), token: 'gone' }));
  let ran = false;
  await withFileLock(
    path,
    async () => {
      ran = true;
    },
    { staleMs: 150, timeoutMs: 2_000 },
  );
  assert.equal(ran, true);
});

/**
 * Puts the next holder's body in place, or leaves the lock as it is for this turn when Windows will not.
 *
 * Windows refuses to rename over a file another process has open, with EPERM (or EACCES or EBUSY), and the waiter under
 * test opens the lock to read its token many times a second — the first Windows release run met it at once. A turn
 * skipped is a hand-over 50 ms later than planned, which changes nothing either test asserts; the next tick tries again.
 */
function replaceLock(next: string, lock: string): void {
  try {
    renameSync(next, lock);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
  }
}

/**
 * Stands in for a line of other callers: puts a new holder's token in the lock every `everyMs`, and never leaves it
 * free in between, so a waiter sees the lock handed on again and again and never gets a turn until `stop`. Renamed
 * into place, so a waiter never reads half a body.
 */
function handedOnRepeatedly(path: string, everyMs: number): { stop: () => void } {
  let holders = 0;
  const handOn = () => {
    holders += 1;
    const next = `${path}.next`;
    writeFileSync(next, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: `holder-${holders}` }));
    replaceLock(next, path);
  };
  handOn();
  const timer = setInterval(handOn, everyMs);
  return {
    stop: () => {
      clearInterval(timer);
      rmSync(path, { force: true });
    },
  };
}

test('with timeoutPerHolder a waiter keeps its place while the lock keeps changing hands; without, it gives up', async () => {
  /*
   * Six callers on one lock at the same moment, on a machine slow enough, used to time the last of them out: its
   * five seconds were a budget for every holder ahead of it, though the lock was being handed on as it should be.
   * Scaled down: a line of holders lasting six seconds, each a moment long, against a timeout of five seconds — and
   * of 300ms for the caller that keeps the old rule, which is still the default.
   *
   * Seconds, not tenths: the waiter and the stand-in line run in one process, so a stall of that process — the
   * pre-push verify runs every package's tests at once, and a load of 89 stalled it past a second — stops the line
   * handing on while the waiter's clock keeps going, and a budget of one second read the stall as a stuck holder.
   */
  const path = join(tempDir(), 'queue.lock');
  const line = handedOnRepeatedly(path, 50);
  const ended = setTimeout(line.stop, 6_000);
  const started = Date.now();
  try {
    const [patient, plain] = await Promise.allSettled([
      // An overall limit far past the line, so that only the per-holder rule is under test here.
      withFileLock(path, async () => Date.now() - started, {
        timeoutMs: 5_000,
        timeoutPerHolder: true,
        maxWaitMs: 60_000,
      }),
      withFileLock(path, async () => Date.now() - started, { timeoutMs: 300 }),
    ]);
    assert.equal(
      patient.status,
      'fulfilled',
      `it gave up in the line: ${String((patient as PromiseRejectedResult).reason)}`,
    );
    assert.ok(patient.value > 5_000, `it had its turn only once the line ahead had gone, after ${patient.value}ms`);
    assert.ok(
      plain.status === 'rejected' && plain.reason instanceof CommsError && plain.reason.code === 'LOCK_TIMEOUT',
      'without the option the timeout still counts the whole line: the default has not changed',
    );
  } finally {
    clearTimeout(ended);
    line.stop();
  }
});

test('with timeoutPerHolder, one holder that keeps the lock still makes a waiter give up', async () => {
  // The other half: per holder is not for ever. A lock that never changes hands is the stuck lock the timeout is for.
  const path = join(tempDir(), 'stuck.lock');
  writeFileSync(path, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'stuck' }));
  // Released long after the timeout, only so that a waiter that never gives up ends the test rather than hanging it.
  const released = setTimeout(() => rmSync(path, { force: true }), 3_000);
  try {
    await assert.rejects(
      withFileLock(path, async () => 'had a turn', { timeoutMs: 300, timeoutPerHolder: true, maxWaitMs: 60_000 }),
      (error: unknown) =>
        error instanceof CommsError &&
        error.code === 'LOCK_TIMEOUT' &&
        /another agent-communications process is holding/.test(error.message),
    );
  } finally {
    clearTimeout(released);
  }
});

test('with timeoutPerHolder, a lock that keeps changing hands past a waiter still ends its wait, at maxWaitMs', async () => {
  /*
   * The lock is polled, not queued: whoever looks first after a release takes it. So a waiter can lose it to caller
   * after caller arriving later, and per holder its timeout starts again at every hand-over — alone, a wait with no
   * end. Here the line never ends while the waiter is in it: a new holder every 50 ms, against ten seconds for each
   * holder (never reached, even with the process stalled) and an overall limit of 600 ms (reached). The line stops
   * after twelve seconds only so that a waiter that never gives up gets its turn and fails the test, rather than
   * hanging it.
   */
  const path = join(tempDir(), 'overtaken.lock');
  const line = handedOnRepeatedly(path, 50);
  const ended = setTimeout(line.stop, 12_000);
  const started = Date.now();
  try {
    await assert.rejects(
      withFileLock(path, async () => `had a turn after ${Date.now() - started}ms`, {
        timeoutMs: 10_000,
        timeoutPerHolder: true,
        maxWaitMs: 600,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommsError, String(error));
        assert.equal(error.code, 'LOCK_TIMEOUT');
        assert.equal(error.message, `gave up waiting for ${path}: the wait hit its overall limit of 0.6 s`);
        assert.match(String(error.hint), /changed hands \d+ time\(s\) while this waited/, 'and says it was busy');
        return true;
      },
    );
    assert.ok(Date.now() - started >= 600, `it gave up at the limit, not before: after ${Date.now() - started}ms`);
  } finally {
    clearTimeout(ended);
    line.stop();
  }
});

test('maxWaitMs bounds a wait on a stuck lock too, before its timeout', async () => {
  // Fixed when the wait begins: an overall limit shorter than the timeout ends the wait first, whatever the lock does.
  const path = join(tempDir(), 'stuck-short.lock');
  writeFileSync(path, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'stuck' }));
  const released = setTimeout(() => rmSync(path, { force: true }), 8_000);
  try {
    await assert.rejects(
      withFileLock(path, async () => 'had a turn', { timeoutMs: 5_000, maxWaitMs: 300 }),
      (error: unknown) =>
        error instanceof CommsError && error.code === 'LOCK_TIMEOUT' && /overall limit of 0\.3 s/.test(error.message),
    );
  } finally {
    clearTimeout(released);
  }
});
