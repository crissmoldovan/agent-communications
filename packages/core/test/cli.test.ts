import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { needsYes } from '../src/cli.ts';
import type { Streams } from '../src/cli-runtime.ts';
import { secretsStoreOf } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { tempDir } from './helpers/temp.ts';

/** A fixed timestamp, so a fixture never depends on when the suite ran. */
const NOW = '2026-01-01T00:00:00.000Z';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// Type stripping is on by default only from Node 22.18; the flag lets the source CLI run on older 22.x too.
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function run(args: string[], env: Record<string, string> = {}) {
  const config = env.AGENT_COMMS_CONFIG_DIR ?? tempDir();
  const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tempDir(), AGENT_COMMS_CONFIG_DIR: config, NO_COLOR: '1', ...env },
  });
  return { ...result, config };
}

test('--version and --help print and exit 0', () => {
  assert.match(run(['--version']).stdout, /^\d+\.\d+\.\d+/);
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agentcomms paths/);
  assert.match(help.stdout, /Exit codes:/);
});

test('paths --json prints the versioned envelope with the overridden config dir', () => {
  const { stdout, status, config } = run(['paths', '--json']);
  assert.equal(status, 0);
  const envelope = JSON.parse(stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.data.configDir, config);
  assert.equal(envelope.data.stateDir, join(config, 'state'));
});

test('unknown commands and flags are usage errors (64), in the envelope when --json is given', () => {
  const unknown = run(['frobnicate', '--json']);
  assert.equal(unknown.status, 64);
  assert.equal(JSON.parse(unknown.stdout).error.code, 'USAGE');
  const badFlag = run(['paths', '--bogus', '--json']);
  assert.equal(badFlag.status, 64);
  assert.equal(JSON.parse(badFlag.stdout).ok, false);
  const human = run(['paths', '--bogus']);
  assert.match(human.stderr, /^error: /);
  assert.equal(human.stdout, '');
});

