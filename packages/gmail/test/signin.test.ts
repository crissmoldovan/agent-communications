import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError } from '@agent-communications/core';
import { FLOW_ID_PATTERN } from '../src/auth/flows.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { renderSignInStarted } from '../src/cli/render.ts';
import { GmailContext } from '../src/context.ts';
import { clientAdd } from '../src/operations/clients.ts';
import { inboxList } from '../src/operations/inboxes.ts';
import { finishSignIn, startSignIn } from '../src/operations/signin.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

const CLI_ENTRY = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const LISTENER = {
  command: process.execPath,
  args: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI_ENTRY],
};

/** Writes a Desktop client JSON and registers it, as `client add` would. */
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

test('the two-step sign-in: start returns a link, the browser answers, finish connects the inbox', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);

  const started = await startSignIn(context, {
    mode: 'add',
    alias: 'work',
    email: 'jo@example.test',
    listenerCommand: LISTENER,
  });
  assert.match(started.flowId, FLOW_ID_PATTERN);
  assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const authUrl = new URL(started.authUrl);
  assert.equal(authUrl.searchParams.get('login_hint'), 'jo@example.test');
  assert.equal(authUrl.searchParams.get('redirect_uri'), started.redirectUri);

  // The browser goes to Google and is redirected back to the detached listener.
  const redirect = harness.google.consent(started.authUrl);
  const response = await fetch(redirect);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Signed in/);

  const result = await finishSignIn(context, { flowId: started.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(result.alias, 'work');
  assert.equal(result.inbox.email, 'jo@example.test');
  assert.equal(result.inbox.sub, 'sub-1');
  assert.equal(result.inbox.identity, 'oidc');
  assert.equal(result.reauthorised, false);
  assert.deepEqual(result.missingScopes, []);

  const inboxes = await inboxList(context);
  assert.deepEqual(
    inboxes.map((inbox) => `${inbox.alias}:${inbox.email}:${inbox.tier}:${inbox.sendPolicy}`),
    ['work:jo@example.test:organize:chat'],
  );

  // The flow file, which holds the PKCE verifier, is gone once the sign-in completes.
  assert.deepEqual(await readdir(join(harness.core.paths.stateDir, 'flows')), []);

  // And it cannot be finished twice.
  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, waitSeconds: 0, pollMs: 10 }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});

test('finish waits, and says so without consuming the sign-in when nobody has answered yet', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const started = await startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER });

  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, waitSeconds: 0, pollMs: 10 }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING' && error.exitCode === 10,
  );

  // Still usable: the user simply had not finished yet.
  await fetch(harness.google.consent(started.authUrl));
  const result = await finishSignIn(context, { flowId: started.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(result.inbox.email, 'jo@example.test');
});

test('a pasted redirect URL finishes a sign-in on a machine with no browser', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const started = await startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER });
  const redirect = harness.google.consent(started.authUrl);

  // A URL from another sign-in, or with no code, is refused.
  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, url: 'http://127.0.0.1:1/?code=x&state=someone-else' }),
    (error: unknown) => error instanceof CommsError && error.code === 'AUTH_REQUIRED',
  );
  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, url: 'not a url' }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );

  const result = await finishSignIn(context, { flowId: started.flowId, url: redirect });
  assert.equal(result.inbox.email, 'jo@example.test');
});

test('a refused consent is reported with the fix, and nothing is saved', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const started = await startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER });
  await fetch(harness.google.consent(started.authUrl, { deny: 'access_denied' }));

  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, waitSeconds: 10, pollMs: 50 }),
    (error: unknown) =>
      error instanceof CommsError &&
      error.code === 'AUTH_REQUIRED' &&
      /not verified|Access blocked|publish/i.test(error.hint ?? ''),
  );
  assert.deepEqual(await inboxList(context), []);
});

test('signing in as the wrong account saves nothing and says which account it was', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'someone.else@example.test' },
    ],
  });
  const context = await withClient(harness);
  const started = await startSignIn(context, {
    mode: 'add',
    alias: 'work',
    email: 'jo@example.test',
    listenerCommand: LISTENER,
  });
  // The account chooser hands back the account that happened to be signed in.
  await fetch(harness.google.consent(started.authUrl, { sub: 'sub-2' }));

  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, waitSeconds: 10, pollMs: 50 }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'AUTH_REQUIRED');
      assert.match(error.message, /someone\.else@example\.test/);
      assert.match(error.message, /jo@example\.test/);
      return true;
    },
  );
  assert.deepEqual(await inboxList(context), []);
});

