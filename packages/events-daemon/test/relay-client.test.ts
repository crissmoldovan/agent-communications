import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  assertLoopbackRelayUrl,
  isPromptableSession,
  locateRelay,
  RELAY_DEFAULT_PORT,
  RELAY_RUN_END_TYPES,
  RelayClient,
  RelayError,
  type RelayEventV1,
  readRelayToken,
} from '../src/runtime/relay-client.ts';
import {
  type ListenerAttestor,
  listenerOwners,
  listenersAreYours,
  parseLsofOwners,
  parseProcNetTcp,
} from '../src/runtime/relay-listener.ts';
import { FAKE_RELAY_TOKEN, FakeRelay } from './support/fake-relay.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * The claude-stream relay client (0.33.0 design §3.5, §6), against a loopback fake relay that serves the contract's
 * shapes. No real claude-stream is started or contacted, and no real relay home is read: every home is a temp folder.
 */

async function withRelay(
  work: (relay: FakeRelay, root: string) => Promise<void>,
  options?: ConstructorParameters<typeof FakeRelay>[0],
): Promise<void> {
  const relay = await new FakeRelay(options).start();
  const root = await shortTempDir('aev-relay-');
  try {
    await work(relay, root);
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function clientFor(relay: FakeRelay, root: string, attestListener?: ListenerAttestor): Promise<RelayClient> {
  const home = await relay.writeHome(root);
  const location = await locateRelay({ relayHome: home, relayPort: null }, root);
  return new RelayClient({ url: location.url, token: await readRelayToken(home), attestListener });
}

test('RELAY-1: the Pilot app’s home and its port record, the default home, and the person’s own setting', async () => {
  await withRelay(async (relay, root) => {
    const fakeHome = join(root, 'home');
    // No relay anywhere: a clear refusal, naming neither path.
    await assert.rejects(locateRelay({ relayHome: null, relayPort: null }, fakeHome), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.reason, 'RELAY_NOT_FOUND');
      return true;
    });
    // The Pilot app's home, with the port its record names.
    const pilotParent = join(fakeHome, 'Library', 'Application Support', 'com.cueplusplus.claude-stream.pilot');
    await mkdir(pilotParent, { recursive: true });
    await relay.writeHome(pilotParent);
    const pilot = await locateRelay({ relayHome: null, relayPort: null }, fakeHome);
    assert.deepEqual(pilot, { home: join(pilotParent, 'relay-home'), url: relay.url, source: 'pilot' });
    // claude-stream's default home comes first, on 4318 when no record is beside it.
    const defaultHome = join(fakeHome, '.local', 'state', 'agent-relay');
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(defaultHome, 'control.token'), `${FAKE_RELAY_TOKEN}\n`, { mode: 0o600 });
    assert.deepEqual(await locateRelay({ relayHome: null, relayPort: null }, fakeHome), {
      home: defaultHome,
      url: `http://127.0.0.1:${RELAY_DEFAULT_PORT}`,
      source: 'default',
    });
    // The person's setting wins, and its port.
    assert.deepEqual(await locateRelay({ relayHome: join(pilotParent, 'relay-home'), relayPort: 4999 }, fakeHome), {
      home: join(pilotParent, 'relay-home'),
      url: 'http://127.0.0.1:4999',
      source: 'setting',
    });
  });
});

test('RELAY-2: a control token others can read, a link, or another kind of file is refused', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRelay(async (relay, root) => {
    const home = await relay.writeHome(root, 0o644);
    await assert.rejects(readRelayToken(home), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.reason, 'RELAY_TOKEN_UNSAFE');
      assert.match(error.message, /others can read or write the relay's control token \(mode 644\)/u);
      assert.ok(!error.message.includes(FAKE_RELAY_TOKEN), 'the refusal never holds the token');
      assert.ok(!JSON.stringify(error.details).includes(FAKE_RELAY_TOKEN));
      return true;
    });
    await chmod(join(home, 'control.token'), 0o600);
    const token = await readRelayToken(home);
    // However it is printed, the token reads as its name.
    for (const shown of [String(token), JSON.stringify({ token }), inspect(token), `${token}`])
      assert.ok(!shown.includes(FAKE_RELAY_TOKEN), shown);
    assert.equal(token.authorization(), `Bearer ${FAKE_RELAY_TOKEN}`);
    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(join(home, 'control.token'), join(linked, 'control.token'));
    await assert.rejects(readRelayToken(linked), /not a regular file \(a link is refused\)/u);
    const empty = join(root, 'empty');
    await mkdir(empty);
    await writeFile(join(empty, 'control.token'), 'short', { mode: 0o600 });
    await assert.rejects(readRelayToken(empty), /is not one/u);
  });
});

