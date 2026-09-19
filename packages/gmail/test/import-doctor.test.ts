import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agent-communications/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { findUngatedGmailServers, listRegisteredServers } from '../src/operations/client-configs.ts';
import { doctor } from '../src/operations/doctor.ts';
import { aliasFromCredentialsFile, importLegacy, parseLegacyCredentials } from '../src/operations/import-legacy.ts';
import { inboxList, inboxRemove, orphanedSecretsPath } from '../src/operations/inboxes.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

const CLIENT = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };

/** A refresh token the fake Google will renew, as the legacy server's files would hold. */
async function mintToken(harness: Harness, options: { sub?: string; scopes?: string[] } = {}): Promise<string> {
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client: CLIENT,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: options.scopes ?? [SCOPES.gmailReadonly, SCOPES.gmailCompose],
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl, { sub: options.sub })).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client: CLIENT,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  return tokens.refreshToken;
}

/** Recreates the other server's directory layout. */
async function legacyDirectory(files: Record<string, unknown>): Promise<string> {
  const directory = join(tempDir(), '.gmail-mcp');
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return directory;
}

test('credentials are read in both shapes the other server has written', () => {
  const nested = parseLegacyCredentials(
    JSON.stringify({ tokens: { refresh_token: 'rt_1', access_token: 'at' }, scopes: [SCOPES.gmailModify] }),
  );
  assert.deepEqual(nested, { refreshToken: 'rt_1', scopes: [SCOPES.gmailModify] });
  const flat = parseLegacyCredentials(
    JSON.stringify({ refresh_token: 'rt_2', scope: `${SCOPES.gmailReadonly} ${SCOPES.gmailCompose}` }),
  );
  assert.deepEqual(flat, { refreshToken: 'rt_2', scopes: [SCOPES.gmailReadonly, SCOPES.gmailCompose] });
  assert.throws(
    () => parseLegacyCredentials('{}'),
    (error: unknown) => error instanceof CommsError,
  );
  assert.equal(aliasFromCredentialsFile('creds-work.json'), 'work');
  assert.equal(aliasFromCredentialsFile('credentials.json'), 'default');
});

test('importing copies the mailboxes, asks Google who they are, and leaves the old files alone', async () => {
  const harness = await newHarness({
    accounts: [
      { sub: 'sub-1', email: 'jo@example.test' },
      { sub: 'sub-2', email: 'sam@company.test' },
    ],
  });
  const directory = await legacyDirectory({
    'gcp-oauth.keys.json': { installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } },
    'creds-work.json': {
      tokens: { refresh_token: await mintToken(harness, { sub: 'sub-1' }) },
      scopes: [SCOPES.gmailReadonly, SCOPES.gmailCompose],
    },
    'creds-client.json': {
      tokens: { refresh_token: await mintToken(harness, { sub: 'sub-2' }) },
      scopes: [SCOPES.gmailModify],
    },
    'creds-broken.json': '{ not json',
  });
  const context = new GmailContext({ core: harness.core, env: harness.env });

  const dry = await importLegacy(context, { dir: directory, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.imported.map((candidate) => candidate.alias).sort(), ['client', 'work']);
  assert.deepEqual(await inboxList(context), [], 'a dry run changes nothing');

  const result = await importLegacy(context, { dir: directory, store: 'file' });
  assert.deepEqual(
    result.imported.map((candidate) => `${candidate.alias}:${candidate.email}:${candidate.tier}`).sort(),
    ['client:sam@company.test:organize', 'work:jo@example.test:draft'],
  );
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0]?.problem ?? '', /not valid JSON/);

  const inboxes = await inboxList(context);
  assert.deepEqual(inboxes.map((inbox) => inbox.alias).sort(), ['client', 'work']);
  // Imported inboxes have no account id, so `doctor` and reauth know they still need one consent.
  assert.deepEqual(
    inboxes.map((inbox) => inbox.identity),
    ['legacy', 'legacy'],
  );
  // The one that can only draft is told how to reach organise.
  assert.ok(result.nextSteps.some((step) => step.includes('inbox reauth work')));

  // Importing twice does not duplicate anything.
  const again = await importLegacy(context, { dir: directory });
  assert.equal(again.imported.length, 0);
  assert.equal(again.skipped.filter((candidate) => candidate.duplicateOf).length, 2);
  assert.equal((await inboxList(context)).length, 2);
});

test('an imported token Google will not renew is skipped with the reason, not written', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const dead = await mintToken(harness, { sub: 'sub-1' });
  harness.google.revoke(dead);
  const directory = await legacyDirectory({
    'gcp-oauth.keys.json': { installed: { client_id: TEST_CLIENT_ID, client_secret: TEST_CLIENT_SECRET } },
    'creds-work.json': { tokens: { refresh_token: dead }, scopes: [SCOPES.gmailModify] },
  });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const result = await importLegacy(context, { dir: directory, store: 'file' });
  assert.equal(result.imported.length, 0);
  assert.match(result.skipped[0]?.problem ?? '', /will not renew/);
  assert.deepEqual(await inboxList(context), []);
});

