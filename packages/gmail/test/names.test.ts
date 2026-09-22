import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError, type Config, migrateNames, planNamesMigration, type SecretStore } from '@agentcomms/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { mcpInstall } from '../src/mcp/install.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { searchContacts } from '../src/operations/contacts.ts';
import { doctor } from '../src/operations/doctor.ts';
import { createDraft, listDrafts } from '../src/operations/drafts.ts';
import { importLegacy } from '../src/operations/import-legacy.ts';
import {
  inboxList,
  inboxPolicy,
  inboxRemove,
  inboxRename,
  orphanedSecretsPath,
  whoami,
} from '../src/operations/inboxes.ts';
import { readMessage, readThread } from '../src/operations/read.ts';
import { search } from '../src/operations/search.ts';
import { listApprovals } from '../src/operations/send.ts';
import { startSignIn } from '../src/operations/signin.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

/**
 * Organisation/platform names, end to end through the Gmail package.
 *
 * Nothing here can create a version-2 config the way a person will — that command arrives in a later release — so
 * each test migrates its own with core's `migrateNames`, exactly as `agentcomms names migrate` will.
 */

function is(code: string, pattern?: RegExp) {
  return (error: unknown) =>
    error instanceof CommsError && error.code === code && (pattern === undefined || pattern.test(error.message));
}

function base64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}

function message(id: string, from: string, subject: string): FakeMessage {
  return {
    id,
    threadId: id,
    labelIds: ['INBOX'],
    snippet: subject,
    internalDate: String(Date.parse('2026-09-20T09:00:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/html',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: subject },
      ],
      body: { size: 3, data: base64url('<p>hello</p>') },
    },
  };
}

async function migrate(harness: Harness, renames: string[] = []): Promise<void> {
  const plan = planNamesMigration(await harness.core.config.load(), renames);
  assert.equal(plan.status, 'ready');
  if (plan.status === 'ready') await migrateNames(harness.core.config, plan);
}

/** A registered OAuth client, as `client add` leaves it, and a context to use it. */
async function withClient(harness: Harness): Promise<GmailContext> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const path = join(tempDir(), 'client_secret.json');
  await writeFile(
    path,
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, project_id: 'proj' } }),
  );
  await clientAdd(context, { path, store: 'file' });
  return context;
}

/** Every `set` and `delete` the secret store sees, so a test can say what was left behind. */
function recordSecrets(store: SecretStore): { set: string[]; deleted: string[] } {
  const seen = { set: [] as string[], deleted: [] as string[] };
  const set = store.set.bind(store);
  const del = store.delete.bind(store);
  store.set = async (ref, value) => {
    seen.set.push(ref);
    return set(ref, value);
  };
  store.delete = async (ref) => {
    seen.deleted.push(ref);
    return del(ref);
  };
  return seen;
}

type Update = Harness['core']['config']['update'];

/** Makes the next config write commit and then reject — what a failed lock release does. */
function commitThenReject(harness: Harness): void {
  const original: Update = harness.core.config.update.bind(harness.core.config);
  let armed = true;
  harness.core.config.update = (async (mutator, options) => {
    const result = await original(mutator, options);
    if (!armed) return result;
    armed = false;
    throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
  }) as Update;
}

/** Makes the next config write reject without writing anything. */
function rejectBeforeWrite(harness: Harness): void {
  const original: Update = harness.core.config.update.bind(harness.core.config);
  let armed = true;
  harness.core.config.update = (async (mutator, options) => {
    if (!armed) return original(mutator, options);
    armed = false;
    throw new CommsError('LOCK_TIMEOUT', 'another process is holding the config lock');
  }) as Update;
}

// ── Every read path works under an organisation/platform name ───────────────────────────────────────────────────

test('a renamed mailbox reads, searches, drafts and reports under its new name', async () => {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: { m1: message('m1', 'Sam Lee <sam@partner.test>', 'Quarterly numbers') },
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  await migrate(harness, ['work=acme/gmail']);
  const context = new GmailContext({ core: harness.core, env: harness.env });

  const all = await search(context, { query: 'numbers' });
  assert.deepEqual(all.inboxes, ['acme/gmail']);
  assert.equal(all.rows.length, 1);
  const named = await search(context, { query: 'numbers', inboxes: ['acme/gmail'] });
  assert.equal(named.rows.length, 1);
  assert.match(named.enveloped, /\] acme\/gmail · /);

  const read = await readMessage(context, 'acme/gmail', 'm1');
  // Serialised, so the envelope's quotes arrive escaped.
  assert.match(JSON.stringify(read), /inbox=\\"acme\/gmail\\"/);
  await readThread(context, 'acme/gmail', 'm1');
  await searchContacts(context, 'sam', { inboxes: ['acme/gmail'] });
  await createDraft(context, 'acme/gmail', { to: ['sam@partner.test'], subject: 'Re', text: 'Thanks' });
  assert.equal((await listDrafts(context, 'acme/gmail')).length, 1);
  assert.equal((await whoami(context, 'acme/gmail')).email, 'jo@example.test');
  assert.deepEqual(
    (await inboxList(context)).map((row) => row.alias),
    ['acme/gmail'],
  );
});

