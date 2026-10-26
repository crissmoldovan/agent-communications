import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stateOf } from '../src/approval-stored.ts';
import { type GatedChange, gatedChangeAtTerminal } from '../src/change-flow.ts';
import type { AccountConfig, SendPolicy } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { ensureSendEpochConfig } from '../src/send-epoch.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * 0.32.0 (design 2026-10-26-owner-feedback-0320 §3.3, §4, §5 question 3): adding a server to an app is approved in the
 * desktop app, as the person's own act — the change's approval answered through the app channel, as judge setup's are
 * (events design D2's note of 2026-10-26). `mcp install --app-approval <id>` approves the change the app prepared, with
 * `approvedVia: 'app'`, and applies it; it is refused to an agent's shell and inside an MCP server's process, and it
 * changes nothing but the one change it was prepared for.
 */

const ACME = 'acc_AAAAAAAAAAAAAAAA';

function account(sendPolicy: SendPolicy): AccountConfig {
  return {
    id: ACME,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_AAAA',
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: `slack/token/${ACME}`,
    createdAt: '2026-09-20T00:00:00.000Z',
    sendPolicy,
  };
}

/** A config on disk with one account under `sendPolicy`, and the change policy `confirm`, the strictest. */
function coreWith(sendPolicy: SendPolicy): { core: Core } {
  const dir = tempDir();
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify({ version: 2, defaults: { changePolicy: 'confirm' }, accounts: { 'acme/slack': account(sendPolicy) } }, null, 2)}\n`,
  );
  const core = openCore({ env: { AGENT_COMMS_CONFIG_DIR: dir, HOME: dir, USERPROFILE: dir }, caller: CORE_CALLER });
  return { core };
}

/** Moves acme/slack's send policy to `to`, through the store, with whatever consent the flow hands over. */
function setSendPolicy(core: Core, to: SendPolicy): GatedChange<SendPolicy> {
  return {
    plan: (config) => {
      const after = structuredClone(config);
      (after.accounts['acme/slack'] as AccountConfig).sendPolicy = to;
      return { account: 'acme/slack', before: config, after, summary: `acme/slack posts under ${to}` };
    },
    apply: async (consent) => {
      await ensureSendEpochConfig(core);
      const written = await core.config.update(
        (config) => {
          (config.accounts['acme/slack'] as AccountConfig).sendPolicy = to;
          return config;
        },
        consent ? { consent } : {},
      );
      return (written.accounts['acme/slack'] as AccountConfig).sendPolicy as SendPolicy;
    },
  };
}

const policyNow = async (core: Core) => ((await core.config.load()).accounts['acme/slack'] as AccountConfig).sendPolicy;

/** The words the desktop app runs a change with: `--json`, no terminal, and no agent's marker. */
const APP = { channel: 'core', env: {}, output: { json: true, color: false }, rerun: ['policy', 'chat'] };

/** Prepares `change` as the desktop app does, and gives back the approval it is waiting on. */
async function prepared(core: Core, change: GatedChange<SendPolicy>): Promise<string> {
  let approvalId = '';
  await assert.rejects(gatedChangeAtTerminal(core, change, APP), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'APPROVAL_PENDING');
    approvalId = String((error.details as { approvalId?: string }).approvalId);
    return true;
  });
  return approvalId;
}

/** Every audit line written so far. */
async function auditLines(core: Core): Promise<Record<string, unknown>[]> {
  return (await core.audit.tail({ limit: 500 })) as unknown as Record<string, unknown>[];
}

test('a change the app prepared is approved in the app, under confirm, and applied: approved via the app', async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  assert.equal(await policyNow(core), 'never', 'nothing changed while it waited');

  assert.equal(await gatedChangeAtTerminal(core, change, { ...APP, appApproval: approvalId }), 'chat');
  assert.equal(await policyNow(core), 'chat');
  const [record] = await core.approvals.list();
  assert.ok(record);
  assert.equal(stateOf(record), 'used', 'claimed once, by the change it was prepared for');
  assert.equal(record.form, 'v2', 'a record this release reads, not a corrupt one');
  assert.equal(record.form === 'v2' ? record.record.approvedVia : undefined, 'app');

  // The audit says who approved it, and where: the person, in the desktop app.
  const approve = (await auditLines(core)).find((line) => line.operation === 'change.approve' && line.outcome === 'ok');
  assert.ok(approve, 'the approval is audited');
  assert.equal(approve.surface, 'app');
  assert.equal(approve.approvedBy, 'desktop-app');
  assert.equal(approve.approvalId, approvalId);
  const claim = (await auditLines(core)).find((line) => line.operation === 'change.claim' && line.outcome === 'ok');
  assert.ok(claim);
  assert.equal(claim.reason, 'approved in the desktop app');

  // Spent: the same approval does not apply anything a second time.
  await assert.rejects(gatedChangeAtTerminal(core, change, { ...APP, appApproval: approvalId }), CommsError);
});

test("an app approval is refused to an agent's shell and inside an MCP server's process, and approves nothing", async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  for (const env of [{ CLAUDECODE: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { AGENTCOMMS_MCP_SERVER: 'events' }]) {
    await assert.rejects(
      gatedChangeAtTerminal(core, change, { ...APP, env, appApproval: approvalId }),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'APPROVAL_REQUIRED', JSON.stringify(env));
        assert.match(error.message, /only a person can approve a change in the app/);
        return true;
      },
    );
  }
  assert.equal(await policyNow(core), 'never');
  const [record] = await core.approvals.list();
  assert.equal(record && stateOf(record), 'pending', 'still waiting for the person');
  assert.ok(
    (await auditLines(core)).some((line) => line.operation === 'change.approve' && line.outcome === 'refused'),
    'the refusal is audited',
  );
  // And it is never carried with an approval of its own.
  await assert.rejects(
    gatedChangeAtTerminal(core, change, { ...APP, approvalId, appApproval: approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('an app approval spends only the change it was prepared for: another change voids it, and writes nothing', async () => {
  const { core } = coreWith('never');
  const approvalId = await prepared(core, setSendPolicy(core, 'chat'));
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'confirm'), { ...APP, appApproval: approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
  );
  assert.equal(await policyNow(core), 'never');
  const [record] = await core.approvals.list();
  assert.equal(record && stateOf(record), 'revoked');
});

test('only a change is approved through the app channel: a send is not', async () => {
  const { core } = coreWith('never');
  await assert.rejects(
    core.approvals.approve('ap_0123456789ABCDEFGHJKMNPQRS', 'app', { draftMessageId: 'x', contentDigest: 'x' }, 'x'),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
  );
});

// ── The command the desktop app runs ──────────────────────────────────────────────────────────────────────────

const NOT_ON_WINDOWS =
  process.platform === 'win32'
    ? { skip: 'the stand-in client is a script, which Windows cannot spawn without a shell' }
    : {};
const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const NODE_FLAGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

/** A home of its own, a PATH holding only a stand-in `claude` that records what it is asked, and nothing else. */
function machine() {
  const home = tempDir('comms-app-approval-');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    PATH: bin,
    AGENT_COMMS_CONFIG_DIR: configDir,
    NO_COLOR: '1',
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const log = join(bin, 'claude.log');
  writeFileSync(
    join(bin, 'claude'),
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');\n`,
  );
  chmodSync(join(bin, 'claude'), 0o755);
  const asked = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], {
      encoding: 'utf8',
      env: { ...env, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), ...extra },
    });
    return { ...result, json: () => JSON.parse(result.stdout.trim().split('\n')[0] ?? '') };
  };
  return { asked, run, core: () => openCore({ env, caller: CORE_CALLER }) };
}

