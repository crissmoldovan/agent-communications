#!/usr/bin/env node
/**
 * Records the CLI JSON the UI tests read (`src/test/fixtures/*.json`), from this repository's built CLIs — run
 * `pnpm build` at the root first.
 *
 * Reads only, and never a doctor: each call here is one the app polls or lists with, run with the folders pinned to a
 * fresh temporary directory and HOME pointed at it, so it reads an empty installation and touches no real account,
 * keychain or home. Nothing it runs reaches the network: the update check is off, and every call is a local read.
 * What an empty installation cannot show — populated lists, every doctor, the update status, behaviour and standing
 * approvals, which this base does not have yet — is written by hand, with fake data, in the files this script leaves
 * alone.
 *
 *   node apps/desktop/scripts/record-fixtures.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../src/test/fixtures/', import.meta.url));

/** [fixture, package, words, shape]: the reads the app makes, as the allow-list builds them. */
const READS = [
  ['approvals-pending.empty', 'core', ['approvals', 'list', '--state', 'pending'], 'envelope'],
  ['label.empty', 'core', ['label'], 'envelope'],
  ['accounts-gmail.empty', 'gmail', ['inbox', 'list'], 'envelope'],
  ['accounts-slack.empty', 'slack', ['workspace', 'list'], 'envelope'],
  ['accounts-resend.empty', 'resend', ['account', 'list'], 'envelope'],
  ['events-status.not-running', 'events-daemon', ['status'], 'bare'],
];

const temp = mkdtempSync(join(tmpdir(), 'agent-comms-fixtures-'));
try {
  const pins = [
    ['--config-dir', join(temp, 'config')],
    ['--state-dir', join(temp, 'state')],
    ['--data-dir', join(temp, 'data')],
    ['--secrets-dir', join(temp, 'secrets')],
  ].flat();
  // A bare environment: no agent marker, no AGENT_COMMS_* folders, no token of any kind.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: temp,
    USERPROFILE: temp,
    TMPDIR: temp,
    NO_COLOR: '1',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  for (const [fixture, name, words, shape] of READS) {
    const entry = join(ROOT, 'packages', name, 'dist', 'cli.mjs');
    const stdout = execFileSync(process.execPath, [entry, ...words, '--json', ...pins], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    const value = JSON.parse(stdout);
    if (shape === 'envelope' && value.ok !== true) {
      throw new Error(`${name} ${words.join(' ')} answered ${stdout}`);
    }
    const data = shape === 'envelope' ? value.data : value;
    // The temporary folders are this run's, not anyone's: they are written as an example home.
    const text = JSON.stringify(data, null, 2).replaceAll(temp, '/example/home');
    writeFileSync(join(FIXTURES, `${fixture}.json`), `${text}\n`);
    process.stdout.write(`recorded ${fixture}\n`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
