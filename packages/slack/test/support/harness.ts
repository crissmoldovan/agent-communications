import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AccountConfig, type Core, isInside, newAccountId, openCore, type ResolvedPaths } from '@agentcomms/core';
import { BUNDLE_VERSION, serialiseBundle, type TokenBundle } from '../../src/auth/bundle.ts';
import { SLACK_CALLER } from '../../src/caller.ts';
import { SlackContext, type SlackContextOptions } from '../../src/context.ts';
import { botScopesForMode, type InstallMode, scopesForMode } from '../../src/manifest.ts';
import { botSecretRefFor, type SlackAccount, secretRefFor } from '../../src/operations/workspaces.ts';

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
  // realpath: on macOS the temp directory is a symlink, and path jails compare resolved paths. The native one, as the
  // code's own is: on Windows it gives a short name in the temp path (`RUNNER~1`) its long one, as saved paths have.
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

export interface ExchangeCall {
  readonly params: Record<string, string>;
}

export interface Harness {
  /**
   * The harness's own home, which `HOME` and `USERPROFILE` name: every path core resolves is inside it. The person's
   * Downloads folder, for a download, is `<home>/Downloads`.
   */
  home: string;
  /** Its configuration folder, `<home>/config`: this package's own, which no download is ever saved into. */
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
  /** Builds an operation context over this harness's core, with only the dependencies a test names replaced. */
  context(options?: Omit<SlackContextOptions, 'core' | 'env' | 'exchange'>): SlackContext;
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
    /** The port the workspace last signed in with. Absent by default, as in a config written before it was kept. */
    redirectPort?: number | undefined;
    bundle?: Partial<TokenBundle>;
    /**
     * The send app's bot user and its token, as a sign-in from this release keeps them (design 2026-10-15 S1). Absent
     * by default: a workspace connected before this release, which has none.
     */
    bot?: { userId: string; bundle?: Partial<TokenBundle> } | undefined;
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
  const { authed_user: user, scopes, bot, ...rest } = over;
  const granted = scopes ?? scopesForMode('read');
  /*
   * The send app's bot half, at the top of the reply as Slack puts it (design 2026-10-15 S1): a grant that can post is
   * the send app's, which now has a bot user. `bot: false` leaves it out — an app still on the manifest from before.
   */
  const botHalf =
    bot === false || !granted.includes('chat:write')
      ? {}
      : {
          access_token: 'fake-bot-token-1',
          token_type: 'bot',
          scope: botScopesForMode('send').join(','),
          bot_user_id: 'U0BOT0001',
          refresh_token: 'fake-bot-refresh-1',
          expires_in: 43_200,
          ...bot,
        };
  return {
    ok: true,
    app_id: 'A0001',
    team: { id: 'T0001', name: 'Acme' },
    ...botHalf,
    ...rest,
    authed_user: {
      id: 'U0001',
      access_token: 'fake-user-token-1',
      refresh_token: 'fake-refresh-token-1',
      expires_in: 43_200,
      token_type: 'user',
      scope: granted.join(','),
      ...user,
    },
  };
}

export interface SlackReplyOverrides extends Record<string, unknown> {
  /** Merged into the default user half, not substituted for it. */
  authed_user?: Record<string, unknown>;
  /** What the person actually granted. Defaults to exactly what `read` asks for. */
  scopes?: readonly string[];
  /** Laid over the bot half a send grant carries, or `false` for none. */
  bot?: Record<string, unknown> | false;
}

/**
 * Refuses a harness any of whose paths is outside its own temporary home.
 *
 * Checked where every harness is made, before a test can write anything, because a path that resolves to the real
 * machine is written to by the first test that saves a file — and what shows is not the path but a later assertion
 * about a `-2` in a file name, on one platform. The 0.8.0 release run on Windows found it that way.
 */
