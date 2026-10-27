import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Config, parseConfig } from '../src/config.ts';
import type { CommsError } from '../src/errors.ts';
import { checkedTakenIds, checkedTakeStep, gateTake, takeStep } from '../src/take-flow.ts';
import { type TakeAct, type TakeHolder, TakeStore, takerIdentity } from '../src/takes.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Taking messages, what every channel shares (design 2026-10-26-taking-messages §5, §6): the step a take tool is told,
 * the person refused a take of their own, and the gate reading whether a take is required from the configuration as it
 * is now. Temporary folders and synthetic ids only.
 */

const SLACK_ID = 'acc_AAAAAAAAAAAAAAAA';
const REF = { channel: 'slack' as const, accountId: SLACK_ID, id: 'C0123/1729936800.000100' };
const ACT: TakeAct = { account: 'acme/slack', shown: REF.id, act: 'slack.react', takeWith: 'slack_take (step "take")' };
const HOLDER: TakeHolder = {
  key: 'aaaaaaaaaaaaaaaa',
  grouped: true,
  process: 'a1a1a1a1a1a1',
  sessionId: null,
  parent: null,
  folder: null,
  client: null,
};

function config(required?: boolean): Config {
  return parseConfig(
    JSON.stringify({
      version: 2,
      inboxes: {},
      accounts: {
        'acme/slack': {
          id: SLACK_ID,
          platform: 'slack',
          workspace: 'T_ACME',
          userId: 'U_AAAA',
          tier: 'send',
          mode: 'send',
          grantedScopes: [],
          secretRef: `slack:token:${SLACK_ID}`,
          createdAt: '2026-09-20T00:00:00.000Z',
        },
      },
      ...(required === undefined
        ? {}
        : { taking: { accounts: [{ accountId: SLACK_ID, account: 'acme/slack', required }] } }),
    }),
  );
}

test('a step is take, hand-back or done; a hand-back says why in closed words, and a note goes with it or a done', () => {
  assert.deepEqual(checkedTakeStep({}), { step: 'take' });
  assert.deepEqual(checkedTakeStep({ step: 'hand-back', reason: 'not-mine', note: ' about billing ' }), {
    step: 'hand-back',
    reason: 'not-mine',
    note: 'about billing',
  });
  assert.deepEqual(checkedTakeStep({ step: 'done', note: 'replied' }), { step: 'done', note: 'replied' });
  for (const bad of [
    { step: 'grab' },
    { step: 'hand-back' },
    { step: 'hand-back', reason: 'because I said so' },
    { step: 'take', reason: 'not-mine' },
    { step: 'take', note: 'mine' },
    { step: 'done', note: 'x'.repeat(201) },
  ]) {
    assert.throws(() => checkedTakeStep(bad), { code: 'USAGE' }, JSON.stringify(bad));
  }
  assert.throws(() => checkedTakenIds(Array.from({ length: 51 }, (_, index) => `m${index}`)), { code: 'USAGE' });
  assert.deepEqual(checkedTakenIds(['a', 'a', 'b']), ['a', 'b']);
});

test('the person at a terminal takes nothing, and is told to keep the message instead', async () => {
  const store = new TakeStore(tempDir('comms-take-flow-'));
  await assert.rejects(
    takeStep(store, {
      caller: null,
      request: { step: 'take' },
      ref: REF,
      act: ACT,
      verify: async () => assert.fail('nothing is read for the person'),
    }),
    (error: unknown) =>
      (error as { code?: string; hint?: string }).code === 'USAGE' &&
      /takes keep/.test(String((error as { hint?: string }).hint)),
  );
});

test('a take step reads the message first, and returns content-free words', async () => {
  const store = new TakeStore(tempDir('comms-take-flow-'));
  let read = 0;
  const taken = await takeStep(store, {
    caller: HOLDER,
    request: { step: 'take' },
    ref: REF,
    act: ACT,
    verify: async () => {
      read += 1;
      return { ...REF, thread: 'C0123/1729936000.000100' };
    },
  });
  assert.equal(read, 1);
  assert.equal(taken.you, true);
  assert.equal(taken.state, 'taken');
  assert.equal(taken.thread, 'C0123/1729936000.000100');
  assert.match(taken.leaseUntil ?? '', /^\d{4}-/);
  const back = await takeStep(store, {
    caller: HOLDER,
    request: { step: 'hand-back', reason: 'wrong-account' },
    ref: REF,
    act: ACT,
    verify: async () => assert.fail('a hand-back reads nothing'),
  });
  assert.deepEqual(
    { state: back.state, you: back.you, taken: back.taken },
    { state: 'open', you: false, taken: { state: 'open', handedBack: ['wrong-account'] } },
  );
});

