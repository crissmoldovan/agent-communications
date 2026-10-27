/**
 * What Search on this machine answers (0.35.0, design 2026-10-26-local-search §6–§8), read field by field from core's
 * `search status|query|people|person|index|rebuild --json`, and the join that gives each hit its story (S4): the same
 * `join.ts` the Messages screen uses, over `activity items --ids` and, for a message the event service saw, its `message
 * show`. What was done is never copied into the index; it is joined here, each time.
 *
 * Every reader is lenient about what it does not need and strict about what it shows: an entry with no id, or with a
 * time that is not one, is left out rather than guessed at. Nothing here makes markup. Everything a sender wrote — a
 * name, a subject, a line, an excerpt, a message's text — arrives inside the untrusted-content envelope and is kept as
 * it came, a string the screen shows only through `OutsideText` or `UntrustedText`.
 */
import { splitEnvelopes } from './envelope.ts';
import { isSearchQuery, refusedInSearchText, SEARCH_QUERY_LIMIT } from './grammar.ts';
import type { Bridge, Call } from './ipc.ts';
import { type JoinedMessage, join } from './messages/join.ts';
import {
  type ActivityItems,
  type ItemLine,
  isItemId,
  type MessageEvent,
  type Millis,
  readActivityItems,
  readMessageShow,
} from './messages/read.ts';
import { SEARCH_COPY } from './screens/search/copy.ts';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const moment = (value: unknown): Millis | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
const oneOf = <T extends string>(value: unknown, words: readonly T[], otherwise: T): T =>
  words.find((word) => word === value) ?? otherwise;

// ── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type SearchChannelWord = 'gmail' | 'slack';

export interface SearchAccountView {
  id: string;
  alias: string;
  channel: SearchChannelWord;
}

export const MODEL_STATES = ['running', 'missing', 'remote-refused', 'unreachable', 'unexpected'] as const;
export type ModelState = (typeof MODEL_STATES)[number];

export interface SearchModelView {
  address: string;
  name: string;
  state: ModelState;
  digest: string | null;
  /** One sentence about it, in core's words. */
  detail: string;
  /** What the person runs to get it: Agent Comms downloads nothing itself. */
  pull: string;
  /** Whether Ollama's local-only mode is set where core can see it. */
  localOnly: boolean;
}

export interface SearchStatusView {
  on: boolean;
  accounts: SearchAccountView[];
  /** Activity's days: what is kept goes when they pass (S12). */
  retentionDays: number;
  folder: string;
  kept: {
    messages: number;
    asked: number;
    answered: number;
    people: number;
    waiting: number;
    bytes: number;
    oldestDay: string | null;
  };
  words: 'ready' | 'needs-newer-node';
  model: SearchModelView | null;
  /** The reviewed models, the default first. */
  models: { name: string; download: string; licence: string }[];
  backups: 'excluded' | 'not-excluded' | 'not-checked' | 'unknown';
  diskEncryption: 'on' | 'off' | 'not-checked' | 'unknown';
  keyStore: 'keychain' | 'file';
  key: 'present' | 'none' | 'unknown';
  lastCaptureFailure: { at: string; message: string } | null;
  /** Sentences a screen shows: what is not encrypted, what is not checked. */
  notes: string[];
  problems: string[];
}

function accountOf(value: unknown): SearchAccountView | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const alias = text(value.alias);
  const channel = value.channel === 'gmail' || value.channel === 'slack' ? value.channel : null;
  return id === null || alias === null || channel === null ? null : { id, alias, channel };
}

function modelOf(value: unknown): SearchModelView | null {
  if (!isRecord(value)) return null;
  const address = text(value.address);
  const name = text(value.name);
  if (address === null || name === null) return null;
  return {
    address,
    name,
    state: oneOf(value.state, MODEL_STATES, 'unexpected'),
    digest: text(value.digest),
    detail: text(value.detail) ?? '',
    pull: text(value.pull) ?? `ollama pull ${name}`,
    localOnly: value.localOnly === true,
  };
}

