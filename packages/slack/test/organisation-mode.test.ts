import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  beginChangeApproval,
  CommsError,
  type ConfigV2,
  finishChangeApproval,
  gatedChange,
  neutralise,
  resolveProfileSlackTarget,
  type SecretStore,
} from '@agentcomms/core';
import { openCore } from '../../core/src/core.ts';
import { CORE_CALLER } from '../../core/src/handoffs.ts';
import { orgUpdateChange } from '../../core/src/operations/organisations.ts';
import { parseBundle, serialiseBundle } from '../src/auth/bundle.ts';
import { FLOW_TTL_MS, newFlowId, type SlackFlow } from '../src/auth/flow.ts';
import { settleRefreshes } from '../src/auth/refresh.ts';
import { SlackContext } from '../src/context.ts';
import { type InstallMode, scopesForMode } from '../src/manifest.ts';
import { planModeSet, reauthWorkspace } from '../src/operations/changes.ts';
import { openWorkspace } from '../src/operations/session.ts';
import { completeSignIn } from '../src/operations/signin.ts';
import { slackHandoffs } from './support/handoffs.ts';
import { slackOk } from './support/harness.ts';
import { newOrganisationHarness, READ_CLIENT_ID, SEND_CLIENT_ID } from './support/organisation.ts';
import { QUICK } from './support/refresh.ts';

function present<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}

const alias = 'rgc/slack';
let nextManifestPort = 45_000;
async function freePort() {
  return nextManifestPort++;
}

async function fixture(mode: InstallMode = 'read') {
  const h = await newOrganisationHarness({ port: await freePort(), readAppId: 'A0READ', sendAppId: 'A0SEND' });
  await h.addWorkspace({
    alias,
    mode,
    workspaceId: 'TRGC0001',
    oauthClientId: mode === 'read' ? READ_CLIENT_ID : SEND_CLIENT_ID,
    appId: mode === 'read' ? 'A0READ' : 'A0SEND',
    redirectPort: 51234,
  });
  await h.updateConfig((c) => {
    Object.assign(present(c.accounts[alias]), { organisation: 'rgc', profileApp: mode });
  });
  const context = new SlackContext({
    core: h.core,
    env: h.env,
    exchange: async (params) => h.reply(params),
    fetch: async () => new Response(JSON.stringify({ ok: true, revoked: false })),
  });
  return { h, context };
}

async function savedMove(f: Awaited<ReturnType<typeof fixture>>, mode: InstallMode) {
  const config = await f.h.core.config.load();
  const source = present(config.accounts[alias]);
  const target = resolveProfileSlackTarget(config, 'rgc', mode, f.context.handoffs);
  const now = new Date();
  const flow: SlackFlow = {
    flowId: newFlowId(),
    alias,
    mode,
    clientId: target.clientId,
    port: target.redirectPort,
    profile: { ...target, label: neutralise(target.label).text, workspaceName: neutralise(target.workspaceName).text },
    transition: 'profile-app',
    expect: {
      accountId: source.id,
      secretRef: source.secretRef,
      workspaceId: source.workspace,
      userId: source.userId,
      oauthClientId: source.oauthClientId,
      appId: source.appId,
    },
    ...(mode === 'send' ? { consent: { kind: 'loosening-consent' as const, paths: [`accounts.${alias}.mode`] } } : {}),
    verifier: 'fake-verifier',
    state: 'fake-state',
    redirectUrl: `http://localhost:${target.redirectPort}/slack/callback`,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
  };
  f.h.reply = () =>
    slackOk({ team: { id: target.workspace, name: 'RGC' }, app_id: target.appId, scopes: scopesForMode(mode) });
  await f.context.flows.save(flow);
  return flow;
}

function interceptStore(
  real: SecretStore,
  hooks: { set?: (ref: string) => Promise<void>; delete?: (ref: string) => void },
): SecretStore {
  return {
    kind: real.kind,
    get: (r) => real.get(r),
    invalidate: (r) => real.invalidate(r),
    async set(r, v) {
      await real.set(r, v);
      await hooks.set?.(r);
    },
    async delete(r) {
      hooks.delete?.(r);
      return real.delete(r);
    },
  };
}

