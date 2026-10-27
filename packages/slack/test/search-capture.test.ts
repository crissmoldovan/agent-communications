import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { slackCaptures } from '../src/search-capture.ts';
import { type Script, scriptedSlack } from './support/amend.ts';
import { type Harness, newHarness } from './support/harness.ts';

/*
 * Slack's half of Search on this machine (design 2026-10-26-local-search, S2, S3, §5): a read, a thread, a search and a
 * post hand what they had in hand to core's capture after they succeed — only where the person switched Search on for
 * the workspace, never from the account's own user or an app, and never changing what the call returns. Against a
 * scripted Slack; nothing reaches the real one. The inbox's lines are sealed, so the words planted here are in none.
 */

const BODY = 'Davids message: can we talk about the October invoice';
const REPLY = 'Anas reply: the bill has the wrong address';
const OWN = 'Jos own words, never an ask';
const DRAFT = 'the reply the agent wrote';
const THEIRS = '1700000005.000100';
const REPLY_TS = '1700000006.000100';
const OWN_TS = '1700000007.000100';
const BOT_TS = '1700000008.000100';
const POSTED_TS = '1700000009.000100';

function script(): Script {
  return {
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'conversations.history': () => ({
      ok: true,
      messages: [
        { type: 'message', user: 'U2', text: BODY, ts: THEIRS },
        { type: 'message', user: 'U0001', text: OWN, ts: OWN_TS },
        { type: 'message', subtype: 'bot_message', bot_id: 'B1', text: 'a deploy bot', ts: BOT_TS },
      ],
    }),
    'conversations.replies': () => ({
      ok: true,
      messages: [
        { type: 'message', user: 'U2', text: BODY, ts: THEIRS, thread_ts: THEIRS },
        { type: 'message', user: 'U3', text: REPLY, ts: REPLY_TS, thread_ts: THEIRS },
      ],
    }),
    'search.messages': () => ({
      ok: true,
      messages: {
        total: 1,
        paging: { page: 1, pages: 1 },
        matches: [{ ts: THEIRS, user: 'U2', text: BODY, channel: { id: 'C1', name: 'eng' } }],
      },
    }),
    'users.info': (params) => ({
      ok: true,
      user: { id: params.get('user'), name: 'someone', profile: { display_name: 'Someone' } },
    }),
    'users.list': () => ({ ok: true, members: [] }),
    'chat.postMessage': () => ({ ok: true, channel: 'C1', ts: POSTED_TS }),
    'auth.test': () => ({
      ok: true,
      url: 'https://acme.slack.com/',
      team: 'Acme',
      user: 'jo',
      team_id: 'T0001',
      user_id: 'U0001',
    }),
  };
}

interface World {
  readonly harness: Harness;
  readonly accountId: string;
  cli(argv: string[]): Promise<{ code: number; stdout: string }>;
  lines(): string[];
}

async function world(): Promise<World> {
  const harness = await newHarness();
  const account = await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  mkdirSync(join(harness.home, 'Downloads'), { recursive: true });
  const fake = scriptedSlack(script());
  const inbox = join(harness.core.paths.stateDir, 'search', 'inbox');
  return {
    harness,
    accountId: account.id,
    async cli(argv) {
      let stdout = '';
      const out = new PassThrough();
      out.on('data', (chunk) => {
        stdout += String(chunk);
      });
      const code = await run(argv, {
        core: harness.core,
        env: harness.env,
        exchange: (params) => harness.exchange(params),
        streams: {
          stdout: Object.assign(out, { isTTY: false }),
          stderr: Object.assign(new PassThrough(), { isTTY: false }),
          stdin: Object.assign(new PassThrough(), { isTTY: false }),
        },
        openBrowser: () => undefined,
        probe: (probeInput, init) => harness.probe(probeInput, init),
        platform: 'darwin',
        read: (input, init) => fake.fetch(input, init),
        notify: null,
      });
      return { code, stdout };
    },
    lines: () =>
      existsSync(inbox)
        ? readdirSync(inbox).flatMap((name) =>
            readFileSync(join(inbox, name), 'utf8')
              .split('\n')
              .filter((line) => line.trim() !== ''),
          )
        : [],
  };
}

