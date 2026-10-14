import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { beginChangeApproval, claimChange, prepareChange } from '../src/changes.ts';
import { type Config, parseConfig } from '../src/config.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { managedRuntimeDir, managedRuntimeEntry } from '../src/mcp-install.ts';
import { resolveName } from '../src/names.ts';
import { type ServerInstallRequest, serverInstallChange, serverPruneChange } from '../src/operations/servers.ts';
import { updateChange } from '../src/operations/update.ts';
import { VERSION } from '../src/version.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The sentences a person reads before approving something, held byte for byte to what 0.6.0 said.
 *
 * Previews and effects are inside approval digests: an approval is bound to exactly these words, so a Gmail or Slack
 * sentence that changed by one character is a different change, and an approval prepared by one release would be
 * refused by the next for no reason a person could see. When the channel wording moved from code into the manifests
 * (design 2026-09-26), every sentence the core builds about a channel — registration and prune effects, update steps,
 * loosening lines, refusals and hints — was captured first from the code as it stood, into
 * `fixtures/wording-0.6.0.json`, and is compared here.
 *
 * Machine-specific parts are replaced before comparing: the temporary home, this checkout, Node's path and the
 * release version.
 *
 * A handful of sentences name every channel there is — a refusal's list of channels, the approve commands a hint
 * offers, the core server's instructions and three tool descriptions — and so gain a word when a channel is added:
 * Resend's arrival rewrote exactly those ten. WhatsApp's rewrote seven of them: it never sends, so the hints about a
 * send approval, which name only the channels that can send, did not change. None of them is inside an approval
 * digest.
 *
 *   AGENTCOMMS_WRITE_WORDING=1 node --experimental-strip-types --test test/wording-identity.test.ts
 *
 * rewrites the fixture — which is exactly the change this test exists to make visible in review.
 */

const FIXTURE = fileURLToPath(new URL('./fixtures/wording-0.6.0.json', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url)).replace(/[\\/]$/, '');
const CREATED = '2026-09-20T00:00:00.000Z';
const OLD = '0.0.1';
const LATEST = '99.0.0';

const inbox = {
  id: 'ibx_AAAAAAAAAAAAAAAA',
  provider: 'gmail',
  email: 'jo@acme.test',
  identity: 'oidc',
  client: 'desktop',
  tier: 'read',
  contacts: false,
  grantedScopes: [],
  secretRef: 'gmail:refresh:ibx_AAAAAAAAAAAAAAAA',
  internalDomains: ['acme.test'],
  createdAt: CREATED,
};
const account = {
  id: 'acc_AAAAAAAAAAAAAAAA',
  platform: 'slack',
  workspace: 'T_ACME',
  userId: 'U_AAAA',
  tier: 'read',
  mode: 'read',
  grantedScopes: [],
  secretRef: 'slack:token:acc_AAAAAAAAAAAAAAAA',
  createdAt: CREATED,
};

interface Machine {
  home: string;
  env: Record<string, string>;
  core: Core;
  dataDir: string;
}

function machine(body: Record<string, unknown> = {}): Machine {
  // The long form of the temporary folder: a Windows runner's `RUNNER~1` needs quotes in a located command's pins.
  const home = realpathSync.native(tempDir('comms-wording-'));
  mkdirSync(join(home, 'bin'));
  mkdirSync(join(home, 'config'));
  writeFileSync(join(home, 'config', 'config.json'), `${JSON.stringify({ version: 2, ...body }, null, 2)}\n`);
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: join(home, 'bin'),
    AGENT_COMMS_CONFIG_DIR: join(home, 'config'),
    AGENT_COMMS_DATA_DIR: join(home, 'data'),
    NO_COLOR: '1',
    npm_config_offline: 'true',
    AGENT_COMMS_UPDATE_CHECK: 'off', // no test asks the real npm registry, or stops for a release
  };
  const core = openCore({ env, now: () => new Date('2026-09-26T10:00:00.000Z'), caller: CORE_CALLER });
  return { home, env, core, dataDir: core.paths.dataDir };
}

const ACCOUNTS = { inboxes: { 'acme/gmail': inbox }, accounts: { 'acme/slack': account } };

