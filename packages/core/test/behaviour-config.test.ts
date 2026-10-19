import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedAct, readBehaviourSettings } from '../src/behaviour.ts';
import { renderChangePreview } from '../src/changes.ts';
import { type Config, ConfigStore, changedSettings, classifyChange, parseConfig } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { renameEntry } from '../src/names.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task 2 of the behaviour rules (design 2026-10-19-agent-behaviour-rules, B3 and B5): `config.json` carries `behaviour`
 * at its top level beside `agentLabel`, every write keeps it, and `classifyChange` judges it — a change that lets an agent
 * do more anywhere is a loosening a person approves; one that only narrows applies at once. A rule binds to its
 * account's id, so a rename, which needs no approval, keeps it.
 */

const CREATED = '2026-09-20T00:00:00.000Z';
const GMAIL_ID = 'ibx_AAAAAAAAAAAAAAAA';
const SLACK_ID = 'acc_AAAAAAAAAAAAAAAA';
const NEW_SLACK_ID = 'acc_NNNNNNNNNNNNNNNN';
const GONE_ID = 'acc_GGGGGGGGGGGGGGGG';

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
const account = {
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

function body(behaviour?: unknown, version: 1 | 2 | 3 = 2): Record<string, unknown> {
  const names = version === 1 ? { gmail: 'acme', slack: 'acme' } : { gmail: 'acme/gmail', slack: 'acme/slack' };
  return {
    version,
    ...(version === 3 ? { naming: 2 } : {}),
    inboxes: { [names.gmail]: inbox },
    accounts: version === 1 ? {} : { [names.slack]: account },
    ...(behaviour === undefined ? {} : { behaviour }),
  };
}

function store(behaviour?: unknown, version: 1 | 2 | 3 = 2): { store: ConfigStore; file: string } {
  const dir = join(tempDir('comms-behaviour-config-'), 'config');
  mkdirSync(dir);
  const file = join(dir, 'config.json');
  writeFileSync(file, `${JSON.stringify(body(behaviour, version), null, 2)}\n`);
  return { store: new ConfigStore(dir), file };
}

const config = (behaviour?: unknown): Config => parseConfig(JSON.stringify(body(behaviour)));

/** `config` with `behaviour` replaced, and nothing else touched. */
const withBehaviour = (base: Config, behaviour: unknown): Config => ({ ...structuredClone(base), behaviour }) as Config;

const stored = (file: string): unknown => (JSON.parse(readFileSync(file, 'utf8')) as { behaviour?: unknown }).behaviour;

const slackRule = (acts: string[], conversation?: string) => ({
  account: 'acme/slack',
  accountId: SLACK_ID,
  ...(conversation === undefined ? {} : { conversation }),
  acts,
});
const gmailRule = (acts: string[], conversation?: string) => ({
  account: 'acme/gmail',
  accountId: GMAIL_ID,
  ...(conversation === undefined ? {} : { conversation }),
  acts,
});

test('a loosened behaviour rule is a loosening classifyChange reports', () => {
  const before = config({ rules: [slackRule(['reply'])] });
  // An act added.
  const added = classifyChange(before, withBehaviour(before, { rules: [slackRule(['reply', 'post'])] }));
  assert.deepEqual(added.loosened, ['behaviour.rules']);
  // Each level that moved, by the account's name and the conversation, before → after; no `id`, since the rules
  // belong to the whole configuration.
  assert.deepEqual(added.changes, [
    { path: 'behaviour.rules', before: { 'acme/slack': 'reply' }, after: { 'acme/slack': 'post, reply' } },
  ]);
  // A rule removed: everything, where the account had a rule.
  assert.deepEqual(classifyChange(before, withBehaviour(before, { rules: [] })).changes, [
    { path: 'behaviour.rules', before: { 'acme/slack': 'reply' }, after: { 'acme/slack': 'everything' } },
  ]);
  // So is the whole setting removed.
  assert.deepEqual(classifyChange(before, withBehaviour(before, undefined)).loosened, ['behaviour.rules']);
  // A conversation rule wider than its account's, named with its conversation; the levels that only narrowed are listed
  // too, so the person reads the whole change.
  const wider = classifyChange(
    before,
    withBehaviour(before, { rules: [slackRule([]), slackRule(['post', 'reply'], 'C0GENERAL')] }),
  );
  assert.deepEqual(wider.changes, [
    {
      path: 'behaviour.rules',
      before: { 'acme/slack': 'reply', 'acme/slack C0GENERAL': 'reply' },
      after: { 'acme/slack': 'nothing', 'acme/slack C0GENERAL': 'post, reply' },
    },
  ]);
  // An unreadable rule mended lets its account do more: a loosening too.
  const broken = config({ rules: [{ account: 'acme/slack', accountId: SLACK_ID, acts: 'reply' }] });
  assert.deepEqual(classifyChange(broken, withBehaviour(broken, { rules: [slackRule(['reply'])] })).loosened, [
    'behaviour.rules',
  ]);
});

test('a loosened behaviour rule reads, in a change preview, as each level before → after', () => {
  const before = config({ rules: [slackRule(['reply'])] });
  const after = withBehaviour(before, { rules: [slackRule(['reply', 'post']), gmailRule(['send'], '@client.test')] });
  const loosened = classifyChange(before, after).changes;
  const preview = renderChangePreview({
    approvalId: 'ap_00000000000000000000000000',
    requiredPolicy: 'chat',
    change: { summary: 'test', target: null, loosened, settings: changedSettings(before, after), effects: [] },
  });
  assert.match(
    preview,
    /what an agent may do: acme\/gmail @client\.test: everything → send; acme\/slack: reply → post, reply — /,
  );
  assert.doesNotMatch(preview, /\[object Object\]/);
  assert.doesNotMatch(preview, /acc_|ibx_/, 'an account id is no name a person knows');
});

test('a tightened rule is not', () => {
  const none = config();
  // The first rule ever added narrows from everything.
  assert.deepEqual(
    classifyChange(none, withBehaviour(none, { rules: [slackRule(['reply', 'reaction'])] })).loosened,
    [],
  );
  const before = config({ rules: [slackRule(['reply', 'reaction'])] });
  for (const rules of [
    [slackRule(['reply'])],
    [slackRule([])],
    [slackRule(['reply', 'reaction']), slackRule(['reply'], 'C0GENERAL')],
    [slackRule(['reply', 'reaction']), gmailRule(['reply'])],
  ]) {
    assert.deepEqual(classifyChange(before, withBehaviour(before, { rules })).loosened, [], JSON.stringify(rules));
  }
  // A rule this release cannot read narrows its account to nothing: it tightens, whatever it says.
  assert.deepEqual(
    classifyChange(before, withBehaviour(before, { rules: [{ account: 'acme/slack', acts: 'everything' }] })).loosened,
    [],
  );
});

test('a change approval binds the behaviour rules a change writes, tightenings too', () => {
  const before = config({ rules: [slackRule(['reply', 'reaction'])] });
  const after = withBehaviour(before, { rules: [slackRule(['reply'])] });
  assert.deepEqual(classifyChange(before, after).loosened, []);
  // Raw, as the file holds them, ids and all: what an approval binds is what is written.
  assert.deepEqual(
    changedSettings(before, after).filter((setting) => setting.path.startsWith('behaviour.')),
    [{ path: 'behaviour.rules', before: [slackRule(['reply', 'reaction'])], after: [slackRule(['reply'])] }],
  );
  assert.deepEqual(
    changedSettings(config(), config({ rules: [] })).filter((setting) => setting.path.startsWith('behaviour.')),
    [{ path: 'behaviour.rules', before: null, after: [] }],
  );
  assert.deepEqual(
    changedSettings(config(), config()).filter((setting) => setting.path.startsWith('behaviour.')),
    [],
  );
});

test('ConfigStore.update refuses a loosened rule without consent, and takes a tightened one at once', async () => {
  const { store: configs, file } = store({ rules: [slackRule(['reply'])] });
  await assert.rejects(
    configs.update((c) => withBehaviour(c, { rules: [slackRule(['reply', 'post'])] })),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'LOOSENING_REFUSED');
      assert.match(error.message, /behaviour\.rules/);
      return true;
    },
  );
  assert.deepEqual(stored(file), { rules: [slackRule(['reply'])] });
  await configs.update((c) => withBehaviour(c, { rules: [slackRule([])] }));
  assert.deepEqual(stored(file), { rules: [slackRule([])] });
  await configs.update((c) => withBehaviour(c, { rules: [slackRule(['reply'])] }), {
    consent: { kind: 'loosening-consent', paths: ['behaviour.rules'] },
  });
  assert.deepEqual(readBehaviourSettings(await configs.load()).rules, [slackRule(['reply'])]);
});