// ── A former name is refused with its replacement, everywhere a person can type one ─────────────────────────────

test('a former name is refused with the new one on every path that takes a mailbox name', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  await migrate(harness);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await inboxRename(context, 'work/gmail', 'acme/gmail');

  const renamed = is('NOT_FOUND', /renamed to "acme\/gmail"/);
  for (const name of ['work', 'work/gmail']) {
    await assert.rejects(context.inbox(name), renamed, `context.inbox(${name})`);
    await assert.rejects(search(context, { query: 'x', inboxes: [name] }), renamed, `search ${name}`);
    await assert.rejects(listApprovals(context, { inbox: name }), renamed, `send list ${name}`);
    await assert.rejects(inboxPolicy(context, name, 'never'), renamed, `policy ${name}`);
    await assert.rejects(inboxRename(context, name, 'other/gmail'), renamed, `rename ${name}`);
    await assert.rejects(inboxRemove(context, name), renamed, `remove ${name}`);
    await assert.rejects(
      mcpInstall(context, { client: 'json', inbox: name, noVerify: true, apply: false, launcher: 'local' }),
      renamed,
      `mcp install --inbox ${name} --no-verify`,
    );
    const report = await doctor(context, { inbox: name });
    const known = report.checks.find((check) => check.id === 'inbox-known');
    assert.match(known?.detail ?? '', /renamed to "acme\/gmail"/, `doctor --inbox ${name}`);
    assert.equal(known?.fix, 'agent-gmail doctor --inbox acme/gmail');
  }
});

test('a former name can never be taken again, by a rename or a new sign-in', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  await migrate(harness);
  await inboxRename(context, 'work/gmail', 'acme/gmail');

  await assert.rejects(inboxRename(context, 'acme/gmail', 'work/gmail'), is('CONFIG', /cannot be used again/));
  await assert.rejects(
    startSignIn(context, { mode: 'add', alias: 'work/gmail', detached: false }),
    is('CONFIG', /cannot be used again/),
  );
});

// ── Names are checked when a sign-in starts, and again when it finishes ─────────────────────────────────────────

test('a name the config cannot take is refused before the browser opens', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  await harness.addInbox({ alias: 'work', email: 'other@example.test', sub: 'sub-9', refreshToken: 'rt' });

  await assert.rejects(startSignIn(context, { mode: 'add', alias: 'work', detached: false }), is('CONFIG', /exists/));
  await assert.rejects(startSignIn(context, { mode: 'add', alias: 'Not A Name', detached: false }), is('USAGE'));

  await migrate(harness);
  await assert.rejects(
    startSignIn(context, { mode: 'add', alias: 'home', detached: false }),
    is('USAGE', /acme\/gmail/),
  );
  await assert.rejects(
    startSignIn(context, { mode: 'add', alias: 'home/slack', detached: false }),
    is('USAGE', /ends in \/slack/),
  );
});

test('a sign-in started before the migration and finished after it is refused, with nothing stored', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const seen = recordSecrets(await harness.core.secrets('file'));

  const started = await startSignIn(context, { mode: 'add', alias: 'home', detached: false });
  await migrate(harness);
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  await assert.rejects(started.listener?.result ?? Promise.resolve(), is('USAGE', /not a valid name/));
  assert.deepEqual(
    seen.set.filter((ref) => ref.startsWith('gmail:refresh:')),
    [],
    'refused before any token was stored',
  );
  assert.deepEqual(await inboxList(context), []);
});

test('a migration landing between the last check and the write is caught under the lock, and the token taken back', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  // The migration runs while the token is being stored: after every check made on a snapshot, before the write.
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    await store(ref, value);
    if (ref.startsWith('gmail:refresh:')) await migrate(harness);
  };

  const started = await startSignIn(context, { mode: 'add', alias: 'home', detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  await assert.rejects(started.listener?.result ?? Promise.resolve(), is('USAGE', /not a valid name/));

  const tokens = seen.set.filter((ref) => ref.startsWith('gmail:refresh:'));
  assert.equal(tokens.length, 1);
  assert.deepEqual(
    seen.deleted.filter((ref) => ref.startsWith('gmail:refresh:')),
    tokens,
    'taken back',
  );
  assert.deepEqual(await inboxList(context), []);
});

