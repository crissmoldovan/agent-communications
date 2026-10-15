import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { AGENT_LABEL_WORDS, agentLabelOf } from '../src/agent-label.ts';
import { type GatedOutcome, gatedChange } from '../src/change-flow.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { renameEntry } from '../src/names.ts';
import { type LabelChangeRequest, labelChange, labelReport } from '../src/operations/label.ts';
import { auditTail, listApprovals } from '../src/operations/maintenance.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task A2 of the agent label (design 2026-10-15-agent-label, L5 and L6): `agentcomms label` and `comms_label`, one
 * operation. With no change it shows the word, the name, every rule and, for each account and kind, who a message
 * appears to come from; a change goes through the one change flow — a loosening is shown and approved first, a
 * tightening applies at once.
 *
 * Every test runs against a temporary home and config directory, with synthetic accounts; nothing reads the real ones
 * and nothing talks to a channel.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const CREATED = '2026-09-20T00:00:00.000Z';

const inbox = {
  id: 'ibx_AAAAAAAAAAAAAAAA',
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'send',
  contacts: false,
  grantedScopes: [],
  secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
  internalDomains: ['acme.test'],
  createdAt: CREATED,
};
const slack = {
  id: 'acc_AAAAAAAAAAAAAAAA',
  platform: 'slack',
  workspace: 'T_ACME',
  userId: 'U_AAAA',
  tier: 'send',
  mode: 'send',
  grantedScopes: [],
  secretRef: 'slack:token:acc_AAAAAAAAAAAAAAAA',
  createdAt: CREATED,
};
const whatsapp = {
  id: 'acc_BBBBBBBBBBBBBBBB',
  platform: 'whatsapp',
  workspace: 'local',
  userId: 'me',
  tier: 'read',
  mode: 'read',
  grantedScopes: [],
  secretRef: 'whatsapp:none:acc_BBBBBBBBBBBBBBBB',
  createdAt: CREATED,
};

interface Machine {
  env: Record<string, string>;
  core: Core;
}

function machine(agentLabel?: unknown, extra: Record<string, unknown> = {}): Machine {
  const home = tempDir('comms-label-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const body = {
    version: 2,
    inboxes: { 'acme/gmail': inbox },
    accounts: { 'acme/slack': slack, 'acme/whatsapp': whatsapp },
    ...(agentLabel === undefined ? {} : { agentLabel }),
    ...extra,
  };
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  // Opened as core's own CLI and server open it, so what it names is located (CUE-403).
  return { env, core: openCore({ env, caller: CORE_CALLER }) };
}

/**
 * One change through the flow, as the core server runs it: the first call, or the claim with `approvalId`. Async, so a
 * request refused before anything is planned rejects as every other refusal does.
 */
async function run(m: Machine, request: LabelChangeRequest, approvalId?: string) {
  return gatedChange(m.core, labelChange(m.core, request, 'mcp'), { surface: 'mcp', channel: 'core', approvalId });
}

/** The prepared change of an outcome that waits for the person, or a failure saying what happened instead. */
function waiting<T>(outcome: GatedOutcome<T>) {
  assert.equal(outcome.status, 'approval-required', 'this change waits for the person');
  if (outcome.status !== 'approval-required') throw new Error('unreachable');
  return outcome.prepared;
}

function applied<T>(outcome: GatedOutcome<T>): T {
  assert.equal(outcome.status, 'applied', 'this change applies at once');
  if (outcome.status !== 'applied') throw new Error('unreachable');
  return outcome.result;
}

function usage(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(`${error.message} ${error.hint ?? ''}`, pattern);
    return true;
  };
}

const labelOf = async (m: Machine) => agentLabelOf(await m.core.config.load());