for (const mode of ['read', 'send'] as const) {
  test(`profile mode move to ${mode} selects the target role and gates only widening`, async () => {
    const f = await fixture(mode === 'read' ? 'send' : 'read');
    const plan = await planModeSet(f.context, alias, mode, { detached: false });
    assert.equal(plan.kind, 'change');
    if (plan.kind !== 'change') return;
    let outcome = await gatedChange(f.h.core, plan.change, { channel: 'slack', surface: 'cli' });
    assert.equal(outcome.status, mode === 'send' ? 'approval-required' : 'applied');
    if (outcome.status === 'approval-required') {
      assert.deepEqual(await f.context.flows.pending(), []);
      const prompt = await beginChangeApproval(f.h.core, outcome.prepared.approvalId, { surface: 'cli' });
      await finishChangeApproval(f.h.core, outcome.prepared.approvalId, prompt.challenge, { surface: 'cli' });
      outcome = await gatedChange(f.h.core, plan.change, {
        channel: 'slack',
        surface: 'cli',
        approvalId: outcome.prepared.approvalId,
      });
    }
    assert.equal(outcome.status, 'applied');
    if (outcome.status !== 'applied') return;
    try {
      const flow = await f.context.flows.get(outcome.result.flowId);
      const account = present((await f.h.core.config.load()).accounts[alias]);
      assert.equal(flow.transition, 'profile-app');
      assert.equal(flow.profile?.role, mode);
      assert.equal(flow.clientId, mode === 'read' ? READ_CLIENT_ID : SEND_CLIENT_ID);
      assert.equal(flow.expect?.oauthClientId, account.oauthClientId);
      assert.equal(flow.expect?.secretRef, account.secretRef);
      assert.equal(flow.expect?.accountId, account.id);
      assert.equal(flow.port, flow.profile?.redirectPort);
      assert.ok(flow.profile?.sha256);
      assert.doesNotMatch(plan.steps.steps.join(' '), /manifest|uninstall|Remove app|app-updated/);
    } finally {
      await outcome.result.listener?.close();
      await f.context.flows.discard(outcome.result.flowId);
    }
  });
}

test('removed target role is refused; removing Slack leaves sessions usable but removes profile moves', async () => {
  const f = await fixture();
  await f.h.updateProfile((r) => {
    delete r.slack?.apps.send;
  });
  await assert.rejects(planModeSet(f.context, alias, 'send', { detached: false }), /does not list a send app/);
  await f.h.updateProfile((r) => {
    delete r.slack;
  });
  assert.equal((await openWorkspace(f.context, alias)).accountId, (await f.h.core.config.load()).accounts[alias]?.id);
  await assert.rejects(planModeSet(f.context, alias, 'send', { detached: false }), /does not list Slack/);
});

test('own-app mode procedures and app-updated path remain unchanged', async () => {
  const f = await fixture();
  await f.h.updateConfig((c) => {
    delete present(c.accounts[alias]).organisation;
    delete present(c.accounts[alias]).profileApp;
  });
  assert.equal((await planModeSet(f.context, alias, 'send', { detached: false })).kind, 'app-update-needed');
  assert.equal((await planModeSet(f.context, alias, 'send', { detached: false, appUpdated: true })).kind, 'change');
  const send = await fixture('send');
  await send.h.updateConfig((c) => {
    delete present(c.accounts[alias]).organisation;
    delete present(c.accounts[alias]).profileApp;
  });
  const plan = await planModeSet(send.context, alias, 'read', { detached: false });
  assert.equal(plan.kind, 'steps');
  if (plan.kind === 'steps') assert.match(plan.result.steps.join(' '), /Remove app/);
});

