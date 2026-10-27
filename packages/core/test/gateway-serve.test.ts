import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { Config } from '../src/config.ts';
import {
  type ConnectionRecord,
  connectionKeyHash,
  newConnectionId,
  newConnectionKey,
  withConnection,
} from '../src/connections.ts';
import { type Core, openCore } from '../src/core.ts';
import { INSTRUCTIONS_MAX_BYTES } from '../src/gateway/instructions.ts';
import type { PartSpec } from '../src/gateway/router.ts';
import { connectionRefusal, runGateway } from '../src/gateway/serve.ts';
import { runningGateways } from '../src/gateway/status.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The gateway as `agentcomms mcp --connection <id>` runs it (single-server design D2, D10, D15, §4): the key its entry
 * carries is checked against the record's hash, a connection that cannot be served serves nothing and says why, and it
 * follows the record live — a part taken out stops, a connection cut off or re-keyed stops every part. Parts are the
 * gateway's stand-ins (`helpers/gateway/fake-part.ts`), each a real process with a temporary HOME.
 */

const FAKE = fileURLToPath(new URL('./helpers/gateway/fake-part.ts', import.meta.url));
const STRIP = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

interface Machine {
  home: string;
  env: NodeJS.ProcessEnv;
  core: Core;
}

function machine(): Machine {
  const home = tempDir('comms-gateway-serve-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    PATH: process.env.PATH ?? '',
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(home, 'state'),
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { home, env, core: openCore({ env, caller: CORE_CALLER }) };
}

function record(over: Partial<ConnectionRecord> & { key: string }): ConnectionRecord {
  const { key, ...rest } = over;
  return {
    id: newConnectionId(),
    name: 'Work — Claude Code',
    app: 'claude-code',
    where: { scope: 'user', folder: null, configDir: null },
    entry: { name: 'agentcomms', path: '/example/home/.claude.json' },
    launcher: 'managed',
    parts: [{ server: 'slack' }, { server: 'gmail' }],
    keyHash: connectionKeyHash(key),
    keyIssuedAt: '2026-10-27T09:00:00.000Z',
    createdAt: '2026-10-27T09:00:00.000Z',
    revokedAt: null,
    ...rest,
  };
}

async function put(m: Machine, held: ConnectionRecord, consent = true): Promise<void> {
  await m.core.config.update((config: Config) => ({ ...config, connections: withConnection(config, { put: held }) }), {
    ...(consent ? { consent: { kind: 'loosening-consent' as const, paths: [`connections["${held.name}"]`] } } : {}),
  });
}

/** The stand-in parts, as `partSpecs` would hand the gateway the real ones: by the record's parts, each its own env. */
function fakes(m: Machine) {
  return async (held: ConnectionRecord): Promise<{ specs: PartSpec[]; skipped: never[] }> => ({
    specs: held.parts.map((part) => ({
      server: part.server,
      label: part.server,
      prefix: part.server,
      command: process.execPath,
      args: [...STRIP, FAKE, part.server],
      env: { ...m.env, AGENT_COMMS_LAUNCHER: 'core' },
    })),
    skipped: [],
  });
}

async function gateway(t: TestContext, m: Machine, id: string, key: string | undefined, lines: string[] = []) {
  const env = { ...m.env, ...(key === undefined ? {} : { AGENT_COMMS_CONNECTION_KEY: key }) };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runGateway({
    core: m.core,
    env,
    connection: id,
    transport: serverSide,
    log: (line) => lines.push(line),
    parts: fakes(m) as never,
    followEveryMs: 100,
  });
  const client = new Client({ name: 'claude-code', version: '2.1.310' }, { capabilities: {} });
  await client.connect(clientSide);
  t.after(async () => {
    await client.close().catch(() => undefined);
    await served.close();
  });
  return { client, served, env, lines };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting');
}

function everything(m: Machine): string {
  const state = m.env.AGENT_COMMS_STATE_DIR as string;
  const dir = join(state, 'gateway');
  let text = '';
  try {
    for (const name of readdirSync(dir)) text += readFileSync(join(dir, name), 'utf8');
  } catch {
    // none
  }
  return text;
}

test('D10: a wrong, missing, replaced or unknown key, or a connection cut off, serves no tools and says why', async (t) => {
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key });
  await put(m, held);
  const config = await m.core.config.load();
  assert.equal(connectionRefusal(config, held.id, key), null);
  const cases: [string, string, string | undefined, RegExp][] = [
    ['a wrong key', held.id, newConnectionKey(), /is not the connection’s: it was replaced/],
    ['no key', held.id, undefined, /carries no key for the connection/],
    ['a key of the wrong shape', held.id, 'not-a-key', /is not the connection’s/],
    ['an unknown connection', newConnectionId(), key, /not in Agent Comms any more/],
  ];
  for (const [what, id, given, why] of cases) {
    const lines: string[] = [];
    const { client, served } = await gateway(t, m, id, given, lines);
    assert.equal(served.router, null, what);
    assert.match(served.refused ?? '', why, what);
    assert.deepEqual((await client.listTools()).tools, [], what);
    assert.match(client.getInstructions() ?? '', /Agent Comms serves nothing here/, what);
    assert.match(client.getInstructions() ?? '', /MCP connections/, what);
    if (given !== undefined) assert.equal(lines.join('\n').includes(given), false, `${what}: the key in no log line`);
  }
  await put(m, { ...held, revokedAt: '2026-10-27T10:00:00.000Z' }, false);
  const cut = await gateway(t, m, held.id, key);
  assert.match(cut.served.refused ?? '', /cut off/);
  assert.equal(everything(m).includes(key), false, 'the key is in no status file');
});