test('show: with no change it asks nobody, and says who each kind of message appears to come from', async () => {
  const m = machine({
    word: 'twin',
    name: 'Jo Example',
    rules: [
      { account: 'acme/slack', kinds: ['reaction'], as: 'me' },
      { account: 'acme/slack', conversation: 'C0ACME', as: 'me' },
    ],
    slackIcons: { [slack.id]: ':jo-agent:' },
  });
  const report = await labelReport(m.core);
  assert.equal(report.word, 'twin');
  assert.deepEqual(report.words, [...AGENT_LABEL_WORDS]);
  assert.equal(report.name, 'Jo Example');
  assert.deepEqual(
    report.rules.map((rule) => [rule.text, rule.matches]),
    [
      ['acme/slack for reaction: me', true],
      ['acme/slack in C0ACME: me', true],
    ],
  );
  const gmail = report.accounts.find((account) => account.account === 'acme/gmail');
  assert.ok(gmail, 'the mailbox is listed');
  assert.equal(gmail.phrase, 'Jo Example (twin)');
  assert.deepEqual(
    gmail.kinds.map((kind) => [kind.kind, kind.identity, kind.source]),
    [
      ['send', 'agent', 'default'],
      ['reply', 'agent', 'default'],
    ],
  );
  assert.match(gmail.kinds[0]?.appearsAs ?? '', /\(twin\)/);
  const workspace = report.accounts.find((account) => account.account === 'acme/slack');
  assert.ok(workspace, 'the workspace is listed');
  assert.deepEqual(
    workspace.kinds.map((kind) => [kind.kind, kind.identity]),
    [
      ['post', 'agent'],
      ['reply', 'agent'],
      ['reaction', 'me'],
      ['edit', 'agent'],
      ['file', 'agent'],
    ],
  );
  const reaction = workspace.kinds.find((kind) => kind.kind === 'reaction');
  assert.equal(reaction?.rule, 'acme/slack for reaction: me');
  assert.match(reaction?.appearsAs ?? '', /as you, with no label/);
  assert.deepEqual(workspace.conversations, ['acme/slack in C0ACME: me']);
  assert.deepEqual(workspace.icon, { emoji: ':jo-agent:' });
  // WhatsApp sends nothing itself, so nothing it does is labelled.
  const local = report.accounts.find((account) => account.account === 'acme/whatsapp');
  assert.deepEqual(local?.kinds, []);
  assert.deepEqual(await listApprovals(m.core), [], 'showing prepared nothing');
});

test('show: an empty configuration reads as the word agent, no name and no rules', async () => {
  const m = machine();
  const report = await labelReport(m.core);
  assert.equal(report.word, 'agent');
  assert.equal(report.name, null);
  assert.deepEqual(report.rules, []);
  const workspace = report.accounts.find((account) => account.account === 'acme/slack');
  assert.equal(workspace?.phrase, null, 'no name setting: the channel’s own name, or a refusal');
  assert.ok(workspace?.kinds.every((kind) => kind.identity === 'agent' && kind.source === 'default'));
  assert.deepEqual(workspace?.icon, { photo: true });
});

test('word: a new word is shown first, with the phrase recipients will see, and applied with the approval', async () => {
  const m = machine({ name: 'Jo Example' });
  const prepared = waiting(await run(m, { word: 'twin' }));
  assert.match(prepared.preview, /Jo Example \(twin\)/);
  assert.match(prepared.preview, /acme\/gmail/);
  assert.match(prepared.preview, /the word after your name in the agent label: agent → twin/);
  assert.equal((await labelOf(m)).word, undefined, 'nothing is written before the approval');
  const result = applied(await run(m, { word: 'twin' }, prepared.approvalId));
  assert.equal(result.changed, true);
  assert.equal(result.word, 'twin');
  assert.equal((await labelOf(m)).word, 'twin');
  // The same word again changes nothing, and asks nobody.
  const again = applied(await run(m, { word: 'twin' }));
  assert.equal(again.changed, false);
});

test('word: a word off the list is refused, naming the seven', async () => {
  const m = machine();
  for (const word of ['human', 'Agent', 'ai', '']) {
    await assert.rejects(
      run(m, { word }),
      usage('USAGE', /agent, assistant, twin, minion, bot, fake, AI/),
      JSON.stringify(word),
    );
  }
});