/** The rename every surface makes — `gmail_inbox_rename` and `agent-gmail inbox rename` — which no person approves. */
async function renamed(behaviour: unknown): Promise<{ config: Config; file: string }> {
  const { store: configs, file } = store(behaviour);
  await configs.update((c) => renameEntry(c, 'inbox', 'acme/gmail', 'acme/gmail-main'));
  const config = await configs.load();
  assert.deepEqual(Object.keys(config.inboxes), ['acme/gmail-main']);
  return { config, file };
}

const sendFrom = (config: Config, recipient: string) =>
  allowedAct(config, { accountId: GMAIL_ID, account: 'acme/gmail-main', places: [[recipient]], acts: ['send'] });

test('a rename keeps the rule', async () => {
  const orphan = { account: 'acme/gmail', accountId: GONE_ID, conversation: '@partner.test', acts: [] };
  const { config: after, file } = await renamed({ rules: [gmailRule(['reply']), orphan], later: { kept: true } });
  // Bound by id: still refused under the new name.
  assert.deepEqual(sendFrom(after, 'bob@client.test'), {
    allowed: false,
    act: 'send',
    place: 'bob@client.test',
    rule: { account: 'acme/gmail-main' },
    allowedActs: ['reply'],
  });
  // An orphan, which holds the mailbox by its name, is renamed with it, so it holds it still.
  assert.deepEqual(sendFrom(after, 'ann@partner.test'), {
    allowed: false,
    act: 'send',
    place: 'ann@partner.test',
    rule: { account: 'acme/gmail-main', conversation: '@partner.test' },
    allowedActs: [],
  });
  // The rules carry the name the person knows now, and every other key of the setting is kept.
  assert.deepEqual(stored(file), {
    rules: [
      { ...gmailRule(['reply']), account: 'acme/gmail-main' },
      { ...orphan, account: 'acme/gmail-main' },
    ],
    later: { kept: true },
  });
  // And the old name rules nothing.
  assert.equal(
    allowedAct(after, { accountId: 'ibx_OTHEROTHEROTHER', account: 'acme/gmail', places: [], acts: ['send'] }).allowed,
    true,
  );
});

