/**
 * The 0.35 single-server spike (design `docs/superpowers/specs/2026-10-26-single-server-design.md`, phase P0): can one
 * router MCP server sit in front of each part's own MCP server process, with the SDK this repository uses?
 *
 * Run: `node --test spikes/single-server/single-server.test.mjs`. Every part is a stand-in (`fake-part.mjs`) started
 * with a temporary HOME; nothing talks to any service. "Direct" means the same stand-in served to the client with no
 * router, so "through the router" can be compared with it on the wire, byte for byte.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { envelope, rawClient, TASKS_EXTENSION } from './raw-client.mjs';
import { Router } from './router.mjs';
import {
  client as clientSdk,
  clientStdio,
  PASSTHROUGH,
  SDK_VERSION,
  server as serverSdk,
  serverStdio,
  z,
} from './sdk.mjs';

const { Client } = clientSdk;
const { StdioClientTransport } = clientStdio;
const { InMemoryTransport } = serverSdk;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FAKE = join(HERE, 'fake-part.mjs');
const GATEWAY = join(HERE, 'gateway-cli.mjs');
const ERAS = [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
];
const CLIENT = { name: 'claude-code', version: '2.1.310' };
const CAPABILITIES = { elicitation: { form: {} }, extensions: { [TASKS_EXTENSION]: {} } };

let home;
before(async () => {
  home = await mkdtemp(join(tmpdir(), 'acspike-'));
});
after(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A stand-in home for every process the spike starts: no part ever sees the person's real one. */
const baseEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home });
const part = (id, env = {}, kind = id) => ({
  id,
  label: id,
  command: process.execPath,
  args: [FAKE, kind],
  env: { ...baseEnv(), ...env },
});
const body = (message) => {
  const { jsonrpc: _jsonrpc, id: _id, ...rest } = message;
  return JSON.stringify(rest);
};
const typedCode = (params) => params.message.match(/Type (\S+) to send/u)?.[1];
const accept = (params) => ({ action: 'accept', content: { code: typedCode(params) } });

async function waitFor(check, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting');
}

/** Records every message either way, so the client's view of the wire can be compared. */
function tap(inner) {
  const inbound = [];
  const outbound = [];
  const transport = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    start: () => inner.start(),
    send: (message, options) => {
      outbound.push(message);
      return inner.send(message, options);
    },
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    get sessionId() {
      return inner.sessionId;
    },
  };
  inner.onmessage = (message, extra) => {
    inbound.push(message);
    transport.onmessage?.(message, extra);
  };
  inner.onclose = () => transport.onclose?.();
  inner.onerror = (error) => transport.onerror?.(error);
  /** The raw answer, as it came off the wire, to each request the client sent with this method. */
  const answers = (method) =>
    outbound
      .filter((message) => message.method === method && message.id !== undefined)
      .map((request) =>
        inbound.find((message) => message.id === request.id && ('result' in message || 'error' in message)),
      );
  return { transport, inbound, outbound, answers };
}

async function connect(t, transport, options = {}) {
  const { mode = 'legacy', clientInfo = CLIENT, capabilities = CAPABILITIES, listChanged, onElicit = accept } = options;
  const wire = tap(transport);
  const client = new Client(clientInfo, {
    versionNegotiation: { mode },
    capabilities,
    ...(listChanged === undefined ? {} : { listChanged }),
  });
  const asked = [];
  if (capabilities.elicitation !== undefined)
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(request.params);
      return onElicit(request.params);
    });
  await client.connect(wire.transport);
  t.after(() => client.close().catch(() => undefined));
  return { client, wire, asked };
}

/** The SDK client connected, in memory, to a router whose parts are real processes. */
async function viaRouter(t, parts, options = {}) {
  const lines = [];
  const router = new Router({ parts, connectionId: 'cn_spike', log: (line) => lines.push(line), ...options.router });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  router.serve(serverSide);
  t.after(() => router.close());
  return { ...(await connect(t, clientSide, options)), router, lines };
}

