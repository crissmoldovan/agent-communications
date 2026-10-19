import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { allowedAct } from '../src/behaviour.ts';
import { type GatedOutcome, gatedChange, gatedChangeAtTerminal } from '../src/change-flow.ts';
import type { Streams } from '../src/cli-runtime.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import { type BehaviourChangeRequest, behaviourChange, behaviourReport } from '../src/operations/behaviour.ts';
import { auditTail, doctor, listApprovals } from '../src/operations/maintenance.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task 3 of the agent behaviour rules (design 2026-10-19-agent-behaviour-rules, B3–B5): `agentcomms behaviour` and
 * `comms_behaviour`, one operation each way. With no change it shows every rule and what each account allows, across it
 * and in each conversation a rule names; a change goes through the one change flow — one that allows more anywhere is
 * shown and approved first, one that only narrows applies at once — and the doctor says what would keep a rule from
 * holding.
 *
 * Every test runs against a temporary home and config directory, with synthetic accounts; nothing reads the real ones
 * and nothing talks to a channel.
 */

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
const CREATED = '2026-09-20T00:00:00.000Z';
const RESTART = 'servers started before 0.22.0 do not enforce this until their client restarts them';

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
  home: string;
  env: Record<string, string>;
  core: Core;
}

/** A home of its own, with a mailbox, a Slack workspace and a WhatsApp account — or, `bare`, no config at all. */
function machine(behaviour?: unknown, extra: Record<string, unknown> = {}, bare = false): Machine {
  const home = tempDir('comms-behaviour-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  if (!bare) {
    const body = {
      version: 2,
      inboxes: { 'acme/gmail': inbox },
      accounts: { 'acme/slack': slack, 'acme/whatsapp': whatsapp },
      ...(behaviour === undefined ? {} : { behaviour }),
      ...extra,
    };
    writeFileSync(join(configDir, 'config.json'), `${JSON.stringify(body, null, 2)}\n`);
  }
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
  return { home, env, core: openCore({ env, caller: CORE_CALLER }) };
}

/** One change through the flow, as the core server runs it: the first call, or the claim with `approvalId`. */
async function run(m: Machine, request: BehaviourChangeRequest, approvalId?: string) {
  return gatedChange(m.core, behaviourChange(m.core, request, 'mcp'), { surface: 'mcp', channel: 'core', approvalId });
}

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

function refused(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(`${error.message} ${error.hint ?? ''}`, pattern);
    return true;
  };
}

/** The rules as the file holds them. */
async function stored(m: Machine): Promise<unknown> {
  const behaviour = (await m.core.config.load()).behaviour as { rules?: unknown } | undefined;
  return behaviour?.rules;
}

test('the report on an empty config: no rules, and every account that acts allows everything', async () => {
  const bare = machine(undefined, {}, true);
  assert.deepEqual(await behaviourReport(bare.core), { rules: [], unreadable: [], accounts: [] });

  const m = machine();
  assert.deepEqual(await behaviourReport(m.core), {
    rules: [],
    unreadable: [],
    // WhatsApp sends nothing through these tools, so there is nothing for a rule to allow there.
    accounts: [
      { account: 'acme/gmail', allowed: 'all', conversations: [] },
      { account: 'acme/slack', allowed: 'all', conversations: [] },
    ],
  });
  assert.deepEqual(await listApprovals(m.core), [], 'showing prepared nothing');
});

test('the report: every rule, orphans marked, and what each account allows across it and per conversation', async () => {
  const m = machine({
    rules: [
      { account: 'acme/slack', accountId: slack.id, acts: ['reply', 'reaction'] },
      { account: 'acme/slack', accountId: slack.id, conversation: 'C0GENERAL', acts: ['reaction'] },
      { account: 'acme/gmail', accountId: inbox.id, conversation: '@client.test', acts: [] },
      { account: 'gone/gmail', accountId: 'ibx_GONEGONEGONEGONE', acts: ['send'] },
    ],
  });
  const report = await behaviourReport(m.core);
  assert.deepEqual(report.rules, [
    { account: 'acme/slack', acts: ['reply', 'reaction'], orphan: false },
    { account: 'acme/slack', conversation: 'C0GENERAL', acts: ['reaction'], orphan: false },
    { account: 'acme/gmail', conversation: '@client.test', acts: [], orphan: false },
    { account: 'gone/gmail', acts: ['send'], orphan: true },
  ]);
  assert.deepEqual(report.accounts, [
    { account: 'acme/gmail', allowed: 'all', conversations: [{ conversation: '@client.test', allowed: [] }] },
    {
      account: 'acme/slack',
      allowed: ['reply', 'reaction'],
      conversations: [{ conversation: 'C0GENERAL', allowed: ['reaction'] }],
    },
  ]);
});