test('D10: the right key serves the parts, which never see it; the gateway forgets it, and the status file holds none', async (t) => {
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key });
  await put(m, held);
  const { client, served, env } = await gateway(t, m, held.id, key);
  assert.ok(served.router);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('slack_echo') && names.includes('gmail_whoami'), names.join(', '));
  const seen = (await client.callTool({ name: 'slack_env', arguments: {} })).structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(seen.hasConnectionKey, false);
  assert.equal(seen.hasLauncher, false);
  assert.equal(seen.connection, held.id);
  assert.equal(env.AGENT_COMMS_CONNECTION_KEY, undefined, 'taken out of the environment it was handed');
  const instructions = client.getInstructions() ?? '';
  assert.match(instructions, /the connection "Work — Claude Code"/);
  assert.ok(Buffer.byteLength(instructions) <= INSTRUCTIONS_MAX_BYTES);
  // Written as each part moves: the last write says both run.
  await waitFor(async () => {
    const [now] = await runningGateways(m.env.AGENT_COMMS_STATE_DIR as string, held.id);
    return now?.parts.every((part) => part.state === 'running') === true && now.client !== null;
  });
  const [status] = await runningGateways(m.env.AGENT_COMMS_STATE_DIR as string, held.id);
  assert.deepEqual(
    status?.parts.map((part) => [part.server, part.state]),
    [
      ['slack', 'running'],
      ['gmail', 'running'],
    ],
  );
  assert.deepEqual(status?.client, { name: 'claude-code', version: '2.1.310' });
  assert.equal(everything(m).includes(key), false);
});

test('D15: a part taken out stops at once and its tools go; a connection cut off, or whose key is replaced, stops every part', async (t) => {
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key });
  await put(m, held);
  const { client, served } = await gateway(t, m, held.id, key);
  assert.ok(served.router);
  const slackPid = served.router.status().find((part) => part.server === 'slack')?.pid;
  // Narrowing applies at once, with no approval: Slack taken out.
  await put(m, { ...held, parts: [{ server: 'gmail' }] }, false);
  const after = (await client.listTools()).tools.map((tool) => tool.name);
  assert.equal(
    after.some((name) => name.startsWith('slack_')),
    false,
    after.join(', '),
  );
  assert.equal(
    served.router.status().some((part) => part.server === 'slack'),
    false,
  );
  if (typeof slackPid === 'number') await waitFor(() => !alive(slackPid));
  // A new key: the one this entry carries no longer matches, and nothing is served.
  await put(m, { ...held, parts: [{ server: 'gmail' }], keyHash: connectionKeyHash(newConnectionKey()) }, false);
  await assert.rejects(client.callTool({ name: 'gmail_whoami', arguments: {} }), /replaced/);
  assert.deepEqual((await client.listTools()).tools, []);
  assert.ok(served.router.status().every((part) => part.state === 'stopped'));
});

