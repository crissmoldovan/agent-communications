import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { asV2, stateOf } from '../src/approval-stored.ts';
import { type Core, openCore } from '../src/core.ts';
import { DESKTOP_RELEASE_IDENTIFIER, type DesktopOrigin } from '../src/desktop-origin.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { type MainRun, runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.34.0 (design 2026-10-26-desktop-0340, B3): `mcp install --client <c> --server <a,b,c>` adds several servers to one
 * client as one change — one plan, one preview naming every server, one approval, then each server registered in
 * order; the first that fails stops the rest, says which went in and which did not, and the approval is not used
 * again. `comms_server_install` takes the same list as `servers`. One server is the install it always was.
 *
 * Nothing here reaches a real client or npm: `claude` is a stand-in on PATH that records what it is asked — and
 * answers "already exists" for the server named in STANDIN_REFUSE — and every server is registered with the `local`
 * launcher, unchecked. The origin of an app approval is handed in; nothing asks codesign.
 */

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in client is a script, which Windows cannot spawn without a shell' }
    : {};

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: DESKTOP_RELEASE_IDENTIFIER,
});

/** The core server, Gmail and the event service: the list the app's Connect Agent Comms… sends. */
const THREE = ['core', 'gmail', 'events'] as const;
const WORDS = [
  'mcp',
  'install',
  '--client',
  'claude-code',
  '--server',
  THREE.join(','),
  '--launcher',
  'local',
  '--no-verify',
];

interface Machine {
  core: Core;
  env: Record<string, string>;
  /** What the stand-in `claude` was asked, one line a call. */
  asked: () => string[];
  run: (
    words: readonly string[],
    options?: { extra?: Record<string, string>; origin?: () => Promise<DesktopOrigin> },
  ) => Promise<MainRun>;
}

