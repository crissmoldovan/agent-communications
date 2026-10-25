/**
 * The event service's action queue, as the Queue screen reads it (design 2026-10-25-action-queue §4.5, §7, §8): its
 * `queue list --json`, `queue counts --json` and the answers of `done`, `dismiss`, `reopen` and `clear`, read field by
 * field into the few shapes the screen shows, and what the judge said in a few words.
 *
 * Nothing here makes markup. What a sender wrote — who it is from, the subject, the first words — arrives inside the
 * untrusted-content envelope and is kept as it came, as a string the screen shows as plain text marked From outside.
 */
import { productLabel } from './components/ApprovalCard.tsx';
import { isQueueItemId, isRuleId } from './grammar.ts';
import { QUEUE_CHANNELS, type QueueChannel } from './ipc.ts';

/** The screen's three views, in its tab bar's order: what waits first (§4.5). */
export type QueueTab = 'open' | 'done' | 'dismissed';

export const QUEUE_TABS: readonly QueueTab[] = ['open', 'done', 'dismissed'];

/**
 * What the judge said of an item, read from its decision and never copied (Q3): its answer while the decision's
 * metadata lives (`answered`), that it is no longer kept (`expired`), that the person let a held decision through
 * (`released`), or that the rule asked no judge (`none`).
 */
export interface QueueJudge {
  state: 'answered' | 'expired' | 'released' | 'none';
  id: string | null;
  kind: string | null;
  model: string | null;
  /** The rule's own question: the person's words, not a sender's. */
  question: string | null;
  answer: 'yes' | 'no' | null;
  confidence: number | null;
  /** A local endpoint's score, which is no probability (§4.2). */
  uncalibrated: boolean;
}

/** One item, as `queue list` gives it. Each sender-written field is kept as it came, inside its envelope. */
export interface QueueItem {
  id: string;
  /** Whether the id is one the allow-list takes, so that Done, Dismiss and Reopen can name it. */
  actionable: boolean;
  state: QueueTab;
  stateAt: string | null;
  arrivedAt: string;
  expiresAt: string | null;
  rule: { id: string; version: number | null; name: string | null };
  channel: string;
  account: { id: string; alias: string };
  from: { name: string | null; address: string | null };
  subject: string | null;
  text: string | null;
  link: { kind: 'gmail' | 'slack'; url: string } | null;
  judge: QueueJudge;
}

export interface QueueListView {
  items: QueueItem[];
  /** More items matched than the list holds. */
  more: boolean;
}

/** `queue counts`: how many items are in each state, and each rule's open count. Content-free. */
export interface QueueCounts {
  open: number;
  done: number;
  dismissed: number;
  byRule: { ruleId: string; name: string | null; open: number }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const JUDGE_STATES: readonly QueueJudge['state'][] = ['answered', 'expired', 'released', 'none'];

function judgeOf(value: unknown): QueueJudge {
  const given = isRecord(value) ? value : {};
  const state = JUDGE_STATES.find((each) => each === given.state) ?? 'none';
  const answer = given.answer === 'yes' || given.answer === 'no' ? given.answer : null;
  return {
    state,
    id: text(given.id),
    kind: text(given.kind),
    model: text(given.model),
    question: text(given.question),
    answer,
    confidence: finite(given.confidence),
    uncalibrated: given.uncalibrated === true,
  };
}

function linkOf(value: unknown): QueueItem['link'] {
  if (!isRecord(value)) return null;
  const url = text(value.url);
  if (url === null || (value.kind !== 'gmail' && value.kind !== 'slack')) return null;
  return { kind: value.kind, url };
}

/** An item, read: null for one with no id, no state of the three or no time it arrived. */
function itemOf(value: unknown): QueueItem | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const arrivedAt = text(value.arrivedAt);
  const state = QUEUE_TABS.find((tab) => tab === value.state);
  if (id === null || arrivedAt === null || state === undefined) return null;
  const rule = isRecord(value.rule) ? value.rule : {};
  const account = isRecord(value.account) ? value.account : {};
  const from = isRecord(value.from) ? value.from : {};
  return {
    id,
    actionable: isQueueItemId(id),
    state,
    stateAt: text(value.stateAt),
    arrivedAt,
    expiresAt: text(value.expiresAt),
    rule: { id: text(rule.id) ?? '', version: whole(rule.version), name: text(rule.name) },
    channel: text(value.channel) ?? '',
    account: { id: text(account.id) ?? '', alias: text(account.alias) ?? '' },
    from: { name: text(from.name), address: text(from.address) },
    subject: text(value.subject),
    text: text(value.text),
    link: linkOf(value.link),
    judge: judgeOf(value.judge),
  };
}

