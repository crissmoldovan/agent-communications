import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, canonicalJson, type DesktopOrigin, sha256Hex } from '@agentcomms/core';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { createEventsMcpServer } from '../src/mcp/server.ts';
import { JudgeReader } from '../src/runtime/judge-show.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { DAVID } from './support/lane-harness.ts';
import { rawClient, resultText } from './support/raw-mcp.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/*
 * `judge show <judgeId> [--version <n>]` and `events_judge_show` (0.33.0): one judge version's exact canonical
 * document, its digest and its state, so the app's rule editor can embed it in a rule as it will be approved. A judge
 * document is configuration only; a hosted judge's key is a separate secret generation and never part of it.
 */

// A synthetic provider key: never a real one. It is given to the Jev judge, and must appear in nothing judge show says.
const KEY = 'fake-judge-show-key-0123456789';

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

async function cli(
  stateDir: string,
  args: readonly string[],
  stdin = '',
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const input = new PassThrough();
  input.end(stdin);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin: input, stdout, stderr };
  const code = await run(['--state-dir', stateDir, '--json', ...args], { streams, env: {}, desktopOrigin: ATTESTED });
  return { code, stdout: out, stderr: err };
}

/** Every key name anywhere in a value. */
function keyNames(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keyNames(item, into);
  else if (value !== null && typeof value === 'object')
    for (const [name, entry] of Object.entries(value)) {
      into.push(name);
      keyNames(entry, into);
    }
  return into;
}

async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

