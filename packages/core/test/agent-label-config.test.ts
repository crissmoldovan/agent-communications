import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { agentLabelOf, resolveIdentity } from '../src/agent-label.ts';
import { renderChangePreview } from '../src/changes.ts';
import { type Config, ConfigStore, changedSettings, classifyChange, parseConfig } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { renameEntry } from '../src/names.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * Task A1 of the agent label (design 2026-10-15-agent-label, L5): `config.json` carries `agentLabel` at its top level,
 * every write keeps it, and `classifyChange` judges it with the contract's `classifyAgentLabelChange` — a change that
 * could leave a message unlabelled, or that changes how the label looks, is a loosening; adding an `agent` rule or
 * removing a `me` rule is not.
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
const account = {
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

const RULES = [
  { account: 'acme/slack', as: 'me' },
  { account: 'acme/slack', conversation: 'C0ACME', kinds: ['post', 'reply'], as: 'agent' },
  { account: 'acme/gmail', conversation: '@acme.test', as: 'me' },
];

function body(agentLabel?: unknown): Record<string, unknown> {
  return {
    version: 2,
    inboxes: { 'acme/gmail': inbox },
    accounts: { 'acme/slack': account },
    ...(agentLabel === undefined ? {} : { agentLabel }),
  };
}

function store(agentLabel?: unknown): { store: ConfigStore; file: string } {
  const dir = join(tempDir('comms-label-config-'), 'config');
  mkdirSync(dir);
  const file = join(dir, 'config.json');
  writeFileSync(file, `${JSON.stringify(body(agentLabel), null, 2)}\n`);
  return { store: new ConfigStore(dir), file };
}

const config = (agentLabel?: unknown): Config => parseConfig(JSON.stringify(body(agentLabel)));

/** `config` with `agentLabel` replaced, and nothing else touched. */
const withLabel = (base: Config, agentLabel: unknown): Config => ({ ...structuredClone(base), agentLabel }) as Config;

test('L5: agentLabel at the top of config.json survives a read and a write unchanged', async () => {
  const label = { word: 'twin', name: 'Jo Example', rules: RULES, slackIcons: { [account.id]: ':jo-agent:' } };
  const { store: configs, file } = store(label);
  const loaded = await configs.load();
  assert.deepEqual(loaded.agentLabel, label);
  // An unrelated write — the timezone — keeps every key of it, byte for byte as JSON.
  await configs.update((c) => ({ ...c, defaults: { ...c.defaults, timezone: 'Europe/London' } }));
  const written = JSON.parse(readFileSync(file, 'utf8')) as { agentLabel?: unknown; defaults: { timezone: string } };
  assert.equal(written.defaults.timezone, 'Europe/London');
  assert.deepEqual(written.agentLabel, label);
  // And a key inside it this release does not know is kept too: a later release's.
  const later = { ...label, quietHours: { from: '22:00' } };
  const { store: laterStore, file: laterFile } = store(later);
  await laterStore.update((c) => ({ ...c, defaults: { ...c.defaults, timezone: 'UTC' } }));
  assert.deepEqual((JSON.parse(readFileSync(laterFile, 'utf8')) as { agentLabel?: unknown }).agentLabel, later);
});

test('L5: adding a `me` rule is a loosening, listed as agentLabel.rules with what the rules were and will be', () => {
  const before = config({ rules: [RULES[1]] });
  const after = withLabel(before, { rules: [RULES[1], RULES[0]] });
  const { loosened, changes } = classifyChange(before, after);
  assert.deepEqual(loosened, ['agentLabel.rules']);
  // Rendered as the other settings' values are — a list of words — so a preview reads it, and an approval binds it.
  // No `id`: a label setting belongs to the whole configuration.
  assert.deepEqual(changes, [
    {
      path: 'agentLabel.rules',
      before: ['acme/slack in C0ACME for post/reply: agent'],
      after: ['acme/slack in C0ACME for post/reply: agent', 'acme/slack: me'],
    },
  ]);
});

test('L5: adding an `agent` rule, or removing a `me` rule, lists nothing', () => {
  const before = config({ rules: [RULES[0]] });
  assert.deepEqual(classifyChange(before, withLabel(before, { rules: [RULES[0], RULES[1]] })).loosened, []);
  assert.deepEqual(classifyChange(before, withLabel(before, { rules: [] })).loosened, []);
  assert.deepEqual(classifyChange(before, withLabel(before, {})).loosened, []);
});

test('L5: removing an `agent` rule, and every change of word, name or Slack icon, is a loosening', () => {
  const before = config({ word: 'agent', name: 'Jo Example', rules: [RULES[1]] });
  const cases: [unknown, string, unknown, unknown][] = [
    [{ word: 'agent', name: 'Jo Example', rules: [] }, 'agentLabel.rules', [RULES[1]].length, 0],
    [{ word: 'twin', name: 'Jo Example', rules: [RULES[1]] }, 'agentLabel.word', 'agent', 'twin'],
    [{ word: 'agent', name: 'Jo E', rules: [RULES[1]] }, 'agentLabel.name', 'Jo Example', 'Jo E'],
    [{ word: 'agent', rules: [RULES[1]] }, 'agentLabel.name', 'Jo Example', null],
    [
      { word: 'agent', name: 'Jo Example', rules: [RULES[1]], slackIcons: { [account.id]: ':jo-agent:' } },
      'agentLabel.slackIcons',
      {},
      { 'acme/slack': ':jo-agent:' },
    ],
  ];
  for (const [label, path, was, now] of cases) {
    const { loosened, changes } = classifyChange(before, withLabel(before, label));
    assert.deepEqual(loosened, [path], JSON.stringify(label));
    const [change] = changes;
    if (path === 'agentLabel.rules') {
      assert.equal((change?.before as string[] | undefined)?.length, was);
      assert.equal((change?.after as string[] | undefined)?.length, now);
    } else {
      assert.deepEqual(change?.before, was, path);
      assert.deepEqual(change?.after, now, path);
    }
  }
});

test('L5: a loosened label setting reads, in a change preview, as what it is', () => {
  const before = config({ rules: [] });
  const after = withLabel(before, { word: 'twin', rules: [RULES[0]] });
  const loosened = classifyChange(before, after).changes;
  const preview = renderChangePreview({
    approvalId: 'ap_00000000000000000000000000',
    requiredPolicy: 'chat',
    change: { summary: 'test', target: null, loosened, settings: changedSettings(before, after), effects: [] },
  });
  assert.match(preview, /the word after your name in the agent label: agent → twin/);
  assert.match(preview, /who each kind of message appears to come from: none → acme\/slack: me/);
  assert.doesNotMatch(preview, /\[object Object\]/);
});

test('L5: a change approval binds every label setting a change writes, tightenings too', () => {
  const before = config({ rules: [RULES[0]] });
  const after = withLabel(before, { rules: [RULES[0], RULES[1]] });
  assert.deepEqual(classifyChange(before, after).loosened, [], 'adding an agent rule tightens');
  const settings = changedSettings(before, after).filter((setting) => setting.path.startsWith('agentLabel.'));
  assert.deepEqual(settings, [{ path: 'agentLabel.rules', before: [RULES[0]], after: [RULES[0], RULES[1]] }]);
  // A configuration with no label settings on either side records none.
  assert.deepEqual(
    changedSettings(config(), config()).filter((setting) => setting.path.startsWith('agentLabel.')),
    [],
  );
});

test('L5: ConfigStore.update refuses a `me` rule added without consent, and takes an `agent` rule at once', async () => {
  const { store: configs, file } = store({ rules: [] });
  await assert.rejects(
    configs.update((c) => withLabel(c, { rules: [RULES[0]] })),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'LOOSENING_REFUSED');
      assert.match(error.message, /agentLabel\.rules/);
      return true;
    },
  );
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { agentLabel?: unknown }).agentLabel, { rules: [] });
  await configs.update((c) => withLabel(c, { rules: [RULES[1]] }));
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { agentLabel?: unknown }).agentLabel, {
    rules: [RULES[1]],
  });
  // With the person's consent for exactly that path, the `me` rule is written.
  await configs.update((c) => withLabel(c, { rules: [RULES[1], RULES[0]] }), {
    consent: { kind: 'loosening-consent', paths: ['agentLabel.rules'] },
  });
  assert.deepEqual(agentLabelOf(await configs.load()).rules, [RULES[1], RULES[0]]);
});

