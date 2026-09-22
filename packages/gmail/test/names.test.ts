import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type ClientConfig,
  CommsError,
  type Config,
  credentialsLockPath,
  formerNamesOf,
  inboxProfileFile,
  readComposeProfile,
  type SecretStore,
  withFileLock,
} from '@agentcomms/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { clientSecretRef } from '../src/auth/session.ts';
import { renderSetupPlan } from '../src/cli/render.ts';
import { GmailContext } from '../src/context.ts';
import { mcpInstall } from '../src/mcp/install.ts';
import { threadTimeline } from '../src/operations/analyse.ts';
import { clientAdd, clientRemove } from '../src/operations/clients.ts';
import { followUps, searchContacts } from '../src/operations/contacts.ts';
import { doctor } from '../src/operations/doctor.ts';
import { createDraft, listDrafts } from '../src/operations/drafts.ts';
import { exportMail } from '../src/operations/export.ts';
import { importLegacy } from '../src/operations/import-legacy.ts';
import {
  inboxList,
  inboxPolicy,
  inboxRemove,
  inboxRename,
  orphanedSecretsPath,
  whoami,
} from '../src/operations/inboxes.ts';
import { modify } from '../src/operations/organise.ts';
import { readMessage, readThread } from '../src/operations/read.ts';
import { search } from '../src/operations/search.ts';
import { listApprovals } from '../src/operations/send.ts';
import { startSignIn } from '../src/operations/signin.ts';
import type { FakeMessage } from './support/fake-google.ts';
import {
  type Harness,
  migrateNamesForTest,
  newHarness,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  tempDir,
} from './support/harness.ts';