/** The SDK client connected over stdio to the stand-in alone. */
async function direct(t, kind, options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FAKE, kind],
    env: { ...baseEnv(), ...(options.env ?? {}) },
    stderr: 'ignore',
  });
  return connect(t, transport, options);
}

async function rawViaRouter(t, parts, options = {}) {
  const router = new Router({ parts, connectionId: 'cn_spike', log: () => undefined, ...options.router });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  router.serve(serverSide);
  const raw = await rawClient(clientSide, options);
  t.after(async () => {
    await raw.close();
    await router.close();
  });
  return { raw, router };
}

async function rawDirect(t, kind, options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [FAKE, kind],
    env: { ...baseEnv(), ...(options.env ?? {}) },
    stderr: 'ignore',
  });
  const raw = await rawClient(transport, options);
  t.after(() => raw.close());
  return raw;
}

test('SPIKE-0: the SDK under test is the one the packages use', () => {
  assert.equal(SDK_VERSION, '2.3.1');
});

// ------------------------------------------------------------------------------------------- 1. tool passthrough
for (const { mode, version } of ERAS) {
  test(`SPIKE-1 (${version}): tools/list through the router is each part's own list, tool for tool and byte for byte`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('gmail'), part('events')], { mode });
    assert.equal(routed.client.getNegotiatedProtocolVersion(), version);
    const expected = [];
    for (const kind of ['slack', 'gmail', 'events']) {
      const alone = await direct(t, kind, { mode });
      await alone.client.listTools();
      expected.push(...alone.wire.answers('tools/list')[0].result.tools);
    }
    await routed.client.listTools();
    const got = routed.wire.answers('tools/list')[0].result.tools;
    assert.deepEqual(
      got.map((tool) => tool.name),
      expected.map((tool) => tool.name),
    );
    for (const [index, tool] of got.entries()) assert.equal(JSON.stringify(tool), JSON.stringify(expected[index]));
  });

  test(`SPIKE-1 (${version}): results, isError, structured content, _meta and JSON-RPC errors arrive as the part sent them, byte for byte`, async (t) => {
    const calls = [
      ['slack_echo', { text: 'hello', mode: 'loud', to: 'someone@example.org' }],
      ['slack_rich', {}],
      ['slack_fail', {}],
      ['slack_throw', {}],
      ['slack_nonexistent', {}],
      ['slack_params', { nested: { list: [1, 'two'] } }],
    ];
    const alone = await direct(t, 'slack', { mode });
    const routed = await viaRouter(t, [part('gmail'), part('slack')], { mode });
    for (const [name, args] of calls)
      for (const side of [alone, routed])
        await side.client
          .callTool({ name, arguments: args, _meta: { 'example.org/trace': 't-1' } })
          .catch(() => undefined);
    const expected = alone.wire.answers('tools/call');
    const got = routed.wire.answers('tools/call');
    assert.equal(got.length, calls.length);
    for (const [index, [name]] of calls.entries()) assert.equal(body(got[index]), body(expected[index]), name);
    assert.equal(got[2].result.isError, true);
    assert.deepEqual(got[3].error, { code: -32602, message: 'bad workspace', data: { workspace: 'cue/slack', n: 1 } });
    // The call reached the part as the client sent it: arguments, the client's own _meta and, on 2026-07-28, its envelope.
    const received = got[5].result.structuredContent;
    assert.deepEqual(received.params.arguments, { nested: { list: [1, 'two'] } });
    assert.equal(received.params._meta['example.org/trace'], 't-1');
    if (mode === 'auto') assert.deepEqual(received.envelope['io.modelcontextprotocol/clientInfo'], CLIENT);
  });

  test(`SPIKE-1 (${version}): a part's progress notifications reach the client under the client's own progressToken`, async (t) => {
    const routed = await viaRouter(t, [part('slack')], { mode });
    const seen = [];
    await routed.client.callTool({ name: 'slack_progress', arguments: {} }, { onprogress: (step) => seen.push(step) });
    assert.deepEqual(
      seen.map((step) => [step.progress, step.total, step.message]),
      [
        [1, 3, 'step 1'],
        [2, 3, 'step 2'],
        [3, 3, 'step 3'],
      ],
    );
  });

  test(`SPIKE-1 (${version}): a part cannot answer for another prefix: its foreign tools are dropped and each call reaches the owner`, async (t) => {
    // The rogue part comes first, so without the prefix filter its `slack_echo` would win.
    const routed = await viaRouter(t, [part('gmail', { FAKE_ROGUE: '1' }), part('slack'), part('events')], { mode });
    const names = (await routed.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name === 'slack_echo').length, 1);
    assert.equal(names.includes('comms_doctor'), false);
    const echo = await routed.client.callTool({ name: 'slack_echo', arguments: { text: 'who' } });
    assert.equal(echo.structuredContent.servedBy, 'slack');
    const status = await routed.client.callTool({ name: 'events_status', arguments: {} });
    assert.deepEqual(status.structuredContent, { owner: 'not-running' });
    await assert.rejects(
      routed.client.callTool({ name: 'comms_doctor', arguments: {} }),
      /Tool comms_doctor not found/u,
    );
    assert.deepEqual(routed.router.dropped.map((drop) => drop.tool).sort(), [
      'comms_doctor',
      'events_status',
      'slack_echo',
    ]);
  });
}

