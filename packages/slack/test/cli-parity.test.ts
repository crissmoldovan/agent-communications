import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Where the CLI has to agree with the MCP server.
 *
 * In a file of its own rather than in `cli.test.ts`, which drives real sign-ins over loopback and already runs
 * close to the per-file time limit: these need no socket and no child process, only the command and a scripted
 * Slack, and they should not be what pushes that file over.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function cli(harness: Harness, argv: string[], options: { read?: FakeFetch } = {}) {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  err.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: false }),
      stderr: Object.assign(err, { isTTY: false }),
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
    },
    openBrowser: () => undefined,
    probe: (input, init) => harness.probe(input, init),
    // Always a scripted Slack: a test that forgot it would reach the real one.
    read: options.read ?? slackReplies({}),
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

function slackReplies(script: Record<string, unknown>): FakeFetch {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
}

test('search marks an author from another organisation as external, as the MCP tool does', async () => {
  /*
   * `read` and `thread` passed the workspace's own team id and `search` did not, so the same message came back
   * `external: true` from `slack_search` and `external: false` from `agent-slack search`. The external flag is what
   * a reader is told to lean on when deciding whether a message came from inside the organisation.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001' });
  const read = slackReplies({
    'search.messages': {
      ok: true,
      messages: {
        total: 1,
        paging: { page: 1, pages: 1 },
        matches: [{ ts: '1.0', user: 'U9', team: 'T_OTHER', text: 'hello', channel: { id: 'C1', name: 'shared' } }],
      },
    },
    'users.info': { ok: true, user: { id: 'U9', team_id: 'T_OTHER', profile: { display_name: 'stranger' } } },
  });
  const result = await cli(harness, ['--json', 'search', 'hello', '--workspace', 'acme'], { read });
  assert.equal(result.code, EXIT_CODES.OK, result.stderr);
  const hit = result.json<Envelope<{ hits: { message: { attribution: { external: boolean } } }[] }>>().data?.hits[0];
  assert.equal(hit?.message.attribution.external, true);
});

test('a --limit or --page that is not a count is refused before anything is asked of Slack', async () => {
  // `--limit abc` used to become `limit=NaN` on the wire and come back `ok`; MCP refused the same input.
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  let asked = 0;
  const read = async () => {
    asked += 1;
    return new Response(JSON.stringify({ ok: true, channels: [], messages: { matches: [] }, files: [] }));
  };
  for (const argv of [
    ['channels', '--limit', 'abc'],
    ['channels', '--limit', '0'],
    ['read', 'C1', '--limit', '2.5'],
    ['thread', 'C1', '1.0', '--limit', '-1'],
    ['search', 'x', '--page', '0'],
    ['files', '--page', 'two'],
    ['people', '--limit', 'NaN'],
  ]) {
    const result = await cli(harness, ['--json', ...argv, '--workspace', 'acme'], { read });
    assert.equal(result.code, EXIT_CODES.USAGE, `${argv.join(' ')} should be a usage error`);
    assert.match(result.stdout, /is not a count/);
  }
  assert.equal(asked, 0, 'nothing reached Slack');
});

test('`draft show` reads this workspace’s draft, and not another’s', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002', userId: 'U0002' });
  const written = await cli(harness, [
    '--json',
    'draft',
    'create',
    '--workspace',
    'acme',
    '--channel',
    'C1',
    '--text',
    'ready when you are',
  ]);
  const draftId = String(written.json<Envelope<{ draftId: string }>>().data?.draftId);

  const shown = await cli(harness, ['--json', 'draft', 'show', draftId, '--workspace', 'acme']);
  assert.equal(shown.code, EXIT_CODES.OK, shown.stderr);
  assert.equal(shown.json<Envelope<{ source: string }>>().data?.source, 'ready when you are');

  const elsewhere = await cli(harness, ['--json', 'draft', 'show', draftId, '--workspace', 'zeta']);
  assert.equal(elsewhere.code, EXIT_CODES.NOT_FOUND);
});

test('`post prepare` leaves an audit record naming the CLI', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001', userId: 'U0001' });
  const read = slackReplies({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'general', num_members: 4, is_member: true } },
  });
  const written = await cli(harness, [
    '--json',
    'draft',
    'create',
    '--workspace',
    'acme',
    '--channel',
    'C1',
    '--text',
    'hi',
  ]);
  const draftId = String(written.json<Envelope<{ draftId: string }>>().data?.draftId);
  const prepared = await cli(harness, ['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', draftId], {
    read,
  });
  assert.equal(prepared.code, EXIT_CODES.OK, prepared.stderr);
  const records = await harness.core.audit.tail({ limit: 20 });
  assert.ok(
    records.some((record) => record.operation.startsWith('slack.post.prepare') && record.surface === 'cli'),
    `a prepare record from the CLI: ${JSON.stringify(records.map((r) => [r.operation, r.surface]))}`,
  );
});
