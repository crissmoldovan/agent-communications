import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { liveGateOf } from '../src/approval-outcome.ts';
import { type AccountConfig, type Config, classifyChange, parseConfig, standingEpochOf } from '../src/config.ts';
import { openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { raiseStandingEpoch } from '../src/standing.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The standing epoch (design 2026-10-19-standing-approvals, S8): one number for the whole configuration that
 * `standing off` and every tightening of a change policy raise, and that nothing lowers. A standing approval binds it
 * when it is made; one whose epoch is not the live one has ended, and loosening again revives nothing.
 */

const ACME = 'acc_AAAAAAAAAAAAAAAA';
const BETA = 'acc_BBBBBBBBBBBBBBBB';
const MAIL = 'ibx_AAAAAAAAAAAAAAAA';

/** A version-3 machine with two Slack accounts and a mailbox, every policy `chat`, and a core over it. */
function machine(state: Parameters<typeof liveConfig>[1] = {}) {
  const home = tempDir('comms-standing-epoch-');
  const config = liveConfig(home, {
    accounts: { 'acme/slack': { id: ACME }, 'beta/slack': { id: BETA } },
    inboxes: { 'acme/gmail': { id: MAIL } },
    ...state,
  });
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: config.dir, AGENT_COMMS_UPDATE_CHECK: 'off' };
  return { config, core: openCore({ env, caller: CORE_CALLER }) };
}

const epochNow = async (core: ReturnType<typeof openCore>) => standingEpochOf(await core.config.load());

test('tightening the default change policy raises the standing epoch', async () => {
  const { core } = machine();
  assert.equal(await epochNow(core), 0, 'absent reads as 0');
  const written = await core.config.update((config) => {
    config.defaults.changePolicy = 'confirm';
    return config;
  });
  assert.equal(standingEpochOf(written), 1);
  assert.equal(await epochNow(core), 1);
  // A write that tightens nothing leaves it where it is.
  await core.config.update((config) => config);
  assert.equal(await epochNow(core), 1);
});

test("tightening one account's change policy raises it, and so does a mailbox's", async () => {
  const { core } = machine();
  await core.config.update((config) => {
    (config.accounts['beta/slack'] as AccountConfig).changePolicy = 'confirm';
    return config;
  });
  assert.equal(await epochNow(core), 1, 'an account');
  await core.config.update((config) => {
    const inbox = config.inboxes['acme/gmail'];
    if (inbox) inbox.changePolicy = 'confirm';
    return config;
  });
  assert.equal(await epochNow(core), 2, 'a mailbox');
  // Two tightenings in one write are one raise: the epoch says that standing approvals ended, not how often.
  const { core: both } = machine();
  await both.config.update((config) => {
    (config.accounts['acme/slack'] as AccountConfig).changePolicy = 'confirm';
    config.defaults.changePolicy = 'confirm';
    return config;
  });
  assert.equal(await epochNow(both), 1);
});

test('an account whose own policy keeps it at chat while the default tightens still raises it: the default moved', async () => {
  const { core } = machine({ accounts: { 'acme/slack': { id: ACME, changePolicy: 'chat' } } });
  await core.config.update((config) => {
    config.defaults.changePolicy = 'confirm';
    return config;
  });
  assert.equal(await epochNow(core), 1);
});

test('loosening a change policy raises nothing', async () => {
  const { core } = machine({ changePolicy: 'confirm' });
  const looser = (config: Config): Config => {
    config.defaults.changePolicy = 'chat';
    return config;
  };
  const before = await core.config.load();
  const { loosened } = classifyChange(before, looser(structuredClone(before)));
  assert.ok(loosened.includes('defaults.changePolicy'), 'a loosening, consented to');
  await core.config.update(looser, { consent: { kind: 'loosening-consent', paths: loosened } });
  assert.equal(await epochNow(core), 0);
  // An account brought back from confirm to chat raises nothing either, nor does a new account added under confirm.
  const { core: other } = machine({ accounts: { 'acme/slack': { id: ACME, changePolicy: 'confirm' } } });
  await other.config.update(
    (config) => {
      (config.accounts['acme/slack'] as AccountConfig).changePolicy = 'chat';
      return config;
    },
    { consent: { kind: 'loosening-consent', paths: ['accounts.acme/slack.changePolicy'] } },
  );
  assert.equal(await epochNow(other), 0);
});

test('a write carrying a lower epoch keeps the higher one', async () => {
  const { core } = machine();
  await raiseStandingEpoch(core);
  await raiseStandingEpoch(core);
  assert.equal(await epochNow(core), 2);
  await core.config.update((config) => ({ ...config, standingEpoch: 0 }) as Config);
  assert.equal(await epochNow(core), 2, 'never lowered');
  await core.config.update((config) => {
    const { standingEpoch: _dropped, ...rest } = config as Config & { standingEpoch?: number };
    return rest as Config;
  });
  assert.equal(await epochNow(core), 2, 'nor dropped');
  // A higher one a later release wrote is kept.
  await core.config.update((config) => ({ ...config, standingEpoch: 9 }) as Config);
  assert.equal(await epochNow(core), 9);
});

test('raiseStandingEpoch adds one, and classifyChange reports no loosening for it', async () => {
  const { core } = machine();
  const before = await core.config.load();
  assert.equal(await raiseStandingEpoch(core), 1);
  assert.equal(await raiseStandingEpoch(core), 2);
  const after = await core.config.load();
  assert.equal(standingEpochOf(after), 2);
  assert.deepEqual(classifyChange(before, after), { loosened: [], changes: [] });
  // Nothing else in the file moved.
  const { standingEpoch: _raised, ...rest } = after as Config & { standingEpoch?: number };
  assert.deepEqual(rest, before);
});

test("a config with standingEpoch parses and survives a write that doesn't name it", async () => {
  const { config, core } = machine();
  const raw = JSON.parse(readFileSync(config.store.path, 'utf8')) as Record<string, unknown>;
  writeFileSync(config.store.path, `${JSON.stringify({ ...raw, standingEpoch: 4 }, null, 2)}\n`);
  assert.equal(standingEpochOf(parseConfig(readFileSync(config.store.path, 'utf8'))), 4);
  await core.config.update((current) => {
    (current.accounts['acme/slack'] as AccountConfig).sendPolicy = 'chat';
    return current;
  });
  assert.equal(await epochNow(core), 4);
  // Malformed, it is refused rather than read as some other number.
  writeFileSync(config.store.path, `${JSON.stringify({ ...raw, standingEpoch: -1 }, null, 2)}\n`);
  assert.throws(() => parseConfig(readFileSync(config.store.path, 'utf8')));
  writeFileSync(config.store.path, `${JSON.stringify({ ...raw, standingEpoch: 1.5 }, null, 2)}\n`);
  assert.throws(() => parseConfig(readFileSync(config.store.path, 'utf8')));
});

test('the live gate carries the standing epoch for every record', async () => {
  const { core } = machine();
  await raiseStandingEpoch(core);
  const config = await core.config.load();
  const present = liveGateOf(config, { kind: 'send', ownerScope: 'owner', inboxId: ACME, change: undefined });
  assert.equal(present.standingEpoch, 1);
  const removed = liveGateOf(config, {
    kind: 'send',
    ownerScope: 'owner',
    inboxId: 'acc_ZZZZZZZZZZZZZZZZ',
    change: undefined,
  });
  assert.equal(removed.owner, 'removed');
  assert.equal(removed.standingEpoch, 1);
  const global = liveGateOf(config, { kind: 'change', ownerScope: 'global', inboxId: '', change: undefined });
  assert.equal(global.standingEpoch, 1);
});
