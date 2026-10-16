import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isDangerous } from './chars.ts';
import type {
  ClientConfig,
  Config,
  OrganisationGeneration,
  OrganisationRecord,
  OrganisationServes,
  OrganisationSlackApp,
} from './config.ts';
import { hasNames } from './config.ts';
import { CommsError } from './errors.ts';
import {
  type CliHandoffs,
  type Handoff,
  handoffChoices,
  handoffSentence,
  isCommand,
  type Remedy,
  remedy,
} from './handoff-text.ts';
import { organisationProblem, parseName, parseOrganisation } from './name-grammar.ts';
import { clientSecretRef, GOOGLE_CLIENT_ID_PATTERN } from './oauth-client-records.ts';
import { expandHome, homeDirectory } from './paths.ts';
import { truncateDisplay } from './render.ts';
import { neutralise } from './untrusted.ts';

/**
 * Organisation profiles (design 2026-10-02): an organisation makes its apps once — a Google OAuth client, a Slack app
 * for reading and one for posting — and writes them into one small document; every member adds that document here,
 * alongside whatever they already have, and their accounts can then use the organisation's apps.
 *
 * This module is what the profile *is* and what the configuration records of it: the strict schema a document has to
 * pass (§D1, §D2), how it is read from a file (§D3), how it is shown (§D2), and — over the `organisations` record and
 * the client rows — the generations of its Google client, which of them a profile resolves to, and how far the
 * configuration has drifted from what was approved (§D4, §D8). It writes nothing: `operations/organisations.ts` is the
 * one place a profile changes the configuration, each change approved first.
 *
 * **A profile is data, never code, and none of it is trusted.** Every field comes from whoever wrote the document, so
 * each has a grammar and a bound, an unknown key is an error, and the two free-text fields are neutralised and put on
 * one line wherever they are shown. The client secret is never shown anywhere — not in a preview, an effect, an error,
 * the audit log, a command's output or a tool's result.
 */

/** What a profile says it is, in its first key. */
export const PROFILE_KIND = 'organisation-profile' as const;

/** The whole document, at most: a profile is a few hundred bytes, and this is what stops `/dev/zero` being read. */
export const PROFILE_MAX_BYTES: number = 64 * 1024;

/**
 * The longest organisation word a profile may have: its clients are named `<organisation>-<n>`, `n` up to
 * `GENERATION_LIMIT`, and a client name has 32 characters (`ALIAS_PATTERN`).
 */
export const PROFILE_ORGANISATION_MAX = 28;

/** The most generations — owned client names `<organisation>-1` … — one organisation can have here. */
export const GENERATION_LIMIT = 999;

/**
 * One line of text a person wrote: 1 to `max` characters, with no line or paragraph separator, tab, control character,
 * bidi control or zero-width character (`isDangerous`), and not only spaces.
 *
 * Refused rather than cleaned up: a label is shown in every preview of this organisation, and a line break in it would
 * print a second line that reads like the preview's own. Anything that gets past this — a record edited by hand — is
 * still neutralised and flattened where it is shown (`shownText`).
 */
function oneLine(max: number, what: string): z.ZodType<string, unknown> {
  return z.string().refine(
    (value) => {
      const chars = [...value];
      return (
        chars.length >= 1 &&
        chars.length <= max &&
        value.trim() !== '' &&
        chars.every((char) => char !== '\n' && char !== '\t' && !isDangerous(char.codePointAt(0) ?? 0))
      );
    },
    { message: `${what} is 1–${max} characters on one line: no line break, tab or other control character` },
  );
}

/** A host name as an Internal client's administrator lists it: lower case, letters, digits, hyphens and dots. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export const SLACK_WORKSPACE_ID_PATTERN: RegExp = /^T[A-Z0-9]{2,20}$/;
export const SLACK_CLIENT_ID_PATTERN: RegExp = /^[0-9]{1,20}\.[0-9]{1,20}$/;
export const SLACK_APP_ID_PATTERN: RegExp = /^A[A-Z0-9]{2,20}$/;

const slackAppSchema: z.ZodType<ProfileSlackApp, unknown> = z.strictObject({
  clientId: z.string().regex(SLACK_CLIENT_ID_PATTERN, 'a Slack client id is two runs of digits around a dot'),
  appId: z
    .string()
    .regex(SLACK_APP_ID_PATTERN, 'a Slack app id is A followed by 2–20 capital letters or digits')
    .optional(),
});

/**
 * The strict schema every profile passes (design 2026-10-02 §D2): exactly these keys, each to its grammar and bound.
 *
 * Version 1 names apps and nothing else — no defaults, no policies. Either `gmail` or `slack` may be absent, and so may
 * either Slack app: a profile that stops naming one is how an organisation withdraws it (§D8).
 */
const profileSchema = z.strictObject({
  agentcomms: z.literal(PROFILE_KIND),
  version: z.literal(1),
  organisation: z.string().refine((word) => parseOrganisation(word, { max: PROFILE_ORGANISATION_MAX }) !== null, {
    message: `the organisation is the first half of an account name — lowercase letters, digits and hyphens — at most ${PROFILE_ORGANISATION_MAX} characters, and not a word Windows reserves`,
  }),
  label: oneLine(64, 'the label'),
  gmail: z
    .strictObject({
      clientId: z
        .string()
        .regex(GOOGLE_CLIENT_ID_PATTERN, 'a Google client id is digits, a hyphen, then .apps.googleusercontent.com'),
      // Never echoed, whatever is wrong with it: the message says what a secret looks like, not what this one is.
      clientSecret: z.string().regex(/^[\x20-\x7e]{1,256}$/, 'the client secret is 1–256 printable ASCII characters'),
      projectId: z
        .string()
        .regex(
          /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
          'a Google Cloud project id is 6–30 lowercase letters, digits or hyphens',
        )
        .optional(),
      serves: z.union([
        z.literal('any'),
        z.strictObject({
          domains: z.array(z.string().regex(DOMAIN_PATTERN, 'each domain is a lower-case host name')).min(1).max(50),
        }),
      ]),
    })
    .optional(),
  slack: z
    .strictObject({
      workspace: z
        .string()
        .regex(SLACK_WORKSPACE_ID_PATTERN, 'a Slack workspace id is T followed by capital letters or digits'),
      workspaceName: oneLine(80, 'the workspace name'),
      redirectPort: z.number().int().min(1024).max(65535),
      apps: z.strictObject({ read: slackAppSchema.optional(), send: slackAppSchema.optional() }),
    })
    .optional(),
});