/**
 * Organisation/platform names, end to end through the Gmail package.
 *
 * The harness starts every config at version 1 — most tests in this package are about mail rather than about
 * names, and a fixture that says which version it is written for does not drift. The tests that are about names
 * migrate it first with `migrateNamesForTest`, which runs core's own migration: the one the command runs.
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

const migrate = migrateNamesForTest;

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

async function connectBySignIn(
  harness: Harness,
  context: GmailContext,
  alias: string,
  tier: 'read' | 'organize' = 'organize',
): Promise<string> {
  const started = await startSignIn(context, { mode: 'add', alias, tier, detached: false });
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
  const seen = recordSecrets(secrets);
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('NOT_FOUND', /no longer exists/));
  // Not written and then taken back: never written at all.
  assert.deepEqual(seen.set, [], 'the removed mailbox’s token was not written back');
  assert.equal(await secrets.get(`gmail:refresh:${id}`), null);
  assert.deepEqual(await inboxList(context), []);
});

test('reauth: a removal that starts while it is writing waits for it, then removes', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work');
  const secrets = await harness.core.secrets('file');

  // The removal is started from inside the reauth's token write — the middle of its critical section.
  let removal: Promise<unknown> | undefined;
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    if (ref === `gmail:refresh:${id}` && !removal) removal = inboxRemove(context, 'work');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return store(ref, value);
  };
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  const result = await reauth.listener?.result;
  assert.equal(result?.reauthorised, true, 'the reauth finished first');
  await removal;
  assert.deepEqual(await inboxList(context), [], 'and the removal after it');
  assert.equal(await secrets.get(`gmail:refresh:${id}`), null, 'leaving no token behind');
});

test('reauth: a rename made while it was open is followed, not undone', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');

  // An upgrade, so what the reauth writes differs from what is there and a write that did not land cannot pass.
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await inboxRename(context, 'work', 'home');
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  const result = await reauth.listener?.result;
  assert.equal(result?.alias, 'home');
  assert.equal(result?.inbox.id, id);
  const rows = await inboxList(context);
  assert.deepEqual(
    rows.map((row) => `${row.alias}:${row.tier}`),
    ['home:organize'],
  );
});

test('reauth keeps a policy set while it was writing', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work');
  const secrets = await harness.core.secrets('file');
  // Set from inside the reauth's token write: after it read the row, before it writes the row back.
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    await store(ref, value);
    if (ref === `gmail:refresh:${id}`) await inboxPolicy(context, 'work', 'never');
  };
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await reauth.listener?.result;
  assert.equal((await inboxList(context))[0]?.sendPolicy, 'never');
});

test('remove: two removals of one mailbox at once — one removes it, the other is told it is gone', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const outcomes = await Promise.allSettled([inboxRemove(context, 'work'), inboxRemove(context, 'work')]);
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ['fulfilled', 'rejected']);
  const refused = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.ok(refused && is('NOT_FOUND')((refused as PromiseRejectedResult).reason));
});

test('reauth: a write that committed and then reported failure is a reauth that worked', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  await connectBySignIn(harness, context, 'work', 'read');
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  commitThenReject(harness);
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  assert.equal((await reauth.listener?.result)?.reauthorised, true);
  assert.equal((await inboxList(context))[0]?.tier, 'organize');
});

test('reauth: a write that did not happen is reported, not mistaken for one that did', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const before = await secrets.get(`gmail:refresh:${id}`);
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  rejectBeforeWrite(harness);
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('LOCK_TIMEOUT'));
  assert.equal((await inboxList(context))[0]?.tier, 'read', 'the row is as it was');
  // And so is the token under it: the row still names the old grant, so the old token is put back.
  assert.equal(await secrets.get(`gmail:refresh:${id}`), before);
});

test('reauth: when the credentials lock cannot be had, it says nothing was saved — and nothing was', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  const seen = recordSecrets(await harness.core.secrets('file'));
  await withFileLock(credentialsLockPath(harness.configDir), async () => {
    await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
    await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('TRANSIENT', /nothing was saved/));
  });
  assert.deepEqual(seen.set, [], `no token written for ${id}`);
  assert.equal((await inboxList(context))[0]?.tier, 'read');
});

test('add: a secret store switched away while it finished is caught, and the token taken back', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  // `secrets migrate` switches the backend after the token went into the old one.
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    await store(ref, value);
    if (ref.startsWith('gmail:refresh:')) {
      await harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } }));
    }
  };
  const started = await startSignIn(context, { mode: 'add', alias: 'work', detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  await assert.rejects(started.listener?.result ?? Promise.resolve(), is('TRANSIENT', /secret store was changed/));
  const token = seen.set.find((ref) => ref.startsWith('gmail:refresh:'));
  assert.ok(token && seen.deleted.includes(token), 'withdrawn from the store it went into');
});

test('remove: waits for the credentials lock', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  let released = false;
  let removedWhileHeld = false;
  let running: Promise<void> | undefined;
  await withFileLock(credentialsLockPath(harness.configDir), async () => {
    running = inboxRemove(context, 'work').then(() => {
      removedWhileHeld = !released;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    released = true;
  });
  await running;
  assert.equal(removedWhileHeld, false);
  assert.deepEqual(await inboxList(context), []);
});

test('reauth: with no previous token to put back, a write that did not happen leaves no new one either', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  await secrets.delete(`gmail:refresh:${id}`);
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  rejectBeforeWrite(harness);
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('LOCK_TIMEOUT'));
  assert.equal(await secrets.get(`gmail:refresh:${id}`), null, 'back as it was: no token');
});

test('client add and an import racing for one client name: one registers it, and keeps its own secret', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  const legacy = join(tempDir(), '.gmail-mcp');
  await mkdir(legacy, { recursive: true });
  await writeFile(
    join(legacy, 'gcp-oauth.keys.json'),
    JSON.stringify({
      installed: { client_id: 'project-b.apps.googleusercontent.com', client_secret: 'fake-secret-b' },
    }),
  );
  const outcomes = await Promise.allSettled([
    clientAdd(context, { path: json, name: 'imported', store: 'file', noProbe: true }),
    importLegacy(context, { dir: legacy }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  const registered = (await harness.core.config.load()).clients.imported;
  const secret = await (await harness.core.secrets('file')).get(clientSecretRef('imported'));
  assert.equal(secret, registered?.clientId.startsWith('project-a') ? 'fake-secret-a' : 'fake-secret-b');
});

test('remove: when the leftover token cannot even be recorded, it says so rather than promising doctor will list it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const secrets = await harness.core.secrets('file');
  secrets.delete = async () => {
    throw new Error('the keychain is locked');
  };
  // A directory where the record file should go: appending to it fails.
  await mkdir(orphanedSecretsPath(context), { recursive: true });
  const removed = await inboxRemove(context, 'work');
  assert.ok(removed.orphanedSecret);
  assert.equal(removed.orphanRecorded, false);
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
  assert.deepEqual((await inboxList(context)).map((row) => row.alias).sort(), ['acme/gmail', 'home/gmail']);
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
      assert.ok(
        problems.some((p) => /given to more than one mailbox/.test(p)),
        problems.join('\n'),
      );
      assert.ok(problems.some((p) => /no credentials file is called "nope"/.test(p)));
      assert.ok(problems.some((p) => /"broken" is not/.test(p)));
      return true;
    },
  );
  assert.deepEqual(seen.set, [], 'no secret was written');
  assert.deepEqual(await inboxList(context), []);
});

test('import: a mailbox connected under the same name while it runs is not overwritten', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const secrets = await harness.core.secrets('file');
  // While the first imported token is being stored, somebody connects a mailbox under the name it was going to take.
  const store = secrets.set.bind(secrets);
  let raced: string | undefined;
  let fired = false;
  secrets.set = async (ref, value) => {
    await store(ref, value);
    // Once: connecting the other mailbox stores a token too, and must not set this off again.
    if (ref.startsWith('gmail:refresh:') && !fired) {
      fired = true;
      raced = (await harness.addInbox({ alias: 'home', email: 'other@x.test', sub: 'sub-9', refreshToken: 'rt' })).id;
    }
  };
  await assert.rejects(importLegacy(context, { dir: directory, store: 'file' }), is('CONFIG', /already exists/));
  const rows = await inboxList(context);
  assert.equal(rows.find((row) => row.alias === 'home')?.id, raced, 'the mailbox connected meanwhile is intact');
});

/** Arms the n-th config write from now (1-based) to fail in one of the ways a write can fail. */
function failNthWrite(
  harness: Harness,
  n: number,
  how: 'commit-then-reject' | 'reject' | 'unknown',
  context?: GmailContext,
): void {
  const original: Update = harness.core.config.update.bind(harness.core.config);
  let count = 0;
  harness.core.config.update = (async (mutator, options) => {
    count += 1;
    if (count !== n) return original(mutator, options);
    if (how === 'reject') throw new CommsError('LOCK_TIMEOUT', 'another process is holding the config lock');
    if (how === 'commit-then-reject') {
      await original(mutator, options);
      throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
    }
    if (context) {
      context.config = async () => {
        throw new CommsError('CONFIG', 'config.json could not be read');
      };
    }
    throw new CommsError('LOCK_TIMEOUT', 'the lock could not be released');
  }) as Update;
}

