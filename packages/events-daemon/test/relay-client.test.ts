import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  assertLoopbackRelayUrl,
  locateRelay,
  RELAY_DEFAULT_PORT,
  RELAY_RUN_END_TYPES,
  RelayClient,
  RelayError,
  type RelayEventV1,
  readRelayToken,
} from '../src/runtime/relay-client.ts';
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

async function clientFor(relay: FakeRelay, root: string): Promise<RelayClient> {
  const home = await relay.writeHome(root);
  const location = await locateRelay({ relayHome: home, relayPort: null }, root);
  return new RelayClient({ url: location.url, token: await readRelayToken(home) });
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

test('RELAY-6: the event stream is followed with fetch, resumed with Last-Event-ID, and each record told once', async () => {
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

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