test('RELAY-3: only a loopback relay address is used', async () => {
  for (const url of [
    'http://example.test:4318',
    'https://127.0.0.1:4318',
    'http://10.0.0.5:4318',
    'http://localhost.example:4318',
    'http://127.0.0.1',
    'http://user:pass@127.0.0.1:4318',
    'http://127.0.0.1:4318/proxy',
    'not a url',
  ])
    assert.throws(
      () => assertLoopbackRelayUrl(url),
      (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.reason, 'RELAY_NOT_LOOPBACK', url);
        return true;
      },
    );
  assert.equal(assertLoopbackRelayUrl('http://127.0.0.1:4318').host, '127.0.0.1:4318');
  assert.equal(assertLoopbackRelayUrl('http://[::1]:4318').hostname, '[::1]');
  await withRelay(async (relay, root) => {
    const home = await relay.writeHome(root);
    const token = await readRelayToken(home);
    assert.throws(() => new RelayClient({ url: 'http://192.168.1.4:4318', token }), /only on this machine/u);
  });
});

test('RELAY-4: GET /v1/relay must say protocol 1 and the capabilities this client relies on', async () => {
  await withRelay(async (relay, root) => {
    const info = await (await clientFor(relay, root)).ready();
    assert.equal(info.protocol, 1);
    assert.ok(
      relay.requests.every((request) => request.origin === undefined),
      'a node client sends no Origin',
    );
  });
  for (const [options, pattern] of [
    [{ protocol: 2 }, /speaks protocol 2, and Agent Comms speaks protocol 1/u],
    [{ capabilities: ['journal-id'] }, /does not offer sender, which Agent Comms relies on/u],
    [{ noRelayInfo: true }, /older than Agent Comms needs/u],
  ] as const)
    await withRelay(async (relay, root) => {
      await assert.rejects((await clientFor(relay, root)).ready(), (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.reason, 'RELAY_PROTOCOL');
        assert.match(error.message, pattern);
        return true;
      });
    }, options);
});

test('RELAY-5: sessions, a snapshot, a new session, and a run whose startId makes it once', async () => {
  await withRelay(async (relay, root) => {
    const client = await clientFor(relay, root);
    const existing = relay.addSession({ cwd: '/example/home/acme', nativeSessionId: 'abc' });
    assert.deepEqual(
      (await client.sessions()).map((session) => session.id),
      [existing.id],
    );
    const snapshot = await client.snapshot(existing.id);
    assert.equal(snapshot?.session.cwd, '/example/home/acme');
    assert.equal(await client.snapshot(`sess_${randomUUID()}`), null);
    const created = await client.createSession({
      provider: 'claude',
      cwd: '/example/home/new',
      requestedMode: 'manual',
      title: 'Agent Comms: invoices',
    });
    const startId = randomUUID();
    const first = await client.startRun(created.id, { prompt: 'hello', requestedMode: 'manual', startId });
    assert.equal(first.kind, 'started');
    // A retry under the same startId — its answer was lost — makes no second run, even while the first is live.
    const again = await client.startRun(created.id, { prompt: 'hello', requestedMode: 'manual', startId });
    assert.ok(again.kind === 'started' && again.repeated);
    assert.equal(first.kind === 'started' && again.kind === 'started' && first.run.id === again.run.id, true);
    assert.equal(relay.runs.filter((run) => run.sessionId === created.id).length, 1);
    // A different start while the run is live: 409, nothing started.
    assert.deepEqual(
      await client.startRun(created.id, { prompt: 'second', requestedMode: 'manual', startId: randomUUID() }),
      { kind: 'busy' },
    );
    assert.deepEqual(relay.runs.at(-1)?.sender, { kind: 'local', id: 'agent-comms', name: 'Agent Comms' });
    assert.ok(
      relay.requests.every((request) => request.authorised),
      'every call carries the bearer token',
    );
    assert.ok(
      relay.requests.every((request) => !request.path.includes(FAKE_RELAY_TOKEN)),
      'the token is never in a URL',
    );
  });
});

