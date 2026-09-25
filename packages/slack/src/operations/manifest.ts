import { CommsError } from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import { buildManifest, type InstallMode, type SlackManifest } from '../manifest.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * The Slack app to create or update, for `agent-slack manifest` and `slack_manifest` alike.
 *
 * Changing what a workspace's app may ask for is a person's act on api.slack.com, and stays one: it needs either that
 * page or an app configuration token that can rewrite every app its owner has. What an agent can do is make that act
 * one paste — hand over the manifest, and for a workspace already connected, the link to that app's own manifest page
 * rather than to the list of apps, where the one to edit has to be found by name and a new one is one click away.
 */

export interface ManifestResult {
  readonly mode: InstallMode;
  readonly port: number;
  readonly redirectUrl: string;
  readonly manifest: SlackManifest;
  /** The workspace whose app this is for, when one was named. */
  readonly workspace: string | null;
  /** That workspace's app, as recorded at sign-in. Null for a workspace connected before it was kept. */
  readonly appId: string | null;
  /** Where that app's manifest is edited. Null unless both of the above are known. */
  readonly manifestUrl: string | null;
}

/**
 * A loopback port, checked rather than coerced: the one given, else the one recorded, else a refusal.
 *
 * Slack matches redirect URLs exactly, so a port nobody chose is worse than none — the sign-in would complete at
 * Slack and fail on the way back. Never guessed.
 */
export function checkedPort(raw: unknown, recorded?: number): number {
  const value = raw ?? recorded;
  if (value === undefined) {
    throw new CommsError('USAGE', 'the loopback port is needed, and must match the one in the manifest', {
      hint: 'Slack matches redirect URLs exactly. Pass the same `--port` you built the manifest with.',
    });
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CommsError('USAGE', `"${String(value)}" is not a port`, { hint: 'A whole number from 1 to 65535.' });
  }
  return port;
}

export async function manifestFor(
  context: SlackContext,
  options: { mode?: InstallMode | undefined; port?: unknown; workspace?: string | undefined },
): Promise<ManifestResult> {
  const mode = options.mode ?? 'read';
  const found =
    options.workspace === undefined ? undefined : requireWorkspace(await context.config(), options.workspace);
  /*
   * The port is decided here, before any sign-in exists.
   *
   * Slack stores redirect URLs on the app and matches them exactly, so it cannot be whichever port the OS hands out at
   * sign-in time — which is what the Gmail side does, and why the two differ. For a workspace already connected the
   * one it signed in with is the one its app names; for a new app, the caller chooses, and `workspace add --port` is
   * then the same number by construction rather than by luck.
   */
  const port = checkedPort(options.port, found?.account.redirectPort);
  const redirectUrl = `http://localhost:${port}/slack/callback`;
  // Never guessed: without the recorded id there is no telling which of the person's apps this workspace uses.
  const appId = found?.account.appId ?? null;
  return {
    mode,
    port,
    redirectUrl,
    manifest: buildManifest(mode, redirectUrl),
    workspace: found?.alias ?? null,
    appId,
    manifestUrl: appId === null ? null : `https://api.slack.com/apps/${encodeURIComponent(appId)}/app-manifest`,
  };
}
