import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { test } from 'node:test';
import {
  type AccountConfig,
  applyNamesMigration,
  CommsError,
  type ConfigV2,
  planNamesMigration,
  renameEntry,
  resolveName,
  retargetFormerNames,
  type SecretStore,
} from '@agentcomms/core';
import { SlackContext } from '../src/context.ts';
import { scopesForMode } from '../src/manifest.ts';
import { finishSignIn, type StartedSignIn, startSignIn } from '../src/operations/signin.ts';
import { removeWorkspace, requireWorkspace } from '../src/operations/workspaces.ts';
import { type Harness, newHarness, slackOk, TEST_CLIENT_ID } from './support/harness.ts';

/**
 * Organisation/platform names through the Slack package.
 *
 * This release cannot write version 2 through any API, by design, so each test writes its migrated config straight to
 * the file with core's own plan and transform — exactly what `agentcomms names migrate` will write.
 */

function is(code: string, pattern?: RegExp) {
  return (error: unknown) =>
    error instanceof CommsError && error.code === code && (pattern === undefined || pattern.test(error.message));
}

async function migrate(harness: Harness, renames: string[] = []): Promise<void> {
  const current = await harness.core.config.load();
  const plan = planNamesMigration(current, renames);
  if (plan.status !== 'ready' || current.version !== 1) throw new Error('already migrated');
  await writeFile(harness.core.config.path, `${JSON.stringify(applyNamesMigration(current, plan.rows), null, 2)}\n`);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((settle) => server.listen(0, 'localhost', () => settle()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((settle) => server.close(() => settle()));
  return port;
}

async function redirectTo(authUrl: string): Promise<void> {
  const url = new URL(authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  await fetch(back);
}

function contextFor(harness: Harness): SlackContext {
  return new SlackContext({ core: harness.core, env: harness.env, exchange: (params) => harness.exchange(params) });
}

function expectFor(account: AccountConfig) {
  return {
    accountId: account.id,
    workspaceId: account.workspace,
    userId: account.userId,
    oauthClientId: account.oauthClientId,
    appId: account.appId,
  };
}

async function reauthStart(context: SlackContext, alias: string, account: AccountConfig): Promise<StartedSignIn> {
  return startSignIn(context, {
    mode: 'read',
    alias,
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
    expect: expectFor(account),
  });
}

async function finish(started: StartedSignIn) {
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  await redirectTo(started.authUrl);
  try {
    return await listener.result;
  } finally {
    await listener.close();
  }
}

test('after the migration, a reauth carries the workspace’s former names to its new id', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live' });
  await migrate(harness, ['live=cue/slack']);

  const view = await finish(await reauthStart(context, 'cue/slack', original));
  assert.equal(view.alias, 'cue/slack');

  const config = (await harness.core.config.load()) as ConfigV2;
  const renewed = config.accounts['cue/slack'];
  assert.ok(renewed && renewed.id !== original.id, 'reauth mints a new id');
  assert.equal(config.formerNames.accounts.live?.id, renewed.id);
  // So the old name still says what it is called now — not that it was removed.
  assert.throws(() => resolveName(config, 'account', 'live'), is('NOT_FOUND', /renamed to "cue\/slack"$/));
});

test('a reauth started before the migration and finished after it follows the workspace to its new name', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live' });
  const started = await reauthStart(context, 'live', original);
  await migrate(harness, ['live=cue/slack']);

  const view = await finish(started);
  assert.equal(view.alias, 'cue/slack');
  const config = (await harness.core.config.load()) as ConfigV2;
  assert.deepEqual(Object.keys(config.accounts), ['cue/slack'], 'the old name was not put back');
  assert.equal(config.formerNames.accounts.live?.id, config.accounts['cue/slack']?.id);
  // And the superseded credential is gone.
  const secrets = await harness.core.secrets('file');
  assert.equal(await secrets.get(original.secretRef), null);
});

test('the credential deleted after a reauth is the one the replaced row held under the lock, not the snapshot’s', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'acme' });
  const real = await harness.core.secrets('file');
  // Between the snapshot and the write, the same account's credential moves to another reference.
  let moved = false;
  const store: SecretStore = {
    ...real,
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      if (moved) return;
      moved = true;
      await real.set('slack/token/moved', 'the same account, stored elsewhere');
      await harness.core.config.update((config) => {
        const held = config.accounts.acme as AccountConfig;
        return { ...config, accounts: { acme: { ...held, secretRef: 'slack/token/moved' } } };
      });
    },
  };
  context.secrets = async () => store;
  await finish(await reauthStart(context, 'acme', original));
  assert.equal(await real.get('slack/token/moved'), null, 'the reference the replaced row held was deleted');
});

