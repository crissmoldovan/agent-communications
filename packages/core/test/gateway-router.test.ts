import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { gatewayInstructions } from '../src/gateway/instructions.ts';
import { type PartSpec, Router, type RouterOptions } from '../src/gateway/router.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The gateway's router (single-server design D1–D5, D13, §4–§5), against stand-in parts that are real child processes,
 * in both protocol eras: tools pass through byte for byte, each part owns its prefix, approval forms and tasks are
 * relayed, a part that crashes or hangs holds up nothing else, and no part is given the connection's key. Ported from
 * the spike's tests (`spikes/single-server/single-server.test.mjs`), with the restart, refusal and key cases the spike
 * did not build. Every process gets a temporary HOME; nothing talks to any service.
 */

const FAKE = fileURLToPath(new URL('./helpers/gateway/fake-part.ts', import.meta.url));
const ERAS = [
  { mode: 'legacy', version: '2025-11-25' },
  { mode: 'auto', version: '2026-07-28' },
] as const;
type Mode = (typeof ERAS)[number]['mode'];
const CLIENT = { name: 'claude-code', version: '2.1.310' };
const TASKS = 'io.modelcontextprotocol/tasks';
const CAPABILITIES = { elicitation: { form: {} }, extensions: { [TASKS]: {} } };
const HOME = tempDir('comms-gateway-');

const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? '', HOME, USERPROFILE: HOME });
const STRIP = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function part(server: string, env: NodeJS.ProcessEnv = {}, kind: string = server, prefix: string = server): PartSpec {
  return {
    server,
    label: server,
    prefix,
    command: process.execPath,
    args: [...STRIP, FAKE, kind],
    env: { ...baseEnv(), ...env },
  };
}

interface Wire {
  inbound: Record<string, unknown>[];
  outbound: Record<string, unknown>[];
  answers: (method: string) => (Record<string, unknown> | undefined)[];
}

/** Records every message either way, so the client's view of the wire can be compared with a direct one. */
function tap(inner: InMemoryTransport | StdioClientTransport) {
  const inbound: Record<string, unknown>[] = [];
  const outbound: Record<string, unknown>[] = [];
  const transport = {
    onmessage: undefined as ((message: unknown, extra?: unknown) => void) | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    start: () => inner.start(),
    send: (message: unknown, options?: unknown) => {
      outbound.push(message as Record<string, unknown>);
      return inner.send(message as never, options as never);
    },
    close: () => inner.close(),
    setProtocolVersion: (version: string) =>
      (inner as { setProtocolVersion?: (v: string) => void }).setProtocolVersion?.(version),
    get sessionId() {
      return (inner as { sessionId?: string }).sessionId;
    },
  };
  inner.onmessage = (message: unknown, extra?: unknown) => {
    inbound.push(message as Record<string, unknown>);
    transport.onmessage?.(message, extra);
  };
  inner.onclose = () => transport.onclose?.();
  inner.onerror = (error: Error) => transport.onerror?.(error);
  const wire: Wire = {
    inbound,
    outbound,
    answers: (method) =>
      outbound
        .filter((message) => message.method === method && message.id !== undefined)
        .map((request) =>
          inbound.find((message) => message.id === request.id && ('result' in message || 'error' in message)),
        ),
  };
  return { transport, wire };
}

interface Connected {
  client: Client;
  wire: Wire;
  asked: Record<string, unknown>[];
}

async function connect(
  t: TestContext,
  inner: InMemoryTransport | StdioClientTransport,
  options: {
    mode?: Mode;
    clientInfo?: { name: string; version: string };
    capabilities?: Record<string, unknown>;
    listChanged?: Record<string, unknown>;
    onElicit?: (params: Record<string, unknown>) => Promise<unknown> | unknown;
  } = {},
): Promise<Connected> {
  const { transport, wire } = tap(inner);
  const capabilities = options.capabilities ?? CAPABILITIES;
  const client = new Client(options.clientInfo ?? CLIENT, {
    versionNegotiation: { mode: options.mode ?? 'legacy' },
    capabilities,
    ...(options.listChanged === undefined ? {} : { listChanged: options.listChanged }),
  } as never);
  const asked: Record<string, unknown>[] = [];
  if (capabilities.elicitation !== undefined) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as Record<string, unknown>;
      asked.push(params);
      if (options.onElicit) return (await options.onElicit(params)) as never;
      const code = /Type (\S+) to send/u.exec(String(params.message))?.[1];
      return { action: 'accept', content: { code } } as never;
    });
  }
  await client.connect(transport as never);
  t.after(() => client.close().catch(() => undefined));
  return { client, wire, asked };
}