test(
  '`mcp install --app-approval <id>` approves the install the app prepared, in the app, and registers it',
  NOT_ON_WINDOWS,
  async () => {
    const m = machine();
    const words = ['mcp', 'install', '--client', 'claude-code', '--launcher', 'local', '--no-verify'];
    const asked = m.run([...words, '--json']);
    assert.equal(asked.status, 10, asked.stderr);
    const { approvalId, preview } = asked.json().error.details as { approvalId: string; preview: string };
    assert.match(preview, /registers the agentcomms \(core\) MCP server with claude-code/);
    assert.deepEqual(m.asked(), []);

    // An agent's shell cannot answer it, nor a process an MCP server started: exit 10, and nothing registered.
    for (const marker of [{ CLAUDECODE: '1' }, { AGENTCOMMS_MCP_SERVER: 'events' }]) {
      const refused = m.run([...words, '--app-approval', approvalId, '--json'], marker);
      assert.equal(refused.status, 10, refused.stdout);
      assert.equal(refused.json().error.code, 'APPROVAL_REQUIRED');
    }
    assert.deepEqual(m.asked(), []);

    const done = m.run([...words, '--app-approval', approvalId, '--json']);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(done.json().data.applied, true);
    assert.equal(m.asked().length, 1, 'registered once');
    const [record] = await m.core().approvals.list();
    assert.equal(record?.form === 'v2' ? record.record.approvedVia : undefined, 'app');

    // Never alongside --approval.
    const both = m.run([...words, '--app-approval', approvalId, '--approval', approvalId, '--json']);
    assert.equal(both.status, 64, both.stdout);
  },
);
