import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RULES, runtimeSources, scan, suiteFacts } from './helpers/printed-command-guard.mjs';
import { tempDir } from './helpers/temp-dir.mjs';

/*
 * No package prints one of this suite's commands but through the locator (CUE-403 task 15; design 2026-10-04, D5;
 * §4 7c and 7e-structure). A syntax-tree scan of every runtime package's source — derived from `capabilities.json` and
 * the channel registry, never listed — for a suite binary at a word's edge in a string a person reads, a binary taken
 * from a manifest put into one, a manifest's binary written whole into a `CommsError`, an MCP server's instructions or
 * a tool's description, a stream or a result's field, `node` before a suite entry, `npx` before a suite package, and a
 * wrapper whose payload starts a suite product. What it leaves alone, it leaves by syntax and data flow — see
 * `helpers/printed-command-guard.mjs` — never by naming a file.
 *
 * The compile-time half — a result's command field takes no string; no constructor is reachable — is
 * `printed-command-types.test.mjs`.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'printed-commands', 'source');
const FACTS = suiteFacts(ROOT);

/** The fixtures in `kind` (`rejected` or `accepted`), read as the scan reads runtime source. */
function fixtures(kind) {
  return readdirSync(join(FIXTURES, kind))
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ path: `${kind}/${name}`, text: readFileSync(join(FIXTURES, kind, name), 'utf8') }));
}

const said = (findings) => findings.map(({ path, line, rule, text }) => `${path}:${line} [${rule}] ${text}`).join('\n');

/**
 * What a rejected fixture breaks, as it says on each line: `// expect: <rule>, …` after the code a finding starts on,
 * once per finding. Every finding is expected and every expectation is found, so each visitor and matcher is held to
 * its own lines — one turned off loses its findings even where another rule still reaches the same file.
 */
function expected(file) {
  const pairs = [];
  for (const [index, line] of file.text.split('\n').entries()) {
    const marked = /\/\/ expect: ([a-z-]+(?:, [a-z-]+)*)\s*$/.exec(line)?.[1];
    for (const rule of marked?.split(', ') ?? []) pairs.push(`${index + 1} ${rule}`);
  }
  return pairs.sort();
}

test('the scan reads every runtime package the capabilities and the channel registry name, servers’ wrappers included', () => {
  const capabilities = JSON.parse(readFileSync(join(ROOT, 'capabilities.json'), 'utf8'));
  for (const row of capabilities.capabilities) assert.ok(FACTS.packages.includes(row.package), row.package);
  // The event library too: it is published, and its source is scanned like every runtime package's.
  assert.deepEqual(FACTS.packages, [
    'core',
    'events',
    'events-daemon',
    'gmail',
    'gmail-mcp',
    'resend',
    'slack',
    'whatsapp',
  ]);
  // Every manifest's command and every server's own, and every package's `bin`: the wrapper's included.
  assert.deepEqual([...FACTS.binaries].sort(), [
    'agent-events',
    'agent-gmail',
    'agent-gmail-mcp',
    'agent-resend',
    'agent-slack',
    'agent-whatsapp',
    'agentcomms',
  ]);
  const sources = runtimeSources(FACTS);
  for (const name of FACTS.packages) {
    assert.ok(
      sources.some((file) => file.path.startsWith(`packages/${name}/src/`)),
      `${name}'s source is read`,
    );
  }
});

test('a package a newer capability names, and its binary, are scanned without an edit here (a synthetic channel)', async () => {
  // A checkout with core, a new channel and its first capability: found from the files alone.
  const root = await tempDir('printed-command-guard-');
  cpSync(join(ROOT, 'packages', 'core', 'package.json'), join(root, 'packages', 'core', 'package.json'), {
    recursive: true,
  });
  mkdirSync(join(root, 'packages', 'telegram', 'src'), { recursive: true });
  const telegram = JSON.parse(readFileSync(join(ROOT, 'packages', 'whatsapp', 'package.json'), 'utf8'));
  telegram.name = '@agentcomms/telegram';
  telegram.bin = { 'agent-telegram': './dist/cli.mjs' };
  telegram.agentcomms = {
    ...telegram.agentcomms,
    channel: 'telegram',
    label: 'Telegram',
    binary: 'agent-telegram',
    // Its server run through a wrapper package of its own, whose command only that package's `bin` names.
    server: { defaultName: 'telegram', npxPackage: '@agentcomms/telegram-mcp' },
  };
  writeFileSync(join(root, 'packages', 'telegram', 'package.json'), JSON.stringify(telegram));
  mkdirSync(join(root, 'packages', 'telegram-mcp', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'telegram-mcp', 'package.json'),
    JSON.stringify({
      name: '@agentcomms/telegram-mcp',
      version: telegram.version,
      bin: { 'tg-server': './dist/server.mjs' },
    }),
  );
  writeFileSync(
    join(root, 'packages', 'telegram', 'src', 'hint.ts'),
    "export const hint = 'Run Agent-Telegram.cmd approve ap_1 in your own terminal.';\n",
  );
  writeFileSync(join(root, 'packages', 'telegram-mcp', 'src', 'help.ts'), "export const help = 'tg-server --help';\n");
  writeFileSync(
    join(root, 'capabilities.json'),
    JSON.stringify({ capabilities: [{ id: 'telegram.status', package: 'telegram', cli: 'status', mcp: 'x' }] }),
  );
  const facts = suiteFacts(root);
  assert.deepEqual(facts.packages, ['core', 'telegram', 'telegram-mcp']);
  assert.ok(facts.binaries.includes('agent-telegram') && facts.binaries.includes('tg-server'));
  const findings = scan(runtimeSources(facts), facts);
  assert.deepEqual(
    findings.map(({ path, rule }) => [path, rule]),
    [
      ['packages/telegram-mcp/src/help.ts', 'binary'],
      ['packages/telegram/src/hint.ts', 'binary'],
    ],
  );
  // A capability for a package that is not there is not quietly skipped.
  writeFileSync(
    join(root, 'capabilities.json'),
    JSON.stringify({ capabilities: [{ id: 'signal.status', package: 'signal', cli: 'status', mcp: 'x' }] }),
  );
  assert.throws(() => suiteFacts(root), /names the package signal, and there is no packages\/signal/);
});