test('RELAY-5b: only a live run’s 409 is busy; a watched, fenced or moved session’s 409 is a refusal', async () => {
  await withRelay(async (relay, root) => {
    const client = await clientFor(relay, root);
    const start = () => ({ prompt: 'hello', requestedMode: 'manual', startId: randomUUID() });
    const busy = relay.addSession({ cwd: '/example/home/acme' });
    relay.startRunElsewhere(busy.id);
    assert.deepEqual(await client.startRun(busy.id, start()), { kind: 'busy' });
    const watched = relay.addSession({ cwd: '/example/home/acme', attached: 'observer' });
    const fenced = relay.addSession({ cwd: '/example/home/acme', executor: { generation: 2, state: 'fenced' } });
    const moved = relay.addSession({ cwd: '/example/home/acme', executor: { generation: 3, state: 'moved' } });
    for (const [session, code] of [
      [watched, 'conflict'],
      [fenced, 'session_fenced'],
      [moved, 'session_moved'],
    ] as const)
      await assert.rejects(client.startRun(session.id, start()), (error: unknown) => {
        assert.ok(error instanceof RelayError);
        assert.equal(error.reason, 'RELAY_REFUSED');
        assert.equal(error.relayCode, code);
        return true;
      });
    // The relay's snapshot says so too, and none of them is chosen for a prompt.
    const listed = new Map((await client.sessions()).map((session) => [session.id, session]));
    assert.deepEqual(
      [busy, watched, fenced, moved].map((session) => isPromptableSession(listed.get(session.id) as never)),
      [true, false, false, false],
    );
    assert.equal(relay.runs.filter((run) => run.sessionId !== busy.id).length, 0, 'nothing was started');
  });
});

test('RELAY-6: the event stream is followed with the bearer token, resumed with Last-Event-ID, and each record told once', async () => {
  await withRelay(async (relay, root) => {
    const client = await clientFor(relay, root);
    const session = relay.addSession({ cwd: '/example/home/acme' });
    const seen = new Set<string>();
    const told: RelayEventV1[] = [];
    const first = new AbortController();
    const following = client.follow({
      after: 0,
      types: RELAY_RUN_END_TYPES,
      signal: first.signal,
      seen,
      handlers: { onEvent: (event) => told.push(event) },
    });
    await waitFor(() => relay.streamCount === 1);
    relay.startRunElsewhere(session.id);
    relay.endRun(session.id, 'completed');
    await waitFor(() => told.length === 1);
    // The relay drops the stream; the client comes back from where it was, and the boundary record repeats.
    relay.disconnectStreams();
    const cursor = await following;
    relay.startRunElsewhere(session.id);
    relay.endRun(session.id, 'interrupted');
    const second = new AbortController();
    const resumed = client.follow({
      after: 0,
      lastEventId: cursor,
      types: RELAY_RUN_END_TYPES,
      signal: second.signal,
      seen,
      handlers: { onEvent: (event) => told.push(event) },
    });
    await waitFor(() => told.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    second.abort();
    await resumed;
    assert.deepEqual(
      told.map((event) => event.type),
      ['run.completed', 'run.interrupted'],
      'only run ends were asked for, and each is told once, the repeat after the resume dropped',
    );
    const resume = relay.requests.filter((request) => request.path.startsWith('/v1/events')).at(-1);
    assert.equal(resume?.lastEventId, String(cursor), 'the resume carries Last-Event-ID');
    assert.match(resume?.path ?? '', /follow=1/u);
  });
});

test('REVIEW-8: the control token is read from the opened file itself: a FIFO or a link swapped in is refused, never waited on', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withRelay(async (relay, root) => {
    const home = await relay.writeHome(root);
    const token = join(home, 'control.token');
    await unlink(token);
    execFileSync('/usr/bin/mkfifo', ['-m', '600', token]);
    const outcome = await Promise.race([
      readRelayToken(home).then(
        () => 'read',
        (error: unknown) => (error instanceof RelayError ? error.reason : 'other'),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 1_500)),
    ]);
    if (outcome === 'hung') execFileSync('/bin/sh', ['-c', `printf x > '${token}'`]);
    assert.equal(outcome, 'RELAY_TOKEN_UNSAFE', 'a FIFO is refused at once');
    await unlink(token);
    await writeFile(join(root, 'elsewhere'), `${FAKE_RELAY_TOKEN}\n`, { mode: 0o600 });
    await symlink(join(root, 'elsewhere'), token);
    await assert.rejects(readRelayToken(home), /a link is refused/u);
  });
});

