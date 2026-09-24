// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createSlackMcpServer, PACKAGE_NAME, VERSION } from '@agentcomms/slack';

assert.equal(PACKAGE_NAME, '@agentcomms/slack');
assert.match(VERSION, /^\d+\.\d+\.\d+/);

// The library entry must build a server with no workspace connected, and without pulling in anything else.
const server = await createSlackMcpServer();
assert.equal(typeof server.connectStdio, 'function');

/*
 * `join`, not a '/'-joined literal.
 *
 * On Windows the shell resolves `node_modules\\.bin\\agent-slack.cmd`; handed forward slashes it finds nothing,
 * `execFileSync` throws, and the catch below turns that into an empty stdout — so the version assertion failed
 * with `'' !== '0.3.2'` and said nothing about the path. The Gmail consumer check has always used `join`.
 */
const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-slack.cmd' : 'agent-slack');

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

const workspaces = JSON.parse(run('workspace', 'list', '--json').stdout);
assert.equal(workspaces.ok, true);
assert.ok(Array.isArray(workspaces.data));

/*
 * The one thing worth asserting from outside the repository: a read-only install cannot be talked into posting,
 * and the way that is guaranteed is a closed method allowlist. A method nobody classified is unreachable, so a
 * future package that adds one without classifying it fails here rather than in somebody's workspace.
 */
const manifest = run('manifest', '--mode', 'read', '--port', '51234').stdout;
assert.doesNotMatch(manifest, /chat:write/, 'a read manifest asks for no posting scope');
assert.doesNotMatch(manifest, /incoming-webhook/, 'and never for a webhook, which posts with no scope at all');

const send = run('manifest', '--mode', 'send', '--port', '51234').stdout;
assert.match(send, /chat:write/, 'the send manifest is the one that asks');