async function viaRouter(
  t: TestContext,
  parts: PartSpec[],
  options: Parameters<typeof connect>[2] & { router?: Partial<RouterOptions> } = {},
) {
  const lines: string[] = [];
  const router = new Router({
    parts,
    connectionId: 'cn_0123456789ABCDEFGHJKMNPQRS',
    serverInfo: { name: 'agentcomms', version: '0.35.0' },
    instructions: (input) => gatewayInstructions('Test', input),
    log: (line) => lines.push(line),
    ...options.router,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await router.serve(serverSide);
  t.after(() => router.close());
  return { ...(await connect(t, clientSide, options)), router, lines };
}

async function direct(
  t: TestContext,
  kind: string,
  options: Parameters<typeof connect>[2] & { env?: NodeJS.ProcessEnv } = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...STRIP, FAKE, kind],
    env: { ...baseEnv(), ...(options.env ?? {}) } as Record<string, string>,
    stderr: 'ignore',
  });
  return connect(t, transport, options);
}

const body = (message: Record<string, unknown> | undefined) => {
  const { jsonrpc: _jsonrpc, id: _id, ...rest } = message ?? {};
  return JSON.stringify(rest);
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting');
}

const callError = async (promise: Promise<unknown>): Promise<{ code?: unknown; message: string }> => {
  try {
    await promise;
  } catch (error) {
    return error as { code?: unknown; message: string };
  }
  throw new Error('the call did not fail');
};

