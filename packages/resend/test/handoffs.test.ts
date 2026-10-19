import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  CommsError,
  handoffSentence,
  handoffSentenceToFill,
  inlineCommand,
  isCommand,
  lineWithWordsToFill,
  openCore,
  type RegisteredServer,
  SENDING_LEASE_MS,
  sendApprovesHint,
} from '@agentcomms/core';
import { RESEND_CALLER } from '../src/caller.ts';
import { nothingToDo, usageHint } from '../src/cli/program.ts';
import { renderAccounts } from '../src/cli/render.ts';
import { ResendContext } from '../src/context.ts';
import { runDoctor } from '../src/operations/doctor.ts';
import { listDomains } from '../src/operations/read.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { VERSION } from '../src/version.ts';
import {
  assertNoBareCommand,
  coreText,
  locatedResendLine,
  notLocatable,
  OLD_NODE,
  RESEND_SOURCE_CLI,
  resendHandoffs,
  resendInline,
  resendText,
  SUITE_COMMANDS,
  THIS_NODE,
} from './support/handoffs.ts';
import { FULL, type Harness, newHarness, ok, refused, tempDir } from './support/harness.ts';

/*
 * What Resend tells a person to run (CUE-403, task 13): every repair, approval and help it names is its own CLI as
 * this installation runs it — this Node, its entry, its folders pinned — or core's through its installed dependency,
 * or the sentence saying there is none here. Never `agent-resend …` by name: that is not on most people's PATH. The
 * Resend slice of the design's §4 7d is here — the bare command, the command with only an option, the existing
 * `--help` site and a Windows name in another case — beside the account, send and status handoffs it covers.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

const email = { from: 'hello@acme.test', to: ['sam@partner.test'], subject: 'Hi', text: 'Hi' };

/** A refusal's hint, asserting it was refused with `code`. */
async function hintOf(attempt: Promise<unknown>, code?: string): Promise<string> {
  const error = await attempt.then(
    () => assert.fail('it was not refused'),
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CommsError, String(error));
  if (code !== undefined) assert.equal(error.code, code, error.message);
  return error.hint ?? '';
}

/** A context whose handoffs locate nothing — a Node Resend does not run on — over the harness's own folders. */
function contextLocatingNothing(): ResendContext {
  const core = { ...harness.core, handoffs: resendHandoffs(harness.core.paths, 'darwin', OLD_NODE) };
  return new ResendContext({ core, env: harness.env, fetch: harness.fake.fetch, throttle: { intervalMs: 0 } });
}

// ── The command is this installation's own ─────────────────────────────────────────────────────────────────────

test('a Resend command is this Node, Resend’s own entry, its folders pinned, then its words (7d-resend)', async () => {
  harness = await newHarness();
  const context = harness.context();
  const approve = context.handoffs.own(['approve', 'ap_1']);
  assert.ok(isCommand(approve));
  assert.equal(approve.words[0], THIS_NODE);
  assert.ok(approve.words.includes(RESEND_SOURCE_CLI), approve.words.join(' '));
  const at = approve.words.indexOf(RESEND_SOURCE_CLI);
  assert.deepEqual(approve.words.slice(at + 1), [
    '--config-dir',
    harness.core.paths.configDir,
    '--state-dir',
    harness.core.paths.stateDir,
    '--data-dir',
    harness.core.paths.dataDir,
    '--secrets-dir',
    harness.core.paths.secretsDir,
    'approve',
    'ap_1',
  ]);
  // Core's, through Resend's installed dependency on it: core's own entry, never `agentcomms`.
  const doctor = context.handoffs.core(['doctor']);
  assert.ok(isCommand(doctor) && doctor.words.at(-1) === 'doctor');
  assert.ok(!doctor.words.includes(RESEND_SOURCE_CLI));
  assert.equal(doctor.words[0], THIS_NODE);
});

test('Resend’s context refuses a core that would print another package’s commands, or none', async () => {
  harness = await newHarness();
  assert.throws(() => new ResendContext({ core: openCore({ env: harness.env }), env: harness.env }), /caller/);
  const asCore = openCore({
    env: harness.env,
    caller: { url: import.meta.resolve('@agentcomms/core'), packageName: '@agentcomms/core' },
  });
  assert.throws(() => new ResendContext({ core: asCore, env: harness.env }), /@agentcomms\/core/);
  // Left to open its own, it opens it as Resend.
  const own = new ResendContext({ env: harness.env });
  assert.equal(own.handoffs.caller, RESEND_CALLER);
});

