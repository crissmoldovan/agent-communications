import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { openCore } from '../src/core.ts';
import { type CommsError, toCommsError } from '../src/errors.ts';
// From the index, as the Gmail and Slack servers take it: the one mechanism every server registers its tools through.
import { strictToolArguments } from '../src/index.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Tool arguments are checked strictly, and refused in the envelope every other refusal uses (design 2026-09-18 §11:
 * "unknown fields are rejected").
 *
 * The SDK wraps a tool's input schema in a plain `z.object`, which *strips* a key it does not declare. So a call that
 * misspelt an argument, or used the name another API gives it, ran without it — `gmail_inbox_add {client: 'other',
 * contacts: false}` once signed in through the default client and asked for the address book, because neither key was
 * declared then. And what the SDK did refuse — a wrong type, a fraction, a word outside an enum — came back as its own
 * "Input validation error", with no `error.code` for an agent to act on.
 */

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}

interface Refusal {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

/** The envelope the servers answer a refusal with: code, message and hint, and the text block mirroring it. */
const envelope = (error: CommsError) => {
  const structured = { error: { code: error.code, message: error.message, hint: error.hint ?? null } };
  return {
    isError: true as const,
    structuredContent: structured,
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
  };
};

/** A refusal with a code — asserting it is one, and that the text block says the same as the structured half. */
function refused(result: ToolResult): Refusal {
  assert.equal(result.isError, true, `expected a refusal, got ${JSON.stringify(result.structuredContent)}`);
  const error = (result.structuredContent as { error?: Refusal } | undefined)?.error;
  assert.ok(error, `refused without a code: ${JSON.stringify(result.content)}`);
  assert.deepEqual(JSON.parse(result.content?.[0]?.text ?? 'null'), result.structuredContent, 'the text mirrors it');
  return error;
}

/** A bare server with `strictToolArguments` applied, a client talking to it, and what each handler was handed. */
async function bare(register: (server: McpServer, seen: unknown[][]) => void) {
  const server = new McpServer({ name: 'test', version: '0' });
  strictToolArguments(server, (error) => envelope(toCommsError(error)));
  const seen: unknown[][] = [];
  register(server, seen);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, seen, close: () => Promise.all([client.close(), server.close()]) };
}

const done = (args: unknown) => ({
  structuredContent: { got: args as Record<string, unknown> },
  content: [{ type: 'text' as const, text: JSON.stringify({ got: args }) }],
});

/** The same arguments three ways: as a raw shape, as a `z.object`, and in a `z.object` with its own refinement. */
const shape = () => ({
  name: z.string().min(1).describe('what to call it'),
  count: z.number().int().positive().optional().describe('how many'),
  mode: z.enum(['read', 'send']).optional(),
  flag: z.boolean().optional(),
});

function registerThree(server: McpServer, seen: unknown[][]) {
  const handler = async (args: unknown) => {
    seen.push([args]);
    return done(args);
  };
  server.registerTool('raw', { description: 'raw shape', inputSchema: shape() }, handler);
  server.registerTool('object', { description: 'z.object', inputSchema: z.object(shape()) }, handler);
  server.registerTool(
    'refined',
    {
      description: 'z.object with a refinement',
      inputSchema: z.object(shape()).refine((value) => value.name !== 'forbidden', { message: 'not that name' }),
    },
    handler,
  );
  server.registerTool('none', { description: 'no arguments', inputSchema: {} }, async (args: unknown) => {
    seen.push([args]);
    return done(args);
  });
  // Declared without any input schema at all: the SDK then hands the handler only its context.
  server.registerTool('unschemed', { description: 'no schema' }, async (...args: unknown[]) => {
    seen.push(args);
    return done({ arity: args.length });
  });
}

// ── The mechanism ───────────────────────────────────────────────────────────────────────────────────────────────

