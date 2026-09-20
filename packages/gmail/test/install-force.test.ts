import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { mcpInstall } from '../src/mcp/install.ts';
import { newHarness, tempDir } from './support/harness.ts';

/**
 * A stand-in for the `claude` binary, on PATH.
 *
 * `--force` is remove-then-add against a CLI this package does not control, so its failure modes only exist at
 * that boundary: a remove that succeeds followed by an add that does not. Nothing can be learned about them from
 * a test that never crosses it, which is why the first attempt at covering this asserted only that a JSON field
 * parsed. This script records every call and fails whichever ones the test names.
 */
async function fakeClaude(options: { failAdd?: boolean; failRestore?: boolean; failRemove?: string } = {}) {
  const dir = tempDir();
  const log = join(dir, 'calls.log');
  // CommonJS, deliberately: an extensionless file run through a shebang is parsed as CJS, and an `import` here
  // made the script fail on every call — which made two of these tests pass for the wrong reason.
  const script = [
    '#!/usr/bin/env node',
    'const fs = require("node:fs");',
    `const log = ${JSON.stringify(log)};`,
    'const argv = process.argv.slice(2);',
    'fs.appendFileSync(log, argv.join(" ") + "\\n");',
    'const sub = argv[1];',
    `const failRemove = ${JSON.stringify(options.failRemove ?? null)};`,
    `const failAdd = ${options.failAdd ? 'true' : 'false'};`,
    `const failRestore = ${options.failRestore ? 'true' : 'false'};`,
    'if (sub === "remove" && failRemove) { process.stderr.write(failRemove); process.exit(1); }',
    'if (sub === "add-json") {',
    '  const adds = fs.readFileSync(log, "utf8").split("\\n").filter((l) => l.startsWith("mcp add-json")).length;',
    '  if (adds === 1 && failAdd) { process.stderr.write("add refused"); process.exit(1); }',
    '  if (adds === 2 && failRestore) { process.stderr.write("restore refused"); process.exit(1); }',
    '}',
    'process.exit(0);',
  ].join('\n');
  const path = join(dir, 'claude');
  await writeFile(path, script);
  await chmod(path, 0o755);
  return {
    dir,
    log,
    calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
  };
}

/** A `.claude.json` holding one registered server, so `--force` has something to preserve. */
async function withRegistered(home: string, env: Record<string, string>) {
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({ mcpServers: { gmail: { command: 'node', args: ['/old/cli.mjs', 'mcp'], env } } }),
  );
}

test('--force restores the previous entry, with its env, when the replacement fails', async () => {
  const harness = await newHarness({ accounts: [] });
  const fake = await fakeClaude({ failAdd: true });
  const previousEnv = { AGENT_COMMS_CONFIG_DIR: '/cfg/previous', PATH: '/usr/bin' };
  await withRegistered(harness.configDir, previousEnv);

  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: harness.configDir, PATH: fake.dir },
  });

  await assert.rejects(
    mcpInstall(context, { client: 'claude-code', apply: true, force: true, noVerify: true }),
    (error: unknown) => error instanceof CommsError && /the previous entry was put back/.test(error.message),
  );

  const calls = await fake.calls();
  assert.ok(
    calls.some((call) => call.startsWith('mcp remove gmail')),
    'it removed first',
  );
  assert.equal(calls.filter((call) => call.startsWith('mcp add-json')).length, 2, 'it added, failed, and restored');

  // The restore must carry the env back. Without it the "restored" server points at another config directory,
  // starts fine, and reports no mailboxes — to somebody who was just told their entry survived.
  const restore = calls.filter((call) => call.startsWith('mcp add-json')).at(-1) ?? '';
  assert.match(restore, /\/old\/cli\.mjs/, 'the old command, not the new one');
  assert.match(restore, /AGENT_COMMS_CONFIG_DIR/, 'and its env');
  assert.match(restore, /\/cfg\/previous/);
});

test('--force says so plainly when the restore fails too, rather than claiming it worked', async () => {
  const harness = await newHarness({ accounts: [] });
  const fake = await fakeClaude({ failAdd: true, failRestore: true });
  await withRegistered(harness.configDir, { AGENT_COMMS_CONFIG_DIR: '/cfg/previous' });

  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: harness.configDir, PATH: fake.dir },
  });

  await assert.rejects(
    mcpInstall(context, { client: 'claude-code', apply: true, force: true, noVerify: true }),
    (error: unknown) =>
      error instanceof CommsError &&
      /could not be put back/.test(error.message) &&
      /no server called "gmail"/.test(error.message),
  );
});

test('--force does not swallow a removal failure that is not "no such server"', async () => {
  const harness = await newHarness({ accounts: [] });
  const fake = await fakeClaude({ failRemove: 'permission denied writing the config' });
  await withRegistered(harness.configDir, { AGENT_COMMS_CONFIG_DIR: '/cfg/previous' });

  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: harness.configDir, PATH: fake.dir },
  });

  // Proceeding would add beside an entry we failed to remove.
  await assert.rejects(mcpInstall(context, { client: 'claude-code', apply: true, force: true, noVerify: true }));
  const calls = await fake.calls();
  assert.equal(calls.filter((call) => call.startsWith('mcp add-json')).length, 0, 'it did not add over it');
});

test('--force with nothing registered is one plain add', async () => {
  const harness = await newHarness({ accounts: [] });
  const fake = await fakeClaude({ failRemove: 'No MCP server found with name: gmail' });
  await writeFile(join(harness.configDir, '.claude.json'), JSON.stringify({ mcpServers: {} }));

  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: harness.configDir, PATH: fake.dir },
  });

  const result = await mcpInstall(context, { client: 'claude-code', apply: true, force: true, noVerify: true });
  assert.equal(result.applied, true);
  assert.equal(result.method, 'cli');
  const calls = await fake.calls();
  assert.equal(calls.filter((call) => call.startsWith('mcp add-json')).length, 1);
});
