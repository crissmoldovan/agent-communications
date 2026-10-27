// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { composeDraft, createWhatsAppMcpServer, PACKAGE_NAME, VERSION } from '@agentcomms/whatsapp';

/*
 * Everything the bin can reach is inside this consumer.
 *
 * HOME is a directory of the consumer's own, so the default WhatsApp store it looks for is one that is not there —
 * the check never comes near the real one — and `mcp install` reads no real client's configuration. The secret store
 * is pinned to files: this package never opens one, and a check that could reach the login keychain is one refactor
 * away from writing to it.
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

assert.equal(PACKAGE_NAME, '@agentcomms/whatsapp');
assert.match(VERSION, /^\d+\.\d+\.\d+/);

// The library entry builds a server with no account set up, and composes a draft that sends nothing.
const server = await createWhatsAppMcpServer({ env });
assert.equal(typeof server.connectStdio, 'function');
const draft = composeDraft({ to: '+15555550101', text: 'On my way' });
assert.equal(draft.sent, false);
assert.equal(draft.links?.web, 'https://wa.me/15555550101?text=On%20my%20way');

const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-whatsapp.cmd' : 'agent-whatsapp');

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

const status = JSON.parse(run('status', '--json').stdout);
assert.equal(status.ok, true);
assert.deepEqual(status.data.accounts, []);
assert.match(status.data.reads, /no network client/);
assert.match(status.data.sends, /^never/);
// What it says to run first is this installation's own add — the bin this consumer installed, under the Node that ran
// it — never a bare `agent-whatsapp`, which nothing put on PATH (CUE-403). On a Windows Node whose path needs quotes it
// is the words as JSON, to type.
const installedCli = realpathSync(join('node_modules', '@agentcomms', 'whatsapp', 'dist', 'cli.mjs'));
assert.ok(
  [installedCli, JSON.stringify(installedCli).slice(1, -1)].some((form) => status.data.setup.includes(form)),
  `status names the installed CLI to run: ${status.data.setup}`,
);
assert.doesNotMatch(status.data.setup, /(?:^|[\s`"])agent-whatsapp(?:\.cmd)?[\s`"]/i, status.data.setup);

/*
 * The server, as a client starts it: the packed bin, `mcp`, over stdio. Six tools, the read surface and the draft;
 * nothing that sends, and nothing that approves.
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
  assert.deepEqual(initialized.result.serverInfo, { name: 'agent-whatsapp', version: VERSION });
  sendMessage({ jsonrpc: '2.0', method: 'notifications/initialized' });
  sendMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const tools = await waitFor(2);
  assert.deepEqual(tools.result.tools.map((tool) => tool.name).sort(), [
    'whatsapp_chats',
    'whatsapp_draft',
    'whatsapp_read',
    'whatsapp_search',
    'whatsapp_status',
    'whatsapp_sync',
  ]);
} finally {
  child.stdin.end();
  child.kill();
}

// The entry `mcp install --launcher npx` writes runs the whole CLI, so it must say `mcp`. Nothing is written.
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
  `whatsapp consumer check: mcp initialize and tools/list over stdio OK, npx entry keeps \`mcp\` (${VERSION})`,
);
