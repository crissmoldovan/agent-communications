import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
  retargetFormerNames,
} from '../src/names.ts';
import { enableNamesMigrationForTests } from '../src/release-gate.ts';
import { parseConfigAsReleased014 } from './fixtures/v0.1.4-version-gate.ts';
import { tempDir } from './helpers/temp.ts';

// The transition is what these tests are about; `release-gate.test.ts` proves it is off by default.
enableNamesMigrationForTests();

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

test('a new config is created at version 2, and an existing version-1 one stays where it is', async () => {
  assert.equal(emptyConfig().version, 2);
  const fresh = new ConfigStore(tempDir('comms-names-'));
  assert.equal((await fresh.load()).version, 2);
  assert.equal((await fresh.update((config) => config)).version, 2);

  // An existing file is never moved by an ordinary write: only the migration changes a version.
  const existing = storeWith(machine());
  assert.equal((await existing.update((config) => config)).version, 1);
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
  // Of either kind: a name recorded as a former *account* name is not free for a mailbox either.
  const crossKind = v2({
    inboxes: { 'cue/gmail': inbox(IBX_A) },
    formerNames: { inboxes: {}, accounts: { 'odd/gmail': { name: 'cue/gmail', id: IBX_A } } },
  });
  assert.equal(nameAvailable(crossKind, 'inbox', 'odd/gmail', 'gmail').ok, false);
  assert.equal(nameAvailable(crossKind, 'inbox', 'even/gmail', 'gmail').ok, true);
});

test('the schema refuses a former name on every write, not only where names are proposed', async () => {
  const store = storeWith(renameEntry(migrated(), 'inbox', 'cue/gmail', 'cue/gmail-main'));
  await assert.rejects(
    store.update((config) => ({ ...config, inboxes: { ...config.inboxes, 'cue/gmail': inbox(IBX_B) } })),
    isError('CONFIG', /was renamed and cannot be used again/),
  );
});