test('an account granted no read access is refused, and unticked extras are reported', async () => {
  const harness = await newHarness({
    accounts: [{ sub: 'sub-1', email: 'jo@example.test', grantScopes: [SCOPES.openid, SCOPES.email] }],
  });
  const context = await withClient(harness);
  const started = await startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER });
  await fetch(harness.google.consent(started.authUrl));
  await assert.rejects(
    finishSignIn(context, { flowId: started.flowId, waitSeconds: 10, pollMs: 50 }),
    (error: unknown) => error instanceof CommsError && error.code === 'SCOPE_MISSING',
  );
  assert.deepEqual(await inboxList(context), []);

  // Reading granted but contacts unticked: connected, with the shortfall named.
  const partial = await newHarness({
    accounts: [
      { sub: 'sub-3', email: 'sam@example.test', grantScopes: [SCOPES.openid, SCOPES.email, SCOPES.gmailReadonly] },
    ],
  });
  const partialContext = await withClient(partial);
  const secondStart = await startSignIn(partialContext, { mode: 'add', alias: 'sam', listenerCommand: LISTENER });
  await fetch(partial.google.consent(secondStart.authUrl));
  const result = await finishSignIn(partialContext, { flowId: secondStart.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(result.inbox.tier, 'read');
  assert.equal(result.inbox.contacts, false);
  assert.ok(result.missingScopes.includes(SCOPES.contacts));
});

test('the same mailbox cannot be connected twice, under any name', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);
  const first = await startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER });
  await fetch(harness.google.consent(first.authUrl));
  await finishSignIn(context, { flowId: first.flowId, waitSeconds: 10, pollMs: 50 });

  const second = await startSignIn(context, { mode: 'add', alias: 'work-again', listenerCommand: LISTENER });
  await fetch(harness.google.consent(second.authUrl));
  await assert.rejects(
    finishSignIn(context, { flowId: second.flowId, waitSeconds: 10, pollMs: 50 }),
    (error: unknown) => error instanceof CommsError && /already connected as "work"/.test(error.message),
  );

  // And the same alias cannot be started twice.
  await assert.rejects(
    startSignIn(context, { mode: 'add', alias: 'work', listenerCommand: LISTENER }),
    (error: unknown) => error instanceof CommsError && error.code === 'CONFIG',
  );
});

