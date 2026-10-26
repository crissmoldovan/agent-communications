import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { LINEAR_GRAPHQL_ENDPOINT } from '../src/domain/linear-target.ts';
import { preparePinnedConnection } from '../src/network/pinned-connection.ts';
import { classifyLinearResponse, LinearClient, parseHttpResponse } from '../src/runtime/linear-client.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { FAKE_LABELS, FAKE_LINEAR_KEY, FAKE_TEAM, type FakeLinear, startFakeLinear } from './support/fake-linear.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The Linear integration (0.33.0 design §3.4): the key kept as a provider key, the hosted network admitting Linear's
 * GraphQL endpoint and nothing else there, and `integration show linear`, the person's read of what the key can see.
 * Every Linear here is the loopback fake in `support/fake-linear.ts`, and every key is fake.
 */

const APPROVAL_EXIT = new CommsError('APPROVAL_REQUIRED', 'x').exitCode;
const AUTH_EXIT = new CommsError('AUTH_REQUIRED', 'x').exitCode;

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

async function cli(
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv; readonly stateDir?: string } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
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
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run([...(options.stateDir === undefined ? [] : ['--state-dir', options.stateDir]), ...args], {
    streams,
    env: options.env ?? {},
    desktopOrigin: ATTESTED,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { code, stdout: out, stderr: err };
}

test('E3: the hosted network admits exactly Linear’s GraphQL URL, and still refuses every other, before DNS', async () => {
  const lookups: string[] = [];
  const resolver = {
    async lookup(hostname: string) {
      lookups.push(hostname);
      return ['8.8.8.8'];
    },
  };
  const connection = await preparePinnedConnection({
    url: LINEAR_GRAPHQL_ENDPOINT,
    addressMode: 'global-only',
    hostedPurpose: 'linear',
    resolver,
  });
  assert.equal(connection.hostname, 'api.linear.app');
  assert.equal(connection.useTls, true);
  assert.equal(connection.tls.certificateHost, 'api.linear.app');
  for (const url of [
    'https://api.linear.app/graphql/',
    'https://api.linear.app/graphql?x=1',
    'https://api.linear.app/oauth/token',
    'https://api.linear.app:8443/graphql',
    'https://linear.app/graphql',
    'https://evil.api.linear.app/graphql',
    'https://api.linear.app.example/graphql',
    'http://api.linear.app/graphql',
    'https://uploads.linear.app/graphql',
    // Linear's purpose admits no other hosted endpoint: a judge's or Analyse's.
    'https://api.typesafe.ai/v1/systemone',
    'https://openrouter.ai/api/v1/systemone',
    'https://api.anthropic.com/v1/messages',
  ])
    await assert.rejects(
      () => preparePinnedConnection({ url, addressMode: 'global-only', hostedPurpose: 'linear', resolver }),
      /global-only/u,
      url,
    );
  // And Linear's endpoint is reached only with Linear's purpose: not as a judge's, nor as Analyse's.
  for (const hostedPurpose of [undefined, 'analyse'] as const)
    await assert.rejects(
      () =>
        preparePinnedConnection({ url: LINEAR_GRAPHQL_ENDPOINT, addressMode: 'global-only', hostedPurpose, resolver }),
      /global-only/u,
      String(hostedPurpose),
    );
  assert.deepEqual(lookups, ['api.linear.app'], 'a refused URL never reaches DNS');
  // A global-only answer that is not a global address is refused too: Linear is never this machine or its network.
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: LINEAR_GRAPHQL_ENDPOINT,
        addressMode: 'global-only',
        hostedPurpose: 'linear',
        resolver: { lookup: async () => ['127.0.0.1'] },
      }),
    /refused by global-only policy/u,
  );
});