test('atomic hand-off journal: stage, one locked switch with ledger, then both revokes; live session uses new ref', async () => {
  const f = await fixture();
  const source = present((await f.h.core.config.load()).accounts[alias]);
  const flow = await savedMove(f, 'send');
  const real = await f.h.core.secrets('file');
  const events: string[] = [];
  let staged = '';
  f.context.secrets = async () =>
    interceptStore(real, {
      async set(ref) {
        // The send app's bot token, kept once the switch is saved (design 2026-10-15 S1): never staged, never revoked.
        if (ref.startsWith('slack/bot-token/')) {
          events.push('bot');
          return;
        }
        staged = ref;
        events.push('stage');
        assert.equal((await f.h.core.config.load()).accounts[alias]?.secretRef, source.secretRef);
      },
      delete(ref) {
        if (ref === source.secretRef) events.push('delete-old');
      },
    });
  const update = f.h.core.config.update.bind(f.h.core.config);
  f.h.core.config.update = async (mutator, options) =>
    update(async (c) => {
      const next = await mutator(c);
      if (c.accounts[alias]?.secretRef !== next.accounts[alias]?.secretRef) {
        events.push('switch');
        assert.ok(staged, 'configuration switched before staging');
        const account = present(next.accounts[alias]);
        assert.equal(account.secretRef, staged);
        assert.equal(account.oauthClientId, SEND_CLIENT_ID);
        assert.equal(account.appId, 'A0SEND');
        assert.equal(account.mode, 'send');
        assert.equal(account.tier, 'send');
        assert.equal(account.profileApp, 'send');
        assert.equal(account.id, source.id);
        assert.equal(account.createdAt, source.createdAt);
        assert.equal(next.pendingRevocations?.[0]?.ref, source.secretRef, 'ledger must be in the switching write');
        assert.equal(next.pendingRevocations?.[0]?.store, 'file');
        assert.equal(next.pendingRevocations?.[0]?.tokens.access.status, 'pending');
        assert.equal(next.pendingRevocations?.[0]?.tokens.refresh?.status, 'pending');
      }
      return next;
    }, options);
  const originalUpdate = f.h.core.config.update;
  f.h.core.config.update = async (...args) => {
    if (!events.includes('switch')) await access(join(f.h.configDir, '.credentials.lock'));
    return originalUpdate(...args);
  };
  const context = new SlackContext({
    core: f.h.core,
    env: f.h.env,
    exchange: f.context.exchange,
    fetch: async () => {
      events.push('revoke');
      assert.ok(await real.get(source.secretRef), 'old bundle was deleted before revocation');
      assert.equal((await f.h.core.config.load()).accounts[alias]?.secretRef, staged);
      assert.equal((await openWorkspace(f.context, alias)).call.token, 'fake-user-token-1');
      return new Response(JSON.stringify({ ok: true, revoked: false }));
    },
  });
  context.secrets = f.context.secrets;
  const result = await completeSignIn(context, flow.flowId, 'move');
  assert.deepEqual(events, ['stage', 'switch', 'bot', 'revoke', 'revoke']);
  assert.equal(result.cleanup?.cleaned, false);
  assert.deepEqual(
    result.cleanup?.tokens.map((t) => t.status),
    ['pending', 'pending'],
  );
  assert.ok(await real.get(source.secretRef));
});

test('second move appends an independent pending entry and unique new ref', async () => {
  const f = await fixture();
  const firstRef = present((await f.h.core.config.load()).accounts[alias]).secretRef;
  await completeSignIn(f.context, (await savedMove(f, 'send')).flowId, 'first');
  const middle = await f.h.core.config.load();
  const firstEntry = middle.pendingRevocations?.[0];
  assert.ok(firstEntry);
  const secondRef = present(middle.accounts[alias]).secretRef;
  await completeSignIn(f.context, (await savedMove(f, 'read')).flowId, 'second');
  const after = await f.h.core.config.load();
  assert.deepEqual(after.pendingRevocations?.[0], firstEntry);
  assert.deepEqual(
    after.pendingRevocations?.map((e) => e.ref),
    [firstRef, secondRef],
  );
  assert.equal(new Set([firstRef, secondRef, present(after.accounts[alias]).secretRef]).size, 3);
});

