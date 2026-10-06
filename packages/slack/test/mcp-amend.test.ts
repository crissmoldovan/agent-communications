import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { asV2, EXIT_CODES } from '@agentcomms/core';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { run } from '../src/cli/program.ts';
import { createSlackMcpServer } from '../src/mcp/server.ts';
import { audited, homeFile, mine, type Script, scriptedSlack, TS, WORDS } from './support/amend.ts';
import { startFakeSlack } from './support/fake-slack.ts';
import { slackCommand } from './support/handoffs.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Editing and deleting over MCP and at the command line, through the gate a post goes through (design 2026-10-06).
 *
 * Each test drives the tools and commands in the order an agent and a person would: prepare, show, a yes — in the
 * chat under `chat`, at the person's own terminal under `confirm` — then the send, once. Slack is a script that counts
 * what it was asked and never reaches the real one.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface Failure {
  code: string;
  message: string;
  hint: string | null;
  details?: Record<string, unknown>;
}

const failure = (result: ToolResult): Failure => (result.structuredContent as { error: Failure }).error;

/** This account's message in `#eng`, and a Slack that edits and deletes it. */
function slack(over: Script = {}) {
  return scriptedSlack({
    'conversations.history': () => ({ ok: true, messages: [mine()] }),
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'chat.update': () => ({ ok: true, channel: 'C1', ts: TS }),
    'chat.delete': () => ({ ok: true, channel: 'C1', ts: TS }),
    ...over,
  });
}