test('a web OAuth client is refused with the fix, and a missing directory says so', async () => {
  const harness = await newHarness();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const webOnly = await legacyDirectory({
    'gcp-oauth.keys.json': { web: { client_id: TEST_CLIENT_ID, client_secret: 'x' } },
  });
  await assert.rejects(
    importLegacy(context, { dir: webOnly }),
    (error: unknown) => error instanceof CommsError && /Desktop app/.test(error.hint ?? ''),
  );
  await assert.rejects(
    importLegacy(context, { dir: join(tempDir(), 'nope') }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});

test('other Gmail servers registered on this machine are found and reported as ungated send paths', async () => {
  const home = tempDir();
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        'gmail-old': { command: 'npx', args: ['-y', '@artymclabin/gmail-mcp'] },
        other: { command: 'node', args: ['server.js'] },
      },
      projects: {
        '/some/project': {
          mcpServers: { autoauth: { command: 'npx', args: ['@gongrzhe/server-gmail-autoauth-mcp'] } },
        },
      },
    }),
  );
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(
    join(home, '.codex', 'config.toml'),
    ['[mcp_servers.gmail]', 'command = "npx"', 'args = ["-y", "@shinzolabs/gmail-mcp"]', '', '[other]', 'x = 1'].join(
      '\n',
    ),
  );

  const servers = await listRegisteredServers({ HOME: home }, 'linux');
  assert.deepEqual(servers.map((server) => server.name).sort(), ['autoauth', 'gmail', 'gmail-old', 'other']);
  const findings = findUngatedGmailServers(servers);
  // `name` is what the client calls the entry; `packageName` is what makes it a finding.
  assert.deepEqual(findings.map((finding) => finding.name).sort(), ['autoauth', 'gmail', 'gmail-old']);
  assert.deepEqual(findings.map((finding) => finding.packageName).sort(), [
    '@artymclabin/gmail-mcp',
    '@gongrzhe/server-gmail-autoauth-mcp',
    '@shinzolabs/gmail-mcp',
  ]);
  assert.match(findings.find((finding) => finding.client === 'claude-code')?.removal ?? '', /claude mcp remove/);
  assert.match(findings.find((finding) => finding.client === 'codex')?.removal ?? '', /codex mcp remove/);
});

test('a token that could not be deleted is remembered and reported, not forgotten', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken: 'rt_x' });

  // A secret store that refuses to delete: the inbox still goes, and the leftover token is recorded.
  const secrets = await harness.core.secrets('file');
  const original = secrets.delete.bind(secrets);
  secrets.delete = async () => {
    throw new Error('the keychain is locked');
  };
  const removed = await inboxRemove(context, 'work');
  secrets.delete = original;

  assert.equal(removed.orphanedSecret, `gmail:refresh:${removed.id}`);
  assert.deepEqual(await inboxList(context), []);
  const recorded = await readFile(orphanedSecretsPath(context), 'utf8');
  assert.match(recorded, /the keychain is locked/);

  const checks = await doctor(context);
  const orphans = checks.checks.find((check) => check.id === 'orphaned-secrets');
  assert.equal(orphans?.status, 'warn');
  assert.match(orphans?.fix ?? '', /keychain/);
});

test('doctor reports what is missing with the command that fixes it, and finds ungated servers', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  const context = new GmailContext({ core: harness.core, env: harness.env });

  const empty = await doctor(context);
  const byId = (checks: typeof empty.checks, id: string) => checks.find((check) => check.id === id);
  assert.equal(byId(empty.checks, 'oauth-client')?.status, 'fail');
  assert.equal(byId(empty.checks, 'inboxes')?.status, 'warn');
  assert.equal(empty.healthy, false);
  assert.equal(byId(empty.checks, 'node-version')?.status, 'ok');

  // A working inbox: the token renews and Gmail agrees who it is.
  const refreshToken = await mintToken(harness, { sub: 'sub-1', scopes: [SCOPES.gmailModify] });
  await harness.addInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', refreshToken });
  const healthy = await doctor(context, { inbox: 'work' });
  assert.equal(byId(healthy.checks, 'inbox-token')?.status, 'ok');
  assert.equal(byId(healthy.checks, 'inbox-profile')?.status, 'ok');

  // A revoked grant is a failure with the reauth command, not a mystery.
  harness.google.revoke(refreshToken);
  const broken = await doctor(new GmailContext({ core: harness.core, env: harness.env }), { inbox: 'work' });
  const token = byId(broken.checks, 'inbox-token');
  assert.equal(token?.status, 'fail');
  assert.match(token?.fix ?? '', /reauth work/);
  assert.equal(broken.healthy, false);

  // And another Gmail server on the machine is a failure, because it would be an ungated way to send.
  await writeFile(
    join(harness.configDir, '.claude.json'),
    JSON.stringify({ mcpServers: { old: { command: 'npx', args: ['@artymclabin/gmail-mcp'] } } }),
  );
  const scanned = await doctor(
    new GmailContext({ core: harness.core, env: { ...harness.env, HOME: harness.configDir } }),
  );
  const others = byId(scanned.checks, 'other-gmail-servers');
  assert.equal(others?.status, 'fail');
  assert.match(others?.detail ?? '', /@artymclabin\/gmail-mcp/);
  assert.match(others?.fix ?? '', /claude mcp remove old/);
});