/** `queue list --json`, read: null when it is not that answer at all. */
export function readQueueList(value: unknown): QueueListView | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  return { items: value.items.flatMap((each) => itemOf(each) ?? []), more: value.more === true };
}

/** `queue counts --json`, read: null when it is not that answer at all. */
export function readQueueCounts(value: unknown): QueueCounts | null {
  if (!isRecord(value)) return null;
  const open = whole(value.open);
  const done = whole(value.done);
  const dismissed = whole(value.dismissed);
  if (open === null || done === null || dismissed === null) return null;
  const byRule = Array.isArray(value.byRule)
    ? value.byRule.flatMap((each) => {
        if (!isRecord(each)) return [];
        const ruleId = text(each.ruleId);
        if (ruleId === null) return [];
        return [{ ruleId, name: text(each.name), open: whole(each.open) ?? 0 }];
      })
    : [];
  return { open, done, dismissed, byRule };
}

/** `queue done|dismiss|reopen --json`, read: the item's id and its new state, or null. */
export function readStateChange(value: unknown): { id: string; state: QueueTab; stateAt: string | null } | null {
  if (!isRecord(value) || !isRecord(value.item)) return null;
  const id = text(value.item.id);
  const state = QUEUE_TABS.find((tab) => tab === (value.item as Record<string, unknown>).state);
  if (id === null || state === undefined) return null;
  return { id, state, stateAt: text(value.item.stateAt) };
}

/** `queue clear --json`, read: how many items it purged, or null. */
export function readCleared(value: unknown): number | null {
  return isRecord(value) ? whole(value.cleared) : null;
}

/**
 * Whether no rule sends to a queue: `queue counts` names no rule and holds no item. A rule that queues is named in its
 * per-rule counts even with nothing open; until one is, the screen says how to add one.
 */
export function noQueueYet(counts: QueueCounts): boolean {
  return counts.byRule.length === 0 && counts.open + counts.done + counts.dismissed === 0;
}

/** How many items a tab holds, by the counts. */
export function tabCount(counts: QueueCounts, tab: QueueTab): number {
  return counts[tab];
}

/** The rules the screen offers as a filter: those with an id the allow-list takes, by name. */
export function filterRules(counts: QueueCounts): { ruleId: string; name: string }[] {
  return counts.byRule
    .filter((rule) => isRuleId(rule.ruleId))
    .map((rule) => ({ ruleId: rule.ruleId, name: rule.name ?? rule.ruleId }));
}

/** The channels the screen offers as a filter, in the order the app lists them. */
export const FILTER_CHANNELS: readonly QueueChannel[] = QUEUE_CHANNELS;

/** A channel's name on screen. */
export function queueChannelLabel(channel: string): string {
  return productLabel(channel === '' ? null : channel);
}

// ── What the judge said ────────────────────────────────────────────────────────────────────────────────────────

/** The words the judge's line says when there is no answer to show (Q3). */
export const JUDGE_WORDS = {
  expired: "The judge's answer is no longer kept",
  released: 'You let it through',
  uncalibrated: 'uncalibrated',
} as const;

/** What a judge is called on an item: by its kind, as the Judges section names them, in a word. */
function judgeName(judge: QueueJudge): string {
  switch (judge.kind) {
    case 'typesafe':
      return 'Jev';
    case 'local-endpoint':
      return 'Local model';
    case 'laya':
      return 'Laya';
    default:
      return judge.id ?? 'Judge';
  }
}

