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
 * The whole grammar as one expression, so a record key can be checked by the schema without a second pass.
 *
 * Segments never start or end with a hyphen, and the character set is `[a-z0-9/-]` and nothing else: no `.`, so no
 * `..`; no whitespace, no controls, no upper case, nothing that looks like something else.
 */
export const NAME_PATTERN: RegExp = new RegExp(
  `^(?!(?:${WINDOWS_RESERVED.join('|')})/)(${ORG})/(${PLATFORM})(?:-(${QUALIFIER}))?$`,
);

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
 * Why a name is refused, in words a person can act on — or null when it is fine.
 *
 * `platform` is what the account actually is. Checked here as well as in the schema, so the error arrives when the
 * name is proposed rather than as a refused config write after a sign-in has already been spent.
 */
export function nameShapeProblem(name: string, platform: string): string | null {
  const parsed = parseName(name);
  if (!parsed) {
    const org = name.split('/')[0] ?? '';
    if (WINDOWS_RESERVED.includes(org)) {
      return `"${org}" cannot be an organisation name: Windows reserves it, and the organisation becomes a folder`;
    }
    return `"${name}" is not a valid name: it should be the organisation, a slash, then ${platform} — for example acme/${platform}, or acme/${platform}-support for a second one`;
  }
  if (parsed.platform !== platform) {
    return `"${name}" ends in /${parsed.platform}, but this is a ${platform} account`;
  }
  return null;
}
