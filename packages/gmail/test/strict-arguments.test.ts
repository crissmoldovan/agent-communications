import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { GmailContext } from '../src/context.ts';
import { inboxRename } from '../src/operations/inboxes.ts';
import { type Harness, newHarness } from './support/harness.ts';
import { connect, type ToolResult, toolError } from './support/surfaces.ts';

/*
 * Every Gmail tool holds a call to the arguments it declares (design 2026-09-18 §11: "unknown fields are rejected"),
 * and refuses one that fails its schema as USAGE, in the envelope every other refusal uses.
 *
 * The SDK stripped a key a tool did not declare, so the call ran without it: `gmail_inbox_add {client: 'other',
 * contacts: false}` signed in through the default client and asked for the address book, back when neither was
 * declared. A misspelt `Cc` on a draft left the copy off; a `send_policy` meant to tighten a mailbox changed nothing.
 * And a fraction for `waitSeconds` came back as the SDK's "Input validation error", which has no code to act on.
 */

const harnesses: Harness[] = [];

async function oneMailbox(): Promise<Harness> {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  harnesses.push(harness);
  return harness;
}

/*
 * A sign-in these tests expect never to start has a detached listener if it does — the check let the call through —
 * and that listener would wait out its ten minutes after the file ends. So any that exists is stopped once the test
 * is done, passed or failed.
 */
afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    const store = new GmailContext({ core: harness.core, env: harness.env }).flows;
    for (const name of flows(harness)) {
      const flowId = name.replace(/\.(outcome\.)?json$/, '');
      try {
        const flow = await store.get(flowId);
        if (flow.listenerPid) process.kill(flow.listenerPid, 'SIGTERM');
        await store.discard(flowId);
      } catch {
        // Finished, or gone already: nothing left to stop.
      }
    }
  }
});

const configOf = (harness: Harness) => readFileSync(join(harness.configDir, 'config.json'), 'utf8');

/** The sign-ins waiting on this machine: none, when nothing was started. */
function flows(harness: Harness): string[] {
  const directory = new GmailContext({ core: harness.core, env: harness.env }).flows.directory;
  return existsSync(directory) ? readdirSync(directory) : [];
}

/** A refusal with a code, in the envelope — not the SDK's uncoded text. */
function usage(result: ToolResult) {
  const error = toolError(result);
  assert.ok(error, `refused without a code: ${JSON.stringify(result.content)}`);
  assert.equal(error.code, 'USAGE', JSON.stringify(error));
  assert.doesNotMatch(error.message, /Input validation error/);
  return error;
}

test('gmail_inbox_add with a key it does not take is refused, and no sign-in is started', async () => {
  const harness = await oneMailbox();
  const before = configOf(harness);
  const asked = harness.google.requests.length;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const error = usage(
      await call('gmail_inbox_add', {
        alias: 'viatool',
        email: 'jo@example.test',
        clientName: 'other',
        contacts: false,
      }),
    );
    assert.match(error.message, /gmail_inbox_add does not take `clientName`/);
    assert.match(error.hint ?? '', /`client`/, 'the key it does take is named');
    assert.match(error.hint ?? '', /`alias` \(required\)/);
  } finally {
    await close();
  }
  assert.deepEqual(flows(harness), [], 'no sign-in was started');
  assert.equal(harness.google.requests.length, asked, 'Google was asked nothing');
  assert.equal(configOf(harness), before, 'the config is as it was');
});

test('gmail_inbox_policy with a misspelt policy is refused, rather than answered as a change of nothing', async () => {
  const harness = await oneMailbox();
  const before = configOf(harness);
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const error = usage(await call('gmail_inbox_policy', { inbox: 'work', send_policy: 'never' }));
    assert.match(error.message, /does not take `send_policy`/);
    assert.match(error.hint ?? '', /`sendPolicy`/);
  } finally {
    await close();
  }
  assert.equal(configOf(harness), before);
  assert.deepEqual(await harness.core.approvals.list(), [], 'nothing was prepared');
});

test('gmail_draft_create with `Cc` for `cc` writes no draft without the copy', async () => {
  const harness = await oneMailbox();
  const asked = harness.google.requests.length;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const error = usage(
      await call('gmail_draft_create', {
        inbox: 'work',
        to: ['sam@partner.test'],
        Cc: ['lee@partner.test'],
        subject: 'Tue',
        text: 'See you Tuesday.',
      }),
    );
    assert.match(error.message, /gmail_draft_create does not take `Cc`/);
    assert.match(error.hint ?? '', /`cc`/);
  } finally {
    await close();
  }
  assert.equal(harness.google.requests.length, asked, 'nothing reached Gmail');
});