test('finishing a reauth by name: the current name finishes it, a former one is refused with the current', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live' });
  const started = await reauthStart(context, 'live', original);
  await migrate(harness, ['live=cue/slack']);
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  const url = new URL(started.authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  try {
    await assert.rejects(
      finishSignIn(context, { flowId: started.flowId, expectAlias: 'live', url: back.href }),
      is('NOT_FOUND', /renamed to "cue\/slack"/),
    );
    const view = await finishSignIn(context, { flowId: started.flowId, expectAlias: 'cue/slack', url: back.href });
    assert.equal(view.alias, 'cue/slack');
  } finally {
    await listener.close();
  }
});

test('a former name is refused with the new one when a workspace is looked up', async () => {
  const harness = await newHarness();
  await harness.addWorkspace({ alias: 'live' });
  await migrate(harness, ['live=cue/slack']);
  const config = await harness.core.config.load();
  assert.throws(() => requireWorkspace(config, 'live'), is('NOT_FOUND', /renamed to "cue\/slack"/));
  assert.equal(requireWorkspace(config, 'cue/slack').alias, 'cue/slack');
});

test('on a migrated config, a new workspace needs an organisation/slack name that nothing ever had', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  await harness.addWorkspace({ alias: 'live' });
  await migrate(harness, ['live=cue/slack']);
  const start = async (alias: string) =>
    startSignIn(context, { mode: 'read', alias, clientId: TEST_CLIENT_ID, port: await freePort(), detached: false });

  await assert.rejects(start('rgc'), is('USAGE', /acme\/slack/));
  await assert.rejects(start('rgc/gmail'), is('USAGE', /ends in \/gmail/));
  await assert.rejects(start('cue/slack'), is('CONFIG', /already connected/));

  // A former name that is valid version-2 syntax — the only kind whose reuse the grammar alone would not stop.
  const renamed = renameEntry((await harness.core.config.load()) as ConfigV2, 'account', 'cue/slack', 'cue/slack-main');
  await writeFile(harness.core.config.path, `${JSON.stringify(renamed, null, 2)}\n`);
  await assert.rejects(start('cue/slack'), is('CONFIG', /cannot be used again/));

  harness.reply = () => slackOk({ team: { id: 'T0002', name: 'RGC' }, authed_user: { id: 'U0002' } });
  const view = await finish(await start('rgc/slack'));
  assert.equal(view.alias, 'rgc/slack');
});

test('a renewal landing between the snapshot and the write is caught under the lock', async () => {
  // Another sign-in renews the workspace while this one is storing its credential: after every check made on a
  // snapshot, before the write. Only the check inside the lock can see it.
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'acme' });
  const real = await harness.core.secrets('file');
  let renewed = false;
  const meddling: SecretStore = {
    ...real,
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      if (renewed) return;
      renewed = true;
      await harness.core.config.update((config) => {
        const held = config.accounts.acme as AccountConfig;
        return {
          ...config,
          accounts: { acme: { ...held, id: 'acc_ZZZZZZZZZZZZZZZZ', secretRef: 'slack/token/other' } },
        };
      });
    },
  };
  context.secrets = async () => meddling;
  await assert.rejects(finish(await reauthStart(context, 'acme', original)), is('CONFIG', /changed while/));
  assert.equal((await harness.core.config.load()).accounts.acme?.id, 'acc_ZZZZZZZZZZZZZZZZ');
});

test('removal finds the workspace by id, whatever it is called by the time it writes', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'acme' });
  const secrets = await context.secrets();
  // The key changes between removal's read and its write — here from inside the secret deletion that sits between.
  const store: SecretStore = {
    ...secrets,
    kind: secrets.kind,
    get: (ref) => secrets.get(ref),
    set: (ref, value) => secrets.set(ref, value),
    invalidate: (ref) => secrets.invalidate(ref),
    async delete(ref: string) {
      const deleted = await secrets.delete(ref);
      await harness.core.config.update((config) => {
        const { acme, ...rest } = config.accounts;
        return { ...config, accounts: { ...rest, 'acme-renamed': acme as AccountConfig } };
      });
      return deleted;
    },
  };
  const removed = await removeWorkspace(
    {
      config: await context.config(),
      secrets: store,
      update: (mutator) => harness.core.config.update(mutator),
    },
    'acme',
  );
  assert.equal(removed.accountId, original.id);
  assert.deepEqual((await harness.core.config.load()).accounts, {});
});