// ── Accounts: every repair is a located command ─────────────────────────────────────────────────────────────────

test('an account’s repairs are Resend’s own commands, located — on POSIX and on Windows (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'read' });
  for (const platform of ['darwin', 'win32'] as const) {
    const context = harness.context('cli', platform);
    const handoffs = resendHandoffs(harness.core.paths, platform);

    // An account that is not there: how to list them, and how a person adds one.
    const unknown = await hintOf(context.accounts.require('zeta/resend'), 'NOT_FOUND');
    assert.equal(
      unknown,
      handoffSentence(handoffs.own(['account', 'list']), (listed) =>
        handoffSentenceToFill(
          handoffs.own(['account', 'add']),
          ['<org/resend>'],
          (adding) => `List them with ${listed}; a person adds one with ${adding}.`,
        ),
      ),
    );
    assertNoBareCommand(unknown, 'the unknown account’s hint');

    // A key the secret store no longer has.
    const named = await context.accounts.require('acme/resend');
    await (await harness.core.secrets('file')).delete(named.account.secretRef);
    const missing = await hintOf(context.transport(named), 'AUTH_REQUIRED');
    assert.equal(
      missing,
      `A person removes the account and adds it again: ${resendInline(harness.core, ['account', 'add', 'acme/resend'], platform)}.`,
    );
    // The doctor's fix for it: remove, then add, both located.
    const doctor = await runDoctor(context, { offline: true });
    const stored = doctor.accounts[0]?.checks.find((check) => check.name === 'key stored');
    assert.equal(
      stored?.fix,
      `${resendText(harness.core, ['account', 'remove', 'acme/resend'], platform)}, then ${resendText(harness.core, ['account', 'add', 'acme/resend'], platform)}`,
    );
    assertNoBareCommand(String(stored?.fix), 'the doctor’s fix');
    await (await harness.core.secrets('file')).set(named.account.secretRef, FULL);
  }
});

test('a name already taken, or a key already connected, names the command that deals with it (7d-resend)', async () => {
  harness = await newHarness();
  // Connected from a terminal, so the account records the key it was added with.
  const added = await harness.cli(['--json', 'account', 'add', 'acme/resend'], {
    env: { RESEND_API_KEY: FULL },
  });
  assert.equal(added.code, 0, added.stdout);
  // From a terminal, with a key typed for a name that is taken: refused before any key is read.
  const taken = await harness.cli(['--json', 'account', 'add', 'acme/resend'], { env: { RESEND_API_KEY: 'x' } });
  assert.equal(taken.json().error?.code, 'USAGE');
  assert.equal(
    taken.json().error?.hint,
    `Choose another name, or remove that one first with ${resendInline(harness.core, ['account', 'remove', 'acme/resend'])}.`,
  );
  // The same key under another name: the account it is connected as, and its policy command with that name in it —
  // not the bare command with no name, which commander refuses.
  const again = await harness.cli(['--json', 'account', 'add', 'zeta/resend'], {
    env: { RESEND_API_KEY: FULL },
  });
  assert.equal(again.json().error?.code, 'USAGE', again.stdout);
  assert.equal(
    again.json().error?.hint,
    `One key, one account. Change that one with ${resendInline(harness.core, ['account', 'policy', 'acme/resend'])}, adding --send, --mode or --change.`,
  );
  assert.equal(harness.fake.sends().length, 0);
});

test('with no account, the list says how a person adds one, and an unknown name says it too (7d-resend)', async () => {
  harness = await newHarness();
  const handoffs = resendHandoffs(harness.core.paths, 'darwin');
  const add = handoffs.own(['account', 'add']);
  assert.ok(isCommand(add));
  const empty = renderAccounts({ accounts: [] }, false, handoffs);
  assert.equal(empty, `No Resend account yet. A person adds one with \`${lineWithWordsToFill(add, '<org/resend>')}\`.`);
  const cli = await harness.cli(['account', 'list']);
  assert.equal(cli.code, 0);
  assert.equal(cli.stdout.trim(), empty);
  // No command here: the list says only what it knows, and why there is none.
  const why = notLocatable(harness.core);
  assert.equal(
    renderAccounts({ accounts: [] }, false, resendHandoffs(harness.core.paths, 'darwin', OLD_NODE)),
    `No Resend account yet. ${why.message}`,
  );
});

