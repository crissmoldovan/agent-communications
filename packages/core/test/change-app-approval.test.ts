import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stateOf } from '../src/approval-stored.ts';
import { type GatedChange, gatedChange, gatedChangeAtTerminal } from '../src/change-flow.ts';
import type { AccountConfig, SendPolicy } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import type { DesktopOrigin } from '../src/desktop-origin.ts';
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
/** The release app, attested as the process that started this one (`desktopAppOrigin`, injected here). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

/** The words the desktop app runs a change with: `--json`, no terminal, no agent's marker, and the app attested. */
const APP = {
  channel: 'core',
  env: {},
  output: { json: true, color: false },
  rerun: ['policy', 'chat'],
  appOrigin: ATTESTED,
};

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

/** Where an approval stands, read from the store: its state, and how it was approved, if it was. */
async function standing(core: Core): Promise<{ state: string; via: string | undefined }> {
  const [record] = await core.approvals.list();
  assert.ok(record, 'the approval is there');
  return { state: stateOf(record), via: record.form === 'v2' ? record.record.approvedVia : undefined };
}

test('an app approval is checked against this exact change before it is answered: another change leaves it untouched', async () => {
  const { core } = coreWith('never');
  const approvalId = await prepared(core, setSendPolicy(core, 'chat'));
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'confirm'), { ...APP, appApproval: approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(await policyNow(core), 'never');
  assert.deepEqual(await standing(core), { state: 'pending', via: undefined }, 'never answered');
});

/*
 * The release's security review (2026-10-26): `--app-approval` answered any pending change's code first, and planned and
 * claimed after. A call whose plan then refused — a change that needs no approval, `--print`, a plan that throws — left
 * that approval approved, for anything to claim: an agent prepared a loosening over MCP, ran the app's command with its
 * id on a no-op, and claimed it over MCP. Each of these must leave the approval untouched, never approved.
 */
