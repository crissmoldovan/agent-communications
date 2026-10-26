import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import { homeForDiscovery, NO_REAL_HOME_VARIABLE, resolvePaths } from '../src/paths.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The real-home guard (the second look at 0.33.0): a test that started the event service without a temporary home read
 * the person's claude-stream relay token into memory. Under the test preload, looking for user state under the
 * account's own home fails loudly; a temporary home is what it says. Every check here compares paths: nothing under
 * the real home is read, and each refusal this file causes on purpose is taken back from the count the preload reads.
 */

const ATTEMPTS = Symbol.for('agentcomms.test.real-home-attempts.v1');
const REAL = userInfo().homedir;
const PRELOAD = fileURLToPath(new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url));
const PATHS = fileURLToPath(new URL('../src/paths.ts', import.meta.url));

/** Takes back the refusals this test caused on purpose, so the preload's exit check sees only the ones nobody meant. */
function taken(): string[] {
  const store = globalThis as unknown as Record<symbol, string[] | undefined>;
  return store[ATTEMPTS]?.splice(0) ?? [];
}

const refused = (what: RegExp) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /would have been looked for in the account's real home folder/u);
  assert.match(error.message, what);
  return true;
};

test('REAL-HOME: the test preload turns the guard on', () => {
  assert.equal(process.env[NO_REAL_HOME_VARIABLE], '1');
});

test('REAL-HOME: the account’s own home is refused for user state; a temporary one is what it says', () => {
  const home = tempDir('comms-home-');
  assert.equal(homeForDiscovery(home, 'a test folder'), home);
  assert.throws(() => homeForDiscovery(REAL, 'a test folder'), refused(/a test folder/u));
  assert.throws(() => homeForDiscovery(`${REAL}/`, 'a test folder'), refused(/a test folder/u));
  // The apps' MCP configs: an environment that names no home falls back to the account's.
  assert.throws(() => knownClientConfigs({}), refused(/the apps' MCP configs/u));
  assert.ok(knownClientConfigs({ HOME: home, USERPROFILE: home }).every((file) => file.path.startsWith(home)));
  // Agent Comms' own folders, derived from the account's home, and the same pinned or under a temporary home.
  assert.throws(() => resolvePaths({ env: {} }), refused(/Agent Comms' own folders/u));
  assert.equal(resolvePaths({ env: { HOME: home, USERPROFILE: home } }).configDir.startsWith(home), true);
  const pinned = { AGENT_COMMS_CONFIG_DIR: join(home, 'config'), AGENT_COMMS_DATA_DIR: join(home, 'data') };
  assert.equal(resolvePaths({ env: pinned }).secretsDir, join(home, 'config', 'secrets'));
  assert.deepEqual(taken(), ['a test folder', 'a test folder', "the apps' MCP configs", "Agent Comms' own folders"]);
});

test('REAL-HOME: outside tests the guard changes nothing', () => {
  const was = process.env[NO_REAL_HOME_VARIABLE];
  delete process.env[NO_REAL_HOME_VARIABLE];
  try {
    assert.equal(homeForDiscovery(REAL, 'a test folder'), REAL);
    assert.equal(homeForDiscovery(REAL, 'a test folder', { [NO_REAL_HOME_VARIABLE]: '0' }), REAL);
    // The environment given turns it on as well as this process's.
    assert.throws(
      () => homeForDiscovery(REAL, 'a test folder', { [NO_REAL_HOME_VARIABLE]: '1' }),
      refused(/a test folder/u),
    );
  } finally {
    process.env[NO_REAL_HOME_VARIABLE] = was;
  }
  assert.deepEqual(taken(), ['a test folder']);
});

test('REAL-HOME: a process that catches the refusal and goes on still fails, at exit, saying what it looked for', () => {
  const script = [
    "import { userInfo } from 'node:os';",
    `const { homeForDiscovery } = await import(${JSON.stringify(PATHS)});`,
    "try { homeForDiscovery(userInfo().homedir, 'a swallowed test folder'); } catch {}",
    "process.stdout.write('went on\\n');",
  ].join('\n');
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      PRELOAD,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--input-type=module',
      '-e',
      script,
    ],
    { encoding: 'utf8', env: { ...process.env, HOME: tempDir('comms-home-') } },
  );
  assert.equal(child.stdout, 'went on\n', child.stderr);
  assert.equal(child.status, 1, child.stderr);
  assert.match(
    child.stderr,
    /real-home guard: this process looked for a swallowed test folder in the account's real home/u,
  );
});
