import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { after, afterEach, beforeEach } from 'node:test';
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
import { capabilitiesOf, SCOPES } from '../../src/auth/scopes.ts';
import { clientSecretRef, refreshTokenRef } from '../../src/auth/session.ts';
import { GMAIL_CALLER } from '../../src/caller.ts';
import { GmailContext } from '../../src/context.ts';
import { LISTENER_TEST_FILE_ENV, LISTENER_TEST_NAME_ENV, stopRegisteredListeners } from './detached-listeners.ts';
import { type FakeGoogle, type FakeGoogleOptions, startFakeGoogle } from './fake-google.ts';

export const TEST_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const TEST_CLIENT_SECRET = 'test-client-secret-not-a-real-credential';

export function tempDir(prefix = 'agent-gmail-'): string {
  // realpath: on macOS the temp directory is a symlink, and path jails compare resolved paths. The native one, as the
  // code's own is: on Windows it gives a short name in the temp path (`RUNNER~1`) its long one, as saved paths have.
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
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
    /** Whether it was connected with the address book. Defaults to true, whatever `grantedScopes` says. */
    contacts?: boolean;
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

const harnesses = new Set<Harness>();
let activeTest: { file: string; name: string } | undefined;

beforeEach((context) => {
  const invoked = process.argv[1];
  const file = invoked ? relative(process.cwd(), invoked).replaceAll('\\', '/') : '<unknown test file>';
  activeTest = { file, name: context.name };
  process.env[LISTENER_TEST_FILE_ENV] = file;
  process.env[LISTENER_TEST_NAME_ENV] = context.name;
});

async function stopHarnessListeners(harness: Harness): Promise<void> {
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const names = await readdir(context.flows.directory).catch(() => []);
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.outcome.json')) continue;
    const flowId = name.slice(0, -'.json'.length);
    try {
      const flow = await context.flows.get(flowId);
      // By PID and flow: a listener that finished may have handed its PID on, and that process is not stopped.
      if (flow.listenerPid && flow.listenerPid !== process.pid) {
        await stopRegisteredListeners([{ pid: flow.listenerPid, flowId }]);
      }
      await context.flows.discard(flowId);
    } catch {
      // A finish or expiry removed it before cleanup reached it.
    }
  }
}

afterEach(async () => {
  try {
    const made = [...harnesses];
    harnesses.clear();
    await Promise.all(made.map(stopHarnessListeners));
  } finally {
    activeTest = undefined;
    delete process.env[LISTENER_TEST_FILE_ENV];
    delete process.env[LISTENER_TEST_NAME_ENV];
  }
});

/** A config directory, a file secret store and a fake Google, torn down when the test file ends. */
export async function newHarness(options: FakeGoogleOptions = {}): Promise<Harness> {
  const configDir = tempDir();
  const google = await startFakeGoogle({ clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET, ...options });
  after(() => google.close());
  const env: NodeJS.ProcessEnv = {
    AGENT_COMMS_CONFIG_DIR: configDir,
    AGENT_COMMS_GOOGLE_ROOT_URL: google.url,
    /*
     * The home under both names core reads it by: `HOME` on macOS and Linux, `USERPROFILE` on Windows. With `HOME`
     * alone, a Windows run resolved the default data and downloads directories to the real profile of whoever ran the
     * tests, as the Slack harness did until the 0.8.0 release run caught it.
     */
    HOME: configDir,
    USERPROFILE: configDir,
    NO_COLOR: '1',
    // Where a client's own command is looked for beyond PATH: this home, and nowhere else. Left out, /opt/homebrew/bin
    // and /usr/local/bin are searched too, and a real `claude` or `codex` there would be found — and run — by a test
    // that meant to have none.
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    // The daily update check, off: no test asks the real npm registry, and no call stops for a release the tests did
    // not make. The gate's own tests turn it back on, with a registry and a clock of their own (design 2026-09-28).
    AGENT_COMMS_UPDATE_CHECK: 'off',
    ...(activeTest ? { [LISTENER_TEST_FILE_ENV]: activeTest.file, [LISTENER_TEST_NAME_ENV]: activeTest.name } : {}),
  };
  const core = openCore({ env, caller: GMAIL_CALLER });
  /*
   * The harness starts a mailbox at config version 1, and says so rather than relying on the default.
   *
   * A new config is created at version 2 from this release, where every name is `organisation/platform`. Most tests
   * here are about behaviour that does not depend on the version at all — reading, drafting, the send gate — and
   * they name their mailbox `work`, which version 2 does not accept. So the fixture pins version 1, and the tests
   * that *are* about names migrate it with `migrateNamesForTest`, exactly as a person's config will be migrated.
   * `names.test.ts` also covers a config created fresh at version 2.
   *
   * The file secret store from the start, not only once a mailbox is added. With no mailbox the store defaulted
   * to the keychain, and `doctor` proves a keychain works by writing, reading and deleting an item in it — so
   * every doctor test on a harness with no mailbox did that to the real login keychain of whoever ran the suite.
   */
  writeFileSync(
    join(configDir, 'config.json'),
    `${JSON.stringify({ version: 1, secrets: { store: 'file' } }, null, 2)}\n`,
  );
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
      contacts: inboxOptions.contacts ?? true,
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
    /*
     * Its contacts setting from what it was granted, as a real sign-in records it. `addInbox` says true whatever the
     * scopes, and a mailbox that says it has the address book while its grant does not is one a re-authorisation
     * would widen — which is a change approval, and not what a test re-authorising at the same tier is about.
     */
    return addInbox({
      ...rest,
      refreshToken: tokens.refreshToken,
      grantedScopes: scopes,
      contacts: capabilitiesOf(scopes).has('contacts'),
    });
  };

  const harness = { configDir, core, google, endpoints, env, addInbox, connectInbox };
  harnesses.add(harness);
  return harness;
}

/** Every `agentLabel` path a change to the label settings can loosen (design 2026-10-15-agent-label, L5). */
const AGENT_LABEL_PATHS = ['agentLabel.word', 'agentLabel.name', 'agentLabel.rules', 'agentLabel.slackIcons'];

/**
 * Sets the person's label settings, `agentLabel`, with the consent a person's change to them carries.
 *
 * A fixture whose second mailbox signs in as the fake's first account (`connectInbox` consents as that one) has no
 * send-as entry for the second mailbox's address, so its drafts have no Gmail name to label: such a fixture gives the
 * person a `label name`, as a person whose send-as name is empty would.
 */
export async function setAgentLabel(harness: Harness, settings: Record<string, unknown>): Promise<void> {
  const added = { agentLabel: settings };
  await harness.core.config.update((config): Config => ({ ...config, ...added }), {
    consent: { kind: 'loosening-consent', paths: AGENT_LABEL_PATHS },
  });
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
