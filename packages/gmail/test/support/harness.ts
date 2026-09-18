import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import {
  type ClientConfig,
  type Config,
  type Core,
  type InboxConfig,
  newInboxId,
  openCore,
} from '@cloudpixel/comms-core';
import type { GoogleEndpoints } from '../../src/auth/endpoints.ts';
import { resolveEndpoints } from '../../src/auth/endpoints.ts';
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
    tier?: string;
    grantedScopes?: string[];
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
  const endpoints = resolveEndpoints(env);

  return {
    configDir,
    core,
    google,
    endpoints,
    env,
    async addInbox(inboxOptions) {
      const id = newInboxId();
      const secrets = await core.secrets('file');
      await secrets.set(clientSecretRef('default'), TEST_CLIENT_SECRET);
      await secrets.set(refreshTokenRef(id), inboxOptions.refreshToken);
      const client: ClientConfig = {
        provider: 'gmail',
        clientId: TEST_CLIENT_ID,
        secretRef: clientSecretRef('default'),
        addedAt: new Date().toISOString(),
      };
      const inbox: InboxConfig = {
        id,
        provider: 'gmail',
        email: inboxOptions.email,
        sub: inboxOptions.sub,
        identity: inboxOptions.sub ? 'oidc' : 'legacy',
        client: 'default',
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
          clients: { ...config.clients, default: client },
          inboxes: { ...config.inboxes, [inboxOptions.alias]: inbox },
        }),
      );
      return inbox;
    },
  };
}