async function connect(harness: Harness, fetch: FakeFetch, options: { workspace?: string } = {}) {
  const { server } = await createSlackMcpServer({
    core: harness.core,
    env: harness.env,
    fetch,
    platform: 'darwin',
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

/** The CLI, as a person at a terminal runs it: an approval's code is read off the prompt and typed back. */
async function cli(
  harness: Harness,
  argv: string[],
  read: FakeFetch,
  options: { tty?: boolean; answerChallenge?: boolean; answer?: string } = {},
) {
  let stdout = '';
  let stderr = '';
  const out = new PassThrough();
  const err = new PassThrough();
  const input = new PassThrough();
  out.on('data', (chunk) => {
    stdout += String(chunk);
  });
  let answered = false;
  err.on('data', (chunk) => {
    stderr += String(chunk);
    if (answered) return;
    const asked = /Type (\S+) to approve/.exec(stderr);
    if (asked && (options.answerChallenge || options.answer !== undefined)) {
      answered = true;
      input.write(`${options.answerChallenge ? asked[1] : options.answer}\n`);
    }
  });
  const code = await run(argv, {
    core: harness.core,
    env: harness.env,
    exchange: (params) => harness.exchange(params),
    streams: {
      stdout: Object.assign(out, { isTTY: options.tty ?? false }),
      stderr: Object.assign(err, { isTTY: options.tty ?? false }),
      stdin: Object.assign(input, { isTTY: options.tty ?? false }),
    },
    openBrowser: () => undefined,
    probe: (probeInput, init) => harness.probe(probeInput, init),
    platform: 'darwin',
    read,
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** A person approving at their own terminal — the one step no tool takes. */
async function personApproves(harness: Harness, approvalId: string, read: FakeFetch): Promise<string> {
  const approved = await cli(harness, ['approve', approvalId], read, { tty: true, answerChallenge: true });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stdout + approved.stderr);
  return approved.stdout;
}

// ── Over MCP ───────────────────────────────────────────────────────────────────────────────────────────────────

test('under `chat`, slack_edit_send makes the edit the person said yes to, once, and records that the agent did', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.fetch);
  try {
    const prepared = await call('slack_edit_prepare', {
      workspace: 'acme',
      ts: TS,
      channel: 'C1',
      text: 'shipping in ten minutes',
    });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
    const { draftId, approvalId, preview } = prepared.structuredContent as {
      draftId: string;
      approvalId: string;
      preview: { body: string; replaces: { ts: string; body: string } };
    };
    assert.deepEqual(preview.replaces, { ts: TS, body: WORDS });
    assert.equal(preview.body, 'shipping in ten minutes');
    assert.equal(fake.count('chat.update'), 0, 'preparing changes nothing');

    const send = { workspace: 'acme', draftId, approvalId, expectChannel: 'C1', ts: TS };
    const edited = await call('slack_edit_send', send);
    assert.notEqual(edited.isError, true, JSON.stringify(edited.structuredContent));
    const { approval, ...result } = edited.structuredContent as { approval: { state: string } };
    assert.deepEqual(result, { approvalId, channel: 'C1', ts: TS });
    assert.equal(approval.state, 'used');
    assert.equal(fake.count('chat.update'), 1);

    const again = await call('slack_edit_send', send);
    assert.equal(again.isError, true, 'an approval is spent by the edit it permits');
    assert.equal(fake.count('chat.update'), 1);

    const [record] = await audited(harness, 'slack.edit');
    assert.equal(record?.outcome, 'ok');
    assert.equal(record?.surface, 'mcp');
  } finally {
    await close();
  }
});

test('under `confirm`, slack_delete_send waits for a person, hands over the terminal command, and never approves', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const fake = slack();
  const { call, close } = await connect(harness, fake.fetch);
  try {
    const prepared = await call('slack_delete_prepare', { workspace: 'acme', channel: 'C1', ts: TS });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
    const { approvalId, preview } = prepared.structuredContent as {
      approvalId: string;
      preview: { body: string; policy: string };
    };
    assert.equal(preview.body, WORDS);
    assert.equal(preview.policy, 'this needs a person to approve it at a terminal before the message is deleted');

    const send = { workspace: 'acme', channel: 'C1', ts: TS, approvalId };
    const held = await call('slack_delete_send', send);
    const error = failure(held);
    assert.equal(error.code, 'APPROVAL_PENDING');
    assert.equal(error.details?.command, slackCommand(harness.core.paths, ['approve', approvalId], 'darwin'));
    assert.match(error.hint ?? '', /slack_delete_send/, 'and what the agent does once they have');
    assert.doesNotMatch(error.hint ?? '', /delete send command/, 'not a command for a shell the agent is not in');
    assert.equal(fake.count('chat.delete'), 0, 'nothing is deleted while it waits');
    assert.equal(asV2(await harness.core.approvals.get(approvalId))?.state, 'pending', 'asking did not approve it');

    const shown = await personApproves(harness, approvalId, fake.fetch);
    assert.match(shown, /^DELETE PREVIEW · workspace acme · approval ap_/m);
    assert.match(shown, /Approved\. This command approves; it does not delete\./);
    assert.equal(fake.count('chat.delete'), 0, 'approving does not delete');

    const deleted = await call('slack_delete_send', send);
    assert.notEqual(deleted.isError, true, JSON.stringify(deleted.structuredContent));
    assert.equal(fake.count('chat.delete'), 1, 'the person’s approval deletes it, once');
  } finally {
    await close();
  }
});

test('a pinned server refuses another workspace’s approval for an edit or a deletion before touching it', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat', workspaceId: 'T0001' });
  await harness.addWorkspace({ alias: 'zeta', mode: 'send', sendPolicy: 'chat', workspaceId: 'T0002' });
  const fake = slack();
  const unpinned = await connect(harness, fake.fetch);
  let zetaEdit: { draftId: string; approvalId: string };
  let zetaDelete: string;
  try {
    const edit = await unpinned.call('slack_edit_prepare', { workspace: 'zeta', ts: TS, channel: 'C1', text: 'x' });
    zetaEdit = edit.structuredContent as { draftId: string; approvalId: string };
    const deletion = await unpinned.call('slack_delete_prepare', { workspace: 'zeta', channel: 'C1', ts: TS });
    zetaDelete = String((deletion.structuredContent as { approvalId: string }).approvalId);
  } finally {
    await unpinned.close();
  }

  const pinned = await connect(harness, fake.fetch, { workspace: 'acme' });
  try {
    const edit = await pinned.call('slack_edit_send', {
      draftId: zetaEdit.draftId,
      approvalId: zetaEdit.approvalId,
      expectChannel: 'C1',
      ts: TS,
    });
    assert.equal(failure(edit).code, 'NOT_FOUND');
    const deletion = await pinned.call('slack_delete_send', { channel: 'C1', ts: TS, approvalId: zetaDelete });
    assert.equal(failure(deletion).code, 'NOT_FOUND');
    for (const approvalId of [zetaEdit.approvalId, zetaDelete]) {
      assert.equal(asV2(await harness.core.approvals.get(approvalId))?.state, 'pending', 'it was not touched');
    }
    assert.equal(fake.count('chat.update') + fake.count('chat.delete'), 0);
  } finally {
    await pinned.close();
  }
});

test('the same refusal comes from both surfaces: somebody else’s message, by tool and by command', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack({ 'conversations.history': () => ({ ok: true, messages: [mine({ user: 'U0002' })] }) });
  const { call, close } = await connect(harness, fake.fetch);
  try {
    const byTool = failure(await call('slack_delete_prepare', { workspace: 'acme', channel: 'C1', ts: TS }));
    const byCommand = await cli(
      harness,
      ['--json', 'delete', 'prepare', '--workspace', 'acme', '--channel', 'C1', '--ts', TS],
      fake.fetch,
    );
    const refused = byCommand.json<{ ok: boolean; error: Failure }>();
    assert.equal(refused.ok, false);
    assert.equal(byTool.code, 'SCOPE_MISSING');
    assert.equal(refused.error.code, byTool.code);
    assert.equal(refused.error.message, byTool.message);
    assert.equal(byTool.details?.reason, 'not-own-message');
  } finally {
    await close();
  }
});