test('a key a tool does not declare is refused as USAGE before its handler runs, naming it and what the tool takes', async () => {
  const { call, seen, close } = await bare((server, seen) => registerThree(server, seen));
  try {
    for (const tool of ['raw', 'object', 'refined']) {
      const error = refused(await call(tool, { name: 'x', nmae: 'y', thread_ts: '1' }));
      assert.equal(error.code, 'USAGE', tool);
      assert.match(error.message, new RegExp(`${tool} does not take \`nmae\` or \`thread_ts\``), tool);
      assert.match(error.hint ?? '', /takes `name` \(required\), `count`, `mode` and `flag`/, tool);
    }
    for (const tool of ['none', 'unschemed']) {
      const error = refused(await call(tool, { anything: true }));
      assert.equal(error.code, 'USAGE', tool);
      assert.match(error.message, new RegExp(`${tool} does not take \`anything\``));
      assert.match(error.hint ?? '', /takes no arguments/);
    }
    assert.deepEqual(seen, [], 'no handler ran');
  } finally {
    await close();
  }
});

test('arguments that fail the schema are refused as USAGE naming the argument and what it takes, not the SDK’s text', async () => {
  const { call, seen, close } = await bare((server, seen) => registerThree(server, seen));
  try {
    for (const tool of ['raw', 'object', 'refined']) {
      const cases: Array<[Record<string, unknown>, RegExp]> = [
        [{ name: 'x', count: 1.5 }, /`count` takes a whole number of 1 or more/],
        [{ name: 'x', count: 0 }, /`count` takes a whole number of 1 or more/],
        [{ name: 'x', count: '3' }, /`count` takes a whole number of 1 or more/],
        [{ name: 'x', mode: 'write' }, /`mode` takes `read` or `send`/],
        [{ name: 'x', flag: 'yes' }, /`flag` takes true or false/],
        [{ name: '' }, /`name` takes a non-empty string/],
        [{ name: 7 }, /`name` takes a non-empty string/],
        [{}, /`name` is required, and takes a non-empty string/],
        [{ count: 2.5 }, /`name` is required.*; `count` takes a whole number/],
      ];
      for (const [args, message] of cases) {
        const error = refused(await call(tool, args));
        assert.equal(error.code, 'USAGE', `${tool} ${JSON.stringify(args)}`);
        assert.match(error.message, message, `${tool} ${JSON.stringify(args)}`);
        assert.doesNotMatch(error.message, /Input validation error|Invalid input/, 'not the SDK’s words, nor zod’s');
      }
      // The argument’s own description, where it has one, is what the hint says about it.
      assert.match(refused(await call(tool, { name: 'x', count: 1.5 })).hint ?? '', /`count`: how many/);
    }
    // A refinement of the whole object still runs, and is refused in the same envelope.
    const error = refused(await call('refined', { name: 'forbidden' }));
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /not that name/);
    assert.deepEqual(seen, [], 'no handler ran');
  } finally {
    await close();
  }
});

