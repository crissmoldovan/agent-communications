import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import type { MessageShowResultV1, MessagesListResultV1 } from '../src/domain/messages.ts';
import { MessagesStore } from '../src/runtime/messages.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  bindDavid,
  cli,
  DAVID,
  deliver,
  lane,
  setUp,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * `message show <eventId>` (0.32.0 spec §3.6): one message's entry, as `messages list` gives it, but with every line
 * of its queue item's history rather than the newest of each kind. The person's read: refused inside an MCP server's
 * process (10), a malformed id is 64, and an event the service never observed is 66.
 */

const UNKNOWN = '0123456789abcdef0123456789abcdef';

async function runCli(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk;
  });
  stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await run(argv, { env, streams: { stdin: new PassThrough(), stdout, stderr } });
  return { code, out, err };
}

test('MSG-SHOW: an unknown event id is not found, and a malformed one a bad argument, before anything is read', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-message-show-');
  const store = await openEventDatabase({ stateDir });
  try {
    const messages = new MessagesStore({
      store,
      cipher: { decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes) },
      queue: { keptSummaries: async () => new Map() },
    });
    await assert.rejects(
      () => messages.show(UNKNOWN),
      (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
    );
    for (const id of ['', 'ABCDEF0123456789ABCDEF0123456789', 'event-00001', `${UNKNOWN}0`, 42])
      await assert.rejects(
        () => messages.show(id),
        (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
        String(id),
      );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('MSG-SHOW: message show refuses inside the event service’s MCP server (10), and a malformed id is 64, before any owner is asked', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-message-show-cli-');
  try {
    const refused = await runCli(['--state-dir', stateDir, 'message', 'show', UNKNOWN, '--json'], {
      AGENTCOMMS_MCP_SERVER: 'events',
    });
    assert.equal(refused.code, 10, refused.err);
    assert.match(refused.err, /for a person, at a terminal or in the app/u);
    const malformed = await runCli(['--state-dir', stateDir, 'message', 'show', 'not-an-event', '--json'], {});
    assert.equal(malformed.code, 64, malformed.err);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('MSG-SHOW-E: through a real owner, message show --json gives one message with every line of its item’s history; an unknown event is 66', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await withLaneOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    await bindDavid(harness, david);
    const watch = await tool(david, 'events_watch', { lane: 'david' });
    const messageId = await deliver(harness, 'Can you sign the David contract by Friday?');
    const woke = await david.request('tasks/get', { taskId: String(watch.result?.taskId) });
    const item = String(
      (woke.result?.result as { structuredContent: { item: string } } | undefined)?.structuredContent.item,
    );
    structured(await tool(david, 'events_lane_item', { item }));
    structured(await tool(david, 'events_lane_item', { item }));
    structured(await tool(david, 'events_queue_done', { itemId: item }));
    assert.equal((await cli(harness.stateDir, ['queue', 'reopen', item, '--json'])).code, 0);

    const listed = JSON.parse(
      (await cli(harness.stateDir, ['messages', 'list', '--json'])).out,
    ) as MessagesListResultV1;
    const eventId = String(listed.messages[0]?.eventId);
    const shown = await cli(harness.stateDir, ['message', 'show', eventId, '--json']);
    assert.equal(shown.code, 0, shown.err);
    t.diagnostic(`message show --json: ${shown.out.trim()}`);
    const { message } = JSON.parse(shown.out) as MessageShowResultV1;
    assert.equal(message.eventId, eventId);
    assert.deepEqual(message.source, { channel: 'gmail', messageId });
    assert.deepEqual(
      message.queueItem?.history.map((line) => [line.kind, line.actor, line.windowKey]),
      [
        ['woken', 'window', DAVID.activityKey],
        ['read', 'window', DAVID.activityKey],
        ['read', 'window', DAVID.activityKey],
        ['done', 'window', DAVID.activityKey],
        ['reopened', 'person', null],
      ],
      'every line, oldest first',
    );
    assert.deepEqual(
      listed.messages[0]?.queueItem?.history.map((line) => line.kind),
      ['woken', 'read', 'done', 'reopened'],
      'the list keeps the newest line of each kind',
    );
    const { queueItem: shownItem, ...shownRest } = message;
    const { queueItem: listedItem, ...listedRest } = listed.messages[0] as typeof message;
    assert.deepEqual(
      { ...shownRest, kept: null },
      { ...listedRest, kept: null },
      'the same entry as the list gives, but for its history (and its envelopes’ boundaries)',
    );
    assert.deepEqual({ ...shownItem, history: [] }, { ...listedItem, history: [] });
    assert.match(message.kept?.subject ?? '', /^<untrusted-content [\s\S]*Can you sign the David contract/u);

    const unknown = await cli(harness.stateDir, ['message', 'show', UNKNOWN, '--json']);
    assert.equal(unknown.code, 66, unknown.err);
    assert.match(unknown.err, /no message with that event id/u);
  });
});