test('D15: a request that arrives while the timer’s look is applying a change waits for it, rather than being served before it', async (t) => {
  /*
   * The flake this test pins (about 1 run in 4 of the test above): the timer's look saw the narrowed `config.json`,
   * recorded its stamp, and was still working out the parts when `tools/list` arrived. That request's own look found
   * the stamp unchanged — "nothing new" — and was served with Slack still in. Here the timer's look is held inside the
   * parts it works out, so the order is certain: the request must not be answered until the look it raced has applied.
   */
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key });
  await put(m, held);
  const env = { ...m.env, AGENT_COMMS_CONNECTION_KEY: key };
  const real = fakes(m);
  let looks = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runGateway({
    core: m.core,
    env,
    connection: held.id,
    transport: serverSide,
    log: () => undefined,
    parts: (async (next: ConnectionRecord) => {
      looks += 1;
      // The start's own look goes through; the next one — the timer's, on the narrowed record — is held.
      if (looks > 1) await released;
      return real(next);
    }) as never,
    followEveryMs: 50,
  });
  const client = new Client({ name: 'claude-code', version: '2.1.310' }, { capabilities: {} });
  await client.connect(clientSide);
  t.after(async () => {
    release();
    await client.close().catch(() => undefined);
    await served.close();
  });
  assert.ok((await client.listTools()).tools.some((tool) => tool.name.startsWith('slack_')));
  await put(m, { ...held, parts: [{ server: 'gmail' }] }, false);
  // No request is in flight: the look that reaches the parts now is the timer's.
  await waitFor(() => looks > 1);
  let answered = false;
  const listed = client.listTools().then((result) => {
    answered = true;
    return result;
  });
  await sleep(300);
  assert.equal(answered, false, 'the request was served before the change the timer had seen was applied');
  release();
  const names = (await listed).tools.map((tool) => tool.name);
  assert.equal(
    names.some((name) => name.startsWith('slack_')),
    false,
    names.join(', '),
  );
});

test('D15: a re-keyed connection refuses the request that arrives while the timer’s look is still reading it', async (t) => {
  /*
   * The same race on the refusal: the timer's look recorded the new stamp, and had the reason only once it had read the
   * record — a request in between found the stamp unchanged and was served on the replaced key. Here the timer's read
   * of `config.json` is held, so the request comes in between for certain: it must wait, and be refused.
   */
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key, parts: [{ server: 'gmail' }] });
  await put(m, held);
  const env = { ...m.env, AGENT_COMMS_CONNECTION_KEY: key };
  let holding = false;
  let reads = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = {
    path: m.core.config.path,
    load: async () => {
      if (holding) {
        reads += 1;
        await released;
      }
      return m.core.config.load();
    },
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = await runGateway({
    core: { paths: m.core.paths, config } as never,
    env,
    connection: held.id,
    transport: serverSide,
    log: () => undefined,
    parts: fakes(m) as never,
    followEveryMs: 50,
  });
  const client = new Client({ name: 'claude-code', version: '2.1.310' }, { capabilities: {} });
  await client.connect(clientSide);
  t.after(async () => {
    release();
    await client.close().catch(() => undefined);
    await served.close();
  });
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'gmail_whoami'));
  holding = true;
  await put(m, { ...held, keyHash: connectionKeyHash(newConnectionKey()) }, false);
  // No request is in flight: the look reading the record now is the timer's.
  await waitFor(() => reads > 0);
  let answered = false;
  const called = client.callTool({ name: 'gmail_whoami', arguments: {} }).finally(() => {
    answered = true;
  });
  called.catch(() => undefined);
  await sleep(300);
  assert.equal(answered, false, 'the call was answered before the replaced key the timer had seen was refused');
  release();
  await assert.rejects(called, /replaced/);
});

test('D15: the gateway follows its connection on a timer too, and a connection removed is refused the next call', async (t) => {
  const m = machine();
  const key = newConnectionKey();
  const held = record({ key, parts: [{ server: 'slack' }] });
  await put(m, held);
  const { client, served } = await gateway(t, m, held.id, key);
  assert.ok(served.router);
  await m.core.config.update((config: Config) => ({
    ...config,
    connections: withConnection(config, { remove: held.id }),
  }));
  // Without any call: the 100 ms timer of this test finds it, and stops the part.
  await waitFor(() => served.router?.status().every((part) => part.state === 'stopped') === true);
  await assert.rejects(client.callTool({ name: 'slack_echo', arguments: { text: 'x' } }), /removed/);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