test('a problem inside an object argument is named by its full path and what is wrong there, never by its value', async () => {
  /*
   * A misspelt key inside an object argument was reported against the argument itself: `gmail_draft_send` with
   * `expect: {To: [...], cc, bcc, subject}` was told "`expect` takes an object" — though an object was passed — and
   * `gmail_organise_undo` with `undo: [{messageID}]` "`undo` takes a list". Neither named the key that was missing, nor
   * the one that was misspelt, so an agent had nothing to correct.
   */
  const { call, seen, close } = await bare((server, seen) => {
    server.registerTool(
      'nested',
      {
        description: 'object arguments',
        inputSchema: {
          expect: z
            .object({ to: z.array(z.string()).describe('who it goes to'), subject: z.string() })
            .describe('what you believe it is'),
          undo: z.array(z.object({ messageId: z.string().min(1), labels: z.array(z.string()) })).min(1),
          sealed: z.strictObject({ a: z.string() }).optional(),
          open: z.looseObject({ a: z.string() }).optional(),
        },
      },
      async (args: unknown) => {
        seen.push([args]);
        return done(args);
      },
    );
  });
  const sentinel = 'sentinel-value-7c1f';
  const good = { expect: { to: [sentinel], subject: sentinel }, undo: [{ messageId: sentinel, labels: [] }] };
  try {
    const cases: Array<[Record<string, unknown>, RegExp[], RegExp]> = [
      [
        { ...good, expect: { To: [sentinel], subject: sentinel } },
        [/`expect\.to` is required, and takes a list of strings/, /`expect` does not take `To`/],
        /`expect` takes `to` \(required\) and `subject` \(required\)/,
      ],
      [
        { ...good, undo: [{ messageID: sentinel, labels: [] }] },
        [/`undo\[0\]\.messageId` is required, and takes a non-empty string/, /`undo\[0\]` does not take `messageID`/],
        /`undo\[0\]` takes `messageId` \(required\) and `labels` \(required\)/,
      ],
      [
        { ...good, expect: { to: sentinel, subject: sentinel } },
        [/`expect\.to` takes a list of strings/],
        /`expect` takes/,
      ],
      [
        { ...good, undo: [good.undo[0], { messageId: 5, labels: [sentinel] }] },
        [/`undo\[1\]\.messageId` takes a non-empty string/],
        /`undo\[1\]` takes/,
      ],
      [
        { ...good, undo: [{ messageId: '', labels: [7] }] },
        [/`undo\[0\]\.messageId` takes a non-empty string/, /`undo\[0\]\.labels\[0\]` takes a string/],
        /`undo\[0\]` takes/,
      ],
      // A nested object that is strict itself: its unknown key is named where it is, as the top level's is.
      [
        { ...good, sealed: { a: sentinel, [sentinel]: 1 } },
        [/`sealed` does not take `sentinel-value-7c1f`/],
        /`sealed`/,
      ],
    ];
    // An object that takes any key has none it does not take: only what is wrong in it is named.
    const open = refused(await call('nested', { ...good, open: { b: 1 } }));
    assert.equal(open.message, '`open.a` is required, and takes a string');
    for (const [args, messages, hint] of cases) {
      const label = JSON.stringify(args);
      const error = refused(await call('nested', args));
      assert.equal(error.code, 'USAGE', label);
      for (const message of messages) assert.match(error.message, message, label);
      assert.doesNotMatch(error.message, /`expect` takes an object|`undo` takes a list/, `not the argument: ${label}`);
      assert.doesNotMatch(error.message, /Input validation error|Invalid input|Unrecognized key/, label);
      assert.match(error.hint ?? '', hint, label);
      if (!/sealed/.test(label)) {
        // A key name is the caller's own spelling and is named; a value is not, wherever it sits.
        assert.doesNotMatch(`${error.message} ${error.hint}`, new RegExp(sentinel), `a value was echoed: ${label}`);
      }
    }

    // Many records wrong the same way are named a few at a time, not one clause per record.
    const many = refused(
      await call('nested', { ...good, undo: Array.from({ length: 9 }, () => ({ messageID: sentinel, labels: [] })) }),
    );
    assert.match(many.message, /`undo\[0\]\.messageId` is required/);
    assert.doesNotMatch(many.message, /undo\[8\]/);
    assert.match(many.message, /and \d+ more/);
    assert.doesNotMatch(many.message, new RegExp(sentinel));

    // The argument itself wrong is still said as it was.
    assert.match(refused(await call('nested', { ...good, expect: sentinel })).message, /^`expect` takes an object$/);
    assert.match(refused(await call('nested', { ...good, undo: [] })).message, /^`undo` takes a list$/);
    assert.match(
      refused(await call('nested', { undo: good.undo })).message,
      /^`expect` is required, and takes an object$/,
    );
    assert.deepEqual(seen, [], 'no handler ran');

    // And a call right all the way down still reaches the handler.
    const ok = await call('nested', good);
    assert.notEqual(ok.isError, true, JSON.stringify(ok.structuredContent));
    assert.equal(seen.length, 1);
  } finally {
    await close();
  }
});

