import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createWhatsAppMcpServer } from '../src/mcp/server.ts';
import { ALICE, GROUP } from './support/fixture.ts';
import { newHarness, tempDir } from './support/harness.ts';

/**
 * No network, no send path — shown three ways.
 *
 * 1. The package's own source imports no network module and calls no `fetch`, `WebSocket` or `XMLHttpRequest`, and
 *    only the link opener starts a process.
 * 2. The built bundle — this package with core, commander, zod and the MCP SDK inlined, as it would ship — imports no
 *    network module either, and calls none of those globals.
 * 3. Every command and every tool runs with the network cut off at the socket, DNS, TLS, `fetch` and `WebSocket`, and
 *    with process creation watched, and attempts none of them.
 *
 * And there is nothing to send with: no command or tool sends, posts, reacts, marks read or sets presence.
 */

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const NETWORK_MODULES = [
  'net',
  'http',
  'https',
  'http2',
  'tls',
  'dgram',
  'dns',
  'dns/promises',
  'ws',
  'undici',
  'node-fetch',
  'axios',
  'baileys',
  '@whiskeysockets/baileys',
  'whatsapp-web.js',
  'puppeteer',
];
const NETWORK_GLOBALS =
  /\bfetch\s*\(|\bnew\s+WebSocket\b|\bXMLHttpRequest\b|\bnew\s+EventSource\b|\bnavigator\.sendBeacon\b/;

function files(directory: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...files(path, extension));
    else if (entry.name.endsWith(extension)) out.push(path);
  }
  return out;
}

function specifiers(source: string): string[] {
  const found = new Set<string>();
  // Statement-level `import … from` / `export … from`, bare `import 'x'`, dynamic `import('x')` and `require('x')`.
  const patterns = [
    /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[1] as string);
  }
  return [...found];
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function isNetwork(specifier: string): boolean {
  const bare = specifier.replace(/^node:/, '');
  return NETWORK_MODULES.includes(bare) || NETWORK_MODULES.some((name) => bare.startsWith(`${name}/`));
}

test("the package's own code imports no network module and calls no fetch, WebSocket or XMLHttpRequest", () => {
  const sources = files(join(PACKAGE, 'src'), '.ts');
  assert.ok(sources.length > 10);
  const offenders: string[] = [];
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiers(source)) {
      if (isNetwork(specifier)) offenders.push(`${relative(PACKAGE, file)} imports ${specifier}`);
    }
    if (NETWORK_GLOBALS.test(withoutComments(source)))
      offenders.push(`${relative(PACKAGE, file)} calls a network global`);
  }
  assert.deepEqual(offenders, []);

  const manifest = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf8')) as Record<string, unknown>;
  // Nothing installed at run time but this suite's own core, which every channel carries so that it can find core's
  // command (design 2026-10-04, D4); its code is inlined in the bundle checked below, not imported from there.
  assert.deepEqual(
    manifest.dependencies,
    { '@agentcomms/core': 'workspace:*' },
    'nothing else installed at run time: no WhatsApp client library, no driver',
  );
  assert.equal(manifest.optionalDependencies, undefined, 'not even the keychain module: this package holds no secret');
  // What the manifest promises, as core and every tool read it: no host, only `read`, and nothing about sending.
  const channel = manifest.agentcomms as {
    hosts: string[];
    accounts: { modes: string[]; guarantee: { why: string } };
  };
  assert.deepEqual(channel.hosts, [], 'it declares no host, because it talks to none');
  assert.deepEqual(channel.accounts.modes, ['read']);
  assert.match(channel.accounts.guarantee.why, /reads only local files/);
  assert.match(channel.accounts.guarantee.why, /no network client/);
  assert.match(channel.accounts.guarantee.why, /never sends/);
});