for (const { mode, version } of ERAS) {
  test(`D4 (${version}): tools/list through the router is each part's own, tool for tool and byte for byte`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('events')], { mode });
    assert.equal(routed.client.getNegotiatedProtocolVersion(), version);
    const expected: unknown[] = [];
    for (const kind of ['slack', 'events']) {
      const alone = await direct(t, kind, { mode });
      await alone.client.listTools();
      expected.push(
        ...((alone.wire.answers('tools/list')[0]?.result as { tools?: unknown[] } | undefined)?.tools ?? []),
      );
    }
    await routed.client.listTools();
    const got = (routed.wire.answers('tools/list')[0]?.result as { tools?: unknown[] } | undefined)?.tools ?? [];
    assert.equal(got.length, expected.length);
    for (const [index, tool] of got.entries()) assert.equal(JSON.stringify(tool), JSON.stringify(expected[index]));
  });

  test(`D4 (${version}): results, structured content, _meta and errors arrive as the part sent them, byte for byte`, async (t) => {
    const calls: [string, Record<string, unknown>][] = [
      ['slack_echo', { text: 'hello', mode: 'loud' }],
      ['slack_rich', {}],
      ['slack_throw', {}],
    ];
    const alone = await direct(t, 'slack', { mode });
    const routed = await viaRouter(t, [part('slack')], { mode });
    for (const [name, args] of calls) {
      for (const side of [alone, routed]) {
        await side.client
          .callTool({ name, arguments: args, _meta: { 'example.org/trace': 't-1' } })
          .catch(() => undefined);
      }
    }
    const expected = alone.wire.answers('tools/call');
    const got = routed.wire.answers('tools/call');
    for (const [index, [name]] of calls.entries()) assert.equal(body(got[index]), body(expected[index]), name);
  });

  test(`D5 (${version}): a part cannot answer for another prefix: its foreign tools are dropped, and calls reach the owner`, async (t) => {
    // The rogue part comes first, so without the prefix filter its `slack_echo` would win.
    const routed = await viaRouter(t, [part('gmail', { FAKE_ROGUE: '1' }), part('slack'), part('events')], { mode });
    const names = (await routed.client.listTools()).tools.map((tool) => tool.name);
    assert.equal(names.filter((name) => name === 'slack_echo').length, 1);
    assert.equal(names.includes('comms_doctor'), false);
    const echo = await routed.client.callTool({ name: 'slack_echo', arguments: { text: 'who' } });
    assert.equal((echo.structuredContent as { servedBy: string }).servedBy, 'slack');
    const status = await routed.client.callTool({ name: 'events_status', arguments: {} });
    assert.deepEqual(status.structuredContent, { owner: 'not-running' });
    const missing = await callError(routed.client.callTool({ name: 'comms_doctor', arguments: {} }));
    assert.match(missing.message, /Tool comms_doctor not found/u);
    assert.deepEqual(routed.router.dropped.map((drop) => drop.tool).sort(), [
      'comms_doctor',
      'events_status',
      'slack_echo',
    ]);
    assert.match(routed.lines.join('\n'), /\[gateway:gmail\] dropped a tool outside its prefix gmail_/);
  });

  test(`§5.5 (${version}): Gmail's approval form reaches the client through the router, and the answer reaches Gmail`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode });
    const result = await routed.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd1' } });
    assert.equal(routed.asked.length, 1, 'the client was asked once');
    assert.deepEqual(result.structuredContent, { sent: true, typed: 'XK-d1', client: 'claude-code' });
    if (mode === 'legacy') {
      assert.deepEqual(routed.router.relayed, [
        { server: 'gmail', method: 'elicitation/create', answeredBy: 'client' },
      ]);
    } else {
      // 2026-07-28: the form in the result and the answer in the client's own retry; the router asks nothing itself.
      assert.deepEqual(routed.router.relayed, []);
      assert.equal(
        (routed.wire.answers('tools/call')[0]?.result as { resultType?: string } | undefined)?.resultType,
        'input_required',
      );
    }
  });

  test(`D7 (${version}): a part sees the client's own name, never the gateway's, exactly as direct`, async (t) => {
    const alone = await direct(t, 'gmail', { mode });
    const routed = await viaRouter(t, [part('gmail')], { mode });
    const expected = (await alone.client.callTool({ name: 'gmail_whoami', arguments: {} })).structuredContent;
    const got = (await routed.client.callTool({ name: 'gmail_whoami', arguments: {} })).structuredContent as Record<
      string,
      unknown
    >;
    assert.deepEqual(got, expected);
    assert.deepEqual(mode === 'legacy' ? got.getClientVersion : got.envelopeClientInfo, CLIENT);
    assert.deepEqual(routed.router.client(), CLIENT);
  });

  test(`D15 (${version}): adding and removing a part emits tools/list_changed, and the client sees each list`, async (t) => {
    const lists: string[][] = [];
    const routed = await viaRouter(t, [part('slack')], {
      mode,
      listChanged: {
        tools: {
          debounceMs: 0,
          onChanged: (_e: unknown, tools: { name: string }[]) => lists.push(tools.map((x) => x.name)),
        },
      },
    });
    await routed.router.addPart(part('gmail'));
    await waitFor(() => (lists.at(-1) ?? []).includes('gmail_whoami'));
    await routed.router.removePart('gmail');
    await waitFor(() => lists.length >= 2 && !(lists.at(-1) ?? []).includes('gmail_whoami'));
    // A part's own list_changed comes up through the router too.
    await routed.client.callTool({ name: 'slack_add_tool', arguments: {} });
    await waitFor(() => (lists.at(-1) ?? []).includes('slack_late'));
  });

  test(`§4 (${version}): a part that hangs holds up nothing else; the client's timeout ends it and its cancel reaches it`, async (t) => {
    const routed = await viaRouter(t, [part('slack'), part('gmail')], { mode });
    const hanging = routed.client.callTool({ name: 'slack_hang', arguments: {} }, { timeout: 800 });
    const [who, echo] = await Promise.all([
      routed.client.callTool({ name: 'gmail_whoami', arguments: {} }),
      routed.client.callTool({ name: 'slack_echo', arguments: { text: 'meanwhile' } }),
    ]);
    assert.notEqual(who.isError, true);
    assert.equal((echo.structuredContent as { echo: string }).echo, 'meanwhile');
    await assert.rejects(hanging);
    await waitFor(async () => {
      const seen = await routed.client.callTool({ name: 'slack_cancelled', arguments: {} });
      return (seen.structuredContent as { cancelled: string[] }).cancelled.length === 1;
    });
  });
}

