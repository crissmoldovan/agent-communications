// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status } from '@agentcomms/events-daemon';

assert.deepEqual(await status(), { owner: 'not-running' });
const dist = dirname(fileURLToPath(import.meta.resolve('@agentcomms/events-daemon')));
const cli = join(dist, 'cli.mjs');
const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const result = execFileSync(process.execPath, [cli, '--json', 'status'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.match(help, /Usage: agent-events/);
assert.equal(result, '{"owner":"not-running"}\n');

function startMcp(command, args, env) {
  const child = spawn(process.execPath, [command, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter !== undefined) {
        pending.delete(message.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
    }
  });
  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP request ${method} did not finish: ${stderr}`));
        }, 5_000);
        pending.set(id, { resolve, timeout });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    async close() {
      child.stdin.end();
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(null), 5_000))]);
      if (code === null) {
        child.kill('SIGTERM');
        await exited.catch(() => undefined);
        throw new Error(`MCP process did not exit: ${stderr}`);
      }
      assert.equal(code, 0, stderr);
    },
  };
}

if (process.platform !== 'win32') {
  // `/tmp` stays short after macOS resolves its per-user temporary-directory symlink; the control socket has 103 bytes.
  const root = await mkdtemp(join('/tmp', 'events-daemon-consumer-'));
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const env = {
    ...process.env,
    AGENT_COMMS_STATE_DIR: stateDir,
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_UPDATE_CHECK: 'off',
    NO_COLOR: '1',
  };
  let stderr = '';
  const owner = spawn(process.execPath, [cli, '--state-dir', stateDir, 'run'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  owner.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('exit', (code) => resolve(code));
  });
  const running = async () => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const output = execFileSync(process.execPath, [cli, '--state-dir', stateDir, '--json', 'status'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
        if (JSON.parse(output).owner === 'running') return;
      } catch {
        // The control socket appears only after the foreground owner has created its private state.
      }
      if (Date.now() >= deadline) throw new Error(`the foreground owner did not start: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    await running();
    const mcp = startMcp(cli, ['--state-dir', stateDir, 'mcp'], env);
    try {
      const initialized = await mcp.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'packed-consumer', version: '0' },
      });
      assert.equal(initialized.result.protocolVersion, '2025-03-26');
      mcp.notify('notifications/initialized', {});
      const status = await mcp.request('tools/call', { name: 'events_status', arguments: {} });
      assert.equal(status.result.structuredContent.owner, 'running');
    } finally {
      await mcp.close();
    }
    const stopped = execFileSync(process.execPath, [cli, '--state-dir', stateDir, '--json', 'stop'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    assert.equal(stopped, '{"stopping":true}\n');
    assert.equal(await exited, 0, stderr);
  } finally {
    if (owner.exitCode === null) owner.kill('SIGTERM');
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

console.log('events-daemon consumer check: package import, foreground owner, local CLI and MCP control OK');