// ── Sending: the approval, the status, the domain, the schedule ──────────────────────────────────────────────────

test('under confirm the preview, the next step and the claim name Resend’s own approve, and nothing is sent (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send', sendPolicy: 'confirm' });
  for (const platform of ['darwin', 'win32'] as const) {
    const context = harness.context('mcp', platform);
    const prepared = await prepareSend(context, 'acme/resend', email);
    const approve = resendInline(harness.core, ['approve', prepared.approvalId], platform);
    assert.ok(
      prepared.preview.includes(`Policy: confirm — a person runs ${approve} at their own terminal before this can go.`),
    );
    assert.equal(
      prepared.nextStep,
      `Show the preview to the user, then have them run ${approve} in their own terminal; learn when they have with resend_send_wait. You cannot approve this yourself. Then execute it with the same approval id.`,
    );
    const pending = await hintOf(
      executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
      'APPROVAL_PENDING',
    );
    assert.equal(
      pending,
      `Ask the user to run ${approve} in their own terminal; learn when they have with resend_send_wait, then execute it again with the same approval. You cannot approve it yourself.`,
    );
    for (const text of [prepared.preview, prepared.nextStep, pending]) assertNoBareCommand(text);
  }
  assert.equal(harness.fake.sends().length, 0, 'nothing was sent without its approval');
});

test('a send whose outcome is not known is checked with Resend’s own send status, located (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context();
  const prepared = await prepareSend(context, 'acme/resend', email);
  harness.fake.afterSend = () => ({ status: 0, drop: true });
  const status = resendInline(harness.core, ['send', 'status', prepared.approvalId, '--account', 'acme/resend']);
  // At once, its own code (design 2026-10-05 §D2): the send may have happened.
  const lost = await hintOf(
    executeSend(context, 'acme/resend', { approvalId: prepared.approvalId }),
    'SEND_OUTCOME_UNKNOWN',
  );
  assert.equal(
    lost,
    `Do not send it again, and do not prepare it again until you know it did not go. Check the Resend dashboard or ask the recipient, and check with ${status}; this approval is not used again.`,
  );
  // Later, when the approval reads as unknown: the same command, before anything else — and no second send.
  const later = new ResendContext({
    core: openCore({ env: harness.env, caller: RESEND_CALLER, now: () => new Date(Date.now() + SENDING_LEASE_MS) }),
    env: harness.env,
    fetch: harness.fake.fetch,
    throttle: { intervalMs: 0 },
    platform: 'darwin',
  });
  // Its own code (design 2026-10-05 §D2): the outcome is unknown, never a void — and the status command after it.
  const unknown = await hintOf(
    executeSend(later, 'acme/resend', { approvalId: prepared.approvalId }),
    'SEND_OUTCOME_UNKNOWN',
  );
  assert.ok(unknown.endsWith(` Check what happened with ${status} before anything else.`), unknown);
  assert.match(unknown, /^Check Sent, or the channel, before anything else/);
  assertNoBareCommand(`${lost} ${unknown}`);
  assert.equal(harness.fake.sends().length, 1, 'the one approved send, and no other');
});

test('read mode, never, an unverified or unknown domain: each names the command that changes it (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  await harness.addAccount({ name: 'read/resend', mode: 'read' });
  await harness.addAccount({ name: 'never/resend', mode: 'send', sendPolicy: 'never' });
  const context = harness.context();
  const inline = (words: string[]) => resendInline(harness.core, words);
  assert.equal(
    await hintOf(prepareSend(context, 'read/resend', email), 'SCOPE_MISSING'),
    `A person can allow sending with ${inline(['account', 'policy', 'read/resend', '--mode', 'send'])}, which is a change they approve.`,
  );
  assert.equal(
    await hintOf(prepareSend(context, 'never/resend', email), 'POLICY_NEVER'),
    `A person can change it with ${inline(['account', 'policy', 'never/resend', '--send', 'confirm'])}.`,
  );
  // `domains` takes `--account`: a command without it is one commander refuses, so the account is in it.
  assert.equal(
    await hintOf(prepareSend(context, 'acme/resend', { ...email, from: 'hello@other.test' }), 'BAD_DATA'),
    `Send from an address at a verified domain: see ${inline(['domains', '--account', 'acme/resend'])}.`,
  );
  assert.equal(
    await hintOf(prepareSend(context, 'acme/resend', { ...email, from: 'hello@pending.test' }), 'BAD_DATA'),
    `A person finishes the DNS records for it first: ${inline(['domains', '--account', 'acme/resend', '--domain', 'pending.test'])} lists them.`,
  );
  assert.equal(
    await hintOf(listDomains(context, 'acme/resend', { domain: 'nowhere.test' }), 'NOT_FOUND'),
    `List them with ${inline(['domains', '--account', 'acme/resend'])}.`,
  );
  assert.equal(harness.fake.sends().length, 0);
});