test('Slack style (2026-10-17): app to labelled loosens, and its preview says what it trades', () => {
  const before = config({});
  const after = withLabel(before, { slackStyles: { [account.id]: 'labelled' } });
  const { loosened, changes } = classifyChange(before, after);
  assert.deepEqual(loosened, ['agentLabel.slackStyles']);
  // By the workspace's name, as the person knows it: its id is bound by the settings the change writes, not shown.
  assert.deepEqual(changes, [
    { path: 'agentLabel.slackStyles', before: { 'acme/slack': 'app' }, after: { 'acme/slack': 'labelled' } },
  ]);
  const settings = changedSettings(before, after);
  assert.deepEqual(
    settings.filter((setting) => setting.path === 'agentLabel.slackStyles'),
    [{ path: 'agentLabel.slackStyles', before: null, after: { [account.id]: 'labelled' } }],
  );
  const preview = renderChangePreview({
    approvalId: 'ap_00000000000000000000000000',
    requiredPolicy: 'chat',
    change: { summary: 'test', target: null, loosened: changes, settings, effects: [] },
  });
  assert.match(preview, /how the agent’s Slack messages look in acme\/slack: app → labelled — /);
  assert.doesNotMatch(preview, /acc_/, 'an account id is no name a person knows');
  assert.match(preview, /trades Slack’s own APP tag, which no one can fake, for words in the message/);
  // A style this release cannot read is app, so labelled from it loosens just the same.
  assert.deepEqual(classifyChange(config({ slackStyles: { [account.id]: 'fancy' } }), after).loosened, [
    'agentLabel.slackStyles',
  ]);
});