test('audit tail and approvals list work on an empty config', () => {
  const audit = run(['audit', 'tail', '--json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.deepEqual(JSON.parse(audit.stdout).data, []);
  const approvals = run(['approvals', 'list', '--json']);
  assert.deepEqual(JSON.parse(approvals.stdout).data, []);
  const missing = run(['approvals', 'list', '--inbox', 'nope', '--json']);
  assert.equal(missing.status, 66);
});

test('audit tail --inbox and approvals list --inbox refuse a former name with the current one', () => {
  const config = tempDir();
  writeFileSync(
    join(config, 'config.json'),
    JSON.stringify({
      version: 2,
      inboxes: {
        'acme/gmail': {
          id: 'ibx_AAAAAAAAAAAAAAAA',
          provider: 'gmail',
          email: 'jo@example.test',
          identity: 'oidc',
          client: 'desktop',
          tier: 'read',
          secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
          createdAt: NOW,
        },
      },
      formerNames: { inboxes: { work: { name: 'acme/gmail', id: 'ibx_AAAAAAAAAAAAAAAA' } }, accounts: {} },
    }),
  );
  for (const command of [
    ['audit', 'tail'],
    ['approvals', 'list'],
  ]) {
    const refused = run([...command, '--inbox', 'work', '--json'], { AGENT_COMMS_CONFIG_DIR: config });
    assert.equal(refused.status, 66, command.join(' '));
    const error = JSON.parse(refused.stdout).error;
    assert.match(error.message, /"work" was renamed to "acme\/gmail"/);
    assert.equal(error.details.currentName, 'acme/gmail');
    const current = run([...command, '--inbox', 'acme/gmail', '--json'], { AGENT_COMMS_CONFIG_DIR: config });
    assert.equal(current.status, 0, current.stderr);
  }
});

test('secrets migrate to file on an empty config records the backend without a keychain', () => {
  const { status, stdout, config } = run(['secrets', 'migrate', '--to', 'file', '--json'], {});
  // With no config yet the current backend is keychain; migrating to file needs no keychain access when nothing
  // is stored, and records the new backend.
  const envelope = JSON.parse(stdout);
  if (status === 0) {
    assert.equal(envelope.data.to, 'file');
    assert.equal(statSync(join(config, 'config.json')).isFile(), true);
  } else {
    // The keychain module may be unavailable on a CI runner; the error must then be a CONFIG error, not a crash.
    assert.ok(['CONFIG', 'SECRET_STORE_UNAVAILABLE'].includes(envelope.error.code));
  }
});

test('the migration ref list carries the non-mail accounts too', async () => {
  /*
   * `secretRefsOf` was built from `clients` and `inboxes` and the approval key. A Slack workspace's token lives
   * under `accounts`, so a migration would have carried the mail credentials across, deleted the originals, and
   * left every workspace token on a backend nothing reads any more — a total loss for one platform, found on the
   * next call.
   *
   * Asserted on the list rather than by running a migration, because `migrateSecrets` returns early when the
   * source and target are the same store, and the only real migration needs a keychain the CI runner may not
   * have. A test that skips on CI would not have caught this.
   */
  const { secretRefsOf } = await import('../src/cli.ts');
  const { emptyConfig, newAccountId, newInboxId } = await import('../src/config.ts');
  const config = {
    ...emptyConfig(),
    clients: {
      desktop: { provider: 'gmail', clientId: 'c', secretRef: 'gmail/client/desktop', addedAt: NOW },
    },
    inboxes: {
      'acme/gmail': {
        id: newInboxId(),
        provider: 'gmail',
        email: 'jo@example.test',
        identity: 'oidc' as const,
        client: 'desktop',
        tier: 'read',
        contacts: false,
        grantedScopes: [],
        secretRef: 'gmail/token/acme',
        internalDomains: [],
        createdAt: NOW,
      },
    },
    accounts: {
      'acme/slack': {
        id: newAccountId(),
        platform: 'slack',
        workspace: 'T0001',
        userId: 'U0001',
        tier: 'read',
        grantedScopes: [],
        secretRef: 'slack/token/acme',
        createdAt: NOW,
      },
      // A second entry pointing at the same secret. Nothing should write that, which is why the dedup is here:
      // without a duplicate in the fixture the uniqueness assertion below passes whatever the code does.
      acmeAlias: {
        id: newAccountId(),
        platform: 'slack',
        workspace: 'T0001',
        userId: 'U0001',
        tier: 'read',
        grantedScopes: [],
        secretRef: 'slack/token/acme',
        createdAt: NOW,
      },
    },
  };

  const refs = secretRefsOf(config);
  assert.ok(refs.includes('slack/token/acme'), `a workspace token would be stranded: ${JSON.stringify(refs)}`);
  assert.ok(refs.includes('gmail/token/acme'));
  assert.ok(refs.includes('gmail/client/desktop'));
  // Deduplicated: two entries may legitimately share a ref, and moving it twice would report it twice.
  assert.equal(new Set(refs).size, refs.length);
});

test('a migration does not switch backends when a credential appeared or vanished while it copied', async () => {
  /*
   * The copy runs outside the config lock, so the configuration can change under it: a Slack sign-in storing a
   * new credential in the *old* backend, or a removal deleting one the copy already duplicated. Switching anyway
   * points the runtime at a backend missing the new credential, or holding one nothing names.
   *
   * Asserted on the decision rather than by running a migration, for the reason given at the top of this file:
   * the only other backend is the real keychain, and a test must never write to it.
   */
  const { migrationConflict, secretRefsOf } = await import('../src/cli.ts');
  const { parseConfig } = await import('../src/config.ts');
  const base = parseConfig(
    JSON.stringify({
      version: 1,
      secrets: { store: 'keychain' },
      accounts: {
        acme: {
          id: 'acc_AAAAAAAAAAAAAAAA',
          platform: 'slack',
          workspace: 'T1',
          userId: 'U1',
          tier: 'read',
          secretRef: 'slack/token/acc_AAAAAAAAAAAAAAAA',
          createdAt: '2026-09-22T12:00:00.000Z',
        },
      },
    }),
  );
  const copied = secretRefsOf(base);
  assert.equal(migrationConflict(base, 'keychain', copied), null, 'an unchanged config was refused');

  const added = structuredClone(base);
  added.accounts.zed = {
    ...(base.accounts.acme as NonNullable<typeof base.accounts.acme>),
    id: 'acc_ZZZZZZZZZZZZZZZZ',
    secretRef: 'slack/token/acc_ZZZZZZZZZZZZZZZZ',
  };
  assert.match(migrationConflict(added, 'keychain', copied) ?? '', /added or removed/);

  const removed = structuredClone(base);
  removed.accounts = {};
  assert.match(migrationConflict(removed, 'keychain', copied) ?? '', /added or removed/);

  const moved = structuredClone(base);
  moved.secrets = { store: 'file' };
  assert.match(migrationConflict(moved, 'keychain', copied) ?? '', /changed by something else/);
});

/**
 * An in-memory secret store for driving a real migration without a keychain.
 *
 * `failSet` writes and then throws, which is what a keychain timeout that landed anyway looks like from outside.
 * `failDelete` refuses every delete, which is what a keychain whose prompt is dismissed looks like.
 */
function memoryStore(
  kind: 'keychain' | 'file',
  options: { failSet?: string; failDelete?: boolean; deleteDelayMs?: number } = {},
) {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      kind,
      async get(ref: string) {
        return values.get(ref) ?? null;
      },
      async set(ref: string, value: string) {
        values.set(ref, value);
        if (options.failSet === ref) throw new Error('timed out waiting for the keychain');
      },
      async delete(ref: string) {
        if (options.deleteDelayMs) await new Promise((settle) => setTimeout(settle, options.deleteDelayMs));
        if (options.failDelete) throw new Error('the keychain said no');
        return values.delete(ref);
      },
      invalidate() {},
    },
  };
}