// ── At the command line ────────────────────────────────────────────────────────────────────────────────────────

test('edit prepare shows the edit, and edit send makes it, from a draft written with draft create', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack();
  const created = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'shipping in ten minutes'],
    fake.fetch,
  );
  const draftId = created.json<{ data: { draftId: string } }>().data.draftId;

  const shown = await cli(
    harness,
    ['edit', 'prepare', '--workspace', 'acme', '--draft', draftId, '--ts', TS],
    fake.fetch,
  );
  assert.equal(shown.code, EXIT_CODES.OK, shown.stderr);
  assert.match(
    shown.stdout,
    /^EDIT PREVIEW · workspace acme · approval (ap_\w+) · draft dft_\w+ · nothing has been changed$/m,
  );
  assert.match(shown.stdout, /^Edits: +the message at 1700000000\.000100$/m);
  assert.match(shown.stdout, new RegExp(`Now \\(4 words, 23 characters\\):\\n\`\`\`text\\n${WORDS}\\n\`\`\``));
  assert.match(shown.stdout, /After the edit \(4 words, 23 characters\):\n```text\nshipping in ten minutes\n```/);
  assert.match(shown.stdout, /^say yes and the message is changed$/m);
  const approvalId = /approval (ap_\w+)/.exec(shown.stdout)?.[1] ?? '';

  const made = await cli(
    harness,
    [
      'edit',
      'send',
      '--workspace',
      'acme',
      '--draft',
      draftId,
      '--approval',
      approvalId,
      '--expect-channel',
      'C1',
      '--ts',
      TS,
    ],
    fake.fetch,
  );
  assert.equal(made.code, EXIT_CODES.OK, made.stderr);
  assert.equal(made.stdout.trim(), `Edited the message at ${TS} in C1.`);
  assert.equal(fake.count('chat.update'), 1);
});

test('delete prepare shows what disappears, delete send deletes it, and a note reads as a sentence', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const fake = slack({ 'chat.delete': () => ({ ok: false, error: 'message_not_found' }) });
  const shown = await cli(
    harness,
    ['delete', 'prepare', '--workspace', 'acme', '--channel', 'C1', '--ts', TS],
    fake.fetch,
  );
  assert.equal(shown.code, EXIT_CODES.OK, shown.stderr);
  assert.match(shown.stdout, /^DELETE PREVIEW · workspace acme · approval (ap_\w+) · nothing has been deleted$/m);
  assert.match(shown.stdout, /^! A deletion cannot be undone/m);
  assert.match(shown.stdout, /^say yes and the message is deleted$/m);
  const approvalId = /approval (ap_\w+)/.exec(shown.stdout)?.[1] ?? '';

  const done = await cli(
    harness,
    ['delete', 'send', '--workspace', 'acme', '--channel', 'C1', '--ts', TS, '--approval', approvalId],
    fake.fetch,
  );
  assert.equal(done.code, EXIT_CODES.OK, done.stderr);
  assert.equal(
    done.stdout.trim(),
    `Deleted the message at ${TS} in C1. Slack found no message at that ts by the time it was asked, so there was nothing left to delete.`,
  );
});