test('uncertain renewal keeps its staged credential when a later app move owns it in the ledger', async () => {
  const f = await fixture();
  const first = await savedMove(f, 'read');
  // An ordinary same-app renewal can finish while a later profile move starts in another process.
  await f.context.flows.patch(first.flowId, { transition: undefined });
  const nextContext = new SlackContext({
    core: f.h.core,
    env: f.h.env,
    exchange: f.context.exchange,
    fetch: async () => new Response(JSON.stringify({ ok: true, revoked: false })),
  });
  const update = f.h.core.config.update.bind(f.h.core.config);
  let renewedRef = '';
  let failed = false;
  f.h.core.config.update = async (...args) => {
    const written = await update(...args);
    if (!renewedRef) {
      renewedRef = present(written.accounts[alias]).secretRef;
      const second = await savedMove({ ...f, context: nextContext }, 'send');
      await completeSignIn(nextContext, second.flowId, 'second');
      failed = true;
      throw new Error('post-commit lock release failure');
    }
    return written;
  };
  const config = f.context.config.bind(f.context);
  let recoveryWasLocked = false;
  f.context.config = async () => {
    if (failed) {
      recoveryWasLocked = await access(join(f.h.configDir, '.credentials.lock')).then(
        () => true,
        () => false,
      );
    }
    return config();
  };
  const outcome = await Promise.allSettled([completeSignIn(f.context, first.flowId, 'first')]);
  assert.ok(failed, 'the post-commit failure was not injected');
  const current = await f.h.core.config.load();
  assert.notEqual(current.accounts[alias]?.secretRef, renewedRef);
  assert.ok(current.pendingRevocations?.some((entry) => entry.ref === renewedRef));
  assert.ok(await (await f.h.core.secrets('file')).get(renewedRef), 'ledger-owned credential was withdrawn');
  assert.equal(outcome[0]?.status, 'fulfilled');
  assert.ok(recoveryWasLocked, 'ownership readback must hold the credentials lock');
});

for (const mode of ['read', 'send'] as const) {
  test(`profile ${mode} transition with mismatched scopes directs the member to their administrator`, async () => {
    const f = await fixture(mode === 'read' ? 'send' : 'read');
    const source = (await f.h.core.config.load()).accounts[alias];
    const flow = await savedMove(f, mode);
    f.h.reply = () =>
      slackOk({
        team: { id: 'TRGC0001', name: 'RGC' },
        app_id: mode === 'read' ? 'A0READ' : 'A0SEND',
        scopes: scopesForMode(mode === 'read' ? 'send' : 'read'),
        // A read sign-in asks Slack for no bot scope, so its reply carries no bot token (design 2026-10-15 S1).
        bot: false,
      });
    f.context.secrets = async () => {
      throw new Error('scope refusal must precede staging');
    };
    await assert.rejects(completeSignIn(f.context, flow.flowId, 'scope-mismatch'), (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, mode === 'read' ? 'CONFIG' : 'SCOPE_MISSING');
      assert.match(error.hint ?? '', /organisation administrator/);
      assert.match(error.hint ?? '', new RegExp(`${mode} app`));
      assert.doesNotMatch(
        `${error.message} ${error.hint}`,
        /manifest|uninstall|remove.{0,20}app|app.{0,20}remove|re-create|app update/i,
      );
      return true;
    });
    assert.deepEqual((await f.h.core.config.load()).accounts[alias], source);
  });
}