async function coreWithTwoSlackTokens() {
  const { openCore } = await import('../src/core.ts');
  const dir = tempDir();
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir } });
  const account = (id: string) => ({
    id,
    platform: 'slack',
    workspace: 'T1',
    userId: `U-${id}`,
    tier: 'read',
    grantedScopes: [] as string[],
    secretRef: `slack/token/${id}`,
    createdAt: '2026-09-22T12:00:00.000Z',
  });
  await core.config.update((c) => ({
    ...c,
    secrets: { store: 'file' },
    accounts: { 'one/slack': account('acc_AAAAAAAAAAAAAAAA'), 'two/slack': account('acc_BBBBBBBBBBBBBBBB') },
  }));
  const source = await core.secrets('file');
  await source.set('slack/token/acc_AAAAAAAAAAAAAAAA', 'fake-token-one');
  await source.set('slack/token/acc_BBBBBBBBBBBBBBBB', 'fake-token-two');
  return { core, source };
}

test('a migration whose copy throws after landing takes that copy back', async () => {
  /*
   * A copy was tracked only once `set` returned, so a write that threw after landing — a keychain timeout that
   * finished anyway — was a copy nobody would ever clean up: a live credential in a backend nothing reads.
   */
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain', { failSet: 'slack/token/acc_BBBBBBBBBBBBBBBB' });

  await assert.rejects(migrateSecrets(core, 'keychain', { source, target: target.store }), /timed out/);
  assert.equal(target.values.size, 0, `copies were left in the target: ${[...target.values.keys()].join(', ')}`);
  assert.equal((await core.config.load()).secrets?.store, 'file', 'the backend was switched after a failed copy');
  assert.equal(await source.get('slack/token/acc_AAAAAAAAAAAAAAAA'), 'fake-token-one', 'an original was lost');
});

test('a migration that cannot take its copies back says which ones, instead of failing quietly', async () => {
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain', { failSet: 'slack/token/acc_BBBBBBBBBBBBBBBB', failDelete: true });

  await assert.rejects(migrateSecrets(core, 'keychain', { source, target: target.store }), (error: CommsError) => {
    const leftovers = (error.details?.leftovers ?? []) as { backend: string; ref: string }[];
    assert.deepEqual(leftovers.map((l) => l.ref).sort(), [
      'slack/token/acc_AAAAAAAAAAAAAAAA',
      'slack/token/acc_BBBBBBBBBBBBBBBB',
    ]);
    assert.ok(leftovers.every((l) => l.backend === 'keychain'));
    assert.match(error.hint ?? '', /Copies were left in keychain/);
    return true;
  });
});

test('a migration that switched but could not remove an original reports it rather than calling it done', async () => {
  /*
   * The originals are duplicates once the switch has happened, and `catch(() => false)` used to drop every
   * failure to remove them under a result that said the migration had simply worked.
   */
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core } = await coreWithTwoSlackTokens();
  const stubborn = memoryStore('file', { failDelete: true });
  stubborn.values.set('slack/token/acc_AAAAAAAAAAAAAAAA', 'fake-token-one');
  stubborn.values.set('slack/token/acc_BBBBBBBBBBBBBBBB', 'fake-token-two');
  const target = memoryStore('keychain');

  const result = await migrateSecrets(core, 'keychain', { source: stubborn.store, target: target.store });
  assert.equal(result.moved, 2);
  assert.equal((await core.config.load()).secrets?.store, 'keychain');
  assert.deepEqual(result.leftovers.map((l) => `${l.backend}:${l.ref}`).sort(), [
    'file:slack/token/acc_AAAAAAAAAAAAAAAA',
    'file:slack/token/acc_BBBBBBBBBBBBBBBB',
  ]);
  // Announced before the switch, then recorded as a failure with how many were left, so it outlives the terminal.
  const migrations = (await core.audit.tail({})).filter((e) => e.operation === 'secrets.migrate');
  assert.deepEqual(
    migrations.map((e) => `${e.outcome}: ${e.reason}`),
    [
      'started: file → keychain: switching, 2 copied',
      'failed: file → keychain: 2 moved, 2 left behind in a backend nothing reads',
    ],
  );
});