test('word: a word that would make the name’s label too long is refused, saying how to shorten the name', async () => {
  const m = machine({ name: 'x'.repeat(70) });
  await assert.rejects(run(m, { word: 'assistant' }), usage('USAGE', /80 characters[\s\S]*label name/));
});

test('name: set and cleared through the flow; a name with a parenthesis or hidden character is refused', async () => {
  const m = machine();
  const prepared = waiting(await run(m, { name: 'Jo Example' }));
  assert.match(prepared.preview, /Jo Example \(agent\)/);
  applied(await run(m, { name: 'Jo Example' }, prepared.approvalId));
  assert.equal((await labelOf(m)).name, 'Jo Example');
  const clearing = waiting(await run(m, { name: null }));
  applied(await run(m, { name: null }, clearing.approvalId));
  assert.equal((await labelOf(m)).name, undefined);
  for (const name of ['Jo (agent)', 'Jo <x>', 'Jo​Example', ' Jo', 'x'.repeat(75)]) {
    await assert.rejects(run(m, { name }), usage('USAGE', /name|characters/), JSON.stringify(name));
  }
});

test('rules: an agent rule, or removing a me rule, tightens and applies at once with no approval', async () => {
  const meRule = { account: 'acme/slack', kinds: ['reaction' as const], as: 'me' as const };
  const m = machine({ rules: [meRule] });
  const added = applied(
    await run(m, { addRule: { account: 'acme/slack', conversation: 'C0ACME', kinds: ['post'], as: 'agent' } }),
  );
  assert.equal(added.changed, true);
  assert.deepEqual((await labelOf(m)).rules, [
    meRule,
    { account: 'acme/slack', conversation: 'C0ACME', kinds: ['post'], as: 'agent' },
  ]);
  applied(await run(m, { removeRule: meRule }));
  assert.deepEqual((await labelOf(m)).rules, [
    { account: 'acme/slack', conversation: 'C0ACME', kinds: ['post'], as: 'agent' },
  ]);
  assert.deepEqual(await listApprovals(m.core), [], 'neither asked anybody');
});

test('rules: a me rule waits, and its preview says what each affected kind will now be', async () => {
  const m = machine();
  const rule = { account: 'acme/slack', kinds: ['post', 'reply'] as const, as: 'me' as const };
  const prepared = waiting(await run(m, { addRule: { ...rule, kinds: [...rule.kinds] } }));
  assert.match(prepared.preview, /acme\/slack, post: as your agent → as you, with no label/);
  assert.match(prepared.preview, /acme\/slack, reply: as your agent → as you, with no label/);
  assert.doesNotMatch(prepared.preview, /acme\/slack, reaction/, 'only the kinds it names');
  assert.deepEqual((await labelOf(m)).rules, undefined);
  applied(await run(m, { addRule: { ...rule, kinds: [...rule.kinds] } }, prepared.approvalId));
  assert.deepEqual((await labelOf(m)).rules, [{ account: 'acme/slack', kinds: ['post', 'reply'], as: 'me' }]);
});

test('rules: a rule replaces the rule for the same scope with the other identity, so it is never shadowed', async () => {
  const m = machine({ rules: [{ account: 'acme/slack', as: 'agent' }] });
  // Beside it, the bare `me` rule would lose every tie to the `agent` one and change nothing.
  const prepared = waiting(await run(m, { addRule: { account: 'acme/slack', as: 'me' } }));
  assert.match(prepared.preview, /acme\/slack, post: as your agent → as you, with no label/);
  const result = applied(await run(m, { addRule: { account: 'acme/slack', as: 'me' } }, prepared.approvalId));
  assert.match(result.note ?? '', /replaced/);
  assert.deepEqual((await labelOf(m)).rules, [{ account: 'acme/slack', as: 'me' }]);
  // And back, at once: the agent rule replaces the me rule, which is a tightening.
  applied(await run(m, { addRule: { account: 'acme/slack', as: 'agent' } }));
  assert.deepEqual((await labelOf(m)).rules, [{ account: 'acme/slack', as: 'agent' }]);
});

