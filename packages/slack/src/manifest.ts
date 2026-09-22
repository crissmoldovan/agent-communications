import { scopesFor } from './api/methods.ts';

/**
 * The two Slack app manifests, as data.
 *
 * D8: we do not distribute a Slack app. A commercially distributed non-Marketplace app gets
 * `conversations.history` at one request per minute, which is unusable; an **internal customer-built** app — one
 * the person creates in their own workspace — is exempt and keeps Tier 3. So the thing we ship is the manifest,
 * and the person pastes it into their own workspace.
 *
 * Built here rather than kept as two JSON files, because the scope lists have to agree with the method registry
 * and two hand-maintained lists of the same fact drift. `send` is `read` plus exactly the scopes the registry
 * says the write methods need, and a test asserts that rather than trusting this comment.
 */

/** The workspace-name/description shown on the app's own page. Cosmetic; the person may change all of it. */
const DISPLAY = {
  name: 'agent-slack',
  description: 'Read and search this workspace from a coding agent, with posting behind an approval.',
  background_color: '#1a1a1a',
};

/**
 * Reading, and nothing else.
 *
 * Every one of these is a **user** scope. §1.3 of the research settles why: only a user token reaches the
 * person's DMs and the public channels they have not joined, and `search:read` is "compatible exclusively with
 * user tokens". A bot token would be blind to most of what the person actually cares about.
 *
 * `search:read` is legacy and kept knowingly — see D14. Changing it later forces every workspace to
 * re-authorise, which is why it is settled now rather than in S3.
 */
export const READ_SCOPES: readonly string[] = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'files:read',
  'search:read',
];

/**
 * Never requested, in either manifest.
 *
 * D2 enumerated four ways to put a message in front of people. Two are behind the gate; these two are simply not
 * asked for, and a test asserts neither manifest carries them — a scope that is never granted is a door that
 * cannot be opened by a bug in this package.
 */
export const NEVER_REQUESTED: readonly string[] = ['incoming-webhook', 'im:write', 'team:read'];

export type InstallMode = 'read' | 'send';

export interface SlackManifest {
  display_information: typeof DISPLAY;
  oauth_config: {
    redirect_urls: string[];
    /**
     * The switch everything else here depends on.
     *
     * "Redirects to `localhost` … are treated as desktop redirects if the app has opted into PKCE. If the app
     * has never enabled PKCE, they will be treated like a server redirect." So without it the loopback redirect
     * is refused, the secret-free exchange has no basis, and the app this prints cannot complete a single
     * sign-in.
     */
    pkce_enabled: boolean;
    scopes: { user: string[] };
  };
  settings: {
    org_deploy_enabled: boolean;
    socket_mode_enabled: boolean;
    token_rotation_enabled: boolean;
  };
}

/**
 * The scopes a mode asks for.
 *
 * `send` is `read` plus what the registry says the write and prepare methods need — taken from there rather than
 * written out, so adding a posting method without its scope is a test failure instead of a runtime refusal.
 */
export function scopesForMode(mode: InstallMode): string[] {
  // Always sorted, both modes. Slack returns the granted scopes in its own order, and every comparison in this
  // package is against this list — one of the two being unsorted made `read` and `send` compare differently.
  const scopes = mode === 'read' ? [...READ_SCOPES] : [...READ_SCOPES, ...scopesFor(['write', 'prepare'])];
  return scopes.sort();
}

/**
 * Builds a manifest for one mode.
 *
 * `redirectUrl` is a parameter because the loopback port is not fixed until the flow starts, and Slack matches
 * redirect URLs exactly. The caller decides; this only says what goes in the file.
 *
 * **`oauth_config.pkce_enabled` is the field everything else depends on.** An earlier version of this file left
 * it out and said so proudly: the research had found no PKCE key documented, and inventing one Slack would
 * silently ignore is worse than omitting it. The research was simply incomplete. Both the PKCE guide and the app
 * manifest reference document `pkce_enabled` as a boolean under `oauth_config`, and the guide is explicit about
 * what its absence costs: "If the app has never enabled PKCE, they will be treated like a server redirect."
 *
 * So the app this printed could not have completed a sign-in at all. The refusal to guess was right; the
 * conclusion drawn from it — that there was nothing to find — was not, and "the docs do not mention it" is a
 * claim about the search, not about the API.
 *
 * `settings` carries only the three keys the research did verify: `org_deploy_enabled`, `socket_mode_enabled`
 * and `token_rotation_enabled`.
 */
export function buildManifest(mode: InstallMode, redirectUrl: string): SlackManifest {
  return {
    display_information: DISPLAY,
    oauth_config: {
      redirect_urls: [redirectUrl],
      pkce_enabled: true,
      scopes: { user: scopesForMode(mode) },
    },
    settings: {
      org_deploy_enabled: false,
      // D13: nothing in v1 subscribes to events, so the app should not be able to.
      socket_mode_enabled: false,
      // Rotation is the point of the 30-day/12-hour handling in `auth/`.
      token_rotation_enabled: true,
    },
  };
}

/** The manifest as a person pastes it: JSON, two-space indented, newline-terminated. */
export function renderManifest(mode: InstallMode, redirectUrl: string): string {
  return `${JSON.stringify(buildManifest(mode, redirectUrl), null, 2)}\n`;
}