test('§4: a part that crashes fails its call at once, is started again with its tools still listed, and is given up after three', async (t) => {
  const lists: string[][] = [];
  const routed = await viaRouter(t, [part('slack'), part('gmail')], {
    router: { restartDelaysMs: [100, 100, 100], maxCrashes: 3, crashWindowMs: 60_000 },
    listChanged: {
      tools: {
        debounceMs: 0,
        onChanged: (_e: unknown, tools: { name: string }[]) => lists.push(tools.map((x) => x.name)),
      },
    },
  });
  const started = Date.now();
  const first = await callError(routed.client.callTool({ name: 'slack_exit', arguments: {} }));
  assert.ok(Date.now() - started < 5_000, 'the call fails at once, not at a timeout');
  assert.equal(first.code, -32603);
  assert.match(
    first.message,
    /slack stopped in this connection; Agent Comms is starting it again, and does not repeat this call/u,
  );
  // While it starts again its tools stay listed, and a call says why rather than "no such tool".
  const listed = await routed.client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === 'slack_echo'));
  // It is started again, and serves.
  await waitFor(async () => {
    const echo = await routed.client.callTool({ name: 'slack_echo', arguments: { text: 'back' } }).catch(() => null);
    return (echo?.structuredContent as { echo?: string } | undefined)?.echo === 'back';
  });
  // The other part was never touched.
  assert.notEqual((await routed.client.callTool({ name: 'gmail_whoami', arguments: {} })).isError, true);
  // Two more crashes inside the window: given up, and its tools go, with list_changed.
  await callError(routed.client.callTool({ name: 'slack_exit', arguments: {} }));
  await waitFor(async () => routed.router.status().find((each) => each.server === 'slack')?.state === 'running');
  await callError(routed.client.callTool({ name: 'slack_exit', arguments: {} }));
  await waitFor(() => routed.router.status().find((each) => each.server === 'slack')?.state === 'stopped');
  await waitFor(() => lists.length > 0 && !(lists.at(-1) ?? []).some((name) => name.startsWith('slack_')));
  const after = await callError(routed.client.callTool({ name: 'slack_echo', arguments: { text: 'x' } }));
  assert.match(
    after.message,
    /slack stopped in this connection, and Agent Comms starts it again only when the connection changes or the app restarts/u,
  );
  assert.match(routed.router.status().find((each) => each.server === 'slack')?.why ?? '', /given up/);
  assert.notEqual((await routed.client.callTool({ name: 'gmail_whoami', arguments: {} })).isError, true);
});