export interface ProfileSlackApp {
  clientId: string;
  appId?: string | undefined;
}

export interface ProfileGmail {
  clientId: string;
  clientSecret: string;
  projectId?: string | undefined;
  serves: OrganisationServes;
}

export interface ProfileSlack {
  workspace: string;
  workspaceName: string;
  redirectPort: number;
  apps: { read?: ProfileSlackApp | undefined; send?: ProfileSlackApp | undefined };
}

/** An organisation profile, as the schema has checked it. */
export interface OrganisationProfile {
  agentcomms: typeof PROFILE_KIND;
  version: 1;
  organisation: string;
  label: string;
  gmail?: ProfileGmail | undefined;
  slack?: ProfileSlack | undefined;
}

export const organisationProfileSchema: z.ZodType<OrganisationProfile, unknown> = profileSchema;

/**
 * A string that came from a profile, as it is shown anywhere: chat-template tokens, role markers and envelope look-alikes
 * neutralised (`neutralise`), every control and invisible character made visible, tabs and line breaks flattened to a
 * space, and cut to `width`. `neutralise` keeps line feeds and tabs on purpose — they are legitimate in a message body —
 * so the flattening is what keeps a label from printing a second line of a preview.
 */
export function shownText(value: unknown, width = 120): string {
  return truncateDisplay(neutralise(typeof value === 'string' ? value : String(value ?? '')).text, width);
}

/** Who a client serves, in a preview's words. */
export function servesText(serves: OrganisationServes): string {
  return serves === 'any'
    ? 'any address'
    : `addresses at ${serves.domains.map((domain) => shownText(domain)).join(', ')}`;
}

/**
 * Parses a profile's text, or refuses it — naming each problem by where it is and what it should be, never by the value
 * found there. A key the schema does not know is named, neutralised and cut short: it came from the document too.
 */
export function parseProfile(text: string): OrganisationProfile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text);
  } catch {
    throw new CommsError('BAD_DATA', 'the organisation profile is not valid JSON', {
      hint: 'Ask your organisation for its profile again; it is one JSON document.',
    });
  }
  const parsed = organisationProfileSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const problems = parsed.error.issues.slice(0, 6).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : 'the profile';
    if (issue.code === 'unrecognized_keys') {
      return `${where}: ${issue.keys.map((key) => `"${shownText(key, 40)}"`).join(', ')} ${issue.keys.length === 1 ? 'is not a key' : 'are not keys'} a profile has`;
    }
    // The secret's own messages are the schema's, which say what a secret looks like; any other wording zod might
    // produce for it is replaced, so nothing about the value can reach a message.
    if (issue.path.join('.') === 'gmail.clientSecret') {
      return `${where}: the client secret is 1–256 printable ASCII characters`;
    }
    return `${where}: ${issue.message}`;
  });
  throw new CommsError('BAD_DATA', `the organisation profile is not valid: ${problems.join('; ')}`, {
    hint: 'A profile has exactly the keys its organisation’s README describes. Ask your organisation for its current one.',
  });
}

/**
 * What looks like a URL rather than a path: a scheme of two or more characters and a colon. Two, so a Windows drive
 * (`C:\…`) is still a path.
 */
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]+:/;

/**
 * The absolute, normalised path a profile is read from — and read again from on every `org update`, whatever the
 * working directory is then (§D3).
 *
 * A URL is refused: version 1 reads files only. A URL's path, not only its query, can be a bearer credential, so one
 * kept or shown would leak it, and fetching one is an outbound request the core does not make. The refusal names the
 * scheme and nothing else of it, for the same reason.
 */
export function profileSourcePath(
  given: unknown,
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  handoffs: CliHandoffs,
): string {
  const value = typeof given === 'string' ? given : '';
  if (value.trim() === '') {
    throw new CommsError('USAGE', 'name the profile file', {
      hint: handoffSentence(
        handoffs.core(['org', 'add', './rgc.agentcomms.json']),
        (command) => `For example: ${command}.`,
        { instead: 'Name it by its path: ./rgc.agentcomms.json, for example.' },
      ),
    });
  }
  /*
   * A path a person cannot read is one they cannot approve. A line break, a terminal control, a bidi override or a
   * zero-width character in the name would be shown escaped — `<U+202E>` — and the person would approve something
   * that is not the file's name as it is spelt; no profile needs a name like that. So it is refused, and the name is
   * repeated only as it is shown. (What remains, visible text that looks like a chat-template token, is neutralised
   * wherever the path is shown; a preview binds the path by its own SHA-256, so the display cannot weaken that.)
   */
  if ([...value].some((char) => char === '\n' || char === '\t' || isDangerous(char.codePointAt(0) ?? 0))) {
    // Shown with each such character made visible, `<U+202E>`, so the person can see which one to rename away —
    // `shownPath` strips invisible characters, which would show a name that looks fine.
    const visible = [...value]
      .map((char) =>
        char === '\n' || char === '\t'
          ? `<U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`
          : char,
      )
      .join('');
    throw new CommsError(
      'USAGE',
      `the profile's path holds a control, invisible or line-break character: ${neutralise(truncateDisplay(visible, 400)).text}`,
      { hint: 'Rename the file to a plain name, and pass that path.' },
    );
  }
  const scheme = URL_LIKE.exec(value.trim());
  if (scheme) {
    throw new CommsError(
      'USAGE',
      `a profile is read from a file in this version, not from a ${scheme[0].toLowerCase()} address`,
      {
        hint: 'Clone your organisation’s repository, or have the file sent to you, and pass its path. A file whose name has a colon in it is passed as ./name.',
      },
    );
  }
  return resolve(cwd ?? process.cwd(), expandHome(value, homeDirectory(env)));
}

