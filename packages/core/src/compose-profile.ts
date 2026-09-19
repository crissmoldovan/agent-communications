import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from './fs.ts';

/**
 * How messages should be written.
 *
 * A person's writing has a shape — how they greet, how long a message runs, how they sign off — and an agent that
 * ignores it produces mail that reads as written by somebody else. That shape belongs in one place, not scattered
 * through skills, and it has layers: what is true of every message, what is true of this platform (a Gmail thread
 * has a subject and a signature; a chat message has neither), and what is true of one mailbox (work is not home).
 *
 * The layers are plain Markdown files the user can edit. They are **instructions to whoever writes the message**,
 * never content, and never anything this package sends on its own.
 */

export const PROFILE_LAYERS = ['default', 'user', 'platform', 'inbox'] as const;
export type ProfileLayer = (typeof PROFILE_LAYERS)[number];

export interface ProfileSection {
  layer: ProfileLayer;
  /** The file it came from, or `built-in`. */
  source: string;
  text: string;
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

export interface ProfileOptions {
  /** `gmail`, or another provider later. */
  platform?: string | undefined;
  /** The mailbox alias, for per-inbox rules. */
  inbox?: string | undefined;
}

function fileFor(directory: string, layer: ProfileLayer, options: ProfileOptions): string | null {
  switch (layer) {
    case 'default':
      return join(directory, 'default.md');
    case 'user':
      return join(directory, 'user.md');
    case 'platform':
      return options.platform ? join(directory, `${options.platform}.md`) : null;
    case 'inbox':
      return options.inbox ? join(directory, `inbox-${options.inbox}.md`) : null;
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
    const path = fileFor(directory, layer, options);
    if (!path) continue;
    candidates.push(path);
    try {
      const text = (await readFile(path, 'utf8')).trim();
      if (text) sections.push({ layer, source: path, text });
    } catch {
      // Not written yet.
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
