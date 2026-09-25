// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGmailMcpServer, PACKAGE_NAME, VERSION } from '@agentcomms/gmail';

assert.equal(PACKAGE_NAME, '@agentcomms/gmail');
assert.match(VERSION, /^\d+\.\d+\.\d+/);

// The library entry must build a server without a configured mailbox, and without pulling in anything else.
const server = await createGmailMcpServer();
assert.equal(typeof server.connectStdio, 'function');
assert.equal(typeof server.close, 'function');
await server.close();

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-gmail.cmd' : 'agent-gmail');

/*
 * Everything the bin can reach is inside this consumer, as in Slack's check.
 *
 * `doctor` reads every MCP client's config to see what else is registered, so with the caller's HOME it read the
 * maintainer's real `~/.claude.json` — and it now reads the `.mcp.json` of each project listed there too.
 * `CODEX_HOME` and `CLAUDE_CONFIG_DIR` point that reading somewhere else again, so neither is passed on.
 */
const home = resolve('home');
mkdirSync(home, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
};
delete env.CODEX_HOME;
delete env.CLAUDE_CONFIG_DIR;

/** Runs the bin and returns what it printed with the status it exited with: a refusal is an answer, not a crash. */
function run(...args) {
  try {
    return {
      status: 0,
      stdout: execFileSync(bin, args, { encoding: 'utf8', env, shell: process.platform === 'win32' }),
    };
  } catch (error) {
    if (typeof error.status !== 'number') throw error;
    return { status: error.status, stdout: String(error.stdout ?? '') };
  }
}
assert.equal(run('--version').stdout.trim(), VERSION);
assert.match(run('--help').stdout, /Exit codes: 0 ok/);

const inboxes = JSON.parse(run('inbox', 'list', '--json').stdout);
assert.equal(inboxes.ok, true);
assert.deepEqual(inboxes.data, []);

// The documented exit codes have to survive packaging: they are what a script branches on.
const missing = run('inbox', 'show', 'nope', '--json');
assert.equal(missing.status, 66);
assert.equal(JSON.parse(missing.stdout).error.code, 'NOT_FOUND');

/*
 * The file secret store, before `doctor` runs. A fresh config defaults to the keychain, and `doctor` proves a
 * keychain works by writing, reading and deleting an item in it — so this check, run by `pnpm verify`, did that to
 * the real login keychain of whoever was verifying a release.
 */
const configDir = process.env.AGENT_COMMS_CONFIG_DIR;
assert.ok(configDir, 'verify-package runs this with its own config directory');
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);

const doctor = JSON.parse(run('doctor', '--json').stdout);
assert.equal(doctor.ok, true);
assert.ok(doctor.data.checks.some((check) => check.id === 'oauth-client'));
assert.equal(
  doctor.data.checks.find((check) => check.id === 'secret-store')?.detail,
  'owner-only files in the config directory',
);

console.log('gmail consumer check: library entry, agent-gmail bin, envelopes and doctor OK');
