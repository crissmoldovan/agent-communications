import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

type ProtocolModule = typeof import('../src/control/protocol.ts');
type SessionModule = typeof import('../src/control/session.ts');
type PathsModule = typeof import('../src/runtime/paths.ts');
type ClientModule = typeof import('../src/control/client.ts');
type InstanceModule = typeof import('../src/control/instance.ts');

async function protocolModule(): Promise<ProtocolModule | null> {
  return import('../src/control/protocol.ts').catch(() => null);
}

async function sessionModule(): Promise<SessionModule | null> {
  return import('../src/control/session.ts').catch(() => null);
}

async function pathsModule(): Promise<PathsModule | null> {
  return import('../src/runtime/paths.ts').catch(() => null);
}

async function clientModule(): Promise<ClientModule | null> {
  return import('../src/control/client.ts').catch(() => null);
}

async function instanceModule(): Promise<InstanceModule | null> {
  return import('../src/control/instance.ts').catch(() => null);
}

test('CTRL-B1: control frames are length-prefixed, bounded JSON and preserve the exact request envelope', async () => {
  const protocol = await protocolModule();
  assert.ok(protocol, 'Task 6 supplies the local control protocol');
  if (!protocol) return;

  const request = {
    version: 1,
    requestId: 'req-1',
    session: 'session-1',
    operation: 'status',
    args: {},
  };
  const encoded = protocol.encodeControlFrame(request);
  assert.deepEqual(protocol.decodeControlFrame(encoded), request);
  const reader = new protocol.ControlFrameReader();
  assert.deepEqual(reader.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(reader.push(encoded.subarray(3)), [request]);
  assert.throws(() => protocol.decodeControlFrame(new Uint8Array([0, 0, 0, 1, 123])), /malformed/i);
  assert.throws(
    () => protocol.decodeControlFrame(new Uint8Array([255, 255, 255, 255])),
    /too large/i,
    'an oversized frame is refused before it is allocated or parsed',
  );
});

test('CTRL-B1: a stale instance that no longer accepts a local socket connection is not reported as running', {
  skip: WINDOWS_SKIP,
}, async () => {
  const paths = await pathsModule();
  const client = await clientModule();
  const instance = await instanceModule();
  assert.ok(paths, 'Task 6 supplies local control paths');
  assert.ok(client, 'Task 6 supplies the local control client');
  assert.ok(instance, 'Task 6 supplies validated instance records');
  if (!paths || !client || !instance) return;

  const stateDir = await shortTempDir('aev-stale-client-');
  try {
    const eventPaths = paths.eventPaths(stateDir);
    await paths.ensureEventPaths(eventPaths);
    const token = 'a'.repeat(64);
    const record = instance.newInstanceRecord(join(stateDir, 'missing-control.sock'), token);
    await writeFile(eventPaths.controlToken, `${token}\n`, { mode: 0o600 });
    await instance.writeInstance(eventPaths, record);
    await assert.rejects(
      () => new client.EventControlClient({ stateDir }).request('status'),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CTRL-B1: protocol negotiation and authentication errors are stable and never include the token', async () => {
  const protocol = await protocolModule();
  const sessions = await sessionModule();
  assert.ok(protocol, 'Task 6 supplies the local control protocol');
  assert.ok(sessions, 'Task 6 supplies local control sessions');
  if (!protocol || !sessions) return;

  const token = 'a'.repeat(64);
  assert.deepEqual(protocol.negotiateVersion([1, 2], [2, 3]), { ok: true, version: 2 });
  assert.deepEqual(protocol.negotiateVersion([1], [2]), { ok: false, code: 'PROTOCOL_UNSUPPORTED' });
  const unauthenticated = protocol.controlFailure('AUTH_REQUIRED', 'control session is required');
  assert.equal(unauthenticated.ok, false);
  assert.equal(unauthenticated.error.code, 'AUTH_REQUIRED');
  assert.doesNotMatch(JSON.stringify(unauthenticated), new RegExp(token));
  assert.equal(sessions.matchesControlToken(token, token), true);
  assert.equal(sessions.matchesControlToken(token, `${token.slice(0, -1)}b`), false);
  let now = 100;
  const store = new sessions.ControlSessions({ now: () => now, ttlMs: 10 });
  const session = store.create(1);
  session.requestIds.add('request-1');
  assert.equal(store.get(session.id, 1)?.requestIds.has('request-1'), true, 'request correlation is session-local');
  now = 110;
  assert.equal(store.get(session.id, 1), null, 'expired sessions refuse subsequent requests');
});

test('CTRL-B1: a request cannot run before an authenticated hello', async () => {
  const source = await readFile(new URL('../src/control/server.ts', import.meta.url), 'utf8');
  assert.match(
    source,
    /if \(!session\) \{[\s\S]*?if \(!isControlHello\(message\)\) \{[\s\S]*?controlFailure\('AUTH_REQUIRED'/,
    'the server must reject a request before it creates a session from hello',
  );
});