test('review regression: an approval prepared over MCP is not approved by an app call for a change that needs none', async () => {
  const { core } = coreWith('never');
  const first = await gatedChange(core, setSendPolicy(core, 'chat'), { surface: 'mcp', channel: 'core' });
  assert.equal(first.status, 'approval-required');
  const approvalId = first.status === 'approval-required' ? first.prepared.approvalId : '';
  // The no-op: moving the send policy to where it already is.
  await assert.rejects(
    gatedChangeAtTerminal(core, setSendPolicy(core, 'never'), { ...APP, appApproval: approvalId }),
    CommsError,
  );
  assert.deepEqual(await standing(core), { state: 'pending', via: undefined });
  // Claimed over MCP, under confirm: refused, since nobody approved it.
  await assert.rejects(
    gatedChange(core, setSendPolicy(core, 'chat'), { surface: 'mcp', channel: 'core', approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING',
  );
  assert.equal(await policyNow(core), 'never');
});

test('review regression: a plan that throws, or one with nothing to approve, never approves the approval it names', async () => {
  const { core } = coreWith('never');
  const approvalId = await prepared(core, setSendPolicy(core, 'chat'));
  const throwing: GatedChange<SendPolicy> = {
    plan: () => {
      throw new CommsError('USAGE', 'a print is not a change');
    },
    apply: async () => 'chat',
  };
  await assert.rejects(
    gatedChangeAtTerminal(core, throwing, { ...APP, appApproval: approvalId }),
    /a print is not a change/,
  );
  assert.deepEqual(await standing(core), { state: 'pending', via: undefined });
  // A plan that changes nothing at all, as `mcp install --print` plans.
  const nothing: GatedChange<SendPolicy> = {
    plan: (config) => ({ account: 'acme/slack', before: config, after: structuredClone(config), summary: 'prints' }),
    apply: async () => 'never',
  };
  await assert.rejects(
    gatedChangeAtTerminal(core, nothing, { ...APP, appApproval: approvalId }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
  assert.deepEqual(await standing(core), { state: 'pending', via: undefined });
});

test('an app approval that is answered and then not applied is revoked, never left approved', async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  const failing: GatedChange<SendPolicy> = {
    plan: change.plan,
    apply: async () => {
      throw new CommsError('CONFIG', 'the client could not be written');
    },
  };
  await assert.rejects(
    gatedChangeAtTerminal(core, failing, { ...APP, appApproval: approvalId }),
    /the client could not be written/,
  );
  // Claimed for the change and then not applied: spent, and so not usable again.
  assert.notEqual((await standing(core)).state, 'approved');
});

test('on macOS a process the app did not start cannot approve in the app: refused, audited, and nothing approved', async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  for (const reason of [
    'not-agent-comms',
    'not-a-test-profile',
    'test-app-with-real-profile',
    'test-profile-unknown',
  ]) {
    await assert.rejects(
      gatedChangeAtTerminal(core, change, {
        ...APP,
        appOrigin: async () => ({ ok: false, reason }),
        appApproval: approvalId,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'APPROVAL_REQUIRED', reason);
        assert.equal((error.details as { reason?: string }).reason, reason);
        return true;
      },
    );
  }
  assert.deepEqual(await standing(core), { state: 'pending', via: undefined });
  assert.equal(await policyNow(core), 'never');
});

test('the local test build approves only as itself: its audit line says desktop-app (test build), never desktop-app', async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  const applied = await gatedChangeAtTerminal(core, change, {
    ...APP,
    appOrigin: async () => ({ ok: true, build: 'test', identifier: 'com.cueplusplus.agentcomms.test' }),
    appApproval: approvalId,
  });
  assert.equal(applied, 'chat');
  const approve = (await auditLines(core)).find((line) => line.operation === 'change.approve' && line.outcome === 'ok');
  assert.equal(approve?.approvedBy, 'desktop-app (test build)');
});

test('on Windows and Linux, where nothing attests the app, the audit says the approval was unattested', async () => {
  const { core } = coreWith('never');
  const change = setSendPolicy(core, 'chat');
  const approvalId = await prepared(core, change);
  const applied = await gatedChangeAtTerminal(core, change, {
    ...APP,
    appOrigin: async () => ({ ok: false, reason: 'unattested-platform' }),
    appApproval: approvalId,
  });
  assert.equal(applied, 'chat');
  const approve = (await auditLines(core)).find((line) => line.operation === 'change.approve' && line.outcome === 'ok');
  assert.equal(approve?.approvedBy, 'desktop-app (unattested)');
  // Even there, an agent's marker is refused.
  const { core: other } = coreWith('never');
  const again = await prepared(other, setSendPolicy(other, 'chat'));
  await assert.rejects(
    gatedChangeAtTerminal(other, setSendPolicy(other, 'chat'), {
      ...APP,
      env: { CLAUDECODE: '1' },
      appOrigin: async () => ({ ok: false, reason: 'unattested-platform' }),
      appApproval: again,
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
  );
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
  '`mcp install --app-approval <id>` is refused unless the app started it (macOS), and registers the install otherwise',
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
    if (process.platform === 'darwin') {
      // Here the command's parent is this test, not Agent Comms: on macOS that is refused, and nothing is approved.
      assert.equal(done.status, 10, done.stdout + done.stderr);
      assert.equal(done.json().error.details.reason, 'not-agent-comms');
      assert.deepEqual(m.asked(), []);
      const [record] = await m.core().approvals.list();
      assert.equal(record?.form === 'v2' ? record.record.state : undefined, 'pending');
    } else {
      // Linux attests nothing: the marker checks hold, and the approval is said to be the app's, unattested.
      assert.equal(done.status, 0, done.stdout + done.stderr);
      assert.equal(done.json().data.applied, true);
      assert.equal(m.asked().length, 1, 'registered once');
      const [record] = await m.core().approvals.list();
      assert.equal(record?.form === 'v2' ? record.record.approvedVia : undefined, 'app');
      const approve = (await m.core().audit.tail({ limit: 100 })).find(
        (line) => line.operation === 'change.approve' && line.outcome === 'ok',
      );
      assert.equal(approve?.approvedBy, 'desktop-app (unattested)');
    }

    // Never alongside --approval.
    const both = m.run([...words, '--app-approval', approvalId, '--approval', approvalId, '--json']);
    assert.equal(both.status, 64, both.stdout);
  },
);
