import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { type CommsError, EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { manifestFor } from '../src/operations/manifest.ts';
import { slackCommand, slackInline } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { newOrganisationHarness } from './support/organisation.ts';

/**
 * The two setup problems the owner met in a live check of the agent label (2026-10-15), each from both surfaces:
 *
 * - the client-secret manifest (`--with-client-secret`, `pkce: false`) told the person there was no client secret to
 *   copy, and printed a connect command without `--with-client-secret`;
 * - a new app's manifest refused without `--port`, so whoever set it up had to pick a number. It now chooses a free
 *   loopback port, never one another workspace here already uses, and the command it prints carries the same one.
 *
 * Nothing here reaches Slack: `manifest` and `slack_manifest` only build text, and the one socket opened is a
 * loopback port asked of the system and closed again.
 */

/** Slack refusing everything: nothing here asks Slack anything, and a test that did would say so. */
const nothing = async () => new Response(JSON.stringify({ ok: false, error: 'unknown_method' }));

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

interface ManifestData {
  mode: string;
  port: number;
  portFrom: 'given' | 'recorded' | 'chosen';
  redirectUrl: string;
  steps: string[];
  notes: string[];
  manifest: { oauth_config: { redirect_urls: string[]; pkce_enabled: boolean } };
}

/** The command line, its printed commands pinned to darwin's shell so a test can name them exactly. */
async function cli(harness: Harness, argv: string[]) {
  let stdout = '';
  const out = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: { stdout: out, stderr: new PassThrough(), stdin: new PassThrough() },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
    read: nothing,
    platform: 'darwin',
  });
  return { code, stdout, json: <T>() => JSON.parse(stdout) as T };
}

async function connect(harness: Harness) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch: nothing,
    probe: (input, init) => harness.probe(input, init),
    platform: 'darwin',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

/** Whether nothing holds this loopback port: it can be bound, and is let go at once. */
async function free(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise((settle) => {
    server.once('error', () => settle(false));
    server.listen(port, '127.0.0.1', () => server.close(() => settle(true)));
  });
}

const SECRET_CONNECT = [
  'workspace',
  'add',
  '<name>',
  '--mode',
  'send',
  '--client-id',
  '<the Client ID>',
  '--port',
  '47911',
  '--with-client-secret',
];
const PKCE_CONNECT = ['workspace', 'add', '<name>', '--client-id', '<the Client ID>', '--port', '47911'];

// ── Problem 1: the client-secret manifest's instructions ─────────────────────────────────────────────────────────

test('the client-secret manifest says, in numbered steps, to create a new app, keep its Client Secret for a hidden prompt, and connect with --with-client-secret', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['manifest', '--mode', 'send', '--with-client-secret', '--port', '47911']);
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
  const text = result.stdout;
  const flat = text.replace(/\s+/g, ' ');

  // What the PKCE app's text says, and is false here: this app has a client secret, and it is needed.
  assert.doesNotMatch(flat, /no client secret to copy/);
  assert.doesNotMatch(flat, /the only thing you need from that page/);
  assert.doesNotMatch(flat, /signs in with PKCE/);

  // Three numbered steps, in order: create the app, copy the Client ID and keep the secret, connect.
  const step = (n: number) =>
    new RegExp(`^ *${n}\\. (.*)$`, 'm').exec(text)?.[1] ?? assert.fail(`no step ${n}:\n${text}`);
  assert.match(step(1), /new app.*manifest|manifest.*new app/i);
  assert.match(step(2), /Basic Information.*Client ID.*Client Secret/);
  assert.match(step(2), /hidden prompt/);
  assert.match(step(2), /never pasted? into (a )?chat/i);
  assert.ok(
    step(3).includes(slackInline(harness.core.paths, SECRET_CONNECT, 'darwin')),
    `the connect step carries --with-client-secret and the port:\n${step(3)}`,
  );
  assert.equal(/^ *4\. /m.test(text), false, 'three steps, no more');

  // Why it has to be a new app: PKCE is off, and an existing app's cannot be.
  assert.match(flat, /PKCE (is )?off/);
  assert.match(flat, /cannot be undone on an existing app/);

  // And the manifest printed with it is the one those steps describe.
  const json = JSON.parse(text.slice(text.indexOf('{'))) as ManifestData['manifest'];
  assert.equal(json.oauth_config.pkce_enabled, false);
  assert.deepEqual(json.oauth_config.redirect_urls, ['http://localhost:47911/slack/callback']);
});