test('a scheduled email’s preview names the cancel command with its account, the id to fill in (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const at = new Date(Date.now() + 3_600_000).toISOString();
  const prepared = await prepareSend(harness.context(), 'acme/resend', { ...email, scheduledAt: at });
  const cancel = resendHandoffs(harness.core.paths, 'darwin').own(['scheduled', 'cancel', '--account', 'acme/resend']);
  assert.ok(isCommand(cancel));
  assert.ok(
    prepared.preview.includes(
      `Scheduled for ${at}; until then it can be cancelled with \`${lineWithWordsToFill(cancel, '<id>')}\``,
    ),
    prepared.preview,
  );
  assertNoBareCommand(prepared.preview);
  assert.equal(harness.fake.sends().length, 0);
});

test('an attachment from outside the allowed folders names core’s attach command, located from Resend (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const outside = join(tempDir('agent-resend-outside-'), 'plan.txt');
  writeFileSync(outside, 'the plan');
  const hint = await hintOf(prepareSend(harness.context(), 'acme/resend', { ...email, attachments: [outside] }));
  const add = resendHandoffs(harness.core.paths, 'darwin').core(['attach', 'roots', 'add']);
  assert.ok(isCommand(add));
  assert.ok(hint.includes(`\`${lineWithWordsToFill(add, '<folder>')}\``), hint);
  assertNoBareCommand(hint);
});

// ── No command here: the sentence says why, and what is left to say is still said ─────────────────────────────────

test('where Resend cannot be located, every handoff says why and keeps what it had to say, never a bare command', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send', sendPolicy: 'confirm' });
  const context = contextLocatingNothing();
  const why = notLocatable(harness.core).message;
  const prepared = await prepareSend(context, 'acme/resend', email);
  assert.ok(
    prepared.preview.includes(
      `Policy: confirm — a person approves it at their own terminal before this can go. ${why}`,
    ),
    prepared.preview,
  );
  assert.equal(
    prepared.nextStep,
    `Show the preview to the user; they approve it at their own terminal. ${why} You cannot approve this yourself. Then execute it with the same approval id.`,
  );
  assert.equal(
    await hintOf(executeSend(context, 'acme/resend', { approvalId: prepared.approvalId })),
    `Ask the user to approve it at their own terminal, then execute it again with the same approval. ${why} You cannot approve it yourself.`,
  );
  assert.equal(
    await hintOf(context.accounts.require('zeta/resend'), 'NOT_FOUND'),
    why,
    'no list, no add: the reason, once',
  );
  const named = await context.accounts.require('acme/resend');
  await (await harness.core.secrets('file')).delete(named.account.secretRef);
  const doctor = await runDoctor(context, { offline: true });
  assert.equal(doctor.accounts[0]?.checks.find((check) => check.name === 'key stored')?.fix, why);
  assert.equal(harness.fake.sends().length, 0);
});

// ── `--help`, and a command with nothing after it ──────────────────────────────────────────────────────────────────

