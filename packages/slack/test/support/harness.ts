import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccountConfig, type Core, newAccountId, openCore } from '@agentcomms/core';
import { BUNDLE_VERSION, serialiseBundle, type TokenBundle } from '../../src/auth/bundle.ts';
import { type InstallMode, scopesForMode } from '../../src/manifest.ts';
import { secretRefFor } from '../../src/operations/workspaces.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * A config directory, a file secret store, and a stand-in for Slack's token exchange.
 *
 * There is no fake Slack server here, and deliberately not: the only network call S2 makes is the exchange, and
 * `SlackContext` takes it as a value. A fake HTTP server would test Node's fetch, not this package.
 */

export const TEST_CLIENT_ID = '1234567890.1234567890';

export function tempDir(prefix = 'agent-slack-'): string {
  // realpath: on macOS the temp directory is a symlink, and path jails compare resolved paths.
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface ExchangeCall {
  readonly params: Record<string, string>;
}

export interface Harness {
  configDir: string;
  core: Core;
  env: NodeJS.ProcessEnv;
  /** Every exchange this harness was asked for, in order. Lets a test assert the secret was never sent. */
  readonly calls: ExchangeCall[];
  /** What the next exchange returns. Replaceable mid-test, to model a second sign-in answering differently. */
  reply: (params: Record<string, string>) => unknown;
  /**
   * What `auth.test` comes back with, for the one network call `doctor` makes.
   *
   * Always supplied, never optional: a test that forgot it would reach the real slack.com, and would pass or
   * fail depending on somebody's network rather than on the code.
   */
  authTest: () => Response;
  probe: (input: string | URL, init?: RequestInit) => Promise<Response>;
  exchange(params: Record<string, string>): Promise<unknown>;
  /** Writes a connected workspace straight into the config, for tests that are not about signing in. */
  addWorkspace(options: {
    alias: string;
    workspaceId?: string;
    workspaceName?: string;
    userId?: string;
    /** A string rather than `InstallMode`, so a test can plant what a hand-edited config might hold. */
    mode?: InstallMode | string;
    grantedScopes?: readonly string[];
    oauthClientId?: string | undefined;
    appId?: string | undefined;
    sendPolicy?: 'chat' | 'confirm' | 'never';
    bundle?: Partial<TokenBundle>;
  }): Promise<AccountConfig>;
}

/**
 * Slack's `oauth.v2.access` reply for a user-token app: the token is nested under `authed_user`.
 *
 * `authed_user` merges rather than replaces, so a test that changes only the user id still gets a usable token —
 * otherwise "sign in as somebody else" and "return no token at all" are the same fixture, and a test meant to
 * prove the identity check passes because of an unrelated refusal.
 */
export function slackOk(over: SlackReplyOverrides = {}): Record<string, unknown> {
  const { authed_user: user, scopes, ...rest } = over;
  return {
    ok: true,
    app_id: 'A0001',
    team: { id: 'T0001', name: 'Acme' },
    ...rest,
    authed_user: {
      id: 'U0001',
      access_token: 'fake-user-token-1',
      refresh_token: 'fake-refresh-token-1',
      expires_in: 43_200,
      token_type: 'user',
      scope: (scopes ?? scopesForMode('read')).join(','),
      ...user,
    },
  };
}

export interface SlackReplyOverrides extends Record<string, unknown> {
  /** Merged into the default user half, not substituted for it. */
  authed_user?: Record<string, unknown>;
  /** What the person actually granted. Defaults to exactly what `read` asks for. */
  scopes?: readonly string[];
}

export async function newHarness(): Promise<Harness> {
  const configDir = tempDir();
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(configDir, 'state'),
    HOME: configDir,
    NO_COLOR: '1',
  };
  const core = openCore({ env });
  /*
   * Version 1, said rather than assumed.
   *
   * From this release a new config is created at version 2, where every name is `organisation/platform`. The tests
   * here that are not about names call their workspace `acme`, which version 2 does not accept, so the fixture pins
   * version 1; `names.test.ts` migrates it where the names are the point, and covers a fresh version-2 config too.
   */
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
  const calls: ExchangeCall[] = [];

  const harness: Harness = {
    configDir,
    core,
    env,
    calls,
    reply: () => slackOk(),
    authTest: () =>
      new Response(JSON.stringify({ ok: true, team_id: 'T0001', user_id: 'U0001' }), {
        headers: { 'x-oauth-scopes': scopesForMode('read').join(',') },
      }),
    async probe() {
      return harness.authTest();
    },
    async exchange(params) {
      calls.push({ params });
      return harness.reply(params);
    },
    async addWorkspace(options) {
      const id = newAccountId();
      const mode = options.mode ?? 'read';
      const account: AccountConfig = {
        id,
        platform: 'slack',
        workspace: options.workspaceId ?? 'T0001',
        ...(options.workspaceName === undefined ? { workspaceName: 'Acme' } : { workspaceName: options.workspaceName }),
        userId: options.userId ?? 'U0001',
        tier: mode,
        mode,
        grantedScopes: [...(options.grantedScopes ?? scopesForMode(mode === 'send' ? 'send' : 'read'))],
        secretRef: secretRefFor(id),
        ...(options.oauthClientId === undefined
          ? { oauthClientId: TEST_CLIENT_ID }
          : { oauthClientId: options.oauthClientId }),
        ...(options.appId === undefined ? { appId: 'A0001' } : { appId: options.appId }),
        ...(options.sendPolicy ? { sendPolicy: options.sendPolicy } : {}),
        createdAt: new Date('2026-09-22T12:00:00.000Z').toISOString(),
      };
      const secrets = await core.secrets('file');
      /*
       * Issued now, as a real sign-in's bundle is — never a fixed date.
       *
       * The command under test reads the real clock, and this used to store a fixed expiry: midnight UTC on
       * 2026-09-23. Every doctor test passed until that moment and failed for ever after it, which is how the
       * 0.3.0 release found it — on the one run that happened to start after midnight, with nothing in the change
       * to blame. A test that means an expired token says so with its own `bundle`.
       */
      const issued = Date.now();
      const bundle: TokenBundle = {
        v: BUNDLE_VERSION,
        state: 'ready',
        accessToken: 'fake-user-token-0',
        accessExpiresAt: new Date(issued + 12 * HOUR).toISOString(),
        refreshToken: 'fake-refresh-token-0',
        refreshExpiresAt: new Date(issued + 30 * DAY).toISOString(),
        issuedAt: new Date(issued).toISOString(),
        ...options.bundle,
      };
      await secrets.set(account.secretRef, serialiseBundle(bundle));
      await core.config.update((config) => ({
        ...config,
        accounts: { ...config.accounts, [options.alias]: account },
      }));
      return account;
    },
  };
  await core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  return harness;
}
