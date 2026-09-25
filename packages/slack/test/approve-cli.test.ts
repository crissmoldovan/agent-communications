import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { EXIT_CODES } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * Approving at a terminal, and what the commands waiting on it tell the agent.
 *
 * In a file of its own for the reason `cli-parity.test.ts` gives: these need a scripted Slack and a typed answer,
 * not a socket or a child process, and `cli.test.ts` already runs close to its time limit.
 *
 * Every test runs the commands in the order an agent and a person actually would. The operations underneath had
 * tests of their own, and none of them could see what went wrong between the commands: `approve` refused every
 * reaction it was given, the approval screen showed a room of four hundred as a count it could not read, and the
 * command an agent was told to hand the person was Gmail's.
 */

type FakeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

async function cli(
  harness: Harness,
  argv: string[],
  options: { read?: FakeFetch; tty?: boolean; answerChallenge?: boolean } = {},
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
    if (options.answerChallenge && !answered) {
      // `Type ABCD to approve this` — the code is issued per run, so it is read back off the prompt.
      const asked = /Type (\S+) to approve/.exec(stderr);
      if (asked) {
        answered = true;
        input.write(`${asked[1]}\n`);
      }
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
    probe: (input, init) => harness.probe(input, init),
    // Always a scripted Slack: a test that forgot it would reach the real one.
    read: options.read ?? scripted({}).read,
  });
  return { code, stdout, stderr, json: <T>() => JSON.parse(stdout) as T };
}

/** Slack as a script of replies by method, counting what it was asked. The script can be changed mid-test. */
function scripted(script: Record<string, unknown>) {
  const asked: string[] = [];
  const read: FakeFetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split('/api/')[1]?.split('?')[0] ?? '';
    asked.push(method);
    return new Response(JSON.stringify(script[method] ?? { ok: false, error: 'unknown_method' }));
  };
  return { read, script, count: (method: string) => asked.filter((name) => name === method).length };
}

// ── Reactions ──────────────────────────────────────────────────────────────────────────────────────────────────

const REACT = ['react', '--workspace', 'acme', '--channel', 'C1', '--ts', '1.1', '--emoji', 'tada'];

/** A reaction held under `confirm`, and the approval id the refusal names. */
async function heldReaction(harness: Harness, read: FakeFetch): Promise<string> {
  const held = await cli(harness, ['--json', ...REACT], { read });
  assert.equal(held.code, EXIT_CODES.APPROVAL, held.stdout);
  const error = held.json<Envelope<never>>().error;
  assert.equal(error?.code, 'APPROVAL_PENDING');
  const approvalId = String(error?.details?.approvalId);
  assert.match(approvalId, /^ap_/);
  return approvalId;
}

test('a reaction under `confirm` waits for a person, and the approval they give adds it exactly once', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const slack = scripted({ 'reactions.add': { ok: true } });

  const held = await cli(harness, ['--json', ...REACT], { read: slack.read });
  assert.equal(held.code, EXIT_CODES.APPROVAL, held.stdout);
  const error = held.json<Envelope<never>>().error;
  assert.equal(error?.code, 'APPROVAL_PENDING', 'waiting, not refused');
  const approvalId = String(error?.details?.approvalId);
  assert.match(approvalId, /^ap_/, 'and it says which approval a person has to give');
  assert.match(error?.hint ?? '', new RegExp(`agent-slack approve ${approvalId}`), 'the command that approves it');
  assert.match(error?.hint ?? '', new RegExp(`--approval ${approvalId}`), 'and the one that then uses it');
  assert.doesNotMatch(error?.hint ?? '', /gmail/i, 'never another product’s');
  assert.equal(slack.count('reactions.add'), 0, 'nothing is added while it waits');

  const approved = await cli(harness, ['approve', approvalId], { tty: true, answerChallenge: true });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stderr);
  // The one line a person reads: the workspace, the channel, the message and the emoji.
  assert.match(approved.stdout, /workspace acme/);
  assert.match(approved.stdout, /Add :tada: to the message at 1\.1 in C1/);
  assert.equal(slack.count('reactions.add'), 0, 'approving does not react');

  const made = await cli(harness, ['--json', ...REACT, '--approval', approvalId], { read: slack.read });
  assert.equal(made.code, EXIT_CODES.OK, made.stdout);
  assert.equal(slack.count('reactions.add'), 1, 'the approval adds it');

  const again = await cli(harness, ['--json', ...REACT, '--approval', approvalId], { read: slack.read });
  assert.equal(again.code, EXIT_CODES.APPROVAL, 'and is spent by doing so');
  assert.equal(slack.count('reactions.add'), 1, 'so a second claim reaches nothing');
});

