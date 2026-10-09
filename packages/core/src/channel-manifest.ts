import { z } from 'zod';
import { ACCOUNT_MODES, type AccountMode } from './config.ts';
import { PLATFORM_PATTERN } from './name-grammar.ts';

/**
 * What a channel says about itself: the `"agentcomms"` field of its `package.json`.
 *
 * Pure data, so it can be read without running any of the channel's code — by this repository's tooling, by the build
 * that snapshots it into core (`channels.generated.ts`), and later by anything that has to decide about a package
 * before installing it. Everything core used to know about Gmail and Slack by name — the package to install, the
 * flags that pin a server to one account, which other servers to warn about, what a person approves with — is here,
 * and core derives its behaviour from it rather than from a table written beside the code.
 *
 * First-party only (design 2026-09-26). A channel in this repository ships in lockstep with core, and the manifest is
 * the shape a reviewed registry would read later; nothing here loads a channel from anywhere else.
 */

/** The version of this contract a manifest is written against. A manifest names it so a later one can differ. */
export const CHANNEL_CONTRACT = 1;

/** What keeps a mode within bounds: the grant the platform issued, or only this suite's code. */
export type GuaranteeSource = 'grant' | 'code';

/** How a server is narrowed: a `pin` to one account, which takes its name, or a `switch`, which takes nothing. */
export interface ChannelNarrowing {
  /** The install option it sets. `account` is the generic pin; `inbox` and `workspace` are Gmail's and Slack's. */
  readonly option: NarrowingOption;
  /** The flag it is on the server's command line, and on `mcp install`: `--inbox`, `--read-only`. */
  readonly flag: string;
  readonly kind: 'pin' | 'switch';
}

export type NarrowingOption = 'account' | 'inbox' | 'workspace' | 'readOnly';

/** A published package that serves the same platform with no approval step. */
export interface ChannelRivalPackage {
  /** `@shinzolabs/gmail-mcp`. Matched anywhere on a registered server's command line. */
  readonly name: string;
  /** Also match the name without its scope, as its own word: `npx server-gmail-autoauth-mcp`. */
  readonly unscoped?: boolean | undefined;
}

/**
 * How the unsent report groups a channel's send approvals into drafts (design 2026-10-05 §D9), applied by core to the
 * generic fields every approval stores, so a channel chooses without any edit to core:
 *
 * - `draft` — by mailbox or account and draft (`inboxId`, `draftId`): every approval for the draft counts, however its
 *   content changed between preparations. Gmail's, and Resend's prepared sends'.
 * - `draft-revision-digest` — by mailbox or account, draft, exact revision and exact content digest (`inboxId`,
 *   `draftId`, `draftMessageId`, `contentDigest`): Slack's posts and files. A record whose revision is its own content
 *   digest — the convention for an act with no draft to edit, such as a reaction — is in no group.
 */
export type ApprovalGrouping = 'draft' | 'draft-revision-digest';

/** The credential boundary an event source needs, kept as manifest data rather than inferred from an adapter. */
export type EventSourceAccess =
  | { readonly kind: 'oauth-user'; readonly requiredScopes: readonly string[] }
  | { readonly kind: 'resend-full-access' }
  | { readonly kind: 'local-store' };

/** A channel's optional local-event adapter declaration. */
export interface ChannelEvents {
  readonly types: readonly string[];
  readonly minimumIntervalMs: number;
  readonly access: EventSourceAccess;
}