test('renameEntry keeps what a newer release added to a former-name record', () => {
  const config = v2({
    inboxes: { 'cue/gmail': inbox(IBX_A) },
    formerNames: {
      inboxes: { cue: { name: 'cue/gmail', id: IBX_A, recordedBy: 'a newer release' } as { name: string; id: string } },
      accounts: {},
    },
  });
  const renamed = renameEntry(config, 'inbox', 'cue/gmail', 'cue/gmail-main');
  assert.deepEqual(renamed.formerNames.inboxes.cue, {
    name: 'cue/gmail-main',
    id: IBX_A,
    recordedBy: 'a newer release',
  });
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
        'nope=y/gmail',
      ]),
    (error: unknown) => {
      if (!(error instanceof CommsError) || error.code !== 'USAGE') return false;
      const problems = (error.details as { problems: string[] }).problems;
      const expected = [
        /"live" is renamed more than once/,
        /"nope" is renamed more than once/,
        /"broken" is not source=name/,
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

test('a rename for a name this computer does not have is reported, and the rest of the plan stands', () => {
  // The same mapping, run on a computer that has only some of the accounts it names.
  const partial = v1({ inboxes: { gmail: inbox(IBX_A), cue: inbox(IBX_B) } });
  const plan = ready(
    planNamesMigration(partial, [
      'gmail=personal/gmail',
      'wf-tech=wf/gmail-tech',
      'account:live=cue/slack',
      'inbox:elsewhere=acme/gmail',
    ]),
  );
  assert.deepEqual(Object.fromEntries(plan.rows.map((row) => [row.from, row.to])), {
    cue: 'cue/gmail',
    gmail: 'personal/gmail',
  });
  assert.deepEqual(
    plan.notApplicable.map((skipped) => skipped.rename),
    ['wf-tech=wf/gmail-tech', 'account:live=cue/slack', 'inbox:elsewhere=acme/gmail'],
  );
  assert.deepEqual(plan.notApplicable[0], { rename: 'wf-tech=wf/gmail-tech', source: 'wf-tech', to: 'wf/gmail-tech' });
  // A name that is here but in the other map is still not applicable when qualified with the wrong kind.
  assert.deepEqual(
    ready(planNamesMigration(partial, ['account:gmail=personal/slack'])).notApplicable.map((s) => s.source),
    ['account:gmail'],
  );
  // And one that matches everything has nothing to report.
  assert.deepEqual(ready(planNamesMigration(partial, ['gmail=personal/gmail'])).notApplicable, []);
});

test('the migration backs up the file it replaces, byte for byte and owner-only, and says where', async () => {
  // Written with odd spacing, so a copy re-serialised from the parsed config would not match.
  const store = storeWith(machine());
  const original = readFileSync(store.path, 'utf8').replace('{', '{   ');
  writeFileSync(store.path, original);
  const plan = ready(planNamesMigration(await store.load(), ['gmail=personal/gmail']));
  const result = await migrateNames(store, plan);
  assert.equal(result.status, 'migrated');
  const backup = present(result.backup);
  assert.match(backup, /config\.json\.before-names-migrate-\d{8}T\d{6}Z$/);
  assert.equal(dirname(backup), dirname(store.path));
  assert.equal(readFileSync(backup, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 2);

  // A retry finds it done, and does not back up the migrated file as if it were the original.
  const again = await migrateNames(store, plan);
  assert.equal(again.status, 'already-migrated');
  assert.equal(again.backup, undefined);
  assert.equal(readdirSync(dirname(store.path)).filter((f) => f.includes('before-names-migrate')).length, 1);
});

test('an existing backup is never overwritten', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  // Every name this second could produce, and the next, already taken by something that must survive.
  const stamp = (at: Date) =>
    at
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z');
  const now = new Date();
  for (const at of [now, new Date(now.getTime() + 1000)]) {
    writeFileSync(`${store.path}.before-names-migrate-${stamp(at)}`, 'the only copy\n');
  }
  const result = await migrateNames(store, plan);
  const backup = present(result.backup);
  assert.match(backup, /-\d+$/, 'a suffix, not the taken name');
  for (const at of [now, new Date(now.getTime() + 1000)]) {
    assert.equal(readFileSync(`${store.path}.before-names-migrate-${stamp(at)}`, 'utf8'), 'the only copy\n');
  }
});

test('a refused migration leaves no backup behind', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  await store.update((config) => ({
    ...config,
    inboxes: { ...config.inboxes, cue: { ...present(config.inboxes.cue), sendPolicy: 'never' } },
  }));
  await assert.rejects(migrateNames(store, plan), isError('TRANSIENT'));
  assert.deepEqual(
    readdirSync(dirname(store.path)).filter((f) => f.includes('before-names-migrate')),
    [],
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

test('what the migration writes, 0.1.4 refuses with the message it already prints', async () => {
  const store = storeWith(machine());
  await migrateNames(store, ready(planNamesMigration(await store.load())));
  assert.throws(
    () => parseConfigAsReleased014(readFileSync(store.path, 'utf8')),
    /config\.json has version 2; this release reads version 1/,
  );
  // And a version-1 file this release wrote, it still reads.
  const one = storeWith(machine());
  await one.update((config) => config);
  assert.doesNotThrow(() => parseConfigAsReleased014(readFileSync(one.path, 'utf8')));
});

test('a write that committed and then reported failure is found already done on retry', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  // The write lands and the call rejects anyway — what a failed lock release does after a committed write.
  const original = store.migrateNames.bind(store);
  store.migrateNames = async (expected, rows, build) => {
    await original(expected, rows, build);
    throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
  };
  await assert.rejects(migrateNames(store, plan), isError('LOCK_TIMEOUT'));
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 2, 'the write is on disk');
  store.migrateNames = original;

  const before = readFileSync(store.path, 'utf8');
  assert.equal((await migrateNames(store, plan)).status, 'already-migrated');
  assert.equal(readFileSync(store.path, 'utf8'), before, 'and the retry changes nothing');
});

test('two people mapping the same names differently: the loser is not told its mapping is already in place', async () => {
  const store = storeWith(machine());
  const current = await store.load();
  // Both previewed the same version-1 config, so both carry the same `fingerprint`. Only the mappings differ.
  const mine = ready(planNamesMigration(current, ['gmail=personal/gmail']));
  const theirs = ready(planNamesMigration(current, ['gmail=home/gmail']));
  assert.equal(mine.fingerprint, theirs.fingerprint, 'the same configuration was previewed twice');

  assert.equal((await migrateNames(store, theirs)).status, 'migrated');
  // Mine arrives second. It must not report "already migrated" — its rows say `personal/gmail`, and nothing on
  // disk was ever called that; a caller updating its registrations from them would point them at nothing.
  await assert.rejects(migrateNames(store, mine), isError('TRANSIENT', /not to these names/));
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(store.path, 'utf8')).inboxes, 'home/gmail'), true);
  // The same plan applied twice is still its own retry.
  assert.equal((await migrateNames(store, theirs)).status, 'already-migrated');
});