test('a fraction, a word for a number or a missing argument is USAGE naming it, from the Gmail server', async () => {
  const harness = await oneMailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const wait = usage(await call('gmail_inbox_finish', { flowId: 'fl_AAAAAAAAAAAAAAAAAAAAAA', waitSeconds: 1.5 }));
    assert.match(wait.message, /`waitSeconds` takes a whole number from 0 to 600/);
    assert.match(wait.hint ?? '', /`waitSeconds`: how long to wait/);

    const limit = usage(await call('gmail_search', { query: 'from:sam', limit: 'ten' }));
    assert.match(limit.message, /`limit` takes a whole number/);

    const flag = usage(await call('gmail_message_get', { inbox: 'work', messageId: 'm1', includeQuoted: 'maybe' }));
    assert.match(flag.message, /`includeQuoted` takes true or false/);

    const missing = usage(await call('gmail_message_get', { inbox: 'work' }));
    assert.match(missing.message, /`messageId` is required, and takes a non-empty string/);

    // The coercion the design allows still happens before the check: "12" is 12 and "false" is false.
    const searched = await call('gmail_search', {
      query: 'from:sam',
      inboxes: 'work',
      limit: '12',
      includeSpamTrash: 'false',
    });
    assert.notEqual(searched.isError, true, JSON.stringify(searched.structuredContent ?? searched.content));
    const shown = await call('gmail_inbox_show', { inbox: 'work' });
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));
    assert.equal((shown.structuredContent as { alias: string }).alias, 'work');
  } finally {
    await close();
  }
  assert.deepEqual(flows(harness), []);
});

test('a misspelt key inside `expect` or an `undo` record is named where it is, not reported as the wrong kind of argument', async () => {
  /*
   * `gmail_draft_send` with `expect: {To: [...], cc, bcc, subject}` was refused with "`expect` takes an object" — an
   * object was passed — and `gmail_organise_undo` with `undo: [{messageID, ...}]` with "`undo` takes a list". Neither
   * named the key that was missing nor the one that was misspelt, so an agent handed that had nothing to correct.
   */
  const harness = await oneMailbox();
  const asked = harness.google.requests.length;
  const { call, close } = await connect({ core: harness.core, env: harness.env });
  try {
    const sent = usage(
      await call('gmail_draft_send', {
        inbox: 'work',
        draftId: 'r1',
        approvalId: `ap_${'0'.repeat(26)}`,
        expect: { To: ['sam@partner.test'], cc: [], bcc: [], subject: 'Tue' },
      }),
    );
    assert.match(sent.message, /`expect\.to` is required, and takes a list of strings/);
    assert.match(sent.message, /`expect` does not take `To`/);
    assert.doesNotMatch(sent.message, /`expect` takes an object/);
    assert.match(sent.hint ?? '', /`expect` takes `to` \(required\), `cc` \(required\), `bcc` \(required\)/);
    assert.doesNotMatch(`${sent.message} ${sent.hint}`, /sam@partner\.test|Tue/, 'no value is echoed');

    const undone = usage(
      await call('gmail_organise_undo', {
        inbox: 'work',
        undo: [{ messageID: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] }],
      }),
    );
    assert.match(undone.message, /`undo\[0\]\.messageId` is required, and takes a non-empty string/);
    assert.match(undone.message, /`undo\[0\]` does not take `messageID`/);
    assert.doesNotMatch(undone.message, /`undo` takes a list/);
    assert.match(undone.hint ?? '', /`undo\[0\]` takes `messageId` \(required\)/);
    assert.doesNotMatch(`${undone.message} ${undone.hint}`, /m1|INBOX/, 'no value is echoed');
  } finally {
    await close();
  }
  assert.equal(harness.google.requests.length, asked, 'nothing reached Gmail');
  assert.deepEqual(await harness.core.approvals.list(), [], 'nothing was prepared');
});

test('a pinned server refuses an unknown key before it looks at the pin', async () => {
  const harness = await oneMailbox();
  const { call, close } = await connect({ core: harness.core, env: harness.env, inbox: 'work' });
  try {
    const error = usage(await call('gmail_inbox_show', { inbox: 'work', verbose: true }));
    assert.match(error.message, /gmail_inbox_show does not take `verbose`/);
    const shown = await call('gmail_inbox_show', {});
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));

    // With the pin broken under it, a call it takes is answered by the pin, and one it does not by the check first:
    // the arguments are looked at before anything is read, the configuration included.
    await inboxRename(new GmailContext({ core: harness.core, env: harness.env }), 'work', 'office');
    const pin = toolError(await call('gmail_inbox_show', {}));
    assert.equal(pin.code, 'NOT_FOUND');
    assert.match(pin.message, /renamed to "office"/);
    assert.match(usage(await call('gmail_inbox_show', { verbose: true })).message, /does not take `verbose`/);
  } finally {
    await close();
  }
});

test('every Gmail tool, pinned, read-only or neither, refuses a key it does not take and publishes only its own', async () => {
  // By construction: a tool added later is held to this without anyone remembering to.
  const harness = await oneMailbox();
  const before = configOf(harness);
  const asked = harness.google.requests.length;
  for (const options of [{}, { inbox: 'work' }, { readOnly: true }, { inbox: 'work', readOnly: true }]) {
    const { client, call, close } = await connect({ core: harness.core, env: harness.env, ...options });
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length > 10, `${tools.length} tools`);
      for (const tool of tools) {
        const label = `${tool.name} ${JSON.stringify(options)}`;
        assert.equal(tool.inputSchema.additionalProperties, false, `${label} publishes additionalProperties: false`);
        assert.equal(tool.inputSchema.type, 'object', label);
        const error = usage(await call(tool.name, { zzUnknown: 1 }));
        assert.match(error.message, new RegExp(`${tool.name} does not take \`zzUnknown\``), label);
      }
    } finally {
      await close();
    }
  }
  assert.equal(configOf(harness), before, 'nothing was changed');
  assert.deepEqual(flows(harness), [], 'nothing was started');
  assert.equal(harness.google.requests.length, asked, 'nothing reached Google');
  assert.deepEqual(await harness.core.approvals.list(), [], 'nothing was prepared');
});