test('import: each write — the client and every mailbox — is looked at before anything is undone', async () => {
  // Write 1 records the OAuth client; writes 2 and 3 record the mailboxes, in file order (home, then work).
  const cases: Array<{ write: number; how: 'commit-then-reject' | 'reject' | 'unknown'; expect: RegExp | null }> = [
    { write: 1, how: 'commit-then-reject', expect: null },
    // A client's reference is name-derived and shared, so it is never taken back — only named.
    { write: 1, how: 'reject', expect: /strandedSecretRef/ },
    { write: 1, how: 'unknown', expect: /possiblyStrandedSecretRef/ },
    { write: 2, how: 'commit-then-reject', expect: null },
    { write: 2, how: 'reject', expect: /LOCK_TIMEOUT/ },
    { write: 2, how: 'unknown', expect: /possiblyStrandedSecretRef/ },
  ];
  for (const { write, how, expect } of cases) {
    const harness = await newHarness(twoAccounts);
    const context = new GmailContext({ core: harness.core, env: harness.env });
    const directory = await legacyDirectory(harness);
    await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
    const secrets = await harness.core.secrets('file');
    const seen = recordSecrets(secrets);
    failNthWrite(harness, write, how, context);
    const label = `write ${write}, ${how}`;
    if (expect === null) {
      const result = await importLegacy(context, { dir: directory, store: 'file' });
      assert.equal(result.imported.length, 2, label);
      continue;
    }
    const error = await importLegacy(context, { dir: directory, store: 'file' }).then(
      () => assert.fail(`${label}: should have failed`),
      (caught: unknown) => caught,
    );
    assert.match(`${(error as CommsError).code} ${JSON.stringify((error as CommsError).details ?? {})}`, expect, label);
    const failedRef = seen.set.at(-1) ?? '';
    const keptAnyway = write === 1; // the client's reference, which is never withdrawn
    if (how === 'reject' && !keptAnyway) assert.ok(seen.deleted.includes(failedRef), `${label}: withdrawn`);
    if (how === 'unknown' || keptAnyway) assert.ok(!seen.deleted.includes(failedRef), `${label}: kept`);
  }
});

test('import: a failed withdrawal names the credential it left behind', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const secrets = await harness.core.secrets('file');
  secrets.delete = async () => {
    throw new Error('the keychain is locked');
  };
  failNthWrite(harness, 2, 'reject');
  await assert.rejects(
    importLegacy(context, { dir: directory, store: 'file' }),
    (error: unknown) =>
      error instanceof CommsError &&
      /^gmail:refresh:/.test(String((error.details as { strandedSecretRef?: string }).strandedSecretRef)),
  );
});

test('import: two imports racing for one client name from two projects cannot both write it', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const project = async (clientId: string, clientSecret: string) => {
    const directory = join(tempDir(), '.gmail-mcp');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'gcp-oauth.keys.json'),
      JSON.stringify({ installed: { client_id: clientId, client_secret: clientSecret } }),
    );
    return directory;
  };
  const a = await project('project-a.apps.googleusercontent.com', 'fake-secret-a');
  const b = await project('project-b.apps.googleusercontent.com', 'fake-secret-b');
  const outcomes = await Promise.allSettled([importLegacy(context, { dir: a }), importLegacy(context, { dir: b })]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
  const registered = (await harness.core.config.load()).clients.imported;
  const secret = await (await harness.core.secrets('file')).get(clientSecretRef('imported'));
  assert.equal(
    secret,
    registered?.clientId.startsWith('project-a') ? 'fake-secret-a' : 'fake-secret-b',
    'the secret is the registered project’s own',
  );
});

/** Runs `meddle` once, right after the first secret whose reference passes `when` is stored — mid-import. */
function meddleAfterStoring(store: SecretStore, when: (ref: string) => boolean, meddle: () => Promise<unknown>): void {
  const set = store.set.bind(store);
  let fired = false;
  store.set = async (ref, value) => {
    await set(ref, value);
    if (fired || !when(ref)) return;
    fired = true;
    await meddle();
  };
}

test('import: a client written by something outside the lock is not mistaken for this import’s own', async () => {
  // An older release, which knows no credentials lock, registers another project's client under the same name
  // between this import's check and its write.
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  meddleAfterStoring(
    await harness.core.secrets('file'),
    (ref) => ref === clientSecretRef('imported'),
    () =>
      harness.core.config.update((config) => ({
        ...config,
        clients: {
          imported: {
            provider: 'gmail',
            clientId: 'another-project',
            secretRef: clientSecretRef('imported'),
            addedAt: 'x',
          },
        },
      })),
  );
  await assert.rejects(
    importLegacy(context, { dir: directory, store: 'file' }),
    (error: unknown) =>
      error instanceof CommsError &&
      /was added while this ran/.test(error.message) &&
      (error.details as { contestedSecretRef?: string }).contestedSecretRef === clientSecretRef('imported'),
  );
  assert.deepEqual(await inboxList(context), [], 'no mailbox was attached to the other project’s client');
  // And the reference the other client's row names was not deleted from under it.
  assert.notEqual(await (await harness.core.secrets('file')).get(clientSecretRef('imported')), null);
});

test('import: a mailbox is not written under a client that changed after it was registered', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  meddleAfterStoring(
    secrets,
    (ref) => ref.startsWith('gmail:refresh:'),
    () =>
      harness.core.config.update((config) => ({
        ...config,
        clients: {
          imported: { ...(config.clients.imported as ClientConfig), clientId: 'replaced.apps.googleusercontent.com' },
        },
      })),
  );
  await assert.rejects(
    importLegacy(context, { dir: directory, store: 'file' }),
    is('CONFIG', /changed while this ran/),
  );
  const token = seen.set.find((ref) => ref.startsWith('gmail:refresh:'));
  assert.ok(token && seen.deleted.includes(token), 'its token taken back');
});