test('§4: a part that exits at start, or never finishes its handshake, leaves the rest serving, and calls to it say why', async (t) => {
  const started = Date.now();
  const routed = await viaRouter(
    t,
    [part('slack'), part('gmail', { FAKE_EXIT_AT_START: '1' }), part('events', { FAKE_SLOW_START_MS: '60000' })],
    {
      router: { startWindowMs: 400, joinWindowMs: 6_000, restartDelaysMs: [60_000] },
    },
  );
  assert.ok(Date.now() - started < 8_000, 'the handshake did not wait for them');
  const names = (await routed.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(
    names.every((name) => name.startsWith('slack_')),
    names.join(', '),
  );
  const instructions = routed.client.getInstructions() ?? '';
  // Named as starting — or starting again, after its exit — at the handshake; on a busy machine slack may be too.
  assert.match(instructions, /Starting: [^\n]*\bgmail\b/u);
  assert.match(instructions, /Starting: [^\n]*\bevents\b/u);
  await waitFor(() => routed.router.status().find((each) => each.server === 'events')?.state === 'stopped', 30_000);
  assert.match(
    (await callError(routed.client.callTool({ name: 'events_status', arguments: {} }))).message,
    /events did not start in this connection/u,
  );
  assert.match(
    (await callError(routed.client.callTool({ name: 'gmail_whoami', arguments: {} }))).message,
    // Exited and given up, or — on a busy machine — not even started within the join window: either says why.
    /gmail (stopped|did not start) in this connection/u,
  );
  const echo = await routed.client.callTool({ name: 'slack_echo', arguments: { text: 'still here' } });
  assert.equal((echo.structuredContent as { echo: string }).echo, 'still here');
});

test('§4: a part that misses the start window joins later with list_changed, and a call to it waits for it', async (t) => {
  const lists: string[][] = [];
  const routed = await viaRouter(t, [part('slack'), part('gmail', { FAKE_SLOW_START_MS: '1200' })], {
    router: { startWindowMs: 200 },
    listChanged: {
      tools: {
        debounceMs: 0,
        onChanged: (_e: unknown, tools: { name: string }[]) => lists.push(tools.map((x) => x.name)),
      },
    },
  });
  assert.equal(
    (await routed.client.listTools()).tools.some((tool) => tool.name.startsWith('gmail_')),
    false,
  );
  // A client that knows the tool already is not refused while the part starts: the call waits for it.
  const who = await routed.client.callTool({ name: 'gmail_whoami', arguments: {} });
  assert.notEqual(who.isError, true);
  await waitFor(() => (lists.at(-1) ?? []).includes('gmail_whoami'));
});

test('§4: a part is started without the connection key or the launcher name, and knows its gateway and connection', async (t) => {
  const env = {
    AGENT_COMMS_CONNECTION_KEY: 'ack_not-a-real-key-for-a-test-only-000000000',
    AGENT_COMMS_LAUNCHER: 'core',
  };
  const routed = await viaRouter(t, [part('slack', env)]);
  const seen = (await routed.client.callTool({ name: 'slack_env', arguments: {} })).structuredContent as Record<
    string,
    unknown
  >;
  assert.equal(seen.hasConnectionKey, false);
  assert.equal(seen.hasLauncher, false);
  assert.equal(seen.gatewayPid, String(process.pid));
  assert.equal(seen.connection, 'cn_0123456789ABCDEFGHJKMNPQRS');
  assert.equal(seen.ppid, process.pid);
});

test('§5.3 (2026-07-28): an events_watch task is made, polled and completed through the router; a task no part made is refused', async (t) => {
  // The SDK client cannot take a task answer (the spike's finding 3), so this speaks the wire itself.
  const raw = await rawViaRouter(t, [part('slack'), part('events')], { extensions: { [TASKS]: {} } });
  const discovered = await raw('server/discover', {});
  assert.ok(
    TASKS in (discovered.result as { capabilities: { extensions: Record<string, unknown> } }).capabilities.extensions,
  );
  const watch = (await raw('tools/call', { name: 'events_watch', arguments: { lane: 'david' } })).result as Record<
    string,
    unknown
  >;
  assert.equal(watch.resultType, 'task');
  const taskId = String(watch.taskId);
  assert.equal(((await raw('tasks/get', { taskId })).result as { status: string }).status, 'working');
  await raw('tools/call', { name: 'events_fire', arguments: { item: 'qi_1' } });
  const done = (await raw('tasks/get', { taskId })).result as {
    status: string;
    result: { structuredContent: unknown };
  };
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result.structuredContent, { lane: 'david', item: 'qi_1' });
  assert.deepEqual((await raw('tasks/get', { taskId: 'lt_none' })).error, { code: -32602, message: 'unknown task' });
});

test('§4 (2026-07-28): the tasks extension the connection declares is advertised even when Events is late', async (t) => {
  const raw = await rawViaRouter(t, [part('slack'), part('events', { FAKE_SLOW_START_MS: '1500' })], {
    extensions: { [TASKS]: {} },
    startWindowMs: 200,
  });
  const discovered = await raw('server/discover', {});
  assert.ok(
    TASKS in
      ((discovered.result as { capabilities: { extensions?: Record<string, unknown> } }).capabilities.extensions ?? {}),
  );
});