test('a call the schema accepts reaches the handler with what it parsed, exactly as before', async () => {
  const { call, seen, close } = await bare((server, seen) => {
    registerThree(server, seen);
    // What a preprocessing argument turns a value into is what the handler gets, as it was with the SDK’s own parse.
    server.registerTool(
      'coerced',
      {
        description: 'preprocess',
        inputSchema: z.object({
          on: z.preprocess((value) => (value === 'true' ? true : value), z.boolean()),
          trimmed: z.string().transform((value) => value.trim()),
        }),
      },
      async (args) => {
        seen.push([args]);
        return done(args);
      },
    );
  });
  try {
    for (const tool of ['raw', 'object', 'refined']) {
      const result = await call(tool, { name: 'x', count: 2, mode: 'send', flag: false });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      assert.deepEqual(result.structuredContent, { got: { name: 'x', count: 2, mode: 'send', flag: false } });
    }
    assert.deepEqual((await call('none')).structuredContent, { got: {} });
    assert.deepEqual((await call('unschemed')).structuredContent, { got: { arity: 1 } }, 'the context alone');
    assert.deepEqual((await call('coerced', { on: 'true', trimmed: ' a ' })).structuredContent, {
      got: { on: true, trimmed: 'a' },
    });
    assert.equal(seen.length, 6);
  } finally {
    await close();
  }
});

test('tools/list publishes the same arguments, and says up front that no other is accepted', async () => {
  const { client, close } = await bare((server, seen) => registerThree(server, seen));
  try {
    const { tools } = await client.listTools();
    const plain = z.toJSONSchema(z.object(shape()), { io: 'input', target: 'draft-2020-12' }) as Record<
      string,
      unknown
    >;
    for (const name of ['raw', 'object', 'refined']) {
      const listed = tools.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>;
      assert.deepEqual(listed.properties, plain.properties, `${name}: every property, description and enum`);
      assert.deepEqual(listed.required, ['name'], name);
      assert.equal(listed.type, 'object', name);
      assert.equal(listed.additionalProperties, false, `${name}: a client is told no other key is taken`);
    }
    for (const name of ['none', 'unschemed']) {
      const listed = tools.find((tool) => tool.name === name)?.inputSchema as Record<string, unknown>;
      assert.deepEqual(listed.properties ?? {}, {}, name);
      assert.equal(listed.additionalProperties, false, name);
    }
  } finally {
    await close();
  }
});

test('a tool whose arguments cannot be checked strictly is refused when it is registered, not when it is called', () => {
  const server = new McpServer({ name: 'test', version: '0' });
  strictToolArguments(server, (error) => envelope(toCommsError(error)));
  const handler = async () => done({});
  // An input schema that is not an object of named arguments has no keys to hold a call to.
  assert.throws(
    () => server.registerTool('union', { inputSchema: z.union([z.object({ a: z.string() }), z.string()]) }, handler),
    /union: .*object of named arguments/,
  );
  // A registration in a shape this does not know would be a tool registered unchecked; that stops the server instead.
  const loose = server.registerTool as unknown as (...args: unknown[]) => unknown;
  assert.throws(() => loose.call(server, 'two-args', handler), /cannot check this tool/);
  assert.throws(() => loose.call(server, 'four-args', {}, handler, handler), /cannot check this tool/);
});

// ── The core server ─────────────────────────────────────────────────────────────────────────────────────────────

