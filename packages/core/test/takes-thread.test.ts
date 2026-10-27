import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type TakeAct, type TakeHolder, type TakeMessage, TakeStore } from '../src/takes.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * `TakeStore.threadHolder` (workflows 0.36 W36): the session that took an earlier message in a conversation, for a
 * workflow's "find the session that took this conversation". A temporary state folder, synthetic ids and synthetic
 * sessions; no real process is probed.
 */

const ACCOUNT = 'acc_AAAAAAAAAAAAAAAA';
const OTHER_ACCOUNT = 'acc_BBBBBBBBBBBBBBBB';
const THREAD = 'C0123/1729936800.000100';
const ALICE_SESSION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BOB_SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ACT: TakeAct = { account: 'acme/slack', shown: THREAD, act: 'slack.react', takeWith: 'slack_take (step "take")' };

function holder(key: string, sessionId: string | null): TakeHolder {
  return {
    key: key.repeat(16).slice(0, 16),
    grouped: true,
    process: key.repeat(12).slice(0, 12),
    sessionId,
    parent: { pid: 4242, startedAt: 'Mon Oct 26 10:00:00 2026', name: 'claude' },
    folder: '/example/home/work/client-secret-project',
    client: { name: 'claude-code', version: '2.1.0' },
  };
}

const message = (ts: string, thread: string | null = THREAD, accountId = ACCOUNT): TakeMessage => ({
  channel: 'slack',
  accountId,
  id: `C0123/${ts}`,
  thread,
});

function storeAt(start = '2026-10-26T10:00:00.000Z') {
  let now = Date.parse(start);
  const dir = tempDir('comms-takes-thread-');
  const store = new TakeStore(dir, {
    now: () => new Date(now),
    running: () => true,
    probe: async () => null,
    pinLive: async () => false,
  });
  return {
    dir,
    store,
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Every record file's bytes and time, to show that a read wrote nothing. */
function snapshot(dir: string): string[] {
  const files: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(`${path}:${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`);
    }
  };
  walk(dir);
  return files.sort();
}

test('threadHolder names the newest session to take the thread, and skips the message itself', async () => {
  const { dir, store, advance } = storeAt();
  const parent = message('1729936800.000100');
  const reply = message('1729936900.000200');
  const latest = message('1729937000.000300');
  await store.take(parent, holder('a', ALICE_SESSION));
  advance(60_000);
  await store.take(reply, holder('b', BOB_SESSION));
  await store.finish(reply, holder('b', BOB_SESSION), undefined, ACT);
  advance(60_000);
  const before = snapshot(dir);
  // The newest message's own take, were it there, is not "an earlier one".
  assert.deepEqual(await store.threadHolder({ channel: 'slack', accountId: ACCOUNT, thread: THREAD, except: latest }), {
    sessionId: BOB_SESSION,
    state: 'done',
    at: '2026-10-26T10:01:00.000Z',
  });
  assert.deepEqual(await store.threadHolder({ channel: 'slack', accountId: ACCOUNT, thread: THREAD, except: reply }), {
    sessionId: ALICE_SESSION,
    state: 'taken',
    at: '2026-10-26T10:00:00.000Z',
  });
  assert.deepEqual(snapshot(dir), before, 'it writes nothing');
  // Never another account's, nor another channel's.
  assert.equal(
    await store.threadHolder({ channel: 'slack', accountId: OTHER_ACCOUNT, thread: THREAD, except: latest }),
    null,
  );
  assert.equal(
    await store.threadHolder({ channel: 'gmail', accountId: ACCOUNT, thread: THREAD, except: latest }),
    null,
  );
});

test('threadHolder is null for the person, for a holder with no session id, and for a thread nobody took', async () => {
  const { store } = storeAt();
  const kept = message('1729936800.000100');
  const anonymous = message('1729936900.000200', 'C0123/1729936000.000900');
  const elsewhere = message('1729937000.000300', 'C0123/1729935000.000100', OTHER_ACCOUNT);
  await store.keep(kept, { folder: '/example/home/work', ancestors: ['zsh', 'Terminal'] });
  await store.take(anonymous, holder('c', null));
  await store.take(elsewhere, holder('d', ALICE_SESSION));
  const asked = message('1729938000.000400');
  assert.equal(await store.threadHolder({ channel: 'slack', accountId: ACCOUNT, thread: THREAD, except: asked }), null);
  assert.equal(
    await store.threadHolder({
      channel: 'slack',
      accountId: ACCOUNT,
      thread: 'C0123/1729936000.000900',
      except: asked,
    }),
    null,
  );
  assert.equal(
    await store.threadHolder({
      channel: 'slack',
      accountId: ACCOUNT,
      thread: 'C0123/1111111111.000000',
      except: asked,
    }),
    null,
  );
  assert.equal(await store.threadHolder({ channel: 'slack', accountId: ACCOUNT, thread: '', except: asked }), null);
});