test('import: a secret store switched away mid-import is caught, and the token taken back', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  meddleAfterStoring(
    secrets,
    (ref) => ref.startsWith('gmail:refresh:'),
    () => harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } })),
  );
  await assert.rejects(
    importLegacy(context, { dir: directory, store: 'file' }),
    is('TRANSIENT', /secret store was changed/),
  );
  const token = seen.set.find((ref) => ref.startsWith('gmail:refresh:'));
  assert.ok(token && seen.deleted.includes(token), 'its token taken back');
});

test('import under a name another Google project already uses is refused, not overwritten', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({
    ...config,
    secrets: { store: 'file' },
    clients: {
      imported: {
        provider: 'gmail',
        clientId: 'another-project',
        secretRef: clientSecretRef('imported'),
        addedAt: 'x',
      },
    },
  }));
  const secrets = await harness.core.secrets('file');
  await secrets.set(clientSecretRef('imported'), 'the other project’s secret');

  await assert.rejects(importLegacy(context, { dir: directory }), is('CONFIG', /different Google project/));
  assert.equal(await secrets.get(clientSecretRef('imported')), 'the other project’s secret');
});

// ── Downloads under former names ────────────────────────────────────────────────────────────────────────────────

async function downloadsHere(harness: Harness): Promise<string> {
  const downloads = tempDir('agent-gmail-downloads-');
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, downloadsDir: downloads } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.downloadsDir'] } },
  );
  return downloads;
}

test('doctor mentions downloads left under a former name, once, and moves nothing', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const downloads = await downloadsHere(harness);
  await migrate(harness);

  // Before anything is left over: the new folder alone is the new layout, not a leftover.
  await mkdir(join(downloads, 'work', 'gmail'), { recursive: true });
  let report = await doctor(context);
  assert.equal(
    report.checks.find((check) => check.id === 'former-download-folders'),
    undefined,
  );

  await writeFile(join(downloads, 'work', 'invoice.pdf'), 'from before the rename');
  report = await doctor(context);
  const folders = report.checks.filter((check) => check.id === 'former-download-folders');
  assert.equal(folders.length, 1);
  assert.match(folders[0]?.detail ?? '', /1 item\(s\) from before "work" became "work\/gmail"/);
  assert.equal(await readFile(join(downloads, 'work', 'invoice.pdf'), 'utf8'), 'from before the rename', 'not moved');
});

test('a nested name cannot be used to write through a symlinked folder out of the downloads root', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  const downloads = await downloadsHere(harness);
  await migrate(harness, ['work=acme/gmail']);
  const elsewhere = tempDir('agent-gmail-elsewhere-');
  await symlink(elsewhere, join(downloads, 'acme'));
  await assert.rejects(exportMail(context, 'acme/gmail', 'm1'), (error: unknown) => error instanceof CommsError);
  assert.deepEqual(await readdir(elsewhere), [], 'nothing written outside the root');
});

test('setup’s examples name a mailbox the config will accept', () => {
  const state = { next: 'inbox', done: [], clients: ['desktop'], inboxes: [], registeredWith: [], candidates: [] };
  assert.match(renderSetupPlan({ ...state, nameExample: 'acme/gmail' }, [], false), /--inbox acme\/gmail/);
  assert.match(renderSetupPlan(state, [], false), /--inbox work/);
});

test('doctor --inbox reports only that mailbox’s leftover folders', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'jo@home.test' },
    ],
  });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt' });
  await harness.addInbox({ alias: 'home', email: 'jo@home.test', sub: 'sub-2', refreshToken: 'rt2' });
  const downloads = await downloadsHere(harness);
  await migrate(harness);
  for (const former of ['work', 'home']) {
    await mkdir(join(downloads, former), { recursive: true });
    await writeFile(join(downloads, former, 'old.pdf'), 'x');
  }
  const scoped = await doctor(context, { inbox: 'work/gmail' });
  const detail = scoped.checks.find((check) => check.id === 'former-download-folders')?.detail ?? '';
  assert.match(detail, /"work" became "work\/gmail"/);
  assert.doesNotMatch(detail, /home/);
});

test('client add refuses to register into a store that moved while it ran', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  // `secrets migrate` finishing between the secret write and the row write.
  meddleAfterStoring(
    await harness.core.secrets('file'),
    (ref) => ref === clientSecretRef('desktop'),
    () => harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } })),
  );
  await assert.rejects(
    clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true }),
    is('TRANSIENT', /secret store was changed/),
  );
  assert.equal((await harness.core.config.load()).clients.desktop, undefined);
});

test('client remove waits for the credentials lock', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  let released = false;
  let removedWhileHeld = false;
  let running: Promise<unknown> | undefined;
  await withFileLock(credentialsLockPath(harness.configDir), async () => {
    running = clientRemove(context, 'desktop').then(() => {
      removedWhileHeld = !released;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    released = true;
  });
  await running;
  assert.equal(removedWhileHeld, false);
  assert.equal((await harness.core.config.load()).clients.desktop, undefined);
});

test('reauth: a token write that lands and then reports failure still puts the old token back', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const before = await secrets.get(`gmail:refresh:${id}`);
  // A keychain write that stores the value and then reports a timeout.
  const store = secrets.set.bind(secrets);
  let armed = true;
  secrets.set = async (ref, value) => {
    await store(ref, value);
    if (!armed || ref !== `gmail:refresh:${id}`) return;
    armed = false;
    throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the keychain timed out');
  };
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), (error: unknown) => error instanceof CommsError);
  assert.equal(await secrets.get(`gmail:refresh:${id}`), before, 'the old token is back under the row that names it');
  assert.equal((await inboxList(context))[0]?.tier, 'read');
});

