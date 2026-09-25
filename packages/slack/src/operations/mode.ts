import type { AccountConfig } from '@agentcomms/core';
import { type InstallMode, parseMode, scopesForMode } from '../manifest.ts';

/**
 * What a workspace can do, and what changing that takes.
 *
 * One place for the facts and the two procedures, so `workspace mode`, the refusal a narrowing sign-in meets, and —
 * when Slack has an MCP server — the agent tools all say the same thing. The procedures are text a person follows:
 * one step of each is in a browser, and nothing here can take it for them.
 */

/**
 * Every scope `send` adds to `read`: the ones that let a token act outward — post, upload, react.
 *
 * Derived from the two lists rather than written out, so the day a scope joins `send` it is counted here too.
 */
export const OUTWARD_SCOPES: readonly string[] = scopesForMode('send').filter(
  (scope) => !scopesForMode('read').includes(scope),
);

export interface ModeReport {
  readonly alias: string;
  /** What the configuration records. */
  readonly mode: InstallMode;
  /**
   * The outward scopes in the grant recorded at sign-in. From the record, not from Slack: a token revoked since, or
   * narrowed by removing the app, would still show here until the next sign-in or `doctor`.
   */
  readonly outwardScopes: readonly string[];
  readonly canActOutward: boolean;
  readonly toSend: readonly string[];
  readonly toRead: readonly string[];
}

export function modeReport(alias: string, account: AccountConfig, requested?: number): ModeReport {
  // The port asked for, else the one the workspace was signed in with; neither, and the steps say `<port>`.
  const port = requested ?? account.redirectPort;
  const mode = parseMode(account.mode ?? account.tier, `"${alias}"`);
  const granted = new Set(account.grantedScopes ?? []);
  const outwardScopes = OUTWARD_SCOPES.filter((scope) => granted.has(scope));
  return {
    alias,
    mode,
    outwardScopes,
    canActOutward: outwardScopes.length > 0,
    toSend: mode === 'send' ? [] : wideningSteps(alias, port),
    toRead:
      mode === 'read' && outwardScopes.length === 0
        ? []
        : narrowingSteps(alias, port, { knowsItsApp: account.oauthClientId !== undefined }),
  };
}

const portText = (port: number | undefined): string => (port === undefined ? '<port>' : String(port));

/**
 * `read` → `send`: the app first, because a token can only be granted what its app declares, and changing the app
 * changes no token already issued.
 */
export function wideningSteps(alias: string, port?: number): string[] {
  const p = portText(port);
  return [
    `Open the workspace's existing app at https://api.slack.com/apps → App Manifest, and replace it with \`agent-slack manifest --mode send --port ${p}\` — the same app, not a new one.`,
    `Then, at a terminal: \`agent-slack workspace mode ${alias} send --port ${p}\`, and approve it in Slack.`,
  ];
}

/**
 * `send` → `read`, which this package cannot do by itself.
 *
 * Slack adds scopes to what a person has granted before and never takes one away from a token; revoking a rotating
 * token leaves the installation and its scopes in place; and only `apps.uninstall` resets an installation, with a
 * client secret this package deliberately never stores. So the installation is removed in Slack's own settings, and
 * the workspace signs in again asking for less — as a reauth, which keeps its name, its app and its former names.
 */
export function narrowingSteps(alias: string, port?: number, options: { knowsItsApp?: boolean } = {}): string[] {
  const p = portText(port);
  return [
    `(Recommended) Open the workspace's existing app at https://api.slack.com/apps → App Manifest, and replace it with \`agent-slack manifest --mode read --port ${p}\`, so the app itself can no longer offer posting.`,
    'In Slack, remove the app from the workspace: Workspace settings → Manage apps → the app → Remove app. That revokes every token it holds, which is the only way Slack takes a scope back.',
    options.knowsItsApp === false
      ? `Then \`agent-slack workspace remove ${alias}\`, and \`agent-slack workspace add ${alias} --client-id <the app's Client ID> --port ${p}\`. This record predates the one that remembers its app, so it cannot be re-authorised in place.`
      : `Then: \`agent-slack workspace reauth ${alias} --mode read --port ${p}\` — a reauth, which keeps the name, the app and every former name.`,
  ];
}