test('a rename keeps an unreadable rule holding the mailbox, by name or by id', async () => {
  const byName = { account: 'acme/gmail', conversation: '@other.test', acts: 'none' };
  const named = await renamed({ rules: [byName] });
  assert.equal(sendFrom(named.config, 'bob@client.test').allowed, false);
  assert.deepEqual(stored(named.file), { rules: [{ ...byName, account: 'acme/gmail-main' }] });
  const byId = { account: 'acme/gmail', accountId: GMAIL_ID, acts: 'none' };
  const bound = await renamed({ rules: [byId] });
  assert.equal(sendFrom(bound.config, 'bob@client.test').allowed, false);
});

test('a rename leaves a rule bound to another account alone, and judges as no change', () => {
  // Bound by id to the workspace, though it carries the mailbox's name.
  const elsewhere = { account: 'acme/gmail', accountId: SLACK_ID, acts: ['reply'] };
  const before = config({ rules: [gmailRule(['reply']), elsewhere] });
  const after = renameEntry(before, 'inbox', 'acme/gmail', 'acme/gmail-main');
  assert.deepEqual((after.behaviour as { rules: unknown[] }).rules, [
    { ...gmailRule(['reply']), account: 'acme/gmail-main' },
    elsewhere,
  ]);
  assert.deepEqual(
    classifyChange(before, after).changes.filter((change) => change.path.startsWith('behaviour.')),
    [],
  );
  // Nothing to rename: the setting is left exactly as it was, absent or not.
  assert.equal('behaviour' in renameEntry(config(), 'inbox', 'acme/gmail', 'acme/gmail-main'), false);
  const odd = config('off');
  assert.equal(renameEntry(odd, 'inbox', 'acme/gmail', 'acme/gmail-main').behaviour, 'off');
});

test('connecting an account under an orphaned rule, or removing one, needs nobody', async () => {
  // The workspace's rule outlived it: removed, the rule is an orphan, and a workspace connected under the name is held.
  const { store: configs } = store({ rules: [slackRule(['reply'])] });
  await configs.update((c) => ({ ...c, accounts: {} }));
  // Connected to read, as a widening of its mode would wait for a person whatever the rules say.
  const reading = { ...account, id: NEW_SLACK_ID, tier: 'read', mode: 'read' };
  await configs.update((c) => ({ ...c, accounts: { 'acme/slack': reading } }) as Config);
  const reconnected = await configs.load();
  assert.equal(
    allowedAct(reconnected, { accountId: NEW_SLACK_ID, account: 'acme/slack', places: [['C0GENERAL']], acts: ['post'] })
      .allowed,
    false,
  );
});

test("older releases' loose schema keeps behaviour through a write", async () => {
  const behaviour = {
    rules: [{ account: 'acme', accountId: GMAIL_ID, conversation: 'bob@client.test', acts: ['reply', 'later-act'] }],
    defaults: { from: 'a later release' },
  };
  for (const version of [1, 2, 3] as const) {
    const { store: configs, file } = store(behaviour, version);
    const loaded = await configs.load();
    assert.deepEqual(loaded.behaviour, behaviour, `version ${version} reads it`);
    // An unrelated write — the timezone — keeps every key of it, as written.
    await configs.update((c) => ({ ...c, defaults: { ...c.defaults, timezone: 'Europe/London' } }));
    const written = JSON.parse(readFileSync(file, 'utf8')) as { behaviour?: unknown; defaults: { timezone: string } };
    assert.equal(written.defaults.timezone, 'Europe/London', `version ${version}`);
    assert.deepEqual(written.behaviour, behaviour, `version ${version} keeps it`);
  }
});