function machine(): Machine {
  const home = tempDir('comms-install-several-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 2 }, null, 2)}\n`);
  const log = join(bin, 'claude.log');
  writeFileSync(
    join(bin, 'claude'),
    [
      `#!${process.execPath}`,
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      'const refuse = process.env.STANDIN_REFUSE;',
      "if (refuse && process.argv[3] === 'add-json' && process.argv[4] === refuse) {",
      "  process.stderr.write('MCP server ' + refuse + ' already exists in user config\\n');",
      '  process.exit(1);',
      '}',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  return {
    env,
    core: openCore({ env, caller: CORE_CALLER }),
    asked: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    run: (words, options = {}) =>
      runMain(
        [...words, '--json'],
        { ...env, ...options.extra },
        process.platform,
        options.origin === undefined ? {} : { appOrigin: options.origin },
      ),
  };
}

interface Failure {
  code: string;
  message: string;
  hint?: string;
  details: Record<string, unknown>;
}

const errorOf = (run: MainRun): Failure => run.json().error as Failure;

/** The servers `claude mcp add-json` was asked to add, in order. */
const added = (m: Machine) =>
  m.asked().flatMap((line) => (line.startsWith('mcp add-json ') ? [line.split(' ')[2]] : []));

async function prepare(m: Machine, words: readonly string[] = WORDS): Promise<{ approvalId: string; preview: string }> {
  const asked = await m.run(words);
  assert.equal(asked.code, 10, asked.stdout + asked.stderr);
  const error = errorOf(asked);
  assert.equal(error.code, 'APPROVAL_PENDING');
  return { approvalId: String(error.details.approvalId), preview: String(error.details.preview) };
}

test(
  'one preview names every server and what each reaches, one approval covers all, and each is registered in order',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { approvalId, preview } = await prepare(m);
    assert.match(preview, /Register the agentcomms \(core\), Gmail and events MCP servers with claude-code/u);
    assert.match(
      preview,
      /- agentcomms \(core\): registers the agentcomms \(core\) MCP server with claude-code as "agentcomms"/u,
    );
    assert.match(preview, /- Gmail: registers the Gmail MCP server with claude-code as "gmail"/u);
    assert.match(preview, /- Gmail: not pinned: it reaches every mailbox on this machine, with every tool/u);
    assert.match(preview, /- events: registers the events MCP server with claude-code as "events"/u);
    assert.match(
      preview,
      /- registers them one after another, in the order above, and stops at the first that fails: those after it are not registered, and this approval is not used again/u,
    );
    assert.deepEqual(m.asked(), [], 'nothing was registered while it waited');
    assert.equal((await m.core.approvals.list()).length, 1, 'one approval for the whole list');

    // The person's yes in the chat, claimed by the agent: one claim, three registrations, in the order given.
    const done = await m.run([...WORDS, '--approval', approvalId], { extra: { CLAUDECODE: '1' } });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    const data = done.json().data as { servers: string[]; results: { server: string; applied: boolean }[] };
    assert.deepEqual(data.servers, [...THREE]);
    assert.deepEqual(
      data.results.map((one) => [one.server, one.applied]),
      THREE.map((server) => [server, true]),
    );
    assert.deepEqual(added(m), ['agentcomms', 'gmail', 'events']);
    const [record] = await m.core.approvals.list();
    assert.equal(record && stateOf(record), 'used');
  },
);

test(
  'several servers approved in the app: applied when the app started it, sent to the terminal where nothing attests it',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { approvalId } = await prepare(m);
    const app = [...WORDS, '--app-approval', approvalId];

    const elsewhere = await m.run(app, { origin: async () => ({ ok: false, reason: 'unattested-platform' }) });
    assert.equal(elsewhere.code, 10, elsewhere.stdout);
    const refused = errorOf(elsewhere);
    assert.equal(refused.details.reason, 'ORIGIN_UNATTESTED');
    assert.ok(
      String(refused.hint).includes(
        `mcp install --client claude-code --server ${THREE.join(',')} --launcher local --no-verify`,
      ),
      String(refused.hint),
    );
    assert.ok(!String(refused.hint).includes('--app-approval'), String(refused.hint));
    for (const extra of [{ CLAUDECODE: '1' }, { AGENTCOMMS_MCP_SERVER: 'core' }]) {
      const agent = await m.run(app, { origin: ATTESTED, extra });
      assert.equal(agent.code, 10, agent.stdout);
      assert.equal(errorOf(agent).code, 'APPROVAL_REQUIRED');
    }
    const both = await m.run([...app, '--approval', approvalId], { origin: ATTESTED });
    assert.equal(both.code, 64, both.stdout);
    assert.deepEqual(m.asked(), []);

    const done = await m.run(app, { origin: ATTESTED });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    assert.deepEqual(added(m), ['agentcomms', 'gmail', 'events']);
    const [record] = await m.core.approvals.list();
    assert.equal(record && stateOf(record), 'used');
    assert.equal(record ? asV2(record)?.approvedVia : undefined, 'app');
  },
);

test(
  'the first server that fails stops the rest: it says which went in and which did not, and the approval is spent',
  NOT_ON_WINDOWS,
  async () => {
    for (const how of ['terminal', 'app'] as const) {
      const m = machine();
      const { approvalId } = await prepare(m);
      // Someone else's entry called "gmail", somewhere this could not read: never replaced.
      const extra = { STANDIN_REFUSE: 'gmail', ...(how === 'terminal' ? { CLAUDECODE: '1' } : {}) };
      const words =
        how === 'terminal' ? [...WORDS, '--approval', approvalId] : [...WORDS, '--app-approval', approvalId];
      const stopped = await m.run(words, { extra, ...(how === 'app' ? { origin: ATTESTED } : {}) });
      assert.equal(stopped.code, 78, `${how}: ${stopped.stdout}${stopped.stderr}`);
      const error = errorOf(stopped);
      assert.equal(error.code, 'CONFIG');
      assert.match(error.message, /^stopped at the Gmail server: claude already has an MCP server called "gmail"/u);
      assert.match(
        error.message,
        /Registered with claude-code: agentcomms \(core\); not registered: Gmail and events$/u,
      );
      assert.match(String(error.hint), /The approval was spent on this attempt and is not used again/u);
      assert.deepEqual(error.details.installed, ['core']);
      assert.deepEqual(error.details.notInstalled, ['gmail', 'events']);
      assert.deepEqual(
        (error.details.failed as { server: string; registered: boolean }).server,
        'gmail',
        'it names the one that stopped it',
      );
      assert.equal((error.details.failed as { registered: boolean }).registered, false);
      assert.deepEqual(
        (error.details.results as { server: string }[]).map((one) => one.server),
        ['core'],
      );
      assert.deepEqual(added(m), ['agentcomms', 'gmail'], `${how}: events was never tried`);

      // Spent: not approved and not pending, and the same approval registers nothing more.
      const [record] = await m.core.approvals.list();
      assert.ok(record && !['approved', 'pending'].includes(stateOf(record)), record && stateOf(record));
      const again = await m.run(words, { extra: { CLAUDECODE: how === 'terminal' ? '1' : '' }, origin: ATTESTED });
      assert.notEqual(again.code, 0, again.stdout);
      assert.deepEqual(added(m), ['agentcomms', 'gmail'], 'nothing more was registered');
    }
  },
);

test(
  'a list refuses what names one server, an empty name, a name twice and an unknown server, before anything is prepared',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const base = ['mcp', 'install', '--client', 'claude-code', '--launcher', 'local', '--no-verify'];
    for (const [words, pattern] of [
      [[...base, '--server', 'gmail,slack', '--inbox', 'acme/gmail'], /`inbox` names one server's entry/u],
      [[...base, '--server', 'gmail,slack', '--name', 'mine'], /`name` names one server's entry/u],
      [[...base, '--server', 'gmail,slack', '--read-only'], /`readOnly` names one server's entry/u],
      [[...base, '--server', 'core,'], /a name in the list of servers is empty/u],
      [[...base, '--server', 'core,core'], /"core" is named twice/u],
      [[...base, '--server', 'core,nope'], /"nope" is not a server this can register/u],
    ] as const) {
      const run = await m.run(words);
      assert.equal(run.code, 64, `${words.join(' ')}: ${run.stdout}`);
      assert.match(errorOf(run).message, pattern);
    }
    assert.deepEqual(await m.core.approvals.list(), []);
    assert.deepEqual(m.asked(), []);
    // One server is the install it always was: its own preview, for it alone.
    const single = await prepare(m, [...base, '--server', 'gmail']);
    assert.match(single.preview, /\nRegister the Gmail MCP server with claude-code\n/u);
    assert.doesNotMatch(single.preview, /- Gmail: |one after another/u);
  },
);

test(
  'comms_server_install takes the same list as `servers`: the same preview, one approval, and the same refusals',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const call = async (args: Record<string, unknown>) => {
      const result = (await client.callTool({ name: 'comms_server_install', arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: { text?: string }[];
      };
      return {
        isError: result.isError === true,
        data: result.structuredContent ?? {},
        text: result.content?.[0]?.text,
      };
    };
    try {
      const args = { servers: [...THREE], client: 'claude-code', launcher: 'local', noVerify: true };
      const first = await call(args);
      assert.equal(first.isError, false, first.text);
      assert.equal(first.data.approvalRequired, true);
      const byCommand = await prepare(m);
      const same = (preview: string, id: string) => preview.replaceAll(id, '<id>');
      assert.equal(
        same(String(first.data.preview), String(first.data.approvalId)),
        same(byCommand.preview, byCommand.approvalId),
        'one change, whichever surface prepared it',
      );
      // The approval the tool prepared is claimed by the command, and the other way round.
      const claimed = await m.run([...WORDS, '--approval', String(first.data.approvalId)], {
        extra: { CLAUDECODE: '1' },
      });
      assert.equal(claimed.code, 0, claimed.stdout + claimed.stderr);
      assert.deepEqual(added(m), ['agentcomms', 'gmail', 'events']);

      for (const [wrong, pattern] of [
        [{ ...args, channel: 'core' }, /give one of them/u],
        [{ client: 'claude-code' }, /name the server with `channel`, or several with `servers`/u],
        [{ ...args, inbox: 'acme/gmail' }, /`inbox` names one server's entry/u],
      ] as const) {
        const refused = await call(wrong);
        assert.equal(refused.isError, true, JSON.stringify(wrong));
        assert.match(String(refused.text), pattern);
      }
    } finally {
      await client.close();
    }
  },
);

/*
 * The security review of 0.34.0 (finding 4): the approval is bound to the whole list, in its order. Another order, a
 * subset, a superset or a single install is another change: it is refused, registers nothing, and voids the approval —
 * the same through `--approval` and `--app-approval`, which once left it pending. Each case on a machine of its own.
 */
const MISMATCHES: readonly (readonly [string, string])[] = [
  ['core,gmail,events', 'events,gmail,core'],
  ['core,gmail,events', 'gmail,core,events'],
  ['core,gmail,events', 'core,gmail'],
  ['core,gmail,events', 'core,gmail,events,slack'],
  ['core,gmail,events', 'core'],
  ['core', 'core,gmail'],
];
for (const how of ['approval', 'app-approval'] as const) {
  test(
    `an approval for a list is claimed only for that list, in that order, through --${how}`,
    NOT_ON_WINDOWS,
    async () => {
      const base = ['mcp', 'install', '--client', 'claude-code', '--launcher', 'local', '--no-verify'];
      for (const [prepared, claimed] of MISMATCHES) {
        const m = machine();
        const { approvalId } = await prepare(m, [...base, '--server', prepared]);
        const words = [...base, '--server', claimed, `--${how}`, approvalId];
        const run = await m.run(words, how === 'approval' ? { extra: { CLAUDECODE: '1' } } : { origin: ATTESTED });
        assert.equal(run.code, 10, `${prepared} → ${claimed}: ${run.stdout}`);
        assert.equal(errorOf(run).code, 'APPROVAL_VOID', `${prepared} → ${claimed}`);
        assert.deepEqual(added(m), [], `${prepared} → ${claimed}: nothing was registered`);
        const [record] = await m.core.approvals.list();
        assert.equal(record && stateOf(record), 'revoked', `${prepared} → ${claimed}: void, never left to wait`);
        // Void for the list it was prepared for too.
        const original = [...base, '--server', prepared, `--${how}`, approvalId];
        const after = await m.run(original, how === 'approval' ? { extra: { CLAUDECODE: '1' } } : { origin: ATTESTED });
        assert.notEqual(after.code, 0, after.stdout);
        assert.deepEqual(added(m), [], `${prepared}: nothing was registered with a void approval`);
      }
    },
  );
}