export interface ChannelManifest {
  readonly contract: typeof CHANNEL_CONTRACT;
  /**
   * The platform word: the second half of every account's name (`cue/<channel>`), the prefix of the server's tools
   * (`<channel>_…`) and of its secret references. `core` is the core package's own, and no channel's.
   */
  readonly channel: string;
  /** How a person is shown it: `Gmail`, `Slack`. */
  readonly label: string;
  /** The command a person types. */
  readonly binary: string;
  readonly server: {
    /** The name a client shows for it when none is given. */
    readonly defaultName: string;
    /** What `npx` runs: the package itself, or a thin `-mcp` wrapper that is nothing but the server. */
    readonly npxPackage: string;
    /** What `npx` runs that package with, before the server's own flags: `["mcp"]` for a whole CLI. */
    readonly npxArgs?: readonly string[] | undefined;
    /** Trailing path segments, beyond `dist/cli.mjs`, that also start this server. */
    readonly entryFiles?: readonly (readonly string[])[] | undefined;
    /** Other published commands that start this server. */
    readonly bins?: readonly string[] | undefined;
  };
  /** The accounts it connects. Absent only for core, which connects none. */
  readonly accounts?:
    | {
        /** The config map they live in. Gmail's are `inboxes`; every channel after it uses `accounts`. */
        readonly map: 'inboxes' | 'accounts';
        /** What one is called in a sentence: `mailbox`, `workspace`, `account`. */
        readonly noun: string;
        /** The modes it offers, narrow to wide, from the closed vocabulary `read`, `send`. */
        readonly modes: readonly AccountMode[];
        /**
         * What holds each end, honestly: `floor` is what stops the narrowest mode from reaching anyone, `ceiling`
         * what bounds the widest. `grant` when the platform's own credential enforces it; `code` when only this
         * suite does — Resend has no read-only key, so its `read` is code.
         */
        readonly guarantee: {
          readonly ceiling: GuaranteeSource;
          readonly floor: GuaranteeSource;
          readonly why: string;
        };
      }
    | undefined;
  /** The flags that narrow its server, in the order they are written. */
  readonly narrowing?: readonly ChannelNarrowing[] | undefined;
  /**
   * Other servers for the same service, which a registration warns about: by package name, or — where there are too
   * many to list — by the platform's word anywhere in an entry, with what such a server `can` do unapproved.
   */
  readonly rivals?:
    | {
        readonly word?: string | undefined;
        readonly can?: string | undefined;
        readonly packages?: readonly ChannelRivalPackage[] | undefined;
      }
    | undefined;
  /**
   * The hosts its code talks to. Declared, not yet enforced.
   *
   * Every channel says it, and `[]` is an answer: a channel that reaches no host at all — WhatsApp, which reads a file
   * on this Mac — says so rather than naming one it never talks to. What a list names is a promise a later transport
   * can hold it to; an empty list is the strictest such promise.
   */
  readonly hosts?: readonly string[] | undefined;
  /** The command a person runs at a terminal to approve under `confirm`: `agent-gmail approve`. */
  readonly approve?: string | undefined;
  /** Its skills: their name prefix, and the contract every one of them carries. */
  readonly skills?: { readonly prefix: string; readonly contract: string } | undefined;
  /**
   * How the unsent report groups its send approvals into drafts (`ApprovalGrouping`). Absent: its approvals take no
   * part in the report. The core, which sends nothing, declares none.
   */
  readonly approvalGrouping?: ApprovalGrouping | undefined;
  /** Local event types the channel can acquire, with its scheduler floor and credential boundary. */
  readonly events?: ChannelEvents | undefined;
}

/** A manifest, and the package that declares it. */
export interface ChannelEntry {
  readonly packageName: string;
  readonly manifest: ChannelManifest;
}

const SCOPE = '@agentcomms/';
const line = z
  .string()
  .min(1)
  .regex(/^[^\n\r]*$/, 'one line');
const word = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');
const ownPackage = z.string().refine((name) => name.startsWith(SCOPE), `a package of this suite, ${SCOPE}…`);
const host = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, 'a host name');

const narrowingSchema = z.strictObject({
  option: z.enum(['account', 'inbox', 'workspace', 'readOnly']),
  flag: z.string().regex(/^--[a-z][a-z-]*$/, 'a long flag, `--like-this`'),
  kind: z.enum(['pin', 'switch']),
});

const eventAccessSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('oauth-user'), requiredScopes: z.array(line).min(1) }),
  z.strictObject({ kind: z.literal('resend-full-access') }),
  z.strictObject({ kind: z.literal('local-store') }),
]);

const eventsSchema = z.strictObject({
  types: z.array(line).min(1),
  minimumIntervalMs: z.number().int().positive(),
  access: eventAccessSchema,
});

/**
 * The shapes Gmail and Slack had before there was a manifest, kept because their entries, tools and skills already
 * say them — and nobody else's.
 *
 * Gmail's mailboxes are in `inboxes`, and its server is pinned by `--inbox` and narrowed by `--read-only`; Slack's is
 * pinned by `--workspace`. Every channel after them keeps its accounts in `accounts` and is pinned by `--account`
 * alone (design 2026-09-26, §2 and §6). Allowed to anyone, either shape made a new channel's accounts mailboxes to the
 * core — its pin checked against the inbox map — or wrote Slack's flag for it; so each exception is its channel's, by
 * name, and exactly as shipped.
 */
const KEPT_SHAPES: Readonly<
  Record<string, { label: string; map: 'inboxes' | 'accounts'; narrowing: readonly ChannelNarrowing[] }>
> = {
  gmail: {
    label: 'Gmail',
    map: 'inboxes',
    narrowing: [
      { option: 'inbox', flag: '--inbox', kind: 'pin' },
      { option: 'readOnly', flag: '--read-only', kind: 'switch' },
    ],
  },
  slack: { label: 'Slack', map: 'accounts', narrowing: [{ option: 'workspace', flag: '--workspace', kind: 'pin' }] },
};

