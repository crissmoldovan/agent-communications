import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIL_CONVERSATION_PATTERN, SLACK_CONVERSATION_PATTERN } from '../agent-label.ts';
import {
  type ComposeProfile,
  conversationProfileFile,
  inboxProfileFile,
  PROFILE_STARTER,
  type ProfileSection,
  readComposeProfile,
} from '../compose-profile.ts';
import { type Config, connectedAccounts } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { ensurePrivateDir, FILE_MODE } from '../fs.ts';
import { formerNameRefusal, formerNamesOf, lookupName } from '../names.ts';

/**
 * Writing profiles for every channel and conversation (design 2026-10-19-agent-behaviour-rules, B6): `agentcomms
 * profile` and `comms_profile` show one place's joined profile — `profileView` — and `agentcomms profile init`, at the
 * command line only, starts the missing file for one layer from a starter — `profileInit`.
 *
 * A profile is the person's own instructions to their agents, so it reaches an agent as theirs, not as untrusted
 * content, and no tool writes one: something an agent read could otherwise change how every later message is written.
 * `profileInit` is the person's, and only ever creates a file that is not there; it never overwrites one, and never
 * starts one under an account's new name while the rules the person wrote under its old one are still being read.
 *
 * Names are looked up as everywhere else (`lookupName`): an account that is not connected is refused, and a former
 * name says what the account is called now, so a typo never starts a file that nothing reads.
 */

export interface ProfileViewInput {
  /** The account a message goes from: `acme/slack`. Left out, only the layers every message shares. */
  account?: string | undefined;
  /**
   * The conversations a message goes to, in the order their files apply: for mail each recipient's address and then
   * its `@domain`, in recipient order; for a Slack DM its `D…` and then the person's `U…`.
   */
  conversations?: readonly string[] | undefined;
}

export interface ProfileView {
  /** Everything joined, each part marked with the file it came from, ready for whoever writes the message. */
  text: string;
  /** The parts in the order they apply: later ones refine, and may contradict, earlier ones. */
  sections: ProfileSection[];
  /** Every file it would read, written or not, so a person knows where to put one. */
  candidates: string[];
}

export interface ProfileInitInput {
  /** The account whose file to start; left out, the person's own `user.md`. */
  account?: string | undefined;
  /** One conversation of that account, for its own file. */
  conversation?: string | undefined;
}

export interface ProfileInitResult {
  /** The file for that layer: the one started, or the one already there and left as it was. */
  path: string;
  /** False when a file was already there: nothing was written. */
  created: boolean;
}

/** Where every profile file lives: `<config>/compose/`. */
function composeDirectory(core: Core): string {
  return join(core.paths.configDir, 'compose');
}

/** The channels whose conversations are mail addresses and `@domain`s; Slack's are its ids. */
const MAIL_PLATFORMS: ReadonlySet<string> = new Set(['gmail', 'resend']);

interface Place {
  account?: string;
  platform?: string;
  /** The account's former names, newest first: what its files were written under before a rename. */
  former: string[];
  /** The conversations, each as a behaviour rule takes it: a Slack id as written, an address lower-cased. */
  conversations: string[];
}

/** A connected account by its name, with its platform and former names; refused as every lookup refuses. */
function accountOf(config: Config, name: string): { platform: string; former: string[] } {
  const inbox = lookupName(config, 'inbox', name);
  if (inbox) return { platform: inbox.provider, former: formerNamesOf(config, 'inbox', name) };
  const account = lookupName(config, 'account', name);
  if (account) return { platform: account.platform, former: formerNamesOf(config, 'account', name) };
  const renamed = formerNameRefusal(config, 'inbox', name) ?? formerNameRefusal(config, 'account', name);
  if (renamed) throw renamed;
  const known = connectedAccounts(config).map((entry) => entry.alias);
  throw new CommsError('NOT_FOUND', `no account called "${name}"`, {
    hint: known.length > 0 ? `Known accounts: ${known.join(', ')}.` : 'No accounts are connected here yet.',
  });
}