test('a sign-in that finishes on a migrated config under a valid name connects', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  await migrate(harness);
  const started = await startSignIn(context, { mode: 'add', alias: 'acme/gmail', detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  const result = await started.listener?.result;
  assert.equal(result?.alias, 'acme/gmail');
});

// ── Gmail add: a rejected write is looked at before anything is undone ──────────────────────────────────────────

test('add: a write that committed and then reported failure keeps the mailbox and its token', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const secrets = await harness.core.secrets('file');
  const started = await startSignIn(context, { mode: 'add', alias: 'work', detached: false });
  commitThenReject(harness);
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  const result = await started.listener?.result;
  assert.equal(result?.alias, 'work');
  assert.ok(result && (await secrets.get(result.inbox.secretRef)), 'the token the config names is still there');
});

test('add: a write that did not happen takes the token back, and says so if it cannot', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);

  const first = await startSignIn(context, { mode: 'add', alias: 'work', detached: false });
  rejectBeforeWrite(harness);
  await fetch(harness.google.consent(first.authUrl, { sub: 'sub-1' }));
  await assert.rejects(first.listener?.result ?? Promise.resolve(), is('LOCK_TIMEOUT'));
  const stored = seen.set.filter((ref) => ref.startsWith('gmail:refresh:'));
  assert.equal(stored.length, 1);
  assert.equal(await secrets.get(stored[0] ?? ''), null, 'withdrawn');

  // And when the withdrawal itself fails, the stranded reference is named rather than swallowed.
  const second = await startSignIn(context, { mode: 'add', alias: 'work', detached: false });
  rejectBeforeWrite(harness);
  secrets.delete = async () => {
    throw new Error('the keychain is locked');
  };
  await fetch(harness.google.consent(second.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    second.listener?.result ?? Promise.resolve(),
    (error: unknown) =>
      error instanceof CommsError &&
      /^gmail:refresh:/.test(String((error.details as { strandedSecretRef?: string }).strandedSecretRef)),
  );
});

// ── Gmail reauth: under the credentials lock, by id ─────────────────────────────────────────────────────────────

async function connectBySignIn(harness: Harness, context: GmailContext, alias: string): Promise<string> {
  const started = await startSignIn(context, { mode: 'add', alias, detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  const result = await started.listener?.result;
  assert.ok(result);
  return result.inbox.id;
}

test('reauth: a removal that finished first leaves nothing written', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work');
  const secrets = await harness.core.secrets('file');

  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', detached: false });
  await inboxRemove(context, 'work');
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('NOT_FOUND', /no longer exists/));
  assert.equal(await secrets.get(`gmail:refresh:${id}`), null, 'the removed mailbox’s token was not written back');
  assert.deepEqual(await inboxList(context), []);
});

test('reauth: a rename made while it was open is followed, not undone', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work');

  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', detached: false });
  await inboxRename(context, 'work', 'home');
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  const result = await reauth.listener?.result;
  assert.equal(result?.alias, 'home');
  assert.equal(result?.inbox.id, id);
  assert.deepEqual(
    (await inboxList(context)).map((row) => row.alias),
    ['home'],
  );
});

test('reauth keeps a policy set while it was open', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  await connectBySignIn(harness, context, 'work');
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', detached: false });
  await inboxPolicy(context, 'work', 'never');
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await reauth.listener?.result;
  assert.equal((await inboxList(context))[0]?.sendPolicy, 'never');
});

// ── Gmail removal: under the credentials lock, and a rejected write looked at ───────────────────────────────────

test('remove: a write that committed and then reported failure still deletes the token', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const inbox = await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const secrets = await harness.core.secrets('file');
  commitThenReject(harness);
  await inboxRemove(context, 'work');
  assert.deepEqual(await inboxList(context), []);
  assert.equal(await secrets.get(inbox.secretRef), null);
});

test('remove: a write that did not happen leaves the mailbox and its token exactly as they were', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const inbox = await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const secrets = await harness.core.secrets('file');
  rejectBeforeWrite(harness);
  await assert.rejects(inboxRemove(context, 'work'), is('LOCK_TIMEOUT'));
  assert.equal((await inboxList(context)).length, 1);
  assert.equal(await secrets.get(inbox.secretRef), 'rt');
});

