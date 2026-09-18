// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createGmailMcpServer, PACKAGE_NAME, VERSION } from '@cloudpixel/gmail';

assert.equal(PACKAGE_NAME, '@cloudpixel/gmail');
assert.match(VERSION, /^\d+\.\d+\.\d+/);

// The library entry must build a server without a configured mailbox, and without pulling in anything else.
const server = await createGmailMcpServer();
assert.equal(typeof server.connectStdio, 'function');
assert.equal(typeof server.close, 'function');
await server.close();

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-gmail.cmd' : 'agent-gmail');

/** Runs the bin and returns what it printed with the status it exited with: a refusal is an answer, not a crash. */
function run(...args) {
  try {
    return { status: 0, stdout: execFileSync(bin, args, { encoding: 'utf8', shell: process.platform === 'win32' }) };
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

const doctor = JSON.parse(run('doctor', '--json').stdout);
assert.equal(doctor.ok, true);
assert.ok(doctor.data.checks.some((check) => check.id === 'oauth-client'));

console.log('gmail consumer check: library entry, agent-gmail bin, envelopes and doctor OK');
