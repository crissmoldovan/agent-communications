import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { doctor } from '../src/operations/maintenance.ts';
import { listTakes } from '../src/operations/takes.ts';
import type { TakeHolder } from '../src/takes.ts';
import { runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Taking messages, core's operations (design 2026-10-26-taking-messages §5, §10, §11 "Person-only"): `agentcomms
 * taking` and `comms_taking`, one operation each way, judged by the change flow; and `agentcomms takes
 * list|release|give|keep`, the person's alone — refused inside an MCP server's process and in an agent's shell.
 *
 * Every test runs against a temporary home and config directory, with synthetic accounts; nothing reads the real ones
 * and nothing talks to a channel.
 */

const CREATED = '2026-09-20T00:00:00.000Z';
const GMAIL_ID = 'ibx_AAAAAAAAAAAAAAAA';
const SLACK_ID = 'acc_AAAAAAAAAAAAAAAA';
const inbox = {
  id: GMAIL_ID,
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'send',
  contacts: false,
  grantedScopes: [],
  secretRef: `gmail:refresh:${GMAIL_ID}`,
  internalDomains: ['acme.test'],
  createdAt: CREATED,
};
const slack = {
  id: SLACK_ID,
  platform: 'slack',
  workspace: 'T_ACME',
  userId: 'U_AAAA',
  tier: 'send',
  mode: 'send',
  grantedScopes: [],
  secretRef: `slack:token:${SLACK_ID}`,
  createdAt: CREATED,
};

const HOLDER: TakeHolder = {
  key: 'aaaaaaaaaaaaaaaa',
  grouped: true,
  process: 'a1a1a1a1a1a1',
  sessionId: null,
  parent: null,
  folder: '/example/home/work/acme-site',
  client: { name: 'claude-code', version: '2.1.0' },
};
const SLACK_MESSAGE = 'C0123/1729936800.000100';

interface Machine {
  env: Record<string, string>;
  core: Core;
  configFile: string;
}

function machine(taking?: unknown): Machine {
  const home = tempDir('comms-takes-ops-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const configFile = join(configDir, 'config.json');
  const body = {
    version: 2,
    inboxes: { 'acme/gmail': inbox },
    accounts: { 'acme/slack': slack },
    ...(taking === undefined ? {} : { taking }),
  };
  writeFileSync(configFile, `${JSON.stringify(body, null, 2)}\n`);
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
  return { env, core: openCore({ env, caller: CORE_CALLER }), configFile };
}

const stored = (m: Machine) => (JSON.parse(readFileSync(m.configFile, 'utf8')) as { taking?: unknown }).taking;

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
    (await client.callTool({ name: 'comms_taking', arguments: args })) as ToolResult;
  return { call, close: () => Promise.all([client.close(), server.close()]) };
}

// ── taking / comms_taking ──────────────────────────────────────────────────────────────────────────────────────

test('taking and comms_taking show the same report; requiring a take applies at once from either', async () => {
  const m = machine();
  const { call, close } = await connect(m);
  try {
    const shown = await call();
    assert.notEqual(shown.isError, true, JSON.stringify(shown.structuredContent));
    const byCommand = await runMain(['taking', '--json'], m.env, process.platform);
    assert.equal(byCommand.code, 0, byCommand.stdout + byCommand.stderr);
    assert.deepEqual((byCommand.json() as { data: unknown }).data, shown.structuredContent);
    assert.deepEqual(
      ((shown.structuredContent?.accounts ?? []) as { account: string; required: boolean }[]).map((a) => [
        a.account,
        a.required,
      ]),
      [
        ['acme/gmail', false],
        ['acme/slack', false],
      ],
    );

    const on = await runMain(['taking', 'acme/slack', '--require', 'on', '--json'], m.env, process.platform);
    assert.equal(on.code, 0, on.stdout + on.stderr);
    assert.equal((on.json() as { data: { changed: boolean } }).data.changed, true);
    const byTool = await call({ account: 'acme/gmail', required: true });
    assert.equal(byTool.structuredContent?.applied, true, JSON.stringify(byTool.structuredContent));
    assert.deepEqual(stored(m), {
      accounts: [
        {
          accountId: SLACK_ID,
          account: 'acme/slack',
          required: true,
          acknowledge: 'nothing',
          unclaimed: { afterMinutes: 15, notify: true },
        },
        {
          accountId: GMAIL_ID,
          account: 'acme/gmail',
          required: true,
          acknowledge: 'nothing',
          unclaimed: { afterMinutes: 15, notify: true },
        },
      ],
    });
    // Reminders apply at once, whichever way.
    const later = await call({ account: 'acme/slack', afterMinutes: 240 });
    assert.equal(later.structuredContent?.applied, true, JSON.stringify(later.structuredContent));
    const quiet = await runMain(['taking', 'acme/slack', '--notify', 'off', '--json'], m.env, process.platform);
    assert.equal(quiet.code, 0, quiet.stdout + quiet.stderr);
  } finally {
    await close();
  }
});

test('letting sessions act without taking, and a 👀 on taking, wait for the person; the claim applies it', async () => {
  const m = machine({ accounts: [{ accountId: SLACK_ID, account: 'acme/slack', required: true }] });
  const { call, close } = await connect(m);
  try {
    const asked = await call({ account: 'acme/slack', required: false });
    assert.equal(asked.structuredContent?.approvalRequired, true, JSON.stringify(asked.structuredContent));
    assert.match(String(asked.structuredContent?.preview), /without taking them first/);
    const pending = await runMain(['taking', 'acme/slack', '--require', 'off', '--json'], m.env, process.platform);
    assert.equal(pending.code, 10, pending.stdout + pending.stderr);
    assert.equal((pending.json() as { error: { code: string } }).error.code, 'APPROVAL_PENDING');
    const claimed = await call({
      account: 'acme/slack',
      required: false,
      approvalId: asked.structuredContent?.approvalId,
    });
    assert.equal(claimed.structuredContent?.applied, true, JSON.stringify(claimed.structuredContent));
    assert.equal(
      (stored(m) as { accounts: { required: boolean }[] }).accounts[0]?.required,
      false,
      'written once approved',
    );

    const eyes = await call({ account: 'acme/slack', acknowledge: 'eyes' });
    assert.equal(eyes.structuredContent?.approvalRequired, true, JSON.stringify(eyes.structuredContent));
    const done = await call({
      account: 'acme/slack',
      acknowledge: 'eyes',
      approvalId: eyes.structuredContent?.approvalId,
    });
    const result = done.structuredContent?.result as { note: string | null };
    assert.match(result.note ?? '', /standing approval/);
    // Saying nothing applies at once.
    assert.equal((await call({ account: 'acme/slack', acknowledge: 'nothing' })).structuredContent?.applied, true);
  } finally {
    await close();
  }
});

test('a mailbox has no 👀, one change goes at a time, and a report takes no approval', async () => {
  const m = machine();
  const { call, close } = await connect(m);
  try {
    const gmail = await call({ account: 'acme/gmail', acknowledge: 'eyes' });
    assert.equal(gmail.isError, true);
    assert.equal(((gmail.structuredContent?.error ?? {}) as { code?: string }).code, 'USAGE');
    const two = await call({ account: 'acme/slack', required: true, notify: false });
    assert.equal(((two.structuredContent?.error ?? {}) as { code?: string }).code, 'USAGE');
    const noAccount = await call({ required: true });
    assert.equal(((noAccount.structuredContent?.error ?? {}) as { code?: string }).code, 'USAGE');
  } finally {
    await close();
  }
  for (const args of [
    ['taking', 'acme/slack', '--require', 'on', '--notify', 'off'],
    ['taking', '--require', 'on'],
    ['taking', 'acme/slack', '--require', 'maybe'],
    ['taking', 'acme/slack', '--unclaimed', '2'],
    ['taking', 'acme/slack', '--approval', 'ap_00000000000000000000000000'],
    ['behaviour', '--require', 'on'],
    ['takes', 'list', '--window', 'aaaaaaaaaaaaaaaa'],
  ]) {
    const run = await runMain([...args, '--json'], m.env, process.platform);
    assert.equal(run.code, 64, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
  }
  assert.equal(stored(m), undefined, 'nothing was written');
});

// ── takes list|release|give|keep: the person's ────────────────────────────────────────────────────────────────

test('takes list, release, give and keep are refused inside an MCP server and in an agent’s shell, exit 10', async () => {
  const m = machine();
  await m.core.takes.take({ channel: 'slack', accountId: SLACK_ID, id: SLACK_MESSAGE, thread: null }, HOLDER);
  const commands = [
    ['takes', 'list'],
    ['takes', 'release', 'acme/slack', SLACK_MESSAGE],
    ['takes', 'keep', 'acme/slack', SLACK_MESSAGE],
    ['takes', 'give', 'acme/slack', SLACK_MESSAGE, '--window', '11111111-2222-4333-8444-555555555555'],
  ];
  for (const [marker, reason] of [
    [{ AGENTCOMMS_MCP_SERVER: 'slack' }, 'MCP_SERVER_PROCESS'],
    [{ CLAUDECODE: '1' }, 'AGENT_SHELL'],
  ] as const) {
    for (const args of commands) {
      const run = await runMain([...args, '--json'], { ...m.env, ...marker }, process.platform);
      assert.equal(run.code, 10, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
      const refused = run.json() as { error: { code: string; details: { reason: string } } };
      assert.equal(refused.error.code, 'APPROVAL_REQUIRED');
      assert.equal(refused.error.details.reason, reason);
      assert.equal(run.stdout.includes('acme-site'), false, 'nothing is read before the refusal');
    }
  }
  // Untouched: still Alice's.
  const listed = await listTakes(m.core, {}, { env: {} });
  assert.equal(listed.takes[0]?.state, 'taken');
});

test('the person lists every take with its holder, and releases, keeps and gives one', async () => {
  const m = machine();
  const ref = { channel: 'slack' as const, accountId: SLACK_ID, id: SLACK_MESSAGE, thread: null };
  await m.core.takes.take(ref, HOLDER);
  await m.core.takes.handBack(ref, HOLDER, 'not-mine', 'about the billing site', {
    account: 'acme/slack',
    shown: SLACK_MESSAGE,
    act: 'slack.take',
    takeWith: 'slack_take',
  });
  await m.core.takes.take(ref, HOLDER);

  const listed = await runMain(['takes', 'list', '--json'], m.env, process.platform);
  assert.equal(listed.code, 0, listed.stdout + listed.stderr);
  const data = (listed.json() as { data: Awaited<ReturnType<typeof listTakes>> }).data;
  const [take] = data.takes;
  assert.equal(take?.account, 'acme/slack');
  assert.equal(take?.key, `slack:${SLACK_ID}:${SLACK_MESSAGE}`);
  assert.equal(((take?.holder ?? {}) as TakeHolder).folder, HOLDER.folder);
  const note = take?.history.find((line) => line.kind === 'handed-back')?.note ?? '';
  assert.match(note, /^<untrusted-content[\s\S]*about the billing site/);
  const plain = await runMain(['takes', 'list'], m.env, process.platform);
  assert.match(
    plain.stdout,
    /acme\/slack {2}C0123\/1729936800\.000100 {2}taken by the agent in [^\n]*acme-site · claude-code/,
  );
  assert.match(plain.stdout, /handed back once: not-mine/);

  const filtered = await runMain(['takes', 'list', '--state', 'open', '--json'], m.env, process.platform);
  assert.deepEqual((filtered.json() as { data: { takes: unknown[] } }).data.takes, []);

  const released = await runMain(['takes', 'release', 'acme/slack', SLACK_MESSAGE, '--json'], m.env, process.platform);
  assert.equal(released.code, 0, released.stdout + released.stderr);
  assert.equal((released.json() as { data: { state: string } }).data.state, 'open');

  const kept = await runMain(['takes', 'keep', 'acme/slack', SLACK_MESSAGE, '--json'], m.env, process.platform);
  assert.equal((kept.json() as { data: { state: string } }).data.state, 'taken');
  await assert.rejects(m.core.takes.take(ref, HOLDER), { code: 'TAKEN_ELSEWHERE' });

  // A key no window recorded anything under is refused: a typo offers nothing to nobody.
  const typo = await runMain(
    ['takes', 'give', 'acme/slack', SLACK_MESSAGE, '--window', 'bbbbbbbbbbbbbbbb', '--json'],
    m.env,
    process.platform,
  );
  assert.equal(typo.code, 66, typo.stdout + typo.stderr);
  const sid = '11111111-2222-4333-8444-555555555555';
  const given = await runMain(
    ['takes', 'give', 'acme/slack', SLACK_MESSAGE, '--window', sid, '--json'],
    m.env,
    process.platform,
  );
  assert.equal(given.code, 0, given.stdout + given.stderr);
  assert.equal((given.json() as { data: { state: string } }).data.state, 'offered');
  assert.equal((await m.core.takes.take(ref, { ...HOLDER, sessionId: sid })).view?.by, 'you');

  // A message that is not one there.
  const wrong = await runMain(['takes', 'release', 'acme/slack', 'not a message', '--json'], m.env, process.platform);
  assert.equal(wrong.code, 64, wrong.stdout + wrong.stderr);
});

test('doctor says when taking cannot be read, and that every account must take a message first', async () => {
  const m = machine({ accounts: 'all' });
  const report = await doctor(m.core, m.env, { platform: process.platform });
  const check = report.checks.find((each) => each.name === 'taking messages');
  assert.equal(check?.ok, false);
  assert.match(check?.detail ?? '', /every account must take a message first/);
});