test('setRule that tightens applies at once with no approval, binds the account id, and the first says to restart', async () => {
  const m = machine();
  const first = applied(await run(m, { setRule: { account: 'acme/slack', acts: ['reaction', 'reply', 'reply'] } }));
  assert.equal(first.change, 'setRule');
  assert.equal(first.changed, true);
  assert.equal(first.note, RESTART, 'the first rule on this machine says which servers do not hold it yet');
  assert.deepEqual(await stored(m), [{ account: 'acme/slack', accountId: slack.id, acts: ['reply', 'reaction'] }]);
  assert.deepEqual(first.rules, [{ account: 'acme/slack', acts: ['reply', 'reaction'], orphan: false }]);

  // Narrower still, in one channel: at once too, and only the first rule says to restart.
  const second = applied(
    await run(m, { setRule: { account: 'acme/slack', conversation: 'C0GENERAL', acts: ['reaction'] } }),
  );
  assert.equal(second.note, null);
  const config = await m.core.config.load();
  const query = { accountId: slack.id, account: 'acme/slack', places: [['C0GENERAL']] };
  assert.equal(allowedAct(config, { ...query, acts: ['reply'] }).allowed, false, 'a reply there is refused now');
  assert.equal(allowedAct(config, { ...query, acts: ['reaction'] }).allowed, true);

  // Nothing at all, for one mail domain: an empty list.
  applied(await run(m, { setRule: { account: 'acme/gmail', conversation: '@Client.TEST', acts: [] } }));
  assert.deepEqual(((await stored(m)) as unknown[]).at(-1), {
    account: 'acme/gmail',
    accountId: inbox.id,
    conversation: '@client.test',
    acts: [],
  });
  assert.deepEqual(await listApprovals(m.core), [], 'none of them asked anybody');

  // A domain in Unicode, or fully qualified with its trailing dot, is kept in the one form rules are compared in.
  applied(await run(m, { setRule: { account: 'acme/gmail', conversation: '@Bücher.DE.', acts: [] } }));
  assert.equal(((await stored(m)) as { conversation?: string }[]).at(-1)?.conversation, '@xn--bcher-kva.de');
  const again2 = applied(
    await run(m, { setRule: { account: 'acme/gmail', conversation: '@xn--bcher-kva.de', acts: [] } }),
  );
  assert.equal(again2.changed, false, 'the same domain in another spelling is the same rule');
  const mailQuery = { accountId: inbox.id, account: 'acme/gmail', acts: ['send' as const] };
  assert.equal(
    allowedAct(await m.core.config.load(), { ...mailQuery, places: [['kunde@xn--bcher-kva.de']] }).allowed,
    false,
  );
  // And it is found to take away in either spelling: removing it loosens, so it waits rather than is not found.
  waiting(await run(m, { removeRule: { account: 'acme/gmail', conversation: '@BÜCHER.de' } }));

  // The same rule again changes nothing, and asks nobody.
  const again = applied(await run(m, { setRule: { account: 'acme/slack', acts: ['reply', 'reaction'] } }));
  assert.equal(again.changed, false);
  assert.match(again.note ?? '', /already/);
});

