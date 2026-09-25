import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  error?: { code: string; message: string; hint?: string };
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

// ── An unreadable draft ─────────────────────────────────────────────────────────────────────────────────────────

const DAMAGED = 'dft_AAAAAAAAAAAAAAAAAAAAAA';

/** Writes a draft file that is not a draft any more — a disk that filled, a hand edit gone wrong. */
async function damage(harness: Harness, contents: string): Promise<string> {
  const directory = join(harness.core.paths.stateDir, 'slack', 'drafts');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${DAMAGED}.json`);
  await writeFile(path, contents);
  return path;
}

test('an unreadable draft can be deleted as its refusal says, and the result says what went', async () => {
  /*
   * The refusal to read it said "delete it with `agent-slack draft delete`", and the delete read it first, so it
   * refused too. `draft list` skips a file it cannot read, so the draft was invisible as well as undeletable.
   */
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme' });
  const path = await damage(harness, '{not json');

  const shown = await cli(harness, ['--json', 'draft', 'show', DAMAGED, '--workspace', 'acme']);
  assert.equal(shown.code, EXIT_CODES.BAD_DATA);
  assert.match(
    shown.json<Envelope<never>>().error?.hint ?? '',
    new RegExp(`agent-slack draft delete ${DAMAGED}`),
    'the refusal names the draft to delete',
  );

  const deleted = await cli(harness, ['--json', 'draft', 'delete', DAMAGED, '--workspace', 'acme']);
  assert.equal(deleted.code, EXIT_CODES.OK, deleted.stdout);
  assert.deepEqual(deleted.json<Envelope<unknown>>().data, {
    draftId: DAMAGED,
    deleted: true,
    unreadable: true,
    workspaceConfirmed: false,
  });
  await assert.rejects(access(path), 'and the file is gone');

  // The words a person reads say what was removed, since nobody ever saw what it said.
  await damage(harness, '{not json');
  const human = await cli(harness, ['draft', 'delete', DAMAGED, '--workspace', 'acme']);
  assert.equal(human.code, EXIT_CODES.OK, human.stderr);
  assert.match(human.stdout, /could not be read/);
  assert.match(human.stdout, /did not say which workspace/);

  // JSON that parses is not therefore a draft: `null` has no owner to check, and used to crash the check instead.
  await damage(harness, 'null');
  const empty = await cli(harness, ['--json', 'draft', 'delete', DAMAGED, '--workspace', 'acme']);
  assert.equal(empty.code, EXIT_CODES.OK, empty.stdout);
  assert.equal(empty.json<Envelope<{ unreadable: boolean }>>().data?.unreadable, true);
});

test('an unreadable draft that still names another workspace is left for that workspace to delete', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', workspaceId: 'T0001' });
  const zeta = await harness.addWorkspace({ alias: 'zeta', workspaceId: 'T0002' });
  // Cut off part-way, as a full disk leaves it: the owner is still on its second line.
  const path = await damage(harness, `{\n  "draftId": "${DAMAGED}",\n  "accountId": "${zeta.id}",\n  "payload": {`);

  const stolen = await cli(harness, ['--json', 'draft', 'delete', DAMAGED, '--workspace', 'acme']);
  assert.equal(stolen.code, EXIT_CODES.NOT_FOUND, stolen.stdout);
  await access(path);

  const own = await cli(harness, ['--json', 'draft', 'delete', DAMAGED, '--workspace', 'zeta']);
  assert.equal(own.code, EXIT_CODES.OK, own.stdout);
  assert.equal(own.json<Envelope<{ workspaceConfirmed: boolean }>>().data?.workspaceConfirmed, true);
  await assert.rejects(access(path));
});