const races: Record<string, (c: ConfigV2) => void> = {
  'profile SHA': (c) => {
    present(present(c.organisations).rgc).sha256 = 'b'.repeat(64);
  },
  'profile removal': (c) => {
    delete present(c.organisations).rgc;
  },
  'Slack removal': (c) => {
    delete present(present(c.organisations).rgc).slack;
  },
  'target role removal': (c) => {
    delete present(present(present(c.organisations).rgc).slack).apps.send;
  },
  'target client replacement': (c) => {
    present(present(present(present(c.organisations).rgc).slack).apps.send).clientId = '9999.7777';
  },
  'target app replacement': (c) => {
    present(present(present(present(c.organisations).rgc).slack).apps.send).appId = 'A0OTHER';
  },
  'port change': (c) => {
    present(present(present(c.organisations).rgc).slack).redirectPort += 1;
  },
  'account renewal': (c) => {
    present(c.accounts[alias]).secretRef += '/renewed';
  },
  'account rename': (c) => {
    c.accounts['rgc/slack-new'] = present(c.accounts[alias]);
    delete c.accounts[alias];
  },
  'account removal': (c) => {
    delete c.accounts[alias];
  },
  'source identity change': (c) => {
    present(c.accounts[alias]).userId = 'U0OTHER';
  },
};
for (const [name, mutate] of Object.entries(races)) {
  test(`staged profile move withdraws on ${name}`, async () => {
    const f = await fixture();
    const flow = await savedMove(f, 'send');
    const real = await f.h.core.secrets('file');
    let staged = '';
    let withdrawalWasLocked = false;
    f.context.secrets = async () =>
      interceptStore(real, {
        async set(ref) {
          staged = ref;
          await f.h.updateConfig(mutate);
          if (name === 'account renewal') {
            const current = present((await f.h.core.config.load()).accounts[alias]);
            const old = await real.get(present(flow.expect?.secretRef));
            assert.ok(old);
            await real.set(current.secretRef, old);
          }
        },
        delete() {
          withdrawalWasLocked = existsSync(join(f.h.configDir, '.credentials.lock'));
        },
      });
    await assert.rejects(completeSignIn(f.context, flow.flowId, 'stale'), /changed|different/);
    assert.ok(staged, 'must exercise the post-staging validation');
    assert.equal(await real.get(staged), null);
    assert.ok(withdrawalWasLocked, 'staged withdrawal must hold the credentials lock');
    assert.equal((await f.h.core.config.load()).pendingRevocations, undefined);
  });
}