/** A runtime directory as the managed launcher leaves one: enough for prune, and for "is it on disk". */
function runtime(m: Machine, packageName: string, version: string): void {
  const root = managedRuntimeDir(m.dataDir, packageName, version);
  const entry = managedRuntimeEntry(m.dataDir, packageName, version);
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, '');
  writeFileSync(
    join(root, 'node_modules', ...packageName.split('/'), 'package.json'),
    JSON.stringify({ name: packageName, version }),
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ private: true, dependencies: { [packageName]: version } }),
  );
}

function cursor(m: Machine, servers: Record<string, { command: string; args: string[] }>): void {
  mkdirSync(join(m.home, '.cursor'), { recursive: true });
  writeFileSync(join(m.home, '.cursor', 'mcp.json'), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

/** The text with everything that depends on this machine or this release replaced. */
function normalise(m: Machine, text: string): string {
  let out = text;
  for (const home of new Set([m.home, realpathSync(m.home)])) out = out.split(home).join('<home>');
  // The npx an npx entry starts is the one beside this node when PATH has none (#46): `npx`, or `npx.cmd` on Windows —
  // the longer names first, so `npx.cmd` is not left as `<npx>.cmd`.
  for (const npx of ['npx.cmd', 'npx.CMD', 'npx.exe', 'npx'].map((name) => join(dirname(process.execPath), name))) {
    out = out.split(npx).join('<npx>');
  }
  out = out.split(REPO).join('<repo>').split(process.execPath).join('<node>');
  out = out.split(VERSION).join('<version>');
  return out.replace(/\\/g, '/');
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
    return '(not refused)';
  } catch (error) {
    const e = error as { code?: string; message: string; hint?: string | null };
    return `${e.code ?? '?'}: ${e.message}${e.hint ? ` | hint: ${e.hint}` : ''}`;
  }
};
const refusalAsync = async (fn: () => unknown): Promise<string> => {
  try {
    await fn();
    return '(not refused)';
  } catch (error) {
    const e = error as { code?: string; message: string; hint?: string | null };
    return `${e.code ?? '?'}: ${e.message}${e.hint ? ` | hint: ${e.hint}` : ''}`;
  }
};

// The golden intentionally includes the new owned-shim sentence for POSIX managed installs; Windows offers no shim.
const posixServerInstallChange = (
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerInstallRequest,
  own?: Parameters<typeof serverInstallChange>[3],
) => serverInstallChange(core, env, request, own, { platform: 'darwin' });

/** Every sentence this test holds still, by a key that says where it came from. */
async function collect(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  // ── Registration: the effects and the summary of every shape of `mcp install` ──
  {
    const m = machine(ACCOUNTS);
    const config = await m.core.config.load();
    const requests: [string, Omit<ServerInstallRequest, 'client'>][] = [];
    for (const launcher of ['managed', 'npx', 'local'] as const) {
      for (const print of [false, true]) {
        const at = `${launcher}${print ? ' print' : ''}`;
        requests.push([`core ${at}`, { channel: 'core', launcher, print }]);
        for (const pin of [undefined, 'acme/gmail']) {
          for (const readOnly of [undefined, true]) {
            requests.push([
              `gmail ${pin ?? 'unpinned'}${readOnly ? ' read-only' : ''} ${at}`,
              { channel: 'gmail', launcher, print, ...(pin ? { inbox: pin } : {}), ...(readOnly ? { readOnly } : {}) },
            ]);
          }
        }
        for (const pin of [undefined, 'acme/slack']) {
          requests.push([
            `slack ${pin ?? 'unpinned'} ${at}`,
            { channel: 'slack', launcher, print, ...(pin ? { workspace: pin } : {}) },
          ]);
        }
      }
    }
    requests.push(['gmail named', { channel: 'gmail', name: 'gmail-work', inbox: 'acme/gmail' }]);
    for (const [key, request] of requests) {
      const plan = await posixServerInstallChange(m.core, m.env, { client: 'cursor', ...request }).plan(config);
      out[`install ${key}: summary`] = normalise(m, plan.summary);
      out[`install ${key}: effects`] = normalise(m, (plan.effects ?? []).join('\n'));
    }
    // A runtime already on disk is not fetched again, and says nothing about it.
    runtime(m, '@agentcomms/slack', VERSION);
    const reused = await posixServerInstallChange(m.core, m.env, { client: 'cursor', channel: 'slack' }).plan(config);
    out['install slack reused runtime: effects'] = normalise(m, (reused.effects ?? []).join('\n'));
  }
  {
    // Replacing an entry keeps its pins, and says so.
    const m = machine(ACCOUNTS);
    cursor(m, {
      gmail: {
        command: process.execPath,
        args: [managedRuntimeEntry(m.dataDir, '@agentcomms/gmail', OLD), 'mcp', '--inbox', 'acme/gmail', '--read-only'],
      },
      slack: {
        command: process.execPath,
        args: [managedRuntimeEntry(m.dataDir, '@agentcomms/slack', OLD), 'mcp', '--workspace', 'acme/slack'],
      },
    });
    const config = await m.core.config.load();
    for (const channel of ['gmail', 'slack'] as const) {
      const plan = await posixServerInstallChange(m.core, m.env, { client: 'cursor', channel, force: true }).plan(
        config,
      );
      out[`install ${channel} replacing: effects`] = normalise(m, (plan.effects ?? []).join('\n'));
      out[`install ${channel} taken: refusal`] = normalise(
        m,
        await refusalAsync(() => posixServerInstallChange(m.core, m.env, { client: 'cursor', channel }).plan(config)),
      );
    }
  }
  {
    // What each channel's install refuses, and what the core says about a channel it does not know.
    const m = machine(ACCOUNTS);
    const config = await m.core.config.load();
    const refuse = (request: Record<string, unknown>) =>
      refusal(() => posixServerInstallChange(m.core, m.env, { client: 'cursor', ...request } as ServerInstallRequest));
    out['refuse inbox on slack'] = refuse({ channel: 'slack', inbox: 'acme/gmail' });
    out['refuse readOnly on slack'] = refuse({ channel: 'slack', readOnly: true });
    out['refuse workspace on gmail'] = refuse({ channel: 'gmail', workspace: 'acme/slack' });
    out['refuse inbox on core'] = refuse({ channel: 'core', inbox: 'acme/gmail' });
    out['refuse workspace on core'] = refuse({ channel: 'core', workspace: 'acme/slack' });
    out['refuse unknown channel'] = refuse({ channel: 'discord' });
    out['refuse unknown client'] = refuse({ channel: 'gmail', client: 'notepad' });
    out['refuse other package'] = refusal(() =>
      posixServerInstallChange(m.core, m.env, { client: 'cursor', channel: 'gmail' }, {
        packageName: '@agentcomms/slack',
      } as never),
    );
    out['refuse unknown mailbox pin'] = await refusalAsync(() =>
      posixServerInstallChange(m.core, m.env, {
        client: 'cursor',
        channel: 'gmail',
        inbox: 'nobody/gmail',
      }).plan(config),
    );
    out['refuse unknown workspace pin'] = await refusalAsync(() =>
      posixServerInstallChange(m.core, m.env, {
        client: 'cursor',
        channel: 'slack',
        workspace: 'nobody/slack',
      }).plan(config),
    );
    // A version-1 name for an account that is not Slack's.
    const v1 = parseConfig(
      JSON.stringify({ version: 1, accounts: { team: { ...account, platform: 'teams' } } }),
    ) as Config;
    out['refuse workspace pin on another platform'] = await refusalAsync(() =>
      posixServerInstallChange(m.core, m.env, { client: 'cursor', channel: 'slack', workspace: 'team' }).plan(v1),
    );
    out['prune refuse unknown channel'] = refusal(() =>
      serverPruneChange(m.core, m.env, { channel: 'discord' } as never),
    );
  }

  // ── Prune ──
  {
    const m = machine();
    for (const [channel, packageName] of [
      ['core', '@agentcomms/core'],
      ['gmail', '@agentcomms/gmail'],
      ['slack', '@agentcomms/slack'],
    ] as const) {
      const config = await m.core.config.load();
      const dry = await serverPruneChange(m.core, m.env, { channel, dryRun: true }).plan(config);
      out[`prune ${channel} dry: summary`] = normalise(m, dry.summary);
      const none = await serverPruneChange(m.core, m.env, { channel, processes: async () => [] }).plan(config);
      out[`prune ${channel} none: summary`] = normalise(m, none.summary);
      runtime(m, packageName, OLD);
      const one = await serverPruneChange(m.core, m.env, { channel, processes: async () => [] }).plan(config);
      out[`prune ${channel} one: summary`] = normalise(m, one.summary);
      out[`prune ${channel} one: effects`] = normalise(m, (one.effects ?? []).join('\n'));
      runtime(m, packageName, '0.0.2');
      const two = await serverPruneChange(m.core, m.env, { channel, processes: async () => [] }).plan(config);
      out[`prune ${channel} two: summary`] = normalise(m, two.summary);
    }
  }

  // ── Update: every registration sentence, pinned and not, managed and npx ──
  {
    const m = machine(ACCOUNTS);
    const managed = (packageName: string, flags: string[] = []) => ({
      command: process.execPath,
      args: [managedRuntimeEntry(m.dataDir, packageName, OLD), 'mcp', ...flags],
    });
    runtime(m, '@agentcomms/gmail', OLD);
    runtime(m, '@agentcomms/slack', OLD);
    cursor(m, {
      gmail: managed('@agentcomms/gmail', ['--inbox', 'acme/gmail', '--read-only']),
      'gmail-all': managed('@agentcomms/gmail'),
      'gmail-npx': { command: 'npx', args: ['-y', `@agentcomms/gmail-mcp@${OLD}`, '--inbox', 'acme/gmail'] },
      slack: managed('@agentcomms/slack', ['--workspace', 'acme/slack']),
      'slack-all': { command: 'npx', args: ['-y', `@agentcomms/slack@${OLD}`, 'mcp'] },
      agentcomms: { command: 'npx', args: ['-y', `@agentcomms/core@${OLD}`, 'mcp'] },
    });
    const deps = {
      latestVersion: async () => LATEST,
      globalPackages: async () => ({ '@agentcomms/core': OLD, '@agentcomms/slack': OLD }),
      installGlobal: async () => undefined,
      installRuntime: async () => undefined,
    };
    const plan = await updateChange(m.core, m.env, { noVerify: true }, deps).plan(await m.core.config.load());
    out['update: summary'] = normalise(m, plan.summary);
    out['update: effects'] = normalise(m, (plan.effects ?? []).join('\n'));
  }

  // ── Loosenings as a person reads them ──
  {
    const m = machine({
      ...ACCOUNTS,
      defaults: { sendPolicy: 'never', changePolicy: 'confirm' },
    });
    const before = await m.core.config.load();
    const lines = async (key: string, scope: { account?: string; inbox?: string }, edit: (c: Config) => void) => {
      const after = structuredClone(before);
      edit(after);
      const prepared = await prepareChange(
        m.core,
        { ...scope, before, after, effects: ['does one thing', 'and another'], summary: `Summary for ${key}` },
        { channel: 'core', surface: 'mcp' },
      );
      out[`preview ${key}`] = normalise(m, prepared.preview.replace(/ap_[A-Z0-9]+/g, 'ap_ID'));
      out[`next ${key}`] = normalise(m, prepared.next.replace(/ap_[A-Z0-9]+/g, 'ap_ID'));
    };
    await lines('account mode', { account: 'acme/slack' }, (c) => {
      c.accounts['acme/slack'] = { ...account, mode: 'send', tier: 'send' } as never;
    });
    await lines('account policies', { account: 'acme/slack' }, (c) => {
      c.accounts['acme/slack'] = { ...account, sendPolicy: 'chat', changePolicy: 'chat' } as never;
    });
    await lines('new account', {}, (c) => {
      c.accounts['zed/slack'] = { ...account, id: 'acc_ZZZZZZZZZZZZZZZZ', mode: 'send', tier: 'send' } as never;
    });
    await lines('inbox', { inbox: 'acme/gmail' }, (c) => {
      c.inboxes['acme/gmail'] = {
        ...inbox,
        sendPolicy: 'chat',
        changePolicy: 'chat',
        internalDomains: ['acme.test', 'partner.test'],
      } as never;
    });
    await lines('defaults', {}, (c) => {
      c.defaults.sendPolicy = 'confirm';
      c.defaults.changePolicy = 'chat';
    });
  }

  // ── Hints that name a channel's commands ──
  {
    const m = machine(ACCOUNTS);
    const before = await m.core.config.load();
    const after = structuredClone(before);
    after.defaults.timezone = 'Europe/London';
    const change = await prepareChange(
      m.core,
      { before, after, effects: ['does a thing'], summary: 'x' },
      { channel: 'core', surface: 'mcp' },
    );
    out['hint change approval used for a send'] = normalise(
      m,
      (await refusalAsync(() => m.core.approvals.issueChallenge(change.approvalId, 'send'))).replace(
        /ap_[A-Z0-9]+/g,
        'ap_ID',
      ),
    );
    const send = await m.core.approvals.create({
      inboxId: inbox.id,
      draftId: 'r1',
      draftMessageId: 'm1',
      channel: 'gmail',
      sendEpoch: 0,
      contentDigest: 'd'.repeat(64),
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['someone@example.test'], cc: [], bcc: [], subject: 'hello' },
    });
    // At a terminal too, another kind's id is the one NOT_FOUND (design 2026-10-05 §D2), as it is at the store.
    out['hint send approval used for a change'] = normalise(
      m,
      (await refusalAsync(() => beginChangeApproval(m.core, send.approvalId, { surface: 'cli' }))).replace(
        /ap_[A-Z0-9]+/g,
        'ap_ID',
      ),
    );
    out['hint send approval claimed as a change'] = normalise(
      m,
      (
        await refusalAsync(() =>
          claimChange(m.core, send.approvalId, { before, after, effects: ['does a thing'] }, { surface: 'mcp' }),
        )
      ).replace(/ap_[A-Z0-9]+/g, 'ap_ID'),
    );
    const empty = parseConfig(JSON.stringify({ version: 2 }));
    out['hint no inboxes'] = refusal(() => resolveName(empty, 'inbox', 'acme/gmail'));
    out['hint no inbox by that name'] = refusal(() => resolveName(before, 'inbox', 'other/gmail'));
    out['hint no account'] = refusal(() => resolveName(before, 'account', 'other/slack'));
  }

  // ── The core server: what it tells an agent, and how its channel tools describe themselves ──
  {
    const m = machine(ACCOUNTS);
    const { server } = await createCoreMcpServer({ core: m.core, env: m.env, keyring: null });
    const inner = server as unknown as {
      server: { _instructions?: string };
      _registeredTools: Record<string, { description?: string; inputSchema?: unknown }>;
    };
    out['core server instructions'] = normalise(m, String(inner.server._instructions ?? ''));
    for (const name of ['comms_channels_available', 'comms_change_policy', 'comms_server_install', 'comms_update']) {
      out[`core tool ${name}`] = normalise(m, String(inner._registeredTools[name]?.description ?? ''));
    }
  }
  return out;
}

