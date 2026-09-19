import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url));

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Starts the bin and closes its stdin, which is how a client ending a session looks to the server. */
function runBin(args: string[], { closeStdin = true } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', ENTRY, ...args],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENT_COMMS_CONFIG_DIR: '/tmp/agent-gmail-mcp-test' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
    if (closeStdin) child.stdin.end();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not exit; stderr: ${stderr.slice(0, 300)}`));
    }, 20_000);
    timer.unref();
  });
}

test('--help explains the options and writes nothing to stdout', async () => {
  const result = await runBin(['--help']);
  assert.equal(result.code, 0);
  // stdout belongs to the protocol, even when the process is only printing help.
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--inbox <alias>/);
  assert.match(result.stderr, /--read-only/);
});

test('the server exits when its client disconnects, rather than lingering', async () => {
  const result = await runBin([]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'a server that spoke to nobody must not print anything on stdout');
});

test('a pinned mailbox that does not exist fails at startup, not on the first call', async () => {
  const result = await runBin(['--inbox', 'missing']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /missing/);
});
