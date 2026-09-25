import { type AccountConfig, CommsError, toCommsError } from '@agentcomms/core';
import { callSlack, type SlackCall, type SlackProblem, type SlackResponse } from '../api/call.ts';
import { closedPermit, configureWith, type FetchLike } from '../api/guard.ts';
import { appManifestUrl, buildManifest, type InstallMode, parseMode, type SlackManifest } from '../manifest.ts';
import { narrowingSteps } from './mode.ts';
import type { AuditSink } from './send.ts';

/**
 * Changing the Slack app itself, so connecting or widening a workspace can skip the api.slack.com page.
 *
 * The default path stays the manual one: `agent-slack manifest` prints the JSON and a person pastes it. This is the
 * optional one from §6.4 of the 2026-09-25 design — the same manifest, sent by `apps.manifest.update` or
 * `apps.manifest.create` with an **app configuration token**.
 *
 * That token is more power than anything else this package touches: Slack issues one per person and workspace, not
 * per app, so it can rewrite every app its owner has. So it is handled as narrowly as a credential can be. The CLI
 * reads it from a hidden prompt or `SLACK_APP_CONFIG_TOKEN`, hands it to one function here, and this module uses it
 * for the calls of that one command and nothing else: it is never stored, never logged, never part of a result, and
 * taken out of any error before the error leaves. There is no MCP tool for any of this — a token typed into a chat
 * stays in the transcript (§4) — and a test fails if anything but the CLI imports this file.
 *
 * `apps.manifest.validate` always goes first. A manifest Slack refuses changes nothing: neither the update nor the
 * create is sent.
 */

/** Where Slack is and how to reach it. Injected in tests; in production the real `fetch`, always under the guard. */
export interface AppTransport {
  readonly fetch?: FetchLike | undefined;
  readonly baseUrl?: string | undefined;
}

export interface AppUpdateInput {
  /** The workspace whose app this is, as named in the configuration. */
  readonly alias: string;
  readonly account: AccountConfig;
  /** Which manifest to apply. */
  readonly mode: InstallMode;
  /** The loopback port the app's redirect URL names. */
  readonly port: number;
  /**
   * Asks for the app configuration token. Called once, after every local check has passed — so nobody types a token
   * for a command that was going to fail anyway — and what it returns is used for this command's calls and dropped.
   */
  readonly askToken: () => Promise<string>;
  readonly transport?: AppTransport | undefined;
  readonly audit?: AuditSink | undefined;
  readonly surface?: 'cli' | 'mcp' | undefined;
}

export interface AppUpdated {
  readonly alias: string;
  readonly appId: string;
  readonly mode: InstallMode;
  readonly port: number;
  readonly redirectUrl: string;
  /** The app's manifest page, to look at what was written. */
  readonly manifestPage: string;
  /** Slack's `permissions_updated`: whether this changed what the app declares. Absent when Slack did not say. */
  readonly permissionsUpdated?: boolean | undefined;
  /**
   * Always false, and said in the result rather than left to be inferred.
   *
   * A manifest changes what the app may *ask for*. The token a workspace already holds keeps exactly what was granted
   * to it, so updating the app to `send` lets nothing post until a person signs in again and approves it.
   */
  readonly tokenChanged: false;
  /** The workspace's recorded mode, which this did not move. */
  readonly workspaceMode: InstallMode;
  /** What is left to do, as commands a person can run. Empty when nothing is. */
  readonly next: readonly string[];
}

export interface AppCreateInput {
  readonly mode: InstallMode;
  readonly port: number;
  /** The name the workspace will be connected under, used only to print the command that connects it. */
  readonly alias?: string | undefined;
  /** As for an update: called once, and what it returns is used for this command's calls and dropped. */
  readonly askToken: () => Promise<string>;
  readonly transport?: AppTransport | undefined;
  readonly audit?: AuditSink | undefined;
  readonly surface?: 'cli' | 'mcp' | undefined;
}

export interface AppCreated {
  readonly appId: string;
  /** Not a secret: it is in every authorisation link the app ever produces. */
  readonly clientId: string;
  readonly mode: InstallMode;
  readonly port: number;
  readonly redirectUrl: string;
  readonly manifestPage: string;
  /**
   * The names — never the values — of the credentials Slack returned with the new app and this dropped.
   *
   * Slack's reply to `apps.manifest.create` carries the client secret, the verification token and the signing
   * secret. A PKCE sign-in needs none of them (D8), so none is kept or shown; listing what was dropped says so,
   * instead of leaving a reader to wonder where the secret went.
   */
  readonly secretsDiscarded: readonly string[];
  /** The command that connects a workspace through the new app, with its Client ID and port filled in. */
  readonly next: string;
}

