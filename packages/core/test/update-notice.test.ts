import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Streams } from '../src/cli-runtime.ts';
import { type CommsError, ERROR_REGISTRY, EXIT_CODES } from '../src/errors.ts';
import { strictToolArguments } from '../src/tool-arguments.ts';
import { serverNoticeLine, updateNoticeAtTerminal, updateToolNotice } from '../src/update-gate.ts';
import { readUpdateCheck, UPDATE_STARTED_BY_ENV } from '../src/update-state.ts';
import { VERSION } from '../src/version.ts';
import { assertNoBareCommand, coreInline } from './helpers/handoffs.ts';
import { codeOf, connect, deps, LATEST, machine, seed, type ToolResult, textsOf } from './helpers/update-machine.ts';

/*
 * The update notice (design 2026-10-16, U1): nothing is refused for being behind. A server's first tool result of its
 * process carries one line, as an `update` field beside the result and a text block of its own; a command prints the
 * same line once on stderr, at most once a day for the machine, and runs.
 *
 * Nothing here reaches npm: every machine's registry is a port nobody answers on, and the state file is seeded.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const OUT = `agent-communications ${LATEST} is out; say "update" when it suits you.`;

test('no tool is refused for being behind: the first result carries the notice, once, and every other carries none', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  // A registry that answers, for the update's own check.
  const { call, close } = await connect(m, { update: deps(async () => LATEST) });
  try {
    // The update's own tool, the doctor and the paths keep working as they do, and do not use the notice up.
    for (const [name, args] of [
      ['comms_update', { check: true }],
      ['comms_doctor', {}],
      ['comms_paths', {}],
    ] as const) {
      const result = await call(name, args);
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.structuredContent)}`);
      assert.equal(result.structuredContent?.update, undefined, `${name} carried the notice`);
    }
    const first = await call('comms_channels_available');
    assert.notEqual(first.isError, true, JSON.stringify(first.structuredContent));
    assert.notEqual(codeOf(first), 'UPDATE_REQUIRED');
    assert.equal(first.structuredContent?.update, OUT);
    // Beside the result, not instead of it: the result is all there, and a client that shows only text reads the line.
    assert.ok(Array.isArray(first.structuredContent?.channels), JSON.stringify(first.structuredContent));
    assert.ok(textsOf(first).includes(OUT), textsOf(first));
    // That process never repeats it.
    for (const name of ['comms_channels_available', 'comms_audit_tail', 'comms_approvals_list']) {
      const later = await call(name);
      assert.notEqual(later.isError, true, `${name}: ${JSON.stringify(later.structuredContent)}`);
      assert.equal(later.structuredContent?.update, undefined, `${name} repeated the notice`);
      assert.ok(!textsOf(later).includes(OUT), `${name} repeated the notice in its text`);
    }
  } finally {
    await close();
  }
  // Another process — another server on the same machine — says it once of its own.
  const again = await connect(m);
  try {
    assert.equal((await again.call('comms_audit_tail')).structuredContent?.update, OUT);
  } finally {
    await again.close();
  }
});

test('an update installed but not yet loaded: the notice says to restart, and nothing is refused', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: false, current: { registered: ['core'], global: [] } });
  const { call, close } = await connect(m);
  try {
    const result = await call('comms_audit_tail');
    assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    assert.equal(
      result.structuredContent?.update,
      `agent-communications ${LATEST} is installed; restart the client (in Claude Code, /mcp → Reconnect) to use it.`,
    );
  } finally {
    await close();
  }
});

test('nothing newer, or a prerelease named latest: no notice at all', async () => {
  for (const latest of [VERSION, '99.0.0-rc.1']) {
    const m = machine();
    await seed(m, { latest, behind: false });
    const { call, close } = await connect(m);
    try {
      const result = await call('comms_audit_tail');
      assert.equal(result.structuredContent?.update, undefined, latest);
    } finally {
      await close();
    }
  }
});

test('a command that is behind runs, and says so once on stderr — not again that day on this machine', () => {
  const m = machine();
  const run = (args: string[]) =>
    spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
      encoding: 'utf8',
      env: { ...m.env, CLAUDECODE: '1' },
    });
  return seed(m, { latest: LATEST, behind: true }).then(async () => {
    const first = run(['channels', '--json']);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal((JSON.parse(first.stdout) as { ok: boolean }).ok, true, 'the command ran, and printed its result');
    const update = coreInline(m.core.paths, ['update']);
    assert.ok(
      first.stderr.includes(
        `agent-communications ${LATEST} is out (this is ${VERSION}); run ${update} when it suits you.`,
      ),
      first.stderr,
    );
    assert.doesNotMatch(first.stdout, /is out/, 'the line is on stderr, never in the result');
    // The rest of the day: the command runs and says nothing — a second command, and a third.
    for (const args of [
      ['channels', '--json'],
      ['audit', 'tail'],
    ]) {
      const next = run(args);
      assert.equal(next.status, 0, next.stdout + next.stderr);
      assert.doesNotMatch(next.stderr, /is out/, `${args.join(' ')} repeated the notice`);
    }
    assert.notEqual((await readUpdateCheck(m.stateDir)).latest, null);
  });
});

test('the stop’s error and its exit status are retired', () => {
  assert.equal(Object.hasOwn(ERROR_REGISTRY, 'UPDATE_REQUIRED'), false);
  assert.equal(Object.hasOwn(EXIT_CODES, 'UPDATE'), false);
  assert.ok(!Object.values(ERROR_REGISTRY).some((spec) => spec.exit === 11), 'nothing exits 11');
});

// ── The pieces ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a tool with an output schema publishes room for the notice, and a client that checks the schema takes it', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const server = new McpServer({ name: 'notice-test', version: '0' });
  const fail = (error: CommsError) => ({ isError: true, content: [{ type: 'text', text: error.message }] });
  strictToolArguments(
    server,
    fail,
    updateToolNotice({ core: m.core, env: m.env, channel: 'gmail', running: VERSION, exempt: [] }),
  );
  const result = (structuredContent: Record<string, unknown>) => ({
    structuredContent,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
  });
  server.registerTool('strict_object', { inputSchema: {}, outputSchema: z.object({ ok: z.boolean() }) }, async () =>
    result({ ok: true }),
  );
  server.registerTool(
    'union',
    { inputSchema: {}, outputSchema: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]) },
    async () => result({ b: 1 }),
  );
  server.registerTool('owns_update', { inputSchema: {}, outputSchema: z.object({ update: z.string() }) }, async () =>
    result({ update: 'its own' }),
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    const schemaOf = (name: string) =>
      listed.tools.find((tool) => tool.name === name)?.outputSchema as
        | { properties?: Record<string, unknown>; anyOf?: { properties?: Record<string, unknown> }[] }
        | undefined;
    assert.ok(schemaOf('strict_object')?.properties?.update, JSON.stringify(schemaOf('strict_object')));
    assert.ok(
      schemaOf('union')?.anyOf?.every((side) => side.properties?.update !== undefined),
      JSON.stringify(schemaOf('union')),
    );
    // The client checks each result against the schema it was given: the one carrying the notice is taken.
    const first = (await client.callTool({ name: 'strict_object', arguments: {} })) as ToolResult;
    assert.notEqual(first.isError, true, JSON.stringify(first));
    assert.deepEqual(first.structuredContent, { ok: true, update: OUT });
    // A schema that declares `update` itself keeps it as it is; the notice goes in a text block alone.
    const many = await connectAgain(m);
    try {
      const own = (await many.client.callTool({ name: 'owns_update', arguments: {} })) as ToolResult;
      assert.deepEqual(own.structuredContent, { update: 'its own' });
      assert.ok(textsOf(own).includes(OUT), textsOf(own));
    } finally {
      await many.close();
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }

  /** The same tools on a server of their own: a process whose notice is still to be given. */
  async function connectAgain(at: typeof m) {
    const again = new McpServer({ name: 'notice-test', version: '0' });
    strictToolArguments(
      again,
      fail,
      updateToolNotice({ core: at.core, env: at.env, channel: 'gmail', running: VERSION, exempt: [] }),
    );
    again.registerTool('owns_update', { inputSchema: {}, outputSchema: z.object({ update: z.string() }) }, async () =>
      result({ update: 'its own' }),
    );
    const [one, two] = InMemoryTransport.createLinkedPair();
    const other = new Client({ name: 'test', version: '0' });
    await Promise.all([other.connect(one), again.connect(two)]);
    return { client: other, close: () => Promise.all([other.close(), again.close()]) };
  }
});