test('REVIEW-8: the token goes only to a port this user’s own process listens on; nothing is sent otherwise', async () => {
  const uid = process.getuid?.();
  await withRelay(async (relay, root) => {
    // Another user's listener holds the port: refused before a byte — the token — is sent.
    const other = await clientFor(relay, root, async () => ({ kind: 'owners', uids: [(uid ?? 0) + 1] }));
    await assert.rejects(other.ready(), (error: unknown) => {
      assert.ok(error instanceof RelayError);
      assert.equal(error.reason, 'RELAY_NOT_YOURS');
      assert.match(error.message, /its control token was not sent/u);
      return true;
    });
    // Nothing this user can see listens, or the system could not be asked: refused too.
    const none = await clientFor(relay, root, async () => ({ kind: 'owners', uids: [] }));
    await assert.rejects(none.sessions(), /RELAY_NOT_YOURS|not held by a relay you run/u);
    const unknown = await clientFor(relay, root, async () => {
      throw new Error('lookup failed');
    });
    await assert.rejects(unknown.sessions(), /could not be checked/u);
    const following = await clientFor(relay, root, async () => ({ kind: 'owners', uids: [(uid ?? 0) + 1] }));
    await assert.rejects(
      following.follow({
        after: 0,
        types: RELAY_RUN_END_TYPES,
        signal: new AbortController().signal,
        seen: new Set(),
        handlers: { onEvent: () => undefined },
      }),
      /its control token was not sent/u,
    );
    assert.equal(relay.requests.length, 0, 'the relay was sent nothing');
    // The system's own answer, for the fake relay this test runs as this user: this user's, so it is used.
    const yours = await clientFor(relay, root);
    assert.equal((await yours.ready()).protocol, 1);
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const port = Number(new URL(relay.url).port);
      const owners = await listenerOwners(port);
      assert.ok(owners.kind === 'owners' && owners.uids.includes(uid as number));
      // A port nothing listens on has no owner, so nothing would be sent to it.
      const closed = createServer();
      await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
      const free = (closed.address() as { port: number }).port;
      await new Promise((resolve) => closed.close(resolve));
      assert.equal(listenersAreYours(await listenerOwners(free), uid), false);
    }
  });
});

test('REVIEW-8: the listener lookups read lsof’s and /proc/net/tcp’s answers, and only an answer of all-yours is yes', () => {
  assert.deepEqual(parseLsofOwners('p123\nu501\nf3\np456\nu0\nf7\n'), [501, 0]);
  assert.deepEqual(parseLsofOwners(''), []);
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:10DE 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0 100 0 0 10 0',
    '   1: 0100007F:10DE 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1001        0 12346 1 0 20 4 30 10 -1',
    '   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 12347 1 0 100 0 0 10 0',
  ].join('\n');
  assert.deepEqual(parseProcNetTcp(table, 4318), [1000], 'only listening sockets on the port, with their owners');
  assert.deepEqual(parseProcNetTcp(table, 8080), [1002]);
  assert.deepEqual(parseProcNetTcp(table, 9), []);
  assert.equal(listenersAreYours({ kind: 'owners', uids: [1000] }, 1000), true);
  assert.equal(listenersAreYours({ kind: 'owners', uids: [1000, 1002] }, 1000), false, 'one other listener is enough');
  assert.equal(listenersAreYours({ kind: 'owners', uids: [] }, 1000), false);
  assert.equal(
    listenersAreYours({ kind: 'unattested', platform: 'win32' }, undefined),
    true,
    'unattested, as documented',
  );
});

test('REVIEW-8: an event-stream record or line larger than any record is dropped as it comes, and the stream goes on', async () => {
  await withRelay(async (relay, root) => {
    const client = await clientFor(relay, root);
    const session = relay.addSession({ cwd: '/example/home/acme' });
    const told: RelayEventV1[] = [];
    const abort = new AbortController();
    const following = client.follow({
      after: 0,
      types: RELAY_RUN_END_TYPES,
      signal: abort.signal,
      seen: new Set(),
      handlers: { onEvent: (event) => told.push(event) },
    });
    await waitFor(() => relay.streamCount === 1);
    const record = (pad: string) =>
      `{"id":"evt_${randomUUID()}","cursor":90,"sessionId":"${session.id}","type":"run.completed","pad":"${pad}"}`;
    // One line of 600 KiB, then one record of three 400 KiB lines: neither is held whole, neither is told.
    relay.writeRaw(`event: relay\ndata: ${record('x'.repeat(600 * 1024))}\n\n`);
    const third = 'y'.repeat(400 * 1024);
    relay.writeRaw(
      `event: relay\ndata: {"id":"evt_${randomUUID()}","cursor":91,\ndata: "a":"${third}",\ndata: "b":"${third}",\ndata: "sessionId":"${session.id}","type":"run.completed","c":"${third}"}\n\n`,
    );
    relay.startRunElsewhere(session.id);
    relay.endRun(session.id, 'completed');
    await waitFor(() => told.length === 1);
    abort.abort();
    await following;
    assert.equal(told.length, 1, 'only the ordinary record');
    assert.equal(
      relay.requests.filter((request) => request.path.startsWith('/v1/events')).length,
      1,
      'the stream was never dropped and followed again',
    );
  });
});

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