test('reauth renews the grant only for the same account, and records what changed', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'other@example.test' },
    ],
  });
  const context = await withClient(harness);
  const first = await startSignIn(context, { mode: 'add', alias: 'work', tier: 'read', listenerCommand: LISTENER });
  await fetch(harness.google.consent(first.authUrl, { sub: 'sub-1' }));
  const added = await finishSignIn(context, { flowId: first.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(added.inbox.tier, 'read');

  // Another account signing in to the same alias is refused, and the inbox is untouched.
  const wrong = await startSignIn(context, { mode: 'reauth', alias: 'work', listenerCommand: LISTENER });
  await fetch(harness.google.consent(wrong.authUrl, { sub: 'sub-2' }));
  await assert.rejects(
    finishSignIn(context, { flowId: wrong.flowId, waitSeconds: 10, pollMs: 50 }),
    (error: unknown) => error instanceof CommsError && error.code === 'AUTH_REQUIRED',
  );
  assert.equal((await inboxList(context))[0]?.tier, 'read');

  // The same account, asking for more: the inbox keeps its id and gains the access.
  const upgrade = await startSignIn(context, {
    mode: 'reauth',
    alias: 'work',
    tier: 'organize',
    listenerCommand: LISTENER,
  });
  await fetch(harness.google.consent(upgrade.authUrl, { sub: 'sub-1' }));
  const reauthorised = await finishSignIn(context, { flowId: upgrade.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(reauthorised.reauthorised, true);
  assert.equal(reauthorised.inbox.id, added.inbox.id);
  assert.equal(reauthorised.inbox.tier, 'organize');
});

test('a sign-in with no expected address says that anyone who opens the link decides the account', () => {
  // The link is a one-time capability, and `inbox add --start` prints it — into a terminal, a transcript, a log.
  // Whoever opens it decides which Google account gets connected, and without `--email` nothing checks afterwards.
  const base = {
    flowId: 'fl_aaaaaaaaaaaaaaaaaaaaaa',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
    redirectUri: 'http://127.0.0.1:5123/',
    expiresAt: '2026-09-19T10:10:00.000Z',
  };
  assert.match(renderSignInStarted(base, 'add', false), /connects whichever Google account opens it/);

  // With an expected address the warning is unnecessary, because the check is real: `finishSignIn` refuses any
  // other account outright, which the test above this one proves.
  const bound = { ...base, expectedEmail: 'jo@example.test' };
  assert.doesNotMatch(renderSignInStarted(bound, 'add', false), /whichever Google account/);
});

test('a reauth goes through the inbox own client, and records the one the token was issued to', async () => {
  // Both halves of one bug. `startSignIn` resolved the client as `Object.keys(config.clients)[0]` — insertion order,
  // not an answer — before the branch that knows which inbox this is, so a reauth of an inbox registered against a
  // second client consented through the first and exchanged the code with the wrong secret. And `reauthorise` then
  // spread the existing row without overwriting `client`, so even `--client <name>` left the registry naming the old
  // one while the stored refresh token belonged to the new. That is the exact recovery the troubleshooting guide
  // prescribes after a `deleted_client`, so it failed precisely when it was needed.
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);

  // A second client, added after the default, so it is not first by insertion order.
  const secondPath = join(tempDir(), 'client_secret.json');
  await writeFile(
    secondPath,
    JSON.stringify({ installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET, project_id: 'p2' } }),
  );
  await clientAdd(context, { path: secondPath, store: 'file', name: 'desktop' });

  const config = await context.config();
  const names = Object.keys(config.clients);
  assert.ok(names.length >= 2, `expected two clients, got ${JSON.stringify(names)}`);
  assert.notEqual(names[0], 'desktop', 'the test is meaningless unless desktop is not first');

  // Add the inbox explicitly against the second client.
  const add = await startSignIn(context, {
    mode: 'add',
    alias: 'work',
    tier: 'read',
    client: 'desktop',
    listenerCommand: LISTENER,
  });
  await fetch(harness.google.consent(add.authUrl, { sub: 'sub-1' }));
  const added = await finishSignIn(context, { flowId: add.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(added.inbox.client, 'desktop');

  // A reauth with no `--client` must still use the inbox's own client, not the first in the file. The end state is
  // enough to tell: `reauthorise` now records `flow.clientName`, so if `startSignIn` had picked `default` the row
  // below would say `default`. Both halves of the bug fail this one assertion.
  const again = await startSignIn(context, { mode: 'reauth', alias: 'work', listenerCommand: LISTENER });
  await fetch(harness.google.consent(again.authUrl, { sub: 'sub-1' }));
  const done = await finishSignIn(context, { flowId: again.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(done.reauthorised, true);
  // And the row still names the client the token was actually issued to.
  assert.equal(done.inbox.client, 'desktop');
  assert.equal(done.inbox.id, added.inbox.id);
});

test('a reauth keeps the mailbox contacts setting when no flag names it', async () => {
  // Commander's implicit default for a `--no-x` flag is `true`, so `options.contacts` was a boolean in every case
  // and `startSignIn`'s `options.contacts ?? inbox.contacts` could never reach its fallback. A mailbox connected
  // with `--no-contacts` therefore had the address-book scopes put back on the consent screen at its next reauth,
  // where the standing "leave every box ticked" advice hands back access the user deliberately declined.
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = await withClient(harness);

  const add = await startSignIn(context, {
    mode: 'add',
    alias: 'work',
    tier: 'read',
    contacts: false,
    listenerCommand: LISTENER,
  });
  await fetch(harness.google.consent(add.authUrl, { sub: 'sub-1' }));
  const added = await finishSignIn(context, { flowId: add.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(added.inbox.contacts, false);

  // No flag named: the stored setting stands, so no contacts scope is requested. Each flow is finished rather than
  // abandoned — `startSignIn` spawns a *detached* listener that waits for Google, and a flow left open keeps that
  // child alive, which keeps the test runner's process alive long after the last assertion has passed.
  const again = await startSignIn(context, { mode: 'reauth', alias: 'work', listenerCommand: LISTENER });
  assert.ok(
    !again.authUrl.includes('contacts'),
    `a bare reauth must not re-request contacts; got ${decodeURIComponent(again.authUrl)}`,
  );
  await fetch(harness.google.consent(again.authUrl, { sub: 'sub-1' }));
  const kept = await finishSignIn(context, { flowId: again.flowId, waitSeconds: 10, pollMs: 50 });
  assert.equal(kept.inbox.contacts, false, 'and the setting is still off afterwards');

  // Naming it explicitly still turns it on.
  const widen = await startSignIn(context, {
    mode: 'reauth',
    alias: 'work',
    contacts: true,
    listenerCommand: LISTENER,
  });
  assert.ok(widen.authUrl.includes('contacts'), 'an explicit --contacts must ask for it');
  await fetch(harness.google.consent(widen.authUrl, { sub: 'sub-1' }));
  await finishSignIn(context, { flowId: widen.flowId, waitSeconds: 10, pollMs: 50 });
});