/** Every channel's after Gmail and Slack: accounts in `accounts`, and the generic pin alone. */
const GENERIC_NARROWING: readonly ChannelNarrowing[] = [{ option: 'account', flag: '--account', kind: 'pin' }];

/** The narrowing as the flags it writes, for a message: `inbox` / `--inbox`, `readOnly` / `--read-only`. */
const narrowingWords = (narrowing: readonly ChannelNarrowing[]) =>
  narrowing.map((entry) => `\`${entry.option}\` / \`${entry.flag}\``).join(' and ');

/** A command a person types: the core's is `agentcomms`, and every channel's is `agent-<something>`. */
const CORE_BINARY = 'agentcomms';
const CHANNEL_BINARY = /^agent-[a-z0-9][a-z0-9-]*$/;

const manifestSchema = z
  .strictObject({
    contract: z.literal(CHANNEL_CONTRACT),
    channel: z.string().regex(PLATFORM_PATTERN, 'a platform word: a lowercase letter, then up to 15 letters or digits'),
    label: line,
    binary: word,
    server: z.strictObject({
      defaultName: word,
      npxPackage: ownPackage,
      npxArgs: z.array(line).optional(),
      entryFiles: z.array(z.array(line).min(1)).optional(),
      bins: z.array(word).optional(),
    }),
    accounts: z
      .strictObject({
        map: z.enum(['inboxes', 'accounts']),
        noun: line,
        modes: z.array(z.enum(ACCOUNT_MODES)).min(1),
        guarantee: z.strictObject({ ceiling: z.enum(['grant', 'code']), floor: z.enum(['grant', 'code']), why: line }),
      })
      .optional(),
    narrowing: z.array(narrowingSchema).optional(),
    rivals: z
      .strictObject({
        word: z.string().regex(PLATFORM_PATTERN).optional(),
        can: line.optional(),
        packages: z
          .array(
            z.strictObject({
              name: z.string().regex(/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/, 'an npm package name'),
              unscoped: z.boolean().optional(),
            }),
          )
          .min(1)
          .optional(),
      })
      .optional(),
    // Required of a channel (below), and may be empty: `[]` says it reaches no host.
    hosts: z.array(host).optional(),
    approve: line.optional(),
    skills: z
      .strictObject({ prefix: z.string().regex(/^[a-z][a-z0-9]*-$/, 'a word and a hyphen: `gmail-`'), contract: line })
      .optional(),
    approvalGrouping: z.enum(['draft', 'draft-revision-digest']).optional(),
    events: eventsSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const isCore = manifest.channel === 'core';
    if (isCore) {
      // The core connects no account, so it has nothing to pin, narrow or be rivalled over.
      for (const key of ['accounts', 'narrowing', 'rivals', 'hosts'] as const) {
        if (manifest[key] !== undefined) issue([key], 'the core connects no account, so it has none');
      }
      if (manifest.approvalGrouping !== undefined) {
        issue(['approvalGrouping'], 'the core sends nothing, so it groups no approvals');
      }
    } else {
      for (const key of ['accounts', 'narrowing', 'hosts', 'approve', 'skills'] as const) {
        if (manifest[key] === undefined) issue([key], 'every channel says this');
      }
      // One pin, so a server can always be narrowed to one account — the thing `--force` must never widen.
      const pins = (manifest.narrowing ?? []).filter((n) => n.kind === 'pin');
      if (pins.length !== 1) issue(['narrowing'], 'a channel has exactly one pin');
      // Gmail's and Slack's own shapes, and every other channel's: see `KEPT_SHAPES`.
      const kept = Object.hasOwn(KEPT_SHAPES, manifest.channel) ? KEPT_SHAPES[manifest.channel] : undefined;
      const map = kept?.map ?? 'accounts';
      if (manifest.accounts !== undefined && manifest.accounts.map !== map) {
        issue(
          ['accounts', 'map'],
          map === 'inboxes'
            ? `${kept?.label}'s mailboxes are in \`inboxes\`, where every entry and tool already reads them`
            : "`inboxes` is Gmail's alone: every channel after it keeps its accounts in `accounts`",
        );
      }
      const narrowing = kept?.narrowing ?? GENERIC_NARROWING;
      if (
        manifest.narrowing !== undefined &&
        JSON.stringify(manifest.narrowing.map(({ option, flag, kind }) => ({ option, flag, kind }))) !==
          JSON.stringify(narrowing)
      ) {
        issue(
          ['narrowing'],
          kept
            ? `${kept.label}'s server is pinned by ${narrowingWords(narrowing)}, as its entries have always been written`
            : `\`inbox\`, \`--read-only\` and \`workspace\` are Gmail's and Slack's; a channel after them is pinned by ${narrowingWords(narrowing)} and nothing else`,
        );
      }
    }
    // The commands a person types: the core's own, or `agent-<something>`, so no channel's reads as anything else.
    if (isCore) {
      if (manifest.binary !== CORE_BINARY) issue(['binary'], "is not the core's own command name");
    } else if (!CHANNEL_BINARY.test(manifest.binary)) {
      issue(['binary'], "a channel's command is `agent-<something>`");
    }
    (manifest.server.bins ?? []).forEach((bin, index) => {
      if (!CHANNEL_BINARY.test(bin)) issue(['server', 'bins', index], "a channel's command is `agent-<something>`");
    });
    const narrowing = manifest.narrowing ?? [];
    narrowing.forEach((entry, index) => {
      if ((entry.option === 'readOnly') !== (entry.kind === 'switch')) {
        issue(['narrowing', index], '`readOnly` is the one switch; every other option is a pin');
      }
    });
    for (const key of ['option', 'flag'] as const) {
      const seen = narrowing.map((entry) => entry[key]);
      if (new Set(seen).size !== seen.length) issue(['narrowing'], `each ${key} once`);
    }
    const modes = manifest.accounts?.modes ?? [];
    if (
      modes.some(
        (mode, index) =>
          index > 0 && ACCOUNT_MODES.indexOf(mode) <= ACCOUNT_MODES.indexOf(modes[index - 1] as AccountMode),
      )
    ) {
      issue(['accounts', 'modes'], 'modes are listed once each, narrow to wide');
    }
    const rivals = manifest.rivals;
    if (rivals) {
      if (rivals.word === undefined && rivals.packages === undefined) issue(['rivals'], 'a word or packages');
      if ((rivals.word === undefined) !== (rivals.can === undefined)) {
        issue(['rivals'], '`word` and `can` come together: what a server matching the word can do unapproved');
      }
    }
    if (manifest.approve !== undefined && !manifest.approve.startsWith(`${manifest.binary} `)) {
      issue(['approve'], "must start with the channel's own command, its `binary`, and a space");
    }
    if (manifest.skills) {
      const family = manifest.skills.prefix.slice(0, -1);
      if (manifest.skills.contract !== `skills/_shared/contract-${family}.md`) {
        issue(
          ['skills', 'contract'],
          `skills/_shared/contract-${family}.md: a skill's contract is chosen by its prefix`,
        );
      }
    }
  });