/** `search status --json`, read; null when it is not that answer at all. */
export function readSearchStatus(value: unknown): SearchStatusView | null {
  if (!isRecord(value) || typeof value.on !== 'boolean' || !isRecord(value.kept)) return null;
  const kept = value.kept;
  const failure = isRecord(value.lastCaptureFailure) ? value.lastCaptureFailure : null;
  return {
    on: value.on,
    accounts: Array.isArray(value.accounts) ? value.accounts.flatMap((each) => accountOf(each) ?? []) : [],
    retentionDays: count(value.retentionDays) || 30,
    folder: text(value.folder) ?? '',
    kept: {
      messages: count(kept.messages),
      asked: count(kept.asked),
      answered: count(kept.answered),
      people: count(kept.people),
      waiting: count(kept.waiting),
      bytes: count(kept.bytes),
      oldestDay: text(kept.oldestDay),
    },
    words: value.words === 'needs-newer-node' ? 'needs-newer-node' : 'ready',
    model: modelOf(value.model),
    models: Array.isArray(value.models)
      ? value.models.flatMap((each) => {
          if (!isRecord(each)) return [];
          const name = text(each.name);
          return name === null
            ? []
            : [{ name, download: text(each.download) ?? '', licence: text(each.licence) ?? '' }];
        })
      : [],
    backups: oneOf(value.backups, ['excluded', 'not-excluded', 'not-checked', 'unknown'] as const, 'unknown'),
    diskEncryption: oneOf(value.diskEncryption, ['on', 'off', 'not-checked', 'unknown'] as const, 'unknown'),
    keyStore: value.keyStore === 'file' ? 'file' : 'keychain',
    key: oneOf(value.key, ['present', 'none', 'unknown'] as const, 'unknown'),
    lastCaptureFailure:
      failure !== null && text(failure.at) !== null && text(failure.message) !== null
        ? { at: failure.at as string, message: failure.message as string }
        : null,
    notes: strings(value.notes),
    problems: strings(value.problems),
  };
}

// ── A search ───────────────────────────────────────────────────────────────────────────────────────────────────

export type HitFlag = 'mismatch' | 'unrenderable';

export interface SearchHitView {
  sourceId: string;
  /** The event service's, when it saw it (phase 2): its story is `message show`'s. */
  eventId: string | null;
  channel: SearchChannelWord;
  account: { id: string; alias: string };
  direction: 'in' | 'out';
  at: Millis;
  person: { id: string; linked: boolean } | null;
  /** `email:<address>` or `slack:<team>/<user>`, plain when it is a plain one, else enveloped. */
  handle: string | null;
  /** The sender's name, the subject, the line, the excerpt: each the sender's words, enveloped. */
  from: string | null;
  subject: string | null;
  line: string;
  excerpt: string;
  flags: HitFlag[];
  /** A snippet, or a read cut short: a full read replaces it. */
  partial: boolean;
  /** The replies Agent Comms sent to it. */
  answeredBy: { sourceId: string; at: Millis }[];
  /** Where it ranked by words and by meaning, 1-based; null for a list it was not in. */
  rank: { words: number | null; meaning: number | null };
}

export interface SearchResultView {
  /** `hybrid` when meaning was looked at too; `words` with no model, or one that failed its check. */
  mode: 'hybrid' | 'words';
  /** Kept messages with no vector yet in the set searched by meaning. */
  pending: number;
  model: { name: string; digest: string } | null;
  /** Why meaning was not looked at, when a model is set and it was not: core's words. */
  modelNote: string | null;
  /** How many kept messages the filters left to look through. */
  looked: number;
  ms: number;
  hits: SearchHitView[];
}

const rankOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;

function answersOf(value: unknown): { sourceId: string; at: Millis }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((each) => {
    if (!isRecord(each)) return [];
    const sourceId = text(each.sourceId);
    const at = moment(each.at);
    return sourceId === null || at === null ? [] : [{ sourceId, at }];
  });
}

function flagsOf(value: unknown): HitFlag[] {
  return strings(value).filter((flag): flag is HitFlag => flag === 'mismatch' || flag === 'unrenderable');
}

function hitOf(value: unknown): SearchHitView | null {
  if (!isRecord(value)) return null;
  const sourceId = text(value.sourceId);
  const channel = value.channel === 'gmail' || value.channel === 'slack' ? value.channel : null;
  const account = isRecord(value.account) ? value.account : null;
  const accountId = account === null ? null : text(account.id);
  const at = moment(value.at);
  if (sourceId === null || channel === null || accountId === null || at === null) return null;
  const person = isRecord(value.person) && text(value.person.id) !== null ? value.person : null;
  const rank = isRecord(value.rank) ? value.rank : {};
  return {
    sourceId,
    eventId: text(value.eventId),
    channel,
    account: { id: accountId, alias: text(account?.alias) ?? accountId },
    direction: value.direction === 'out' ? 'out' : 'in',
    at,
    person: person === null ? null : { id: person.id as string, linked: person.linked === true },
    handle: text(value.handle),
    from: text(value.from),
    subject: text(value.subject),
    line: text(value.line) ?? '',
    excerpt: text(value.excerpt) ?? '',
    flags: flagsOf(value.flags),
    partial: value.partial === true,
    answeredBy: answersOf(value.answeredBy),
    rank: { words: rankOf(rank.words), meaning: rankOf(rank.meaning) },
  };
}

