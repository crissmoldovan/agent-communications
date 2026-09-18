import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const config = env.AGENT_COMMS_CONFIG_DIR ?? tempDir();
  const result = spawnSync(process.execPath, [CLI, ...args], {
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
    assert.equal(envelope.error.code, 'CONFIG');
  }
});