test('SPIKE-1: a client that probes with server/discover, then falls back to initialize, gets every part reopened in the 2025 era', async (t) => {
  const router = new Router({ parts: [part('gmail'), part('slack')], log: () => undefined });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  router.serve(serverSide);
  t.after(() => router.close());
  const waiting = new Map();
  clientSide.onmessage = (message) => waiting.get(message.id)?.(message);
  await clientSide.start();
  const send = (id, method, params) =>
    new Promise((resolve) => {
      waiting.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params });
    });
  const probe = await send(1, 'server/discover', { _meta: envelope(false) });
  assert.deepEqual(probe.result.supportedVersions, ['2026-07-28']);
  const opened = await send(2, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT });
  assert.equal(opened.result.protocolVersion, '2025-11-25');
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const who = await send(3, 'tools/call', { name: 'gmail_whoami', arguments: {} });
  assert.deepEqual(who.result.structuredContent.getClientVersion, CLIENT, "the part's own initialize was the client's");
  assert.equal(who.result.structuredContent.protocol, '2025-11-25');
});

test('SPIKE-1: a part is started without the connection key or the launcher name, and knows its gateway', async (t) => {
  const env = { AGENT_COMMS_CONNECTION_KEY: 'ack_spike-not-a-real-key', AGENT_COMMS_LAUNCHER: 'core' };
  const routed = await viaRouter(t, [part('slack', env)]);
  const seen = (await routed.client.callTool({ name: 'slack_env', arguments: {} })).structuredContent;
  assert.deepEqual(seen, {
    hasConnectionKey: false,
    hasLauncher: false,
    gatewayPid: String(process.pid),
    connection: 'cn_spike',
    ppid: process.pid,
  });
});