test('Slack style: labelled to app is a tightening, and the approval of a change still binds it', async () => {
  const labelledBefore = config({ slackStyles: { [account.id]: 'labelled' } });
  const back = withLabel(labelledBefore, {});
  assert.deepEqual(classifyChange(labelledBefore, back).loosened, []);
  assert.deepEqual(
    changedSettings(labelledBefore, back).filter((setting) => setting.path.startsWith('agentLabel.')),
    [{ path: 'agentLabel.slackStyles', before: { [account.id]: 'labelled' }, after: null }],
  );
  // The store: labelled waits for consent, and app is written at once.
  const { store: configs, file } = store({});
  await assert.rejects(
    configs.update((c) => withLabel(c, { slackStyles: { [account.id]: 'labelled' } })),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'LOOSENING_REFUSED');
      assert.match(error.message, /agentLabel\.slackStyles/);
      return true;
    },
  );
  await configs.update((c) => withLabel(c, { slackStyles: { [account.id]: 'labelled' } }), {
    consent: { kind: 'loosening-consent', paths: ['agentLabel.slackStyles'] },
  });
  assert.deepEqual(agentLabelOf(await configs.load()).slackStyles, { [account.id]: 'labelled' });
  await configs.update((c) => withLabel(c, {}));
  assert.deepEqual((JSON.parse(readFileSync(file, 'utf8')) as { agentLabel?: unknown }).agentLabel, {});
});

test('Review focus 2: a rule naming an account that was renamed or removed is kept, and matches nothing', async () => {
  const { store: configs, file } = store({ rules: [RULES[0]] });
  // Renamed: the rule still names the old name, which no account has now.
  await configs.update((c) => renameEntry(c, 'account', 'acme/slack', 'acme/slack-main'));
  const renamed = await configs.load();
  assert.deepEqual(agentLabelOf(renamed).rules, [RULES[0]], 'kept as it was written');
  const settings = agentLabelOf(renamed);
  for (const name of ['acme/slack-main', 'acme/gmail']) {
    assert.deepEqual(
      resolveIdentity(settings, { account: name, kind: 'post', slack: { channel: 'C0ACME' } }),
      { identity: 'agent', source: 'default' },
      `${name} is not the account the rule names`,
    );
  }
  // Removed: the same.
  await configs.update((c) => ({ ...c, accounts: {} }));
  const removed = JSON.parse(readFileSync(file, 'utf8')) as { agentLabel?: unknown; accounts: object };
  assert.deepEqual(removed.accounts, {});
  assert.deepEqual(removed.agentLabel, { rules: [RULES[0]] });
  // And neither write was a change to the label, whatever it did to the account.
  const before = config({ rules: [RULES[0]] });
  const gone = { ...structuredClone(before), accounts: {} } as Config;
  assert.deepEqual(
    classifyChange(before, gone).changes.filter((change) => change.path.startsWith('agentLabel.')),
    [],
  );
});