test('a clean migration moves everything and leaves nothing behind', async () => {
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain');
  // The line written before the switch has to reach the disk before the switch does: a power cut must not be able
  // to keep the change and lose its record.
  const durability: Array<[string, boolean]> = [];
  const append = core.audit.append.bind(core.audit);
  core.audit.append = (record, options) => {
    durability.push([record.outcome, options?.durable === true]);
    return append(record, options);
  };

  const result = await migrateSecrets(core, 'keychain', { source, target: target.store });
  assert.equal(result.moved, 2);
  assert.deepEqual(result.leftovers, []);
  assert.equal(target.values.get('slack/token/acc_AAAAAAAAAAAAAAAA'), 'fake-token-one');
  assert.equal(await source.get('slack/token/acc_AAAAAAAAAAAAAAAA'), null, 'an original was left in the old backend');
  const migrations = (await core.audit.tail({})).filter((e) => e.operation === 'secrets.migrate');
  assert.deepEqual(
    migrations.map((e) => `${e.outcome}: ${e.reason}`),
    ['started: file → keychain: switching, 2 copied', 'ok: file → keychain: 2 moved'],
  );
  assert.deepEqual(durability, [
    ['started', true],
    ['ok', false],
  ]);
  // One migration, two lines, tied by an id — other lines, including another migration's, can sit between them.
  assert.ok(String(migrations[0]?.ids?.migration).startsWith('mg_'));
  assert.equal(migrations[0]?.ids?.migration, migrations[1]?.ids?.migration);
});

test('a migration that cannot record itself does not switch, and a retry records it', async () => {
  /*
   * The record used to be written after the switch. When the append failed, the command reported failure over a
   * migration that had happened, and a retry found the backend already switched and returned early — so the move
   * was never recorded. It is written before the switch now, and a failure to write it stops the switch.
   */
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain');
  const append = core.audit.append.bind(core.audit);
  core.audit.append = async () => {
    throw new Error('the audit log is on a full disk');
  };
  await assert.rejects(migrateSecrets(core, 'keychain', { source, target: target.store }), /full disk/);
  assert.equal(secretsStoreOf(await core.config.load()), 'file', 'nothing was switched');
  assert.equal(target.values.size, 0, 'and the copies were taken back');
  assert.equal(await source.get('slack/token/acc_AAAAAAAAAAAAAAAA'), 'fake-token-one', 'the originals are untouched');

  core.audit.append = append;
  const retried = await migrateSecrets(core, 'keychain', { source, target: target.store });
  assert.equal(retried.moved, 2);
  const migrations = (await core.audit.tail({})).filter((e) => e.operation === 'secrets.migrate');
  assert.equal(migrations[0]?.reason, 'file → keychain: switching, 2 copied');
});

test('a switch refused after it was announced is recorded as failed', async () => {
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain');
  const update = core.config.update.bind(core.config);
  core.config.update = (async () => {
    throw new CommsError('TRANSIENT', 'something else changed the configuration');
  }) as typeof core.config.update;
  await assert.rejects(migrateSecrets(core, 'keychain', { source, target: target.store }), /something else changed/);
  core.config.update = update;
  const migrations = (await core.audit.tail({})).filter((e) => e.operation === 'secrets.migrate');
  assert.deepEqual(
    migrations.map((e) => `${e.outcome}: ${e.reason}`),
    ['started: file → keychain: switching, 2 copied', 'failed: file → keychain: not switched'],
  );
});

test('a migration whose switch committed but whose lock release failed keeps the new backend’s copies', async () => {
  /*
   * `ConfigStore.update` writes atomically and releases its lock in a `finally`; a release that throws rejects
   * the call with the switch already in. The rollback treated every rejection as "nothing was switched" and
   * deleted the copies — the credentials the runtime now reads.
   */
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core, source } = await coreWithTwoSlackTokens();
  const target = memoryStore('keychain');
  const update = core.config.update.bind(core.config);
  core.config.update = (async (...args: Parameters<typeof update>) => {
    await update(...args);
    throw new Error('EPERM: could not remove the lock file');
  }) as typeof core.config.update;

  const result = await migrateSecrets(core, 'keychain', { source, target: target.store });
  assert.equal((await core.config.load()).secrets?.store, 'keychain');
  assert.equal(target.values.get('slack/token/acc_AAAAAAAAAAAAAAAA'), 'fake-token-one', 'the live copy was deleted');
  assert.equal(target.values.get('slack/token/acc_BBBBBBBBBBBBBBBB'), 'fake-token-two', 'the live copy was deleted');
  assert.equal(result.moved, 2);
  assert.equal(await source.get('slack/token/acc_AAAAAAAAAAAAAAAA'), null, 'the original was not tidied up');
});