test('remove: when nobody can tell whether it worked, the token is kept, and doctor does not advise deleting it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const inbox = await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const secrets = await harness.core.secrets('file');

  // The write is refused and then the config cannot be read back.
  const original: Update = harness.core.config.update.bind(harness.core.config);
  const readConfig = context.config.bind(context);
  let unreadable = false;
  harness.core.config.update = (async () => {
    unreadable = true;
    throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
  }) as Update;
  context.config = async (): Promise<Config> => {
    if (unreadable) throw new CommsError('CONFIG', 'config.json could not be read');
    return readConfig();
  };
  await assert.rejects(
    inboxRemove(context, 'work'),
    (error: unknown) =>
      error instanceof CommsError &&
      (error.details as { possiblyStrandedSecretRef?: string }).possiblyStrandedSecretRef === inbox.secretRef,
  );
  harness.core.config.update = original;
  context.config = readConfig;

  assert.equal(await secrets.get(inbox.secretRef), 'rt', 'kept');
  const recorded = JSON.parse((await readFile(orphanedSecretsPath(context), 'utf8')).trim()) as Record<string, unknown>;
  assert.equal(recorded.unconfirmed, true);
  assert.equal(recorded.inboxId, inbox.id);

  // The mailbox is in fact still connected, so doctor reports the record as in use and advises nothing.
  const report = await doctor(context);
  const orphans = report.checks.find((check) => check.id === 'orphaned-secrets');
  assert.equal(orphans?.status, 'ok');
  assert.match(orphans?.detail ?? '', /belong to a connected mailbox/);
  assert.equal(orphans?.fix, undefined);
});

// ── The legacy import ───────────────────────────────────────────────────────────────────────────────────────────

async function mintToken(harness: Harness, sub: string): Promise<string> {
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: [SCOPES.gmailModify],
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl, { sub })).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  return tokens.refreshToken;
}

async function legacyDirectory(harness: Harness): Promise<string> {
  const directory = join(tempDir(), '.gmail-mcp');
  await mkdir(directory, { recursive: true });
  const files: Record<string, unknown> = {
    'gcp-oauth.keys.json': { installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } },
    'creds-work.json': { tokens: { refresh_token: await mintToken(harness, 'sub-1') }, scopes: [SCOPES.gmailModify] },
    'creds-home.json': { tokens: { refresh_token: await mintToken(harness, 'sub-2') }, scopes: [SCOPES.gmailModify] },
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(content));
  return directory;
}

const twoAccounts = {
  accounts: [
    { sub: 'sub-1', email: 'jo@example.test' },
    { sub: 'sub-2', email: 'jo@home.test' },
  ],
};

test('import on a migrated config proposes <name>/gmail, and --rename overrides one', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await migrate(harness);

  const dry = await importLegacy(context, { dir: directory, dryRun: true, renames: ['work=acme/gmail'] });
  assert.deepEqual(dry.imported.map((row) => row.alias).sort(), ['acme/gmail', 'home/gmail']);

  await importLegacy(context, { dir: directory, store: 'file', renames: ['work=acme/gmail'] });
  assert.deepEqual(
    (await inboxList(context)).map((row) => row.alias).sort(),
    ['acme/gmail', 'home/gmail'],
  );
});

test('import refuses every bad name together, and writes nothing', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await migrate(harness);
  const seen = recordSecrets(await harness.core.secrets('file'));

  await assert.rejects(
    importLegacy(context, {
      dir: directory,
      store: 'file',
      renames: ['work=acme/gmail', 'home=acme/gmail', 'nope=x/gmail', 'broken'],
    }),
    (error: unknown) => {
      if (!(error instanceof CommsError) || error.code !== 'USAGE') return false;
      const problems = (error.details as { problems: string[] }).problems;
      assert.ok(problems.some((p) => /given to more than one mailbox/.test(p)), problems.join('\n'));
      assert.ok(problems.some((p) => /no credentials file is called "nope"/.test(p)));
      assert.ok(problems.some((p) => /"broken" is not/.test(p)));
      return true;
    },
  );
  assert.deepEqual(seen.set, [], 'no secret was written');
  assert.deepEqual(await inboxList(context), []);
});

test('import under a name another Google project already uses is refused, not overwritten', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({
    ...config,
    secrets: { store: 'file' },
    clients: {
      imported: { provider: 'gmail', clientId: 'another-project', secretRef: 'gmail:client:imported', addedAt: 'x' },
    },
  }));
  const secrets = await harness.core.secrets('file');
  await secrets.set('gmail:client:imported', 'the other project’s secret');

  await assert.rejects(importLegacy(context, { dir: directory }), is('CONFIG', /different Google project/));
  assert.equal(await secrets.get('gmail:client:imported'), 'the other project’s secret');
});