/**
 * What the judge said, in a few words (§4.5, Q3): "Jev: yes, 0.86"; ", uncalibrated" after a local endpoint's score;
 * that its answer is no longer kept; that the person let it through; or nothing, when the rule asked no judge.
 */
export function judgeWords(judge: QueueJudge): string | null {
  switch (judge.state) {
    case 'none':
      return null;
    case 'expired':
      return JUDGE_WORDS.expired;
    case 'released':
      return JUDGE_WORDS.released;
    case 'answered': {
      const answer = judge.answer === null ? `${judgeName(judge)} answered` : `${judgeName(judge)}: ${judge.answer}`;
      const confidence = judge.confidence === null ? '' : `, ${judge.confidence.toFixed(2)}`;
      return `${answer}${confidence}${judge.uncalibrated ? `, ${JUDGE_WORDS.uncalibrated}` : ''}`;
    }
  }
}

// ── Links ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Gmail on the web, and Slack's web app: the hosts a queue item's link opens on (`links.rs`). */
const GMAIL_WEB_HOST = 'mail.google.com';
const SLACK_WEB_HOST = 'app.slack.com';

/** The longest link the app opens (`links.rs`, `LINK_LIMIT`). */
const LINK_LIMIT = 2048;

/** What a link never holds as it is: printable ASCII only, and none of these, which a URL writes as `%XX`. */
const NEVER_IN_A_LINK = new Set(['"', '<', '>', '\\', '`', '{', '}']);

/** A host label: letters, digits and inner hyphens, at most 63 of them. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Whether the app may open `url` for a queue item, as Rust's `links::queue_link` decides it again before anything
 * opens, and in the same steps: `https://`, at most 2048 characters of printable ASCII with nothing a URL would have
 * encoded, a host with no user, password or port whose every label is letters, digits and inner hyphens, never
 * Google's `/url` redirect — and the host Gmail's web host, Slack's web app or one workspace's `<workspace>.slack.com`,
 * never an internationalised one.
 */
export function queueLink(url: string): boolean {
  if (url.length > LINK_LIMIT || !url.startsWith('https://')) return false;
  const rest = url.slice('https://'.length);
  for (const character of rest) {
    const code = character.charCodeAt(0);
    if (character.length !== 1 || code < 0x21 || code > 0x7e || NEVER_IN_A_LINK.has(character)) return false;
  }
  const end = rest.search(/[/?#]/);
  const host = (end === -1 ? rest : rest.slice(0, end)).toLowerCase();
  if (!host.split('.').every((label) => LABEL.test(label))) return false;
  const after = rest.slice(host.length);
  const pathEnd = after.search(/[?#]/);
  const path = (pathEnd === -1 ? after : after.slice(0, pathEnd)).toLowerCase();
  if (path === '/url' || path.startsWith('/url/')) return false;
  if (host === GMAIL_WEB_HOST || host === SLACK_WEB_HOST) return true;
  if (!host.endsWith('.slack.com')) return false;
  const workspace = host.slice(0, -'.slack.com'.length);
  return !workspace.includes('.') && !workspace.startsWith('xn--');
}

/**
 * What an item's link opens, when the app may open it: "Open in Gmail" for a Gmail link on Gmail's host, "Open in
 * Slack" for a Slack link on Slack's, each the URL exactly as checked, so what opens is what was checked. A link of one
 * kind on the other's host, or on any other host, is none.
 */
export function openableLink(link: QueueItem['link']): { label: string; url: string } | null {
  if (link === null || !queueLink(link.url)) return null;
  // `queueLink` took it, so its host is Gmail's or one of Slack's.
  const host = link.url.slice('https://'.length).split(/[/?#]/)[0]?.toLowerCase() ?? '';
  if (link.kind === 'gmail' && host === GMAIL_WEB_HOST) return { label: 'Open in Gmail', url: link.url };
  if (link.kind === 'slack' && host !== GMAIL_WEB_HOST) return { label: 'Open in Slack', url: link.url };
  return null;
}