test('only the link opener starts a process', () => {
  const starters = files(join(PACKAGE, 'src'), '.ts')
    .filter((file) => specifiers(readFileSync(file, 'utf8')).some((s) => s.replace(/^node:/, '') === 'child_process'))
    .map((file) => relative(PACKAGE, file));
  assert.deepEqual(starters, [join('src', 'cli', 'opener.ts')]);
  const opener = readFileSync(join(PACKAGE, 'src', 'cli', 'opener.ts'), 'utf8');
  assert.match(opener, /whatsapp:\\\/\\\/send\\\?\|https:\\\/\\\/wa\\\.me\\\//, 'it opens only WhatsApp links');
});

test('the built bundle, with core and every dependency inlined, imports no network module and calls no network global', async () => {
  const { build } = await import('tsdown');
  const outDir = tempDir('agent-whatsapp-bundle-');
  /*
   * Every module the bundle's graph asks for, as the bundler resolves it — what this package imports, what core
   * imports, what the MCP SDK imports — recorded by a plugin rather than read back out of the output with a pattern,
   * which cannot tell an import from a string that looks like one.
   */
  const requested = new Set<string>();
  const external = new Set<string>();
  await build({
    config: false,
    cwd: PACKAGE,
    entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir,
    dts: false,
    noExternal: [/.*/],
    external: ['@napi-rs/keyring'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'record-imports',
        resolveId(source: string) {
          if (!source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')) requested.add(source);
          if (isBuiltin(source)) external.add(source.replace(/^node:/, ''));
          return null;
        },
      },
    ],
  });
  assert.ok(requested.has('@agentcomms/core'), 'the graph was recorded');
  const offenders = [...requested].filter(isNetwork);
  assert.deepEqual(offenders, [], 'no network module anywhere in the graph');
  assert.deepEqual(
    [...external].filter((name) => isNetwork(name)),
    [],
  );
  for (const file of files(outDir, '.mjs')) {
    const source = withoutComments(readFileSync(file, 'utf8'));
    assert.doesNotMatch(source, NETWORK_GLOBALS, `${relative(outDir, file)} calls a network global`);
  }
  // What Node modules the shipped bundle does use, for the record.
  assert.ok(external.has('sqlite') && external.has('child_process') && external.has('fs'));
});

test('every command and every tool runs with the network cut off, and attempts no connection, lookup or process', async () => {
  const attempts: string[] = [];
  const refuse = (what: string) =>
    function refused(): never {
      attempts.push(what);
      throw new Error(`network attempted: ${what}`);
    };
  const saved = {
    connect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    spawn: childProcess.spawn,
    execFile: childProcess.execFile,
  };
  net.Socket.prototype.connect = refuse('net.Socket.connect') as typeof net.Socket.prototype.connect;
  tls.connect = refuse('tls.connect') as typeof tls.connect;
  dns.lookup = refuse('dns.lookup') as unknown as typeof dns.lookup;
  dns.promises.lookup = refuse('dns.promises.lookup') as unknown as typeof dns.promises.lookup;
  globalThis.fetch = refuse('fetch') as typeof fetch;
  globalThis.WebSocket = refuse('WebSocket') as unknown as typeof WebSocket;
  childProcess.spawn = refuse('child_process.spawn') as typeof childProcess.spawn;
  childProcess.execFile = refuse('child_process.execFile') as unknown as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try {
    const harness = await newHarness();
    const account = 'acme/whatsapp';
    const commands = [
      ['add', account],
      ['status'],
      ['sync', '--account', account],
      ['chats', '--account', account],
      ['read', ALICE, '--account', account],
      ['search', 'invoice', '--account', account],
      ['draft', '+15555550101', 'On my way'],
      ['draft', GROUP, 'hello all'],
      ['draft', ALICE, 'On my way', '--account', account],
      ['deny', GROUP, '--account', account],
      ['allow', ALICE, '--account', account],
      ['clear', '--account', account],
      ['mcp', 'install', '--client', 'json', '--standalone', '--print', '--no-verify', '--account', account],
    ];
    for (const argv of commands) {
      for (const json of [true, false]) {
        const result = await harness.cli(json ? [...argv, '--json'] : argv);
        if (argv[0] === 'add' && !json) continue; // already added
        assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
      }
    }
    const { server } = await createWhatsAppMcpServer({ env: harness.env });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      const calls: [string, Record<string, unknown>][] = [
        ['whatsapp_status', {}],
        ['whatsapp_sync', { account }],
        ['whatsapp_chats', { account }],
        ['whatsapp_read', { account, chat: ALICE }],
        ['whatsapp_search', { account, query: 'report' }],
        ['whatsapp_draft', { to: '+15555550101', text: 'hi' }],
        ['whatsapp_draft', { account, to: GROUP, text: 'hi' }],
      ];
      for (const [name, args] of calls) {
        const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
        assert.ok(!result.isError, name);
      }
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
    assert.equal((await harness.cli(['remove', account])).code, 0);
  } finally {
    net.Socket.prototype.connect = saved.connect;
    tls.connect = saved.tlsConnect;
    dns.lookup = saved.lookup;
    dns.promises.lookup = saved.promisesLookup;
    globalThis.fetch = saved.fetch;
    globalThis.WebSocket = saved.WebSocket;
    childProcess.spawn = saved.spawn;
    childProcess.execFile = saved.execFile;
    syncBuiltinESMExports();
  }
  assert.deepEqual(attempts, []);
});

test('there is nothing to send with: the commands are the read surface, the draft, and a person’s setup', async () => {
  const harness = await newHarness({ store: false });
  const help = (await harness.cli(['--help'])).stdout;
  const section = help.split('Commands:')[1]?.split('\n\n')[0] ?? '';
  const commands = [...section.matchAll(/^ {2}([a-z][a-z-]*)(?: |$)/gm)].map((match) => match[1]);
  assert.deepEqual(commands.sort(), [
    'add',
    'allow',
    'approve',
    'chats',
    'clear',
    'deny',
    'draft',
    'help',
    'mcp',
    'read',
    'remove',
    'search',
    'status',
    'sync',
  ]);
  const status = (await harness.cli(['status', '--json'])).data() as { reads: string; sends: string };
  assert.match(status.reads, /no network client/);
  assert.match(status.sends, /^never/);
});