test('E3: the Linear client sends the key as Linear asks, verifies TLS as api.linear.app, and reads chunked answers', {
  skip: WINDOWS_SKIP,
}, async () => {
  const fake = await startFakeLinear();
  try {
    const client = new LinearClient(fake.clientOptions());
    const outcome = await client.request({
      key: FAKE_LINEAR_KEY,
      query: 'query AgentCommsLinearWorkspace { viewer { organization { name } } }',
      variables: {},
    });
    assert.equal(outcome.kind, 'data');
    assert.deepEqual(fake.lookups, ['api.linear.app']);
    assert.deepEqual(fake.peers, ['8.8.8.8:443'], 'the pinned, vetted address');
    assert.deepEqual(fake.tlsNames, ['api.linear.app/api.linear.app']);
    assert.equal(fake.requests[0]?.authorization, FAKE_LINEAR_KEY, 'a personal key, with no Bearer');
    assert.equal(fake.requests[0]?.host, 'api.linear.app');
    // A key that is not one header value is refused before anything is sent.
    assert.deepEqual(await client.request({ key: 'two\nlines', query: 'query X { a }', variables: {} }), {
      kind: 'refused',
      status: 0,
      code: 'LINEAR_KEY_MALFORMED',
    });
    assert.equal(fake.requests.length, 1);
    // A gate's refusal stops the request before that phase.
    await assert.rejects(
      client.request({
        key: FAKE_LINEAR_KEY,
        query: 'query X { a }',
        variables: {},
        gates: {
          finalGate: (phase) => {
            if (phase === 'write') throw new Error('revoked');
          },
        },
      }),
      /refused before its write/u,
    );
    assert.equal(fake.requests.length, 1, 'nothing was written');
  } finally {
    await fake.close();
  }
});

test('E3: Linear’s answers are classified by status and GraphQL code, never by its message', () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value));
  const errors = (code: string) => body({ errors: [{ message: 'repeats the title you sent', extensions: { code } }] });
  assert.deepEqual(classifyLinearResponse(400, errors('RATELIMITED')), { kind: 'rate-limited', status: 400 });
  assert.deepEqual(classifyLinearResponse(429, body({})), { kind: 'rate-limited', status: 429 });
  assert.deepEqual(classifyLinearResponse(503, body({})), { kind: 'server', status: 503 });
  assert.deepEqual(classifyLinearResponse(400, errors('INVALID_INPUT')), {
    kind: 'refused',
    status: 400,
    code: 'INVALID_INPUT',
  });
  assert.deepEqual(classifyLinearResponse(401, body({})), { kind: 'refused', status: 401, code: 'HTTP_401' });
  assert.deepEqual(classifyLinearResponse(200, errors('FORBIDDEN')), {
    kind: 'refused',
    status: 200,
    code: 'FORBIDDEN',
  });
  assert.deepEqual(classifyLinearResponse(200, errors('not a code; drop table')), {
    kind: 'refused',
    status: 200,
    code: 'GRAPHQL_ERROR',
  });
  assert.deepEqual(classifyLinearResponse(302, body({})), { kind: 'refused', status: 302, code: 'HTTP_302' });
  assert.deepEqual(classifyLinearResponse(200, Buffer.from('<html>')), { kind: 'network', preIo: false });
  assert.deepEqual(
    parseHttpResponse(
      Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{"a\r\n4\r\n":1}\r\n0\r\n\r\n'),
    ),
    {
      status: 200,
      body: Buffer.from('{"a":1}'),
    },
  );
  assert.equal(parseHttpResponse(Buffer.from('garbage')), null);
});

async function filesBelow(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'secrets') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await filesBelow(path)));
    else found.push(path);
  }
  return found;
}

