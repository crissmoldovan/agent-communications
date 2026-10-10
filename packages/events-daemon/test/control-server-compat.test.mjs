import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('control real Node v1 server answers compiled Rust status and doctor and rejects disjoint versions', {
  skip:
    process.platform === 'win32' ||
    (!process.env.DESKTOP_CONTROL_PROBE_BIN && process.env.DESKTOP_REQUIRE_CONTROL_PROBE !== '1'),
}, async (t) => {
  assert.ok(process.env.DESKTOP_CONTROL_PROBE_BIN, 'Unix CI requires the compiled Rust control probe');
  const { startControlServer } = await import('../src/control/server.ts');
  const { eventPaths, ensureEventPaths, ensureEventSocketDirectory } = await import('../src/runtime/paths.ts');
  const { controlEndpoint, verifyPrivateSocketDirectory } = await import('../src/control/endpoint.ts');
  const { tokenFingerprint } = await import('../src/control/instance.ts');
  const root = await realpath(await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'aev-c4-')));
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const executable = join(root, 'agent-events');
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  await mkdir(stateDir, { mode: 0o700 });
  await mkdir(configDir, { mode: 0o700 });
  let server;
  let fakeServer;
  let attackMode = null;
  let shutdownTask;
  const receivedOperations = [];
  try {
    const paths = await ensureEventPaths(eventPaths(stateDir));
    await ensureEventSocketDirectory(paths);
    const endpoint = controlEndpoint(paths);
    const token = 'a'.repeat(64);
    const record = {
      instanceId: 'b'.repeat(32),
      pid: process.pid,
      processStart: `${process.pid}:fixture`,
      endpoint,
      tokenFingerprint: tokenFingerprint(token),
    };
    const writeRecord = (identity = record) => writeFile(paths.instance, JSON.stringify(identity), { mode: 0o600 });
    try {
      server = await startControlServer({
        endpoint,
        token,
        verifyEndpoint: async () => {
          await verifyPrivateSocketDirectory(paths);
          if (attackMode === 'hello') await writeRecord({ ...record, instanceId: 'c'.repeat(32) });
        },
        handle: async (request) => {
          receivedOperations.push(request.operation);
          if (attackMode === 'reply') await writeRecord({ ...record, instanceId: 'c'.repeat(32) });
          if (request.operation === 'status') return { owner: 'running' };
          if (request.operation === 'doctor') return { owner: 'running', protocolVersions: [1] };
          if (request.operation === 'stop') {
            if (attackMode === 'supervision') {
              shutdownTask = new Promise((resolve, reject) => {
                setTimeout(() => {
                  const closing = server;
                  server = undefined;
                  closing
                    .close()
                    .then(() => rm(paths.instance, { force: true }))
                    .then(resolve, reject);
                }, 100);
              });
            }
            return { stopping: true };
          }
          throw new Error('unapproved operation');
        },
      });
    } catch (error) {
      if (
        error?.code === 'EPERM' &&
        process.env.DESKTOP_ALLOW_SOCKET_SKIP === '1' &&
        process.env.DESKTOP_REQUIRE_CONTROL_PROBE !== '1'
      ) {
        t.skip('sandbox denies Unix socket bind');
        return;
      }
      throw error;
    }
    await chmod(endpoint, 0o600);
    await writeFile(paths.controlToken, `${token}\n`, { mode: 0o600 });
    await writeRecord();
    const probe = (operation, versions = '1', extra = []) =>
      new Promise((resolve, reject) => {
        // Keep the test's event loop free to service the real Node socket while Rust runs.
        const child = spawn(process.env.DESKTOP_CONTROL_PROBE_BIN, [
          '--executable',
          executable,
          '--state-dir',
          stateDir,
          '--config-dir',
          configDir,
          '--operation',
          operation,
          '--versions',
          versions,
          ...extra,
        ]);
        let stdout = '';
        let stderr = '';
        const timeout = setTimeout(() => child.kill(), 10000);
        child.stdout.setEncoding('utf8').on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (status) => {
          clearTimeout(timeout);
          resolve({ status, stdout, stderr });
        });
      });
    for (const operation of ['status', 'doctor']) {
      const result = await probe(operation);
      assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).owner, 'running');
    }
    const unsupported = await probe('status', '2');
    assert.equal(unsupported.status, 3);
    assert.equal(unsupported.stdout.trim(), 'PROTOCOL_UNSUPPORTED');
    const stop = await probe('stop');
    assert.equal(stop.status, 0, `stop: ${stop.stderr}`);
    assert.equal(JSON.parse(stop.stdout).stopping, true);
    assert.deepEqual(receivedOperations, ['status', 'doctor', 'stop']);

    attackMode = 'hello';
    const replacedBeforeRequest = await probe('status');
    assert.equal(replacedBeforeRequest.status, 2);
    assert.equal(replacedBeforeRequest.stdout.trim(), 'CONTROL_OWNER_CHANGED');
    assert.deepEqual(receivedOperations, ['status', 'doctor', 'stop']);
    await writeRecord();

    attackMode = 'reply';
    const replacedBeforeReply = await probe('status');
    assert.equal(replacedBeforeReply.status, 2);
    assert.equal(replacedBeforeReply.stdout.trim(), 'CONTROL_OWNER_CHANGED');
    assert.deepEqual(receivedOperations, ['status', 'doctor', 'stop', 'status']);
    await writeRecord();

    attackMode = 'supervision';
    const cycle = await probe('status', '1', [
      '--mode',
      'supervision-cycle',
      '--preferences-path',
      join(root, 'desktop-private/prefs'),
    ]);
    assert.equal(cycle.status, 0, `attached supervision cycle: ${cycle.stderr}`);
    assert.deepEqual(JSON.parse(cycle.stdout), { attached: true, stopped: true });
    assert.equal(receivedOperations.filter((operation) => operation === 'stop').length, 2);
    assert.ok(receivedOperations.filter((operation) => operation === 'status').length >= 4);
    await shutdownTask;

    // A controlled byte-level peer exercises malformed replies that production startControlServer never emits.
    const { ControlFrameReader, encodeControlFrame } = await import('../src/control/protocol.ts');
    await writeRecord();
    await rm(endpoint, { force: true });
    let fakeMode = 'oversized';
    let receivedRequest;
    fakeServer = createServer((socket) => {
      const reader = new ControlFrameReader();
      socket.on('data', (chunk) => {
        for (const message of reader.push(chunk)) {
          if ('hello' in message) {
            if (fakeMode === 'oversized') socket.write(Buffer.from([0, 1, 0, 1]));
            else if (fakeMode === 'empty-session')
              socket.write(encodeControlFrame({ ok: true, version: 1, session: '' }));
            else socket.write(encodeControlFrame({ ok: true, version: 1, session: 'synthetic-session' }));
          } else {
            receivedRequest = { operation: message.operation, session: message.session };
            socket.write(encodeControlFrame({ ok: true, requestId: 'wrong-request', data: {} }));
          }
        }
      });
    });
    await new Promise((resolve, reject) => {
      fakeServer.once('error', reject);
      fakeServer.listen(endpoint, () => {
        fakeServer.off('error', reject);
        resolve();
      });
    });
    await chmod(endpoint, 0o600);
    for (const [mode, expected] of [
      ['oversized', 'FRAME_TOO_LARGE'],
      ['empty-session', 'MALFORMED_FRAME'],
      ['stale-request', 'CONTROL_STALE_REPLY'],
    ]) {
      fakeMode = mode;
      const result = await probe('status');
      assert.equal(result.status, 2, `${mode}: ${result.stderr}`);
      assert.equal(result.stdout.trim(), expected);
    }
    assert.deepEqual(receivedRequest, { operation: 'status', session: 'synthetic-session' });
  } finally {
    await server?.close();
    if (fakeServer?.listening) await new Promise((resolve) => fakeServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