test('a server a plugin or an extension started is told where it is updated, whatever the registrations say', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: false, current: { registered: ['gmail'], global: [] } });
  const notice = (startedBy?: string) =>
    updateToolNotice({
      core: m.core,
      env: startedBy === undefined ? m.env : { ...m.env, [UPDATE_STARTED_BY_ENV]: startedBy },
      channel: 'gmail',
      running: VERSION,
      exempt: [],
    })('gmail_search');
  assert.match(String(await notice()), /is installed; restart the client/);
  assert.equal(
    await notice('claude-code-plugin'),
    `agent-communications ${LATEST} is out; this server came with the Claude Code plugin, and is updated there when it suits you.`,
  );
  assert.match(String(await notice('gemini-extension')), /came with the Gemini extension/);
});

test('a command says it at most once a day for the machine: two at once say it once, and a clock gone back says it again', async () => {
  const m = machine();
  await seed(m, { latest: LATEST, behind: true });
  const start = new Date('2026-10-16T09:00:00.000Z');
  const at = (ms: number) => () => new Date(start.getTime() + ms);
  const said: string[] = [];
  const say = (now: () => Date) => {
    const stderr = new PassThrough();
    stderr.on('data', (chunk) => said.push(String(chunk)));
    return updateNoticeAtTerminal({
      core: m.core,
      env: m.env,
      channel: 'gmail',
      running: VERSION,
      output: { json: true, color: false },
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr } as unknown as Streams,
      now,
    });
  };
  await Promise.all([say(at(0)), say(at(0))]);
  assert.equal(said.length, 1, said.join(''));
  assert.match(
    said[0] as string,
    new RegExp(`^agent-communications ${LATEST.replaceAll('.', '\\.')} is out \\(this is `),
  );
  assert.match(said[0] as string, /\n$/, 'one line');
  await say(at(24 * 3_600_000 - 1));
  assert.equal(said.length, 1, 'said again inside the day');
  await say(at(24 * 3_600_000));
  assert.equal(said.length, 2, 'a day on, once');
  // A clock that went back hours: the record is from its future, and cannot be trusted.
  await say(at(10 * 3_600_000));
  assert.equal(said.length, 3);
  // Installed globally at the latest, and this copy older: run the installed one.
  await seed(m, {
    latest: LATEST,
    behind: false,
    current: { registered: [], global: ['gmail'] },
    commandNoticeAt: null,
  });
  await say(at(40 * 3_600_000));
  assert.match(said[3] as string, /is installed; this Gmail CLI is .*: run it from the installed one\.\n$/);
});

test('the notice never names a command by its bare name, and its lines are one line each', () => {
  const pending = { kind: 'update' as const, running: '0.19.0', latest: LATEST };
  for (const line of [
    serverNoticeLine(pending),
    serverNoticeLine({ ...pending, kind: 'restart' }),
    serverNoticeLine(pending, { [UPDATE_STARTED_BY_ENV]: 'claude-code-plugin' }),
  ]) {
    assertNoBareCommand(line, 'the notice');
    assert.doesNotMatch(line, /\n/);
  }
});