/**
 * A profile's path as it is shown — in a preview, an error, a command's output: neutralised and on one line, as every
 * other string a person did not write themselves. The path is chosen by whoever named the file — a repository, a
 * message with an attachment — and its name is text like any other.
 */
export function shownPath(path: string): string {
  return shownText(path, 400);
}

/**
 * The SHA-256 of a profile's path exactly as it is read, which a preview names beside the path as it is shown. An
 * approval is bound to this, not to the display: two paths that read alike once neutralised are still two paths.
 */
export function pathDigest(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex');
}

/** A profile as it was read: from where, the SHA-256 of the exact bytes, and what they say. Never the bytes. */
export interface ProfileFile {
  path: string;
  sha256: string;
  profile: OrganisationProfile;
  /** The organisation's update caps, from the file beside the profile (`updatesPathFor`); absent when there is none. */
  updates?: UpdatesFile | undefined;
}

/**
 * Reads a profile from an absolute path, in one bounded read: open once, check it is a regular file, read at most one
 * byte more than `PROFILE_MAX_BYTES` from the same handle. A path somebody typed can name a FIFO that never ends, a
 * device, a directory; none of them is a profile, and none may be how a command hangs. A symlink is followed: the path
 * is one the person chose.
 */
export async function readProfileFile(path: string): Promise<ProfileFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch {
    throw new CommsError('NOT_FOUND', `no profile file at ${shownPath(path)}`, {
      hint: 'Pass the path of your organisation’s .agentcomms.json file — after `git pull` in its repository, if it came from one.',
    });
  }
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new CommsError('USAGE', `${shownPath(path)} is not a file`);
    const buffer = Buffer.allocUnsafe(PROFILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, PROFILE_MAX_BYTES + 1, 0);
    if (bytesRead > PROFILE_MAX_BYTES) {
      throw new CommsError('BAD_DATA', `${shownPath(path)} is larger than a profile can be (64 KiB)`, {
        hint: 'A profile is a few hundred bytes of JSON. Check this is the file your organisation sent.',
      });
    }
    bytes = Buffer.from(buffer.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError('NOT_FOUND', `the profile at ${shownPath(path)} could not be read`, { cause: error });
  } finally {
    await handle.close();
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CommsError('BAD_DATA', 'the organisation profile is not UTF-8 text');
  }
  const profile = parseProfile(text);
  const updates = await readUpdatesFile(updatesPathFor(path), profile);
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    profile,
    ...(updates === undefined ? {} : { updates }),
  };
}

// ── The record ───────────────────────────────────────────────────────────────────────────────────────────────────

