/**
 * The grammar of an account name in version 2 of the config: `<organisation>/<platform>[-<qualifier>]`.
 *
 * `cue/gmail` is the CUE++ mailbox, `cue/slack` the CUE++ workspace, `wf/gmail-tech` a second Wherefrom mailbox. The
 * first half says who an account belongs to and the second what it is — and the schema checks the second half against
 * the account itself, so a name cannot claim to be a Slack workspace while naming a mailbox.
 *
 * Kept apart from `config.ts`, with no imports, so the schema and the helpers built on it can both depend on it
 * without depending on each other.
 */

/**
 * Organisation names Windows cannot use as a directory.
 *
 * The organisation becomes a folder — downloads land in `downloads/cue/gmail/…` — and `con`, `nul` and the rest are
 * device names on Windows in every directory, with or without an extension. Refused here rather than discovered the
 * first time somebody on Windows saves an attachment.
 */
const WINDOWS_RESERVED = ['con', 'prn', 'aux', 'nul', ...range('com'), ...range('lpt')];

function range(prefix: string): string[] {
  return Array.from({ length: 9 }, (_, index) => `${prefix}${index + 1}`);
}

const ORG = '[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?';
const PLATFORM = '[a-z][a-z0-9]{0,15}';
const QUALIFIER = '[a-z0-9](?:[a-z0-9-]{0,14}[a-z0-9])?';

/**
 * The organisation word, Windows' reserved words refused: the one expression both a name's first half and an
 * organisation on its own are checked by.
 *
 * The refusal looks ahead for the end of the word — a slash in a name, the end of the string on its own — so `con` is
 * refused and `cons` is not, in either place. Written once, because an organisation profile names its organisation
 * with this word (design 2026-10-02 §D2), and a second copy of the rule is a rule that can drift: a profile could then
 * add an organisation no account could ever be named after, or one whose downloads folder Windows cannot create.
 */
const ORGANISATION = `(?!(?:${WINDOWS_RESERVED.join('|')})(?:/|$))(${ORG})`;

/**
 * The whole grammar as one expression, so a record key can be checked by the schema without a second pass.
 *
 * Segments never start or end with a hyphen, and the character set is `[a-z0-9/-]` and nothing else: no `.`, so no
 * `..`; no whitespace, no controls, no upper case, nothing that looks like something else.
 */
export const NAME_PATTERN: RegExp = new RegExp(`^${ORGANISATION}/(${PLATFORM})(?:-(${QUALIFIER}))?$`);

/** An organisation word on its own — `cue`, `rgc` — exactly as it would begin an account name. */
export const ORGANISATION_PATTERN: RegExp = new RegExp(`^${ORGANISATION}$`);

/** A platform word on its own — `gmail`, `slack` — which is also a channel's word in its manifest. */
export const PLATFORM_PATTERN: RegExp = new RegExp(`^${PLATFORM}$`);

/**
 * A version-1 name — `cue`, `rgc-tech` — as the configuration's `ALIAS_PATTERN` is: kept here, with no imports, so the
 * behaviour rules (`behaviour.ts`, which may import no value from the configuration) can tell a name an account could
 * have from one it never could.
 */
export const PLAIN_NAME_PATTERN: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const NAME_MESSAGE =
  'names look like organisation/platform, optionally with a qualifier: cue/gmail, wf/gmail-tech, cue/slack';

export interface ParsedName {
  org: string;
  platform: string;
  qualifier?: string | undefined;
}

/** The three parts of a valid name, or null for anything the grammar refuses. */
export function parseName(name: string): ParsedName | null {
  const match = NAME_PATTERN.exec(name);
  if (!match) return null;
  const [, org = '', platform = '', qualifier] = match;
  return qualifier === undefined ? { org, platform } : { org, platform, qualifier };
}

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/**
 * The organisation word, or null for anything the grammar refuses — the same rule as a name's first half, from the same
 * expression. `max` cuts it shorter where a word has to leave room for something after it: an organisation profile's
 * word becomes client names `<organisation>-<n>`, which have 32 characters between them (design 2026-10-02 §D2).
 */
export function parseOrganisation(word: string, options: { max?: number } = {}): string | null {
  if (typeof word !== 'string' || !ORGANISATION_PATTERN.test(word)) return null;
  if (options.max !== undefined && word.length > options.max) return null;
  return word;
}

/**
 * Why an organisation word is refused, in words a person can act on — or null when it is fine.
 *
 * Shared with `nameShapeProblem`, so the reason a profile's organisation is refused is the reason a name with it would
 * be: Windows' reserved words say so, and anything else says what the word may hold.
 */
export function organisationProblem(word: string, options: { max?: number } = {}): string | null {
  if (parseOrganisation(word, options) !== null) return null;
  if (typeof word === 'string' && WINDOWS_RESERVED.includes(word)) {
    return `"${word}" cannot be an organisation name: Windows reserves it, and the organisation becomes a folder`;
  }
  if (typeof word === 'string' && ORGANISATION_PATTERN.test(word) && options.max !== undefined) {
    return `"${word}" is too long for an organisation name here: at most ${options.max} characters`;
  }
  return 'an organisation name is 1–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit';
}

/**
 * Why a name is refused, in words a person can act on — or null when it is fine.
 *
 * `platform` is what the account actually is. Checked here as well as in the schema, so the error arrives when the
 * name is proposed rather than as a refused config write after a sign-in has already been spent.
 */
export function nameShapeProblem(name: string, platform: string): string | null {
  const parsed = parseName(name);
  if (!parsed) {
    const org = name.split('/')[0] ?? '';
    if (WINDOWS_RESERVED.includes(org)) return organisationProblem(org);
    return `"${name}" is not a valid name: it should be the organisation, a slash, then ${platform} — for example acme/${platform}, or acme/${platform}-support for a second one`;
  }
  if (parsed.platform !== platform) {
    return `"${name}" ends in /${parsed.platform}, but this is a ${platform} account`;
  }
  return null;
}
