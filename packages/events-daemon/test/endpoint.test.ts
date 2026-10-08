import assert from 'node:assert/strict';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { EventControlClient, requestControl } from '../src/control/client.ts';
import {
  assertControlSupported,
  assertSocketPathFits,
  controlEndpoint,
  type EndpointIo,
  type EndpointStat,
  maxSocketPathBytes,
  verifyControlSocket,
  verifyPrivateSocketDirectory,
} from '../src/control/endpoint.ts';
import { readInstance } from '../src/control/instance.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const UID = 501;

function refusal(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'CONFIG');
    assert.equal(error.details?.reason, reason);
    return true;
  };
}

function entry(
  kind: 'dir' | 'socket' | 'link',
  mode: number,
  uid = UID,
): EndpointStat & { readonly kind: 'dir' | 'socket' | 'link' } {
  return {
    kind,
    mode,
    uid,
    isDirectory: () => kind === 'dir',
    isSocket: () => kind === 'socket',
    isSymbolicLink: () => kind === 'link',
  };
}

/** A fake filesystem: `/home/me/state/events/socket`, under a sticky shared `/home`-style tree unless changed. */
function fakeIo(overrides: Record<string, EndpointStat> = {}): EndpointIo & { readonly seen: string[] } {
  const tree: Record<string, EndpointStat> = {
    '/': entry('dir', 0o755, 0),
    '/home': entry('dir', 0o755, 0),
    '/home/me': entry('dir', 0o750),
    '/home/me/state': entry('dir', 0o700),
    '/home/me/state/events': entry('dir', 0o700),
    '/home/me/state/events/socket': entry('dir', 0o700),
    '/home/me/state/events/socket/control.sock': entry('socket', 0o600),
    ...overrides,
  };
  const seen: string[] = [];
  return {
    seen,
    async lstat(path) {
      seen.push(path);
      const found = tree[path];
      if (!found) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      return found;
    },
    async realpath(path) {
      return path === '/home/me/link-to-events' ? '/home/me/state/events' : path;
    },
  };
}

const PATHS = eventPaths('/home/me/state');

test('CTRL-B1: the control endpoint is a private Unix socket path, a full-digest pipe name, and never TCP', () => {
  assert.equal(controlEndpoint(PATHS, 'linux'), PATHS.controlSocket);
  assert.equal(controlEndpoint(PATHS, 'darwin'), PATHS.controlSocket);
  assert.match(controlEndpoint(PATHS, 'win32'), /^\\\\\.\\pipe\\agent-communications-events-[0-9a-f]{64}$/);
  assert.notEqual(
    controlEndpoint(eventPaths('C:\\Users\\alexander\\state'), 'win32'),
    controlEndpoint(eventPaths('C:\\Users\\alexandra\\state'), 'win32'),
    'two users whose paths share a prefix never share a pipe name',
  );
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    assert.doesNotMatch(controlEndpoint(PATHS, platform), /:\/\/|^\d|localhost|127\.0\.0\.1/);
  }
});

test('CTRL-B1: a socket path longer than the platform allows is refused by name, never silently truncated', () => {
  assert.equal(maxSocketPathBytes('darwin'), 103);
  assert.equal(maxSocketPathBytes('linux'), 107);
  assert.doesNotThrow(() => assertSocketPathFits(`/${'a'.repeat(102)}`, 'darwin'));
  assert.throws(() => assertSocketPathFits(`/${'a'.repeat(103)}`, 'darwin'), refusal('SOCKET_PATH_TOO_LONG'));
  assert.doesNotThrow(() => assertSocketPathFits(`/${'a'.repeat(103)}`, 'linux'));
  assert.throws(() => assertSocketPathFits(`/${'é'.repeat(54)}`, 'linux'), refusal('SOCKET_PATH_TOO_LONG'));
});

test('CTRL-B1: Windows refuses the event service, since Node cannot give a pipe a current-user ACL (B1-G)', () => {
  assert.throws(() => assertControlSupported('win32'), refusal('WINDOWS_CONTROL_UNAVAILABLE'));
  assert.doesNotThrow(() => assertControlSupported('linux'));
  assert.doesNotThrow(() => assertControlSupported('darwin'));
});

