import { join } from 'node:path';
import { ACCOUNT_ID_PATTERN, CommsError, handoffSentence, writeFileAtomic } from '@agentcomms/core';
import { slackAvatarDownload } from '../api/avatar.ts';
import { callSlack } from '../api/call.ts';
import type { SlackContext } from '../context.ts';
import { type Bitmap, decodeImage, drawOver, encodePng, squareThumbnail } from '../icon/image.ts';
import { ROBOT_BADGE_PNG } from '../icon/robot-badge.ts';
import type { WorkspaceSession } from './session.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * The agent emoji: the person's own Slack photo with a small robot badge on its lower right (agent-label design §4 S4).
 *
 * When the person's agent posts as the Slack app, its icon is this emoji, so a reader sees at a glance that the
 * message is the agent's and whose agent it is. Slack hosts it as a workspace emoji, as it does any other; this package
 * only makes the picture. It reads the photo with the person's token, draws the badge, writes a square PNG small enough
 * to be an emoji into this machine's data folder, and says where to upload it and what to call it.
 *
 * It changes nothing in Slack — it adds no emoji, it posts nothing — and nothing in the configuration: recording the
 * emoji's name for the account is core's `label icon`, a separate step the person takes once the emoji is uploaded. So
 * it needs nobody's approval, and works in `read` mode.
 */

/** The side of the emoji, in pixels: Slack shows an emoji at most this large, and asks for a square. */
export const AGENT_ICON_SIZE = 128;

/** The most an emoji's image may be, in bytes: Slack refuses a larger one. */
export const AGENT_ICON_MAX_BYTES = 131_072;

/** How far in from the lower-right corner the badge sits, in pixels. */
const BADGE_MARGIN = 2;

/**
 * Where the badge's top-left corner is drawn: its own size and a small margin in from the lower-right corner. Its size
 * is read from the PNG's header — width at byte 16, height at 20 — so nothing is decoded until an emoji is made.
 */
export const BADGE_AT: { readonly left: number; readonly top: number } = Object.freeze({
  left: AGENT_ICON_SIZE - ROBOT_BADGE_PNG.readUInt32BE(16) - BADGE_MARGIN,
  top: AGENT_ICON_SIZE - ROBOT_BADGE_PNG.readUInt32BE(20) - BADGE_MARGIN,
});

let badge: Bitmap | undefined;

/** The badge as it ships, decoded the first time an emoji is made. */
function robotBadge(): Bitmap {
  badge ??= decodeImage(ROBOT_BADGE_PNG);
  return badge;
}

/** The longest an emoji name this suggests may be, colons included. */
const MAX_SUGGESTED = 64;
const SUFFIX = '-agent';

export interface AgentIconResult {
  /** The workspace it was made for, by the name it is known by here. */
  readonly workspace: string;
  /** Where the PNG was written: this machine's data folder, `slack/agent-icons/<account id>.png`. */
  readonly path: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** The workspace's page for adding an emoji, or null when Slack did not say where the workspace is. */
  readonly emojiPage: string | null;
  /** A name for the emoji, with its colons: the person's handle and `-agent`. */
  readonly suggestedName: string;
  /** What the person does next, in order, in the words of the surface that asked. */
  readonly steps: readonly string[];
}

export interface AgentIconDeps {
  /** Ends the photo's download when the caller gives up: the MCP request's signal. */
  signal?: AbortSignal | undefined;
}

/**
 * A name for the emoji from the person's handle: lower-cased, accents taken off, and every run of anything else an
 * emoji name may not have — Slack allows lower-case letters, digits, `_` and `-` — made one `-`, then `-agent`.
 *
 * A handle with nothing usable left (written wholly in another script, say) gives the user id instead, never an empty
 * name or a bare `:agent:` that somebody else in the workspace may already have.
 */
export function suggestedEmojiName(handle: string | undefined, userId: string): string {
  const usable = (text: string): string =>
    text
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
  const room = MAX_SUGGESTED - SUFFIX.length - 2;
  const base =
    usable(handle ?? '')
      .slice(0, room)
      .replace(/[-_]+$/, '') ||
    usable(userId).slice(0, room) ||
    'my';
  return `:${base}${SUFFIX}:`;
}

/** Where an account's emoji is written: one file per account, made again over the last. */
export function agentIconPath(dataDir: string, accountId: string): string {
  // The id names a file, so it is held to the shape every account id has: nothing in it can leave the folder.
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new CommsError('CONFIG', 'this workspace’s account id is not one this package made', {
      hint: 'Check the configuration file; nothing was saved.',
    });
  }
  return join(dataDir, 'slack', 'agent-icons', `${accountId}.png`);
}