test('two opposite migrations at once cannot leave a credential in neither backend', async () => {
  /*
   * Reproduced by review, entirely in memory: A (file → keychain) switches, then cleans its originals out of the
   * file store; B (keychain → file) starts after A's switch and copies back into the file store. A's cleanup then
   * deletes what B just verified, B switches to file, and B cleans the keychain out. The active backend is file,
   * and the credential is in neither.
   *
   * A's cleanup is slowed so that interleaving happens reliably whenever nothing serialises the two. With the
   * credentials lock, B waits for A to finish entirely, reads the backend A left, and moves everything back.
   */
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core } = await coreWithTwoSlackTokens();
  // keychain → file is a loosening, which the command gets a person's consent for; B carries that consent here.
  const downgrade = { kind: 'loosening-consent', paths: ['secrets.store'] } as const;
  const file = memoryStore('file', { deleteDelayMs: 150 });
  const keychain = memoryStore('keychain');
  file.values.set('slack/token/acc_AAAAAAAAAAAAAAAA', 'fake-token-one');
  file.values.set('slack/token/acc_BBBBBBBBBBBBBBBB', 'fake-token-two');

  const a = migrateSecrets(core, 'keychain', { source: file.store, target: keychain.store });
  // Start B only once A has switched, which is the window the race needs.
  for (let i = 0; i < 200 && (await core.config.load()).secrets?.store !== 'keychain'; i += 1) {
    await new Promise((settle) => setTimeout(settle, 5));
  }
  const b = migrateSecrets(core, 'file', { source: keychain.store, target: file.store }, downgrade);
  await Promise.all([a, b]);

  assert.equal((await core.config.load()).secrets?.store, 'file');
  assert.equal(
    file.values.get('slack/token/acc_AAAAAAAAAAAAAAAA'),
    'fake-token-one',
    'a credential is in neither backend',
  );
  assert.equal(
    file.values.get('slack/token/acc_BBBBBBBBBBBBBBBB'),
    'fake-token-two',
    'a credential is in neither backend',
  );
});

test('moving credentials out of the keychain needs consent, and with it goes through', async () => {
  // `doctor` recommends `agentcomms secrets migrate --to file` when the keychain is unavailable, and it never
  // worked: the switch was refused as unconsented every time, after every credential had been copied.
  const { migrateSecrets } = await import('../src/cli.ts');
  const { core } = await coreWithTwoSlackTokens();
  // Keychain-backed, as most installs are. Into the keychain is a tightening, so this needs no consent itself.
  await core.config.update((c) => ({ ...c, secrets: { store: 'keychain' } }));
  const keychain = memoryStore('keychain');
  const file = memoryStore('file');
  keychain.values.set('slack/token/acc_AAAAAAAAAAAAAAAA', 'fake-token-one');
  keychain.values.set('slack/token/acc_BBBBBBBBBBBBBBBB', 'fake-token-two');

  // Refused under the lock before either store is opened — so a command that asked nobody, because its own earlier
  // read found nothing to loosen, still cannot start copying. Stores that fail on any touch prove it.
  const untouchable = (kind: 'keychain' | 'file') => {
    const touched = () => {
      throw new Error(`the ${kind} store was touched`);
    };
    return { kind, get: touched, set: touched, delete: touched, invalidate: () => {} };
  };
  await assert.rejects(
    migrateSecrets(core, 'file', { source: untouchable('keychain'), target: untouchable('file') }),
    (error: CommsError) => error.code === 'LOOSENING_REFUSED',
  );
  assert.equal(secretsStoreOf(await core.config.load()), 'keychain', 'nothing was switched');

  const moved = await migrateSecrets(
    core,
    'file',
    { source: keychain.store, target: file.store },
    {
      kind: 'loosening-consent',
      paths: ['secrets.store'],
    },
  );
  assert.equal(moved.moved, 2);
  assert.deepEqual(moved.leftovers, []);
  assert.equal(secretsStoreOf(await core.config.load()), 'file');
  assert.equal(file.values.get('slack/token/acc_AAAAAAAAAAAAAAAA'), 'fake-token-one');
  assert.equal(keychain.values.size, 0, 'and the keychain no longer holds them');
});