test('CTRL-B1: only a 0700 socket directory of this uid, under ancestors nobody else can change, is private', async () => {
  const check = (io: EndpointIo) => verifyPrivateSocketDirectory(PATHS, { platform: 'linux', uid: UID, io });
  await check(fakeIo());
  await check(fakeIo({ '/home': entry('dir', 0o1777, 0) }));
  await assert.rejects(
    check(fakeIo({ '/home/me/state/events/socket': entry('dir', 0o750) })),
    refusal('SOCKET_DIRECTORY_MODE'),
  );
  await assert.rejects(
    check(fakeIo({ '/home/me/state/events/socket': entry('dir', 0o700, UID + 1) })),
    refusal('SOCKET_DIRECTORY_OWNER'),
  );
  await assert.rejects(
    check(fakeIo({ '/home/me/state/events/socket': entry('link', 0o777) })),
    refusal('SOCKET_DIRECTORY_NOT_DIRECTORY'),
  );
  await assert.rejects(check(fakeIo({ '/home/me': entry('dir', 0o755, UID + 1) })), refusal('SOCKET_ANCESTOR_OWNER'));
  await assert.rejects(check(fakeIo({ '/home': entry('dir', 0o777, 0) })), refusal('SOCKET_ANCESTOR_WRITABLE'));
  await assert.rejects(check(fakeIo({ '/home/me': entry('dir', 0o770) })), refusal('SOCKET_ANCESTOR_WRITABLE'));
  await assert.rejects(
    verifyPrivateSocketDirectory(PATHS, { platform: 'win32', uid: UID, io: fakeIo() }),
    refusal('WINDOWS_CONTROL_UNAVAILABLE'),
  );
  const io = fakeIo();
  await check(io);
  assert.deepEqual(io.seen, [
    '/home/me/state/events/socket',
    '/home/me/state/events',
    '/home/me/state',
    '/home/me',
    '/home',
    '/',
  ]);
});

test('CTRL-B1: a client accepts only this uid’s 0600 socket', async () => {
  const check = (io: EndpointIo) => verifyControlSocket(PATHS.controlSocket, { uid: UID, io });
  await check(fakeIo());
  await assert.rejects(check(fakeIo({ [PATHS.controlSocket]: entry('socket', 0o660) })), refusal('SOCKET_MODE'));
  await assert.rejects(
    check(fakeIo({ [PATHS.controlSocket]: entry('socket', 0o600, UID + 1) })),
    refusal('SOCKET_OWNER'),
  );
  await assert.rejects(check(fakeIo({ [PATHS.controlSocket]: entry('link', 0o777) })), refusal('SOCKET_NOT_SOCKET'));
});

test('CTRL-B1: the owner re-proves its endpoint for every connection, and a client sends no token to one that fails', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-endpoint-');
  const owner = await startEventOwner({ stateDir });
  const paths = eventPaths(stateDir);
  try {
    const client = new EventControlClient({ stateDir });
    assert.equal(((await client.request('status')) as { owner: string }).owner, 'running');
    await assert.rejects(
      client.request('no-such-operation'),
      (error: unknown) =>
        error instanceof CommsError &&
        error.code === 'USAGE' &&
        error.message === 'the local event control operation is not recognised',
      'an operation’s own stable code comes back through the D12 failure envelope',
    );

    await chmod(paths.socketDir, 0o755);
    await assert.rejects(client.request('status'), refusal('SOCKET_DIRECTORY_MODE'));
    const record = await readInstance(paths);
    assert.ok(record);
    const { readFile } = await import('node:fs/promises');
    const token = (await readFile(paths.controlToken, 'utf8')).trim();
    await assert.rejects(
      requestControl(record, token, 'endpoint-test', 'status', {}),
      (error: unknown) =>
        error instanceof CommsError && error.code === 'AUTH_REQUIRED' && /not private/.test(error.message),
      'the owner refuses a connection while its directory is reachable by others',
    );
    await chmod(paths.socketDir, 0o700);
    assert.equal(((await client.request('status')) as { owner: string }).owner, 'running');
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CTRL-B1: a client on Windows refuses before it reads a token', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(original);
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try {
    await assert.rejects(
      new EventControlClient({ stateDir: join('/nonexistent', 'state') }).request('status'),
      refusal('WINDOWS_CONTROL_UNAVAILABLE'),
    );
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});