test('a retry after an unrelated edit is still the same migration, and still says so', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  assert.equal((await migrateNames(store, plan)).status, 'migrated');
  // Something else changes a setting that has nothing to do with names — which the whole-file check this
  // replaced would have read as a different migration, refusing a retry of the one that had just landed.
  await store.update((config) => ({ ...config, defaults: { ...config.defaults, timezone: 'Europe/Paris' } }));
  const after = readFileSync(store.path, 'utf8');
  assert.equal((await migrateNames(store, plan)).status, 'already-migrated');
  assert.equal(readFileSync(store.path, 'utf8'), after, 'and it writes nothing');

  // A rename after this one is not this one: the tombstone names the newer name and the key it wrote is gone.
  await store.update((config) => renameEntry(config, 'inbox', 'cue/gmail', 'cue/gmail-old'));
  await assert.rejects(migrateNames(store, plan), isError('TRANSIENT', /not to these names/));
});

test('a plan that is only part of the migration that landed is not that migration', async () => {
  // Previewed before a third mailbox existed. Somebody else added one and migrated, naming the two this plan
  // knows about exactly as this plan would have — so every row it holds is in place, and it is still incomplete.
  const smaller = v1({ inboxes: { gmail: inbox('ibx_GGGGGGGGGGGGGGGG'), cue: inbox('ibx_CCCCCCCCCCCCCCCC') } });
  const stale = ready(planNamesMigration(smaller));
  const store = storeWith({
    ...smaller,
    inboxes: { ...smaller.inboxes, 'wf-tech': inbox('ibx_TTTTTTTTTTTTTTTT') },
  });
  assert.equal((await migrateNames(store, ready(planNamesMigration(await store.load())))).status, 'migrated');

  const written = JSON.parse(readFileSync(store.path, 'utf8'));
  for (const row of stale.rows) {
    assert.equal(written.inboxes[row.to].id, row.id, `${row.to} is there under the name this plan chose`);
  }
  await assert.rejects(migrateNames(store, stale), isError('TRANSIENT', /not to these names/));
});

test('the store decides whether a migration is already done, not whoever called it', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  await migrateNames(store, plan);
  // A caller that could answer its own question could answer it wrongly. An empty plan satisfies "every row of
  // this plan is in place" trivially, and claiming it here would report a migration nobody planned as this one's.
  await assert.rejects(
    store.migrateNames(plan.fingerprint, [], () => {
      throw new Error('the build is never reached on a version-2 config');
    }),
    isError('TRANSIENT', /not to these names/),
  );
});

