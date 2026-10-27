import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, type Config } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { replyDraft } from '../src/operations/drafts.ts';
import { modify, trash } from '../src/operations/organise.ts';
import { readMessage, readThread } from '../src/operations/read.ts';
import { search } from '../src/operations/search.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { takeMessage, takenMessages } from '../src/operations/take.ts';
import { DRAFT_SEND_PATH, type FakeGoogle, type FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { cli, connect } from './support/surfaces.ts';

/*
 * Taking messages in Gmail (design 2026-10-26-taking-messages §5, §6, §11 "Channels"): `take` and `taken`, the gates on
 * every act that answers a message — a reply draft, and a reply's send at prepare and again at the claim — housekeeping
 * refused on a message someone else has, and `taken` on every read. Everything runs against the fake Google with a
 * temporary home; nothing is sent anywhere. Two sessions are two Claude Code session ids, as two windows are.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ORIGINAL = '<abc@mail.partner.test>';

function message(id: string, messageId: string, labelIds: string[] = ['INBOX'], threadId = `t_${id}`): FakeMessage {
  return {
    id,
    threadId,
    labelIds,
    internalDate: String(Date.parse('2026-10-26T09:00:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Sam Lee <sam@partner.test>' },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: 'Tuesday' },
        { name: 'Message-ID', value: messageId },
      ],
      body: { size: 5, data: Buffer.from('Hello', 'utf8').toString('base64url') },
    },
  };
}

interface Mailbox {
  harness: Harness;
  google: FakeGoogle;
  /** A session: an MCP server's context in an agent window with its own Claude Code session id. */
  session: (id: string) => GmailContext;
  /** The person at their own terminal: a command with no window and no session id. */
  person: () => GmailContext;
}

async function mailbox(): Promise<Mailbox> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: {
          m1: message('m1', ORIGINAL),
          m2: message('m2', '<def@mail.partner.test>'),
          mine: message('mine', '<own@example.test>', ['SENT']),
          mdraft: message('mdraft', '<draft@example.test>', ['DRAFT']),
        },
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  const session = (id: string) =>
    new GmailContext({ core: harness.core, env: { ...harness.env, CLAUDE_CODE_SESSION_ID: id }, surface: 'mcp' });
  const person = () => new GmailContext({ core: harness.core, env: harness.env, surface: 'cli' });
  return { harness, google: harness.google, session, person };
}

/** Turns taking on for `work`: a tightening, applied at once. */
async function requireTakes(harness: Harness): Promise<void> {
  const id = (await harness.core.config.load()).inboxes.work?.id;
  assert.ok(id);
  await harness.core.config.update(
    (config): Config => ({ ...config, taking: { accounts: [{ accountId: id, account: 'work', required: true }] } }),
  );
}

const sends = (google: FakeGoogle): number =>
  google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length;

function refused(code: string, reason: string): (error: unknown) => true {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    assert.equal(error.exitCode, 10);
    assert.equal(error.details?.reason, reason);
    return true;
  };
}

// ── take and taken ─────────────────────────────────────────────────────────────────────────────────────────────

test('a take reads the message first: it refuses one this mailbox sent, a draft, and one that is not there', async () => {
  const { session } = await mailbox();
  const alice = session(ALICE);
  for (const id of ['mine', 'mdraft']) {
    await assert.rejects(takeMessage(alice, 'work', id, {}), (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'USAGE');
      assert.equal(error.details?.reason, 'own-message');
      return true;
    });
  }
  await assert.rejects(takeMessage(alice, 'work', 'nope', {}), { code: 'NOT_FOUND' });
  const taken = await takeMessage(alice, 'work', 'm1', {});
  assert.deepEqual(
    { inbox: taken.inbox, message: taken.message, thread: taken.thread, state: taken.state, you: taken.you },
    { inbox: 'work', message: 'm1', thread: 't_m1', state: 'taken', you: true },
  );
});

