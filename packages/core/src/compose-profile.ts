import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from './fs.ts';

/**
 * How messages should be written.
 *
 * A person's writing has a shape — how they greet, how long a message runs, how they sign off — and an agent that
 * ignores it produces mail that reads as written by somebody else. That shape belongs in one place, not scattered
 * through skills, and it has layers: what is true of every message, what is true of this platform (a Gmail thread
 * has a subject and a signature; a chat message has neither), what is true of one account (work is not home), and what
 * is true of one conversation — a channel, a person, a recipient or their domain (design 2026-10-19-agent-behaviour-
 * rules, B6).
 *
 * The layers are plain Markdown files the user can edit. They are **instructions to whoever writes the message**,
 * never content, and never anything this package sends on its own.
 */

/**
 * In the order they apply. The account layer was called `inbox` while only Gmail read it; its files keep the
 * `inbox-<account>.md` names they were written under, so a profile a person wrote then keeps applying.
 */
export const PROFILE_LAYERS = ['default', 'user', 'platform', 'account', 'conversation'] as const;
export type ProfileLayer = (typeof PROFILE_LAYERS)[number];

export interface ProfileSection {
  layer: ProfileLayer;
  /** The file it came from, or `built-in`. */
  source: string;
  text: string;
  /** The conversation layer only: the conversation it is for, as it was asked about. */
  conversation?: string;
}

export interface ComposeProfile {
  /** The layers in the order they apply: later ones refine, and may contradict, earlier ones. */
  sections: ProfileSection[];
  /** Everything joined, ready to hand to whoever is writing. */
  text: string;
  /** Files that would be read if they existed, so a caller can say where to put them. */
  candidates: string[];
}

/**
 * The starting point: what holds for any message to a person, whatever the platform. Deliberately short — a profile
 * nobody reads changes nothing — and deliberately about shape rather than content.
 */
export const BUILT_IN_PROFILE = `# Writing a message

- Say the thing. The first sentence should carry the point, not set it up.
- One subject per message. A second topic is a second message, or a conversation.
- Ask for what you want explicitly, and number the asks when there is more than one.
- Match the length to the content. Most replies are shorter than they feel they should be.
- Write as the person would speak: contractions, ordinary words, no performed enthusiasm.
- No em dashes, no bolded inline headers, no three-part lists written for rhythm rather than meaning.
- Never apologise for timing unless something was actually promised.
- Quote what you are answering only when the reply would otherwise be unclear.
`;

/**
 * What `profile init` writes into a file that does not exist yet (B6): five headings, each with one line of example,
 * for the person to change into how they write there. Guidance, like every profile: "always in the thread" as a rule
 * an agent cannot break is a behaviour rule's `reply` without `post`, not this.
 */
export const PROFILE_STARTER = `# How to write here

These are your instructions to the agents that write for you here. Change each line to say how you write; nothing
in this file is ever sent.

## Tone

- Plain and friendly; match how the other person writes.

## Language

- Write in the language the conversation is in.

## Length

- As short as the content allows; most replies are two or three sentences.

## Sign-off

- Sign off with my first name in mail, and with nothing in a chat.

## Threads

- Reply in the thread; start a new message only when asked.
`;

export interface ProfileOptions {
  /** `gmail`, `slack`, `resend` — the platform's own file, `<platform>.md`. */
  platform?: string | undefined;
  /** The account's name, for its own rules: `acme/slack`. */
  account?: string | undefined;
  /** The mailbox name: what `account` was called while only Gmail read a profile, and Gmail's callers still pass. */
  inbox?: string | undefined;
  /**
   * Names this account used to have, newest first.
   *
   * A profile is a file named after the account, so a rename would leave the rules a person wrote behind under the
   * old name. The current name wins; a former one is read when nothing has been written under the new one. This goes
   * for the account's conversation files too.
   */
  formerAccounts?: readonly string[] | undefined;
  /** `formerAccounts`, as Gmail's callers still pass it. */
  formerInboxes?: readonly string[] | undefined;
  /**
   * The conversations a message goes to, in the order their files apply, after the account's: for mail each
   * recipient's address and then its `@domain`, in recipient order; for a Slack DM its `D…` and then the person's `U…`.
   * Read only with an account, since a conversation's file is named after the account it belongs to.
   */
  conversations?: readonly string[] | undefined;
}

