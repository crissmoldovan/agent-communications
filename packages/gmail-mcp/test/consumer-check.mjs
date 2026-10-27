// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const version = JSON.parse(
  readFileSync(join('node_modules', '@agentcomms', 'gmail-mcp', 'package.json'), 'utf8'),
).version;

/** The directory Node finds `name` in when it is looked up from inside `from`, as a `require` there would. */
function packageRoot(name, from) {
  const found = createRequire(join(from, 'package.json'))
    .resolve.paths(name)
    .map((modules) => join(modules, name))
    .find((directory) => existsSync(join(directory, 'package.json')));
  assert.ok(found, `${name} is not installed where ${from} can find it`);
  return found;
}
const manifestAt = (directory) => JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));

/*
 * Gmail depends on core at runtime, pinned to its own version (design 2026-10-04, D4): a channel finds core's command
 * through the installed package. The verifier gave this project Gmail's and core's tarballs from this checkout and
 * refused every @agentcomms package from a registry, so the core found from inside Gmail is this release's — not the
 * copy of a version already out, which is what npm fetched while only Gmail's tarball was given to it.
 */
const gmailRoot = packageRoot('@agentcomms/gmail', process.cwd());
assert.equal(manifestAt(gmailRoot).version, version, 'the server and Gmail are one release');
assert.equal(manifestAt(gmailRoot).dependencies?.['@agentcomms/core'], version, 'Gmail pins its core exactly');
assert.equal(manifestAt(packageRoot('@agentcomms/core', gmailRoot)).version, version, 'the core Gmail finds');
const bin = join('node_modules', '.bin', process.platform === 'win32' ? 'agent-gmail-mcp.cmd' : 'agent-gmail-mcp');

/** Speaks MCP to the packed server over stdio: initialize, then tools/list. */
const child = spawn(bin, [], {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, AGENT_COMMS_CONFIG_DIR: process.env.AGENT_COMMS_CONFIG_DIR ?? process.cwd() },
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += String(chunk);
});

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const waitFor = (id) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${id}; stderr: ${stderr.slice(0, 400)}`)), 30_000);
    const check = () => {
      // **Complete lines only.** A pipe delivers whatever has arrived, and a `tools/list` answer carrying
      // twenty-nine tools and their descriptions is comfortably larger than one chunk — so the last element of
      // this split is a half-written message until the newline turns up. Parsing it threw a SyntaxError whose
      // text was the JSON fragment, which is what the failure looked like: a wall of tool definitions on stderr
      // and no clue what had gone wrong. Intermittent by nature, and therefore worse than a steady failure.
      const complete = stdout.slice(0, stdout.lastIndexOf('\n') + 1);
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        // The first byte on stdout must be a JSON message: anything else corrupts the protocol.
        assert.equal(line.trimStart()[0], '{', `stdout carried something that is not a message: ${line.slice(0, 120)}`);
        const message = JSON.parse(line);
        if (message.id === id) {
          clearTimeout(timer);
          child.stdout.off('data', check);
          resolve(message);
          return;
        }
      }
    };
    child.stdout.on('data', check);
    check();
  });

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'consumer-check', version } },
});
const initialized = await waitFor(1);
assert.equal(initialized.result.serverInfo.name, 'agent-gmail');
assert.equal(initialized.result.serverInfo.version, version);
assert.match(initialized.result.instructions, /untrusted-content/);

send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const tools = await waitFor(2);
const names = tools.result.tools.map((tool) => tool.name).sort();
assert.deepEqual(names, [
  'gmail_attachment_download',
  'gmail_attachments_find',
  'gmail_client_add',
  'gmail_client_remove',
  'gmail_clients_list',
  'gmail_confirm_client_add',
  'gmail_confirm_client_remove',
  'gmail_confirm_clients',
  'gmail_confirm_probe',
  'gmail_contacts_search',
  'gmail_doctor',
  'gmail_draft_create',
  'gmail_draft_delete',
  'gmail_draft_get',
  'gmail_draft_list',
  'gmail_draft_reply',
  'gmail_draft_send',
  'gmail_draft_update',
  'gmail_export',
  'gmail_followups',
  'gmail_inbox_add',
  'gmail_inbox_finish',
  'gmail_inbox_import',
  'gmail_inbox_policy',
  'gmail_inbox_reauth',
  'gmail_inbox_remove',
  'gmail_inbox_rename',
  'gmail_inbox_show',
  'gmail_inboxes_list',
  'gmail_label_create',
  'gmail_labels_list',
  'gmail_message_get',
  'gmail_organise',
  'gmail_organise_undo',
  'gmail_search',
  'gmail_send_cancel',
  'gmail_send_list',
  'gmail_send_prepare',
  // Where an approval stands, now or once it changes: it only looks.
  'gmail_send_wait',
  'gmail_sendas_list',
  'gmail_setup',
  'gmail_take',
  'gmail_taken',
  'gmail_thread_get',
  'gmail_thread_timeline',
  'gmail_trash',
  'gmail_whoami',
]);

child.stdin.end();
child.kill();
console.log(
  `gmail-mcp consumer check: Gmail and core ${version} installed, initialize and tools/list over stdio OK (${names.length} tools)`,
);