test('rules: what a rule names is checked against the account it is for', async () => {
  const m = machine();
  const cases: [LabelChangeRequest, string, RegExp][] = [
    [{ addRule: { account: 'acme/gmail', kinds: ['post'], as: 'me' } }, 'USAGE', /send, reply/],
    [{ addRule: { account: 'acme/slack', kinds: ['send'], as: 'me' } }, 'USAGE', /post, reply, reaction, edit, file/],
    [{ addRule: { account: 'acme/slack', conversation: 'general', as: 'me' } }, 'USAGE', /C…|channel/],
    [{ addRule: { account: 'acme/gmail', conversation: 'nobody', as: 'me' } }, 'USAGE', /address|@domain/],
    [{ addRule: { account: 'acme/whatsapp', as: 'me' } }, 'USAGE', /sends nothing/],
    [{ addRule: { account: 'acme/slack', as: 'nobody' as 'me' } }, 'USAGE', /agent or me/],
    [{ addRule: { account: 'acme/slack', kinds: [], as: 'me' } }, 'USAGE', /kinds/],
    [{ addRule: { account: 'gone/slack', as: 'me' } }, 'NOT_FOUND', /gone\/slack/],
  ];
  for (const [request, code, pattern] of cases) {
    await assert.rejects(run(m, request), usage(code, pattern), JSON.stringify(request));
  }
  // A mail rule's address is kept in lower case, as it is matched.
  applied(await run(m, { addRule: { account: 'acme/gmail', conversation: '@Acme.Test', as: 'agent' } }));
  assert.deepEqual((await labelOf(m)).rules, [{ account: 'acme/gmail', conversation: '@acme.test', as: 'agent' }]);
});

test('Review focus 2: a rule naming a renamed or removed account matches nothing, is shown so, and can be removed', async () => {
  const m = machine({ rules: [{ account: 'acme/slack', as: 'me' }] });
  await m.core.config.update((c) => renameEntry(c, 'account', 'acme/slack', 'acme/slack-main'));
  const report = await labelReport(m.core);
  assert.deepEqual(
    report.rules.map((rule) => [rule.text, rule.matches]),
    [['acme/slack: me', false]],
  );
  const renamed = report.accounts.find((account) => account.account === 'acme/slack-main');
  assert.ok(
    renamed?.kinds.every((kind) => kind.identity === 'agent'),
    'the rule never follows a rename',
  );
  // A new rule for the old name is refused with the name it has now; the old rule is taken out as it is listed.
  await assert.rejects(
    run(m, { addRule: { account: 'acme/slack', as: 'me' } }),
    usage('NOT_FOUND', /acme\/slack-main/),
  );
  applied(await run(m, { removeRule: { account: 'acme/slack', as: 'me' } }));
  assert.equal((await labelOf(m)).rules, undefined, 'the last rule taken out takes the list with it');
  await assert.rejects(run(m, { removeRule: { account: 'acme/slack', as: 'me' } }), usage('NOT_FOUND', /rule/));
});

test('icon: an emoji name between colons is recorded for a Slack account through the flow; anything else is refused', async () => {
  const m = machine();
  await assert.rejects(
    run(m, { icon: { account: 'acme/slack', emoji: 'no-colons' } }),
    usage('USAGE', /:jo-agent:|colons/),
  );
  await assert.rejects(run(m, { icon: { account: 'acme/gmail', emoji: ':jo-agent:' } }), usage('USAGE', /Slack/));
  const prepared = waiting(await run(m, { icon: { account: 'acme/slack', emoji: ':jo-agent:' } }));
  assert.match(prepared.preview, /:jo-agent:/);
  applied(await run(m, { icon: { account: 'acme/slack', emoji: ':jo-agent:' } }, prepared.approvalId));
  // Keyed by the account's id, so it follows a rename and never another account.
  assert.deepEqual((await labelOf(m)).slackIcons, { [slack.id]: ':jo-agent:' });
  const clearing = waiting(await run(m, { icon: { account: 'acme/slack', emoji: null } }));
  applied(await run(m, { icon: { account: 'acme/slack', emoji: null } }, clearing.approvalId));
  assert.equal((await labelOf(m)).slackIcons, undefined);
});