test('a usage error and an empty command line point at this installation’s --help, located (7d-resend)', async () => {
  harness = await newHarness();
  for (const platform of ['darwin', 'win32'] as const) {
    const help = resendHandoffs(harness.core.paths, platform).own(['--help'], { uses: [] });
    assert.ok(isCommand(help));
    assert.deepEqual(help.words.slice(-1), ['--help']);
    assert.ok(!help.words.includes('--config-dir'), '--help opens no folder, so none is pinned');

    const usage = await harness.cli(['--json', 'nonsense'], { platform });
    assert.equal(usage.code, 64);
    assert.equal(usage.json().error?.hint, `Run ${inlineCommand(help)} to see the commands.`);
    assertNoBareCommand(String(usage.json().error?.hint), 'the usage error');

    // A parse that runs nothing — Commander shows the help for an empty line itself, so this is its fallback.
    assert.equal(nothingToDo(help), `Nothing to do. Try ${inlineCommand(help)}.`);
    assert.equal(usageHint(help), `Run ${inlineCommand(help)} to see the commands.`);
  }
  const why = resendHandoffs(harness.core.paths, 'darwin', OLD_NODE).own(['--help'], { uses: [] });
  assert.ok(!isCommand(why));
  assert.equal(nothingToDo(why), why.message);
  assert.equal(usageHint(why), why.message);
  // From the real CLI's own words, for a reader of the plain output: Resend's entry, then `--help`. For this machine's
  // own shell, which `locatedResendLine` reads: the harness otherwise gives the CLI darwin's, which quotes a Windows path.
  locatedResendLine((await harness.cli(['nonsense'], { platform: process.platform })).stderr, ['--help']);
});

test('approving as an agent, or with no terminal, names the approve a person runs, located (7d-resend)', async () => {
  harness = await newHarness();
  const approve = resendInline(harness.core, ['approve', 'ap_1']);
  const agent = await harness.cli(['--json', 'approve', 'ap_1'], { env: { CLAUDECODE: '1' } });
  // And the wait that learns when they have (design 2026-10-05 §D7).
  assert.equal(
    agent.json().error?.hint,
    `Ask the user to run ${approve} in their own terminal; learn when they have with ${resendInline(harness.core, ['send', 'wait', 'ap_1'])}.`,
  );
  const script = await harness.cli(['--json', 'approve', 'ap_1']);
  assert.equal(script.json().error?.hint, `Run ${approve} directly in a terminal.`);
  // A key, likewise: the command a person runs is this one, with the name, located.
  const key = await harness.cli(['--json', 'account', 'add', 'acme/resend'], { env: { CLAUDECODE: '1' } });
  assert.equal(
    key.json().error?.hint,
    `Ask the user to run ${resendInline(harness.core, ['account', 'add', 'acme/resend'])} in their own terminal. Never paste a key into a chat: the transcript keeps it.`,
  );
  const install = await harness.cli(['--json', 'mcp', 'install']);
  assert.equal(
    install.json().error?.hint,
    `For example: ${resendInline(harness.core, ['mcp', 'install', '--client', 'claude-code'])}.`,
  );
});

test('a change asked for at the command line is run again as this installation’s own command, with the approval', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'read' });
  const asked = await harness.cli(['--json', 'account', 'remove', 'acme/resend']);
  assert.equal(asked.code, 10, asked.stdout);
  const approvalId = String(asked.json().error?.details?.approvalId);
  assert.equal(
    asked.json().error?.hint,
    `Show the person the preview. Once they say yes, run ${resendInline(harness.core, ['account', 'remove', 'acme/resend', '--approval', approvalId])}.`,
  );
  assert.ok(await harness.context().accounts.find('acme/resend'), 'nothing was removed while it was asked');
});

// ── The greeting and the tools name no CLI ──────────────────────────────────────────────────────────────────────

test('the greeting and every tool say to run the command a result gives, and name no CLI (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const { client, close } = await harness.mcp();
  try {
    const greeting = client.getInstructions() ?? '';
    assertNoBareCommand(greeting, 'the greeting');
    assert.match(greeting, /the approve command the preparation gives/);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assertNoBareCommand(tool.description ?? '', `${tool.name}'s description`);
      assertNoBareCommand(JSON.stringify(tool.inputSchema), `${tool.name}'s arguments`);
    }
  } finally {
    await close();
  }
});

// ── A misdirected approval, and a Windows registration in another case ─────────────────────────────────────────