/** The redirect every manifest here names. The same string `agent-slack manifest` and the sign-in build. */
export function redirectUrlFor(port: number): string {
  return `http://localhost:${port}/slack/callback`;
}

/** The app's own manifest page — the one link a person needs to check what an update wrote. */
export function manifestPageFor(appId: string): string {
  return appManifestUrl(appId);
}

/**
 * Checked before it is used, and never quoted back.
 *
 * Every Slack token is one run of visible ASCII. Anything else — a space, a line break from a paste, a stray quote —
 * is a mistake, and worse than a refusal from Slack: `fetch` rejects a header value with a line break in it, and its
 * error quotes the value. So it is refused here, and the refusal says what is wrong without saying what was typed.
 */
export function checkConfigurationToken(token: string): void {
  if (token.length === 0) {
    throw new CommsError('USAGE', 'no app configuration token was given, so nothing was changed', {
      hint: 'Generate one at https://api.slack.com/apps, under "Your App Configuration Tokens".',
    });
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new CommsError('USAGE', 'that is not an app configuration token: it has spaces or characters no token has', {
      hint: 'Copy the access token again from https://api.slack.com/apps, under "Your App Configuration Tokens".',
    });
  }
}

/**
 * An error with every appearance of the token taken out of it.
 *
 * Nothing in this module writes the token into an error, and nothing should. This is for what it did not write: a
 * transport failure whose message quotes the request, or a runtime that one day puts a header in one. Message, hint
 * and details are all scrubbed; the cause is dropped rather than scrubbed, because it is an object this cannot see
 * all of, and nothing downstream prints it anyway.
 */
export function withoutToken(error: unknown, token: string): CommsError {
  const failure = toCommsError(error);
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string')
      return token.length > 0 ? value.split(token).join('[the configuration token]') : value;
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]));
    }
    return value;
  };
  return new CommsError(failure.code, scrub(failure.message) as string, {
    ...(failure.hint === undefined ? {} : { hint: scrub(failure.hint) as string }),
    ...(failure.details === undefined ? {} : { details: scrub(failure.details) as Record<string, unknown> }),
  });
}

/**
 * Slack's refusals, in terms of the token and the app rather than of a workspace.
 *
 * `callSlack` maps `invalid_auth` to "sign in again", which is the right advice for a workspace's token and the wrong
 * one here: this token is not a sign-in, it is a twelve-hour credential from the app settings page. Each case says
 * what to go and get instead.
 */
function inTermsOfTheApp(error: unknown, appId?: string): CommsError {
  const failure = toCommsError(error);
  const slackError = failure.details?.slackError;
  const problems = failure.details?.slackProblems as SlackProblem[] | undefined;
  const app = appId ? `app ${appId}` : 'the app';
  switch (slackError) {
    case 'not_authed':
    case 'invalid_auth':
    case 'token_expired':
    case 'token_revoked':
    case 'account_inactive':
      return new CommsError('AUTH_REQUIRED', 'Slack did not accept the app configuration token', {
        hint: 'Configuration tokens last twelve hours. Generate a new one at https://api.slack.com/apps under "Your App Configuration Tokens", and use the access token, not its refresh token.',
        details: { slackError },
      });
    case 'missing_scope':
    case 'not_allowed_token_type':
      return new CommsError('AUTH_REQUIRED', 'that token cannot change Slack apps', {
        hint: 'It has to be an app configuration token, from https://api.slack.com/apps under "Your App Configuration Tokens". A workspace’s own sign-in token cannot change an app.',
        details: { slackError },
      });
    case 'app_not_found':
    case 'invalid_app_id':
    case 'invalid_app':
      return new CommsError('NOT_FOUND', `Slack has no ${app} that this token can change`, {
        hint: 'A configuration token belongs to one person in one workspace. Generate it in the workspace the app lives in, as somebody who can edit the app.',
        details: { slackError },
      });
    case 'no_permission':
    case 'access_denied':
      return new CommsError('AUTH_REQUIRED', `the token’s owner may not change ${app}`, {
        hint: 'Ask one of the app’s collaborators, or paste the manifest on its page instead.',
        details: { slackError },
      });
    case 'invalid_manifest':
      return new CommsError('BAD_DATA', 'Slack refused the manifest, so nothing was changed', {
        hint:
          problems && problems.length > 0
            ? problems.map((problem) => `${problem.pointer ?? '(manifest)'}: ${problem.message}`).join('; ')
            : 'Slack gave no reason. Compare it with `agent-slack manifest`, and please report this.',
        details: { slackError, ...(problems ? { slackProblems: problems } : {}) },
      });
    default:
      return failure;
  }
}