test('client add refuses a store that moved while it waited for the credentials lock', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  // The store changes while the command is queued behind the lock — the window before any of its writes.
  const seen = recordSecrets(await harness.core.secrets('file'));
  let running: Promise<unknown> | undefined;
  await withFileLock(credentialsLockPath(harness.configDir), async () => {
    running = clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } }));
  });
  await assert.rejects(running ?? Promise.resolve(), is('TRANSIENT', /secret store was changed/));
  assert.equal((await harness.core.config.load()).clients.desktop, undefined);
  // Refused before writing, not after: nothing was put into the store it was about to leave.
  assert.deepEqual(seen.set, []);
});

test('client remove refuses when the client under the name changed since it was read', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  const secrets = await harness.core.secrets('file');
  // Something that holds no lock — an older release — replaces the row between the read and the write.
  const read = context.config.bind(context);
  let swapped = false;
  context.config = async () => {
    const config = await read();
    if (!swapped) {
      swapped = true;
      await harness.core.config.update((current) => ({
        ...current,
        clients: { desktop: { ...(current.clients.desktop as ClientConfig), clientId: 'another-project' } },
      }));
    }
    return config;
  };
  await assert.rejects(clientRemove(context, 'desktop'), is('CONFIG', /changed while it was being removed/));
  context.config = read;
  assert.ok((await harness.core.config.load()).clients.desktop, 'the other client’s row is still there');
  assert.notEqual(await secrets.get(clientSecretRef('desktop')), null, 'and its secret was not deleted');
});

test('a sign-in whose OAuth client was replaced while it ran saves nothing', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  // `client add --replace` landing between the exchange and the write: the token belongs to the old client.
  meddleAfterStoring(
    secrets,
    (ref) => ref.startsWith('gmail:refresh:'),
    () =>
      harness.core.config.update((config) => ({
        ...config,
        clients: {
          default: { ...(config.clients.default as ClientConfig), clientId: 'replaced.apps.googleusercontent.com' },
        },
      })),
  );
  const started = await startSignIn(context, { mode: 'add', alias: 'work', detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    started.listener?.result ?? Promise.resolve(),
    is('CONFIG', /changed while this sign-in was being completed/),
  );
  const token = seen.set.find((ref) => ref.startsWith('gmail:refresh:'));
  assert.ok(token && seen.deleted.includes(token), 'the token taken back');
  assert.deepEqual(await inboxList(context), []);
});

test('client remove refuses when a mailbox started using the client while it ran', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  const secrets = await harness.core.secrets('file');
  const read = context.config.bind(context);
  let attached = false;
  context.config = async () => {
    const config = await read();
    if (!attached) {
      attached = true;
      // Only a mailbox row, leaving the client row exactly as it is: the client's own check must not be what fires.
      await harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          work: {
            id: 'ibx_WWWWWWWWWWWWWWWW',
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc' as const,
            sub: 'sub-1',
            client: 'desktop',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_WWWWWWWWWWWWWWWW',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      }));
    }
    return config;
  };
  await assert.rejects(clientRemove(context, 'desktop'), is('CONFIG', /began using "desktop"/));
  context.config = read;
  assert.ok((await harness.core.config.load()).clients.desktop);
  assert.notEqual(await secrets.get(clientSecretRef('desktop')), null, 'its secret was not deleted');
});

test('client remove: a write that committed and then reported failure still deletes the secret', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  const secrets = await harness.core.secrets('file');
  commitThenReject(harness);
  await clientRemove(context, 'desktop');
  assert.equal((await harness.core.config.load()).clients.desktop, undefined);
  assert.equal(await secrets.get(clientSecretRef('desktop')), null);
});

test('import: an account connected under another name while it ran is not connected twice', async () => {
  const harness = await newHarness(twoAccounts);
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const directory = await legacyDirectory(harness);
  await harness.core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  const secrets = await harness.core.secrets('file');
  const seen = recordSecrets(secrets);
  meddleAfterStoring(
    secrets,
    (ref) => ref.startsWith('gmail:refresh:'),
    async () => {
      // The same account, under another name, from somewhere that holds no lock.
      await harness.addInbox({
        alias: 'elsewhere',
        email: 'jo@home.test',
        sub: 'sub-2',
        refreshToken: 'rt',
        client: 'imported',
      });
    },
  );
  await assert.rejects(importLegacy(context, { dir: directory, store: 'file' }), is('CONFIG', /while this ran/));
  // The import's own token is the first one stored; the mailbox connected meanwhile stores one too.
  const token = seen.set.find((ref) => ref.startsWith('gmail:refresh:'));
  assert.ok(token && seen.deleted.includes(token), 'its token taken back');
});

test('a reauth whose OAuth client was replaced while it ran saves nothing, and restores the old token', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const before = await secrets.get(`gmail:refresh:${id}`);
  meddleAfterStoring(
    secrets,
    (ref) => ref === `gmail:refresh:${id}`,
    () =>
      harness.core.config.update((config) => ({
        ...config,
        clients: {
          default: { ...(config.clients.default as ClientConfig), clientId: 'replaced.apps.googleusercontent.com' },
        },
      })),
  );
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    reauth.listener?.result ?? Promise.resolve(),
    is('CONFIG', /changed while this sign-in was being completed/),
  );
  assert.equal(await secrets.get(`gmail:refresh:${id}`), before, 'the old token is back');
  assert.equal((await inboxList(context))[0]?.tier, 'read');
});