test('E3: integration show linear is the person’s read of what their Linear key sees, and the key never leaves its slot', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-linear-integration-');
  const configDir = await emptyConfigDir(stateDir);
  const opened = await openEventDatabase({ stateDir });
  await selectEventSecretStore(opened.database, 'file');
  opened.close();
  let fake: FakeLinear | undefined;
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  const outputs: string[] = [];
  const ok = async (args: readonly string[], stdin?: string) => {
    const ran = await cli(['--json', ...args], { stateDir, ...(stdin === undefined ? {} : { stdin }) });
    outputs.push(ran.stdout, ran.stderr);
    assert.equal(ran.code, 0, `${args.join(' ')}: ${ran.stderr}`);
    return JSON.parse(ran.stdout) as Record<string, unknown>;
  };
  try {
    fake = await startFakeLinear();
    owner = await startEventOwner({ stateDir, configDir, tickMs: 60_000, linearClient: fake.clientOptions() });
    // Without a key nothing is asked of Linear.
    assert.deepEqual(await ok(['integration', 'show', 'linear']), {
      integration: 'linear',
      connected: false,
      workspace: null,
      teams: [],
    });
    assert.equal(fake.requests.length, 0);

    // The key arrives on stdin, as the app sends it; Linear serves no judge, so no judge holds it.
    assert.deepEqual(await ok(['provider', 'key', 'set', 'linear'], `${FAKE_LINEAR_KEY}\n`), {
      provider: 'linear',
      hasKey: true,
      judges: 0,
    });
    assert.deepEqual(
      ((await ok(['provider', 'list'])) as { providers: { id: string; hasKey: boolean }[] }).providers.find(
        (entry) => entry.id === 'linear',
      ),
      { id: 'linear', name: 'Linear', hasKey: true },
    );
    const shown = await ok(['integration', 'show', 'linear']);
    assert.deepEqual(shown, {
      integration: 'linear',
      connected: true,
      workspace: 'Example Workspace',
      teams: [FAKE_TEAM],
    });
    // With a team, the labels an issue there can carry: the team's and the workspace's, each once, by name.
    assert.deepEqual(await ok(['integration', 'show', 'linear', '--team', 'cue']), {
      ...shown,
      labels: [FAKE_LABELS[0], FAKE_LABELS[1]],
    });
    const unknownTeam = await cli(['integration', 'show', 'linear', '--team', 'NOPE'], { stateDir });
    assert.notEqual(unknownTeam.code, 0);
    assert.match(unknownTeam.stderr, /sees no such team/u);

    // Inside an MCP server's process it is refused before the owner is asked; an agent window's call too.
    const before = fake.requests.length;
    const inMcp = await cli(['integration', 'show', 'linear'], { stateDir, env: { AGENTCOMMS_MCP_SERVER: 'events' } });
    assert.equal(inMcp.code, APPROVAL_EXIT);
    assert.match(inMcp.stderr, /what your Linear key can see is for a person/u);
    await assert.rejects(
      new EventControlClient({ stateDir }).request('integration-show', {
        integration: 'linear',
        caller: { kind: 'session', id: '25f971a3-0c69-44e3-971c-3a4656afa986' },
      }),
      /for a person, at a terminal or in the app, not an agent window/u,
    );
    assert.equal(fake.requests.length, before, 'neither reached Linear');

    // A key Linear refuses says so, as an authentication failure.
    await ok(['provider', 'key', 'set', 'linear'], 'fake-revoked-key\n');
    const refused = await cli(['integration', 'show', 'linear'], { stateDir });
    assert.equal(refused.code, AUTH_EXIT, refused.stderr);
    assert.match(refused.stderr, /Linear refused the key/u);

    // Removing the key is a tightening: nothing more is asked of Linear.
    assert.deepEqual(await ok(['provider', 'key', 'remove', 'linear']), {
      provider: 'linear',
      hasKey: false,
      judges: 0,
    });
    const afterRemove = fake.requests.length;
    assert.equal((await ok(['integration', 'show', 'linear'])).connected, false);
    assert.equal(fake.requests.length, afterRemove);
    assert.ok(
      fake.requests.every((request) => request.host === 'api.linear.app'),
      'every request names Linear’s host',
    );
  } finally {
    await owner?.stop();
    await fake?.close();
  }
  try {
    for (const output of outputs) assert.ok(!output.includes(FAKE_LINEAR_KEY), `an output names the key: ${output}`);
    for (const file of await filesBelow(stateDir)) {
      const bytes = await readFile(file);
      assert.ok(!bytes.includes(Buffer.from(FAKE_LINEAR_KEY)), `${file.slice(stateDir.length)} holds the key`);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
