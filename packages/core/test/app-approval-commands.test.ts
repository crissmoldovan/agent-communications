import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentLabelOf } from '../src/agent-label.ts';
import { stateOf } from '../src/approval-stored.ts';
import type { Config } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { DESKTOP_RELEASE_IDENTIFIER, type DesktopOrigin } from '../src/desktop-origin.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { type MainRun, runMain } from './helpers/main-in-process.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.34.0 (design 2026-10-26-desktop-0340 §3, B1 and B2): the desktop app approves the agent label and what agents may do
 * as the person's own act, as it has approved adding a server to an app since 0.32.0. `label word|name|rule add|rule
 * remove|icon|style` and `behaviour allow|clear` take `--app-approval <id>`: a loosening the app prepared is approved
 * there — on macOS only when the app itself started the command — and applied; a tightening applies at once, and is
 * never approved in the app. Everything else about `--app-approval` is as it was: never with `--approval`, refused to an
 * agent's shell and inside an MCP server's process, and sent to the terminal where nothing attests the app.
 *
 * Each command is run as the app runs it — core's own CLI, in this process, with `--json`, no terminal and no agent's
 * marker — with the origin check handed in (`main`'s `appOrigin`): a test is never the signed app, and no real codesign
 * is asked. Every machine is a temporary home with synthetic accounts.
 */

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

/** The release app, attested as the process that started the command. */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: DESKTOP_RELEASE_IDENTIFIER,
});
/** Windows and Linux: nothing attests the app. */
const UNATTESTED = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'unattested-platform' });
/** macOS, a parent that is not Agent Comms. */
const NOT_THE_APP = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'not-agent-comms', parent: 'sh' });

interface Machine {
  core: Core;
  /** The command as the app runs it: `--json`, with the origin `origin` says and the environment's extras. */
  run: (
    words: readonly string[],
    options?: { origin?: () => Promise<DesktopOrigin>; extra?: Record<string, string> },
  ) => Promise<MainRun>;
}

/** A home of its own, a mailbox and a workspace, and the change policy `confirm`, the strictest. */
function machine(config: Record<string, unknown> = {}): Machine {
  const home = tempDir('comms-app-approve-');
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const body = {
    version: 2,
    defaults: { changePolicy: 'confirm' },
    inboxes: { 'acme/gmail': inbox },
    accounts: { 'acme/slack': slack },
    ...config,
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
  const core = openCore({ env, caller: CORE_CALLER });
  return {
    core,
    run: (words, options = {}) =>
      runMain(
        [...words, '--json'],
        { ...env, ...options.extra },
        process.platform,
        options.origin === undefined ? {} : { appOrigin: options.origin },
      ),
  };
}

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

const envelope = (run: MainRun): Envelope => run.json() as unknown as Envelope;

/** Prepares the change as the app does, with no approval: exit 10 and the approval it waits on. */
async function prepare(m: Machine, words: readonly string[]): Promise<string> {
  const asked = await m.run(words);
  assert.equal(asked.code, 10, asked.stdout + asked.stderr);
  const error = envelope(asked).error;
  assert.equal(error?.code, 'APPROVAL_PENDING', asked.stdout);
  return String(error?.details?.approvalId);
}

/** The one approval there is: its state, and how it was approved. */
async function standing(core: Core, approvalId: string): Promise<{ state: string; via: string | undefined }> {
  const record = (await core.approvals.list()).find((one) => one.form === 'v2' && one.record.approvalId === approvalId);
  assert.ok(record, `approval ${approvalId} is there`);
  return { state: stateOf(record), via: record.form === 'v2' ? record.record.approvedVia : undefined };
}

async function auditOf(core: Core, operation: string): Promise<Record<string, unknown>[]> {
  const lines = (await core.audit.tail({ limit: 500 })) as unknown as Record<string, unknown>[];
  return lines.filter((line) => line.operation === operation);
}

interface Loosening {
  title: string;
  config?: Record<string, unknown>;
  words: readonly string[];
  /** What the configuration says once the change is applied. */
  applied: (config: Config) => void;
  /** The same command, the other way: it only takes away, and applies at once. */
  tightening?: { words: readonly string[]; applied: (config: Config) => void };
}

const label = (config: Config) => agentLabelOf(config);

const LOOSENINGS: readonly Loosening[] = [
  {
    title: 'label word',
    words: ['label', 'word', 'assistant'],
    applied: (config) => assert.equal(label(config)?.word, 'assistant'),
  },
  {
    title: 'label name',
    words: ['label', 'name', 'Jo Example'],
    applied: (config) => assert.equal(label(config)?.name, 'Jo Example'),
  },
  {
    title: 'label rule add',
    words: ['label', 'rule', 'add', 'acme/slack', '--as', 'me'],
    applied: (config) =>
      assert.deepEqual(
        label(config)?.rules?.map((rule) => rule.as),
        ['me'],
      ),
    tightening: {
      words: ['label', 'rule', 'add', 'acme/slack', '--as', 'agent'],
      applied: (config) =>
        assert.deepEqual(
          label(config)?.rules?.map((rule) => rule.as),
          ['agent'],
        ),
    },
  },
  {
    title: 'label rule remove',
    config: {
      agentLabel: {
        rules: [
          { account: 'acme/slack', accountId: slack.id, as: 'agent' },
          { account: 'acme/gmail', accountId: inbox.id, as: 'me' },
        ],
      },
    },
    words: ['label', 'rule', 'remove', 'acme/slack', '--as', 'agent'],
    applied: (config) =>
      assert.deepEqual(
        label(config)?.rules?.map((rule) => `${rule.account} ${rule.as}`),
        ['acme/gmail me'],
      ),
    tightening: {
      words: ['label', 'rule', 'remove', 'acme/gmail', '--as', 'me'],
      applied: (config) =>
        assert.deepEqual(
          label(config)?.rules?.map((rule) => `${rule.account} ${rule.as}`),
          ['acme/slack agent'],
        ),
    },
  },
  {
    title: 'label icon',
    words: ['label', 'icon', 'acme/slack', ':robot_face:'],
    applied: (config) => assert.deepEqual(label(config)?.slackIcons, { [slack.id]: ':robot_face:' }),
  },
  {
    title: 'label style',
    words: ['label', 'style', 'acme/slack', 'labelled'],
    applied: (config) => assert.deepEqual(label(config)?.slackStyles, { [slack.id]: 'labelled' }),
    tightening: {
      // From labelled, as the loosening above left it in another machine: back to the app applies at once.
      words: ['label', 'style', 'acme/slack', 'app'],
      applied: (config) => assert.notEqual(label(config)?.slackStyles?.[slack.id], 'labelled'),
    },
  },
  {
    title: 'behaviour allow',
    config: { behaviour: { rules: [{ account: 'acme/slack', accountId: slack.id, acts: ['reply'] }] } },
    words: ['behaviour', 'allow', 'acme/slack', 'reply,post'],
    applied: (config) =>
      assert.deepEqual((config.behaviour as { rules: { acts: string[] }[] }).rules[0]?.acts.sort(), ['post', 'reply']),
    tightening: {
      words: ['behaviour', 'allow', 'acme/slack', 'none'],
      applied: (config) => assert.deepEqual((config.behaviour as { rules: { acts: string[] }[] }).rules[0]?.acts, []),
    },
  },
  {
    title: 'behaviour clear',
    config: {
      behaviour: {
        rules: [
          { account: 'acme/slack', accountId: slack.id, acts: ['reply'] },
          { account: 'acme/slack', accountId: slack.id, conversation: 'C0GENERAL', acts: ['reply'] },
        ],
      },
    },
    words: ['behaviour', 'clear', 'acme/slack'],
    applied: (config) =>
      assert.deepEqual(
        (config.behaviour as { rules: { conversation?: string }[] }).rules.map((rule) => rule.conversation),
        ['C0GENERAL'],
      ),
    tightening: {
      // The conversation falls back to the account's own reply: nothing widens.
      words: ['behaviour', 'clear', 'acme/slack', '--conversation', 'C0GENERAL'],
      applied: (config) =>
        assert.deepEqual(
          (config.behaviour as { rules: { conversation?: string }[] }).rules.map((rule) => rule.conversation),
          [undefined],
        ),
    },
  },
];

for (const loosening of LOOSENINGS) {
  test(`${loosening.title}: a loosening the app prepared is approved in the app, and refused anywhere else`, async () => {
    const m = machine(loosening.config);
    const before = JSON.stringify(await m.core.config.load());
    const approvalId = await prepare(m, loosening.words);
    const app = [...loosening.words, '--app-approval', approvalId];

    // Never with --approval beside it.
    const both = await m.run([...app, '--approval', approvalId], { origin: ATTESTED });
    assert.equal(both.code, 64, both.stdout);
    assert.equal(envelope(both).error?.code, 'USAGE');

    // An agent's shell, and a process an MCP server started: refused before the approval is touched.
    for (const extra of [{ CLAUDECODE: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { AGENTCOMMS_MCP_SERVER: 'core' }]) {
      const refused = await m.run(app, { origin: ATTESTED, extra });
      assert.equal(refused.code, 10, `${JSON.stringify(extra)}: ${refused.stdout}`);
      assert.equal(envelope(refused).error?.code, 'APPROVAL_REQUIRED');
      assert.match(String(envelope(refused).error?.message), /only a person can approve a change in the app/u);
    }

    // macOS, started by something that is not the app.
    const stranger = await m.run(app, { origin: NOT_THE_APP });
    assert.equal(stranger.code, 10, stranger.stdout);
    assert.equal(envelope(stranger).error?.details?.reason, 'not-agent-comms');

    // Windows and Linux: nothing attests the app, so the person approves it at their terminal, with these words.
    const elsewhere = await m.run(app, { origin: UNATTESTED });
    assert.equal(elsewhere.code, 10, elsewhere.stdout);
    const error = envelope(elsewhere).error;
    assert.equal(error?.code, 'APPROVAL_REQUIRED');
    assert.equal(error?.details?.reason, 'ORIGIN_UNATTESTED');
    assert.match(String(error?.message), /nothing on this platform attests that the Agent Comms app started this/u);
    // The hint names the command that was run, without the app's approval — not "the same mcp install".
    const hint = String(error?.hint);
    assert.match(hint, /In the app, press Approve in Terminal; or run `.+`( \(PowerShell\))? at your own terminal\./u);
    assert.ok(hint.includes(loosening.words.slice(0, 2).join(' ')), hint);
    assert.ok(!hint.includes('--app-approval') && !hint.includes('mcp install'), hint);
    const unattested = (await auditOf(m.core, 'change.approve')).filter(
      (line) => line.approvedBy === 'desktop-app (unattested)',
    );
    assert.deepEqual(
      unattested.map((line) => line.outcome),
      ['refused'],
    );

    // Nothing was approved or changed by any of them.
    assert.deepEqual(await standing(m.core, approvalId), { state: 'pending', via: undefined });
    assert.equal(JSON.stringify(await m.core.config.load()), before);

    // The app itself, attested: approved there, applied, and audited as the person's act in the app.
    const done = await m.run(app, { origin: ATTESTED });
    assert.equal(done.code, 0, done.stdout + done.stderr);
    const result = envelope(done);
    assert.equal(result.ok, true);
    assert.equal(result.data?.changed, true);
    loosening.applied(await m.core.config.load());
    assert.deepEqual(await standing(m.core, approvalId), { state: 'used', via: 'app' });
    const approved = (await auditOf(m.core, 'change.approve')).find((line) => line.outcome === 'ok');
    assert.equal(approved?.approvedBy, 'desktop-app');
    assert.equal(approved?.surface, 'app');
    assert.equal(approved?.approvalId, approvalId);

    // Spent: the same approval applies nothing a second time.
    const again = await m.run(app, { origin: ATTESTED });
    assert.notEqual(again.code, 0, again.stdout);
  });
}

for (const loosening of LOOSENINGS.filter((one) => one.tightening !== undefined)) {
  const tightening = loosening.tightening as NonNullable<Loosening['tightening']>;
  test(`${loosening.title}: a tightening applies at once, and the app's approval is refused for it, approving nothing`, async () => {
    // label style's tightening starts from labelled: what its loosening leaves.
    const m = machine(
      loosening.title === 'label style'
        ? { agentLabel: { slackStyles: { [slack.id]: 'labelled' } } }
        : loosening.config,
    );
    const before = JSON.stringify(await m.core.config.load());
    // An approval waiting for something else, which an app call for the tightening must leave as it is.
    const waiting = await prepare(m, ['label', 'word', 'twin']);

    const flagged = await m.run([...tightening.words, '--app-approval', waiting], { origin: ATTESTED });
    assert.equal(flagged.code, 64, flagged.stdout);
    assert.equal(envelope(flagged).error?.code, 'USAGE');
    assert.match(String(envelope(flagged).error?.message), /needs no approval/u);
    assert.equal(JSON.stringify(await m.core.config.load()), before, 'refused: nothing was applied');
    assert.deepEqual(await standing(m.core, waiting), { state: 'pending', via: undefined });

    // Without it, as the app runs a tightening: applied at once, asking nobody.
    const atOnce = await m.run(tightening.words);
    assert.equal(atOnce.code, 0, atOnce.stdout + atOnce.stderr);
    assert.equal(envelope(atOnce).data?.changed, true);
    tightening.applied(await m.core.config.load());
    assert.equal((await m.core.approvals.list()).length, 1, 'nothing more was prepared');
  });
}

test('--app-approval is refused on every command the app does not approve with it, and on a report', async () => {
  const m = machine();
  const id = 'ap_0123456789ABCDEFGHJKMNPQRS';
  for (const words of [
    ['label'],
    ['behaviour'],
    ['policy', 'chat'],
    ['attach', 'roots', 'add', '/example/home/folder'],
    ['standing', 'off'],
    ['update', '--check'],
    ['update', '--status'],
    ['update', '--rollback'],
    ['update', '--level', 'never'],
    ['update', '--pause', '7'],
    ['mcp', 'prune'],
  ]) {
    const run = await m.run([...words, '--app-approval', id], { origin: ATTESTED });
    assert.equal(run.code, 64, `${words.join(' ')}: ${run.stdout}`);
    assert.equal(envelope(run).error?.code, 'USAGE', words.join(' '));
  }
  assert.deepEqual(await m.core.approvals.list(), []);
});