type Raw = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The workspace's emoji page, from the address `auth.test` gives for it — or null for one that is not a workspace
 * address on slack.com, which is never offered as a page to open.
 */
function emojiPageOf(address: string | undefined): string | null {
  if (address === undefined) return null;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.slack\.com$/.test(url.hostname)) return null;
  return `${url.origin}/customize/emoji`;
}

/** Composes the emoji: the photo's middle square at the emoji's size, and the badge over its lower-right corner. */
function composed(photo: Uint8Array): Buffer {
  const icon = squareThumbnail(decodeImage(photo), AGENT_ICON_SIZE);
  drawOver(icon, robotBadge(), BADGE_AT.left, BADGE_AT.top);
  return encodePng(icon);
}

/** The person's next steps: upload it, then record its name for the account, in the caller's words. */
function stepsFor(
  context: SlackContext,
  workspace: string,
  path: string,
  emojiPage: string | null,
  suggestedName: string,
): string[] {
  const bare = suggestedName.slice(1, -1);
  const upload =
    emojiPage === null
      ? `In Slack, open Customize workspace, then Emoji, and add a custom emoji: upload ${path} and name it ${bare}.`
      : `Open ${emojiPage} and add a custom emoji: upload ${path} and name it ${bare}.`;
  const tool = `call \`comms_label\` with icon: { account: "${workspace}", emoji: "${suggestedName}" }`;
  const say = (step: string): string => `Then ${step}, so the app’s posts for your agent show it.`;
  const record =
    context.surface === 'mcp'
      ? say(tool)
      : handoffSentence(
          context.handoffs.core(['label', 'icon', workspace, suggestedName]),
          (command) => say(`run ${command}`),
          { instead: say(`${tool} from a chat`) },
        );
  return [upload, record];
}

/**
 * Makes the agent emoji for one workspace's signed-in person, and writes it to the data folder.
 *
 * Two reads of Slack with the person's token — `auth.test`, for who the token is and where the workspace is, and
 * `users.info`, for their handle and their photo — and one download of the photo with no token at all. Then the
 * picture is made in memory, and written only once it is whole and under {@link AGENT_ICON_MAX_BYTES}; any refusal
 * before that writes nothing.
 */
export async function makeAgentIcon(
  context: SlackContext,
  session: WorkspaceSession,
  deps: AgentIconDeps = {},
): Promise<AgentIconResult> {
  const { account } = requireWorkspace(await context.config(), session.name, context.handoffs);
  const path = agentIconPath(context.core.paths.dataDir, account.id);

  const who = await callSlack(session.call, 'auth.test', {});
  /*
   * The token's own answer to who it is, held to the account: a token that is somebody else's — another sign-in in
   * the same browser — would otherwise make this person's agent emoji out of another person's photo.
   */
  if (text(who.user_id) !== account.userId || (text(who.team_id) ?? account.workspace) !== account.workspace) {
    throw new CommsError('AUTH_REQUIRED', `the token for "${session.name}" is not the account it was connected as`, {
      hint: handoffSentence(
        context.handoffs.own(['workspace', 'reauth', session.name]),
        (command) => `Sign it in again with ${command}. Nothing was saved.`,
        { instead: 'Sign it in again with slack_workspace_reauth from a chat. Nothing was saved.' },
      ),
    });
  }

  const response = await callSlack(session.call, 'users.info', { user: account.userId });
  const user = (response.user as Raw | undefined) ?? {};
  const profile = (user.profile as Raw | undefined) ?? {};
  const photo = text(profile.image_512);
  if (photo === undefined) {
    throw new CommsError('NOT_FOUND', 'Slack gave no profile photo for this account', {
      hint: 'Add a profile photo in Slack, then make the icon again. Nothing was saved.',
    });
  }

  const { bytes } = await slackAvatarDownload({ fetch: session.call.fetch, signal: deps.signal }, photo);
  const png = composed(bytes);
  // Always true of a 128-pixel PNG, whatever the photo; checked anyway, so a file Slack would refuse is never written.
  if (png.byteLength >= AGENT_ICON_MAX_BYTES) {
    throw new CommsError('BAD_DATA', `the emoji came out at ${png.byteLength} bytes, over Slack’s limit`, {
      hint: 'This is a bug — please report it. Nothing was saved.',
    });
  }
  await writeFileAtomic(path, png);

  const emojiPage = emojiPageOf(text(who.url));
  const suggestedName = suggestedEmojiName(text(user.name), account.userId);
  return {
    workspace: session.name,
    path,
    bytes: png.byteLength,
    width: AGENT_ICON_SIZE,
    height: AGENT_ICON_SIZE,
    emojiPage,
    suggestedName,
    steps: stepsFor(context, session.name, path, emojiPage, suggestedName),
  };
}