test('an approved reaction is bound to its channel, its message and its emoji', async () => {
  // Each of these is a different act from the one the person read, so none of them may spend the approval.
  const swaps: [string, string[]][] = [
    ['another emoji', [...REACT.slice(0, -1), 'thumbsdown']],
    ['another channel', REACT.map((part) => (part === 'C1' ? 'C2' : part))],
    ['another message', REACT.map((part) => (part === '1.1' ? '2.2' : part))],
    ['taking it off instead', [...REACT, '--remove']],
  ];
  for (const [what, argv] of swaps) {
    const harness = await newHarness();
    await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
    const slack = scripted({ 'reactions.add': { ok: true }, 'reactions.remove': { ok: true } });
    const approvalId = await heldReaction(harness, slack.read);
    const approved = await cli(harness, ['approve', approvalId], { tty: true, answerChallenge: true });
    assert.equal(approved.code, EXIT_CODES.OK, approved.stderr);

    const swapped = await cli(harness, ['--json', ...argv, '--approval', approvalId], { read: slack.read });
    assert.equal(swapped.code, EXIT_CODES.APPROVAL, `${what}: ${swapped.stdout}`);
    assert.equal(slack.count('reactions.add') + slack.count('reactions.remove'), 0, `${what} reached Slack`);
  }
});

// ── Posts ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Draft → prepare, as an agent does it, returning what `post send` and `approve` are then given. */
async function preparedPost(harness: Harness, read: FakeFetch, extra: string[] = []) {
  const written = await cli(
    harness,
    ['--json', 'draft', 'create', '--workspace', 'acme', '--channel', 'C1', '--text', 'shipping now', ...extra],
    { read },
  );
  assert.equal(written.code, EXIT_CODES.OK, written.stdout);
  const draftId = String(written.json<Envelope<{ draftId: string }>>().data?.draftId);
  const prepared = await cli(harness, ['--json', 'post', 'prepare', '--workspace', 'acme', '--draft', draftId], {
    read,
  });
  assert.equal(prepared.code, EXIT_CODES.OK, prepared.stdout);
  const approvalId = String(prepared.json<Envelope<{ approvalId: string }>>().data?.approvalId);
  const send = ['--json', 'post', 'send', '--workspace', 'acme', '--draft', draftId, '--approval', approvalId];
  return { draftId, approvalId, send: [...send, '--expect-channel', 'C1'] };
}

test('a post held for approval names agent-slack’s commands, never Gmail’s', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const slack = scripted({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'eng', num_members: 4, is_member: true } },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
  });
  const { approvalId, send } = await preparedPost(harness, slack.read);

  const held = await cli(harness, send, { read: slack.read });
  assert.equal(held.code, EXIT_CODES.APPROVAL, held.stdout);
  const error = held.json<Envelope<never>>().error;
  assert.equal(error?.code, 'APPROVAL_PENDING');
  assert.match(error?.hint ?? '', new RegExp(`agent-slack approve ${approvalId}`));
  assert.match(error?.hint ?? '', /agent-slack post send/);
  assert.doesNotMatch(error?.hint ?? '', /gmail|trusted client form/i, 'there is no Gmail and no form here');
  assert.equal(slack.count('chat.postMessage'), 0);
});

test('the approval screen shows the channel and how many people the post interrupts', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const slack = scripted({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'eng', num_members: 412, is_member: true } },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
  });
  const { approvalId, send } = await preparedPost(harness, slack.read, ['--broadcast', 'channel']);

  const approved = await cli(harness, ['approve', approvalId], {
    read: slack.read,
    tty: true,
    answerChallenge: true,
  });
  assert.equal(approved.code, EXIT_CODES.OK, approved.stderr);
  assert.match(approved.stdout, /Channel:\s+#eng/, 'the room by name, not only its id');
  assert.match(approved.stdout, /@channel — about 412 people/, 'and the reach the approval is bound to');
  assert.doesNotMatch(approved.stdout, /could not be read|not known/);

  const posted = await cli(harness, send, { read: slack.read });
  assert.equal(posted.code, EXIT_CODES.OK, posted.stdout);
  assert.equal(slack.count('chat.postMessage'), 1, 'what was approved is what goes');
});

test('a room that grew after the preview is refused at the approval screen, before a code is asked for', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'acme', mode: 'send', sendPolicy: 'confirm' });
  const slack = scripted({
    'conversations.info': { ok: true, channel: { id: 'C1', name: 'eng', num_members: 412, is_member: true } },
    'chat.postMessage': { ok: true, ts: '1700000000.000100' },
  });
  const { approvalId, send } = await preparedPost(harness, slack.read, ['--broadcast', 'channel']);

  // Sixty people joined while the approval waited. The person would be agreeing to a number nobody measured.
  slack.script['conversations.info'] = {
    ok: true,
    channel: { id: 'C1', name: 'eng', num_members: 472, is_member: true },
  };
  const approving = await cli(harness, ['approve', approvalId], {
    read: slack.read,
    tty: true,
    answerChallenge: true,
  });
  assert.equal(approving.code, EXIT_CODES.APPROVAL, approving.stdout + approving.stderr);
  assert.match(approving.stderr, /472/, 'it says what the room holds now');
  assert.doesNotMatch(approving.stderr, /Type \S+ to approve/, 'and never asks for the code');

  const posted = await cli(harness, send, { read: slack.read });
  assert.equal(posted.code, EXIT_CODES.APPROVAL, 'nothing was approved');
  assert.equal(slack.count('chat.postMessage'), 0);
});