test('setRule that loosens waits, its preview listing before → after, and applies on the claim', async () => {
  const m = machine({ rules: [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }] });
  const request: BehaviourChangeRequest = { setRule: { account: 'acme/slack', acts: ['post', 'reply'] } };
  const prepared = waiting(await run(m, request));
  assert.match(prepared.preview, /what an agent may do: acme\/slack: reply → post, reply/);
  assert.deepEqual(
    await stored(m),
    [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }],
    'nothing is written before the approval',
  );
  const result = applied(await run(m, request, prepared.approvalId));
  assert.equal(result.changed, true);
  assert.equal(result.note, 'It replaced acme/slack: reply: one place has one rule.', 'not the first rule');
  assert.deepEqual(await stored(m), [{ account: 'acme/slack', accountId: slack.id, acts: ['post', 'reply'] }]);

  // A conversation allowed more than its account loosens too: there, it is the wider of the two that holds.
  const wider: BehaviourChangeRequest = {
    setRule: { account: 'acme/slack', conversation: 'C0GENERAL', acts: ['post', 'reply', 'reaction'] },
  };
  const asked = waiting(await run(m, wider));
  assert.match(asked.preview, /acme\/slack C0GENERAL: post, reply → post, reply, reaction/);
  applied(await run(m, wider, asked.approvalId));
});

test('removeRule loosens, unless the rule it falls back to is no wider; one that is not there is refused', async () => {
  const m = machine({
    rules: [
      { account: 'acme/slack', accountId: slack.id, acts: ['reply'] },
      { account: 'acme/slack', accountId: slack.id, conversation: 'C0GENERAL', acts: ['reply'] },
      { account: 'acme/gmail', accountId: inbox.id, conversation: '@client.test', acts: [] },
    ],
  });
  // C0GENERAL falls back to the account's own reply: nothing widens, so it applies at once.
  const narrow = applied(await run(m, { removeRule: { account: 'acme/slack', conversation: 'C0GENERAL' } }));
  assert.equal(narrow.change, 'removeRule');
  assert.equal(narrow.changed, true);
  assert.deepEqual(await listApprovals(m.core), []);

  const request: BehaviourChangeRequest = { removeRule: { account: 'acme/slack' } };
  const prepared = waiting(await run(m, request));
  assert.match(prepared.preview, /acme\/slack: reply → everything/);
  applied(await run(m, request, prepared.approvalId));
  assert.deepEqual(await stored(m), [
    { account: 'acme/gmail', accountId: inbox.id, conversation: '@client.test', acts: [] },
  ]);

  await assert.rejects(
    run(m, { removeRule: { account: 'acme/slack', conversation: 'C0NONE' } }),
    refused('NOT_FOUND', /acme\/gmail in @client\.test/),
  );
  // The last one away: no rules left, and the setting with them.
  const last: BehaviourChangeRequest = { removeRule: { account: 'acme/gmail', conversation: '@CLIENT.test' } };
  const asked = waiting(await run(m, last));
  assert.match(asked.preview, /acme\/gmail @client\.test: nothing → everything/);
  applied(await run(m, last, asked.approvalId));
  assert.equal((await m.core.config.load()).behaviour, undefined);
});