/** The schema of one manifest. */
export const channelManifestSchema: z.ZodType<ChannelManifest, unknown> = manifestSchema as never;

/**
 * Every first-party manifest, checked one by one and against each other.
 *
 * What no single manifest can promise: the core is there exactly once, and no two channels share a word, a binary,
 * a server name, a package or a skill prefix — any of which would make a registration, a tool or a skill mean two
 * things. Throws with every problem named.
 */
export function parseChannelEntries(entries: readonly { packageName: string; manifest: unknown }[]): ChannelEntry[] {
  const problems: string[] = [];
  const parsed: ChannelEntry[] = [];
  for (const { packageName, manifest } of entries) {
    const result = channelManifestSchema.safeParse(manifest);
    if (!result.success) {
      for (const issue of result.error.issues) {
        problems.push(`${packageName}: agentcomms.${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      continue;
    }
    if (!packageName.startsWith(SCOPE)) problems.push(`${packageName}: not a package of this suite`);
    parsed.push({ packageName, manifest: result.data });
  }
  const unique = (what: string, of: (entry: ChannelEntry) => readonly string[]) => {
    const seen = new Map<string, string>();
    for (const entry of parsed) {
      for (const value of of(entry)) {
        const other = seen.get(value);
        if (other !== undefined) problems.push(`${entry.packageName}: ${what} "${value}" is ${other}'s too`);
        seen.set(value, entry.packageName);
      }
    }
  };
  unique('channel', (entry) => [entry.manifest.channel]);
  unique('binary', (entry) => [entry.manifest.binary, ...(entry.manifest.server.bins ?? [])]);
  unique('server name', (entry) => [entry.manifest.server.defaultName]);
  unique('package', (entry) => [
    entry.packageName,
    ...(entry.manifest.server.npxPackage === entry.packageName ? [] : [entry.manifest.server.npxPackage]),
  ]);
  unique('skill prefix', (entry) => (entry.manifest.skills ? [entry.manifest.skills.prefix] : []));
  const cores = parsed.filter((entry) => entry.manifest.channel === 'core');
  if (cores.length !== 1 && problems.length === 0) problems.push(`the core's manifest appears ${cores.length} times`);
  if (problems.length > 0) throw new Error(`channel manifests:\n  - ${problems.join('\n  - ')}`);
  return parsed;
}
