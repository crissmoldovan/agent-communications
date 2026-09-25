// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createSlackMcpServer, PACKAGE_NAME, VERSION } from '@agentcomms/slack';

/*
 * Everything the bin can reach is inside this consumer.
 *
 * `mcp install` reads every MCP client's config under the home directory to see what else is registered, so with the
 * caller's HOME it would read the maintainer's real `~/.claude.json`. And the secret store is pinned to the file
 * backend before anything runs: nothing here stores a secret, but a check that could reach the login keychain is one
 * refactor away from writing to it.
 */
const home = resolve('home');
const configDir = process.env.AGENT_COMMS_CONFIG_DIR ?? resolve('config');
mkdirSync(home, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2, secrets: { store: 'file' } })}\n`);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  AGENT_COMMS_CONFIG_DIR: configDir,
  AGENT_COMMS_DATA_DIR: join(home, 'data'),
  AGENT_COMMS_STATE_DIR: join(home, 'state'),
};
// These move where codex and Claude Code keep their configs, which the scan would then follow out of this consumer.
delete env.CODEX_HOME;
delete env.CLAUDE_CONFIG_DIR;

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

/*
 * The server, as a client starts it: the packed bin, `mcp`, over stdio.
 *
 * Everything above calls the library or one-shot commands, so a published package whose `mcp` subcommand failed to
 * start — a missing chunk, a stdout write before the first message — passed here and failed only in somebody's
 * client log. The Gmail MCP package has always been checked this way; Slack was not.
 */
const child = spawn(bin, ['mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env, shell: process.platform === 'win32' });
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const sendMessage = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const waitFor = (id) =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${id}; stderr: ${stderr.slice(0, 400)}`)), 30_000);
    const check = () => {
      // Complete lines only: a `tools/list` answer is larger than one pipe chunk. See the Gmail MCP consumer check.
      const complete = stdout.slice(0, stdout.lastIndexOf('\n') + 1);
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        assert.equal(line.trimStart()[0], '{', `stdout carried something that is not a message: ${line.slice(0, 120)}`);
        const message = JSON.parse(line);
        if (message.id === id) {
          clearTimeout(timer);
          child.stdout.off('data', check);
          resolvePromise(message);
          return;
        }
      }
    };
    child.stdout.on('data', check);
    check();
  });

try {
  sendMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'consumer-check', version: VERSION },
    },
  });
  const initialized = await waitFor(1);
  assert.deepEqual(initialized.result.serverInfo, { name: 'agent-slack', version: VERSION });

  sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  const names = tools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'slack_channels',
    'slack_doctor',
    // Local drafts only: none of the three reaches Slack.
    'slack_draft_delete',
    'slack_draft_get',
    'slack_draft_list',
    'slack_files',
    'slack_manifest',
    'slack_mode',
    'slack_mode_narrow',
    'slack_mode_request_send',
    'slack_people',
    'slack_post_prepare',
    // The three that reach people, each through the approval gate the CLI uses. None of them approves.
    'slack_post_send',
    'slack_react',
    'slack_react_send',
    'slack_read',
    'slack_search',
    'slack_thread',
    'slack_workspace_show',
    'slack_workspaces_list',
  ]);
  assert.ok(
    names.every((name) => !/approv/.test(name)),
    'no tool approves: under `confirm` that is a person at a terminal',
  );
} finally {
  child.stdin.end();
  child.kill();
}

/*
 * The entry `mcp install --launcher npx` writes must still say `mcp`.
 *
 * Slack's npx package is the whole CLI, not a server-only wrapper like Gmail's. The installer dropped the subcommand
 * for both, which is right for Gmail and made Slack's entry run the CLI: `unknown option '--workspace'`, exit 64,
 * in a client config it had already written. `--client json --print` writes nothing and `--no-verify` starts nothing
 * from the registry, so this reads the entry without installing anything.
 */
const printed = run('mcp', 'install', '--client', 'json', '--launcher', 'npx', '--print', '--no-verify', '--json');
assert.equal(printed.status, 0, `mcp install --print failed: ${printed.stdout.slice(0, 400)}`);
const install = JSON.parse(printed.stdout);
assert.equal(install.ok, true);
assert.equal(install.data.applied, false, '--print must not write anything');
const args = install.data.entry.args;
assert.equal(args[0], '-y');
assert.equal(args[1], `${PACKAGE_NAME}@${VERSION}`, 'the npx entry pins exactly this version');
assert.equal(args[2], 'mcp', `the npx entry runs the CLI, so it must say \`mcp\`: ${JSON.stringify(args)}`);

console.log(`slack consumer check: mcp initialize and tools/list over stdio OK, npx entry keeps \`mcp\` (${VERSION})`);
