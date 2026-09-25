// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const version = JSON.parse(
  readFileSync(join('node_modules', '@agentcomms', 'gmail-mcp', 'package.json'), 'utf8'),
).version;
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
  'gmail_clients_list',
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
  'gmail_inbox_policy',
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
  'gmail_sendas_list',
  'gmail_setup',
  'gmail_thread_get',
  'gmail_thread_timeline',
  'gmail_trash',
  'gmail_whoami',
]);

child.stdin.end();
child.kill();
console.log(`gmail-mcp consumer check: initialize and tools/list over stdio OK (${names.length} tools)`);