test('every sentence the core builds about a channel is byte for byte what it was', async () => {
  const now = await collect();
  if (process.env.AGENTCOMMS_WRITE_WORDING === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  const then = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, string>;
  // Key by key, so a failure names the sentence that moved.
  for (const key of Object.keys(then)) assert.equal(now[key], then[key], key);
  assert.deepEqual(Object.keys(now).sort(), Object.keys(then).sort(), 'the same sentences are collected');
  // And the collection is not empty or collapsed: every kind of sentence is in it.
  assert.ok(Object.keys(then).length > 100, `only ${Object.keys(then).length} sentences`);
  for (const fragment of [
    'pinned to the mailbox acme/gmail',
    'pinned to the workspace acme/slack',
    'not pinned: it reaches every mailbox on this machine, with every tool',
    'not read-only: it has every tool for acme/gmail',
    'not pinned: it reaches every workspace on this machine',
    'keeping --inbox acme/gmail --read-only from it',
    'deletes the unused Gmail runtime',
    'registers the Slack MCP server with cursor as "slack" again',
    'it will be able to send, not only read',
    // Another kind's id at the terminal: the one NOT_FOUND (design 2026-10-05 §D2), no longer the send's approvers.
    'an approval is only found by the surface, the kind and the owner it was prepared for',
    "add one with Gmail's inbox add",
    'is not a Slack workspace',
    'is an option of the Gmail server; the Slack server has no such option',
  ]) {
    assert.ok(
      Object.values(then).some((sentence) => sentence.includes(fragment)),
      `the fixture has no sentence with "${fragment}"`,
    );
  }
});
