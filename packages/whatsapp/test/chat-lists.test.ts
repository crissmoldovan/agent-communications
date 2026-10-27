import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentMarkerHint, handoffText } from '@agentcomms/core';
import { allowChat, clearChats, denyChat } from '../src/operations/chat-lists.ts';
import { ALICE, BOB, ERIN_STATUS, GROUP, HIDDEN } from './support/fixture.ts';
import { ownInline, ownText } from './support/handoffs.ts';
import { newHarness } from './support/harness.ts';
import { ACCOUNT, asIfAbsent, connect, NOBODY, person, surfaces } from './support/surfaces.ts';

/**
 * A person's allow and deny lists of chats: which chats an agent may see at all. Applied by every read on both
 * surfaces — chats, read, search, draft and status's counts — and by sync, which leaves hidden chats out of the index.
 * A hidden chat does not appear, and asking for it by id gets exactly the answer a chat that does not exist gets.
 */

test('deny hides a chat from every read on both surfaces, and answers for it as for a chat that does not exist', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const { call, close } = await connect(harness);
  const on = surfaces(harness, call);
  try {
    const before = await on.counts();
    const lists = await person(harness, 'deny', '+1 555 555 0102');
    assert.deepEqual(lists, { ...lists, allow: [], deny: [BOB] }, 'a number is kept as its chat id');

    assert.ok(!(await on.chats()).includes(BOB));
    assert.deepEqual(await on.search('report'), ['10', '17'], 'Bob’s message is not found');
    assert.deepEqual(await on.search('Bobby'), []);
    assert.deepEqual(await on.search('report', '--chat', BOB), []);

    const absent = await on.read(NOBODY);
    const hidden = await on.read(BOB);
    assert.equal(hidden.code, 66);
    assert.equal(hidden.error?.code, 'NOT_FOUND');
    assert.deepEqual(
      { message: hidden.error?.message, hint: hidden.error?.hint },
      asIfAbsent(absent.error, BOB),
      'the refusal is word for word the one a chat that does not exist gets',
    );
    assert.equal((await on.read('+15555550102')).code, 66, 'by number too');

    for (const withAccount of [true, false]) {
      const draft = await on.draft(BOB, withAccount);
      assert.equal(draft.code, 66, `draft ${withAccount ? 'with' : 'without'} --account`);
      assert.equal(draft.error?.code, 'NOT_FOUND');
    }
    assert.equal((await on.draft(ALICE)).code, 0, 'the others are drafted to as before');

    const after = await on.counts();
    assert.equal(after.chats, (before.chats as number) - 1, 'nor is it counted');
    assert.equal(after.messages, (before.messages as number) - 1);
  } finally {
    await close();
  }
});

test('an allow list shows only the chats on it, on both surfaces', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const { call, close } = await connect(harness);
  const on = surfaces(harness, call);
  try {
    await person(harness, 'allow', ALICE);
    const lists = await person(harness, 'allow', GROUP);
    assert.deepEqual([lists.allow, lists.deny], [[ALICE, GROUP], []]);

    assert.deepEqual(await on.chats(), [GROUP, ALICE]);
    assert.deepEqual(await on.chats('status'), [], 'status updates of people not allowed stay hidden');
    assert.deepEqual(await on.search('invoice'), ['1', '3']);
    assert.deepEqual(await on.search('report'), ['10'], 'only the group’s');
    assert.equal((await on.read(HIDDEN)).code, 66);
    assert.equal((await on.read(ALICE)).code, 0);
    assert.equal((await on.draft(BOB)).code, 66, 'nor drafted to');
    assert.equal((await on.draft('+1 555 555 0199')).code, 66, 'not even a number that has no chat');
    assert.ok((await on.draft(ALICE)).links);
    assert.equal((await on.counts()).chats, 2);
  } finally {
    await close();
  }
});

test('deny beats allow, a number and its id are one entry, a number covers its status posts, and clear undoes', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const { call, close } = await connect(harness);
  const on = surfaces(harness, call);
  try {
    await person(harness, 'allow', ALICE);
    await person(harness, 'allow', GROUP);
    const byNumber = await person(harness, 'deny', '+15555550101');
    const byId = await person(harness, 'deny', ALICE);
    assert.deepEqual([byNumber.deny, byId.deny], [[ALICE], [ALICE]], 'a number and its id are one entry');
    assert.deepEqual(await on.chats(), [GROUP], 'denied and allowed: denied wins');
    const lists = await person(harness, 'allow', '+1 555 555 0101');
    assert.deepEqual([lists.allow, lists.deny], [[ALICE, GROUP], []], 'allowing it again takes it off the deny list');
    assert.deepEqual(await on.chats(), [GROUP, ALICE]);

    const cleared = await person(harness, 'clear', '+15555550101');
    assert.deepEqual([cleared.allow, cleared.deny], [[GROUP], []], 'clear takes one chat off both lists');
    const empty = await person(harness, 'clear');
    assert.deepEqual([empty.allow, empty.deny], [[], []], 'and with no chat, empties both');
    assert.equal((await on.chats()).length, 6, 'everything but status updates, as before');

    // A number names the person: their own status posts go with them, and their posts in the status feed.
    assert.deepEqual(await on.chats('status'), [ERIN_STATUS, 'status@broadcast']);
    await person(harness, 'deny', '+15555550105');
    assert.deepEqual(await on.chats('status'), ['status@broadcast']);
    assert.deepEqual(await on.search('update', '--kind', 'status'), ['16']);
    await person(harness, 'deny', ALICE);
    assert.deepEqual(await on.search('update', '--kind', 'status'), [], 'Alice’s post in the status feed is hers');
    assert.deepEqual((await on.read('status@broadcast')).ids, []);
    const feed = (await harness.cli(['chats', '--account', ACCOUNT, '--kind', 'status', '--json'])).data();
    assert.equal((feed.chats as { messages: number }[])[0]?.messages, 0, 'nor is it counted in the feed');
    const pageFrom = async (before: string) =>
      (await harness.cli(['read', 'status@broadcast', '--account', ACCOUNT, '--before', before, '--json'])).json()
        .error;
    assert.deepEqual(
      await pageFrom('16'),
      JSON.parse(JSON.stringify(await pageFrom('999999')).replaceAll('999999', '16')),
      'paging from her post is refused as from a message that does not exist',
    );

    // Denying the only allowed chat hides it; it does not empty the allow list and show everything.
    await person(harness, 'clear');
    await person(harness, 'allow', GROUP);
    const denied = await person(harness, 'deny', GROUP);
    assert.deepEqual([denied.allow, denied.deny], [[GROUP], [GROUP]]);
    assert.deepEqual(await on.chats(), []);
  } finally {
    await close();
  }
});