test('the first session’s take holds; the second is refused, and the hand-back opens it with a closed reason', async () => {
  const { harness, session } = await mailbox();
  const alice = session(ALICE);
  const bob = session(BOB);
  await takeMessage(alice, 'work', 'm1', {});
  await assert.rejects(takeMessage(bob, 'work', 'm1', {}), refused('TAKEN_ELSEWHERE', 'HELD'));
  await assert.rejects(
    takeMessage(bob, 'work', 'm1', { step: 'hand-back', reason: 'not-mine' }),
    refused('TAKEN_ELSEWHERE', 'HELD'),
  );
  const back = await takeMessage(alice, 'work', 'm1', {
    step: 'hand-back',
    reason: 'not-mine',
    note: 'about the billing site',
  });
  assert.equal(back.state, 'open');
  const seen = await takenMessages(bob, 'work', ['m1', 'm2']);
  assert.deepEqual(seen, {
    inbox: 'work',
    messages: [
      { id: 'm1', taken: { state: 'open', handedBack: ['not-mine'] } },
      { id: 'm2', taken: null },
    ],
  });
  assert.equal(JSON.stringify(seen).includes('billing'), false, 'the note is the person’s alone');
  // The record keeps the Message-ID, so a reply's In-Reply-To can find its take.
  const [listed] = await harness.core.takes.list();
  assert.ok(listed && 'record' in listed);
  assert.equal(listed.record.message.rfc822Id, 'abc@mail.partner.test');
});

test('taken says who has a message in closed words, naming nothing of the other session', async () => {
  const { session } = await mailbox();
  await takeMessage(session(BOB), 'work', 'm1', {});
  const alice = session(ALICE);
  const said = await takenMessages(alice, 'work', ['m1']);
  assert.deepEqual(said.messages[0]?.taken, {
    state: 'taken',
    by: 'another session',
    since: said.messages[0]?.taken?.since,
  });
  const text = JSON.stringify(said);
  for (const value of [BOB, process.cwd(), 'test-client']) {
    assert.equal(text.includes(value), false, `taken names ${value}`);
  }
  // With no messages named: this session's own.
  await takeMessage(alice, 'work', 'm2', {});
  assert.deepEqual(
    (await takenMessages(alice, 'work')).messages.map((entry) => [entry.id, entry.taken?.by]),
    [['m2', 'you']],
  );
});

test('the person at their own terminal takes nothing, and is pointed at takes keep', async () => {
  const { harness, person } = await mailbox();
  await assert.rejects(takeMessage(person(), 'work', 'm1', {}), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'USAGE');
    assert.match(error.hint ?? '', /takes keep/);
    return true;
  });
  const run = await cli(harness, ['take', 'm1', '--inbox', 'work', '--json'], { env: harness.env });
  assert.equal(run.code, 64, run.stdout + run.stderr);
  assert.deepEqual(await harness.core.takes.list(), [], 'nothing was recorded');
});

// ── The gates (§6) ─────────────────────────────────────────────────────────────────────────────────────────────

test('with taking required, a reply draft needs this session’s take; a forward and a follow-up to its own mail do not', async () => {
  const { harness, session } = await mailbox();
  await requireTakes(harness);
  const alice = session(ALICE);
  await assert.rejects(replyDraft(alice, 'work', 'm1', { text: 'Tuesday works.' }), (error: unknown) => {
    refused('TAKE_REQUIRED', 'NOT_TAKEN')(error);
    const refusal = error as CommsError;
    assert.equal(refusal.details?.act, 'gmail.draft.reply');
    assert.equal(refusal.details?.message, 'm1');
    assert.match(refusal.hint ?? '', /gmail_take \(step "take"\)/);
    return true;
  });
  await replyDraft(alice, 'work', 'm2', { text: 'Fwd.', mode: 'forward', to: ['kim@partner.test'] });
  await replyDraft(alice, 'work', 'mine', { text: 'Following up.' });
  await takeMessage(alice, 'work', 'm1', {});
  const draft = await replyDraft(alice, 'work', 'm1', { text: 'Tuesday works.' });
  assert.ok(draft.draftId);
});