test('two distinct finishers racing the same source stage separately and only one commits', async () => {
  const f = await fixture();
  const first = await savedMove(f, 'send');
  const second = await savedMove(f, 'send');
  const real = await f.h.core.secrets('file');
  const refs: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  f.context.secrets = async () =>
    interceptStore(real, {
      async set(ref) {
        // The user tokens each finisher stages; the winner's bot token comes after its commit (design 2026-10-15 S1).
        if (ref.startsWith('slack/bot-token/')) return;
        refs.push(ref);
        if (refs.length === 2) release();
        await gate;
      },
    });
  const results = await Promise.allSettled([
    completeSignIn(f.context, first.flowId, 'one'),
    completeSignIn(f.context, second.flowId, 'two'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const c = await f.h.core.config.load();
  assert.equal(c.pendingRevocations?.length, 1);
  assert.equal(new Set(refs).size, 2);
  for (const ref of refs) assert.equal(Boolean(await real.get(ref)), ref === present(c.accounts[alias]).secretRef);
});

for (const field of ['client', 'app', 'person', 'workspace', 'discriminator'] as const) {
  test(`profile exchange refuses an unbound ${field} transition`, async () => {
    const f = await fixture();
    const flow = await savedMove(f, 'send');
    if (field === 'client') await f.context.flows.patch(flow.flowId, { clientId: '9999.7777' });
    if (field === 'discriminator') await f.context.flows.patch(flow.flowId, { transition: undefined });
    f.h.reply = () =>
      slackOk({
        team: { id: field === 'workspace' ? 'T0OTHER' : 'TRGC0001', name: 'RGC' },
        app_id: field === 'app' ? 'A0OTHER' : 'A0SEND',
        scopes: scopesForMode('send'),
        authed_user: { id: field === 'person' ? 'U0OTHER' : 'U0001' },
      });
    let stages = 0;
    const real = await f.h.core.secrets('file');
    f.context.secrets = async () =>
      interceptStore(real, {
        async set() {
          stages++;
        },
      });
    await assert.rejects(completeSignIn(f.context, flow.flowId, 'invalid'), /different|another|changed/);
    assert.equal(stages, 0);
  });
}

test('same-role profile replacement reauth selects current client/app and later profile port', async () => {
  const f = await fixture();
  const port = await freePort();
  await f.h.updateProfile((r) => {
    r.sha256 = 'b'.repeat(64);
    present(r.slack).apps.read = { clientId: '9999.7777', appId: 'A0NEW' };
    present(r.slack).redirectPort = port;
  });
  const change = reauthWorkspace(f.context, { alias, detached: false });
  const outcome = await gatedChange(f.h.core, change, { channel: 'slack', surface: 'cli' });
  assert.equal(outcome.status, 'applied');
  if (outcome.status !== 'applied') return;
  try {
    const flow = await f.context.flows.get(outcome.result.flowId);
    assert.equal(flow.clientId, '9999.7777');
    assert.equal(flow.profile?.appId, 'A0NEW');
    assert.equal(flow.port, port);
    assert.equal(flow.expect?.oauthClientId, READ_CLIENT_ID);
    f.h.reply = () => slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0NEW' });
    const result = await completeSignIn(f.context, flow.flowId, 'replacement');
    assert.equal(result.profileApp, 'read');
    assert.equal(result.appId, 'A0NEW');
    assert.equal(result.cleanup?.cleaned, false);
  } finally {
    await outcome.result.listener?.close();
    await f.context.flows.discard(outcome.result.flowId);
  }
});

test('profile mode report describes moves through organisation apps', async () => {
  for (const mode of ['read', 'send'] as const) {
    const f = await fixture(mode);
    const plan = await planModeSet(f.context, alias, undefined, { detached: false });
    assert.equal(plan.kind, 'report');
    if (plan.kind === 'report') {
      const steps = [...plan.report.toRead, ...plan.report.toSend].join(' ');
      assert.match(steps, /organisation/);
      assert.doesNotMatch(steps, /manifest|Remove app|app-updated/);
    }
  }
});

async function coreUpdate(
  f: Awaited<ReturnType<typeof fixture>>,
  change: (slack: NonNullable<NonNullable<ConfigV2['organisations']>[string]['slack']>) => void,
) {
  const config = (await f.h.core.config.load()) as ConfigV2;
  const slack = structuredClone(present(present(present(config.organisations).rgc).slack));
  change(slack);
  const path = join(f.h.home, 'rgc.agentcomms.json');
  await writeFile(
    path,
    JSON.stringify({ agentcomms: 'organisation-profile', version: 1, organisation: 'rgc', label: 'RGC', slack }),
  );
  // Core's own update, as core's CLI and server open core: with its caller.
  const core = openCore({ env: f.h.env, caller: CORE_CALLER });
  const build = (approvalId?: string) =>
    orgUpdateChange(
      core,
      { organisation: 'rgc', source: path, approvalId },
      { env: f.h.env, platform: 'darwin', surface: 'mcp', keyring: null, cwd: f.h.home },
    );
  const prepared = await gatedChange(f.h.core, build(), { channel: 'slack', surface: 'mcp' });
  const outcome =
    prepared.status === 'applied'
      ? prepared
      : await gatedChange(f.h.core, build(prepared.prepared.approvalId), {
          channel: 'slack',
          surface: 'mcp',
          approvalId: prepared.prepared.approvalId,
        });
  assert.equal(outcome.status, 'applied');
  if (outcome.status !== 'applied') throw new Error('update was not applied');
  return outcome.result;
}

test('D8 core refuses changing the profile workspace while provenance exists', async () => {
  const f = await fixture();
  await assert.rejects(
    coreUpdate(f, (slack) => {
      slack.workspace = 'T0OTHER';
    }),
    /another Slack workspace/,
  );
});

test('D8 changed client report leads to same-role replacement reauth', async () => {
  const f = await fixture();
  const result = await coreUpdate(f, (slack) => {
    slack.apps.read = { clientId: '9999.7777', appId: 'A0NEW' };
  });
  assert.match(result.reported.join(' '), /rgc\/slack is on the old read app/);
  const flow = await savedMove(f, 'read');
  assert.equal(flow.clientId, '9999.7777');
  const view = await completeSignIn(f.context, flow.flowId, 'replacement');
  assert.equal(view.oauthClientId, '9999.7777');
  assert.equal(view.cleanup?.cleaned, false);
});

test('D8 removed role report offers remaining mode; removed role cannot be selected', async () => {
  const f = await fixture('send');
  const result = await coreUpdate(f, (slack) => {
    delete slack.apps.send;
  });
  assert.match(result.reported.join(' '), /rgc\/slack is on the send app the profile no longer lists/);
  const renewal = reauthWorkspace(f.context, { alias, detached: false });
  const config = await f.h.core.config.load();
  assert.throws(() => renewal.plan(config), /does not list a send app/);
  assert.equal((await planModeSet(f.context, alias, 'read', { detached: false })).kind, 'change');
});

test('D8 already-applied core app-id-only replacement reports drift and Slack rejects the old learned id', async () => {
  const f = await fixture();
  const result = await coreUpdate(f, (slack) => {
    present(slack.apps.read).appId = 'A0STATED';
  });
  assert.match(result.reported.join(' '), /rgc\/slack is on the old read app/);
  const config = (await f.h.core.config.load()) as ConfigV2;
  assert.equal(present(present(present(present(config.organisations).rgc).slack).apps.read).appId, 'A0STATED');
  assert.equal(present(config.accounts[alias]).appId, 'A0READ');
  const old = await savedMove(f, 'read');
  f.h.reply = () => slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
  await assert.rejects(completeSignIn(f.context, old.flowId, 'old-app'), /another app/);
  const current = await savedMove(f, 'read');
  const view = await completeSignIn(f.context, current.flowId, 'stated-app');
  assert.equal(view.appId, 'A0STATED');
  assert.equal(view.cleanup?.cleaned, false);
});

test('same-app profile renewal keeps ordinary local cleanup and creates no revocation ledger', async () => {
  const f = await fixture();
  const source = present((await f.h.core.config.load()).accounts[alias]);
  const view = await completeSignIn(f.context, (await savedMove(f, 'read')).flowId, 'same-app');
  assert.equal(view.cleanup, undefined);
  assert.equal((await f.h.core.config.load()).pendingRevocations, undefined);
  assert.equal(await (await f.h.core.secrets('file')).get(source.secretRef), null);
});

test('a committed app switch reports durable per-token progress if later cleanup cannot be saved', async () => {
  const f = await fixture();
  const flow = await savedMove(f, 'send');
  const update = f.h.core.config.update.bind(f.h.core.config);
  let writes = 0;
  f.h.core.config.update = async (...args) => {
    writes++;
    if (writes === 3) throw new Error('fake cleanup write failed');
    return update(...args);
  };
  const context = new SlackContext({
    core: f.h.core,
    env: f.h.env,
    exchange: f.context.exchange,
    fetch: async () => new Response(JSON.stringify({ ok: true, revoked: true })),
  });
  const result = await completeSignIn(context, flow.flowId, 'move');
  assert.equal(result.mode, 'send');
  assert.equal(result.cleanup?.cleaned, false);
  assert.deepEqual(
    result.cleanup?.tokens.map((t) => t.status),
    ['revoked', 'pending'],
  );
  const config = await f.h.core.config.load();
  assert.equal(config.accounts[alias]?.appId, 'A0SEND');
  assert.ok(await (await f.h.core.secrets('file')).get(present(flow.expect?.secretRef)));
});

test('the locked hand-off invalidates a cached old bundle before fixing revocation deadlines', async () => {
  const f = await fixture();
  const flow = await savedMove(f, 'send');
  const real = await f.h.core.secrets('file');
  const ref = present(flow.expect?.secretRef);
  const cached = await real.get(ref);
  const bundle = parseBundle(cached, slackHandoffs());
  assert.ok(bundle);
  const deadline = new Date(Date.now() + 86400000).toISOString();
  await real.set(ref, serialiseBundle({ ...bundle, accessExpiresAt: deadline }));
  let invalidated = false;
  f.context.secrets = async () => ({
    kind: real.kind,
    get: (r) => (r === ref && !invalidated ? Promise.resolve(cached) : real.get(r)),
    set: (r, v) => real.set(r, v),
    delete: (r) => real.delete(r),
    invalidate(r) {
      if (r === ref) invalidated = true;
      real.invalidate(r);
    },
  });
  await completeSignIn(f.context, flow.flowId, 'move');
  assert.equal((await f.h.core.config.load()).pendingRevocations?.[0]?.tokens.access.deadline, deadline);
});

for (const state of ['refreshing', 'refresh-uncertain'] as const) {
  test(`a profile hand-off refuses ${state} until a retained refresh has a durable cleanup owner`, async () => {
    const f = await fixture();
    const source = present((await f.h.core.config.load()).accounts[alias]);
    const real = await f.h.core.secrets('file');
    const original = parseBundle(await real.get(source.secretRef), slackHandoffs());
    assert.ok(original);
    await real.set(source.secretRef, serialiseBundle({ ...original, accessExpiresAt: new Date(0).toISOString() }));
    let failPersistence = false;
    const staged: string[] = [];
    const store: SecretStore = {
      kind: real.kind,
      get: (ref) => real.get(ref),
      delete: (ref) => real.delete(ref),
      invalidate: (ref) => real.invalidate(ref),
      async set(ref, value) {
        if (ref === source.secretRef && failPersistence) throw new Error('fake retained refresh persistence failure');
        if (ref !== source.secretRef) staged.push(ref);
        await real.set(ref, value);
      },
    };
    f.context.secrets = async () => store;
    f.h.reply = () => {
      failPersistence = true;
      return slackOk({ authed_user: { access_token: 'fake-retained-access', refresh_token: 'fake-retained-refresh' } });
    };
    const revoked: string[] = [];
    const signIn = new SlackContext({
      core: f.h.core,
      env: f.h.env,
      exchange: f.context.exchange,
      fetch: async (_url, init) => {
        revoked.push(new Headers(init?.headers).get('authorization') ?? '');
        return new Response(JSON.stringify({ ok: true, revoked: true }));
      },
    });
    signIn.secrets = async () => store;
    try {
      const live = await openWorkspace(f.context, alias, { persist: QUICK });
      assert.equal(live.call.token, 'fake-retained-access');
      const marker = parseBundle(await real.get(source.secretRef), slackHandoffs());
      assert.equal(marker?.state, 'refreshing');
      assert.ok(marker);
      if (state === 'refresh-uncertain') {
        await real.set(
          source.secretRef,
          serialiseBundle({
            ...marker,
            state,
            attempt: undefined,
            reason: { kind: 'interrupted', attemptId: marker.attempt?.id, at: new Date().toISOString() },
          }),
        );
      }
      const flow = await savedMove(f, 'send');
      await assert.rejects(completeSignIn(signIn, flow.flowId, 'unsettled'), /refresh.*unresolved|unresolved.*refresh/);
      const unchanged = await f.h.core.config.load();
      assert.equal(unchanged.accounts[alias]?.secretRef, source.secretRef);
      assert.equal(unchanged.accounts[alias]?.mode, 'read');
      assert.equal(unchanged.pendingRevocations, undefined);
      assert.equal(staged.length, 1);
      assert.equal(await real.get(present(staged[0])), null);
      assert.deepEqual(revoked, [], 'stale stored tokens must not be reported as the whole old app credential');

      // The existing account remains the owner while its process retains the newer result. Once persistence
      // recovers, normal settlement makes those exact issued tokens durable before another move can retire them.
      failPersistence = false;
      assert.deepEqual(await settleRefreshes(5000), []);
      const settled = parseBundle(await real.get(source.secretRef), slackHandoffs());
      assert.equal(settled?.state, 'ready');
      assert.equal(settled?.accessToken, 'fake-retained-access');
      assert.equal(settled?.refreshToken, 'fake-retained-refresh');
      const retry = await completeSignIn(signIn, (await savedMove(f, 'send')).flowId, 'settled');
      assert.equal(retry.cleanup?.cleaned, true);
      assert.deepEqual(revoked, ['Bearer fake-retained-access', 'Bearer fake-retained-refresh']);
      assert.equal(await real.get(source.secretRef), null);
      assert.equal((await f.h.core.config.load()).pendingRevocations, undefined);
    } finally {
      // Keep the module's retained-result registry clean even when running this test against the broken guard.
      failPersistence = false;
      await settleRefreshes(5000);
    }
  });
}