/** An own property only: a name is user input, and `map.constructor` is a function on every plain object. */
export function own<T>(map: Record<string, T> | undefined, key: string): T | undefined {
  return map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The organisation profiles this configuration records — none on version 1, which cannot hold them. */
export function organisationsOf(config: Config): Record<string, OrganisationRecord> {
  return hasNames(config) ? (config.organisations ?? {}) : {};
}

export function recordOf(config: Config, organisation: string): OrganisationRecord | undefined {
  return own(organisationsOf(config), organisation);
}

/** The organisation a profile names, checked as the profile's own word is: refused with the reason. */
export function checkedOrganisation(word: unknown): string {
  const value = typeof word === 'string' ? word : '';
  const problem = organisationProblem(value, { max: PROFILE_ORGANISATION_MAX });
  if (problem !== null) throw new CommsError('USAGE', shownText(problem, 200));
  return value;
}

/** The organisation a client row says owns it, if that organisation has a record here; otherwise none. */
export function managingOrganisation(config: Config, client: ClientConfig | undefined): string | null {
  const marker = client?.organisation;
  if (typeof marker !== 'string' || recordOf(config, marker) === undefined) return null;
  return marker;
}

/**
 * The organisations that hold a client row: the one whose marker it carries, and each whose generation names it while
 * it still holds that generation's client. A row is held by at most one in a configuration this release wrote; more
 * is drift, and either way a held row is never adopted by another (§D4).
 */
export function holdersOf(config: Config, name: string): string[] {
  const row = own(config.clients, name);
  if (!row) return [];
  const holders = new Set<string>();
  const marker = managingOrganisation(config, row);
  if (marker !== null) holders.add(marker);
  for (const [organisation, record] of Object.entries(organisationsOf(config))) {
    if (
      record.gmail?.generations.some((generation) => generation.name === name && generation.clientId === row.clientId)
    ) {
      holders.add(organisation);
    }
  }
  return [...holders].sort();
}

/**
 * How a generation's client row stands against the generation (§D4, §D8):
 *
 * - `ok` — the row is the generation's: for an owned one, marked with this organisation, the same client id, project
 *   and the canonical secret reference; for an adopted one, the same client id and held by no other organisation.
 * - `missing` — no row under its name.
 * - `unmarked` — owned, and its name holds a row of the same client with no organisation's mark: what an older release's
 *   `client add --replace` leaves, since it writes the row afresh and knows nothing of the mark. The same client, so it
 *   is marked again rather than counted as a reused name — which would make the organisation a second client of the
 *   one it already has.
 * - `name-reused` — owned, and its name now holds a row that is not this organisation's: another client with no mark,
 *   or a row another organisation has marked.
 * - `replaced` — owned, marked with this organisation, but holding another client id: row (c).
 * - `altered` — owned, marked, the same client id, but another project, provider or secret reference: rows (b), (e).
 * - `gone` — adopted, and the row now holds another client: the person replaced it.
 * - `held` — adopted, and another organisation has claimed the row since.
 */
export type GenerationState = 'ok' | 'missing' | 'unmarked' | 'name-reused' | 'replaced' | 'altered' | 'gone' | 'held';

export function generationState(
  config: Config,
  organisation: string,
  generation: OrganisationGeneration,
): GenerationState {
  const row = own(config.clients, generation.name);
  if (!row) return 'missing';
  if (generation.ownership === 'owned') {
    // Only the mark missing: the provider and the canonical secret reference are what `client add --replace` writes,
    // and a row without them is not one marking again would make the generation's. A replacement from an older
    // release may omit the project id. Only an active generation can safely treat that as repairable from the
    // profile: on an inactive generation the same shape is what D8(e) leaves after releasing a row whose project id
    // was removed, and the next update must not claim it again. An inactive unmarked row therefore has to retain the
    // generation's exact project id before it can be recognised and marked again.
    const active = organisationsOf(config)[organisation]?.gmail?.active === generation.name;
    if (
      row.organisation === undefined &&
      row.clientId === generation.clientId &&
      row.provider === 'gmail' &&
      row.secretRef === clientSecretRef(generation.name) &&
      (active || row.projectId === generation.projectId)
    ) {
      return 'unmarked';
    }
    if (row.organisation !== organisation) return 'name-reused';
    if (row.clientId !== generation.clientId) return 'replaced';
    const altered =
      row.provider !== 'gmail' ||
      row.secretRef !== clientSecretRef(generation.name) ||
      (row.projectId ?? null) !== (generation.projectId ?? null);
    return altered ? 'altered' : 'ok';
  }
  if (row.clientId !== generation.clientId) return 'gone';
  return holdersOf(config, generation.name).some((holder) => holder !== organisation) ? 'held' : 'ok';
}

/**
 * Whether a retained generation can be made active again (§D4, resolver step 1): an owned one whose row the profile can
 * rebuild — its name free, or holding this organisation's row of that client — and an adopted one whose live row still
 * holds its client and is held by no other organisation.
 */
export function generationUsable(config: Config, organisation: string, generation: OrganisationGeneration): boolean {
  const state = generationState(config, organisation, generation);
  return generation.ownership === 'owned'
    ? state === 'ok' || state === 'missing' || state === 'altered' || state === 'unmarked'
    : state === 'ok';
}

/** The generation `gmail.active` names, if any. */
export function activeGeneration(record: OrganisationRecord | undefined): OrganisationGeneration | undefined {
  const active = record?.gmail?.active;
  if (active === null || active === undefined) return undefined;
  return record?.gmail?.generations.find((generation) => generation.name === active);
}

/**
 * Returns the live client row for one organisation generation, or refuses the route (design 2026-10-02 §D6).
 *
 * A consent flow must never repair drift as it goes. The organisation operation is the one place that can restore a
 * missing owned row, its marker or its canonical secret reference, and can decide whether an adopted row is still
 * safe to use. Gmail therefore calls this one guard for every organisation generation it selects, both before
 * consent and when the flow completes.
 */
export function requireLiveOrganisationGeneration(
  config: Config,
  organisation: string,
  generation: OrganisationGeneration,
  handoffs: CliHandoffs,
): ClientConfig {
  const row = own(config.clients, generation.name);
  const commonMatches =
    row?.provider === 'gmail' &&
    row.clientId === generation.clientId &&
    row.secretRef === clientSecretRef(generation.name);
  const ownershipMatches =
    generation.ownership === 'owned'
      ? row?.organisation === organisation
      : row !== undefined &&
        (row.organisation === undefined || row.organisation === organisation) &&
        !holdersOf(config, generation.name).some((holder) => holder !== organisation);
  if (!row || !commonMatches || !ownershipMatches) {
    throw new CommsError(
      'CONFIG',
      `the organisation ${organisation} cannot use its Google client "${generation.name}" because its registered row is missing or no longer matches`,
      {
        hint: handoffSentence(
          handoffs.core(['org', 'update', organisation]),
          (command) =>
            `Run ${command} (or comms_org_update from a chat) to repair the organisation profile before signing in.`,
          { instead: 'Call comms_org_update from a chat to repair the organisation profile before signing in.' },
        ),
      },
    );
  }
  return row;
}

/** Every client name some organisation's generation uses, live or not: a new owned name never reuses one. */
function generationNames(config: Config): Set<string> {
  const names = new Set<string>();
  for (const record of Object.values(organisationsOf(config))) {
    for (const generation of record.gmail?.generations ?? []) names.add(generation.name);
  }
  return names;
}

/** The lowest `<organisation>-<n>` free in the configuration and in every record, or null past `GENERATION_LIMIT`. */
export function nextGenerationName(
  config: Config,
  organisation: string,
  taken: ReadonlySet<string> = new Set(),
): string | null {
  const used = generationNames(config);
  for (let n = 1; n <= GENERATION_LIMIT; n += 1) {
    const name = `${organisation}-${n}`;
    if (!own(config.clients, name) && !used.has(name) && !taken.has(name)) return name;
  }
  return null;
}

/** Which generation a profile's Google client is, as the one resolver decides it (§D4). */
export type GmailResolution =
  | { kind: 'reactivate'; generation: OrganisationGeneration }
  | { kind: 'adopt'; client: string }
  | { kind: 'create'; name: string };

/**
 * The one resolver, for `org add` and `org update` alike (§D4):
 *
 * 1. a retained generation of this organisation with the client id, **if it is usable** (`generationUsable`) — the
 *    active one first, else the latest — is made active again: A → B → A returns to A's generation;
 * 2. else a row holding that client id that no organisation holds is adopted: the one `adopt` names, or the only one —
 *    two or more are ambiguous, and refused naming them;
 * 3. else a new owned generation, `<organisation>-<n>` at the lowest free `n`.
 *
 * Nothing is ever overwritten: a held row is never adopted, and a new name is free in the configuration and in every
 * record. `adopt` that names anything but the resolver's choice is refused, never silently ignored.
 */
export function resolveGmailGeneration(
  config: Config,
  organisation: string,
  clientId: string,
  options: { adopt?: string | undefined } = {},
): GmailResolution {
  const record = recordOf(config, organisation);
  const generations = record?.gmail?.generations ?? [];
  const usable = generations.filter(
    (generation) => generation.clientId === clientId && generationUsable(config, organisation, generation),
  );
  const active = record?.gmail?.active ?? null;
  const retained = usable.find((generation) => generation.name === active) ?? usable.at(-1);
  if (retained) {
    if (options.adopt !== undefined && !(retained.ownership === 'adopted' && retained.name === options.adopt)) {
      throw new CommsError(
        'USAGE',
        `--adopt is not needed: this profile's Google client is already "${retained.name}", an earlier client of ${organisation}, which is made active again`,
        { hint: 'Run it again without --adopt.' },
      );
    }
    return { kind: 'reactivate', generation: retained };
  }
  const free = Object.entries(config.clients)
    .filter(
      ([name, row]) => row.provider === 'gmail' && row.clientId === clientId && holdersOf(config, name).length === 0,
    )
    .map(([name]) => name)
    .sort();
  if (options.adopt !== undefined) {
    const name = options.adopt;
    const row = own(config.clients, name);
    if (!row) {
      throw new CommsError('NOT_FOUND', `no OAuth client called "${shownText(name, 40)}" to adopt`, {
        hint:
          free.length > 0 ? `Clients here with this profile's client id: ${free.join(', ')}.` : 'Leave out --adopt.',
      });
    }
    if (row.provider !== 'gmail' || row.clientId !== clientId) {
      throw new CommsError('CONFIG', `"${name}" is another OAuth client, not the one this profile names`, {
        hint:
          free.length > 0 ? `Clients here with this profile's client id: ${free.join(', ')}.` : 'Leave out --adopt.',
      });
    }
    const holders = holdersOf(config, name);
    if (holders.length > 0) {
      throw new CommsError('CONFIG', `"${name}" already belongs to the organisation ${holders.join(' and ')}`, {
        hint: 'A client belongs to one organisation at most. Leave out --adopt, and this profile registers its own.',
      });
    }
    return { kind: 'adopt', client: name };
  }
  if (free.length > 1) {
    throw new CommsError(
      'CONFIG',
      `this profile's Google client is registered here more than once: ${free.join(', ')}`,
      {
        hint: `Say which one this organisation should use with --adopt <client> (adopt, from a chat): ${free.join(' or ')}.`,
      },
    );
  }
  if (free.length === 1) return { kind: 'adopt', client: free[0] as string };
  const name = nextGenerationName(config, organisation);
  if (name === null) {
    throw new CommsError(
      'CONFIG',
      `${organisation} has used every client name from ${organisation}-1 to ${organisation}-${GENERATION_LIMIT}`,
      {
        hint: 'Remove the clients it no longer uses, or the profile, and add it again.',
      },
    );
  }
  return { kind: 'create', name };
}

// ── Drift ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Mailboxes signing in through a client, by name. */
export function mailboxesOn(config: Config, client: string): string[] {
  return Object.entries(config.inboxes)
    .filter(([, inbox]) => inbox.client === client)
    .map(([name]) => name)
    .sort();
}

/**
 * Accounts connected through this organisation's apps — the `organisation` provenance Slack records from phase 3 of
 * the design on. None before then; read here so that every rule that depends on it is already in place.
 */
export function accountsOfOrganisation(config: Config, organisation: string): string[] {
  return Object.entries(config.accounts)
    .filter(([, account]) => account.organisation === organisation)
    .map(([name]) => name)
    .sort();
}

/** Client rows marked with this organisation that are none of its owned generations: a mark nothing here explains. */
export function strayMarkedRows(config: Config, organisation: string): string[] {
  const owned = new Set(
    (recordOf(config, organisation)?.gmail?.generations ?? [])
      .filter((generation) => generation.ownership === 'owned')
      .map((generation) => generation.name),
  );
  return Object.entries(config.clients)
    .filter(([name, row]) => row.organisation === organisation && !owned.has(name))
    .map(([name]) => name)
    .sort();
}

/** Client rows marked with an organisation that has no record here: ordinary clients, which `doctor` points out. */
export function orphanMarkedRows(config: Config): { client: string; organisation: string }[] {
  return Object.entries(config.clients)
    .filter(([, row]) => typeof row.organisation === 'string' && recordOf(config, row.organisation) === undefined)
    .map(([client, row]) => ({ client, organisation: row.organisation as string }))
    .sort((a, b) => a.client.localeCompare(b.client));
}

/**
 * One way the configuration differs from what a profile approved, with what puts it right.
 *
 * `repair` — `org update <organisation>` brings it back to what was approved, at once and without asking (§D8: rows
 * (a), (b), (c), (e), and a stray mark). `report` — nothing here can rebuild it (row (d): a missing earlier generation,
 * whose secret only its old client file holds), or it is the person's own client and is theirs to change.
 */
export interface OrganisationDrift {
  kind: 'repair' | 'report';
  /** The client name it is about. */
  client: string;
  /** Whether that is the generation new mailboxes get. */
  active: boolean;
  state: GenerationState | 'stray-mark';
  detail: string;
  /** What puts it right: core's `org update`, located, or Gmail's commands found where Gmail is registered, in words. */
  fix: Remedy;
}

/**
 * Commands — one an account, say — as "with `a` and `b`"; or, when not one is a command here, "with `tool` from a chat"
 * and why there is none. For another product's commands, which core finds only among the servers registered here
 * (CUE-403): a profile names Gmail's and Slack's, and this core may be installed with neither.
 */
export function withEach(handoffs: readonly Handoff[], tool: string): string {
  return handoffs.some(isCommand)
    ? `with ${handoffChoices(handoffs, '', { conjunction: 'and' })}`
    : `with ${tool} from a chat (${handoffChoices(handoffs, '').replace(/\.$/, '')})`;
}

/** Every drift of one organisation's record from the configuration, in a stable order. */
export function organisationDrift(config: Config, organisation: string, handoffs: CliHandoffs): OrganisationDrift[] {
  const record = recordOf(config, organisation);
  if (!record) return [];
  const drift: OrganisationDrift[] = [];
  // Each fix is said in words around the commands the handoffs made — a sentence of the fixed renderers' — as a remedy.
  const push = (item: Omit<OrganisationDrift, 'fix'> & { fix: string }) =>
    drift.push({ ...item, fix: remedy(item.fix) });
  const maker = handoffs;
  const update = handoffSentence(
    maker.core(['org', 'update', organisation]),
    (command) => `Run ${command} (comms_org_update from a chat).`,
    { instead: 'Call comms_org_update from a chat.' },
  );
  const active = activeGeneration(record);
  for (const generation of record.gmail?.generations ?? []) {
    const state = generationState(config, organisation, generation);
    if (state === 'ok') continue;
    const isActive = generation === active;
    const { name } = generation;
    const users = mailboxesOn(config, name);
    /*
     * Gmail's commands, which this core does not have: found among the servers registered here, when the handoffs
     * were given them (CUE-403) — never guessed. With none found, the tool that does it from a chat, and why.
     */
    const move =
      active && !isActive
        ? ` Move ${users.length > 0 ? users.join(', ') : 'any mailbox on it'} onto "${active.name}" ${withEach(
            users.length > 0
              ? users.map((mailbox) => maker.of('gmail', ['inbox', 'reauth', mailbox, '--client', active.name]))
              : [maker.of('gmail', ['inbox', 'reauth', '--help'], { uses: [] })],
            'gmail_inbox_reauth',
          )}.`
        : '';
    if (generation.ownership === 'adopted') {
      push({
        kind: isActive ? 'repair' : 'report',
        client: name,
        active: isActive,
        state,
        detail:
          state === 'held'
            ? `"${name}", which you registered and ${organisation} uses, is claimed by another organisation now`
            : `"${name}", which you registered and ${organisation} uses, no longer holds its client ${shownText(generation.clientId, 120)}: it was ${state === 'missing' ? 'removed' : 'replaced'}`,
        fix: isActive
          ? `${update} It finds or registers the profile's client again.`
          : `Nothing to repair: it was yours to change.${move}`,
      });
      continue;
    }
    // A row that lost its mark may have lost its project with it — what marking it again puts back, and says so.
    const row = own(config.clients, name);
    const projectLost = state === 'unmarked' && (row?.projectId ?? null) !== (generation.projectId ?? null);
    const putBack = projectLost
      ? `, puts back its Google Cloud project (${generation.projectId === undefined ? 'none' : shownText(generation.projectId, 120)})`
      : '';
    if (isActive) {
      const detail = {
        missing: `"${name}", the client ${organisation} gives new mailboxes, has gone`,
        'name-reused': `the name "${name}", the client ${organisation} gives new mailboxes, now holds a client that is not ${organisation}'s`,
        replaced: `"${name}", marked as ${organisation}'s, holds another client id than the profile's`,
        altered: `"${name}", the client ${organisation} gives new mailboxes, was changed: another secret reference or project`,
        unmarked: `"${name}", the client ${organisation} gives new mailboxes, has lost its mark as ${organisation}'s${projectLost ? ' and its project' : ''} (an older release's \`client add --replace\` drops it)`,
      }[state as 'missing' | 'name-reused' | 'replaced' | 'altered' | 'unmarked'];
      push({
        kind: 'repair',
        client: name,
        active: true,
        state,
        detail,
        fix:
          state === 'unmarked'
            ? `${update} It marks the client as ${organisation}'s again${putBack}, and holds its secret to the profile's.`
            : `${update} It rebuilds the client from the profile.`,
      });
      continue;
    }
    if (state === 'replaced' || state === 'altered') {
      push({
        kind: 'repair',
        client: name,
        active: false,
        state,
        detail: `"${name}", an earlier client of ${organisation}, was changed and is still marked as ${organisation}'s`,
        fix: `${update} It clears the mark, and the client stays as one of your own.`,
      });
      continue;
    }
    if (state === 'unmarked') {
      push({
        kind: 'repair',
        client: name,
        active: false,
        state,
        detail: `"${name}", an earlier client of ${organisation}, has lost its mark as ${organisation}'s${projectLost ? ' and its project' : ''}`,
        fix: `${update} It marks the client as ${organisation}'s again${putBack}, and leaves its secret as it is.`,
      });
      continue;
    }
    push({
      kind: 'report',
      client: name,
      active: false,
      state,
      detail:
        state === 'missing'
          ? `"${name}", an earlier client of ${organisation}, has gone, and cannot be rebuilt without its old client file`
          : `the name "${name}", an earlier client of ${organisation}, now holds a client that is not ${organisation}'s`,
      fix: `Nothing here can rebuild it: the profile holds only the current client's secret.${move}`,
    });
  }
  for (const client of strayMarkedRows(config, organisation)) {
    push({
      kind: 'repair',
      client,
      active: false,
      state: 'stray-mark',
      detail: `"${client}" is marked as ${organisation}'s without being one of its clients`,
      fix: `${update} It clears the mark, and the client stays as one of your own.`,
    });
  }
  return drift;
}

/** The record's Slack apps as the profile states them — keeping an app id learned at sign-in while it still applies. */
export function slackRecordFrom(
  profile: ProfileSlack,
  previous: OrganisationRecord['slack'],
): NonNullable<OrganisationRecord['slack']> {
  const app = (role: 'read' | 'send'): OrganisationSlackApp | undefined => {
    const stated = profile.apps[role];
    if (!stated) return undefined;
    const before = previous?.apps[role];
    // A learned app id is kept only while the workspace, the role and its client id stay the same (§D7); one the
    // profile states replaces it.
    const learned =
      before && previous?.workspace === profile.workspace && before.clientId === stated.clientId
        ? before.appId
        : undefined;
    const appId = stated.appId ?? learned;
    return { clientId: stated.clientId, ...(appId === undefined ? {} : { appId }) };
  };
  const read = app('read');
  const send = app('send');
  return {
    workspace: profile.workspace,
    workspaceName: profile.workspaceName,
    redirectPort: profile.redirectPort,
    apps: { ...(read ? { read } : {}), ...(send ? { send } : {}) },
  };
}

export interface ProfileSlackTarget {
  organisation: string;
  role: 'read' | 'send';
  label: string;
  workspace: string;
  workspaceName: string;
  redirectPort: number;
  clientId: string;
  appId?: string | undefined;
  sha256: string;
}

const profileSlackTargetSchema: z.ZodType<ProfileSlackTarget, unknown> = z.strictObject({
  organisation: z.string().refine((word) => parseOrganisation(word) !== null, 'an organisation is a name’s first half'),
  role: z.enum(['read', 'send']),
  label: oneLine(64, 'the label'),
  workspace: z
    .string()
    .regex(SLACK_WORKSPACE_ID_PATTERN, 'a Slack workspace id is T followed by capital letters or digits'),
  workspaceName: oneLine(80, 'the workspace name'),
  redirectPort: z.number().int().min(1024).max(65535),
  clientId: z.string().regex(SLACK_CLIENT_ID_PATTERN, 'a Slack client id is two runs of digits around a dot'),
  appId: z
    .string()
    .regex(SLACK_APP_ID_PATTERN, 'a Slack app id is A followed by 2–20 capital letters or digits')
    .optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 is 64 lowercase hex digits'),
});

function slackTargetProblem(organisation: string, message: string, handoffs: CliHandoffs): CommsError {
  return new CommsError('CONFIG', message, {
    hint: handoffSentence(
      handoffs.core(['org', 'update', organisation]),
      (command) => `Run ${command} to reconcile the profile, then start the sign-in again.`,
      { instead: 'Call comms_org_update from a chat to reconcile the profile, then start the sign-in again.' },
    ),
  });
}

/** Resolve one profile app to the exact, validated values a Slack sign-in snapshots. */
export function resolveProfileSlackTarget(
  config: Config,
  organisation: string,
  role: 'read' | 'send',
  handoffs: CliHandoffs,
): ProfileSlackTarget {
  const record = recordOf(config, organisation);
  if (!record) {
    throw slackTargetProblem(
      organisation,
      `there is no organisation profile for ${shownText(organisation, 40)}`,
      handoffs,
    );
  }
  if (!record.slack) {
    throw slackTargetProblem(
      organisation,
      `the organisation profile for ${organisation} does not list Slack`,
      handoffs,
    );
  }
  const app = record.slack.apps[role];
  if (!app) {
    throw slackTargetProblem(
      organisation,
      `the organisation profile for ${organisation} does not list a ${role} app`,
      handoffs,
    );
  }
  const parsed = profileSlackTargetSchema.safeParse({
    organisation,
    role,
    label: record.label,
    workspace: record.slack.workspace,
    workspaceName: record.slack.workspaceName,
    redirectPort: record.slack.redirectPort,
    clientId: app.clientId,
    ...(app.appId === undefined ? {} : { appId: app.appId }),
    sha256: record.sha256,
  });
  if (!parsed.success) {
    throw slackTargetProblem(
      organisation,
      `the organisation profile for ${organisation} has an invalid stored Slack target`,
      handoffs,
    );
  }
  return parsed.data;
}

/**
 * Learn the app id Slack returned only while the whole target still names the sign-in that produced it.
 *
 * The function is pure so the caller can put this change in the same locked config update as the account. A target
 * which already carries an id is never overwritten: whether the id came from the profile or an earlier sign-in, it
 * is the one this flow was required to reach.
 */
export function learnProfileSlackAppId(
  config: Config,
  expected: ProfileSlackTarget,
  appId: string,
  handoffs: CliHandoffs,
): Config {
  if (!SLACK_APP_ID_PATTERN.test(appId)) {
    throw slackTargetProblem(
      expected.organisation,
      'Slack returned an invalid app id for the profile sign-in',
      handoffs,
    );
  }
  let live: ProfileSlackTarget;
  try {
    live = resolveProfileSlackTarget(config, expected.organisation, expected.role, handoffs);
  } catch {
    throw slackTargetProblem(
      expected.organisation,
      `the organisation profile changed during the Slack sign-in`,
      handoffs,
    );
  }
  const stable = (target: ProfileSlackTarget) => ({
    organisation: target.organisation,
    role: target.role,
    label: target.label,
    workspace: target.workspace,
    workspaceName: target.workspaceName,
    redirectPort: target.redirectPort,
    clientId: target.clientId,
    sha256: target.sha256,
  });
  if (JSON.stringify(stable(live)) !== JSON.stringify(stable(expected))) {
    throw slackTargetProblem(
      expected.organisation,
      `the organisation profile changed during the Slack sign-in`,
      handoffs,
    );
  }
  if (expected.appId !== undefined && live.appId !== expected.appId) {
    throw slackTargetProblem(
      expected.organisation,
      `the organisation profile changed during the Slack sign-in`,
      handoffs,
    );
  }
  if (live.appId !== undefined) {
    if (live.appId === appId) return config;
    throw slackTargetProblem(
      expected.organisation,
      `the ${expected.role} profile app already has another app id`,
      handoffs,
    );
  }
  if (!hasNames(config)) {
    throw slackTargetProblem(
      expected.organisation,
      'organisation profiles require a version-2 configuration',
      handoffs,
    );
  }
  const next = structuredClone(config);
  const app = next.organisations?.[expected.organisation]?.slack?.apps[expected.role];
  if (!app) {
    throw slackTargetProblem(
      expected.organisation,
      `the organisation profile changed during the Slack sign-in`,
      handoffs,
    );
  }
  app.appId = appId;
  return next;
}

/**
 * Accounts named after this organisation that are connected to its Slack workspace through an app of their own — not
 * the profile's. `org add` reports each and goes on (§D5, as decided in implementation): early members connected that
 * way before profiles existed, and adding the profile must not make them disconnect Slack first. The account is left
 * exactly as it is — it carries no provenance, so nothing treats it as the profile's.
 */
export function unmanagedSlackAccounts(config: Config, organisation: string, workspace: string): string[] {
  return Object.entries(config.accounts)
    .filter(([name, account]) => {
      const parsed = parseName(name);
      return (
        parsed?.org === organisation &&
        account.platform === 'slack' &&
        account.workspace === workspace &&
        account.organisation === undefined
      );
    })
    .map(([name]) => name)
    .sort();
}

// ── The organisation's update caps ──────────────────────────────────────────────────────────────────────────────────

/**
 * An organisation's update caps (design 2026-10-16, U8): the most its members' machines may update — `max`,
 * `every-14-days` or `never` — and `background: false`, no background job. They only ever tighten: a member's level is
 * capped at `max`, and nothing a member sets goes past it.
 *
 * **They are named in a file beside the profile, not in it.** Every object of a version-1 profile is strict in every
 * release since profiles were added (0.13.0 to 0.19.0): a key such as `updates` anywhere refuses the whole document,
 * and a member still on an older release would lose `org update` for everything else the organisation changes. So the
 * profile stays exactly as those releases read it, and the caps go in `<profile>.updates.json`, which they never open.
 * This release reads it whenever it reads the profile, binds it by its own SHA-256 in the same approval, and records it
 * as the organisation's `updates`, where the configuration's loose schema lets older releases keep it through their
 * writes.
 */
export const UPDATE_CAPS = ['every-14-days', 'never'] as const;
export type UpdateCap = (typeof UPDATE_CAPS)[number];

/** The updates file for a profile: in the same folder, the profile's name with `.updates.json` for its `.json`. */
export function updatesPathFor(profilePath: string): string {
  return /\.json$/i.test(profilePath)
    ? `${profilePath.slice(0, -'.json'.length)}.updates.json`
    : `${profilePath}.updates.json`;
}

/** The caps as they were read: from where, the SHA-256 of the exact bytes, and what they say. */
export interface UpdatesFile {
  path: string;
  sha256: string;
  max?: UpdateCap | undefined;
  background?: false | undefined;
}

const updatesSchema = z.strictObject({
  organisation: z.string(),
  max: z
    .enum(UPDATE_CAPS, { message: 'max is every-14-days or never: a cap only ever makes updates less frequent' })
    .optional(),
  background: z
    .literal(false, { message: 'background is false or left out: a cap can only turn background updates off' })
    .optional(),
});

/**
 * Reads the updates file, if there is one, and holds it to the profile it sits beside: the same organisation. Strict as
 * the profile is, read in one bounded read as the profile is, and refused naming each problem by where it is, never by
 * the value found there — but naming this file, so the person knows which of the two to fix. Only a file that is not
 * there is no caps: one that is there and cannot be opened is refused, since read as none it would lift the caps.
 */
async function readUpdatesFile(path: string, profile: OrganisationProfile): Promise<UpdatesFile | undefined> {
  const where = shownPath(path);
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CommsError('NOT_FOUND', `the updates file at ${where} could not be opened`, { cause: error });
  }
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) throw new CommsError('USAGE', `${where} is not a file`);
    const buffer = Buffer.allocUnsafe(PROFILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, PROFILE_MAX_BYTES + 1, 0);
    if (bytesRead > PROFILE_MAX_BYTES) {
      throw new CommsError('BAD_DATA', `${where} is larger than an updates file can be (64 KiB)`);
    }
    bytes = Buffer.from(buffer.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof CommsError) throw error;
    throw new CommsError('NOT_FOUND', `the updates file at ${where} could not be read`, { cause: error });
  } finally {
    await handle.close();
  }
  const refuse = (problem: string): never => {
    throw new CommsError('BAD_DATA', `the updates file ${where} is not valid: ${problem}`, {
      hint: 'It names the organisation, and the caps on how its members update and nothing else: `max` (every-14-days or never) and `background` (false). Ask your organisation for its current one.',
    });
  };
  let raw: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    raw = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text);
  } catch {
    return refuse('it is not valid UTF-8 JSON');
  }
  const parsed = updatesSchema.safeParse(raw);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues
        .slice(0, 6)
        .map((issue) => {
          const at = issue.path.length > 0 ? issue.path.map(String).join('.') : 'the file';
          return issue.code === 'unrecognized_keys'
            ? `${at}: ${issue.keys.map((key) => `"${shownText(key, 40)}"`).join(', ')} ${issue.keys.length === 1 ? 'is not a key' : 'are not keys'} it has`
            : `${at}: ${issue.message}`;
        })
        .join('; '),
    );
  }
  const document = parsed.data;
  if (document.organisation !== profile.organisation) {
    return refuse(
      `it names the organisation ${shownText(document.organisation, 40)}, not ${profile.organisation}, whose profile it sits beside`,
    );
  }
  return {
    path,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(document.max === undefined ? {} : { max: document.max }),
    ...(document.background === undefined ? {} : { background: false as const }),
  };
}

/** The caps, as a preview and the doctor say them: "at most never, no background updates", or "no caps". */
export function capsText(caps: { max?: string | undefined; background?: boolean | undefined } | undefined): string {
  const parts = [
    ...(caps?.max === undefined ? [] : [`at most ${shownText(caps.max, 20)}`]),
    ...(caps?.background === false ? ['no background updates'] : []),
  ];
  return parts.length === 0 ? 'no caps' : parts.join(', ');
}