test('a reauth that followed a rename, whose write committed and then reported failure, keeps its credential', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live' });
  const started = await reauthStart(context, 'live', original);
  await migrate(harness, ['live=cue/slack']);

  // The write lands; the call rejects anyway, as a failed lock release does.
  const update = harness.core.config.update.bind(harness.core.config);
  let armed = true;
  harness.core.config.update = (async (mutator, options) => {
    const result = await update(mutator, options);
    if (!armed) return result;
    armed = false;
    throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
  }) as typeof harness.core.config.update;

  const view = await finish(started);
  assert.equal(view.alias, 'cue/slack');
  const account = (await harness.core.config.load()).accounts['cue/slack'];
  const secrets = await harness.core.secrets('file');
  assert.ok(account && (await secrets.get(account.secretRef)), 'the credential the config names is still there');
});

test('a read → send reauth approved before the migration is still approved after it', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live', mode: 'read' });
  // The person typed the challenge for `accounts.live.mode`, before the rename.
  const started = await startSignIn(context, {
    mode: 'send',
    alias: 'live',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
    expect: expectFor(original),
    consent: { kind: 'loosening-consent', paths: ['accounts.live.mode'] },
  });
  await migrate(harness, ['live=cue/slack']);
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const view = await finish(started);
  assert.equal(view.alias, 'cue/slack');
  assert.equal((await harness.core.config.load()).accounts['cue/slack']?.mode, 'send');
});

test('finishing by the current name after a rename and a renewal is refused as changed, not as a usage error', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live' });
  const started = await reauthStart(context, 'live', original);
  await migrate(harness, ['live=cue/slack']);
  // Another sign-in renews it meanwhile: same person, same workspace, new id — its former names carried along.
  const renewed = (await harness.core.config.load()) as ConfigV2;
  const next = retargetFormerNames(renewed, 'account', original.id, 'acc_RRRRRRRRRRRRRRRR');
  const account = next.accounts['cue/slack'] as AccountConfig;
  await writeFile(
    harness.core.config.path,
    `${JSON.stringify({ ...next, accounts: { 'cue/slack': { ...account, id: 'acc_RRRRRRRRRRRRRRRR' } } }, null, 2)}\n`,
  );
  const listener = started.listener as NonNullable<StartedSignIn['listener']>;
  const url = new URL(started.authUrl);
  const back = new URL(url.searchParams.get('redirect_uri') as string);
  back.searchParams.set('state', url.searchParams.get('state') as string);
  back.searchParams.set('code', 'fake-authorisation-code');
  try {
    await assert.rejects(
      finishSignIn(context, { flowId: started.flowId, expectAlias: 'cue/slack', url: back.href }),
      is('CONFIG', /changed while this sign-in was being completed/),
    );
  } finally {
    await listener.close();
  }
});

test('an approved widening survives a migration that lands while its credential is being written', async () => {
  const harness = await newHarness();
  const context = contextFor(harness);
  const original = await harness.addWorkspace({ alias: 'live', mode: 'read' });
  // After every snapshot this sign-in reads, before its config write: the rename happens mid-credential-write.
  const real = await harness.core.secrets('file');
  let migrated = false;
  context.secrets = async () => ({
    ...real,
    kind: real.kind,
    get: (ref) => real.get(ref),
    delete: (ref) => real.delete(ref),
    invalidate: (ref) => real.invalidate(ref),
    async set(ref: string, value: string) {
      await real.set(ref, value);
      if (migrated) return;
      migrated = true;
      await migrate(harness, ['live=cue/slack']);
    },
  });
  const started = await startSignIn(context, {
    mode: 'send',
    alias: 'live',
    clientId: TEST_CLIENT_ID,
    port: await freePort(),
    detached: false,
    expect: expectFor(original),
    consent: { kind: 'loosening-consent', paths: ['accounts.live.mode'] },
  });
  harness.reply = () => slackOk({ scopes: scopesForMode('send') });
  const view = await finish(started);
  assert.equal(view.alias, 'cue/slack');
  assert.equal((await harness.core.config.load()).accounts['cue/slack']?.mode, 'send');
});