// --------------------------------------------------------------------------------- 2. approval forms (elicitation)
for (const { mode, version } of ERAS) {
  test(`SPIKE-2 (${version}): Gmail's approval form reaches the real client through the router, and the person's answer reaches Gmail`, async (t) => {
    const draftId = `d${process.hrtime.bigint()}`;
    const routed = await viaRouter(t, [part('slack'), part('gmail'), part('events')], { mode });
    const result = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId } });
    assert.equal(routed.asked.length, 1, 'the client was asked once');
    assert.match(routed.asked[0].message, new RegExp(`^Send draft ${draftId}\\?`, 'u'));
    assert.deepEqual(result.structuredContent, { sent: true, typed: `XK-${draftId}`, client: 'claude-code' });
    if (mode === 'legacy') {
      // 2025: the part's own `elicitation/create`, relayed to the client, answered by the client.
      assert.deepEqual(routed.router.relayed, [{ part: 'gmail', method: 'elicitation/create', answeredBy: 'client' }]);
    } else {
      // 2026-07-28: the form travels in the result, and the answer in the client's own retry; the router asks nothing.
      assert.deepEqual(routed.router.relayed, []);
      const answers = routed.wire.answers('tools/call');
      assert.equal(answers[0].result.resultType, 'input_required');
      assert.equal(answers[0].result._meta['io.modelcontextprotocol/serverInfo'].name, 'fake-gmail');
      const retry = routed.wire.outbound.filter((message) => message.method === 'tools/call')[1];
      assert.deepEqual(Object.keys(retry.params.inputResponses), ['approval']);
      assert.equal(answers.length, 2);
    }
  });

  test(`SPIKE-2 (${version}): the person's no, and a slow yes, both reach Gmail as given: the router neither answers nor times out`, async (t) => {
    let asked = 0;
    const onElicit = async (params) => {
      asked += 1;
      if (asked === 1) return { action: 'decline' };
      await sleep(1_500);
      return accept(params);
    };
    const routed = await viaRouter(t, [part('gmail')], { mode, onElicit });
    const declined = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd1' } });
    assert.equal(declined.isError, true);
    assert.match(declined.content[0].text, /declined/u);
    const started = Date.now();
    const slow = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd2' } });
    assert.ok(Date.now() - started >= 1_500);
    assert.equal(slow.structuredContent.sent, true);
    if (mode === 'legacy')
      assert.deepEqual(
        routed.router.relayed.map((each) => each.answeredBy),
        ['client', 'client'],
      );
  });

  test(`SPIKE-2 (${version}): Gmail sees the client's own name and capabilities through the router, exactly as direct`, async (t) => {
    const alone = await direct(t, 'gmail', { mode });
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode });
    const expected = (await alone.client.callTool({ name: 'gmail_whoami', arguments: {} })).structuredContent;
    const got = (await routed.client.callTool({ name: 'gmail_whoami', arguments: {} })).structuredContent;
    assert.deepEqual(got, expected);
    const seen = mode === 'legacy' ? got.getClientVersion : got.envelopeClientInfo;
    assert.deepEqual(seen, CLIENT, 'the client as it said it is, never "agentcomms"');
  });

  test(`SPIKE-2 (${version}): a client off Gmail's allow-list gets no form through the router, byte for byte as direct`, async (t) => {
    const clientInfo = { name: 'cursor', version: '1.0.0' };
    const alone = await direct(t, 'gmail', { mode, clientInfo });
    const routed = await viaRouter(t, [part('gmail')], { mode, clientInfo });
    for (const side of [alone, routed])
      await side.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
    assert.equal(body(routed.wire.answers('tools/call')[0]), body(alone.wire.answers('tools/call')[0]));
    assert.match(routed.wire.answers('tools/call')[0].result.content[0].text, /client "cursor"/u);
    assert.equal(routed.asked.length + alone.asked.length, 0);
  });

  test(`SPIKE-2 (${version}): a client that declares no forms gets the part's own refusal through the router, byte for byte as direct`, async (t) => {
    const alone = await direct(t, 'gmail', { mode, capabilities: {} });
    const routed = await viaRouter(t, [part('gmail')], { mode, capabilities: {} });
    for (const side of [alone, routed])
      await side.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } }).catch(() => undefined);
    assert.equal(body(routed.wire.answers('tools/call')[0]), body(alone.wire.answers('tools/call')[0]));
    assert.deepEqual(routed.router.relayed, []);
  });
}

test('SPIKE-2 (2025-11-25): a relayed form needs the router to lift the SDK timeout, or the router itself answers the part', async (t) => {
  // With a 300 ms limit on the relayed request (the SDK default is 60 s) a person who takes 800 ms is cut off.
  const onElicit = async (params) => {
    await sleep(800);
    return accept(params);
  };
  const routed = await viaRouter(t, [part('gmail')], { onElicit, router: { forwardedRequestTimeoutMs: 300 } });
  const result = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Fulfilling input required by 'tools\/call' failed: .*timed out/iu);
  assert.deepEqual(routed.router.relayed, [{ part: 'gmail', method: 'elicitation/create', answeredBy: 'router' }]);
});