/**
 * A mailbox's profile file name, with `/` encoded.
 *
 * `acme/gmail` would otherwise name a file in an `inbox-acme` directory nobody created, and the rules written for
 * that mailbox would silently stop applying. `_` cannot appear in a name, so `__` can only mean the separator.
 *
 * Every account's, not only a mailbox's: `inbox-cue__slack.md` is a Slack workspace's. The name stays what it was, so
 * files people wrote before there were other accounts keep working.
 */
export function inboxProfileFile(inbox: string): string {
  return `inbox-${inbox.replaceAll('/', '__')}.md`;
}

/** What a conversation's part of a file name may hold as it is: every other byte is `%XX`. */
const KEPT_IN_FILE_NAME = /^[A-Za-z0-9@._-]$/u;

/**
 * One conversation's profile file name: `conversation-<account>__<conversation>.md`, the account written as
 * `inboxProfileFile` writes it and the conversation as a behaviour rule takes it — a Slack id as Slack writes it, an
 * address or `@domain` lower-cased, since addresses match regardless of case. `@` is kept; every byte outside
 * `[A-Za-z0-9@._-]`, `%` among them, is `%XX` of its UTF-8, so `sam+news@client.test` is `sam%2Bnews@client.test`
 * and no two conversations share a file. What is left is a name every platform's file system can hold.
 */
export function conversationProfileFile(account: string, conversation: string): string {
  const id = conversation.includes('@') ? conversation.toLowerCase() : conversation;
  let encoded = '';
  for (const char of id) {
    if (KEPT_IN_FILE_NAME.test(char)) {
      encoded += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char))
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `conversation-${account.replaceAll('/', '__')}__${encoded}.md`;
}

/** The files one layer would be read from, each with the conversation it is for; the first written one is read. */
function filesFor(
  directory: string,
  layer: ProfileLayer,
  options: ProfileOptions,
): { paths: string[]; conversation?: string }[] {
  const account = options.account ?? options.inbox;
  const names = account ? [account, ...(options.formerAccounts ?? options.formerInboxes ?? [])] : [];
  switch (layer) {
    case 'default':
      return [{ paths: [join(directory, 'default.md')] }];
    case 'user':
      return [{ paths: [join(directory, 'user.md')] }];
    case 'platform':
      return options.platform ? [{ paths: [join(directory, `${options.platform}.md`)] }] : [];
    case 'account':
      return account ? [{ paths: names.map((name) => join(directory, inboxProfileFile(name))) }] : [];
    case 'conversation': {
      if (!account) return [];
      // Each once, where it first comes: two recipients at one domain read the domain's file once.
      const seen = new Set<string>();
      return (options.conversations ?? []).flatMap((conversation) => {
        const file = conversationProfileFile(account, conversation);
        if (seen.has(file)) return [];
        seen.add(file);
        return [
          { paths: names.map((name) => join(directory, conversationProfileFile(name, conversation))), conversation },
        ];
      });
    }
  }
}

/**
 * Reads the profile for one message. Missing layers are simply absent: a user who has written nothing gets the
 * built-in shape, and a user who has written everything never sees it.
 */
export async function readComposeProfile(directory: string, options: ProfileOptions = {}): Promise<ComposeProfile> {
  const sections: ProfileSection[] = [];
  const candidates: string[] = [];

  for (const layer of PROFILE_LAYERS) {
    for (const { paths, conversation } of filesFor(directory, layer, options)) {
      for (const path of paths) {
        candidates.push(path);
        let text: string;
        try {
          text = (await readFile(path, 'utf8')).trim();
        } catch {
          continue; // Not written yet.
        }
        if (text) {
          sections.push({ layer, source: path, text, ...(conversation === undefined ? {} : { conversation }) });
          // One file each: the current name first, a former one only when nothing was written under it.
          break;
        }
      }
    }
  }

  if (!sections.some((section) => section.layer === 'default')) {
    sections.unshift({ layer: 'default', source: 'built-in', text: BUILT_IN_PROFILE.trim() });
  }

  return {
    sections,
    text: sections.map((section) => `<!-- ${section.layer}: ${section.source} -->\n${section.text}`).join('\n\n'),
    candidates,
  };
}

/** Writes the built-in profile into the directory so a user has something to edit rather than a blank page. */
export async function initialiseComposeProfile(directory: string): Promise<string> {
  await ensurePrivateDir(directory);
  const path = join(directory, 'default.md');
  try {
    await readFile(path, 'utf8');
  } catch {
    await writeFileAtomic(path, BUILT_IN_PROFILE);
  }
  return path;
}

/** The profile files that exist, for `doctor` and for a "where do I put this?" answer. */
export async function listComposeProfiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}