test('another session’s take is respected with taking off: its reply, forward, organise and bin are refused', async () => {
  const { session } = await mailbox();
  const alice = session(ALICE);
  const bob = session(BOB);
  // Off: nothing is demanded.
  await replyDraft(bob, 'work', 'm2', { text: 'Sure.' });
  await takeMessage(alice, 'work', 'm1', {});
  await assert.rejects(replyDraft(bob, 'work', 'm1', { text: 'Mine?' }), refused('TAKEN_ELSEWHERE', 'HELD'));
  await assert.rejects(
    replyDraft(bob, 'work', 'm1', { text: 'Fwd.', mode: 'forward', to: ['kim@partner.test'] }),
    refused('TAKEN_ELSEWHERE', 'HELD'),
  );
  await assert.rejects(modify(bob, 'work', { messageIds: ['m1'], archive: true }), refused('TAKEN_ELSEWHERE', 'HELD'));
  await assert.rejects(trash(bob, 'work', { threadIds: ['t_m1'] }), refused('TAKEN_ELSEWHERE', 'HELD'));
  // Housekeeping needs no take: a dry run, the holder, and another message pass.
  await modify(bob, 'work', { messageIds: ['m1'], archive: true, dryRun: true });
  await modify(alice, 'work', { messageIds: ['m1'], archive: true });
  await trash(bob, 'work', { messageIds: ['m2'] });
});

test('an agent’s shell that joined no window and has no session id is no person: held to every take, and takes none', async () => {
  // Security review of 0.35.0, M4: a Codex shell — its marker set, no CLAUDE_CODE_SESSION_ID, no window in activity —
  // counted as the person, and replied to a message another session held.
  const { harness, session, person } = await mailbox();
  const alice = session(ALICE);
  const shell = new GmailContext({
    core: harness.core,
    env: { ...harness.env, CODEX_SANDBOX: 'seatbelt' },
    surface: 'cli',
  });
  await takeMessage(alice, 'work', 'm1', {});
  await assert.rejects(replyDraft(shell, 'work', 'm1', { text: 'Mine now.' }), refused('TAKEN_ELSEWHERE', 'HELD'));
  await assert.rejects(trash(shell, 'work', { messageIds: ['m1'] }), refused('TAKEN_ELSEWHERE', 'HELD'));
  // With a take required it acts on no message, and is told why; it cannot take one either.
  await requireTakes(harness);
  await assert.rejects(replyDraft(shell, 'work', 'm2', { text: 'Hello.' }), refused('TAKE_REQUIRED', 'NO_SESSION'));
  await assert.rejects(takeMessage(shell, 'work', 'm2', {}), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'USAGE');
    assert.equal(error.details?.reason, 'NO_SESSION');
    return true;
  });
  // The same command at the person's own terminal — no marker — is the person's, as before.
  assert.ok((await replyDraft(person(), 'work', 'm2', { text: 'Hello.' })).draftId);
});

test('a reply’s send needs the take at prepare, says so in its preview, and is asked again at the claim', async () => {
  const { harness, google, session } = await mailbox();
  await requireTakes(harness);
  const alice = session(ALICE);
  await takeMessage(alice, 'work', 'm1', {});
  const draft = await replyDraft(alice, 'work', 'm1', { text: 'Tuesday works.' });
  const prepared = await prepareSend(alice, 'work', draft.draftId);
  assert.match(prepared.preview, /^Taken by this session at \d\d:\d\d\.$/m);
  // The take is pinned while the approval waits.
  const [listed] = await harness.core.takes.list();
  assert.ok(listed && 'record' in listed);
  assert.deepEqual(listed.record.pins, [prepared.approvalId]);

  // The person releases it between the prepare and the send: nothing is sent, and the approval is as it was.
  await harness.core.takes.release(
    { channel: 'gmail', accountId: listed.record.message.accountId, id: 'm1' },
    { folder: null, ancestors: [] },
  );
  await assert.rejects(executeSend(alice, 'work', { approvalId: prepared.approvalId }), (error: unknown) => {
    refused('TAKE_REQUIRED', 'NOT_TAKEN')(error);
    assert.equal((error as CommsError).details?.act, 'gmail.send.execute');
    return true;
  });
  assert.equal(sends(google), 0, 'nothing was sent');
  const stored = await harness.core.approvals.get(prepared.approvalId);
  assert.equal(stored?.form === 'v2' ? stored.record.state : null, 'pending', 'the approval is unused');

  // Taken again, the same approval sends.
  await takeMessage(alice, 'work', 'm1', {});
  assert.ok((await executeSend(alice, 'work', { approvalId: prepared.approvalId })).sentMessageId);
  assert.equal(sends(google), 1);
});