test('SPIKE-2: under serveStdio on 2026-07-28 getClientVersion() is never set, so Gmail as written today shows a modern client no form, direct or routed', async (t) => {
  const env = { FAKE_CLIENT_FROM: 'accessor' };
  const legacy = await direct(t, 'gmail', { env });
  const legacyResult = await legacy.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.equal(legacyResult.structuredContent.sent, true, '2025: initialize sets the accessor');
  const modern = await direct(t, 'gmail', { mode: 'auto', env });
  const modernResult = await modern.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.equal(modernResult.isError, true);
  assert.match(modernResult.content[0].text, /client ""/u, '2026-07-28 direct: the accessor is empty');
  const routed = await viaRouter(t, [part('gmail', env)], { mode: 'auto' });
  const routedResult = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.match(
    routedResult.content[0].text,
    /client ""/u,
    'the router changes nothing: the part must read the envelope',
  );
  assert.equal(modern.asked.length + routed.asked.length, 0);
});

// ---------------------------------------------------------------------------------------------------------- 3. tasks
/** A task's wire shape with its id and times taken out, to compare a routed task with a direct one. */
const shape = (message) =>
  JSON.stringify(message, (key, value) =>
    ['taskId', 'createdAt', 'lastUpdatedAt', 'id'].includes(key) ? `<${key}>` : value,
  );

test('SPIKE-3 (2026-07-28): an events_watch task is made, polled and completed through the router, in the same shapes as direct', async (t) => {
  const { raw } = await rawViaRouter(t, [part('slack'), part('gmail'), part('events')]);
  const alone = await rawDirect(t, 'events');
  const run = async (client) => {
    const steps = [await client.request('server/discover')];
    const watch = await client.request('tools/call', { name: 'events_watch', arguments: { lane: 'david' } });
    steps.push(watch);
    const taskId = watch.result.taskId;
    steps.push(await client.request('tasks/get', { taskId }));
    steps.push(await client.request('tools/call', { name: 'events_fire', arguments: { item: 'qi_1' } }));
    steps.push(await client.request('tasks/get', { taskId }));
    return steps;
  };
  const steps = await run(raw);
  const [discovered, watch, working, , done] = steps;
  assert.ok(TASKS_EXTENSION in discovered.result.capabilities.extensions, 'the router advertises the tasks extension');
  assert.equal(watch.result.resultType, 'task');
  assert.equal(watch.result.status, 'working');
  assert.equal(
    watch.result._meta['io.modelcontextprotocol/serverInfo'].name,
    'fake-events',
    "the part's identity kept",
  );
  assert.equal(working.result.status, 'working');
  assert.equal(done.result.status, 'completed');
  assert.deepEqual(done.result.result.structuredContent, { lane: 'david', item: 'qi_1' });
  // Everything after the handshake is the part's own answer, in the same shape as with no router.
  const expected = await run(alone);
  for (const index of [1, 2, 3, 4])
    assert.equal(shape(steps[index].result), shape(expected[index].result), `step ${index}`);
});

test('SPIKE-3 (2026-07-28): tasks/cancel reaches the part that made the task; a task id no part made is refused by the router', async (t) => {
  const { raw } = await rawViaRouter(t, [part('slack'), part('events')]);
  await raw.request('server/discover');
  const { taskId } = (await raw.request('tools/call', { name: 'events_watch', arguments: { lane: 'x' } })).result;
  assert.equal((await raw.request('tasks/cancel', { taskId })).result.resultType, 'complete');
  const seen = await raw.request('tools/call', { name: 'events_cancelled', arguments: {} });
  assert.deepEqual(seen.result.structuredContent.taskCancels, [taskId]);
  assert.equal(
    (await raw.request('tasks/get', { taskId })).result.status,
    'cancelled',
    "a poll after a cancel is the part's",
  );
  const unknown = await raw.request('tasks/get', { taskId: 'lt_none' });
  assert.deepEqual(unknown.error, { code: -32602, message: 'unknown task' });
});