/** One conversation, checked against what its account's channel has, and written as a behaviour rule takes it. */
function conversationOf(platform: string, conversation: string): string {
  const slack = SLACK_CONVERSATION_PATTERN.test(conversation);
  const mail = MAIL_CONVERSATION_PATTERN.test(conversation);
  if (platform === 'slack' && !slack) {
    throw new CommsError('USAGE', `${JSON.stringify(conversation)} is not a Slack conversation`, {
      hint: 'A Slack conversation is a channel’s id (C…, G…), a DM’s (D…) or a person’s (U…, W…).',
    });
  }
  if (MAIL_PLATFORMS.has(platform) && !mail) {
    throw new CommsError('USAGE', `${JSON.stringify(conversation)} is not an address or @domain`, {
      hint: 'A mail conversation is one recipient’s address, or @domain for everyone there.',
    });
  }
  if (!slack && !mail) {
    throw new CommsError('USAGE', `${JSON.stringify(conversation)} is not a conversation`, {
      hint: 'A conversation is a Slack channel, DM or person id, an address, or @domain.',
    });
  }
  return conversation.includes('@') ? conversation.toLowerCase() : conversation;
}

async function placeOf(core: Core, account: string | undefined, conversations: readonly string[]): Promise<Place> {
  if (account === undefined) {
    if (conversations.length > 0) {
      throw new CommsError('USAGE', 'a conversation’s profile belongs to an account: name the account too', {
        hint: 'Give the account a message goes from, then its conversations.',
      });
    }
    return { former: [], conversations: [] };
  }
  const found = accountOf(await core.config.load(), account);
  return {
    account,
    platform: found.platform,
    former: found.former,
    conversations: conversations.map((conversation) => conversationOf(found.platform, conversation)),
  };
}

/**
 * The joined profile for one place, and every file it would read (B6): the built-in default unless `default.md` is
 * written, `user.md`, the platform's, the account's, then each conversation's, in the order given. Only reads: the
 * compose folder is not even created.
 */
export async function profileView(core: Core, input: ProfileViewInput): Promise<ProfileView> {
  const place = await placeOf(core, input.account, input.conversations ?? []);
  const profile: ComposeProfile = await readComposeProfile(composeDirectory(core), {
    platform: place.platform,
    account: place.account,
    formerAccounts: place.former,
    conversations: place.conversations,
  });
  return { text: profile.text, sections: profile.sections, candidates: profile.candidates };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether a file says anything: an empty one is not read, so it shadows nothing. */
async function hasText(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Starts the missing file for one layer from the starter (`PROFILE_STARTER`), and says where it is: `user.md` with no
 * account, the account's with one, and one conversation's with a conversation too. A file already there is left as it
 * is. So is a file written under a former name of the account, which is read until one is written under the new name:
 * a starter there would shadow it, and that file is the one named instead.
 */
export async function profileInit(core: Core, input: ProfileInitInput): Promise<ProfileInitResult> {
  const place = await placeOf(core, input.account, input.conversation === undefined ? [] : [input.conversation]);
  const directory = composeDirectory(core);
  const [conversation] = place.conversations;
  const names = place.account === undefined ? [] : [place.account, ...place.former];
  const [path, ...former] =
    place.account === undefined
      ? [join(directory, 'user.md')]
      : names.map((name) =>
          join(
            directory,
            conversation === undefined ? inboxProfileFile(name) : conversationProfileFile(name, conversation),
          ),
        );
  const target = path as string;
  if (!(await exists(target))) {
    for (const candidate of former) if (await hasText(candidate)) return { path: candidate, created: false };
  }
  await ensurePrivateDir(directory);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Exclusive: a file that appeared since the check above is still never overwritten.
    handle = await open(target, 'wx', FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { path: target, created: false };
    throw error;
  }
  try {
    await handle.writeFile(PROFILE_STARTER, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { path: target, created: true };
}