export function assertInsideHome(paths: ResolvedPaths, home: string): void {
  const outside = Object.entries(paths).filter(([, path]) => !isInside(path, home));
  if (outside.length > 0) {
    const named = outside.map(([name, path]) => `${name} to ${path}`).join(' and ');
    throw new Error(`the harness resolves ${named}, outside its own home ${home}`);
  }
}

export async function newHarness(options: { version?: 1 | 2 } = {}): Promise<Harness> {
  /*
   * The configuration inside the home rather than the home itself, as `~/.config/agent-communications` is inside a
   * person's. A download may never be saved into this package's own configuration folder, and with the two the same
   * folder, `~/Downloads` would have been inside it.
   */
  const home = tempDir();
  const configDir = join(home, 'config');
  mkdirSync(configDir);
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_STATE_DIR: join(configDir, 'state'),
    /*
     * The home, under both of the names core reads it by: `HOME` on macOS and Linux, `USERPROFILE` on Windows, as
     * Node's own `homedir()` does there. With `HOME` alone, every harness on Windows had its downloads and its data
     * directory resolved to the real profile of whoever ran the tests. The 0.8.0 release run saved its fixture files
     * into the runner's own Downloads folder, all of them into one: the command's copy of a file was already there when
     * the tool saved its own, which came back as `-2`, and a folder a test proved was never made had been made by the
     * test before it.
     */
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: '1',
    // Where a client's own command is looked for beyond PATH: this home, and nowhere else. Left out, /opt/homebrew/bin
    // and /usr/local/bin are searched too, and a real `claude` or `codex` there would be found — and run — by a test
    // that meant to have none.
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    // The daily update check, off: no test asks the real npm registry, and no call stops for a release the tests did
    // not make. The gate's own tests turn it back on, with a registry and a clock of their own (design 2026-09-28).
    AGENT_COMMS_UPDATE_CHECK: 'off',
    // Keep manifest ports deterministic while every test listener asks the OS for its own bound port.
    AGENT_COMMS_TEST_SLACK_LISTENER_PORT: '0',
  };
  // With this package's caller, as its CLI and server open core: every command printed is located, never bare.
  const core = openCore({ env, caller: SLACK_CALLER });
  assertInsideHome(core.paths, home);
  /*
   * Version 1, said rather than assumed.
   *
   * From this release a new config is created at version 2, where every name is `organisation/platform`. The tests
   * here that are not about names call their workspace `acme`, which version 2 does not accept, so the fixture pins
   * version 1; `names.test.ts` migrates it where the names are the point, and covers a fresh version-2 config too.
   */
  writeFileSync(join(configDir, 'config.json'), `${JSON.stringify({ version: options.version ?? 1 }, null, 2)}\n`);
  const calls: ExchangeCall[] = [];

  const harness: Harness = {
    home,
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
    context(options = {}) {
      return new SlackContext({
        core,
        env,
        exchange: (params) => harness.exchange(params),
        ...options,
      });
    },
    async addWorkspace(options) {
      const id = newAccountId();
      const mode = options.mode ?? 'read';
      const account: SlackAccount = {
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
        ...(options.redirectPort === undefined ? {} : { redirectPort: options.redirectPort }),
        ...(options.bot === undefined ? {} : { botUserId: options.bot.userId }),
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
      if (options.bot !== undefined) {
        await secrets.set(
          botSecretRefFor(id),
          serialiseBundle({
            ...bundle,
            accessToken: 'fake-bot-token-0',
            refreshToken: 'fake-bot-refresh-0',
            ...options.bot.bundle,
          }),
        );
      }
      // A workspace planted able to post stands for one a person connected and confirmed, so it carries that consent.
      await core.config.update(
        (config) => ({ ...config, accounts: { ...config.accounts, [options.alias]: account } }),
        { consent: { kind: 'loosening-consent', paths: [`accounts.${options.alias}.mode`] } },
      );
      return account;
    },
  };
  await core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
  return harness;
}