test("SPIKE-3 (2026-07-28): a request that does not declare the tasks extension gets the part's own refusal, byte for byte as direct", async (t) => {
  const { raw } = await rawViaRouter(t, [part('events')]);
  const alone = await rawDirect(t, 'events');
  const answers = [];
  for (const client of [raw, alone]) {
    await client.request('server/discover', {}, { tasks: false });
    answers.push(
      await client.request('tools/call', { name: 'events_watch', arguments: { lane: 'x' } }, { tasks: false }),
    );
  }
  assert.equal(body(answers[0]), body(answers[1]));
  assert.equal(answers[0].result.isError, true);
});

test('SPIKE-3 (2026-07-28): a task id two parts both hand out is refused for the second, and cancelled in it', async (t) => {
  const { raw } = await rawViaRouter(t, [part('events'), part('watcher', { FAKE_PREFIX: 'watcher' }, 'events')]);
  await raw.request('server/discover');
  const first = await raw.request('tools/call', { name: 'events_watch', arguments: { lane: 'a' } });
  const second = await raw.request('tools/call', { name: 'watcher_watch', arguments: { lane: 'b' } });
  assert.equal(first.result.taskId, 'lt_0001', 'both stand-ins number their tasks from 1');
  assert.equal(second.result, undefined);
  assert.match(second.error.message, /task lt_0001 is already another part's: refused/u);
  await waitFor(async () => {
    const cancels = await raw.request('tools/call', { name: 'watcher_cancelled', arguments: {} });
    return cancels.result.structuredContent.taskCancels.includes(first.result.taskId);
  });
  assert.equal((await raw.request('tasks/get', { taskId: first.result.taskId })).result.status, 'working');
});

test("SPIKE-3: the SDK Client cannot be the router's link to a part: it refuses a task answer and has no option to take one", async (t) => {
  const alone = await direct(t, 'events', { mode: 'auto' });
  await assert.rejects(
    alone.client.callTool({ name: 'events_watch', arguments: { lane: 'x' } }),
    (error) => error.code === 'UNSUPPORTED_RESULT_TYPE',
  );
  await assert.rejects(
    alone.client.request(
      { method: 'tools/call', params: { name: 'events_watch', arguments: { lane: 'y' } } },
      PASSTHROUGH,
      {
        allowInputRequired: true,
      },
    ),
    (error) => error.code === 'UNSUPPORTED_RESULT_TYPE',
  );
});

test('SPIKE-3 (2026-07-28): no handler can serve tasks/list or tasks/result on 2026-07-28, so there is nothing to merge', async (t) => {
  // Design §5.3 merges tasks/list across parts. On this era the SDK answers both 2025-only methods itself.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serverStdio.serveStdio(
    () => {
      const server = new serverSdk.Server({ name: 'bare', version: '1' }, { capabilities: { tools: {} } });
      for (const method of ['tasks/list', 'tasks/result', 'tasks/get', 'tasks/update'])
        server.setRequestHandler(method, { params: z.looseObject({}) }, async () => ({ served: method }));
      return server;
    },
    { transport: serverSide },
  );
  const raw = await rawClient(clientSide);
  t.after(() => handle.close());
  await raw.request('server/discover');
  for (const method of ['tasks/list', 'tasks/result'])
    assert.deepEqual((await raw.request(method, { taskId: 'a' })).error, { code: -32601, message: 'Method not found' });
  for (const method of ['tasks/get', 'tasks/update'])
    assert.equal((await raw.request(method, { taskId: 'a' })).result.served, method);
});