async function searchOn(w: World): Promise<void> {
  await w.harness.core.config.update((config) => ({ ...config, search: { enabled: 'on', accounts: [w.accountId] } }), {
    consent: { kind: 'loosening-consent', paths: ['search.enabled', 'search.accounts'] },
  });
}

test('with Search off a read keeps nothing; on, a person’s messages are kept — never the account’s own, never an app’s', async () => {
  const w = await world();
  const off = await w.cli(['--json', 'read', 'C1', '--workspace', 'acme']);
  assert.equal(off.code, EXIT_CODES.OK, off.stdout);
  assert.deepEqual(w.lines(), []);
  await searchOn(w);
  const on = await w.cli(['--json', 'read', 'C1', '--workspace', 'acme']);
  assert.equal(on.code, EXIT_CODES.OK, on.stdout);
  assert.equal(
    on.stdout.replace(/boundary=\\?"[^"\\]+\\?"/g, ''),
    off.stdout.replace(/boundary=\\?"[^"\\]+\\?"/g, ''),
    'the result is what it was',
  );
  assert.equal(w.lines().length, 1, 'David’s message; not Jo’s own, not the bot’s');
  assert.equal((await w.cli(['--json', 'thread', 'C1', THEIRS, '--workspace', 'acme'])).code, EXIT_CODES.OK);
  assert.equal(w.lines().length, 3);
  assert.equal((await w.cli(['--json', 'search', 'invoice', '--workspace', 'acme'])).code, EXIT_CODES.OK);
  assert.equal(w.lines().length, 4);
  for (const line of w.lines()) {
    for (const words of [BODY, REPLY, OWN, 'October invoice']) {
      assert.equal(line.includes(words), false, `sealed: ${words}`);
    }
  }
});

test('a post keeps the words that went, as out, once Slack accepted it', async () => {
  const w = await world();
  await searchOn(w);
  const draftId = JSON.parse(
    (
      await w.cli([
        '--json',
        'draft',
        'create',
        '--workspace',
        'acme',
        '--channel',
        'C1',
        '--thread',
        THEIRS,
        '--text',
        DRAFT,
      ])
    ).stdout,
  ).data.draftId as string;
  const prepared = await w.cli(['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', draftId]);
  assert.equal(prepared.code, EXIT_CODES.OK, prepared.stdout);
  const approvalId = JSON.parse(prepared.stdout).data.approvalId as string;
  const before = w.lines().length;
  const posted = await w.cli([
    '--json',
    'post',
    'send',
    '--workspace',
    'acme',
    '--draft',
    draftId,
    '--approval',
    approvalId,
    '--expect-channel',
    'C1',
  ]);
  assert.equal(posted.code, EXIT_CODES.OK, posted.stdout);
  assert.equal(w.lines().length, before + 1);
  assert.equal(posted.stdout.includes(DRAFT), false, 'nothing was added to what the post returned');
});

test('the capture describers keep only what the result holds', () => {
  assert.deepEqual(slackCaptures('slack.channels', { channels: [] }, {}), []);
  const [kept] = slackCaptures(
    'slack.post.send',
    { posted: { channel: 'C1', ts: POSTED_TS }, thread: THEIRS, said: DRAFT },
    {},
  );
  assert.equal(kept?.direction, 'out');
  assert.equal(kept?.sourceId, `C1/${POSTED_TS}`);
  assert.equal(kept?.replyTo, `C1/${THEIRS}`);
  assert.deepEqual(slackCaptures('slack.post.send', { posted: { channel: 'C1' }, thread: null, said: DRAFT }, {}), []);
});