test('a send prepared by a session that lost the message to another is refused at prepare and at the claim', async () => {
  const { harness, google, session } = await mailbox();
  const alice = session(ALICE);
  const bob = session(BOB);
  // Taking off: Alice drafts and prepares without a take…
  const draft = await replyDraft(alice, 'work', 'm1', { text: 'Tuesday works.' });
  const prepared = await prepareSend(alice, 'work', draft.draftId);
  // …then Bob takes the message: her send is refused at the claim, and a fresh prepare too.
  await takeMessage(bob, 'work', 'm1', {});
  await assert.rejects(
    executeSend(alice, 'work', { approvalId: prepared.approvalId }),
    refused('TAKEN_ELSEWHERE', 'HELD'),
  );
  await assert.rejects(prepareSend(alice, 'work', draft.draftId), refused('TAKEN_ELSEWHERE', 'HELD'));
  assert.equal(sends(google), 0);
  void harness;
});

// ── Reads (§6) ─────────────────────────────────────────────────────────────────────────────────────────────────

test('every read carries taken, in closed words: a message, a thread’s messages, a search’s rows', async () => {
  const { session } = await mailbox();
  const alice = session(ALICE);
  const bob = session(BOB);
  assert.equal((await readMessage(alice, 'work', 'm1')).taken, null);
  await takeMessage(bob, 'work', 'm1', {});
  const read = await readMessage(alice, 'work', 'm1');
  assert.equal(read.taken?.by, 'another session');
  assert.equal((await readMessage(bob, 'work', 'm1')).taken?.by, 'you');
  const thread = await readThread(alice, 'work', 't_m1');
  assert.deepEqual(
    thread.messages.map((each) => [each.messageId, each.taken?.state ?? null]),
    [['m1', 'taken']],
  );
  const found = await search(alice, { query: 'Tuesday', inboxes: ['work'], kind: 'messages' });
  const row = found.rows.find((each) => each.messageId === 'm1');
  assert.equal(row?.taken?.by, 'another session');
  assert.equal(JSON.stringify(found.rows).includes(BOB), false);
});

// ── Over MCP ───────────────────────────────────────────────────────────────────────────────────────────────────

test('gmail_take and gmail_taken: the step is told apart by `step`, and no argument names a session', async () => {
  const { harness } = await mailbox();
  const server = await connect({ core: harness.core, env: { ...harness.env, CLAUDE_CODE_SESSION_ID: ALICE } });
  try {
    const taken = await server.call('gmail_take', { inbox: 'work', message: 'm1' });
    assert.notEqual(taken.isError, true, JSON.stringify(taken.structuredContent));
    assert.equal(taken.structuredContent?.you, true);
    assert.equal(taken.structuredContent?.state, 'taken');
    const asked = await server.call('gmail_taken', { inbox: 'work', messages: ['m1'] });
    assert.deepEqual(((asked.structuredContent?.messages ?? []) as { taken: { by: string } }[])[0]?.taken.by, 'you');
    for (const smuggled of [{ session: BOB }, { key: 'aaaaaaaaaaaaaaaa' }, { sessionId: BOB }]) {
      const refusedCall = await server.call('gmail_take', { inbox: 'work', message: 'm1', ...smuggled });
      assert.equal(refusedCall.isError, true, JSON.stringify(smuggled));
      assert.equal((refusedCall.structuredContent?.error as { code?: string } | undefined)?.code, 'USAGE');
    }
    const back = await server.call('gmail_take', {
      inbox: 'work',
      message: 'm1',
      step: 'hand-back',
      reason: 'needs-the-person',
      note: 'the sender asked for Jo',
    });
    assert.equal(back.structuredContent?.state, 'open', JSON.stringify(back.structuredContent));
  } finally {
    await server.close();
  }
});