test('SPIKE-3 (2026-07-28): the tasks extension is advertised only if Events is ready inside the start window', async (t) => {
  const { raw } = await rawViaRouter(t, [part('slack'), part('events', { FAKE_SLOW_START_MS: '1200' })], {
    router: { startWindowMs: 200 },
  });
  const discovered = await raw.request('server/discover');
  assert.equal(discovered.result.capabilities.extensions, undefined, 'fixed at the handshake, without Events');
  await waitFor(async () => {
    const listed = await raw.request('tools/list');
    return listed.result.tools.some((tool) => tool.name === 'events_watch');
  });
  // The request still declares the extension, so the late part answers with a task the handshake never offered.
  const watch = await raw.request('tools/call', { name: 'events_watch', arguments: { lane: 'x' } });
  assert.equal(watch.result.resultType, 'task');
});

// ------------------------------------------------------------------------------------------------- 4. list_changed
for (const { mode, version } of ERAS) {
  const watching = (lists) => ({
    tools: { debounceMs: 0, onChanged: (error, tools) => lists.push(error ?? tools.map((tool) => tool.name)) },
  });
  const latest = (lists) => lists.at(-1) ?? [];

  test(`SPIKE-4 (${version}): adding and removing a part emits tools/list_changed, and the SDK client sees each new list`, async (t) => {
    const lists = [];
    const routed = await viaRouter(t, [part('slack')], { mode, listChanged: watching(lists) });
    assert.equal(routed.client.getServerCapabilities().tools.listChanged, true);
    await routed.router.addPart(part('gmail'));
    await waitFor(() => latest(lists).includes('gmail_whoami'));
    await routed.router.removePart('gmail');
    await waitFor(() => lists.length >= 2 && !latest(lists).includes('gmail_whoami'));
    assert.ok(latest(lists).includes('slack_echo'));
  });

  test(`SPIKE-4 (${version}): a part's own list_changed comes up through the router`, async (t) => {
    const lists = [];
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode, listChanged: watching(lists) });
    await routed.client.callTool({ name: 'slack_add_tool', arguments: {} });
    await waitFor(() => latest(lists).includes('slack_late'));
    const late = await routed.client.callTool({ name: 'slack_late', arguments: {} });
    assert.equal(late.content[0].text, 'late');
  });

  test(`SPIKE-4 (${version}): a part that misses the start window is left out of the handshake and joins later with list_changed`, async (t) => {
    const lists = [];
    const started = Date.now();
    const routed = await viaRouter(t, [part('slack'), part('gmail', { FAKE_SLOW_START_MS: '1500' })], {
      mode,
      listChanged: watching(lists),
      router: { startWindowMs: 300 },
    });
    assert.ok(Date.now() - started < 1_500, 'the handshake did not wait for the slow part');
    const first = (await routed.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(
      first.some((name) => name.startsWith('gmail_')),
      false,
    );
    assert.match(routed.client.getInstructions() ?? '', /gmail: starting/u);
    await waitFor(() => latest(lists).includes('gmail_whoami'));
  });
}

// ------------------------------------------------------------------------------------------ 5. crash and slowness
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

for (const { mode, version } of ERAS) {
  test(`SPIKE-5 (${version}): a part that exits mid-call fails that call at once, saying so; the other parts keep working`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode });
    const started = Date.now();
    await assert.rejects(
      routed.client.callTool({ name: 'slack_exit', arguments: {} }),
      (error) => error.code === -32603 && /slack stopped in this connection/u.test(error.message),
    );
    assert.ok(Date.now() - started < 5_000);
    const who = await routed.client.callTool({ name: 'gmail_whoami', arguments: {} });
    assert.notEqual(who.isError, true);
    // Its tools stay listed, so a later call says why rather than "no such tool".
    const listed = await routed.client.listTools(undefined, { cacheMode: 'bypass' });
    assert.ok(listed.tools.some((tool) => tool.name === 'slack_echo'));
    await assert.rejects(
      routed.client.callTool({ name: 'slack_echo', arguments: { text: 'x' } }),
      /slack stopped in this connection/u,
    );
    assert.equal(routed.router.parts.get('slack').state, 'stopped');
  });

  test(`SPIKE-5 (${version}): a part that hangs holds up nothing else; the client's own timeout ends the call and its cancel reaches that part`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode });
    const hanging = routed.client.callTool({ name: 'slack_hang', arguments: {} }, { timeout: 800 });
    const [who, echo] = await Promise.all([
      routed.client.callTool({ name: 'gmail_whoami', arguments: {} }),
      routed.client.callTool({ name: 'slack_echo', arguments: { text: 'meanwhile' } }),
    ]);
    assert.notEqual(who.isError, true);
    assert.equal(echo.structuredContent.echo, 'meanwhile', 'even the hanging part answers its other calls');
    await assert.rejects(hanging, (error) => error.code === 'REQUEST_TIMEOUT');
    await waitFor(async () => {
      const seen = await routed.client.callTool({ name: 'slack_cancelled', arguments: {} });
      return seen.structuredContent.cancelled.length === 1;
    });
  });
}