/** `search query --json`, read; null when it is not that answer at all. */
export function readSearchResult(value: unknown): SearchResultView | null {
  if (!isRecord(value) || !Array.isArray(value.hits)) return null;
  const model = isRecord(value.model) && text(value.model.name) !== null ? value.model : null;
  return {
    mode: value.mode === 'hybrid' ? 'hybrid' : 'words',
    pending: count(value.pending),
    model: model === null ? null : { name: model.name as string, digest: text(model.digest) ?? '' },
    modelNote: text(value.modelNote),
    looked: count(value.looked),
    ms: count(value.ms),
    hits: value.hits.flatMap((each) => hitOf(each) ?? []),
  };
}

// ── People ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PersonView {
  id: string;
  /** True once the person joined or separated handles themselves. */
  linked: boolean;
  /** The name the person gave them: the person's own words. */
  label: string | null;
  /** The latest name a sender gave, enveloped: a suggestion, never proof of who they are. */
  name: string | null;
  handles: { handle: string; name: string | null }[];
  count: number;
  lastAt: Millis | null;
}

function personOf(value: unknown): PersonView | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (id === null) return null;
  return {
    id,
    linked: value.linked === true,
    label: text(value.label),
    name: text(value.name),
    handles: Array.isArray(value.handles)
      ? value.handles.flatMap((each) => {
          if (!isRecord(each)) return [];
          const handle = text(each.handle);
          return handle === null ? [] : [{ handle, name: text(each.name) }];
        })
      : [],
    count: count(value.count),
    lastAt: moment(value.lastAt),
  };
}

/** `search people --json`, read: `{ people }`; null when it is not that answer. */
export function readPeople(value: unknown): PersonView[] | null {
  if (!isRecord(value) || !Array.isArray(value.people)) return null;
  return value.people.flatMap((each) => personOf(each) ?? []);
}

export interface PersonMessageView {
  sourceId: string;
  eventId: string | null;
  channel: SearchChannelWord;
  account: { id: string; alias: string };
  at: Millis;
  line: string;
  subject: string | null;
  flags: HitFlag[];
  partial: boolean;
  answeredBy: { sourceId: string; at: Millis }[];
}

function personMessageOf(value: unknown): PersonMessageView | null {
  const hit = hitOf({ ...(isRecord(value) ? value : {}), direction: 'in' });
  if (hit === null) return null;
  const { sourceId, eventId, channel, account, at, line, subject, flags, partial, answeredBy } = hit;
  return { sourceId, eventId, channel, account, at, line, subject, flags, partial, answeredBy };
}

/** `search person <id> --json`, read; null when it is not that answer. */
export function readPerson(
  value: unknown,
): { person: PersonView; messages: PersonMessageView[]; more: boolean } | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const person = personOf(value.person);
  if (person === null) return null;
  return {
    person,
    messages: value.messages.flatMap((each) => personMessageOf(each) ?? []),
    more: value.more === true,
  };
}

// ── Upkeep and changes ─────────────────────────────────────────────────────────────────────────────────────────

export interface IndexRunView {
  /** False when Search was never on here: there was nothing to run. */
  ran: boolean;
  /** Another run held the lock. */
  busy: boolean;
  taken: number;
  embedded: number;
  pending: number;
  pruned: number;
  model: { state: ModelState; detail: string } | null;
  /** Delete everything asked the run to stop. */
  stopped: boolean;
}

/** `search index|rebuild --json`, read; null when it is not that answer. */
export function readIndexRun(value: unknown): IndexRunView | null {
  if (!isRecord(value) || typeof value.ran !== 'boolean') return null;
  const model = isRecord(value.model) ? value.model : null;
  return {
    ran: value.ran,
    busy: value.busy === true,
    taken: count(value.taken),
    embedded: count(value.embedded),
    pending: count(value.pending),
    pruned: count(value.pruned),
    model:
      model === null
        ? null
        : { state: oneOf(model.state, MODEL_STATES, 'unexpected'), detail: text(model.detail) ?? '' },
    stopped: value.stopped === true,
  };
}