/**
 * One call with the configuration token, inside a grant for exactly that method.
 *
 * The `SlackCall` is built here, from the token passed in, and from nothing else: this module never opens a
 * workspace, reads a secret store or looks at a stored token, so a workspace's own credential cannot end up on one
 * of these requests. No `renew`: there is nothing to renew a configuration token with, and a second attempt with the
 * same one would be refused the same way.
 */
async function configure(
  token: string,
  transport: AppTransport | undefined,
  method: 'apps.manifest.validate' | 'apps.manifest.update' | 'apps.manifest.create',
  params: Record<string, string>,
): Promise<SlackResponse> {
  const permit = closedPermit();
  const call: SlackCall = {
    token,
    permit,
    ...(transport?.fetch ? { fetch: transport.fetch } : {}),
    ...(transport?.baseUrl ? { baseUrl: transport.baseUrl } : {}),
  };
  return configureWith(permit, method, () => callSlack(call, method, params));
}

/**
 * Validation first, and a refusal ends it.
 *
 * Slack's documented success is `{"ok": true, "errors": []}`. An `ok` that still lists problems is treated as a
 * refusal rather than trusted: the manifest either passed or it did not, and "passed, but" is not a state to write an
 * app from.
 */
async function validate(
  token: string,
  transport: AppTransport | undefined,
  manifest: SlackManifest,
  appId?: string,
): Promise<void> {
  const reply = await configure(token, transport, 'apps.manifest.validate', {
    manifest: JSON.stringify(manifest),
    ...(appId ? { app_id: appId } : {}),
  });
  if (Array.isArray(reply.errors) && reply.errors.length > 0) {
    throw new CommsError('BAD_DATA', 'Slack refused the manifest, so nothing was changed', {
      hint: 'Slack listed problems with it while calling it valid. Compare it with `agent-slack manifest`.',
      details: { slackError: 'invalid_manifest' },
    });
  }
}

/** What happens next, for the workspace whose app was just updated. */
function stepsAfterUpdate(alias: string, account: AccountConfig, mode: InstallMode, port: number): string[] {
  const workspaceMode = parseMode(account.mode ?? account.tier, `"${alias}"`);
  if (mode === 'send' && workspaceMode === 'read') {
    return [
      `\`agent-slack workspace mode ${alias} send --app-updated --port ${port}\` (slack_mode_set from a chat): a person approves the change, then approves the sign-in in Slack. That sign-in is what gives "${alias}" a token that can post.`,
    ];
  }
  if (mode === 'read' && workspaceMode === 'send') {
    // The first of the narrowing steps is the one just done — putting the `read` manifest on the app — so only
    // what follows it is left. Taken from `narrowingSteps` rather than rewritten, so both say the same thing.
    return narrowingSteps(alias, port, { knowsItsApp: account.oauthClientId !== undefined }).slice(1);
  }
  if (account.redirectPort !== port) {
    const was =
      account.redirectPort === undefined ? 'a port this record does not keep' : `port ${account.redirectPort}`;
    return [
      `The app now redirects to port ${port}, and "${alias}" last signed in on ${was}: its next sign-in must use \`--port ${port}\`, e.g. \`agent-slack workspace reauth ${alias} --port ${port}\`.`,
    ];
  }
  return [];
}

/**
 * Replaces a connected workspace's app manifest with the one `agent-slack manifest` prints.
 *
 * Slack's `apps.manifest.update` replaces the app's whole configuration — its name and description included — with
 * what is sent, so an app somebody renamed by hand comes back as `agent-slack`. The CLI says that before asking for
 * the token.
 *
 * Nothing local changes. The configuration keeps the workspace's mode and port as they were, because both describe
 * the token and the last sign-in, and this touched neither.
 */