test('JUDGE-SHOW: the CLI and the MCP tool give a judge version’s exact canonical document, its digest and state — never its key', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-judge-show-');
  const configDir = await emptyConfigDir(stateDir);
  // The events-only file backend, so no test writes to this Mac's keychain.
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  opened.close();
  const owner = await startEventOwner({ ...noRealHome(stateDir), stateDir, configDir, tickMs: 60_000 });
  const outputs: string[] = [];
  const ok = async (args: readonly string[], stdin?: string) => {
    const ran = await cli(stateDir, args, stdin);
    outputs.push(ran.stdout, ran.stderr);
    assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.stderr}`);
    return JSON.parse(ran.stdout) as Record<string, unknown>;
  };
  try {
    // Jev through OpenRouter, holding the person's key, and a model server on this machine.
    await ok(['provider', 'key', 'set', 'openrouter'], `${KEY}\n`);
    await ok(['judge', 'setup', 'typesafe', '--provider', 'openrouter']);
    await ok(['judge', 'setup', 'local-endpoint', '--url', 'http://127.0.0.1:11434']);

    const jev = await ok(['judge', 'show', 'jev']);
    t.diagnostic(`judge show jev --json: ${JSON.stringify(jev)}`);
    const expectedJev = {
      judgeId: 'jev',
      version: 1,
      kind: 'typesafe',
      provider: 'openrouter',
      model: 'typesafe/jev-1.14',
      endpoint: 'https://openrouter.ai/api/v1/systemone',
      promptTemplate: 'typesafe-jev-noul-v1',
      protocol: 'noul',
    };
    assert.deepEqual(jev, {
      judgeId: 'jev',
      version: 1,
      document: expectedJev,
      digest: sha256Hex(canonicalJson(expectedJev)),
      state: 'live',
    });
    const local = await ok(['judge', 'show', 'local-model', '--version', '1']);
    assert.deepEqual(Object.keys(local.document as object).sort(), [
      'approvedAddressSet',
      'endpoint',
      'judgeId',
      'kind',
      'model',
      'promptTemplate',
      'protocol',
      'provider',
      'version',
    ]);
    assert.equal((local.document as { endpoint: string }).endpoint, 'http://127.0.0.1:11434/v1/systemone');

    // The same through the event service's MCP server.
    const events = await createEventsMcpServer({ stateDir, window: async () => DAVID });
    const [client, server] = InMemoryTransport.createLinkedPair();
    const handle = await events.serve(server);
    const raw = await rawClient(client);
    try {
      await raw.request('server/discover');
      const reply = await raw.request('tools/call', { name: 'events_judge_show', arguments: { judgeId: 'jev' } });
      outputs.push(JSON.stringify(reply));
      assert.notEqual(reply.result?.isError, true, resultText(reply));
      assert.deepEqual(reply.result?.structuredContent, jev, 'MCP gives what the CLI gives');
      const unknown = await raw.request('tools/call', {
        name: 'events_judge_show',
        arguments: { judgeId: 'jev', key: 'please' },
      });
      assert.ok(unknown.error !== undefined || unknown.result?.isError === true, 'the tool takes no other argument');
    } finally {
      await raw.close();
      await handle.close();
    }

    // A removed judge shows as revoked; an unknown judge or version is not found (66); a bad argument is 64.
    await ok(['judge', 'remove', 'local-model']);
    assert.equal((await ok(['judge', 'show', 'local-model'])).state, 'revoked');
    for (const [args, code] of [
      [['judge', 'show', 'nobody'], 66],
      [['judge', 'show', 'jev', '--version', '9'], 66],
      [['judge', 'show', 'jev', '--version', '0'], 64],
      [['judge', 'show', 'has space'], 64],
    ] as const) {
      const ran = await cli(stateDir, args);
      outputs.push(ran.stdout, ran.stderr);
      assert.equal(ran.code, code, `${args.join(' ')}: ${ran.stderr}`);
    }

    // The proof: the key was given to Jev — its slot holds it — and judge show never says it, nor names a key field.
    for (const output of outputs) assert.equal(output.includes(KEY), false, `an output names the key: ${output}`);
    for (const name of keyNames([jev, local]))
      assert.doesNotMatch(name, /key|secret|token|credential|password/iu, `a shown judge has a ${name} field`);
    let held = false;
    for (const file of await filesBelow(stateDir)) if ((await readFile(file)).includes(Buffer.from(KEY))) held = true;
    assert.equal(held, true, 'the key is there to leak: the events secret store holds it');
  } finally {
    await owner.stop();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('JUDGE-SHOW: a document that drifted from its digest is refused, never returned; arguments are read strictly', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-judge-show-drift-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = {
      judgeId: 'jev',
      version: 1,
      kind: 'typesafe',
      provider: 'typesafe',
      model: 'jev-1.13.0',
      endpoint: 'https://api.typesafe.ai/v1/systemone',
      promptTemplate: 'typesafe-jev-noul-v1',
      protocol: 'noul',
    };
    const text = canonicalJson(document);
    store.database
      .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run('jev@1', 'jev', 1, text, sha256Hex(text));
    const reader = new JudgeReader({ store });
    assert.deepEqual(reader.show({ judgeId: 'jev' }).document, document);
    const drifted = canonicalJson({ ...document, apiKey: 'fake-smuggled' });
    store.database.prepare('UPDATE judge_versions SET document = ? WHERE id = ?').run(drifted, 'jev@1');
    assert.throws(
      () => reader.show({ judgeId: 'jev' }),
      (error: unknown) => error instanceof CommsError && error.code === 'CONFIG',
      'a document that is not the approved one is never returned',
    );
    store.database.prepare('UPDATE judge_versions SET digest = ? WHERE id = ?').run(sha256Hex(drifted), 'jev@1');
    assert.throws(
      () => reader.show({ judgeId: 'jev' }),
      (error: unknown) => error instanceof CommsError && error.code === 'CONFIG',
      'nor one with a field a judge document has no place for, even with a matching digest',
    );
    for (const args of [{}, { judgeId: '' }, { judgeId: 'jev', version: 1.5 }, { judgeId: 'jev', caller: {} }])
      assert.throws(
        () => reader.show(args),
        (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
        JSON.stringify(args),
      );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