test('the PKCE manifest keeps its text, and its connect command carries no --with-client-secret', async () => {
  const harness = await newHarness();
  const result = await cli(harness, ['manifest', '--mode', 'send', '--port', '47911']);
  assert.equal(result.code, EXIT_CODES.OK, result.stdout);
  // Word for word, as before this fix.
  for (const line of [
    '1. Open https://api.slack.com/apps and choose "Create New App" → "From a manifest".',
    '2. Pick your workspace, then paste the JSON below.',
    '3. Create the app. On "Basic Information", copy the Client ID.',
    'The Client ID is the only thing you need from that page. It is not a secret, and there',
    'is no client secret to copy: this signs in with PKCE, which replaces one.',
    'Keep --port 47911: Slack matches the redirect URL in this manifest exactly.',
  ]) {
    assert.ok(result.stdout.includes(line), `missing: ${line}\n${result.stdout}`);
  }
  assert.ok(result.stdout.includes(`Then connect it:\n  ${slackCommand(harness.core.paths, PKCE_CONNECT, 'darwin')}`));
  assert.doesNotMatch(result.stdout, /--with-client-secret/);
  assert.doesNotMatch(result.stdout, /now this app's/, 'a port given is not one this call chose');
});

test('slack_manifest returns the same steps as the command, for the client-secret app and for the PKCE one', async () => {
  const harness = await newHarness();
  const { call, close } = await connect(harness);
  try {
    for (const pkce of [false, true]) {
      const tool = await call('slack_manifest', { mode: 'send', port: 47911, ...(pkce ? {} : { pkce: false }) });
      assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
      const command = await cli(harness, [
        '--json',
        'manifest',
        '--mode',
        'send',
        '--port',
        '47911',
        ...(pkce ? [] : ['--with-client-secret']),
      ]);
      const data = command.json<Envelope<ManifestData>>().data ?? assert.fail(command.stdout);
      assert.deepEqual(tool.structuredContent, data, `pkce ${pkce}`);

      assert.equal(data.steps.length, 3, `pkce ${pkce}: ${data.steps.join('\n')}`);
      const connectStep = data.steps[2] ?? '';
      if (pkce) {
        assert.ok(connectStep.includes(slackInline(harness.core.paths, PKCE_CONNECT, 'darwin')), connectStep);
        assert.doesNotMatch(data.steps.join(' '), /--with-client-secret/);
        assert.match(data.steps[1] ?? '', /no client secret to copy/);
      } else {
        assert.ok(connectStep.includes(slackInline(harness.core.paths, SECRET_CONNECT, 'darwin')), connectStep);
        assert.match(data.steps[1] ?? '', /Client Secret.*hidden prompt.*never pasted? into (a )?chat/i);
        assert.match(data.notes.join(' '), /PKCE (is )?off.*cannot be undone on an existing app/);
      }
    }
  } finally {
    await close();
  }
});

// ── Problem 2: a new app's port, chosen rather than asked for ─────────────────────────────────────────────────────

test('a new app’s manifest without --port gets a free port, never another workspace’s, the same in the command and the manifest', async () => {
  const harness = await newHarness();
  const recorded = new Set([50123, 50124]);
  for (const [i, port] of [...recorded].entries()) {
    await harness.addWorkspace({ alias: `ws${i}`, redirectPort: port });
  }
  const seen: number[] = [];
  for (const withSecret of [false, true]) {
    const json = await cli(harness, [
      '--json',
      'manifest',
      '--mode',
      'send',
      ...(withSecret ? ['--with-client-secret'] : []),
    ]);
    assert.equal(json.code, EXIT_CODES.OK, json.stdout);
    const data = json.json<Envelope<ManifestData>>().data ?? assert.fail(json.stdout);
    assert.equal(data.portFrom, 'chosen');
    assert.ok(Number.isInteger(data.port) && data.port > 0 && data.port <= 65535, String(data.port));
    assert.equal(recorded.has(data.port), false, `${data.port} is another workspace's`);
    assert.ok(await free(data.port), `${data.port} was given back free`);
    assert.equal(data.redirectUrl, `http://localhost:${data.port}/slack/callback`);
    assert.deepEqual(data.manifest.oauth_config.redirect_urls, [data.redirectUrl]);
    assert.ok(
      data.steps.some((step) => step.includes(`--port ${data.port}`)),
      `the connect step names the same port:\n${data.steps.join('\n')}`,
    );
    // One sentence: the port is this app's now, because Slack matches the redirect exactly, and later sign-ins reuse it.
    const said = data.notes.filter((note) => note.includes(String(data.port)));
    assert.equal(said.length, 1, data.notes.join('\n'));
    assert.match(said[0] ?? '', /now this app's.*Slack matches the redirect URL exactly.*later sign-in.* reuse/);
    seen.push(data.port);

    // The same, as a person reads it: the manifest's redirect and the command's --port are one number.
    const human = await cli(harness, ['manifest', '--mode', 'send', ...(withSecret ? ['--with-client-secret'] : [])]);
    assert.equal(human.code, EXIT_CODES.OK, human.stdout);
    const redirect = /"http:\/\/localhost:(\d+)\/slack\/callback"/.exec(human.stdout)?.[1];
    const flags = [...human.stdout.matchAll(/--port (\d+)/g)].map((match) => match[1]);
    assert.ok(redirect, human.stdout);
    assert.ok(flags.length > 0, human.stdout);
    for (const flag of flags) assert.equal(flag, redirect, human.stdout);
    assert.equal(recorded.has(Number(redirect)), false);
    assert.match(human.stdout.replace(/\s+/g, ' '), new RegExp(`Port ${redirect} [^.]*now this app's`));
  }
  assert.equal(seen.length, 2);
});

test('slack_manifest without a port chooses one for a new app, as the command does', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', redirectPort: 50123 });
  const { call, close } = await connect(harness);
  try {
    const ports: number[] = [];
    for (const args of [{ mode: 'read' }, { mode: 'send', pkce: false }]) {
      const tool = await call('slack_manifest', args);
      assert.notEqual(tool.isError, true, JSON.stringify(tool.structuredContent));
      const data = tool.structuredContent as unknown as ManifestData;
      assert.equal(data.portFrom, 'chosen');
      assert.notEqual(data.port, 50123);
      assert.ok(await free(data.port));
      assert.deepEqual(data.manifest.oauth_config.redirect_urls, [`http://localhost:${data.port}/slack/callback`]);
      assert.ok(
        data.steps.some((step) => step.includes(`--port ${data.port}`)),
        data.steps.join('\n'),
      );
      assert.match(data.notes.join(' '), /now this app's/);
      ports.push(data.port);
    }
    // A port given still wins, and is not one this call chose.
    const given = (await call('slack_manifest', { mode: 'read', port: 47911 }))
      .structuredContent as unknown as ManifestData;
    assert.equal(given.port, 47911);
    assert.equal(given.portFrom, 'given');
    assert.doesNotMatch(given.notes.join(' '), /now this app's/);
    // A connected workspace's own is the one it recorded.
    const recorded = (await call('slack_manifest', { workspace: 'acme' })).structuredContent as unknown as ManifestData;
    assert.equal(recorded.port, 50123);
    assert.equal(recorded.portFrom, 'recorded');
  } finally {
    await close();
  }
});

test('the port chosen is never one recorded for a workspace or an organisation’s app, whatever the system offers first', async () => {
  const harness = await newOrganisationHarness({ port: 50200 });
  await harness.addWorkspace({ alias: 'acme/slack', redirectPort: 50201 });
  const context = harness.context({ platform: 'darwin' });
  // The system offers the taken ones first; only the fourth is nobody's.
  const offered = [50201, 50200, 50201, 50999];
  let asked = 0;
  const result = await manifestFor(context, {
    mode: 'send',
    probePort: async () => offered[asked++] ?? assert.fail('asked once too often'),
  });
  assert.equal(result.port, 50999);
  assert.equal(result.portFrom, 'chosen');
  assert.equal(asked, 4);

  // One that only ever offers taken ports is refused, after a bounded number of tries, pointing at --port.
  let tries = 0;
  await assert.rejects(
    manifestFor(context, {
      mode: 'send',
      probePort: async () => {
        tries++;
        return 50200;
      },
    }),
    (error: CommsError) => {
      assert.match(error.message, /free loopback port/);
      assert.match(error.hint ?? '', /--port/);
      return true;
    },
  );
  assert.ok(tries > 1 && tries <= 50, String(tries));
});

test('a workspace named without a recorded port is still refused rather than given a new one', async () => {
  // Its app already names a port; a new one would be a redirect Slack does not know.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const result = await cli(harness, ['--json', 'manifest', '--workspace', 'acme']);
  assert.equal(result.code, EXIT_CODES.USAGE, result.stdout);
});