export async function updateApp(input: AppUpdateInput): Promise<AppUpdated> {
  const { alias, account, mode, port, transport } = input;
  const appId = account.appId;
  if (!appId) {
    throw new CommsError('CONFIG', `"${alias}" does not record which Slack app it was connected through`, {
      hint: `Re-authorising records it: \`agent-slack workspace reauth ${alias}\`. Or paste \`agent-slack manifest --mode ${mode} --port ${port}\` on the app's page at https://api.slack.com/apps.`,
    });
  }
  const workspaceMode = parseMode(account.mode ?? account.tier, `"${alias}"`);
  const manifest = buildManifest(mode, redirectUrlFor(port));
  const token = await input.askToken();
  checkConfigurationToken(token);
  const record = async (outcome: 'ok' | 'refused' | 'failed', reason?: string) =>
    input.audit?.append({
      inboxId: account.id,
      alias,
      operation: 'slack.app.update',
      outcome,
      ids: { appId, mode },
      ...(reason ? { reason } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
    });

  let reply: SlackResponse;
  try {
    await validate(token, transport, manifest, appId);
    reply = await configure(token, transport, 'apps.manifest.update', {
      app_id: appId,
      manifest: JSON.stringify(manifest),
    });
  } catch (error) {
    const failure = withoutToken(inTermsOfTheApp(error, appId), token);
    await record(failure.code === 'BAD_DATA' ? 'refused' : 'failed', failure.code);
    throw failure;
  }
  await record('ok');
  return {
    alias,
    appId,
    mode,
    port,
    redirectUrl: redirectUrlFor(port),
    manifestPage: manifestPageFor(appId),
    ...(typeof reply.permissions_updated === 'boolean' ? { permissionsUpdated: reply.permissions_updated } : {}),
    tokenChanged: false,
    workspaceMode,
    next: stepsAfterUpdate(alias, account, mode, port),
  };
}

/** A Slack id this can safely print into a URL and a shell command: letters, digits, dots, hyphens, underscores. */
const PRINTABLE_ID = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Creates a new Slack app from the manifest `agent-slack manifest` prints, and says how to connect it.
 *
 * The app is created in the workspace the configuration token belongs to, and is not installed anywhere yet: the
 * first `workspace add` through it is the installation, with Slack's own consent screen. Of Slack's reply only the
 * app id and the Client ID are kept; every secret in it is dropped here, before anything else can see the object.
 */
export async function createApp(input: AppCreateInput): Promise<AppCreated> {
  const { mode, port, transport } = input;
  const manifest = buildManifest(mode, redirectUrlFor(port));
  const token = await input.askToken();
  checkConfigurationToken(token);
  const record = async (outcome: 'ok' | 'refused' | 'failed', ids: Record<string, string>, reason?: string) =>
    input.audit?.append({
      inboxId: '',
      operation: 'slack.app.create',
      outcome,
      ids: { mode, ...ids },
      ...(reason ? { reason } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
    });

  let appId: unknown;
  let clientId: unknown;
  let secretsDiscarded: string[];
  try {
    await validate(token, transport, manifest);
    const reply = await configure(token, transport, 'apps.manifest.create', { manifest: JSON.stringify(manifest) });
    appId = reply.app_id;
    const credentials = (reply.credentials ?? {}) as Record<string, unknown>;
    clientId = credentials.client_id;
    // Names only. The values go no further than this line, and nothing here keeps a reference to `reply`.
    secretsDiscarded = Object.keys(credentials)
      .filter((key) => key !== 'client_id')
      .sort();
  } catch (error) {
    const failure = withoutToken(inTermsOfTheApp(error), token);
    await record(failure.code === 'BAD_DATA' ? 'refused' : 'failed', {}, failure.code);
    throw failure;
  }

  if (typeof appId !== 'string' || !PRINTABLE_ID.test(appId)) {
    await record('failed', {}, 'no-app-id');
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack answered without naming the app it created', {
      hint: 'Look for a new app called "agent-slack" at https://api.slack.com/apps before running this again.',
    });
  }
  await record('ok', { appId });
  if (typeof clientId !== 'string' || !PRINTABLE_ID.test(clientId)) {
    throw new CommsError('PROVIDER_UNAVAILABLE', `Slack created app ${appId} but its reply carried no Client ID`, {
      hint: `Copy the Client ID from https://api.slack.com/apps/${encodeURIComponent(appId)}/general, then \`agent-slack workspace add <name> --client-id <it> --port ${port}\`. Do not create another app.`,
    });
  }
  const name = input.alias ?? '<name>';
  return {
    appId,
    clientId,
    mode,
    port,
    redirectUrl: redirectUrlFor(port),
    manifestPage: manifestPageFor(appId),
    secretsDiscarded,
    next: `agent-slack workspace add ${name} --client-id ${clientId} --port ${port}${mode === 'send' ? ' --mode send' : ''}`,
  };
}