test('SPIKE-5: a part that exits at start, or never finishes its handshake, leaves the rest serving, and calls to it say why', async (t) => {
  const started = Date.now();
  const routed = await viaRouter(
    t,
    [part('slack'), part('gmail', { FAKE_EXIT_AT_START: '1' }), part('events', { FAKE_SLOW_START_MS: '60000' })],
    { router: { startWindowMs: 300, joinWindowMs: 900 } },
  );
  assert.ok(Date.now() - started < 3_000);
  const names = (await routed.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.every((name) => name.startsWith('slack_')));
  const instructions = routed.client.getInstructions() ?? '';
  assert.match(instructions, /gmail: stopped/u);
  assert.match(instructions, /events: starting/u);
  await waitFor(() => routed.router.parts.get('events').state === 'stopped', 3_000);
  await assert.rejects(routed.client.callTool({ name: 'gmail_whoami', arguments: {} }), /gmail stopped/u);
  await assert.rejects(routed.client.callTool({ name: 'events_status', arguments: {} }), /events stopped/u);
  const echo = await routed.client.callTool({ name: 'slack_echo', arguments: { text: 'still here' } });
  assert.equal(echo.structuredContent.echo, 'still here');
});

for (const { mode, version } of ERAS) {
  test(`SPIKE-0 (${version}): the router as a program on real stdio serves every part's tools and Gmail's form`, async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [GATEWAY],
      env: { ...baseEnv(), SPIKE_PARTS: JSON.stringify([part('slack'), part('gmail'), part('events')]) },
      stderr: 'ignore',
    });
    const { client, asked } = await connect(t, transport, { mode });
    assert.equal(client.getNegotiatedProtocolVersion(), version);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const prefix of ['slack_', 'gmail_', 'events_']) assert.ok(names.some((name) => name.startsWith(prefix)));
    const sent = await client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'stdio' } });
    assert.equal(sent.structuredContent.sent, true);
    assert.equal(asked.length, 1);
  });
}

test('SPIKE-5: a router killed with SIGKILL leaves no part running: each part ends when its stdin closes', {
  skip: process.platform === 'win32' ? 'POSIX signals; Windows needs the kill-by-handle test the design names' : false,
}, async (t) => {
  const status = join(home, 'status.json');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [GATEWAY],
    env: {
      ...baseEnv(),
      SPIKE_PARTS: JSON.stringify([part('slack'), part('gmail'), part('events')]),
      SPIKE_STATUS_FILE: status,
    },
    stderr: 'ignore',
  });
  const { client } = await connect(t, transport);
  assert.ok((await client.listTools()).tools.length > 10);
  await waitFor(() => existsSync(status));
  const pids = JSON.parse(await readFile(status, 'utf8'));
  const parts = Object.values(pids.parts);
  assert.equal(parts.length, 3);
  assert.ok(parts.every(alive));
  process.kill(pids.gateway, 'SIGKILL');
  await waitFor(() => parts.every((pid) => !alive(pid)), 5_000);
});