test('cancelling an edit or a deletion at the approve prompt says what was not done', async () => {
  for (const [kind, prepare, nothing] of [
    ['edit', ['--json', 'edit', 'prepare', '--workspace', 'acme', '--ts', TS, '--draft'], 'Nothing was changed.'],
    [
      'delete',
      ['--json', 'delete', 'prepare', '--workspace', 'acme', '--channel', 'C1', '--ts', TS],
      'Nothing was deleted.',
    ],
  ] as const) {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
    const fake = slack();
    let argv: string[] = [...prepare];
    if (kind === 'edit') {
      const created = await cli(
        harness,
        ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'fixed'],
        fake.fetch,
      );
      argv = [...argv, created.json<{ data: { draftId: string } }>().data.draftId];
    }
    const prepared = await cli(harness, argv, fake.fetch);
    const approvalId = prepared.json<{ data: { approvalId: string } }>().data.approvalId;
    const cancelled = await cli(harness, ['approve', approvalId], fake.fetch, { tty: true, answer: '' });
    assert.equal(cancelled.code, EXIT_CODES.OK, cancelled.stderr);
    assert.match(cancelled.stdout, new RegExp(`Cancelled\\. ${nothing.replace('.', '\\.')}`), kind);
    assert.equal(asV2(await harness.core.approvals.get(approvalId))?.state, 'revoked', kind);
  }
});

test('a file is replaced over MCP in two calls, and taken off at the command line with --remove-file', async (t) => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'chat' });
  const old = { id: 'F0OLD00001', name: 'chart-v1.png' };
  const fake = await startFakeSlack({
    'conversations.history': () => ({ ok: true, messages: [mine({ files: [old] })] }),
    'conversations.info': () => ({ ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } }),
    'chat.update': () => ({ ok: true, channel: 'C1', ts: TS }),
  });
  t.after(() => fake.close());
  const uploads = fake.acceptUploads({ ts: TS });
  const chart = homeFile(harness, 'chart-v2.png', 'the second chart');
  const { call, close } = await connect(harness, fake.fetch);
  try {
    const prepared = await call('slack_edit_prepare', {
      workspace: 'acme',
      ts: TS,
      channel: 'C1',
      files: [chart],
      removeFiles: [old.id],
    });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared.structuredContent));
    const { draftId, approvalId, preview } = prepared.structuredContent as {
      draftId: string;
      approvalId: string;
      preview: { replaces: { files: unknown; wordsUnchanged: boolean } };
    };
    assert.deepEqual(preview.replaces.files, { keeps: [], removes: ['chart-v1.png'] });
    assert.equal(preview.replaces.wordsUnchanged, true);

    const edited = await call('slack_edit_send', {
      workspace: 'acme',
      draftId,
      approvalId,
      expectChannel: 'C1',
      ts: TS,
    });
    assert.notEqual(edited.isError, true, JSON.stringify(edited.structuredContent));
    assert.deepEqual((edited.structuredContent as { files: unknown }).files, [
      { id: 'F0UP0001', name: 'chart-v2.png' },
    ]);
    const update = fake.requests.find((request) => request.method === 'chat.update');
    assert.equal(update?.params.get('file_ids'), JSON.stringify(['F0UP0001']));
    assert.equal(update?.params.get('text'), WORDS, 'the words kept, exactly as Slack holds them');
    assert.equal(uploads.completed[0]?.channelId, null, 'the new file was shared nowhere before the edit');
  } finally {
    await close();
  }

  // At the command line: a draft with no words keeps the message's, and --remove-file takes the file off.
  const created = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--file', chart],
    fake.fetch,
  );
  const fresh = created.json<{ data: { draftId: string } }>().data.draftId;
  const shown = await cli(
    harness,
    ['edit', 'prepare', '--workspace', 'acme', '--draft', fresh, '--ts', TS, '--remove-file', old.id],
    fake.fetch,
  );
  assert.equal(shown.code, EXIT_CODES.OK, shown.stderr);
  assert.match(shown.stdout, /^Removes: +chart-v1\.png$/m);
  assert.match(shown.stdout, /^Attach: +chart-v2\.png · /m);
  assert.match(shown.stdout, /^Words, unchanged \(/m);
});