test('secrets migrate --to file is refused to an agent and to anything without a terminal, before copying', () => {
  // A config that holds a credential, so choosing files really does loosen something. Both runs are refused before
  // any store is opened, so neither can touch the real keychain.
  const config = tempDir();
  writeFileSync(
    join(config, 'config.json'),
    `${JSON.stringify({
      version: 2,
      accounts: {
        'acme/slack': {
          id: 'acc_AAAAAAAAAAAAAAAA',
          platform: 'slack',
          workspace: 'T0001',
          userId: 'U0001',
          tier: 'read',
          secretRef: 'slack/token/acc_AAAAAAAAAAAAAAAA',
          createdAt: NOW,
        },
      },
    })}\n`,
  );
  const agent = run(['secrets', 'migrate', '--to', 'file', '--json'], {
    AGENT_COMMS_CONFIG_DIR: config,
    CLAUDECODE: '1',
  });
  assert.equal(agent.status, 10, agent.stderr);
  assert.match(JSON.parse(agent.stdout).error.message, /not an agent's to do/);
  assert.match(JSON.parse(agent.stdout).error.hint, /in their own terminal/);

  const piped = run(['secrets', 'migrate', '--to', 'file', '--json'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(piped.status, 10, piped.stderr);
  assert.match(JSON.parse(piped.stdout).error.message, /needs a terminal/);
  assert.equal(
    JSON.parse(readFileSync(join(config, 'config.json'), 'utf8')).secrets,
    undefined,
    'nothing was switched',
  );
});

/** A version-1 config with two mailboxes and a workspace, as a machine had before the rename. */
function beforeTheRename(dir: string): void {
  const inbox = (id: string, email: string) => ({
    id,
    provider: 'gmail',
    email,
    identity: 'oidc' as const,
    client: 'desktop',
    tier: 'read',
    secretRef: `gmail:refresh:${id}`,
    createdAt: NOW,
  });
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify({
      version: 1,
      inboxes: {
        work: inbox('ibx_AAAAAAAAAAAAAAAA', 'jo@example.test'),
        gmail: inbox('ibx_BBBBBBBBBBBBBBBB', 'jo@gmail.test'),
      },
      accounts: {
        live: {
          id: 'acc_AAAAAAAAAAAAAAAA',
          platform: 'slack',
          workspace: 'T0001',
          userId: 'U0001',
          tier: 'read',
          secretRef: 'slack/token/acc_AAAAAAAAAAAAAAAA',
          createdAt: NOW,
        },
      },
    })}\n`,
  );
}

test('doctor says a version-1 config can be migrated, and stops saying it once it has been', () => {
  const config = tempDir();
  beforeTheRename(config);
  // The first line is the report; a failing check (the keychain, in a sandbox) adds an error envelope after it.
  const names = (out: string) =>
    JSON.parse(out.split('\n')[0] ?? '').data.checks.find((check: { name: string }) => check.name === 'account names');

  const before = names(run(['doctor', '--json'], { AGENT_COMMS_CONFIG_DIR: config }).stdout);
  assert.equal(before.ok, true, 'a version-1 config is not a problem, so this never fails doctor on its own');
  assert.match(before.fix, /names migrate --dry-run/);
  assert.match(before.fix, /0\.2\.0/, 'and says what everything sharing the config has to be on first');

  run(['names', 'migrate', '--yes'], { AGENT_COMMS_CONFIG_DIR: config });
  const after = names(run(['doctor', '--json'], { AGENT_COMMS_CONFIG_DIR: config }).stdout);
  assert.equal(after.detail, 'organisation/platform');
  assert.equal(after.fix, undefined, 'said until it is done, not for ever');

  // A config nobody can read says nothing about its names — least of all that they have already been migrated.
  const broken = tempDir();
  writeFileSync(join(broken, 'config.json'), '{ not json\n');
  const unknown = names(run(['doctor', '--json'], { AGENT_COMMS_CONFIG_DIR: broken }).stdout);
  assert.match(unknown.detail, /unknown/);
  assert.equal(unknown.fix, undefined, 'and offers no migration for a file it could not read');
});

test('names migrate --dry-run prints the mapping and changes nothing', () => {
  const config = tempDir();
  beforeTheRename(config);
  const dry = run(['names', 'migrate', '--dry-run'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /work\s+→\s+work\/gmail/);
  assert.match(dry.stdout, /live\s+→\s+live\/slack/);
  assert.match(dry.stdout, /Nothing was changed/);
  assert.equal(JSON.parse(readFileSync(join(config, 'config.json'), 'utf8')).version, 1, 'still version 1');
});

test('names migrate needs --yes where nobody can answer, and then renames everything once', () => {
  const config = tempDir();
  beforeTheRename(config);
  const refused = run(['names', 'migrate'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(refused.status, 64, refused.stderr);
  assert.match(refused.stderr, /--yes or a terminal/);
  assert.equal(JSON.parse(readFileSync(join(config, 'config.json'), 'utf8')).version, 1);

  const done = run(['names', 'migrate', '--yes', '--rename', 'gmail=personal/gmail', '--rename', 'live=cue/slack'], {
    AGENT_COMMS_CONFIG_DIR: config,
  });
  assert.equal(done.status, 0, done.stderr);
  // The mapping is shown before the write, `--yes` included: it is the only record of the old names afterwards.
  assert.match(done.stderr, /gmail\s+→\s+personal\/gmail/);
  assert.match(done.stdout, /Renamed 3 account\(s\)/);
  const written = JSON.parse(readFileSync(join(config, 'config.json'), 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(Object.keys(written.inboxes).sort(), ['personal/gmail', 'work/gmail']);
  assert.deepEqual(Object.keys(written.accounts), ['cue/slack']);
  assert.deepEqual(written.formerNames.inboxes.gmail, { name: 'personal/gmail', id: 'ibx_BBBBBBBBBBBBBBBB' });

  // Running it again says so, and changes nothing.
  const again = run(['names', 'migrate', '--yes'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already organisation\/platform/);

  // And the names it replaced are refused with what they are called now.
  const old = run(['audit', 'tail', '--inbox', 'gmail', '--json'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(old.status, 66);
  assert.match(JSON.parse(old.stdout).error.message, /"gmail" was renamed to "personal\/gmail"/);
});

test('names migrate lists every problem at once, and applies none of them', () => {
  const config = tempDir();
  beforeTheRename(config);
  const refused = run(
    ['names', 'migrate', '--yes', '--rename', 'work=cue/slack', '--rename', 'nope=x/gmail', '--json'],
    {
      AGENT_COMMS_CONFIG_DIR: config,
    },
  );
  assert.equal(refused.status, 64);
  const problems = JSON.parse(refused.stdout).error.details.problems as string[];
  assert.equal(problems.length, 1, problems.join(' | '));
  assert.ok(
    problems.some((p) => /ends in \/slack, but this is a gmail account/.test(p)),
    problems.join(' | '),
  );
  assert.equal(JSON.parse(readFileSync(join(config, 'config.json'), 'utf8')).version, 1);
  assert.deepEqual(
    readdirSync(config).filter((f) => f.includes('before-names-migrate')),
    [],
    'and backs nothing up',
  );
});

test('names migrate runs one mapping on a computer that has only some of its names, and saves the old file', () => {
  const config = tempDir();
  beforeTheRename(config);
  const before = readFileSync(join(config, 'config.json'), 'utf8');
  // One mapping for every computer: this one has `work`, `gmail` and `live`, and none of the other two.
  const mapping = [
    '--rename',
    'gmail=personal/gmail',
    '--rename',
    'elsewhere=acme/gmail',
    '--rename',
    'live=cue/slack',
    '--rename',
    'account:other=rgc/slack',
  ];

  const dry = run(['names', 'migrate', '--dry-run', ...mapping], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /gmail\s+→\s+personal\/gmail/);
  assert.match(dry.stdout, /Not applicable here/);
  assert.match(dry.stdout, /--rename elsewhere=acme\/gmail/);
  assert.match(dry.stdout, /--rename account:other=rgc\/slack/);
  assert.equal(readFileSync(join(config, 'config.json'), 'utf8'), before, 'a dry run writes nothing');
  assert.deepEqual(
    readdirSync(config).filter((f) => f.includes('before-names-migrate')),
    [],
    'and backs nothing up',
  );

  const done = run(['names', 'migrate', '--yes', '--json', ...mapping], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(done.status, 0, done.stderr);
  // The skipped renames are shown with the mapping, before the write, as well as returned.
  assert.match(done.stderr, /--rename elsewhere=acme\/gmail/);
  const data = JSON.parse(done.stdout).data;
  assert.equal(data.status, 'migrated');
  assert.deepEqual(
    data.notApplicable.map((skipped: { source: string }) => skipped.source),
    ['elsewhere', 'account:other'],
  );
  assert.match(data.backup, /config\.json\.before-names-migrate-\d{8}T\d{6}Z$/);
  assert.equal(dirname(data.backup), config);
  assert.equal(readFileSync(data.backup, 'utf8'), before, 'the file as it was, byte for byte');
  if (process.platform !== 'win32') assert.equal(statSync(data.backup).mode & 0o777, 0o600);
  const written = JSON.parse(readFileSync(join(config, 'config.json'), 'utf8'));
  assert.deepEqual(Object.keys(written.inboxes).sort(), ['personal/gmail', 'work/gmail']);
  assert.deepEqual(Object.keys(written.accounts), ['cue/slack']);

  // The text form says where the copy is, too.
  const other = tempDir();
  beforeTheRename(other);
  const text = run(['names', 'migrate', '--yes'], { AGENT_COMMS_CONFIG_DIR: other });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /The configuration as it was is saved at .*config\.json\.before-names-migrate-/);
});

test('an agent is never asked, even with a terminal: it can answer its own question', () => {
  const terminal = {
    stdout: { isTTY: true },
    stderr: { isTTY: true },
    stdin: { isTTY: true },
  } as unknown as Streams;
  assert.equal(needsYes({}, terminal, {}), false, 'a person at a terminal is asked');
  assert.equal(needsYes({ CLAUDECODE: '1' }, terminal, {}), true, 'an agent must pass --yes');
  assert.equal(needsYes({}, terminal, { json: true }), true, '--json is never interactive');
  const piped = { ...terminal, stdin: { isTTY: false } } as unknown as Streams;
  assert.equal(needsYes({}, piped, {}), true, 'a pipe cannot answer');
});

test('requirePerson refuses an agent before it asks about a terminal, and names the command either way', async () => {
  const { requirePerson } = await import('../src/cli-runtime.ts');
  const gate = {
    refusedToAgent: 'not an agent’s to do',
    refusedWithoutTerminal: 'needs a terminal',
    command: 'agentcomms do-the-thing',
    prompt: 'This does the thing.',
    color: false,
  };
  const quiet = {
    stdin: { isTTY: false },
    stdout: { isTTY: false, write: () => true },
    stderr: { isTTY: false, write: () => true },
  } as unknown as Streams;

  // An agent at a real terminal is still refused: the marker is checked first, and a challenge an agent can type
  // proves nothing.
  const tty = {
    stdin: { isTTY: true },
    stdout: { isTTY: true, write: () => true },
    stderr: { isTTY: true, write: () => true },
  } as unknown as Streams;
  await assert.rejects(requirePerson({ CLAUDECODE: '1' }, tty, gate), (error: CommsError) => {
    assert.equal(error.code, 'LOOSENING_REFUSED');
    assert.equal(error.message, 'not an agent’s to do');
    assert.equal(error.hint, 'Ask the user to run `agentcomms do-the-thing` in their own terminal.');
    assert.deepEqual(error.details, { marker: 'CLAUDECODE' });
    return true;
  });

  await assert.rejects(requirePerson({}, quiet, gate), (error: CommsError) => {
    assert.equal(error.message, 'needs a terminal');
    assert.equal(error.hint, 'Run `agentcomms do-the-thing` directly in a terminal.');
    return true;
  });
});

test('approve is refused to an agent and to anything without a terminal, touches nothing, and says so in the audit', async () => {
  const { openCore } = await import('../src/core.ts');
  const { prepareChange } = await import('../src/changes.ts');
  const config = tempDir();
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: config, HOME: config } });
  const before = await core.config.load();
  const after = structuredClone(before);
  after.defaults.riskEscalation = false;
  const { approvalId } = await prepareChange(
    core,
    { before, after, summary: 'Stop raising risky sends' },
    { surface: 'mcp' },
  );

  const agent = run(['approve', approvalId, '--json'], { AGENT_COMMS_CONFIG_DIR: config, CLAUDECODE: '1' });
  assert.equal(agent.status, 10, agent.stderr);
  const refusal = JSON.parse(agent.stdout).error;
  assert.equal(refusal.code, 'LOOSENING_REFUSED');
  assert.equal(refusal.message, 'only a person can approve a change, not an agent');
  assert.equal(refusal.hint, `Ask the user to run \`agentcomms approve ${approvalId}\` in their own terminal.`);

  const piped = run(['approve', approvalId], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(piped.status, 10, piped.stderr);
  assert.match(piped.stderr, /approving a change needs an interactive terminal/);
  assert.match(piped.stderr, new RegExp(`Run \`agentcomms approve ${approvalId}\` directly in a terminal`));

  const record = await core.approvals.get(approvalId);
  assert.equal(record?.state, 'pending');
  assert.equal(record?.challengeHash, undefined, 'no code was issued to either');
  const refused = (await core.audit.tail()).filter((line) => line.operation === 'change.approve');
  assert.deepEqual(
    refused.map((line) => [line.outcome, line.surface, line.policy, line.approvalId]),
    [
      ['refused', 'cli', 'chat', approvalId],
      ['refused', 'cli', 'chat', approvalId],
    ],
  );
  assert.match(refused[0]?.reason ?? '', /not an agent/);

  const noId = run(['approve', '--json'], { AGENT_COMMS_CONFIG_DIR: config });
  assert.equal(noId.status, 64);
  assert.match(run(['--help']).stdout, /agentcomms approve <approvalId>/);
});