test('D15: a connection cut off stops every part at once, lists nothing, and refuses each later call with why', async (t) => {
  const routed = await viaRouter(t, [part('slack'), part('gmail')]);
  assert.ok((await routed.client.listTools()).tools.length > 0);
  const pids = routed.router.status().map((each) => each.pid);
  await routed.router.refuse('this connection was cut off');
  assert.deepEqual((await routed.client.listTools()).tools, []);
  const refused = await callError(routed.client.callTool({ name: 'slack_echo', arguments: { text: 'x' } }));
  assert.match(refused.message, /this connection was cut off/u);
  assert.ok(routed.router.status().every((each) => each.state === 'stopped'));
  await waitFor(() => pids.every((pid) => pid === null || !alive(pid)));
});

test('D15: a second refusal while the first is stopping the parts waits for it, and a call it refuses is answered after', async (t) => {
  /*
   * The timer's look and a request's look can both find the replaced key. The second `refuse` returned at once — the
   * refusal was set — so its call was answered "replaced" while the first was still stopping the parts (the flake in
   * gateway-serve.test.ts, "every part stopped", about 1 run in 2 once requests waited for the timer's look).
   */
  const routed = await viaRouter(t, [part('slack'), part('gmail')]);
  assert.ok((await routed.client.listTools()).tools.length > 0);
  const first = routed.router.refuse('this connection was cut off');
  const second = routed.router.refuse('this connection was cut off');
  await second;
  assert.ok(
    routed.router.status().every((each) => each.state === 'stopped'),
    JSON.stringify(routed.router.status().map((each) => each.state)),
  );
  await first;
});

test('§4: a client relay keeps the SDK timeout lifted: a person slower than it is cut off only when the relay times out', async (t) => {
  // A 300 ms relay limit (the SDK default is 60 s, the gateway's 10 min) shows the failure the lift prevents.
  const slow = async (params: Record<string, unknown>) => {
    await sleep(800);
    return { action: 'accept', content: { code: /Type (\S+) to send/u.exec(String(params.message))?.[1] } };
  };
  const cut = await viaRouter(t, [part('gmail')], { onElicit: slow, router: { forwardedRequestTimeoutMs: 300 } });
  const refused = await cut.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.equal(refused.isError, true);
  assert.deepEqual(cut.router.relayed, [{ server: 'gmail', method: 'elicitation/create', answeredBy: 'router' }]);
  const lifted = await viaRouter(t, [part('gmail')], { onElicit: slow });
  const sent = await lifted.client.callTool({ name: 'gmail_draft_send', arguments: { draftId: 'd' } });
  assert.equal((sent.structuredContent as { sent: boolean }).sent, true);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A router served to a 2026-07-28 client written by hand, as the spike's `raw-client.mjs` is: every request carries its envelope. */
async function rawViaRouter(t: TestContext, parts: PartSpec[], options: Partial<RouterOptions> = {}) {
  const router = new Router({
    parts,
    connectionId: 'cn_0123456789ABCDEFGHJKMNPQRS',
    serverInfo: { name: 'agentcomms', version: '0.35.0' },
    instructions: (input) => gatewayInstructions('Test', input),
    log: () => undefined,
    ...options,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await router.serve(serverSide);
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  clientSide.onmessage = (message) => {
    const held = message as Record<string, unknown>;
    if (typeof held.id === 'number' && ('result' in held || 'error' in held)) waiters.get(held.id)?.(held);
  };
  await clientSide.start();
  t.after(async () => {
    await clientSide.close();
    await router.close();
  });
  let next = 0;
  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': CLIENT,
    'io.modelcontextprotocol/clientCapabilities': { extensions: { [TASKS]: {} } },
  };
  return (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    next += 1;
    const id = next;
    return new Promise((resolve) => {
      waiters.set(id, resolve);
      void clientSide.send({ jsonrpc: '2.0', id, method, params: { ...params, _meta: envelope } } as never);
    });
  };
}