test('client add --replace refuses when a mailbox attached to the client while it waited for the lock', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const first = join(tempDir(), 'client_secret.json');
  await writeFile(
    first,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: first, name: 'desktop', store: 'file', noProbe: true });
  const second = join(tempDir(), 'other_secret.json');
  await writeFile(
    second,
    JSON.stringify({
      installed: { client_id: 'project-b.apps.googleusercontent.com', client_secret: 'fake-secret-b' },
    }),
  );
  let running: Promise<unknown> | undefined;
  await withFileLock(credentialsLockPath(harness.configDir), async () => {
    running = clientAdd(context, { path: second, name: 'desktop', replace: true, store: 'file', noProbe: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A sign-in completing meanwhile attaches a mailbox to the client being replaced.
    await harness.core.config.update((current) => ({
      ...current,
      inboxes: {
        ...current.inboxes,
        work: {
          id: 'ibx_QQQQQQQQQQQQQQQQ',
          provider: 'gmail',
          email: 'jo@example.test',
          identity: 'oidc' as const,
          sub: 'sub-1',
          client: 'desktop',
          tier: 'read',
          contacts: false,
          grantedScopes: [],
          secretRef: 'gmail:refresh:ibx_QQQQQQQQQQQQQQQQ',
          internalDomains: [],
          createdAt: '2026-09-22T00:00:00.000Z',
        },
      },
    }));
  });
  await assert.rejects(running ?? Promise.resolve(), is('CONFIG', /mailboxes use it/));
  const registered = (await harness.core.config.load()).clients.desktop;
  assert.equal(registered?.clientId, 'project-a.apps.googleusercontent.com', 'the client the mailbox uses is intact');
  assert.equal(await (await harness.core.secrets('file')).get(clientSecretRef('desktop')), 'fake-secret-a');
});

test('writing rules written for a mailbox keep applying after it is renamed', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  const compose = join(harness.configDir, 'compose');
  await mkdir(compose, { recursive: true });
  await writeFile(join(compose, 'inbox-work.md'), '- Sign off as the team, never as yourself.');
  await migrate(harness, ['work=acme/gmail']);

  // Through the draft that uses it, not only the helper: the wiring is what a person would notice missing.
  const draft = async () =>
    (
      await createDraft(context, 'acme/gmail', {
        to: ['sam@partner.test'],
        subject: 'Hi',
        text: 'x',
        includeProfile: true,
      })
    ).profile ?? '';
  assert.match(await draft(), /Sign off as the team/, 'the rules written under the old name still apply');

  // A file under the new name wins, and its name is a file — not a directory nobody made.
  await writeFile(join(compose, inboxProfileFile('acme/gmail')), '- Say the thing.');
  const current = await draft();
  assert.match(current, /Say the thing/);
  assert.doesNotMatch(current, /Sign off as the team/);
  assert.equal(inboxProfileFile('acme/gmail'), 'inbox-acme__gmail.md');
  assert.deepEqual(formerNamesOf(await harness.core.config.load(), 'inbox', 'acme/gmail'), ['work']);
});

test('client add --replace refuses a mailbox attached during its own write, and puts the old secret back', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const first = join(tempDir(), 'client_secret.json');
  await writeFile(
    first,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: first, name: 'desktop', store: 'file', noProbe: true });
  const second = join(tempDir(), 'other_secret.json');
  await writeFile(
    second,
    JSON.stringify({
      installed: { client_id: 'project-b.apps.googleusercontent.com', client_secret: 'fake-secret-b' },
    }),
  );
  const secrets = await harness.core.secrets('file');
  // The mailbox attaches after the new secret is stored: only the check inside the write can see it.
  meddleAfterStoring(
    secrets,
    (ref) => ref === clientSecretRef('desktop'),
    () =>
      harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          work: {
            id: 'ibx_RRRRRRRRRRRRRRRR',
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc' as const,
            sub: 'sub-1',
            client: 'desktop',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_RRRRRRRRRRRRRRRR',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      })),
  );
  await assert.rejects(
    clientAdd(context, { path: second, name: 'desktop', replace: true, store: 'file', noProbe: true }),
    is('CONFIG', /mailboxes use it/),
  );
  assert.equal((await harness.core.config.load()).clients.desktop?.clientId, 'project-a.apps.googleusercontent.com');
  assert.equal(await secrets.get(clientSecretRef('desktop')), 'fake-secret-a', 'the mailbox’s client secret is back');
});

test('reauth refuses when the same account was connected under another name while it ran', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  meddleAfterStoring(
    secrets,
    (ref) => ref === `gmail:refresh:${id}`,
    () =>
      harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          twin: {
            id: 'ibx_TTTTTTTTTTTTTTTT',
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc' as const,
            sub: 'sub-1',
            client: 'default',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_TTTTTTTTTTTTTTTT',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      })),
  );
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('CONFIG', /was connected as "twin"/));
  assert.equal((await inboxList(context)).find((row) => row.alias === 'work')?.tier, 'read');
});

test('reauth refuses a legacy twin matched by address, whatever its case, and restores the token', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const before = await secrets.get(`gmail:refresh:${id}`);
  // A row imported from the old server: no `sub`, and the address written in another case.
  meddleAfterStoring(
    secrets,
    (ref) => ref === `gmail:refresh:${id}`,
    () =>
      harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          legacy: {
            id: 'ibx_LLLLLLLLLLLLLLLL',
            provider: 'gmail',
            email: 'JO@Example.test',
            identity: 'legacy' as const,
            client: 'default',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_LLLLLLLLLLLLLLLL',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      })),
  );
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('CONFIG', /was connected as "legacy"/));
  assert.equal(await secrets.get(`gmail:refresh:${id}`), before, 'the old token is back');
});