export interface SettingsChangeView {
  /** False when the settings already said this, and nothing was written. */
  changed: boolean;
  on: boolean;
  accounts: SearchAccountView[];
  model: { address: string; name: string } | null;
  /** Kept messages deleted at once: an account no longer kept loses its rows now. */
  deleted: number;
  /** What the person runs next: `ollama pull <model>` for a model this machine may not have. */
  next: string | null;
}

/** What `search on|off|accounts|model --json` answers; null when it is not that answer. */
export function readSettingsChange(value: unknown): SettingsChangeView | null {
  if (!isRecord(value) || typeof value.on !== 'boolean') return null;
  const model = isRecord(value.model) && text(value.model.name) !== null ? value.model : null;
  return {
    changed: value.changed !== false,
    on: value.on,
    accounts: Array.isArray(value.accounts) ? value.accounts.flatMap((each) => accountOf(each) ?? []) : [],
    model: model === null ? null : { address: text(model.address) ?? '', name: model.name as string },
    deleted: count(value.deleted),
    next: text(value.next),
  };
}

/** What `search delete --all --confirm --json` answers; null when it is not that answer. */
export function readDeleteResult(value: unknown): { files: number; keyDeleted: boolean } | null {
  if (!isRecord(value) || typeof value.keyDeleted !== 'boolean') return null;
  return { files: count(value.files), keyDeleted: value.keyDeleted };
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a question cannot be asked as it is, or null when it can: the grammar Rust checks it against again (§8). */
export function questionProblem(text: string): string | null {
  if (text.trim() === '') return SEARCH_COPY.empty;
  if ([...text].length > SEARCH_QUERY_LIMIT) return SEARCH_COPY.tooLong(SEARCH_QUERY_LIMIT);
  if ([...text].some(refusedInSearchText)) return SEARCH_COPY.refusedCharacter;
  return isSearchQuery(text) ? null : SEARCH_COPY.empty;
}

/** How far back a search looks: everything kept, the last 7 days, or today. */
export type SearchWindow = 'kept' | 'week' | 'today';

const DAY = 24 * 60 * 60 * 1000;

/** The window's start, in milliseconds: none for everything kept; the person's own midnight for today. */
export function windowSince(window: SearchWindow, now: Date = new Date()): number | undefined {
  if (window === 'week') return now.getTime() - 7 * DAY;
  if (window === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return undefined;
}

/** What an envelope holds, as plain text, for comparing — never for showing: a screen shows it through `OutsideText`. */
export function envelopedText(value: string): string {
  return splitEnvelopes(value)
    .map((part) => part.text)
    .join('');
}

/** A handle in a person's words: Gmail and its address, or Slack and its user in its workspace. */
export function handleParts(handle: string): { channel: SearchChannelWord | null; shown: string } {
  if (handle.startsWith('email:')) return { channel: 'gmail', shown: handle.slice('email:'.length) };
  if (handle.startsWith('slack:')) {
    const [team = '', user = ''] = handle.slice('slack:'.length).split('/');
    return { channel: 'slack', shown: `${user} in ${team}` };
  }
  return { channel: null, shown: handle };
}

/** A string case-folded as core folds a query: lower case, no accents. */
export function folded(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

const wordsOf = (value: string): string[] => folded(value).match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The people a search's words name (§6, "a person chip"): each whose label, or latest name, is a run of the words,
 * case-folded. A suggestion, never an identity claim: anyone can take a name.
 */
export function namedPeople(query: string, people: readonly PersonView[]): PersonView[] {
  const asked = wordsOf(query);
  if (asked.length === 0) return [];
  const contains = (name: string): boolean => {
    const wanted = wordsOf(name);
    if (wanted.length === 0 || wanted.length > asked.length) return false;
    for (let start = 0; start + wanted.length <= asked.length; start += 1) {
      if (wanted.every((word, index) => asked[start + index] === word)) return true;
    }
    return false;
  };
  return people.filter(
    (person) =>
      (person.label !== null && contains(person.label)) ||
      (person.name !== null && contains(envelopedText(person.name))),
  );
}

/** How a hit was found: by its words, by its meaning, or both. */
export function foundBy(rank: SearchHitView['rank']): 'both' | 'words' | 'meaning' | null {
  if (rank.words !== null && rank.meaning !== null) return 'both';
  if (rank.words !== null) return 'words';
  if (rank.meaning !== null) return 'meaning';
  return null;
}

// ── The join ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The most ids one `activity items --ids` names (`allowlist.rs`, `ITEM_IDS_MAX`). */
export const ITEM_IDS_MAX = 50;

/** How many `message show` reads run at once, for the hits the event service saw. */
const SHOW_AT_ONCE = 4;

/** A message the join reads: its id, and its event when the event service saw it. */
export interface ToJoin {
  sourceId: string;
  eventId: string | null;
}

export interface JoinedStories {
  /** Each message's joined story, by its source id; none for a message nothing recorded. */
  bySource: ReadonlyMap<string, JoinedMessage>;
  /** What the join read: the activity, and the events. */
  activity: ActivityItems;
  events: MessageEvent[];
  /** Why a read failed, when one did. */
  problem: string | null;
}

async function itemsFor(
  bridge: Bridge,
  since: Millis,
  ids: readonly string[],
): Promise<{ items: ActivityItems; problem: string | null }> {
  const wanted = [...new Set(ids)].filter(isItemId).slice(0, ITEM_IDS_MAX);
  if (wanted.length === 0) return { items: new Map(), problem: null };
  try {
    const result = await bridge.cli({ kind: 'activityItems', since, ids: wanted });
    if (result.status === 'ok') {
      const items = readActivityItems(result.data);
      return items === null
        ? { items: new Map(), problem: 'What agents did could not be read.' }
        : { items, problem: null };
    }
    return { items: new Map(), problem: result.status === 'failed' ? result.message : null };
  } catch (error) {
    return { items: new Map(), problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The drafts a Gmail message's replies were made in: their sends are listed under the draft, not the message. */
function draftsOf(items: ActivityItems, ids: ReadonlySet<string>): string[] {
  const drafts = new Set<string>();
  for (const [itemId, lines] of items) {
    for (const line of lines as readonly ItemLine[]) {
      if (line.channel !== 'gmail' || line.replyTo === null || !ids.has(line.replyTo.messageId)) continue;
      drafts.add(line.draftId ?? itemId);
    }
  }
  return [...drafts].filter((draft) => !ids.has(draft));
}

async function eventsFor(bridge: Bridge, eventIds: readonly string[]): Promise<MessageEvent[]> {
  const found: MessageEvent[] = [];
  const queue = [...new Set(eventIds)].filter((id) => /^[0-9a-f]{32}$/.test(id));
  const worker = async () => {
    for (let eventId = queue.shift(); eventId !== undefined; eventId = queue.shift()) {
      const call: Call = { kind: 'eventsMessageShow', eventId };
      try {
        const result = await bridge.cli(call);
        const event = result.status === 'ok' ? readMessageShow(result.data) : null;
        if (event !== null) found.push(event);
      } catch {
        // A message the event service no longer keeps, or one it cannot read: its story is the activity's alone.
      }
    }
  };
  await Promise.all(Array.from({ length: SHOW_AT_ONCE }, worker));
  return found;
}

/**
 * Each message's story, as the Messages screen joins it (S4): its activity, read with `activity items --ids` — the
 * messages, then the drafts their replies were made in, whose sends are listed under the draft — and, for a message the
 * event service saw and `withEvents` allows, its `message show`. Pure but for the reads: the same answers give the same
 * stories.
 */
export async function joinStories(
  bridge: Bridge,
  messages: readonly ToJoin[],
  options: { since: Millis; withEvents: boolean; aliases?: ReadonlyMap<string, string> | undefined },
): Promise<JoinedStories> {
  const ids = new Set(messages.map((message) => message.sourceId));
  const first = await itemsFor(bridge, options.since, [...ids]);
  const drafts = draftsOf(first.items, ids);
  const second = drafts.length === 0 ? null : await itemsFor(bridge, options.since, drafts);
  const activity = new Map<string, readonly ItemLine[]>([...first.items, ...(second?.items ?? new Map())]);
  const events = options.withEvents
    ? await eventsFor(
        bridge,
        messages.flatMap((message) => (message.eventId === null ? [] : [message.eventId])),
      )
    : [];
  const joined = join(events, activity, { aliases: options.aliases });
  const bySource = new Map<string, JoinedMessage>();
  for (const message of joined) {
    if (message.sourceId !== null && ids.has(message.sourceId) && !bySource.has(message.sourceId)) {
      bySource.set(message.sourceId, message);
    }
  }
  return { bySource, activity, events, problem: first.problem ?? second?.problem ?? null };
}