test('a declared service and its binary are scanned without an edit here', async () => {
  const root = await tempDir('printed-command-service-');
  cpSync(join(ROOT, 'packages', 'core', 'package.json'), join(root, 'packages', 'core', 'package.json'), {
    recursive: true,
  });
  const directory = join(root, 'packages', 'service-fixture');
  mkdirSync(join(directory, 'src', 'mcp'), { recursive: true });
  mkdirSync(join(directory, 'src', 'actions'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@agentcomms/service-fixture',
      version: '1.0.0',
      bin: { 'service-fixture': './dist/cli.mjs' },
      agentcommsPackage: {
        kind: 'service',
        binary: 'service-fixture',
        server: {
          defaultName: 'service-fixture',
          entry: 'src/mcp/server.ts',
          factory: 'createServiceFixtureMcpServer',
        },
        operations: 'src/actions',
      },
    }),
  );
  writeFileSync(join(directory, 'src', 'cli.ts'), 'export const status = true;\n');
  writeFileSync(
    join(directory, 'src', 'mcp', 'server.ts'),
    'export async function createServiceFixtureMcpServer() { return {}; }\n',
  );
  writeFileSync(join(directory, 'src', 'actions', 'status.ts'), 'export {};\n');
  writeFileSync(join(root, 'capabilities.json'), JSON.stringify({ capabilities: [] }));

  const facts = suiteFacts(root);
  assert.deepEqual(facts.packages, ['core', 'service-fixture']);
  assert.ok(facts.binaries.includes('service-fixture'));
  assert.ok(runtimeSources(facts).some(({ path }) => path === 'packages/service-fixture/src/cli.ts'));
});

test('every runtime package prints no command of this suite but through the locator', () => {
  const findings = scan(runtimeSources(FACTS), FACTS);
  assert.deepEqual(
    findings,
    [],
    `a command of this suite is written in runtime source; locate it (CONTRIBUTING.md, "Telling a person what to run"):\n${said(findings)}`,
  );
});

test('each rejected fixture breaks the rules it marks, on the lines it marks, and nothing else (7c)', () => {
  const files = fixtures('rejected');
  assert.ok(files.length >= 13, `${files.length} rejected fixtures`);
  const findings = scan(files, FACTS);
  const rules = new Set();
  for (const file of files) {
    const want = expected(file);
    assert.ok(want.length > 0, `${file.path} marks what it breaks`);
    const got = findings
      .filter((finding) => finding.path === file.path)
      .map(({ line, rule }) => `${line} ${rule}`)
      .sort();
    assert.deepEqual(got, want, `${file.path}:\n${said(findings.filter((finding) => finding.path === file.path))}`);
    for (const pair of want) rules.add(pair.split(' ')[1]);
  }
  // Every rule has a fixture that breaks it.
  assert.deepEqual([...rules].sort(), [...RULES].sort());
});

test('a launch is caught by its own rule: node, npx and a wrapper each fail with that rule turned off (7c)', () => {
  /*
   * `node <suite-entry>`, `npx @agentcomms/<product>` and a wrapper's payload name no binary for the word rule to see,
   * so each launch fixture is caught by its own matcher alone: with that one off, its fixture is clean of that rule —
   * and the wrapper's binary-named payload is still a word-rule finding, which is why it carries both.
   */
  const launches = {
    'node-entry.ts': 'node-entry',
    'npx-package.ts': 'npx-package',
    'wrapper-payload.ts': 'wrapper-payload',
  };
  for (const [name, rule] of Object.entries(launches)) {
    const file = fixtures('rejected').filter(({ path }) => path === `rejected/${name}`);
    const off = scan(file, FACTS, { disable: [rule] });
    assert.ok(!off.some((finding) => finding.rule === rule), `${name} with ${rule} off`);
    assert.ok(
      off.every((finding) => finding.rule === 'binary'),
      `${name} is caught by nothing but its own rule (and, for a binary in its payload, the word rule): ${said(off)}`,
    );
  }
  // The windows-only payload of the wrapper fixture names no binary: with the wrapper rule off, it is not caught at all.
  const windows = scan(
    [
      {
        path: 'windows.ts',
        text: "export const w = ['cmd.exe', '/c', 'C:\\\\npm\\\\node_modules\\\\@agentcomms\\\\core\\\\dist\\\\cli.mjs approve'];\n",
      },
    ],
    FACTS,
    { disable: ['wrapper-payload'] },
  );
  assert.deepEqual(windows, []);
});

test('the locator’s inputs, protocol identities, the reviewed external commands and prose are left alone (7e-structure)', () => {
  const findings = scan(fixtures('accepted'), FACTS);
  assert.deepEqual(findings, [], said(findings));
});