test('a send’s approval offered to a change is the one NOT_FOUND, naming no command (7d-resend)', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  await harness.addAccount({ name: 'zeta/resend', mode: 'read' });
  const { call, close } = await harness.mcp();
  try {
    const prepared = ok<{ approvalId: string }>(
      await call('resend_send_prepare', { account: 'acme/resend', ...email }),
    );
    const misdirected = refused(
      await call('resend_account_policy', { account: 'zeta/resend', mode: 'send', approvalId: prepared.approvalId }),
    );
    // Another kind's id is the one NOT_FOUND (design 2026-10-05 §D2): it says nothing of the record, not even the
    // command that would approve it.
    assert.equal(misdirected.code, 'NOT_FOUND');
    const hint = misdirected.hint ?? '';
    assert.doesNotMatch(hint, / approve /);
    assertNoBareCommand(hint);
  } finally {
    await close();
  }
  assert.equal(harness.fake.sends().length, 0);
});

/** Gmail installed globally on Windows, its command written as Windows wrote it: another case, `.CMD`. */
function windowsGmail(prefix: string, command: string): string {
  const root = join(prefix, 'node_modules', '@agentcomms', 'gmail');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({
      name: '@agentcomms/gmail',
      version: VERSION,
      type: 'module',
      engines: { node: '>=22.12.0' },
      bin: { 'agent-gmail': './dist/cli.mjs' },
      agentcomms: { channel: 'gmail', binary: 'agent-gmail' },
    })}\n`,
  );
  writeFileSync(join(root, 'dist', 'cli.mjs'), 'export {};\n');
  const path = join(prefix, command);
  writeFileSync(path, '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\node_modules\\@agentcomms\\gmail\\dist\\cli.mjs" %*\r\n');
  return path;
}

test('from Resend, a Windows registration in another case is found and printed located, never by that name (7d-resend)', async () => {
  harness = await newHarness();
  const command = windowsGmail(join(tempDir('agent-resend-prefix-'), 'npm'), 'Agent-Gmail.CMD');
  const registered: RegisteredServer = {
    client: 'claude-code',
    path: '/cfg/.claude.json',
    name: 'gmail',
    scope: 'user',
    command,
    args: ['mcp'],
  };
  const handoffs = resendHandoffs(harness.core.paths, 'win32').withRegistrations([registered]);
  const gmail = handoffs.of('gmail', ['approve', 'ap_1']);
  assert.ok(isCommand(gmail), 'message' in gmail ? gmail.message : '');
  assert.equal(gmail.words[0], THIS_NODE);
  assert.ok(
    gmail.words.some((word) => word.endsWith(join('gmail', 'dist', 'cli.mjs'))),
    gmail.words.join(' '),
  );
  const hint = sendApprovesHint(handoffs, 'ap_1');
  assert.ok(
    hint.startsWith(
      `It is approved with the command that prepared it — ${inlineCommand(gmail)} or ${resendInline(harness.core, ['approve', 'ap_1'], 'win32')} (`,
    ),
    hint,
  );
  assert.doesNotMatch(hint, /Agent-Gmail\.CMD/i);
  assertNoBareCommand(hint);
});

test('the bare-command check knows Resend’s name in any case, with or without a Windows extension (7d-resend)', () => {
  assert.ok(SUITE_COMMANDS.includes('agent-resend'));
  for (const bare of [
    'Run `agent-resend` to start.',
    'Run `agent-resend --help` to see the commands.',
    'Try Agent-Resend.CMD --help.',
    'Run "AGENT-RESEND.exe account list".',
    "Run 'agent-resend.ps1 approve ap_1'.",
    'A person adds one with `agent-resend account add <org/resend>`.',
  ]) {
    assert.throws(() => assertNoBareCommand(bare), /bare name/, bare);
  }
  for (const prose of [
    'Read-only is enforced by agent-resend, not by the key.',
    'Read-only is enforced by agent-resend’s own code.',
    `Run \`${process.execPath} ${RESEND_SOURCE_CLI} --help\` to see the commands.`,
  ]) {
    assertNoBareCommand(prose);
  }
});

test('core’s doctor, named by Resend, is core’s own command through Resend’s dependency on it', async () => {
  harness = await newHarness();
  writeFileSync(join(harness.core.paths.configDir, 'config.json'), '{ not json');
  const result = await runDoctor(harness.context(), { offline: true });
  const config = result.checks.find((check) => check.name === 'config');
  assert.equal(config?.ok, false);
  assert.equal(config?.fix, coreText(harness.core, ['doctor']));
  assertNoBareCommand(String(config?.fix));
});
