import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type AccountConfig,
  type Config,
  ConfigStore,
  type ConfigV1,
  type ConfigV2,
  classifyChange,
  configFingerprint,
  emptyConfig,
  type InboxConfig,
  parseConfig,
} from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { credentialsLockPath, withFileLock } from '../src/lock.ts';
import { isValidName, nameShapeProblem, parseName } from '../src/name-grammar.ts';
import {
  applyNamesMigration,
  findById,
  migrateNames,
  nameAvailable,
  planNamesMigration,
  renameEntry,
  requireInbox,
  resolveName,
} from '../src/names.ts';
import { tempDir } from './helpers/temp.ts';

function inbox(id: string, overrides: Partial<InboxConfig> = {}): InboxConfig {
  return {
    id,
    provider: 'gmail',
    email: 'jo@example.com',
    identity: 'oidc',
    sub: id,
    client: 'desktop',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:refresh:${id}`,
    internalDomains: ['example.com'],
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

function account(id: string, overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id,
    platform: 'slack',
    workspace: 'T_ACME',
    userId: 'U_ME',
    tier: 'read',
    mode: 'read',
    grantedScopes: [],
    secretRef: `slack/token/${id}`,
    createdAt: '2026-09-22T00:00:00.000Z',
    ...overrides,
  };
}

const IBX_A = 'ibx_AAAAAAAAAAAAAAAA';
const IBX_B = 'ibx_BBBBBBBBBBBBBBBB';
const ACC_A = 'acc_AAAAAAAAAAAAAAAA';
const ACC_B = 'acc_BBBBBBBBBBBBBBBB';

function v1(parts: Partial<ConfigV1> = {}): ConfigV1 {
  return parseConfig(JSON.stringify({ version: 1, ...parts })) as ConfigV1;
}

function v2(parts: Partial<ConfigV2> = {}): ConfigV2 {
  return parseConfig(JSON.stringify({ version: 2, ...parts })) as ConfigV2;
}

function storeWith(config: unknown): ConfigStore {
  const dir = tempDir('comms-names-');
  writeFileSync(join(dir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  return new ConfigStore(dir);
}

/** The row, or a failed assertion — in place of a non-null assertion the linter rightly forbids. */
function present<T>(value: T | undefined): T {
  assert.ok(value !== undefined, 'expected a row');
  return value;
}

function isError(code: string, pattern?: RegExp) {
  return (error: unknown) =>
    error instanceof CommsError && error.code === code && (pattern === undefined || pattern.test(error.message));
}

// ── The grammar ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the grammar accepts organisation/platform with an optional qualifier', () => {
  for (const name of [
    'cue/gmail',
    'wf/gmail-tech',
    'personal/gmail',
    'rgc/slack',
    'a/b',
    '9/gmail',
    'wf-uk/gmail-a-b',
  ]) {
    assert.ok(isValidName(name), name);
  }
  assert.deepEqual(parseName('wf/gmail-tech'), { org: 'wf', platform: 'gmail', qualifier: 'tech' });
  assert.deepEqual(parseName('cue/slack'), { org: 'cue', platform: 'slack' });
});

test('the grammar refuses everything else', () => {
  for (const name of [
    'cue',
    'cue/',
    '/gmail',
    'cue//gmail',
    'cue/gmail/',
    'cue/gmail/x',
    'Cue/gmail',
    'cue/Gmail',
    'cue/gm ail',
    '../gmail',
    'cue./gmail',
    'cue/.gmail',
    '-cue/gmail',
    'cue-/gmail',
    'cue/gmail-',
    'cue/gmail--x',
    'cue/-gmail',
    'cue/1gmail',
    'cue/gmail_x',
    'con/gmail',
    'nul/slack',
    'com1/gmail',
    'lpt9/gmail',
    '',
    'cue/gmail\n',
  ]) {
    assert.equal(isValidName(name), false, JSON.stringify(name));
  }
});

test('the grammar enforces each length limit on each side', () => {
  assert.ok(isValidName(`${'a'.repeat(32)}/gmail`));
  assert.equal(isValidName(`${'a'.repeat(33)}/gmail`), false);
  assert.ok(isValidName(`cue/${'g'.repeat(16)}`));
  assert.equal(isValidName(`cue/${'g'.repeat(17)}`), false);
  assert.ok(isValidName(`cue/gmail-${'q'.repeat(16)}`));
  assert.equal(isValidName(`cue/gmail-${'q'.repeat(17)}`), false);
});

test('reserved words are only reserved as the organisation', () => {
  assert.ok(isValidName('console/gmail'));
  assert.ok(isValidName('cue/gmail-con'));
  assert.ok(isValidName('com10/gmail'));
  assert.match(nameShapeProblem('con/gmail', 'gmail') ?? '', /Windows reserves it/);
});

test('an invalid name is explained with an example ending in the right platform', () => {
  assert.match(nameShapeProblem('work', 'gmail') ?? '', /acme\/gmail/);
  assert.match(nameShapeProblem('work', 'slack') ?? '', /acme\/slack/);
  assert.match(nameShapeProblem('cue/slack', 'gmail') ?? '', /ends in \/slack, but this is a gmail account/);
  assert.equal(nameShapeProblem('cue/gmail', 'gmail'), null);
});

// ── The two versions ─────────────────────────────────────────────────────────────────────────────────────────────

test('a new config is still created at version 1 — nothing writes version 2 yet', async () => {
  assert.equal(emptyConfig().version, 1);
  const store = new ConfigStore(tempDir('comms-names-'));
  assert.equal((await store.load()).version, 1);
  assert.equal((await store.update((config) => config)).version, 1);
});

test('version 1 keeps its rules: plain names, and the same word in both maps is tolerated', () => {
  const config = v1({ inboxes: { work: inbox(IBX_A) }, accounts: { work: account(ACC_A) } });
  assert.equal(config.version, 1);
  assert.throws(() => v1({ inboxes: { 'cue/gmail': inbox(IBX_A) } }), isError('CONFIG', /lowercase letters/));
});

test('version 2 requires the grammar, and says what a valid name looks like', () => {
  assert.throws(() => v2({ inboxes: { cue: inbox(IBX_A) } }), isError('CONFIG', /organisation\/platform/));
  const config = v2({ inboxes: { 'cue/gmail': inbox(IBX_A) }, accounts: { 'cue/slack': account(ACC_A) } });
  assert.deepEqual(config.formerNames, { inboxes: {}, accounts: {} });
});

test('version 2 checks the platform against the account, both ways', () => {
  assert.throws(() => v2({ inboxes: { 'cue/slack': inbox(IBX_A) } }), isError('CONFIG', /gmail mailbox/));
  assert.throws(() => v2({ accounts: { 'cue/gmail': account(ACC_A) } }), isError('CONFIG', /slack account/));
});

test('version 2 refuses one name in both maps, and one id in both', () => {
  assert.throws(
    () =>
      parseConfig(
        JSON.stringify({
          version: 2,
          inboxes: { 'cue/gmail': inbox(IBX_A) },
          accounts: { 'cue/gmail': account(ACC_A, { platform: 'gmail' }) },
        }),
      ),
    isError('CONFIG', /names a mailbox too/),
  );
});

test('version 2 keeps client names plain', () => {
  const config = v2({
    clients: {
      desktop: { provider: 'gmail', clientId: 'x', secretRef: 'gmail:client:desktop', addedAt: '2026-09-22' },
    },
  });
  assert.ok(config.clients.desktop);
});

test('an ordinary update keeps version 1, and leaves what it did not touch byte for byte', async () => {
  const raw = {
    version: 1,
    inboxes: { work: inbox(IBX_A) },
    defaults: { sendPolicy: 'confirm' },
    somethingNewer: { kept: true },
  };
  const store = storeWith(raw);
  const before = JSON.parse(readFileSync(store.path, 'utf8'));
  await store.update((config) => ({ ...config, inboxes: { ...config.inboxes, home: inbox(IBX_B) } }));
  const after = JSON.parse(readFileSync(store.path, 'utf8'));
  assert.equal(after.version, 1);
  assert.deepEqual(after.inboxes.work, before.inboxes.work);
  assert.deepEqual(after.somethingNewer, { kept: true });
});

test('an ordinary update cannot change the version, either way', async () => {
  const one = storeWith({ version: 1, inboxes: { work: inbox(IBX_A) } });
  await assert.rejects(
    one.update((config) => ({ ...config, version: 2, formerNames: { inboxes: {}, accounts: {} } }) as Config),
    isError('CONFIG', /refusing to change the config version from 1 to 2/),
  );
  assert.equal(JSON.parse(readFileSync(one.path, 'utf8')).version, 1);

  const two = storeWith({ version: 2, inboxes: { 'cue/gmail': inbox(IBX_A) } });
  await assert.rejects(
    two.update((config) => ({ ...config, version: 1 }) as Config),
    isError('CONFIG', /from 2 to 1/),
  );
});

test('a version-2 update is validated under version 2', async () => {
  const store = storeWith({ version: 2, inboxes: { 'cue/gmail': inbox(IBX_A) } });
  await assert.rejects(
    store.update((config) => ({ ...config, inboxes: { ...config.inboxes, work: inbox(IBX_B) } })),
    isError('CONFIG', /refusing to write invalid config/),
  );
});

// ── Looking names up ─────────────────────────────────────────────────────────────────────────────────────────────

const migrated = (): ConfigV2 =>
  v2({
    inboxes: { 'cue/gmail': inbox(IBX_A) },
    accounts: { 'cue/slack': account(ACC_A) },
    formerNames: {
      inboxes: { cue: { name: 'cue/gmail', id: IBX_A }, gone: { name: 'gone/gmail', id: IBX_B } },
      accounts: { live: { name: 'cue/slack', id: ACC_A } },
    },
  });

test('a live name resolves to its account', () => {
  const config = migrated();
  assert.equal(resolveName(config, 'inbox', 'cue/gmail').inbox.id, IBX_A);
  assert.equal(resolveName(config, 'account', 'cue/slack').account.id, ACC_A);
  assert.equal(requireInbox(config, 'cue/gmail').id, IBX_A);
});

test('a former name is refused with what it is called now', () => {
  const config = migrated();
  assert.throws(
    () => resolveName(config, 'inbox', 'cue'),
    (error: unknown) =>
      error instanceof CommsError &&
      error.code === 'NOT_FOUND' &&
      error.message === '"cue" was renamed to "cue/gmail"' &&
      error.hint === 'Use "cue/gmail".' &&
      (error.details as { currentName?: string }).currentName === 'cue/gmail',
  );
  assert.throws(() => resolveName(config, 'account', 'live'), isError('NOT_FOUND', /renamed to "cue\/slack"/));
});

test('a former name is followed to the account’s current name, not the one recorded', () => {
  const config = migrated();
  const renamedAgain = renameEntry(config, 'inbox', 'cue/gmail', 'cue/gmail-main');
  assert.throws(() => resolveName(renamedAgain, 'inbox', 'cue'), isError('NOT_FOUND', /renamed to "cue\/gmail-main"/));
  assert.throws(
    () => resolveName(renamedAgain, 'inbox', 'cue/gmail'),
    isError('NOT_FOUND', /renamed to "cue\/gmail-main"/),
  );
});

test('a stale record is still followed by id, even where nothing collapsed the chain', () => {
  // A record whose name is out of date — written by anything that renamed without `renameEntry`.
  const config = v2({
    inboxes: { 'cue/gmail-main': inbox(IBX_A) },
    formerNames: { inboxes: { cue: { name: 'cue/gmail', id: IBX_A } }, accounts: {} },
  });
  assert.throws(() => resolveName(config, 'inbox', 'cue'), isError('NOT_FOUND', /renamed to "cue\/gmail-main"$/));
});

test('a former name of a removed account says so, rather than pointing anywhere', () => {
  assert.throws(
    () => resolveName(migrated(), 'inbox', 'gone'),
    isError('NOT_FOUND', /renamed to "gone\/gmail", which has since been removed/),
  );
});

test('former names are per kind: an old mailbox name is not an old workspace name', () => {
  assert.throws(() => resolveName(migrated(), 'account', 'cue'), isError('NOT_FOUND', /no account called "cue"/));
});

test('an unknown name keeps the caller’s own wording', () => {
  const custom = () => new CommsError('NOT_FOUND', 'no Slack workspace called "x"');
  assert.throws(() => resolveName(migrated(), 'account', 'x', custom), isError('NOT_FOUND', /no Slack workspace/));
  assert.throws(() => requireInbox(v1(), 'work'), isError('NOT_FOUND', /no inbox called "work"/));
});

test('a name that is a property of every object is not an account', () => {
  const config = v1({ inboxes: { work: inbox(IBX_A) } });
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => resolveName(config, 'inbox', name), isError('NOT_FOUND'), name);
    // Only `constructor` is a valid version-1 name among these, and it is free: nothing is called that.
    assert.equal(nameAvailable(config, 'inbox', name, 'gmail').ok, name === 'constructor', name);
  }
});

test('findById finds an account under whatever name it has', () => {
  const config = migrated();
  assert.equal(findById(config, 'inbox', IBX_A)?.alias, 'cue/gmail');
  assert.equal(findById(config, 'account', ACC_A)?.alias, 'cue/slack');
  assert.equal(findById(config, 'inbox', ACC_A), null);
});

// ── Whether a name may be taken ──────────────────────────────────────────────────────────────────────────────────

test('nameAvailable: version 1 keeps each kind’s existing rule', () => {
  const config = v1({ inboxes: { work: inbox(IBX_A) }, accounts: { team: account(ACC_A) } });
  // A mailbox name need only be free among mailboxes — what Gmail checks today.
  assert.equal(nameAvailable(config, 'inbox', 'team', 'gmail').ok, true);
  assert.equal(nameAvailable(config, 'inbox', 'work', 'gmail').ok, false);
  // A workspace name must be free in both — what Slack checks today.
  assert.equal(nameAvailable(config, 'account', 'work', 'slack').ok, false);
  assert.equal(nameAvailable(config, 'account', 'team', 'slack').ok, false);
  assert.equal(nameAvailable(config, 'account', 'home', 'slack').ok, true);
  // Plain names only, and `all` is reserved.
  assert.equal(nameAvailable(config, 'inbox', 'cue/gmail', 'gmail').ok, false);
  assert.equal(nameAvailable(config, 'inbox', 'all', 'gmail').ok, false);
});

test('nameAvailable: version 2 is the grammar, the platform, both maps, and no former name', () => {
  const config = migrated();
  const reason = (kind: 'inbox' | 'account', name: string, platform: string) => {
    const check = nameAvailable(config, kind, name, platform);
    return check.ok ? 'ok' : check.error.message;
  };
  assert.equal(reason('inbox', 'rgc/gmail', 'gmail'), 'ok');
  assert.equal(reason('account', 'rgc/slack', 'slack'), 'ok');
  assert.match(reason('inbox', 'work', 'gmail'), /not a valid name/);
  assert.match(reason('inbox', 'rgc/slack', 'gmail'), /ends in \/slack/);
  assert.match(reason('inbox', 'cue/gmail', 'gmail'), /already connected/);
  assert.match(reason('account', 'cue/gmail', 'gmail'), /already connected/);
  assert.match(reason('inbox', 'gone/gmail', 'gmail'), /ok/);
  assert.match(reason('inbox', 'cue', 'gmail'), /not a valid name/);
  const reused = renameEntry(config, 'inbox', 'cue/gmail', 'cue/gmail-main');
  const check = nameAvailable(reused, 'inbox', 'cue/gmail', 'gmail');
  assert.equal(check.ok, false);
  assert.match(check.ok ? '' : check.error.message, /cannot be used again/);
  // Of either kind: a former workspace name is not free for a mailbox either.
  const crossKind = renameEntry(config, 'account', 'cue/slack', 'cue/slack-main');
  assert.equal(nameAvailable(crossKind, 'account', 'cue/slack', 'slack').ok, false);
});

test('the schema refuses a former name on every write, not only where names are proposed', async () => {
  const store = storeWith(renameEntry(migrated(), 'inbox', 'cue/gmail', 'cue/gmail-main'));
  await assert.rejects(
    store.update((config) => ({ ...config, inboxes: { ...config.inboxes, 'cue/gmail': inbox(IBX_B) } })),
    isError('CONFIG', /was renamed and cannot be used again/),
  );
});

test('renameEntry in version 1 renames and records nothing', () => {
  const renamed = renameEntry(v1({ inboxes: { work: inbox(IBX_A) } }), 'inbox', 'work', 'home');
  assert.deepEqual(Object.keys(renamed.inboxes), ['home']);
  assert.equal('formerNames' in renamed, false);
});

test('renameEntry in version 2 records the old name and collapses the chain', () => {
  const once = renameEntry(migrated(), 'inbox', 'cue/gmail', 'cue/gmail-main');
  assert.deepEqual(once.formerNames.inboxes.cue, { name: 'cue/gmail-main', id: IBX_A });
  assert.deepEqual(once.formerNames.inboxes['cue/gmail'], { name: 'cue/gmail-main', id: IBX_A });
  // An unrelated record is left alone.
  assert.deepEqual(once.formerNames.inboxes.gone, { name: 'gone/gmail', id: IBX_B });
  // And the result is a config the schema accepts.
  assert.equal(parseConfig(JSON.stringify(once)).version, 2);
});

// ── Planning the migration ───────────────────────────────────────────────────────────────────────────────────────

const machine = (): ConfigV1 =>
  v1({
    inboxes: {
      gmail: inbox('ibx_GGGGGGGGGGGGGGGG'),
      cue: inbox('ibx_CCCCCCCCCCCCCCCC'),
      'wf-tech': inbox('ibx_TTTTTTTTTTTTTTTT'),
    },
    accounts: { live: account(ACC_A), 'slack-2': account(ACC_B, { workspace: 'T_OTHER' }) },
  });

function ready(plan: ReturnType<typeof planNamesMigration>) {
  assert.equal(plan.status, 'ready');
  return plan as Extract<typeof plan, { status: 'ready' }>;
}

test('the default proposal is <old name>/<platform>', () => {
  const plan = ready(planNamesMigration(machine()));
  assert.deepEqual(
    plan.rows.map((row) => `${row.kind}:${row.from}=${row.to}`),
    [
      'inbox:cue=cue/gmail',
      'inbox:gmail=gmail/gmail',
      'inbox:wf-tech=wf-tech/gmail',
      'account:live=live/slack',
      'account:slack-2=slack-2/slack',
    ],
  );
  assert.equal(plan.fingerprint, configFingerprint(machine()));
});

test('overrides replace a default, and the mapping for this machine is valid', () => {
  const plan = ready(
    planNamesMigration(machine(), [
      'gmail=personal/gmail',
      'wf-tech=wf/gmail-tech',
      'live=cue/slack',
      'slack-2=rgc/slack',
    ]),
  );
  assert.deepEqual(Object.fromEntries(plan.rows.map((row) => [row.from, row.to])), {
    cue: 'cue/gmail',
    gmail: 'personal/gmail',
    'wf-tech': 'wf/gmail-tech',
    live: 'cue/slack',
    'slack-2': 'rgc/slack',
  });
});

test('a word in both maps must be qualified, and qualified sources work', () => {
  const both = v1({ inboxes: { work: inbox(IBX_A) }, accounts: { work: account(ACC_A) } });
  assert.throws(
    () => planNamesMigration(both, ['work=acme/gmail']),
    isError('USAGE', /names both a mailbox and an account — say which: inbox:work=… or account:work=…/),
  );
  const plan = ready(planNamesMigration(both, ['inbox:work=acme/gmail', 'account:work=acme/slack']));
  assert.deepEqual(
    plan.rows.map((row) => row.to),
    ['acme/gmail', 'acme/slack'],
  );
  // With no overrides the defaults already differ by platform.
  assert.deepEqual(
    ready(planNamesMigration(both)).rows.map((row) => row.to),
    ['work/gmail', 'work/slack'],
  );
});

test('every problem is listed at once, and nothing is planned', () => {
  const config = v1({
    inboxes: { 'work-': inbox(IBX_A), con: inbox(IBX_B) },
    accounts: { live: account(ACC_A) },
  });
  assert.throws(
    () =>
      planNamesMigration(config, [
        'nope=x/gmail',
        'live=cue/gmail',
        'live=cue/slack',
        'broken',
        'inbox:missing=a/gmail',
      ]),
    (error: unknown) => {
      if (!(error instanceof CommsError) || error.code !== 'USAGE') return false;
      const problems = (error.details as { problems: string[] }).problems;
      const expected = [
        /there is nothing called "nope"/,
        /"live" is renamed more than once/,
        /"broken" is not source=name/,
        /there is no inbox called "missing"/,
        /"work-" would become "work-\/gmail", which cannot be used .* --rename inbox:work-=<name>/,
        /"con" would become "con\/gmail".*Windows reserves it/,
        /"cue\/gmail" ends in \/gmail, but this is a slack account/,
      ];
      for (const pattern of expected)
        assert.ok(
          problems.some((p) => pattern.test(p)),
          `missing ${pattern}`,
        );
      assert.equal(problems.length, expected.length, problems.join('\n'));
      return true;
    },
  );
});

test('two accounts cannot be given one name', () => {
  assert.throws(
    () => planNamesMigration(machine(), ['gmail=cue/gmail']),
    isError('USAGE', /"cue\/gmail" would name inbox "cue" and inbox "gmail"|would name inbox "gmail" and inbox "cue"/),
  );
});

test('a version-2 config has nothing to plan', () => {
  assert.deepEqual(planNamesMigration(migrated()), { status: 'already-migrated' });
});

// ── Applying it ──────────────────────────────────────────────────────────────────────────────────────────────────

test('the migration renames every key, records every old name, and touches nothing else', async () => {
  const raw = { ...machine(), somethingNewer: { kept: true } };
  const store = storeWith(raw);
  const plan = ready(planNamesMigration(await store.load(), ['gmail=personal/gmail']));
  const result = await migrateNames(store, plan);
  assert.equal(result.status, 'migrated');

  const written = JSON.parse(readFileSync(store.path, 'utf8'));
  assert.equal(written.version, 2);
  assert.deepEqual(Object.keys(written.inboxes).sort(), ['cue/gmail', 'personal/gmail', 'wf-tech/gmail']);
  assert.deepEqual(Object.keys(written.accounts).sort(), ['live/slack', 'slack-2/slack']);
  assert.deepEqual(written.formerNames.inboxes.gmail, { name: 'personal/gmail', id: 'ibx_GGGGGGGGGGGGGGGG' });
  assert.deepEqual(written.formerNames.accounts.live, { name: 'live/slack', id: ACC_A });
  assert.deepEqual(written.somethingNewer, { kept: true });
  // Secrets are keyed by immutable id, so every reference is exactly what it was.
  assert.equal(written.inboxes['personal/gmail'].secretRef, 'gmail:refresh:ibx_GGGGGGGGGGGGGGGG');
  assert.equal(written.accounts['live/slack'].secretRef, `slack/token/${ACC_A}`);

  const reread = await new ConfigStore(join(store.path, '..')).load();
  assert.throws(() => resolveName(reread, 'inbox', 'gmail'), isError('NOT_FOUND', /renamed to "personal\/gmail"/));
});

test('a retry finds the migration already done', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  await migrateNames(store, plan);
  const before = readFileSync(store.path, 'utf8');
  // The same call again — what a caller does after a write that committed and then reported a failure.
  assert.equal((await migrateNames(store, plan)).status, 'already-migrated');
  assert.equal(readFileSync(store.path, 'utf8'), before);
});

test('a renamed row between preview and apply refuses the migration, and writes nothing', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  await store.update((config) => renameEntry(config, 'inbox', 'cue', 'cue-old'));
  const before = readFileSync(store.path, 'utf8');
  await assert.rejects(migrateNames(store, plan), isError('TRANSIENT', /changed after the preview/));
  assert.equal(readFileSync(store.path, 'utf8'), before);
});

test('a change to nothing but a policy between preview and apply refuses it too', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  await store.update((config) => ({
    ...config,
    inboxes: { ...config.inboxes, cue: { ...present(config.inboxes.cue), sendPolicy: 'never' } },
  }));
  await assert.rejects(migrateNames(store, plan), isError('TRANSIENT'));
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 1);
});

test('a build that changes more than names is refused before it is written', async () => {
  const store = storeWith(machine());
  const current = (await store.load()) as ConfigV1;
  const plan = ready(planNamesMigration(current));
  const widened = (config: ConfigV1): ConfigV2 => {
    const next = applyNamesMigration(config, plan.rows);
    next.inboxes['cue/gmail'] = { ...present(next.inboxes['cue/gmail']), sendPolicy: 'chat' };
    return next;
  };
  await assert.rejects(store.migrateNames(plan.fingerprint, widened), isError('CONFIG', /changes more than names/));
  const dropped = (config: ConfigV1): ConfigV2 => {
    const next = applyNamesMigration(config, plan.rows);
    delete next.inboxes['cue/gmail'];
    return next;
  };
  await assert.rejects(store.migrateNames(plan.fingerprint, dropped), isError('CONFIG', /number of inboxes changed/));
  const defaults = (config: ConfigV1): ConfigV2 => ({
    ...applyNamesMigration(config, plan.rows),
    defaults: { ...config.defaults, sendPolicy: 'never' },
  });
  await assert.rejects(
    store.migrateNames(plan.fingerprint, defaults),
    isError('CONFIG', /a setting other than a name/),
  );
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 1);
});

test('the migration waits for the credentials lock', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  let released = false;
  let migratedWhileHeld = false;
  let running: Promise<void> | undefined;
  await withFileLock(credentialsLockPath(join(store.path, '..')), async () => {
    running = migrateNames(store, plan).then(() => {
      migratedWhileHeld = !released;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    released = true;
  });
  await running;
  assert.equal(migratedWhileHeld, false);
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 2);
});

// ── The classifier ───────────────────────────────────────────────────────────────────────────────────────────────

test('a pure rename loosens nothing, for either kind', () => {
  const before = v1({ inboxes: { cue: inbox(IBX_A) }, accounts: { live: account(ACC_A) } });
  const after = applyNamesMigration(before, ready(planNamesMigration(before)).rows);
  assert.deepEqual(classifyChange(before, after).loosened, []);
});

test('a widening in the same write as a rename is reported under the new name', () => {
  const before = v1({
    inboxes: { cue: inbox(IBX_A, { sendPolicy: 'never' }) },
    accounts: { live: account(ACC_A, { sendPolicy: 'never' }) },
  });
  const renamed = applyNamesMigration(before, ready(planNamesMigration(before)).rows);
  const after: ConfigV2 = {
    ...renamed,
    inboxes: {
      'cue/gmail': {
        ...present(renamed.inboxes['cue/gmail']),
        sendPolicy: 'chat',
        internalDomains: ['example.com', 'x.test'],
      },
    },
    accounts: { 'live/slack': { ...present(renamed.accounts['live/slack']), sendPolicy: 'chat' } },
  };
  assert.deepEqual(classifyChange(before, after).loosened.sort(), [
    'accounts.live/slack.sendPolicy',
    'inboxes.cue/gmail.internalDomains',
    'inboxes.cue/gmail.sendPolicy',
  ]);
});

test('a Slack rename and an id rotation in one write is still the same account', () => {
  const before = v1({ accounts: { live: account(ACC_A, { mode: 'read', sendPolicy: 'never' }) } });
  // Re-authorised (new id) and renamed at once, now able to post and set to chat.
  const after = v2({
    accounts: { 'cue/slack': account(ACC_B, { mode: 'send', tier: 'send', sendPolicy: 'chat' }) },
  });
  assert.deepEqual(classifyChange(before, after).loosened.sort(), [
    'accounts.cue/slack.mode',
    'accounts.cue/slack.sendPolicy',
  ]);
  // A different workspace under the new name is not that account.
  const unrelated = v2({ accounts: { 'cue/slack': account(ACC_B, { workspace: 'T_ELSE', mode: 'send' }) } });
  assert.deepEqual(classifyChange(before, unrelated).loosened, []);
});
