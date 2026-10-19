import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * `doctor --json` prints exactly one envelope, whatever it finds (desktop design DA13), as Gmail's and Slack's doctors
 * do: a failing check is a finding, so the envelope is the report, `ok` with `data.ok` false, and the exit status, 78,
 * says something is wrong. It used to print the report and then an error envelope after it — two documents on stdout,
 * where `--json` promises one, and a reader taking the last line lost the report. At a terminal nothing changes.
 *
 * Every machine here is a temporary home whose `config.json` is not JSON: the `config` check fails on every platform.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function brokenMachine() {
  const home = tempDir('comms-doctor-json-');
  const config = join(home, 'config');
  mkdirSync(config);
  writeFileSync(join(config, 'config.json'), '{ not json\n');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    AGENT_COMMS_CONFIG_DIR: config,
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    NO_COLOR: '1',
    // The daily update check, off: nothing here asks npm.
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return { env, config };
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env });
}

interface Check {
  name: string;
  ok: boolean;
}

test('doctor --json with a failing check prints exactly one envelope and exits 78', () => {
  const { env } = brokenMachine();
  const result = run(['doctor', '--json'], env);
  assert.equal(result.status, 78, result.stderr);
  const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
  assert.equal(lines.length, 1, `one envelope, not:\n${result.stdout}`);
  const envelope = JSON.parse(lines[0] as string);
  assert.equal(envelope.ok, true, 'a failing check is a finding, not a failure to run');
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.data.ok, false, 'the report says it failed');
  const config = (envelope.data.checks as Check[]).find((check) => check.name === 'config');
  assert.equal(config?.ok, false, JSON.stringify(envelope.data.checks));
});

test('doctor without --json still says doctor found problems and exits 78', () => {
  const { env } = brokenMachine();
  const result = run(['doctor'], env);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stdout, /^FAIL config /m);
  assert.match(result.stderr, /doctor found problems/);
});

test('comms_doctor returns the report unchanged', async () => {
  const { env } = brokenMachine();
  const core = openCore({ env, caller: CORE_CALLER });
  const { server } = await createCoreMcpServer({ core, env, keyring: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = (await client.callTool({ name: 'comms_doctor', arguments: {} })) as {
      isError?: boolean;
      structuredContent?: { ok?: boolean; checks?: Check[] };
    };
    assert.notEqual(result.isError, true, 'a failing check is a finding, not an error');
    assert.equal(result.structuredContent?.ok, false);
    const expected = JSON.parse(JSON.stringify(await doctor(core, env, { keyring: null })));
    assert.deepEqual(result.structuredContent, expected);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