test('client add: a secret written for a row that was never registered is put back as it was', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  const secrets = await harness.core.secrets('file');
  rejectBeforeWrite(harness);
  await assert.rejects(
    clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true }),
    is('LOCK_TIMEOUT'),
  );
  // Nothing was registered, so nothing is left in the store under that name either.
  assert.equal(await secrets.get(clientSecretRef('desktop')), null);
});

test('client add --replace: a secret write that lands and then reports failure is put back', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const first = join(tempDir(), 'client_secret.json');
  await writeFile(
    first,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: first, name: 'desktop', store: 'file', noProbe: true });
  const second = join(tempDir(), 'other_secret.json');
  await writeFile(
    second,
    JSON.stringify({
      installed: { client_id: 'project-b.apps.googleusercontent.com', client_secret: 'fake-secret-b' },
    }),
  );
  const secrets = await harness.core.secrets('file');
  // The keychain stores the value and then reports a timeout: the row is never written.
  const store = secrets.set.bind(secrets);
  let armed = true;
  secrets.set = async (ref, value) => {
    await store(ref, value);
    if (!armed || ref !== clientSecretRef('desktop')) return;
    armed = false;
    throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the keychain timed out');
  };
  await assert.rejects(
    clientAdd(context, { path: second, name: 'desktop', replace: true, store: 'file', noProbe: true }),
    (error: unknown) => error instanceof CommsError,
  );
  secrets.set = store;
  assert.equal((await harness.core.config.load()).clients.desktop?.clientId, 'project-a.apps.googleusercontent.com');
  assert.equal(
    await secrets.get(clientSecretRef('desktop')),
    'fake-secret-a',
    'the registered client’s secret is back',
  );
});

test('client add --replace rotating one client’s secret: a write that never stored is not called a success', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  // The same client, a new secret — and the store refuses before writing anything.
  const rotated = join(tempDir(), 'rotated.json');
  await writeFile(
    rotated,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a2' },
    }),
  );
  const secrets = await harness.core.secrets('file');
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    if (ref === clientSecretRef('desktop')) throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the keychain is locked');
    return store(ref, value);
  };
  await assert.rejects(
    clientAdd(context, { path: rotated, name: 'desktop', replace: true, store: 'file', noProbe: true, move: true }),
    (error: unknown) => error instanceof CommsError,
  );
  secrets.set = store;
  // The old secret is untouched, and the file holding the new one was not deleted.
  assert.equal(await secrets.get(clientSecretRef('desktop')), 'fake-secret-a');
  assert.equal(
    await readFile(rotated, 'utf8').then(
      () => true,
      () => false,
    ),
    true,
    'the downloaded JSON is still there',
  );
});

test('reauth that changes nothing: a token write that never stored is not called a success', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const before = await secrets.get(`gmail:refresh:${id}`);
  // The same grant again, and the store refuses before writing anything: the row would match either way.
  const store = secrets.set.bind(secrets);
  secrets.set = async (ref, value) => {
    if (ref === `gmail:refresh:${id}`) throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the keychain is locked');
    return store(ref, value);
  };
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'read', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), (error: unknown) => error instanceof CommsError);
  secrets.set = store;
  assert.equal(await secrets.get(`gmail:refresh:${id}`), before, 'the mailbox still holds the token it had');
});

test('reauth: when the store cannot say what it holds, it says so rather than guessing', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  // A keychain write that times out and then refuses every call while it is still in flight: reads before it are
  // answered, reads after it are not, and the write itself may still land.
  const read = secrets.get.bind(secrets);
  let inFlight = false;
  secrets.set = async () => {
    inFlight = true;
    throw new CommsError('SECRET_STORE_UNAVAILABLE', 'the keychain timed out');
  };
  secrets.get = async (ref) => {
    if (inFlight) throw new CommsError('SECRET_STORE_UNAVAILABLE', 'a write is still in flight');
    return read(ref);
  };
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    reauth.listener?.result ?? Promise.resolve(),
    (error: unknown) =>
      error instanceof CommsError &&
      (error.details as { tokenStateUnknown?: string }).tokenStateUnknown === `gmail:refresh:${id}` &&
      (error.details as { settingsUpdated?: boolean }).settingsUpdated === false &&
      /were not changed/.test(error.hint ?? ''),
  );
});

test('reauth: a write that committed before the store went quiet says the settings were updated', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  const write = secrets.set.bind(secrets);
  const read = secrets.get.bind(secrets);
  // The token is stored, the row is written, the lock release fails — and only then does the store go quiet.
  let quiet = false;
  secrets.set = async (ref, value) => {
    await write(ref, value);
    if (ref === `gmail:refresh:${id}`) quiet = true;
  };
  secrets.get = async (ref) => {
    if (quiet) throw new CommsError('SECRET_STORE_UNAVAILABLE', 'a write is still in flight');
    return read(ref);
  };
  commitThenReject(harness);
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'organize', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    reauth.listener?.result ?? Promise.resolve(),
    (error: unknown) =>
      error instanceof CommsError &&
      (error.details as { settingsUpdated?: boolean }).settingsUpdated === true &&
      (error.details as { tokenStateUnknown?: string }).tokenStateUnknown === `gmail:refresh:${id}` &&
      /were updated/.test(error.hint ?? ''),
  );
  secrets.get = read;
  assert.equal((await inboxList(context))[0]?.tier, 'organize', 'the settings it says were updated, were');
});