test('a list applies at once, and the next sync leaves what it hides out of the index', async () => {
  const harness = await newHarness();
  await harness.ready(ACCOUNT);
  const { call, close } = await connect(harness);
  const on = surfaces(harness, call);
  try {
    await person(harness, 'deny', BOB);
    assert.equal((await on.read(BOB)).code, 66, 'hidden from the index already there, without a sync');
    await person(harness, 'clear');
    assert.equal((await on.read(BOB)).code, 0);

    await person(harness, 'deny', BOB);
    const synced = await harness.cli(['sync', '--account', ACCOUNT, '--json']);
    assert.equal(synced.data().chats, 5, 'the sync did not index it');
    await person(harness, 'clear');
    assert.equal((await on.read(BOB)).code, 66, 'not in the index at all: cleared, it is still not there');
    const cleared = await harness.cli(['clear', '--account', ACCOUNT], { platform: 'darwin' });
    assert.ok(
      cleared.stdout.includes(ownText(harness.env, ['sync', '--account', ACCOUNT])),
      'the person is told to sync',
    );
    await harness.cli(['sync', '--account', ACCOUNT]);
    assert.equal((await on.read(BOB)).code, 0, 'the next sync brings it back');

    // A status post whose author is hidden is left out of the index too, though the feed it is in is not.
    await person(harness, 'deny', ALICE);
    await harness.cli(['sync', '--account', ACCOUNT]);
    await person(harness, 'clear');
    assert.deepEqual((await on.read('status@broadcast')).ids, []);
    await harness.cli(['sync', '--account', ACCOUNT]);
    assert.deepEqual((await on.read('status@broadcast')).ids, ['16']);
  } finally {
    await close();
  }
});

test('a list change renders its next sync for the selected Windows shell', async () => {
  const harness = await newHarness();
  await harness.ready('7/whatsapp');
  const result = await clearChats(harness.context({ platform: 'win32' }), { account: '7/whatsapp' });
  // The command itself, written out as its text where the result leaves (`handoffText`, or `--json`).
  const next = handoffText(result.next);
  assert.equal(next, ownText(harness.env, ['sync', '--account', '7/whatsapp'], 'win32'));
  assert.equal(JSON.parse(JSON.stringify(result)).next, next);
  assert.ok(next.endsWith(' sync --account "7/whatsapp"'), next);
});

test('allow, deny and clear are a person’s: refused to an agent, unchanged by one, and offered by no tool', async () => {
  const harness = await newHarness({ env: { CLAUDECODE: '1' } });
  await harness.ready(ACCOUNT);
  const configPath = join(harness.configDir, 'config.json');
  const config = readFileSync(configPath);
  assert.equal(harness.listsFile(), null);
  for (const argv of [['allow', ALICE], ['deny', ALICE], ['clear'], ['clear', ALICE]]) {
    const result = await harness.cli([...argv, '--account', ACCOUNT, '--json']);
    assert.equal(result.code, 10, `${argv.join(' ')}: only a person may`);
    assert.equal(result.json().error?.code, 'LOOSENING_REFUSED');
    assert.match(String(result.json().error?.message), /only a person changes which chats an agent may see/);
    assert.equal(
      result.json().error?.hint,
      // The refusal names the marker and how a person clears it (0.35.0 re-review, LOW 3).
      `Ask the person to run ${ownInline(harness.env, [...argv, '--account', ACCOUNT])} in their own terminal. ${agentMarkerHint('CLAUDECODE', 'darwin')}`,
    );
  }
  assert.deepEqual(readFileSync(configPath), config, 'nothing was written');
  assert.equal(harness.listsFile(), null, 'no list was written either');

  // Nor from anywhere but the command line, marker or no marker: the operations refuse a server's context.
  const plain = await newHarness();
  await plain.ready(ACCOUNT);
  const server = plain.context({ surface: 'mcp' });
  for (const attempt of [
    () => allowChat(server, { account: ACCOUNT, chat: ALICE }),
    () => denyChat(server, { account: ACCOUNT, chat: ALICE }),
    () => clearChats(server, { account: ACCOUNT }),
  ]) {
    await assert.rejects(attempt, (error: unknown) => (error as { code?: string }).code === 'LOOSENING_REFUSED');
  }
  const cli = plain.context({ surface: 'cli' });
  assert.deepEqual((await denyChat(cli, { account: ACCOUNT, chat: ALICE })).deny, [ALICE], 'a person’s terminal may');

  const { client, close } = await connect(harness);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!tools.some((name) => /allow|deny|clear|list|hide|visib/.test(name)), tools.join(', '));
  } finally {
    await close();
  }
});
