import { CommsError } from '@agentcomms/core';
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

/** The name a new app is created with, as Slack's own pages list it: the app's identity there, not a command. */
export const APP_NAME: string = DISPLAY.name;

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

/**
 * The send app's bot user, and exactly the four scopes it holds (design 2026-10-15 S1).
 *
 * It posts as the app, named after the person with the word that says an agent sent it, so it needs to post
 * (`chat:write`), to name each post (`chat:write.customize`), to post in a public channel it has not joined
 * (`chat:write.public`) and to react (`reactions:write`). Nothing that reads or uploads: a bot token reads nothing here,
 * and files go out as the person. This reverses the Slack design's D7, which never asked for `chat:write.customize`:
 * nobody can pass a name or an icon, and Slack's APP badge stands beside every such post, so it discloses the agent.
 *
 * The read app has none, so on this machine no token a read workspace holds can post.
 */
export const BOT_SCOPES: readonly string[] = Object.freeze([
  'chat:write',
  'chat:write.customize',
  'chat:write.public',
  'reactions:write',
]);

export type InstallMode = 'read' | 'send';

export const INSTALL_MODES: readonly InstallMode[] = ['read', 'send'];

/**
 * A mode read back from somewhere a type cannot reach — the config file, a flag — checked rather than cast.
 *
 * `@agentcomms/core` stores `mode` as any non-empty string, because it is platform-neutral and other platforms
 * will have other modes. So a Slack mode on disk is only a claim until it is checked, and the code downstream
 * used to treat every value except `read` as `send`. A typo of `read` in a hand-edited config therefore asked
 * Slack for posting scopes, and skipped the read → send challenge because the stored value was not `read`
 * either. An unknown mode is refused, never guessed at.
 */
export function parseMode(value: unknown, where: string): InstallMode {
  if (value === 'read' || value === 'send') return value;
  throw new CommsError('CONFIG', `${where} has mode "${String(value)}", which is neither "read" nor "send"`, {
    hint: 'Fix the value in the configuration, or remove and add the workspace again.',
  });
}

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
    /** `bot` only in the send app's manifest: its bot user's four posting scopes (S1). */
    scopes: { user: string[]; bot?: string[] };
  };
  /** Only in the send app's manifest: the bot user that posts as the app, named after the person, per post (S1). */
  features?: { bot_user: { display_name: string; always_online: boolean } };
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
  //
  // Each mode named, rather than "read, or else send": the type says only two values arrive here, but the type
  // is erased at runtime and a cast upstream can deliver anything. Anything else gets no scopes at all.
  if (mode === 'read') return [...READ_SCOPES].sort();
  if (mode === 'send') return [...READ_SCOPES, ...scopesFor(['write', 'prepare'])].sort();
  return parseMode(mode, 'this request') as never;
}

/**
 * The bot scopes a mode asks for: the send app's four (S1), and none for the read app. Each mode named, as
 * {@link scopesForMode} names them, so a value a cast let through gets nothing.
 */
export function botScopesForMode(mode: InstallMode): string[] {
  if (mode === 'read') return [];
  if (mode === 'send') return [...BOT_SCOPES].sort();
  return parseMode(mode, 'this request') as never;
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
export function buildManifest(
  mode: InstallMode,
  redirectUrl: string,
  /**
   * `pkce: false` for an app that signs in with its client secret (design 2026-10-15 S1, revised): its `localhost`
   * redirect is then a server redirect, which may ask for the bot scopes. Slack's PKCE page: enabling PKCE "is a one-way
   * operation" that "cannot be disabled without contacting Slack support" — so this is a new app, never an existing one.
   */
  options: { pkce?: boolean | undefined } = {},
): SlackManifest {
  const bot = botScopesForMode(mode);
  return {
    display_information: DISPLAY,
    // The send app's bot user. Its name is only the default: every post it makes is named after the person (S4).
    ...(bot.length > 0 ? { features: { bot_user: { display_name: DISPLAY.name, always_online: false } } } : {}),
    oauth_config: {
      redirect_urls: [redirectUrl],
      pkce_enabled: options.pkce !== false,
      scopes: { user: scopesForMode(mode), ...(bot.length > 0 ? { bot } : {}) },
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
export function renderManifest(
  mode: InstallMode,
  redirectUrl: string,
  options: { pkce?: boolean | undefined } = {},
): string {
  return `${JSON.stringify(buildManifest(mode, redirectUrl, options), null, 2)}\n`;
}

/**
 * What a port chosen for a new app now is, in one sentence: that app's, for good. Here, beside the manifest, because the
 * operation returns it and the command prints it, and the two must say the same.
 */
export function chosenPortSentence(port: number): string {
  return `Port ${port} was free, and is now this app's: Slack matches the redirect URL exactly, so every later sign-in reuses it.`;
}

/**
 * The page where one app's manifest is edited: the one link a person needs to widen or narrow a workspace's app.
 *
 * Here rather than beside the commands that print it, because the manifest step, the mode steps and `app update`
 * all name it, and `operations/app.ts` may be imported by nothing but the CLI. A link to the list of apps instead
 * leaves the person to find the right one by name, with "Create New App" one click away — and a new app changes no
 * installation.
 */
export function appManifestUrl(appId: string): string {
  return `https://api.slack.com/apps/${encodeURIComponent(appId)}/app-manifest`;
}
