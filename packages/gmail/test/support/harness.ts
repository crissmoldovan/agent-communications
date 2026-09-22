import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import {
  type ClientConfig,
  type Config,
  type Core,
  type InboxConfig,
  migrateNames,
  newInboxId,
  openCore,
  planNamesMigration,
} from '@agentcomms/core';
import type { GoogleEndpoints } from '../../src/auth/endpoints.ts';
import { resolveEndpoints } from '../../src/auth/endpoints.ts';
import { buildAuthUrl, exchangeCode, newPkce } from '../../src/auth/oauth.ts';
import { SCOPES } from '../../src/auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../../src/auth/session.ts';
import { type FakeGoogle, type FakeGoogleOptions, startFakeGoogle } from './fake-google.ts';

export const TEST_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const TEST_CLIENT_SECRET = 'test-client-secret-not-a-real-credential';

export function tempDir(prefix = 'agent-gmail-'): string {
  // realpath: on macOS the temp directory is a symlink, and path jails compare resolved paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface Harness {
  configDir: string;
  core: Core;
  google: FakeGoogle;
  endpoints: GoogleEndpoints;
  env: NodeJS.ProcessEnv;
  /** Registers the fake client and an inbox holding `refreshToken`, and returns the inbox as configured. */
  addInbox(options: {
    alias: string;
    email: string;
    sub?: string;
    refreshToken: string;
    /** Which OAuth client it signed in through. Defaults to `default`; name it when a test is about the difference. */
    client?: string;
    tier?: string;
    grantedScopes?: string[];
    sendPolicy?: 'chat' | 'confirm' | 'never';
  }): Promise<InboxConfig>;
  /**
   * The same, but with a refresh token the fake Google will actually refresh.
   *
   * `addInbox` writes whatever token it is given, which is enough for anything that never calls Google — and exit 77,
   * "Google will not refresh the token", for everything that does. Signing in properly is two round trips and removes
   * a whole class of confusing test failure.
   */
  connectInbox(options: {
    alias: string;
    email: string;
    sub?: string;
    scopes?: string[];
    tier?: string;
    sendPolicy?: 'chat' | 'confirm' | 'never';
  }): Promise<InboxConfig>;
}

/** A config directory, a file secret store and a fake Google, torn down when the test file ends. */
export async function newHarness(options: FakeGoogleOptions = {}): Promise<Harness> {
  const configDir = tempDir();
  const google = await startFakeGoogle({ clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET, ...options });
  after(() => google.close());
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_GOOGLE_ROOT_URL: google.url,
    HOME: configDir,
    NO_COLOR: '1',
  };
  const core = openCore({ env });
  /*
   * The harness starts a mailbox at config version 1, and says so rather than relying on the default.
   *
   * A new config is created at version 2 from this release, where every name is `organisation/platform`. Most tests
   * here are about behaviour that does not depend on the version at all — reading, drafting, the send gate — and
   * they name their mailbox `work`, which version 2 does not accept. So the fixture pins version 1, and the tests
   * that *are* about names migrate it with `migrateNamesForTest`, exactly as a person's config will be migrated.
   * `names.test.ts` also covers a config created fresh at version 2.
   */
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  const endpoints = resolveEndpoints(env);

  const addInbox: Harness['addInbox'] = async (inboxOptions) => {
    const id = newInboxId();
    const clientName = inboxOptions.client ?? 'default';
    const secrets = await core.secrets('file');
    await secrets.set(clientSecretRef(clientName), TEST_CLIENT_SECRET);
    await secrets.set(refreshTokenRef(id), inboxOptions.refreshToken);
    const client: ClientConfig = {
      provider: 'gmail',
      clientId: TEST_CLIENT_ID,
      secretRef: clientSecretRef(clientName),
      addedAt: new Date().toISOString(),
    };
    const inbox: InboxConfig = {
      id,
      provider: 'gmail',
      email: inboxOptions.email,
      sub: inboxOptions.sub,
      identity: inboxOptions.sub ? 'oidc' : 'legacy',
      client: clientName,
      tier: inboxOptions.tier ?? 'organize',
      contacts: true,
      grantedScopes: inboxOptions.grantedScopes ?? ['https://www.googleapis.com/auth/gmail.modify'],
      secretRef: refreshTokenRef(id),
      sendPolicy: inboxOptions.sendPolicy,
      internalDomains: [],
      createdAt: new Date().toISOString(),
    };
    await core.config.update(
      (config: Config): Config => ({
        ...config,
        secrets: { store: 'file' },
        clients: { ...config.clients, [clientName]: client },
        inboxes: { ...config.inboxes, [inboxOptions.alias]: inbox },
      }),
    );
    return inbox;
  };

  const connectInbox: Harness['connectInbox'] = async (inboxOptions) => {
    const scopes = inboxOptions.scopes ?? [SCOPES.gmailModify];
    const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
    const redirectUri = 'http://127.0.0.1:5123/';
    const pkce = newPkce();
    const authUrl = buildAuthUrl({
      client,
      endpoints,
      redirectUri,
      scopes,
      state: 'st',
      codeChallenge: pkce.challenge,
    });
    const code = new URL(google.consent(authUrl)).searchParams.get('code') ?? '';
    const tokens = await exchangeCode({ client, endpoints, code, codeVerifier: pkce.verifier, redirectUri });
    const { scopes: _ignored, ...rest } = { ...inboxOptions, scopes: undefined };
    return addInbox({ ...rest, refreshToken: tokens.refreshToken, grantedScopes: scopes });
  };

  return { configDir, core, google, endpoints, env, addInbox, connectInbox };
}

/**
 * Migrates the harness's config to organisation/platform names, exactly as `agentcomms names migrate` does.
 *
 * Through core's own migration rather than by writing the file: the locks, the release gate and the checks inside
 * them are part of what a renamed mailbox has been through by the time these tests read it.
 */
export async function migrateNamesForTest(harness: Harness, renames: string[] = []): Promise<void> {
  const plan = planNamesMigration(await harness.core.config.load(), renames);
  if (plan.status !== 'ready') throw new Error('the harness config is already migrated');
  await migrateNames(harness.core.config, plan);
}