test('the gate reads whether a take is required from the configuration as it is now, by the account’s id', async () => {
  const store = new TakeStore(tempDir('comms-take-flow-'));
  assert.deepEqual(await gateTake(store, config(), { ref: REF, caller: HOLDER, act: ACT }), {
    held: false,
    line: null,
  });
  await assert.rejects(gateTake(store, config(true), { ref: REF, caller: HOLDER, act: ACT }), {
    code: 'TAKE_REQUIRED',
  });
  // Fail closed: a block that cannot be read requires a take.
  const broken = { ...config(), taking: 'yes' } as Config;
  await assert.rejects(gateTake(store, broken, { ref: REF, caller: HOLDER, act: ACT }), { code: 'TAKE_REQUIRED' });
});

// ── An agent's own shell that is no session (security review of 0.35.0, M4) ───────────────────────────────────

test('an agent’s shell that joined no window and has no session id is never the person: every take gate holds for it', async () => {
  // The reviewer's scenario: a Codex shell — its marker set — that joined no agent window (activity recording off, say)
  // and has no CLAUDE_CODE_SESSION_ID. It was the person, and passed every gate.
  const unjoined = async () =>
    ({
      key: 'cccccccccccccccc',
      process: 'c3c3c3c3c3c3',
      pid: 1,
      folder: '/example/home/work',
      grouped: false,
      surface: 'cli',
    }) as const;
  const caller = await takerIdentity({ activity: undefined }, 'cli', undefined, {
    env: { CODEX_SANDBOX: 'seatbelt' },
    identity: unjoined,
  });
  assert.notEqual(caller, null, 'it is not the person');
  const store = new TakeStore(tempDir('comms-take-flow-'), { running: () => true, probe: async () => null });
  // Another session holds the message: the shell is refused, whether or not a take is required.
  await store.take({ ...REF, thread: null }, HOLDER);
  for (const required of [true, false]) {
    await assert.rejects(
      gateTake(store, config(required), { ref: REF, caller, act: ACT }),
      (error: unknown) =>
        (error as CommsError).code === 'TAKEN_ELSEWHERE' && (error as CommsError).details?.reason === 'HELD',
      `required ${required}`,
    );
  }
  await assert.rejects(store.refuseHeldElsewhere([REF], caller), { code: 'TAKEN_ELSEWHERE' });
  assert.equal((await store.views([REF], caller)).get(REF.id)?.by, 'another session');
  // Nobody has the message: with a take required it is refused, and told why it cannot take one; without, it acts.
  const open = { ...REF, id: 'C0123/1729936900.000100' };
  const act = { ...ACT, shown: open.id };
  const refused = await gateTake(store, config(true), { ref: open, caller, act }).then(
    () => assert.fail('expected a refusal'),
    (error: unknown) => error as CommsError,
  );
  assert.equal(refused.code, 'TAKE_REQUIRED');
  assert.equal(refused.exitCode, 10);
  assert.deepEqual(refused.details, {
    reason: 'NO_SESSION',
    act: 'slack.react',
    message: open.id,
    marker: 'CODEX_SANDBOX',
  });
  assert.match(refused.message, /joined no agent window and has no Claude Code session id/);
  assert.match(refused.hint ?? '', /over MCP/);
  assert.deepEqual(await gateTake(store, config(false), { ref: open, caller, act }), { held: false, line: null });
  // It takes nothing — a take made here could be matched to nothing it does next — and hands back or finishes nothing.
  for (const request of [{ step: 'take' }, { step: 'hand-back', reason: 'not-mine' }, { step: 'done' }] as const) {
    await assert.rejects(
      takeStep(store, {
        caller,
        request,
        ref: open,
        act,
        verify: async () => assert.fail('nothing is read for a shell that is no session'),
      }),
      (error: unknown) =>
        (error as CommsError).code === 'USAGE' && (error as CommsError).details?.reason === 'NO_SESSION',
      request.step,
    );
  }
  assert.equal(await store.read(open), null, 'nothing was recorded for it');
  // The person at their own terminal — no marker — is still nobody; inside an MCP server's process, nobody is the person.
  assert.equal(await takerIdentity({ activity: undefined }, 'cli', undefined, { env: {}, identity: unjoined }), null);
  assert.notEqual(
    await takerIdentity({ activity: undefined }, 'cli', undefined, {
      env: { AGENTCOMMS_MCP_SERVER: 'gmail' },
      identity: unjoined,
    }),
    null,
  );
  // A marked shell that joined a window, or that has a session id, is that session, as before.
  const joined = await takerIdentity({ activity: undefined }, 'cli', undefined, {
    env: { CODEX_SANDBOX: 'seatbelt' },
    identity: async () => ({ ...(await unjoined()), grouped: true }),
  });
  assert.equal((joined as TakeHolder).key, 'cccccccccccccccc');
  const sid = '11111111-2222-4333-8444-555555555555';
  const claude = await takerIdentity({ activity: undefined }, 'cli', undefined, {
    env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: sid },
    identity: unjoined,
  });
  assert.equal((claude as TakeHolder).sessionId, sid);
});