test('a reauth that changes nothing still refuses when its client was replaced under it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  meddleAfterStoring(
    secrets,
    (ref) => ref === `gmail:refresh:${id}`,
    () =>
      harness.core.config.update((config) => ({
        ...config,
        clients: {
          default: { ...(config.clients.default as ClientConfig), clientId: 'replaced.apps.googleusercontent.com' },
        },
      })),
  );
  // The same tier as it already has: the row this would write is the row that is already there.
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'read', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(
    reauth.listener?.result ?? Promise.resolve(),
    is('CONFIG', /changed while this sign-in was being completed/),
  );
});

test('a reauth that changes nothing still refuses a duplicate connected under it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const id = await connectBySignIn(harness, context, 'work', 'read');
  const secrets = await harness.core.secrets('file');
  meddleAfterStoring(
    secrets,
    (ref) => ref === `gmail:refresh:${id}`,
    () =>
      harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          twin: {
            id: 'ibx_NNNNNNNNNNNNNNNN',
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc' as const,
            sub: 'sub-1',
            client: 'default',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_NNNNNNNNNNNNNNNN',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      })),
  );
  const reauth = await startSignIn(context, { mode: 'reauth', alias: 'work', tier: 'read', detached: false });
  await fetch(harness.google.consent(reauth.authUrl, { sub: 'sub-1' }));
  await assert.rejects(reauth.listener?.result ?? Promise.resolve(), is('CONFIG', /was connected as "twin"/));
});

test('registering the same client again still refuses once a mailbox has attached to it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  const secrets = await harness.core.secrets('file');
  // A different client under the same name, with a mailbox attaching mid-write — but the store ends up holding a
  // secret that matches what this command meant to write, so only the refusal itself can stop it.
  const other = join(tempDir(), 'other.json');
  await writeFile(
    other,
    JSON.stringify({
      installed: { client_id: 'project-b.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  meddleAfterStoring(
    secrets,
    (ref) => ref === clientSecretRef('desktop'),
    () =>
      harness.core.config.update((current) => ({
        ...current,
        inboxes: {
          ...current.inboxes,
          work: {
            id: 'ibx_MMMMMMMMMMMMMMMM',
            provider: 'gmail',
            email: 'jo@example.test',
            identity: 'oidc' as const,
            sub: 'sub-1',
            client: 'desktop',
            tier: 'read',
            contacts: false,
            grantedScopes: [],
            secretRef: 'gmail:refresh:ibx_MMMMMMMMMMMMMMMM',
            internalDomains: [],
            createdAt: '2026-09-22T00:00:00.000Z',
          },
        },
      })),
  );
  await assert.rejects(
    clientAdd(context, { path: other, name: 'desktop', replace: true, store: 'file', noProbe: true }),
    is('CONFIG', /mailboxes use it/),
  );
  assert.equal((await harness.core.config.load()).clients.desktop?.clientId, 'project-a.apps.googleusercontent.com');
});

test('re-registering an identical client still refuses when the secret store moved under it', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const json = join(tempDir(), 'client_secret.json');
  await writeFile(
    json,
    JSON.stringify({
      installed: { client_id: 'project-a.apps.googleusercontent.com', client_secret: 'fake-secret-a' },
    }),
  );
  await clientAdd(context, { path: json, name: 'desktop', store: 'file', noProbe: true });
  // The same client and the same secret: the row this would write is already there, and the store already holds it.
  // Only the refusal itself can stop this being reported as a success.
  meddleAfterStoring(
    await harness.core.secrets('file'),
    (ref) => ref === clientSecretRef('desktop'),
    () => harness.core.config.update((config) => ({ ...config, secrets: { store: 'keychain' } })),
  );
  await assert.rejects(
    clientAdd(context, { path: json, name: 'desktop', replace: true, store: 'file', noProbe: true }),
    is('TRANSIENT', /secret store was changed/),
  );
});

test('a mailbox connected on a config created today needs an organisation/platform name', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  // A config created by this release, rather than the version-1 fixture the harness pins.
  await rm(harness.core.config.path, { force: true });
  const context = await withClient(harness);
  assert.equal((await harness.core.config.load()).version, 2, 'a fresh config names accounts organisation/platform');

  await assert.rejects(
    startSignIn(context, { mode: 'add', alias: 'work', detached: false }),
    is('USAGE', /acme\/gmail/),
  );
  const started = await startSignIn(context, { mode: 'add', alias: 'acme/gmail', detached: false });
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-1' }));
  assert.equal((await started.listener?.result)?.alias, 'acme/gmail');
  assert.equal((await harness.core.config.load()).version, 2);
});

test('organising, timelines and follow-ups all work under an organisation/platform name', async () => {
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

  const archived = await modify(context, 'acme/gmail', { messageIds: ['m1'], archive: true });
  assert.equal(archived.inbox, 'acme/gmail');
  assert.equal(archived.messages, 1);
  const timeline = await threadTimeline(context, 'acme/gmail', 'm1');
  assert.equal(timeline.messageCount, 1);
  const waiting = await followUps(context, { inboxes: ['acme/gmail'] });
  assert.ok(Array.isArray(waiting.rows));
  // Every one of them refuses the name it used to have, with the one it has now.
  const renamed = is('NOT_FOUND', /renamed to "acme\/gmail"/);
  await assert.rejects(modify(context, 'work', { messageIds: ['m1'], archive: true }), renamed);
  await assert.rejects(threadTimeline(context, 'work', 'm1'), renamed);
  await assert.rejects(followUps(context, { inboxes: ['work'] }), renamed);
  // And the audit trail records the name it acted under.
  const audit = await harness.core.audit.tail({ inbox: 'acme/gmail' });
  assert.ok(
    audit.some((entry) => entry.operation === 'modify'),
    JSON.stringify(audit.map((e) => e.operation)),
  );
});