test('what a rule names is checked against the account it is for, and every other rule is kept as written', async () => {
  const unreadable = { account: 'acme/gmail', acts: 'send', later: true };
  const m = machine({ rules: [unreadable], note: 'kept' });
  const cases: [BehaviourChangeRequest, string, RegExp][] = [
    [{ setRule: { account: 'acme/gmail', acts: ['post'] } }, 'USAGE', /acme\/gmail does not post[\s\S]*reply, send/],
    [{ setRule: { account: 'acme/slack', acts: ['send'] } }, 'USAGE', /post, reply, reaction, edit, delete, file/],
    [{ setRule: { account: 'acme/slack', acts: ['shout' as never] } }, 'USAGE', /not an act: "shout"/],
    [{ setRule: { account: 'acme/slack', conversation: 'general', acts: [] } }, 'USAGE', /C…|channel/],
    [{ setRule: { account: 'acme/gmail', conversation: 'nobody', acts: [] } }, 'USAGE', /address|@domain/],
    [{ setRule: { account: 'acme/whatsapp', acts: [] } }, 'USAGE', /sends nothing/],
    [{ setRule: { account: 'gone/slack', acts: [] } }, 'NOT_FOUND', /gone\/slack/],
    [{ setRule: { account: 'acme/slack' } as never }, 'USAGE', /acts/],
    [{ setRule: { account: '', acts: [] } }, 'USAGE', /organisation\/platform/],
    [
      { setRule: { account: 'acme/slack', acts: [] }, removeRule: { account: 'acme/slack' } } as never,
      'USAGE',
      /one change at a time/,
    ],
    [{} as never, 'USAGE', /setRule|removeRule|rule/],
  ];
  for (const [request, code, pattern] of cases) {
    await assert.rejects(run(m, request), refused(code, pattern), JSON.stringify(request));
  }
  // A tightening beside a rule this release cannot read keeps that rule exactly, and every other key of the setting.
  applied(await run(m, { setRule: { account: 'acme/slack', acts: ['reaction'] } }));
  assert.deepEqual((await m.core.config.load()).behaviour, {
    rules: [unreadable, { account: 'acme/slack', accountId: slack.id, acts: ['reaction'] }],
    note: 'kept',
  });
  // A domain that is not one is refused before anything is written: as a rule it could only allow nothing.
  for (const conversation of ['@exa|mple.com', 'bob@xn--a.com', '@client.com..']) {
    await assert.rejects(
      run(m, { setRule: { account: 'acme/gmail', conversation, acts: [] } }),
      refused('USAGE', /domain/),
      conversation,
    );
  }
  // A setting that is no list of rules at all cannot be changed from here: a change would drop it.
  const broken = machine({ rules: 'everything' });
  await assert.rejects(
    run(broken, { setRule: { account: 'acme/slack', acts: [] } }),
    refused('CONFIG', /cannot be read/),
  );
});

test('an orphaned rule, its account removed and connected again, is replaced by the rule set for the account now', async () => {
  const m = machine({ rules: [{ account: 'acme/slack', accountId: 'acc_GONEGONEGONEGONE', acts: ['reply'] }] });
  const report = await behaviourReport(m.core);
  assert.equal(report.rules[0]?.orphan, true, 'its id is no connected account’s');
  assert.deepEqual(report.accounts.find((account) => account.account === 'acme/slack')?.allowed, ['reply']);
  applied(await run(m, { setRule: { account: 'acme/slack', acts: ['reply'] } }));
  assert.deepEqual(await stored(m), [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }]);
});

test('a change is approved at a terminal, the preview saying "typed here, at this terminal"', async () => {
  const m = machine({ rules: [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }] });
  const person = terminal('yes');
  const result = await gatedChangeAtTerminal(
    m.core,
    behaviourChange(m.core, { removeRule: { account: 'acme/slack' } }, 'cli'),
    {
      channel: 'core',
      env: {},
      output: { color: false },
      rerun: ['behaviour', 'clear', 'acme/slack'],
      streams: person.streams,
    },
  );
  assert.equal(result.changed, true);
  assert.match(
    person.shown(),
    /^CHANGE PREVIEW · approval ap_\w+ · approved by a yes typed here, at this terminal · /m,
  );
  assert.match(person.shown(), /acme\/slack: reply → everything/);
  assert.equal(await stored(m), undefined);
});

test('a loosening for an account whose change policy is confirm waits for the person at their terminal', async () => {
  const m = machine(
    { rules: [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }] },
    { accounts: { 'acme/slack': { ...slack, changePolicy: 'confirm' }, 'acme/whatsapp': whatsapp } },
  );
  const prepared = waiting(await run(m, { removeRule: { account: 'acme/slack' } }));
  assert.equal(prepared.policy, 'confirm');
  await assert.rejects(
    run(m, { removeRule: { account: 'acme/slack' } }, prepared.approvalId),
    refused('APPROVAL_PENDING', /approve it at a terminal/),
    'an agent cannot claim it without the person',
  );
  assert.deepEqual(await stored(m), [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }]);
});