test('rows that disagree with the transform, or name one account twice, are refused', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  const elsewhere = ready(planNamesMigration(machine(), ['gmail=personal/gmail']));

  // What the caller would show, and what it would write, are not the same mapping.
  await assert.rejects(
    store.migrateNames(plan.fingerprint, plan.rows, (current) => applyNamesMigration(current, elsewhere.rows)),
    isError('CONFIG', /not the mapping it was given/),
  );
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 1, 'and nothing was written');

  // One account named twice is the right number of rows for the wrong set of accounts.
  const first = present(plan.rows[0]);
  const doubled = [first, first, ...plan.rows.slice(2)];
  await assert.rejects(
    store.migrateNames(plan.fingerprint, doubled, (current) => applyNamesMigration(current, plan.rows)),
    isError('CONFIG', /not the mapping it was given/),
  );

  // And the same rows are refused as a claim that the migration is already done.
  await migrateNames(store, plan);
  await assert.rejects(
    store.migrateNames(plan.fingerprint, doubled, () => {
      throw new Error('the build is never reached on a version-2 config');
    }),
    isError('TRANSIENT', /not to these names/),
  );

  // The same account twice, where counting the rows alone would agree with the file: one mailbox, two rows.
  const one = storeWith(v1({ inboxes: { gmail: inbox('ibx_GGGGGGGGGGGGGGGG') } }));
  const single = ready(planNamesMigration(await one.load()));
  const only = present(single.rows[0]);
  await assert.rejects(
    one.migrateNames(single.fingerprint, [only, only], (current) => applyNamesMigration(current, single.rows)),
    isError('CONFIG', /not the mapping it was given/),
  );
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

