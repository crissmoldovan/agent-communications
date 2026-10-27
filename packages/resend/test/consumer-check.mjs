// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createResendMcpServer, PACKAGE_NAME, ROUTES, VERSION } from '@agentcomms/resend';

/*
 * Everything the bin can reach is inside this consumer, and nothing here reaches Resend.
 *
 * `mcp install` reads every MCP client's config under the home directory, so with the caller's HOME it would read
 * the maintainer's real `~/.claude.json`. The secret store is pinned to the file backend before anything runs, and no
 * key is given — `RESEND_API_KEY` is taken out of the environment — so the one command that could ask Resend
 * anything, `account add`, is refused before it reads a key.
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
delete env.CODEX_HOME;
delete env.CLAUDE_CONFIG_DIR;
delete env.RESEND_API_KEY;

assert.equal(PACKAGE_NAME, '@agentcomms/resend');
assert.match(VERSION, /^\d+\.\d+\.\d+/);
// The route table is on the package's surface — knowing what it may call grants nothing. It writes two things only:
// one email, sent, and one scheduled email, cancelled.
assert.deepEqual(
  ROUTES.filter((route) => route.kind === 'write')
    .map((route) => route.name)
    .sort(),
  ['emails.cancel', 'emails.send'],
);

// The library entry must build a server with no account connected.
const server = await createResendMcpServer({ env });
assert.equal(typeof server.connectStdio, 'function');

/** `join`, not a '/'-joined literal: on Windows the shell resolves `node_modules\\.bin\\agent-resend.cmd`. */
const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-resend.cmd' : 'agent-resend');

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

const accounts = JSON.parse(run('account', 'list', '--json').stdout);
assert.equal(accounts.ok, true);
assert.deepEqual(accounts.data.accounts, []);

// A key is typed by a person at a terminal: with no terminal and no key, it is refused before anything is read.
const add = run('account', 'add', 'acme/resend', '--json');
assert.equal(add.status, 77, `account add without a terminal: ${add.stdout.slice(0, 400)}`);
// The command it hands a person is this installation's own (CUE-403): the packed bundle locates its package from where
// it runs, so the line names this Node and the installed `dist/cli.mjs`, never `agent-resend` by its bare name.
const handedOver = String(JSON.parse(add.stdout).error?.hint);
assert.match(handedOver, /@agentcomms[\\/]+resend[\\/]+dist[\\/]+cli\.mjs/, handedOver);
assert.doesNotMatch(handedOver, /(?:^|[\s`'"[])agent-resend(?:\.cmd)? /i, handedOver);

/*
 * The server, as a client starts it: the packed bin, `mcp`, over stdio.
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
      // Complete lines only: a `tools/list` answer is larger than one pipe chunk.
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
  assert.deepEqual(initialized.result.serverInfo, { name: 'agent-resend', version: VERSION });

  sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  const names = tools.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'resend_account_policy',
    'resend_account_remove',
    'resend_account_show',
    'resend_accounts_list',
    'resend_doctor',
    'resend_domains',
    'resend_email_show',
    'resend_emails_list',
    'resend_metrics',
    'resend_received_download',
    'resend_received_list',
    'resend_received_show',
    // The one that reaches people, through the approval gate the CLI uses. It does not approve.
    'resend_scheduled_cancel',
    'resend_scheduled_list',
    'resend_send_execute',
    'resend_send_prepare',
    'resend_send_status',
    // Where an approval stands, now or once it changes: it only looks.
    'resend_send_wait',
    'resend_suppressions',
    'resend_take',
    'resend_taken',
  ]);
  assert.ok(
    names.every((name) => !/approv/.test(name)),
    'no tool approves: under `confirm` that is a person at a terminal',
  );
  assert.ok(!names.includes('resend_account_add'), 'no tool takes a key: it would stay in the transcript');
} finally {
  child.stdin.end();
  child.kill();
}

/*
 * The entry `mcp install --launcher npx` writes runs the whole CLI, so it must say `mcp`. `--client json --print`
 * writes nothing and `--no-verify` starts nothing from the registry.
 */
const printed = run(
  'mcp',
  'install',
  '--client',
  'json',
  '--standalone',
  '--launcher',
  'npx',
  '--print',
  '--no-verify',
  '--json',
);
assert.equal(printed.status, 0, `mcp install --print failed: ${printed.stdout.slice(0, 400)}`);
const install = JSON.parse(printed.stdout);
assert.equal(install.ok, true);
assert.equal(install.data.applied, false, '--print must not write anything');
const args = install.data.entry.args;
assert.equal(args[0], '-y');
assert.equal(args[1], `${PACKAGE_NAME}@${VERSION}`, 'the npx entry pins exactly this version');
// Then this machine's four folders, pinned as options before the subcommand (CUE-403), then `mcp`.
assert.deepEqual(
  [args[2], args[4], args[6], args[8]],
  ['--config-dir', '--state-dir', '--data-dir', '--secrets-dir'],
  `the npx entry pins the four folders: ${JSON.stringify(args)}`,
);
for (const value of [args[3], args[5], args[7], args[9]]) assert.ok(isAbsolute(String(value)), JSON.stringify(args));
assert.equal(args[3], resolve(configDir), 'the folder it was installed for');
assert.equal(args[10], 'mcp', `the npx entry runs the CLI, so it must say \`mcp\`: ${JSON.stringify(args)}`);

console.log(
  `resend consumer check: library entry, agent-resend bin, no key without a terminal, mcp initialize and tools/list over stdio OK (${VERSION})`,
);