test('each change appears in the audit, by the account it is for', async () => {
  const m = machine();
  applied(await run(m, { setRule: { account: 'acme/slack', conversation: 'C0GENERAL', acts: ['reaction'] } }));
  const prepared = waiting(await run(m, { removeRule: { account: 'acme/slack', conversation: 'C0GENERAL' } }));
  applied(await run(m, { removeRule: { account: 'acme/slack', conversation: 'C0GENERAL' } }, prepared.approvalId));
  const records = await auditTail(m.core, { limit: 20 });
  assert.deepEqual(
    records.map((record) => `${record.operation} ${record.outcome}`),
    ['behaviour.rule.set ok', 'change.prepare ok', 'change.claim ok', 'behaviour.rule.remove ok'],
  );
  assert.equal(records.at(-1)?.alias, 'acme/slack');
  assert.equal(records.at(-1)?.inboxId, slack.id);
  assert.equal(records.at(-1)?.surface, 'mcp');
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
    (await client.callTool({ name: 'comms_behaviour', arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

function cli(m: Machine, args: string[]) {
  const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { encoding: 'utf8', env: m.env });
  return { ...result, json: () => JSON.parse(result.stdout.trim().split('\n')[0] ?? '') };
}

test('comms_behaviour and the behaviour command show the same thing, and a change from either is the one flow', async () => {
  const m = machine();
  const { call, close } = await connect(m);
  try {
    const shown = await call();
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));
    assert.deepEqual(shown.structuredContent, JSON.parse(JSON.stringify(await behaviourReport(m.core))));
    const byCommand = cli(m, ['behaviour', '--json']);
    assert.equal(byCommand.status, 0, byCommand.stderr);
    assert.deepEqual(byCommand.json().data, shown.structuredContent);

    // Tightenings apply at once from either: the command's act list, or `none`, and the tool's.
    const tightened = cli(m, ['behaviour', 'allow', 'acme/slack', 'reply,reaction', '--json']);
    assert.equal(tightened.status, 0, tightened.stderr);
    assert.equal(tightened.json().data.changed, true);
    assert.equal(tightened.json().data.note, RESTART);
    const none = cli(m, ['behaviour', 'allow', 'acme/gmail', 'none', '--conversation', '@client.test', '--json']);
    assert.equal(none.status, 0, none.stderr);
    const byTool = await call({ setRule: { account: 'acme/slack', conversation: 'C0GENERAL', acts: ['reaction'] } });
    assert.equal(byTool.structuredContent?.applied, true, JSON.stringify(byTool.structuredContent));
    assert.deepEqual(await stored(m), [
      { account: 'acme/slack', accountId: slack.id, acts: ['reply', 'reaction'] },
      { account: 'acme/gmail', accountId: inbox.id, conversation: '@client.test', acts: [] },
      { account: 'acme/slack', accountId: slack.id, conversation: 'C0GENERAL', acts: ['reaction'] },
    ]);
    const plain = cli(m, ['behaviour']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /acme\/slack[\s\S]*reply, reaction[\s\S]*in C0GENERAL: reaction/);
    assert.match(plain.stdout, /acme\/gmail[\s\S]*in @client\.test: nothing/);

    // A loosening waits on both, and the tool's approval is claimed by the tool.
    const wider = { setRule: { account: 'acme/slack', acts: ['post', 'reply', 'reaction'] } };
    const asked = await call(wider);
    assert.equal(asked.structuredContent?.approvalRequired, true, JSON.stringify(asked.structuredContent));
    assert.match(String(asked.structuredContent?.preview), /acme\/slack: reply, reaction → post, reply, reaction/);
    const pending = cli(m, ['behaviour', 'allow', 'acme/slack', 'post,reply,reaction']);
    assert.equal(pending.status, 10, pending.stderr);
    assert.match(pending.stdout, /acme\/slack: reply, reaction → post, reply, reaction/);
    assert.match(pending.stderr, /APPROVAL_PENDING|needs approval/);
    const claimed = await call({ ...wider, approvalId: asked.structuredContent?.approvalId });
    assert.equal(claimed.structuredContent?.applied, true, JSON.stringify(claimed.structuredContent));
    const clearing = cli(m, ['behaviour', 'clear', 'acme/slack']);
    assert.equal(clearing.status, 10, clearing.stderr);
    assert.match(clearing.stdout, /acme\/slack: post, reply, reaction → everything/);

    // Refused the same way on both.
    const both = await call({ setRule: { account: 'acme/slack', acts: [] }, removeRule: { account: 'acme/slack' } });
    assert.equal(both.isError, true);
    assert.match(JSON.stringify(both.structuredContent), /one change at a time/);
    const report = await call({ approvalId: 'ap_00000000000000000000000000' });
    assert.equal(report.isError, true, 'showing takes no approval');
    const stray = await call({ setRule: { account: 'acme/slack', acts: ['reply'], conversaton: 'C0GENERAL' } });
    assert.equal(stray.isError, true, 'a misspelt key inside a rule is refused, not dropped');
    const unknown = await call({ setRule: { account: 'acme/slack', acts: ['shout'] } });
    assert.equal(unknown.isError, true);
    for (const args of [
      ['behaviour', 'allow', 'acme/slack', 'reply,shout'],
      ['behaviour', 'allow', 'acme/slack'],
      ['behaviour', 'allow', 'acme/slack', 'reply', 'extra'],
      ['behaviour', 'allow', 'acme/slack', 'reply', '--kinds', 'post'],
      ['behaviour', 'clear'],
      ['behaviour', 'forbid', 'acme/slack'],
      ['behaviour', '--approval', 'ap_00000000000000000000000000'],
    ]) {
      const wrong = cli(m, args);
      assert.equal(wrong.status, 64, `${args.join(' ')}: ${wrong.stderr}`);
    }
    // `--conversation` is behaviour's as much as label's, and still no other command's.
    const elsewhere = cli(m, ['paths', '--conversation', 'C0GENERAL']);
    assert.equal(elsewhere.status, 64, elsewhere.stderr);
  } finally {
    await close();
  }
});

// ── The doctor ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Gmail and Slack registered with Claude Code by npx, pinned to these releases — never started. */
function register(m: Machine, gmail: string, slackVersion: string): string {
  const claude = knownClientConfigs(m.env).find((file) => file.client === 'claude-code')?.path;
  assert.ok(claude);
  mkdirSync(dirname(claude), { recursive: true });
  const servers = {
    gmail: { command: 'npx', args: ['-y', `@agentcomms/gmail-mcp@${gmail}`, '--inbox', 'acme/gmail'] },
    slack: { command: 'npx', args: ['-y', `@agentcomms/slack@${slackVersion}`, 'mcp', '--workspace', 'acme/slack'] },
  };
  writeFileSync(claude, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return claude;
}

const BEHAVIOUR_ROWS = ['behaviour rules', 'orphaned behaviour rules', 'behaviour enforcement'];

test("doctor's three rows: unreadable rules, orphaned rules, and servers below 0.22.0 while any rule exists", async () => {
  // None of them on a machine with no rule, even with an old server registered: nothing is there to enforce.
  const quiet = machine();
  register(quiet, '0.21.0', '0.21.0');
  const before = await doctor(quiet.core, quiet.env, { keyring: null });
  assert.deepEqual(
    before.checks.filter((check) => BEHAVIOUR_ROWS.includes(check.name)),
    [],
    JSON.stringify(before.checks),
  );

  const m = machine({
    rules: [
      { account: 'acme/gmail', acts: 'send' },
      { account: 'acme/slack', accountId: 'acc_GONEGONEGONEGONE', acts: ['reply'] },
      { account: 'old/gmail', accountId: 'ibx_GONEGONEGONEGONE', acts: [] },
    ],
  });
  // Gmail behind the release that enforces, Slack at it — a prerelease of it counts as it.
  register(m, '0.21.0', '0.22.0-behaviour-rules');
  const report = await doctor(m.core, m.env, { keyring: null });
  const row = (name: string) => {
    const found = report.checks.find((check) => check.name === name);
    assert.ok(found, `${name}: ${JSON.stringify(report.checks)}`);
    return found;
  };

  const unreadable = row('behaviour rules');
  assert.equal(unreadable.ok, false, 'an account that allows nothing until it is corrected is a failure');
  assert.match(unreadable.detail, /rule 1 has no list of acts/);
  assert.match(unreadable.detail, /acme\/gmail allows nothing/);
  assert.match(unreadable.fix ?? '', /config\.json/);

  const orphaned = row('orphaned behaviour rules');
  assert.equal(orphaned.ok, true);
  assert.equal(orphaned.warn, true);
  assert.match(orphaned.detail, /acme\/slack[^;]*applies by name to acme\/slack/);
  assert.match(orphaned.detail, /old\/gmail[^;]*no account connected now/);

  const enforcement = row('behaviour enforcement');
  assert.equal(enforcement.ok, true);
  assert.equal(enforcement.warn, true);
  assert.match(enforcement.detail, /Gmail[^;]*0\.21\.0/);
  assert.doesNotMatch(enforcement.detail, /Slack/, 'a server at the release that enforces is not named');
  assert.match(enforcement.fix ?? '', /update/);
  assert.match(enforcement.fix ?? '', /restart/);
});

/*
 * A registration that names no release — `npx @agentcomms/gmail-mcp`, `@latest`, a hand-written command — may start
 * any release, an older one too. Counted as enforcing, it hid exactly the server that may not: so it is named, in
 * words of its own (lead's call, after review).
 */
test('doctor names a server whose release cannot be read as one that may enforce no rule', async () => {
  const m = machine({ rules: [{ account: 'acme/gmail', accountId: inbox.id, acts: ['reply'] }] });
  const claude = knownClientConfigs(m.env).find((file) => file.client === 'claude-code')?.path;
  assert.ok(claude);
  mkdirSync(dirname(claude), { recursive: true });
  const servers = {
    gmail: { command: 'npx', args: ['-y', '@agentcomms/gmail-mcp', '--inbox', 'acme/gmail'] },
    slack: { command: 'npx', args: ['-y', '@agentcomms/slack@latest', 'mcp', '--workspace', 'acme/slack'] },
  };
  writeFileSync(claude, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  const report = await doctor(m.core, m.env, { keyring: null });
  const enforcement = report.checks.find((check) => check.name === 'behaviour enforcement');
  assert.ok(enforcement, JSON.stringify(report.checks));
  assert.equal(enforcement.warn, true);
  assert.match(
    enforcement.detail,
    /Gmail server[^;]*names no release that can be read, so it may enforce no behaviour rule/,
  );
  assert.match(enforcement.detail, /Slack server[^;]*names no release that can be read/);
});

/*
 * A rule's conversation is the file's own words, and the conversation grammar lets an escape sequence through in an
 * address's local part: the report printed it raw, at the terminal of the person reading what an agent may do.
 */
test('the behaviour report shows a hand-edited rule made safe: no escape sequence reaches the terminal', () => {
  const m = machine({
    rules: [
      { account: 'acme/gmail', accountId: inbox.id, conversation: '\u001b[2J\u001b[31mx@client.test', acts: [] },
      {
        account: 'acme/gmail',
        accountId: 'ibx_GONEGONEGONEGONE',
        conversation: '\u001b]0pwned\u0007@a.test',
        acts: [],
      },
    ],
  });
  const shown = cli(m, ['behaviour']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(!shown.stdout.includes('\u001b'), JSON.stringify(shown.stdout));
  assert.ok(!shown.stdout.includes('\u0007'), JSON.stringify(shown.stdout));
  assert.match(shown.stdout, /in [^\n]*x@client\.test: nothing/);
  assert.match(shown.stdout, /not connected now[\s\S]*acme\/gmail in [^\n]*pwned[^\n]*@a\.test: nothing/);
});

// ── A person at a terminal ────────────────────────────────────────────────────────────────────────────────────────

/** Streams that are a terminal, whose person answers `answer` when asked to apply a change. */
function terminal(answer: string) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let shown = '';
  stdout.on('data', (chunk) => {
    shown += String(chunk);
  });
  stderr.on('data', (chunk) => {
    if (/to apply this change/.test(String(chunk))) stdin.write(`${answer}\n`);
  });
  return { streams: { stdin, stdout, stderr } as unknown as Streams, shown: () => shown };
}