test('a key nested anywhere counts: an unknown field inside sendCaps or confirm is kept and fingerprinted', async () => {
  const raw = {
    ...machine(),
    defaults: {
      ...machine().defaults,
      sendCaps: { perHour: 20, perDay: 100, perMinute: 2 },
      confirm: { elicitationClients: [], trustedSince: 'x' },
    },
  };
  const store = storeWith(raw);
  const plan = ready(planNamesMigration(await store.load()));
  // A change to nothing but an unknown nested field between preview and apply.
  const changed = JSON.parse(readFileSync(store.path, 'utf8'));
  changed.defaults.sendCaps.perMinute = 5;
  writeFileSync(store.path, `${JSON.stringify(changed, null, 2)}\n`);
  await assert.rejects(migrateNames(store, plan), isError('TRANSIENT'));

  const fresh = ready(planNamesMigration(await store.load()));
  await migrateNames(store, fresh);
  const written = JSON.parse(readFileSync(store.path, 'utf8'));
  assert.equal(written.defaults.sendCaps.perMinute, 5);
  assert.equal(written.defaults.confirm.trustedSince, 'x');
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
  await assert.rejects(
    store.migrateNames(plan.fingerprint, plan.rows, widened),
    isError('CONFIG', /changes more than names/),
  );
  const dropped = (config: ConfigV1): ConfigV2 => {
    const next = applyNamesMigration(config, plan.rows);
    delete next.inboxes['cue/gmail'];
    return next;
  };
  await assert.rejects(
    store.migrateNames(plan.fingerprint, plan.rows, dropped),
    isError('CONFIG', /number of inboxes changed/),
  );
  const defaults = (config: ConfigV1): ConfigV2 => ({
    ...applyNamesMigration(config, plan.rows),
    defaults: { ...config.defaults, sendPolicy: 'never' },
  });
  await assert.rejects(
    store.migrateNames(plan.fingerprint, plan.rows, defaults),
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

test('the migration takes the credentials lock before the config lock', async () => {
  // While it waits for the credentials lock, the config lock must still be free: taking them the other way round
  // would hold every ordinary config write hostage to whatever holds the credentials lock.
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  let running: Promise<unknown> | undefined;
  let updatedWhileWaiting = false;
  await withFileLock(credentialsLockPath(join(store.path, '..')), async () => {
    running = migrateNames(store, plan);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const update = store.update((config) => config).then(() => true);
    const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000));
    updatedWhileWaiting = await Promise.race([update, timeout]);
  });
  await running;
  assert.equal(updatedWhileWaiting, true);
});

// ── Former names are permanent ───────────────────────────────────────────────────────────────────────────────────

test('an ordinary write cannot forget a former name, or forget one and reuse it in the same write', async () => {
  const store = storeWith(migrated());
  await assert.rejects(
    store.update((config) => ({ ...config, formerNames: { inboxes: {}, accounts: {} } }) as Config),
    isError('CONFIG', /forgets the former name/),
  );
  await assert.rejects(
    store.update((config) => {
      const next = config as ConfigV2;
      const { cue: _dropped, ...rest } = next.formerNames.inboxes;
      return {
        ...next,
        inboxes: { ...next.inboxes, cue: inbox(IBX_B) },
        formerNames: { ...next.formerNames, inboxes: rest },
      } as Config;
    }),
    isError('CONFIG'),
  );
});

test('a former name may follow a re-authorisation to the new id, and nowhere else', async () => {
  // A Slack reauth replaces the account under a new id, and moves its former names with it.
  const store = storeWith(migrated());
  await store.update((config) => {
    const next = retargetFormerNames(config as ConfigV2, 'account', ACC_A, ACC_B);
    return { ...next, accounts: { 'cue/slack': account(ACC_B) } };
  });
  const after = (await store.load()) as ConfigV2;
  assert.equal(after.formerNames.accounts.live?.id, ACC_B);
  assert.throws(() => resolveName(after, 'account', 'live'), isError('NOT_FOUND', /renamed to "cue\/slack"$/));

  // Pointing one at an account that was already there is not following a reauth.
  const other = storeWith(
    v2({
      inboxes: { 'cue/gmail': inbox(IBX_A), 'rgc/gmail': inbox(IBX_B) },
      formerNames: { inboxes: { cue: { name: 'cue/gmail', id: IBX_A } }, accounts: {} },
    }),
  );
  await assert.rejects(
    other.update((config) => {
      const next = config as ConfigV2;
      return { ...next, formerNames: { ...next.formerNames, inboxes: { cue: { name: 'rgc/gmail', id: IBX_B } } } };
    }),
    isError('CONFIG', /points the former name "cue" at a different account/),
  );
});

test('a former name cannot be moved to an account that did not replace its own', async () => {
  // The account it named was removed long ago; something connected today is not its reauth.
  const removedEarlier = storeWith(
    v2({
      accounts: { 'rgc/slack': account(ACC_B, { workspace: 'T_OTHER' }) },
      formerNames: { inboxes: {}, accounts: { live: { name: 'cue/slack', id: ACC_A } } },
    }),
  );
  await assert.rejects(
    removedEarlier.update((config) => {
      const next = config as ConfigV2;
      return {
        ...next,
        accounts: { ...next.accounts, 'new/slack': account('acc_CCCCCCCCCCCCCCCC') },
        formerNames: { ...next.formerNames, accounts: { live: { name: 'new/slack', id: 'acc_CCCCCCCCCCCCCCCC' } } },
      };
    }),
    isError('CONFIG', /points the former name "live" at a different account/),
  );

  // A replacement in the same write, but a different person: not a reauth either.
  const stranger = storeWith(migrated());
  await assert.rejects(
    stranger.update((config) => {
      const next = retargetFormerNames(config as ConfigV2, 'account', ACC_A, ACC_B);
      return { ...next, accounts: { 'cue/slack': account(ACC_B, { userId: 'U_SOMEONE_ELSE' }) } };
    }),
    isError('CONFIG', /at a different account/),
  );

  // The same person, but the old account is still there: nothing was replaced.
  const bothKept = storeWith(migrated());
  await assert.rejects(
    bothKept.update((config) => {
      const next = retargetFormerNames(config as ConfigV2, 'account', ACC_A, ACC_B);
      return { ...next, accounts: { ...next.accounts, 'cue/slack-2': account(ACC_B) } };
    }),
    isError('CONFIG', /at a different account/),
  );

  // The same person, the old account gone — but the other one was already connected before this write.
  const alreadyThere = storeWith(
    v2({
      accounts: { 'cue/slack': account(ACC_A), 'cue/slack-2': account(ACC_B) },
      formerNames: { inboxes: {}, accounts: { live: { name: 'cue/slack', id: ACC_A } } },
    }),
  );
  await assert.rejects(
    alreadyThere.update((config) => {
      const next = retargetFormerNames(config as ConfigV2, 'account', ACC_A, ACC_B);
      return { ...next, accounts: { 'cue/slack-2': account(ACC_B) } };
    }),
    isError('CONFIG', /at a different account/),
  );

  // Mailboxes never re-authorise under a new id, so their former names never move.
  const mailbox = storeWith(migrated());
  await assert.rejects(
    mailbox.update((config) => {
      const next = retargetFormerNames(config as ConfigV2, 'inbox', IBX_A, IBX_B);
      return { ...next, inboxes: { 'cue/gmail': inbox(IBX_B) } };
    }),
    isError('CONFIG', /at a different account/),
  );
});

test('a reauth that replaces an account must carry every one of its former names', async () => {
  const config = (): ConfigV2 =>
    v2({
      accounts: { 'cue/slack': account(ACC_A) },
      formerNames: {
        inboxes: {},
        accounts: { live: { name: 'cue/slack', id: ACC_A }, older: { name: 'cue/slack', id: ACC_A } },
      },
    });
  // None moved.
  await assert.rejects(
    storeWith(config()).update((current) => ({ ...current, accounts: { 'cue/slack': account(ACC_B) } })),
    isError('CONFIG', /pointing at an account a reauth just replaced/),
  );
  // One of two moved.
  await assert.rejects(
    storeWith(config()).update((current) => {
      const next = current as ConfigV2;
      return {
        ...next,
        accounts: { 'cue/slack': account(ACC_B) },
        formerNames: {
          ...next.formerNames,
          accounts: { ...next.formerNames.accounts, live: { name: 'cue/slack', id: ACC_B } },
        },
      };
    }),
    isError('CONFIG', /former name "older"/),
  );
  // All moved: accepted.
  const store = storeWith(config());
  await store.update((current) => {
    const next = retargetFormerNames(current as ConfigV2, 'account', ACC_A, ACC_B);
    return { ...next, accounts: { 'cue/slack': account(ACC_B) } };
  });
  // And an account simply removed, with nothing replacing it, keeps its former names as they were.
  const removed = storeWith(config());
  await removed.update((current) => ({ ...current, accounts: {} }));
  assert.equal(((await removed.load()) as ConfigV2).formerNames.accounts.live?.id, ACC_A);
});

test('a migration that forges, omits or adds a former name is refused', async () => {
  const store = storeWith(machine());
  const plan = ready(planNamesMigration(await store.load()));
  const tamper =
    (edit: (formerNames: ConfigV2['formerNames']) => void) =>
    (config: ConfigV1): ConfigV2 => {
      const next = applyNamesMigration(config, plan.rows);
      edit(next.formerNames);
      return next;
    };
  const cases: Array<[string, (formerNames: ConfigV2['formerNames']) => void]> = [
    ['omitted', (f) => delete f.inboxes.cue],
    ['forged', (f) => Object.assign(f.inboxes, { cue: { name: 'gmail/gmail', id: 'ibx_GGGGGGGGGGGGGGGG' } })],
    ['extra', (f) => Object.assign(f.inboxes, { ghost: { name: 'cue/gmail', id: 'ibx_CCCCCCCCCCCCCCCC' } })],
  ];
  for (const [label, edit] of cases) {
    await assert.rejects(store.migrateNames(plan.fingerprint, plan.rows, tamper(edit)), isError('CONFIG'), label);
  }
  assert.equal(JSON.parse(readFileSync(store.path, 'utf8')).version, 1);
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
  // A different workspace under the new name is not that account: nothing of the one that left is attributed to it.
  // It is a new account that can post, which is a widening of its own and nothing more.
  const unrelated = v2({ accounts: { 'cue/slack': account(ACC_B, { workspace: 'T_ELSE', mode: 'send' }) } });
  assert.deepEqual(classifyChange(before, unrelated).loosened, ['accounts.cue/slack.mode']);
});