/** A home of its own, holding only a config: every path the server could write is inside it. */
function machine(body: Record<string, unknown> = {}) {
  const home = tempDir('comms-strict-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const configFile = join(configDir, 'config.json');
  writeFileSync(configFile, `${JSON.stringify({ version: 2, ...body }, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
  };
  return { home, env, configFile, core: openCore({ env }) };
}

async function coreServer(m: ReturnType<typeof machine>) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, close: () => Promise.all([client.close(), server.close()]) };
}

test('comms_server_install with a misspelt `readOnly` is refused, and nothing is prepared or registered', async () => {
  /*
   * `readonly` for `readOnly` was stripped, and the registration went ahead without it: a server that can change
   * every mailbox, prepared for a person to approve as if it were what was asked for.
   */
  const m = machine();
  const before = readFileSync(m.configFile, 'utf8');
  const { call, close } = await coreServer(m);
  try {
    const error = refused(
      await call('comms_server_install', { channel: 'gmail', client: 'cursor', launcher: 'npx', readonly: true }),
    );
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /comms_server_install does not take `readonly`/);
    assert.match(error.hint ?? '', /`readOnly`/, 'the key it does take is named');
    assert.match(error.hint ?? '', /`channel` \(required\)/);
    assert.deepEqual(error.details?.unknown, ['readonly']);
  } finally {
    await close();
  }
  assert.deepEqual(await m.core.approvals.list(), [], 'nobody was asked');
  assert.deepEqual(await m.core.audit.tail(), [], 'nothing was recorded, because nothing happened');
  assert.equal(existsSync(join(m.home, '.cursor', 'mcp.json')), false, 'no client config was written');
  assert.equal(readFileSync(m.configFile, 'utf8'), before, 'the config is as it was');
});

test('comms_secrets_migrate to a store that does not exist is refused as USAGE naming the two there are', async () => {
  const m = machine();
  const before = readFileSync(m.configFile, 'utf8');
  const { call, close } = await coreServer(m);
  try {
    const error = refused(await call('comms_secrets_migrate', { to: 'cloud' }));
    assert.equal(error.code, 'USAGE');
    assert.match(error.message, /`to` takes `keychain` or `file`/);
    assert.match(error.hint ?? '', /`to`: where credentials should be kept/);

    const missing = refused(await call('comms_secrets_migrate', {}));
    assert.equal(missing.code, 'USAGE');
    assert.match(missing.message, /`to` is required, and takes `keychain` or `file`/);
  } finally {
    await close();
  }
  assert.deepEqual(await m.core.approvals.list(), []);
  assert.equal(readFileSync(m.configFile, 'utf8'), before);
});

test('a number that is not a whole one, or a value of the wrong type, is USAGE from the core server too', async () => {
  const m = machine();
  const { call, close } = await coreServer(m);
  try {
    const fraction = refused(await call('comms_audit_tail', { limit: 1.5 }));
    assert.equal(fraction.code, 'USAGE');
    assert.match(fraction.message, /`limit` takes a whole number of 1 or more/);

    const word = refused(await call('comms_audit_tail', { limit: 'ten' }));
    assert.equal(word.code, 'USAGE');
    assert.match(word.message, /`limit` takes a whole number/);

    const list = refused(await call('comms_names_migrate', { dryRun: true, renames: 'a=b' }));
    assert.equal(list.code, 'USAGE');
    assert.match(list.message, /`renames` takes a list of strings/);

    const state = refused(await call('comms_approvals_list', { state: 'nope' }));
    assert.equal(state.code, 'USAGE');
    assert.match(state.message, /`state` takes `pending`, `approved`, .* or `revoked`/);

    // …and the calls that are right still work.
    const ok = await call('comms_audit_tail', { limit: 5 });
    assert.notEqual(ok.isError, true, JSON.stringify(ok.structuredContent));
    assert.deepEqual(ok.structuredContent, { records: [] });
    assert.notEqual((await call('comms_paths')).isError, true);
  } finally {
    await close();
  }
});

test('every core tool refuses a key it does not take, and publishes its arguments as the only ones', async () => {
  // By construction: a tool added later is held to this without anyone remembering to.
  const m = machine();
  const { client, call, close } = await coreServer(m);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 11, `${tools.length} tools`);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} publishes additionalProperties: false`);
      const error = refused(await call(tool.name, { zzUnknown: 1 }));
      assert.equal(error.code, 'USAGE', tool.name);
      assert.match(error.message, new RegExp(`${tool.name} does not take \`zzUnknown\``));
    }
  } finally {
    await close();
  }
  assert.deepEqual(await m.core.approvals.list(), []);
});
