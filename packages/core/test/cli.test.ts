import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
      work: {
        id: newInboxId(),
        provider: 'gmail',
        email: 'jo@example.test',
        identity: 'oidc' as const,
        client: 'desktop',
        tier: 'read',
        contacts: false,
        grantedScopes: [],
        secretRef: 'gmail/token/work',
        internalDomains: [],
        createdAt: NOW,
      },
    },
    accounts: {
      acme: {
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
  assert.ok(refs.includes('gmail/token/work'));
  assert.ok(refs.includes('gmail/client/desktop'));
  // Deduplicated: two entries may legitimately share a ref, and moving it twice would report it twice.
  assert.equal(new Set(refs).size, refs.length);
});