test('a me rule for an account whose change policy is confirm is approved at a terminal', async () => {
  const m = machine(undefined, {
    accounts: { 'acme/slack': { ...slack, changePolicy: 'confirm' }, 'acme/whatsapp': whatsapp },
  });
  const prepared = waiting(await run(m, { addRule: { account: 'acme/slack', as: 'me' } }));
  assert.equal(prepared.policy, 'confirm');
  await assert.rejects(run(m, { addRule: { account: 'acme/slack', as: 'me' } }, prepared.approvalId));
  assert.equal((await labelOf(m)).rules, undefined, 'an agent cannot claim it without the person');
});

test('each change appears in the audit, as other changes do', async () => {
  const m = machine();
  const prepared = waiting(await run(m, { word: 'minion' }));
  applied(await run(m, { word: 'minion' }, prepared.approvalId));
  applied(await run(m, { addRule: { account: 'acme/slack', as: 'agent' } }));
  const records = await auditTail(m.core, { limit: 20 });
  const operations = records.map((record) => `${record.operation} ${record.outcome}`);
  assert.deepEqual(operations, ['change.prepare ok', 'change.claim ok', 'label.word ok', 'label.rule.add ok']);
  const rule = records.at(-1);
  assert.equal(rule?.alias, 'acme/slack');
  assert.equal(rule?.inboxId, slack.id);
  assert.equal(rule?.surface, 'mcp');
});

// ── Both surfaces ─────────────────────────────────────────────────────────────────────────────────────────────────

interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function connect(m: Machine) {
  const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const call = async (args: Record<string, unknown> = {}) =>
    (await client.callTool({ name: 'comms_label', arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

function cli(m: Machine, args: string[]) {
  const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  return { ...result, json: () => JSON.parse(result.stdout.trim().split('\n')[0] ?? '') };
}

test('comms_label and the label command show the same thing, and a change from either is the one flow', async () => {
  const m = machine({ name: 'Jo Example' });
  const { call, close } = await connect(m);
  try {
    const shown = await call();
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));
    assert.deepEqual(shown.structuredContent, JSON.parse(JSON.stringify(await labelReport(m.core))));
    const byCommand = cli(m, ['label', '--json']);
    assert.equal(byCommand.status, 0, byCommand.stderr);
    assert.deepEqual(byCommand.json().data, shown.structuredContent);

    const asked = await call({ word: 'twin' });
    assert.equal(asked.structuredContent?.approvalRequired, true, JSON.stringify(asked.structuredContent));
    assert.match(String(asked.structuredContent?.preview), /Jo Example \(twin\)/);
    const claimed = await call({ word: 'twin', approvalId: asked.structuredContent?.approvalId });
    assert.equal(claimed.structuredContent?.applied, true, JSON.stringify(claimed.structuredContent));
    assert.equal((await labelOf(m)).word, 'twin');

    const both = await call({ word: 'bot', name: 'Jo' });
    assert.equal(both.isError, true);
    assert.match(JSON.stringify(both.structuredContent), /one change at a time/);
    const report = await call({ approvalId: 'ap_00000000000000000000000000' });
    assert.equal(report.isError, true, 'showing takes no approval');
    const stray = await call({ addRule: { account: 'acme/slack', as: 'me', conversaton: 'C0ACME' } });
    assert.equal(stray.isError, true, 'a misspelt key inside a rule is refused, not dropped');

    // The command, from anything but a person at a terminal, prints the preview and exits 10 with the approval id.
    const pending = cli(m, ['label', 'rule', 'add', 'acme/slack', '--kinds', 'post,reply', '--as', 'me']);
    assert.equal(pending.status, 10, pending.stderr);
    assert.match(pending.stdout, /acme\/slack, post: as your agent → as you, with no label/);
    assert.match(pending.stderr, /APPROVAL_PENDING|needs approval/);
  } finally {
    await close();
  }
});
