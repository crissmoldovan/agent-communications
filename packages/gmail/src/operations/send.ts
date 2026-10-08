import {
  type ApprovalObject,
  type ApprovalRecord,
  approveAndWaitSentence,
  type Caps,
  CommsError,
  canonicalAddress,
  domainOf,
  type Expectation,
  ensureSendEpochConfig,
  fenceOrStop,
  handoffSentence,
  LEASE_LOST_BEFORE_SEND,
  type LegacyDrainReport,
  type MessagePreview,
  newBoundary,
  ownerOf,
  type PublicApprovalView,
  publicApproval,
  renderMessagePreview,
  resolveName,
  type SenderFieldWrapper,
  type SendPolicy,
  type StoredApproval,
  sendEpochOf,
  stricterPolicy,
  type TaintAggregate,
  withApproval,
  withSendingLease,
} from '@agentcomms/core';
import type { GmailContext, ResolvedInbox } from '../context.ts';
import { analyseDraft, type DraftAnalysis, type Unsendable, unsendable } from '../domain/outbound.ts';
import { addressField, domainField, type FieldEnvelope, filenameField, wrapField } from '../domain/untrusted-fields.ts';
import { sendCertainlyRefused, sendThrottleOf, throttledRefusal } from '../gmail-api/errors.ts';
import { type GmailTransport, providerId } from '../gmail-api/transport.ts';
import type { HistoryResult } from './history-cache.ts';
import { type UnsentSection, unsentSection } from './unsent.ts';

/**
 * The send gate: prepare → approve → execute.
 *
 * Everything here exists to make one guarantee true — **nothing leaves this mailbox that a person has not seen in the
 * form it will arrive in.** Prepare reads the draft, refuses it outright if an agent could not have written it,
 * computes a digest over everything a recipient would see, and writes an approval record bound to that digest and to
 * the draft's message id, which Gmail changes on every save. Approval happens in the chat (policy `chat`), or through
 * a channel the model cannot answer (policy `confirm`). Execute re-reads the draft, checks it against the record one
 * last time, and only then calls Gmail — once, never retried.
 *
 * **This is the only module in the package that may cause mail to leave.** A test asserts that `transport.sendDraft`
 * is called from here and nowhere else, and the transport itself refuses any request to a send endpoint that is not
 * inside that one call.
 */

export interface SendPreparation {
  approvalId: string;
  inbox: string;
  draftId: string;
  /** What the person must read before approving. Show it verbatim; do not summarise it. */
  preview: string;
  policy: SendPolicy;
  /** The stricter of the live policy and anything risk escalation raised. */
  effectivePolicy: SendPolicy;
  riskFlags: string[];
  /**
   * Why each recipient that raised `recipient-tainted` raised it (design 2026-10-05 §D4): the address and its domain
   * as untrusted fields, and the stored aggregate's facts in this package's own words. Empty when none did.
   */
  taint: RecipientTaint[];
  /**
   * Present when this mailbox's correspondent domains could not be known — its cache untrustworthy and the scan that
   * would replace it failed, or the scan not committed to it — so a lookalike could not be ruled out (§D4).
   */
  correspondentHistory?: CorrespondentHistory | undefined;
  expect: Expectation;
  digest: string;
  expiresAt: string;
  /** What has to happen next, in the words to repeat to the user. */
  nextStep: string;
  /**
   * Where the approval stands (design 2026-10-05 §D8): pending, on its route, and whether a yes in the chat sends it
   * (`claimable`) or it waits for a person outside the chat.
   */
  approval: ApprovalObject;
  /**
   * What became of the approvals an earlier release prepared, by id, when this call was one that retired them
   * (`ensureSendEpochConfig`). Absent otherwise.
   */
  legacyDrain?: LegacyDrainReport | undefined;
}

/** `send list` and `gmail_send_list`: every approval as its public object, and the unsent section. */
export interface ApprovalList {
  approvals: Array<PublicApprovalView & { inbox: string | null }>;
  unsent: UnsentSection;
}

/** What a send that Gmail accepted without naming the message says, exactly (design 2026-10-05 §D8). */
export const SENT_WITHOUT_ID = 'sent; the provider returned no id';

export interface SendResult {
  inbox: string;
  approvalId: string;
  draftId: string;
  /**
   * The message Gmail filed, by its id — absent when Gmail accepted the send without naming it: then nothing records it
   * as used, and the approval reads `sending`, then `unknown` (§D8). Never an empty string.
   */
  sentMessageId?: string | undefined;
  /** What happened, in the words to repeat: "sent, message id …", or exactly {@link SENT_WITHOUT_ID}. */
  said: string;
  threadId: string | undefined;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** What Gmail says about the message it filed in Sent, read back after the send. */
  verified: { threadId: string | undefined; labelIds: string[] } | null;
  /** Bookkeeping that could not be written after Gmail confirmed the send. */
  note?: string | undefined;
  /**
   * Where the approval stands now that Gmail has the message (design 2026-10-05 §D8): `used`, with the message id —
   * or still `sending`, when that could not be recorded, which later reads as `unknown`. Never a `used` invented.
   */
  approval: ApprovalObject;
  /**
   * What became of the approvals an earlier release prepared, by id, when this call was one that retired them
   * (`ensureSendEpochConfig`). Absent otherwise.
   */
  legacyDrain?: LegacyDrainReport | undefined;
}

const LOOKALIKE_DISTANCE = 2;

/** Levenshtein distance, capped: only used to notice that `partner.test` and `partners.test` are neighbours. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > LOOKALIKE_DISTANCE) return LOOKALIKE_DISTANCE + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] ?? LOOKALIKE_DISTANCE + 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the failure that stopped the send visible, adding only what could not be settled afterwards — and where the
 * approval stands now that it is settled (decision 8), whatever the failure said of it before.
 */
function noSendError(
  error: unknown,
  unrecorded: readonly string[],
  approval: ApprovalObject,
  // Gmail's own refusal of the send: certain, and said as such — nothing was sent (§D2).
  sayNothingSent = false,
): CommsError {
  const original =
    error instanceof CommsError ? error : new CommsError('UNEXPECTED', messageOf(error), { cause: error });
  const hint = [original.hint, ...unrecorded].filter((part) => part !== undefined);
  const message =
    sayNothingSent && !original.message.startsWith('nothing was sent')
      ? `nothing was sent: ${original.message}`
      : original.message;
  return new CommsError(original.code, message, {
    ...(hint.length === 0 ? {} : { hint: hint.join(' ') }),
    details: { ...original.details, approval },
    cause: error,
  });
}

/**
 * Where a claimed send's approval stands now, read under its lock — or, when that read fails, what `fallback` said: a
 * report never turns into a failure of the send it reports on.
 */
async function approvalNow(
  context: GmailContext,
  approvalId: string,
  owner: string,
  fallback: ApprovalObject,
): Promise<ApprovalObject> {
  try {
    return (await context.core.approvals.inspect(approvalId, { kind: 'send', owner })).outcome.approval;
  } catch {
    return fallback;
  }
}

/**
 * Settles a failure known to have happened before Gmail sent anything, without one failed write skipping another.
 *
 * `recorded` is for a failure whose approval is settled already — the fence's, which records `lease-lost-before-send`
 * itself: the slot is given back and the audit written, and the refusal says where the approval stands now.
 */
async function recordNoSend(
  context: GmailContext,
  options: { alias: string; inboxId: string; approvalId: string; draftId: string },
  // The claim's own token, kept apart from what is audited: only the call that claimed records the outcome.
  claimToken: string,
  // Where the approval stood when it was claimed: what the refusal says if its failure cannot be recorded.
  claimed: ApprovalObject,
  error: unknown,
  how: { sayNothingSent?: boolean; recorded?: string } = {},
): Promise<CommsError> {
  const unrecorded: string[] = [];
  const said = how.recorded ?? messageOf(error);
  let settled = claimed;
  try {
    await context.core.ledger.release(options.inboxId, options.approvalId);
  } catch (failure) {
    unrecorded.push(`the capacity slot could not be released (${messageOf(failure)})`);
  }
  if (how.recorded === undefined) {
    try {
      settled = await context.core.approvals.approvalOf(
        await context.core.approvals.complete(options.approvalId, claimToken, { error: said }),
      );
    } catch (failure) {
      unrecorded.push(`the approval could not be marked failed (${messageOf(failure)})`);
    }
  } else {
    settled = await approvalNow(context, options.approvalId, options.inboxId, claimed);
  }
  try {
    await context.core.audit.append({
      inboxId: options.inboxId,
      alias: options.alias,
      operation: 'send.execute',
      outcome: 'failed',
      surface: context.surface,
      ids: { approvalIds: [options.approvalId], draftIds: [options.draftId] },
      reason: [said, ...unrecorded].join('; '),
    });
  } catch (failure) {
    unrecorded.push(`the audit log could not record the failure (${messageOf(failure)})`);
  }
  return noSendError(error, unrecorded, settled, how.sayNothingSent);
}

function capsFor(defaults: { sendCaps: { perHour: number; perDay: number } }): Caps {
  return { perHour: defaults.sendCaps.perHour, perDay: defaults.sendCaps.perDay };
}

/** Every address this mailbox can be: its own, plus each verified send-as. Never tainted, never "first-time". */
async function ownAddresses(transport: GmailTransport, inbox: ResolvedInbox): Promise<Set<string>> {
  const own = new Set<string>([canonicalAddress(inbox.inbox.email)]);
  try {
    for (const entry of await transport.listSendAs()) own.add(canonicalAddress(entry.sendAsEmail));
  } catch {
    // A mailbox that will not list its send-as addresses still has its own; this only widens the exemption.
  }
  return own;
}

/**
 * Where the correspondent domains came from, when it was not a fresh scan or a fresh cache entry: the cache could not
 * be trusted and its recovery scan failed, or the scan's observation could not be committed (design 2026-10-05 §D4).
 * Either keeps the lookalike check's escalation, rather than concluding there is no lookalike.
 */
export type CorrespondentHistory = 'cache-malformed' | 'cache-write-failed';

/**
 * The domains this mailbox has written to recently.
 *
 * From the last two hundred sent messages — one list, and at most two hundred metadata reads — or from the shared cache
 * while a scan's answer is fresh, so a prepare and the terminal approval of one draft scan once between them. It is the
 * yardstick a lookalike is measured against, so it has to come from the mailbox's history rather than from the draft
 * under examination.
 */
async function correspondentDomains(
  context: GmailContext,
  transport: GmailTransport,
  inboxId: string,
): Promise<{ domains: Set<string>; doubt: CorrespondentHistory | undefined }> {
  const cached = await context.historyCache.readCorrespondents(inboxId);
  if (cached.state === 'ok' && cached.value !== null) return { domains: new Set(cached.value), doubt: undefined };
  const domains = new Set<string>();
  let scanned = true;
  try {
    const page = await transport.listMessages({ query: 'in:sent', maxResults: 200 });
    for (const { id } of page.ids.slice(0, 200)) {
      const message = await transport.getMessageMetadata(id);
      for (const header of message.payload?.headers ?? []) {
        if (!/^(to|cc|bcc)$/i.test(header.name ?? '')) continue;
        for (const entry of (header.value ?? '').split(',')) {
          const domain = domainOf(canonicalAddress(entry.replace(/^.*<|>.*$/g, '').trim()));
          if (domain) domains.add(domain);
        }
      }
    }
  } catch {
    // A mailbox that will not answer leaves the set as far as it got, which fires fewer lookalike flags — a quieter
    // preview, not a wrong one, and every other check still runs. Not an observation: nothing is cached.
    scanned = false;
  }
  // A cache that could not be trusted, and no scan to put in its place: no conclusion that there is no lookalike.
  if (!scanned) return { domains, doubt: cached.state === 'malformed' ? 'cache-malformed' : undefined };
  try {
    await context.historyCache.recordCorrespondents(inboxId, [...domains]);
  } catch {
    return { domains, doubt: 'cache-write-failed' };
  }
  return { domains, doubt: undefined };
}

/**
 * How the check of this mailbox's prior sends to one address ended (design 2026-10-05 §D4): what was found — live, or
 * from the shared cache while fresh — or that the cache could not be trusted (`cache-malformed`) or what was found
 * could not be committed to it (`cache-write-failed`). Anything but `written` is treated as not written.
 */
export type HistoryCheck = HistoryResult | 'cache-malformed' | 'cache-write-failed';

/** The most Gmail history requests one recipient analysis starts, across all its recipients (§D4). */
export const HISTORY_BUDGET = 200;

/** The most hits one address's check reads before it answers "not written" (§D4). */
export const HISTORY_HITS = 50;

/** What each unchecked answer says in a preview: never turned into a correspondence exemption (§D4). */
const HISTORY_QUALIFICATION: Partial<Record<HistoryCheck, string>> = {
  'budget-exhausted':
    'prior-send history was not fully checked (the 200-read budget was reached); treated as not previously written.',
  'provider-error': 'prior-send history could not be checked; treated as not previously written.',
  'cache-malformed': 'prior-send history could not be read from its cache; treated as not previously written.',
  'cache-write-failed': 'prior-send history was checked but could not be recorded; treated as not previously written.',
};

/** What a removed mailbox is called where a stored aggregate names it: its id is software data, and means nothing. */
const REMOVED_MAILBOX = 'a mailbox no longer connected';

/** One operation's history requests: each `listMessages` and `getMessageMetadata` takes one before it starts. */
interface HistoryBudget {
  remaining: number;
}

/** The canonical recipients of a sent message, from its To, Cc and Bcc headers. */
function recipientsOf(message: {
  payload?: { headers?: Array<{ name?: string | null; value?: string | null }> | null } | null;
}): string[] {
  return (message.payload?.headers ?? [])
    .filter((header) => /^(to|cc|bcc)$/i.test(header.name ?? ''))
    .flatMap((header) => (header.value ?? '').split(','))
    .map((value) => canonicalAddress(value.replace(/^.*<|>.*$/g, '').trim()));
}

/**
 * Has this mailbox written to this exact address before — within both bounds (design 2026-10-05 §D4)?
 *
 * Gmail's search is fuzzy — it matches display names and partial addresses — so it asks for the address in To, Cc and
 * Bcc, pages through at most fifty hits, and confirms each by comparing its parsed recipients: the headers comma-split
 * and display-name wrappers regex-stripped before an exact canonical comparison, which is deliberately not RFC
 * mailbox-list parsing. A false "we have written to them" would remove exactly the warning a tainted or first-time
 * recipient is there to raise, so every doubt answers no: fifty fuzzy hits with the exact one fifty-first, a budget
 * spent (`budget`, shared by every recipient of one operation, is taken before each request starts), or a provider
 * error.
 */
async function hasWrittenTo(
  transport: GmailTransport,
  canonical: string,
  budget: HistoryBudget,
): Promise<HistoryResult> {
  const query = `in:sent {to:${canonical} cc:${canonical} bcc:${canonical}}`;
  let checked = 0;
  let pageToken: string | undefined;
  try {
    do {
      if (budget.remaining <= 0) return 'budget-exhausted';
      budget.remaining -= 1;
      const page = await transport.listMessages({ query, maxResults: HISTORY_HITS - checked, pageToken });
      for (const { id } of page.ids) {
        if (checked >= HISTORY_HITS) break;
        if (!id) continue;
        if (budget.remaining <= 0) return 'budget-exhausted';
        budget.remaining -= 1;
        const message = await transport.getMessageMetadata(id);
        checked += 1;
        if (recipientsOf(message).includes(canonical)) return 'written';
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined && checked < HISTORY_HITS);
    return 'not-written';
  } catch {
    return 'provider-error';
  }
}

interface RecipientFacts {
  /** As the draft has it: what the preview shows. */
  address: string;
  canonical: string;
  domain: string;
  external: boolean;
  firstTime: boolean;
  /** What the taint store matched, by D4's formula — the exact address, which wins, or its domain alone. */
  match: 'address' | 'domain' | null;
  tainted: boolean;
  /** The stored aggregate's facts, for a tainted recipient: trusted words, never the address or domain. */
  explanation: string[];
  /** `own` for this mailbox's own address, which is never checked. */
  historyCheck: HistoryCheck | 'own';
  lookalikeOf: string | null;
  note: string;
}

/**
 * Why a recipient raised `recipient-tainted`, as a result carries it (design 2026-10-05 §D4). The address and domain
 * are a sender's — through `addressField` and `domainField`, never in trusted prose; `facts` are this package's words
 * about the stored aggregate — the mailboxes by name, a date, a template — and say only what the store holds.
 */
export interface RecipientTaint {
  address: string;
  domain: string;
  match: 'address' | 'domain';
  facts: string[];
  historyCheck: HistoryCheck;
}

/**
 * D4's separate statements about one stored aggregate. Never one sighting: the store keeps the newest time, the
 * strongest source and the union of mailboxes independently, so they are said independently.
 */
function explain(aggregate: TaintAggregate | undefined, names: ReadonlyMap<string, string>): string[] {
  if (aggregate === undefined) return [];
  const known = [...new Set(aggregate.inboxIds.filter((id) => names.has(id)).map((id) => names.get(id) as string))];
  const removed = new Set(aggregate.inboxIds.filter((id) => !names.has(id))).size;
  const mailboxes = [
    ...known,
    ...(removed === 0 ? [] : [removed === 1 ? REMOVED_MAILBOX : `${removed} mailboxes no longer connected`]),
  ];
  return [
    `seen in mail read in these mailboxes within the last seven days: ${mailboxes.join(', ')}`,
    `most recently on ${aggregate.at.slice(0, 10)}`,
    ...(aggregate.source === 'header' ? ['seen at least once in a header'] : []),
  ];
}

/**
 * What is known about each recipient, and what it means for the policy.
 *
 * Risk escalation exists because `chat` trusts the agent to show the preview: a send to somebody the user has never
 * written to, at an address that arrived in a message we read this week, is exactly the shape of an exfiltration, and
 * it is worth taking out of the agent's hands entirely. D4's formula decides it:
 * `(seen.address || (seen.domain && external)) && !written` — an exact stored address escalates internal or external,
 * a domain match only for a recipient external to this mailbox, and a send this mailbox made to the exact address,
 * found within both bounds, suppresses either.
 */
async function studyRecipients(
  context: GmailContext,
  transport: GmailTransport,
  inbox: ResolvedInbox,
  analysis: DraftAnalysis,
): Promise<{ facts: RecipientFacts[]; flags: string[]; correspondentHistory: CorrespondentHistory | undefined }> {
  const own = await ownAddresses(transport, inbox);
  const internal = new Set(inbox.inbox.internalDomains.map((domain) => domain.toLowerCase()));
  // Each recipient once, in a deterministic order: To, then Cc, then Bcc, by canonical address.
  const everyone = new Map<string, string>();
  for (const address of [...analysis.to, ...analysis.cc, ...analysis.bcc]) {
    const canonical = canonicalAddress(address);
    if (!everyone.has(canonical)) everyone.set(canonical, address);
  }
  // The domains this mailbox actually corresponds with, read from Sent rather than assembled from this draft's own
  // recipients. Built the latter way, a message addressed *only* to a lookalike had nothing to compare against and
  // the check never fired — which is precisely the message the check exists for.
  const correspondents = await correspondentDomains(context, transport, inbox.inbox.id);
  const knownDomains = correspondents.domains;
  for (const address of own) {
    const domain = domainOf(address);
    if (domain) knownDomains.add(domain);
  }
  for (const domain of internal) knownDomains.add(domain);
  const names = new Map(Object.entries((await context.config()).inboxes).map(([alias, entry]) => [entry.id, alias]));
  const histories = await priorSends(context, transport, inbox.inbox.id, [...everyone.keys()], own);
  const facts: RecipientFacts[] = [];

  for (const [canonical, address] of everyone) {
    const domain = domainOf(canonical) ?? '';
    const external = !own.has(canonical) && !internal.has(domain);
    const seen = await context.core.taint.check(canonical);
    const historyCheck = histories.get(canonical) ?? 'own';
    const written = historyCheck === 'own' || historyCheck === 'written';
    // A domain in the store counts only for a recipient external to this mailbox (the store already leaves public
    // providers' domains out); an exact address counts either way, and wins the explanation.
    const match = seen.address ? 'address' : seen.domain && external ? 'domain' : null;
    const tainted = match !== null && !written;
    facts.push({
      address,
      canonical,
      domain,
      external,
      firstTime: external && !written,
      match,
      // A tainted address that we have written to before is somebody we already correspond with.
      tainted,
      explanation: tainted ? explain(match === 'address' ? seen.addressSeen : seen.domainSeen, names) : [],
      historyCheck,
      lookalikeOf: null,
      note: '',
    });
  }

  for (const fact of facts) {
    if (!fact.firstTime) continue;
    for (const known of knownDomains) {
      if (known !== fact.domain && distance(known, fact.domain) <= LOOKALIKE_DISTANCE) {
        fact.lookalikeOf = known;
        break;
      }
    }
  }

  for (const fact of facts) {
    // An unchecked history is said wherever its answer mattered: for an external recipient, or an exact sighting.
    const qualification =
      fact.historyCheck === 'own' || !(fact.external || fact.match === 'address')
        ? undefined
        : HISTORY_QUALIFICATION[fact.historyCheck];
    fact.note = [
      fact.external ? 'EXTERNAL' : 'internal',
      fact.firstTime ? 'FIRST-TIME' : '',
      fact.tainted
        ? `${fact.match === 'address' ? 'ADDRESS' : 'DOMAIN'} SEEN IN MAIL YOU READ (${fact.explanation.join('; ')})`
        : '',
      fact.lookalikeOf ? `LOOKS LIKE ${fact.lookalikeOf}` : '',
      qualification ?? '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  const flags: string[] = [];
  if (facts.some((fact) => fact.tainted)) flags.push('recipient-tainted');
  if (analysis.attachments.length > 0 && facts.some((fact) => fact.firstTime)) {
    flags.push('attachment-to-first-time-recipient');
  }
  if (facts.some((fact) => fact.lookalikeOf)) flags.push('lookalike-domain');
  // Correspondents that could not be known for a first-time recipient: a lookalike cannot be ruled out (§D4).
  const correspondentHistory = correspondents.doubt;
  if (correspondentHistory !== undefined && facts.some((fact) => fact.firstTime)) flags.push('lookalike-unchecked');
  return { facts, flags, correspondentHistory };
}

/**
 * Every recipient's prior-send answer, in order: from the shared cache while fresh — which costs nothing — and live,
 * within one budget of 200 requests, for the rest; then what was found live, committed to the cache in one locked
 * change (design 2026-10-05 §D4).
 *
 * Two doubts are never turned into "written". A cache file that cannot be trusted answers every address
 * `cache-malformed` — not written, and nothing asked of Gmail — and is replaced by a valid write. An observation that
 * could not be committed is `cache-write-failed`: whatever it found, it suppresses nothing.
 */
async function priorSends(
  context: GmailContext,
  transport: GmailTransport,
  inboxId: string,
  canonicals: readonly string[],
  own: ReadonlySet<string>,
): Promise<Map<string, HistoryCheck>> {
  const others = canonicals.filter((canonical) => !own.has(canonical));
  const answers = new Map<string, HistoryCheck>();
  const cached = await context.historyCache.readAddresses(inboxId, others);
  if (cached.state === 'malformed') {
    for (const canonical of others) answers.set(canonical, 'cache-malformed');
    // Replaced by a valid locked write, with nothing in it this operation could vouch for.
    await context.historyCache.recordAddresses(inboxId, new Map()).catch(() => undefined);
    return answers;
  }
  const budget: HistoryBudget = { remaining: HISTORY_BUDGET };
  const observed = new Map<string, HistoryResult>();
  for (const canonical of others) {
    const hit = cached.value.get(canonical);
    if (hit !== undefined) {
      answers.set(canonical, hit.result);
      continue;
    }
    const result = await hasWrittenTo(transport, canonical, budget);
    observed.set(canonical, result);
    answers.set(canonical, result);
  }
  if (observed.size > 0) {
    try {
      await context.historyCache.recordAddresses(inboxId, observed);
    } catch {
      for (const canonical of observed.keys()) answers.set(canonical, 'cache-write-failed');
    }
  }
  return answers;
}

/** The tainted recipients' explanations, the sender's parts through this package's field helpers (§D4). */
function taintOf(facts: readonly RecipientFacts[], envelope: FieldEnvelope): RecipientTaint[] {
  return facts.flatMap((fact) =>
    fact.tainted && fact.match !== null && fact.historyCheck !== 'own'
      ? [
          {
            address: addressField(fact.canonical, 'recipient', envelope),
            domain: domainField(fact.domain, 'recipient-domain', envelope),
            match: fact.match,
            facts: fact.explanation,
            historyCheck: fact.historyCheck,
          },
        ]
      : [],
  );
}

function expectationOf(analysis: DraftAnalysis): Expectation {
  return { to: analysis.to, cc: analysis.cc, bcc: analysis.bcc, subject: analysis.subject };
}

/** Reads the draft and everything the approval will be bound to. Used by prepare and again by execute. */
async function readDraft(
  context: GmailContext,
  alias: string,
  draftId: string,
): Promise<{ analysis: DraftAnalysis; draftMessageId: string; refusals: Unsendable[] }> {
  const transport = await context.transport(alias);
  const draft = await transport.getDraft(draftId);
  if (!draft.message?.id) {
    throw new CommsError('NOT_FOUND', `there is no draft ${draftId} in this mailbox`, {
      hint: handoffSentence(
        context.handoffs.own(['draft', 'list', '--inbox', alias]),
        (command) => `List them with ${command}.`,
      ),
    });
  }
  const sendAs = await transport.listSendAs().catch(() => []);
  const { analysis, refusals } = await analyseDraft({
    message: draft.message,
    threadId: draft.message.threadId ?? undefined,
    sendAs,
    fetchAttachment: (attachmentId) => transport.getAttachment(draft.message?.id ?? '', attachmentId),
  });
  return { analysis, draftMessageId: draft.message.id, refusals };
}

function previewFor(options: {
  analysis: DraftAnalysis;
  facts: RecipientFacts[];
  record: ApprovalRecord;
  alias: string;
  effectivePolicy: SendPolicy;
  /** The risk flags this look raised: one the preview says in words of its own. */
  flags?: readonly string[] | undefined;
}): string {
  const { analysis, facts, record, alias } = options;
  // Every way the draft writes a recipient carries that recipient's note: the note is this package's words alone.
  const byCanonical = new Map(facts.map((fact) => [fact.canonical, fact.note]));
  const notes: Record<string, string> = {};
  for (const address of [...analysis.to, ...analysis.cc, ...analysis.bcc]) {
    const note = byCanonical.get(canonicalAddress(address));
    if (note) notes[address] = note;
  }
  const warnings: string[] = [];
  if (analysis.signatureResources.length > 0) {
    warnings.push(`signature loads ${analysis.signatureResources.length} image(s) from the internet when opened`);
  }
  if (analysis.bcc.length > 0) {
    warnings.push(`${analysis.bcc.length} blind recipient(s) — the others will not see them`);
  }
  if (options.flags?.includes('lookalike-unchecked')) {
    warnings.push(
      'the domains this mailbox writes to could not be read, so a lookalike recipient domain could not be ruled out',
    );
  }
  const preview: MessagePreview = {
    recipients: {
      from: analysis.from,
      to: analysis.to,
      cc: analysis.cc,
      bcc: analysis.bcc,
      // Only when it points somewhere else: a Reply-To equal to From is noise, and noise in a preview is what
      // teaches people to skim it.
      replyTo: analysis.replyTo.filter((address) => canonicalAddress(address) !== canonicalAddress(analysis.from)),
    },
    subject: analysis.subject,
    body: analysis.text,
    attachments: analysis.attachments,
    context: {
      inbox: alias,
      approvalId: record.approvalId,
      draftId: record.draftId,
      note: 'nothing has been sent',
    },
    recipientNotes: notes,
    thread: analysis.threadId ? `reply in conversation ${analysis.threadId}` : undefined,
    links: analysis.links,
    warnings,
    policy:
      options.effectivePolicy === 'confirm'
        ? 'Policy: confirm — this send needs approval outside the chat before it can go.'
        : 'Policy: chat — send only after the user approves this exact preview.',
  };
  return renderMessagePreview(preview);
}

/**
 * Step one. Reads the draft, refuses it if an agent could not have written it, and records an approval bound to this
 * exact content. Nothing is sent, and preparing twice is free: each prepare is its own record.
 */
export async function prepareSend(context: GmailContext, alias: string, draftId: string): Promise<SendPreparation> {
  // First: the configuration this send's epoch is read from is version 3, and an earlier release's records are retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const config = await context.config();
  const livePolicy: SendPolicy = resolved.inbox.sendPolicy ?? config.defaults.sendPolicy;
  if (livePolicy === 'never') {
    throw new CommsError('POLICY_NEVER', `sending from ${alias} is turned off (policy: never)`, {
      hint: handoffSentence(
        context.handoffs.own(['inbox', 'policy', alias, '--send', 'confirm']),
        (command) => `The draft is in Gmail; send it from there, or change the policy with ${command} in a terminal.`,
        { instead: 'The draft is in Gmail; send it from there.' },
      ),
    });
  }

  const transport = await context.transport(alias);
  const { analysis, draftMessageId, refusals } = await readDraft(context, alias, draftId);
  if (refusals.length > 0) throw unsendable(refusals);
  if (analysis.to.length === 0 && analysis.cc.length === 0 && analysis.bcc.length === 0) {
    throw new CommsError('BAD_DATA', 'this draft has no recipients', { hint: 'Add them and prepare the send again.' });
  }

  const { facts, flags, correspondentHistory } = config.defaults.riskEscalation
    ? await studyRecipients(context, transport, resolved, analysis)
    : { facts: [], flags: [], correspondentHistory: undefined };
  const requiredPolicy: SendPolicy = flags.length > 0 ? 'confirm' : 'chat';
  const effectivePolicy = stricterPolicy(livePolicy, requiredPolicy);

  const record = await context.core.approvals.create({
    channel: 'gmail',
    inboxId: resolved.inbox.id,
    inboxSub: resolved.inbox.sub,
    draftId,
    draftMessageId,
    contentDigest: analysis.digest,
    sendEpoch: sendEpochOf(config, resolved.inbox.id),
    policy: livePolicy,
    requiredPolicy,
    riskFlags: flags,
    expect: expectationOf(analysis),
  });

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'send.prepare',
    outcome: 'ok',
    surface: context.surface,
    ids: { draftIds: [draftId], messageIds: [draftMessageId], approvalIds: [record.approvalId] },
    reason: flags.length > 0 ? `escalated: ${flags.join(', ')}` : `policy ${effectivePolicy}`,
  });

  return {
    approvalId: record.approvalId,
    inbox: alias,
    draftId,
    preview: previewFor({ analysis, facts, record, alias, effectivePolicy, flags }),
    policy: livePolicy,
    effectivePolicy,
    riskFlags: flags,
    taint: taintOf(facts, { boundary: newBoundary(), inbox: alias, id: draftMessageId }),
    ...(correspondentHistory === undefined ? {} : { correspondentHistory }),
    expect: record.expect,
    digest: analysis.digest,
    expiresAt: record.expiresAt,
    // Not in the approval's digest: the draft is. The command is this process's own, located where it is printed.
    nextStep:
      effectivePolicy === 'confirm'
        ? confirmNextStep(context, record.approvalId)
        : 'Show the preview to the user verbatim and wait for an explicit yes. Then send it with the same approval id and the recipients and subject shown above.',
    approval: await context.core.approvals.approvalOf(record),
    ...(legacyDrain === undefined ? {} : { legacyDrain }),
  };
}

/**
 * What follows a prepare that waits for a person outside the chat (design 2026-10-05 §D5): their terminal command, and
 * the wait that learns when they have used it — `gmail_send_wait` over MCP, `send wait` at the command line — so the
 * agent never asks the person to relay it, and never prepares again.
 */
function confirmNextStep(context: GmailContext, approvalId: string): string {
  return approveAndWaitSentence(
    context.handoffs,
    context.surface,
    approvalId,
    (approve, wait) => {
      const first = `Show the preview to the user, then have them run ${approve} in a terminal`;
      const last = 'or they can send it from Gmail. You cannot approve this yourself.';
      return wait === undefined ? `${first} — ${last}` : `${first}; learn when they have with ${wait} — ${last}`;
    },
    { instead: 'Show the preview to the user; they can send it from Gmail. You cannot approve this yourself.' },
  );
}

export interface ApprovalPrompt {
  approvalId: string;
  preview: string;
  challenge: string;
  effectivePolicy: SendPolicy;
}

/**
 * Re-reads the draft, renders the preview a human is about to approve, and issues the challenge they must type back.
 *
 * The challenge is never returned to an agent: this is called by the terminal command, which prints it to a person.
 * Re-reading is the point — an approval must be for what is in the draft now, not for what was there at prepare.
 */
export async function beginApproval(context: GmailContext, approvalId: string): Promise<ApprovalPrompt> {
  // Before the draft is read: a send, classified for the approval under its lock — anything it cannot be approved as
  // is refused for what it is, with where it stands, and nothing of it is shown.
  const record = await sendToApprove(context, approvalId);
  const config = await context.config();
  const entry = Object.entries(config.inboxes).find(([, inbox]) => inbox.id === record.inboxId);
  if (!entry) {
    throw new CommsError('NOT_FOUND', 'the mailbox this approval belongs to is no longer connected');
  }
  const [alias, inbox] = entry;
  const livePolicy: SendPolicy = inbox.sendPolicy ?? config.defaults.sendPolicy;
  const { analysis, draftMessageId } = await readDraft(context, alias, record.draftId).catch(async (error: unknown) => {
    throw withApproval(error, await context.core.approvals.approvalOf(record));
  });
  if (draftMessageId !== record.draftMessageId || analysis.digest !== record.contentDigest) {
    const voided = await context.core.approvals.revoke(approvalId, 'the draft changed after the preview was prepared', {
      disposition: 'integrity',
      expect: { kind: 'send' },
    });
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: the draft changed after the preview was prepared', {
      hint: 'Prepare the send again to see what it says now.',
      details: {
        approvalId,
        approval: voided.form === 'v2' ? await context.core.approvals.approvalOf(voided.record) : null,
      },
    });
  }
  const transport = await context.transport(alias);
  const { facts, flags } = config.defaults.riskEscalation
    ? await studyRecipients(context, transport, { alias, inbox }, analysis)
    : { facts: [], flags: [] };
  const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform);
  return {
    approvalId,
    preview: previewFor({
      analysis,
      facts,
      record,
      alias,
      effectivePolicy: stricterPolicy(livePolicy, record.requiredPolicy),
      flags,
    }),
    challenge,
    effectivePolicy: stricterPolicy(livePolicy, record.requiredPolicy),
  };
}

/** Accepts the typed challenge. The draft is read once more, so an edit between the preview and the answer voids it. */
export async function finishApproval(
  context: GmailContext,
  approvalId: string,
  answer: string,
  via: 'terminal' | 'elicitation' = 'terminal',
): Promise<ApprovalRecord> {
  // First, as every approval does: version 3, and an earlier release's records retired.
  await ensureSendEpochConfig(context.core, { now: context.now });
  const record = await sendToApprove(context, approvalId);
  const config = await context.config();
  const entry = Object.entries(config.inboxes).find(([, inbox]) => inbox.id === record.inboxId);
  if (!entry) throw new CommsError('NOT_FOUND', 'the mailbox this approval belongs to is no longer connected');
  const [alias] = entry;
  const { analysis, draftMessageId } = await readDraft(context, alias, record.draftId).catch(async (error: unknown) => {
    throw withApproval(error, await context.core.approvals.approvalOf(record));
  });
  const approved = await context.core.approvals.approve(
    approvalId,
    via,
    { draftMessageId, contentDigest: analysis.digest },
    answer,
    'send',
    context.platform,
  );
  await context.core.audit.append({
    inboxId: record.inboxId,
    alias,
    operation: 'send.approve',
    outcome: 'ok',
    surface: context.surface,
    ids: { approvalIds: [approvalId], draftIds: [record.draftId] },
    reason: `approved via ${via}`,
  });
  return approved;
}

/**
 * Step three, and the only place mail leaves.
 *
 * The order matters and is the whole guarantee: claim the record (once, across processes, by O_EXCL), reserve a slot
 * against the rate caps, re-read the draft and check it against the record one final time, and only then send —
 * exactly once, never retried, because a retried send may deliver twice.
 */
export async function executeSend(
  context: GmailContext,
  alias: string,
  options: {
    draftId: string;
    approvalId: string;
    expect: Expectation;
    /** True only for the CLI marker `--expect-subject none`; MCP subjects remain ordinary strings. */
    expectSubjectNone?: boolean | undefined;
  },
): Promise<SendResult> {
  // First, as every claim does: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const config = await context.config();
  const livePolicy: SendPolicy = resolved.inbox.sendPolicy ?? config.defaults.sendPolicy;
  const transport = await context.transport(alias);

  /*
   * The record first, before Google is called at all — this mailbox's send, classified under its lock as the claim
   * would classify it (design 2026-10-05 §D2). Another mailbox's, another kind's or one nobody prepared is the one
   * NOT_FOUND; a used one, an expired one, one revoked — now, because sending was turned off since — or one being sent
   * by another call is refused for what it is, with where it stands. A used approval means the draft has gone from
   * Drafts, and reading it would report a missing draft: true, but the wrong answer to "why did this not send".
   */
  const { outcome } = await context.core.approvals.inspect(
    options.approvalId,
    { kind: 'send', owner: resolved.inbox.id },
    { action: 'claim' },
  );
  if (outcome.error) throw outcome.error;

  // Read first, claim second: the claim is single-use, and burning it on a draft that has since changed would cost
  // the user a fresh approval for no reason. Refused here, the approval is as it was, and says so.
  const before = await readDraft(context, alias, options.draftId).catch((error: unknown) => {
    throw withApproval(error, outcome.approval);
  });
  if (before.refusals.length > 0) throw withApproval(unsendable(before.refusals), outcome.approval);
  const liveSubject = before.analysis.subject;
  const expect = options.expectSubjectNone
    ? {
        ...options.expect,
        subject: ['', 'none'].includes(liveSubject.trim()) ? liveSubject : 'none',
      }
    : options.expect;

  const {
    record: claimed,
    claimToken,
    approval: claimedApproval,
  } = await context.core.approvals.claimForSend(
    options.approvalId,
    {
      draftMessageId: before.draftMessageId,
      contentDigest: before.analysis.digest,
      inboxId: resolved.inbox.id,
      inboxSub: resolved.inbox.sub,
      expect,
    },
    {
      // Gmail's own words, given here because the approval store is shared and no longer speaks for any product: the
      // person's `approve`, and the wait that learns when they have used it, as this surface takes it (§D7).
      pendingHint: approveAndWaitSentence(
        context.handoffs,
        context.surface,
        options.approvalId,
        (command, wait) =>
          `Ask the user to approve it in the terminal (${command}) or in a trusted client form, or to send it from Gmail${
            wait === undefined ? '' : `; learn when they have with ${wait}`
          }.`,
        { instead: 'Ask the user to approve it in a trusted client form, or to send it from Gmail.' },
      ),
      platform: context.platform,
    },
  );
  const bookkeeping = {
    alias,
    inboxId: resolved.inbox.id,
    approvalId: options.approvalId,
    draftId: options.draftId,
  };
  // Claimed: from here until its outcome is recorded, the claim's lease is renewed while Gmail's work is outstanding.
  return withSendingLease(context.core.approvals, options.approvalId, claimToken, async () => {
    if (claimed.draftId !== options.draftId) {
      const error = new CommsError(
        'APPROVAL_VOID',
        'nothing was sent: this approval was prepared for a different draft',
        {
          hint: 'Prepare the send again for the draft you mean.',
        },
      );
      throw await recordNoSend(context, bookkeeping, claimToken, claimedApproval, error);
    }

    const caps = capsFor(config.defaults);
    try {
      await context.core.ledger.reserve(resolved.inbox.id, options.approvalId, caps);
    } catch (error) {
      throw await recordNoSend(context, bookkeeping, claimToken, claimedApproval, error);
    }

    /*
     * The last look and the fence, before every attempt (design 2026-10-08 §R3): a retry after a throttle sends only
     * the draft that was approved, and only while this claim still holds its lease. Nothing has been sent before any
     * of them — a retry follows only a refusal that proves it — so the fence always runs with `stepsStarted: 0`.
     */
    const readyToSend = async (): Promise<void> => {
      // The last look. Between the claim and here, nothing of ours can have changed the draft — `draft update` and
      // `draft delete` refuse while an approval is sending — but a person in Gmail web still can.
      let now: Awaited<ReturnType<typeof readDraft>>;
      try {
        now = await readDraft(context, alias, options.draftId);
      } catch (error) {
        throw await recordNoSend(context, bookkeeping, claimToken, claimedApproval, error);
      }
      if (now.draftMessageId !== claimed.draftMessageId || now.analysis.digest !== claimed.contentDigest) {
        const error = new CommsError('APPROVAL_VOID', 'nothing was sent: the draft changed while it was being sent', {
          hint: 'Prepare the send again to see what it says now.',
        });
        throw await recordNoSend(context, bookkeeping, claimToken, claimedApproval, error);
      }

      /*
       * The fence (design 2026-10-05 §D1): immediately before the one provider mutation, after the reservation and the
       * final read, this claim must still hold a `sending` record — its lease renewed by the look. Once another caller has
       * read it `unknown` (this call stalled past its lease), the send does not start: the record is completed `failed`,
       * `lease-lost-before-send`, and nothing was sent. A fence narrows the window and cannot close it: a call suspended
       * after it and before Gmail answers can still send, which is what `unknown` means.
       */
      const fenced = await fenceOrStop(context.core.approvals, options.approvalId, claimToken, { stepsStarted: 0 });
      if (!fenced.proceed) {
        throw await recordNoSend(
          context,
          bookkeeping,
          claimToken,
          claimedApproval,
          fenced.error ?? new CommsError('APPROVAL_VOID', 'nothing was sent: the sending lease ran out'),
          { recorded: LEASE_LOST_BEFORE_SEND },
        );
      }
    };

    // A refusal that proves nothing was sent and says "later" waits and tries again, within core's pacing (§R1, §R2).
    const pacing = context.sendPacing();
    let sent: { id: string | undefined; threadId: string | undefined };
    for (;;) {
      await readyToSend();
      try {
        sent = await transport.sendDraft(options.draftId);
        break;
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        const ids = { approvalIds: [options.approvalId], draftIds: [options.draftId] };
        if (sendCertainlyRefused(error)) {
          const throttle = sendThrottleOf(error, context.now().getTime());
          const delay = throttle?.limit === 'rate' ? pacing.next(throttle.waitMs) : null;
          if (delay !== null) {
            await pacing.wait(delay);
            continue;
          }
          const refusal = throttle ? throttledRefusal(throttle, pacing.retries, error) : error;
          throw await recordNoSend(context, bookkeeping, claimToken, claimedApproval, refusal, {
            sayNothingSent: true,
          });
        }

        let unaudited = '';
        try {
          await context.core.audit.append({
            inboxId: resolved.inbox.id,
            alias,
            operation: 'send.execute',
            outcome: 'failed',
            surface: context.surface,
            ids,
            reason: `outcome unknown: ${said}`,
          });
        } catch (failure) {
          unaudited = ` The audit log could not record this either (${failure instanceof Error ? failure.message : String(failure)}).`;
        }
        // Uncertain from the moment the answer is lost, and said with its own code at once: never retried, never a
        // retryable transport code an agent would follow with the same call, never "prepare again" (§D2).
        throw new CommsError('SEND_OUTCOME_UNKNOWN', `whether the email was sent is not known: ${said}`, {
          hint: `Check the Sent folder before anything else: Gmail may have sent it. This approval is not used again. Do not prepare the draft again automatically: only once the person has checked that it is not in Sent.${unaudited}`,
          details: {
            ...(error instanceof CommsError ? error.details : {}),
            approvalId: options.approvalId,
            outcome: 'unknown',
            // Still `sending`: nothing is recorded of a send whose outcome is not known.
            approval: await approvalNow(context, options.approvalId, resolved.inbox.id, claimedApproval),
          },
          cause: error,
        });
      }
    }

    /*
     * Gmail accepted it. Its id is validated before anything is built from it (§D8): a send Gmail accepted without
     * naming the message is said as exactly that — never `used`, which needs an id, and never an empty string a
     * completion, an audit line or a read-back would take for one. Nothing records it, so it reads `sending`, then
     * `unknown` at its lease boundary.
     */
    const sentMessageId = providerId(sent.id);
    const unrecorded: string[] = [];
    // `used` only once it is written; until then — and for good, if it cannot be — the record as it stands.
    let approval: ApprovalObject | null = null;
    if (sentMessageId !== undefined) {
      try {
        approval = await context.core.approvals.approvalOf(
          await context.core.approvals.complete(options.approvalId, claimToken, { sentMessageId }),
        );
      } catch (error) {
        unrecorded.push(
          `the approval could not be marked used (${error instanceof Error ? error.message : String(error)}), so it will read as unknown`,
        );
      }
    }

    // Read the sent message back: it is the only evidence that what went out is what was approved, and the only way to
    // catch a reply that Gmail filed outside the conversation it was meant for. With no id there is nothing to read.
    let verified: SendResult['verified'] = null;
    if (sentMessageId !== undefined) {
      try {
        const message = await transport.getMessageMetadata(sentMessageId);
        verified = { threadId: message.threadId ?? undefined, labelIds: message.labelIds ?? [] };
      } catch {
        // The mail has gone either way; not being able to read it back is worth reporting, not worth failing.
      }
    }

    try {
      await context.core.audit.append({
        inboxId: resolved.inbox.id,
        alias,
        operation: 'send.execute',
        outcome: 'ok',
        surface: context.surface,
        ids: {
          approvalIds: [options.approvalId],
          draftIds: [options.draftId],
          // Only an id Gmail gave: accepted without one, the field is left out and the reason says so.
          ...(sentMessageId === undefined ? {} : { messageIds: [sentMessageId] }),
        },
        // From the record, not from what the caller claimed: the two are checked to be equal, but the record is the
        // one a person approved, and an audit line is worth having only if it says what actually happened.
        recipients: [...claimed.expect.to, ...claimed.expect.cc, ...claimed.expect.bcc].map(canonicalAddress),
        reason: [
          ...(sentMessageId === undefined ? ['accepted-without-id'] : []),
          `digest ${claimed.contentDigest.slice(0, 12)} · policy ${livePolicy} · ${claimed.approvedVia ?? 'chat'}`,
          ...unrecorded,
        ].join(' · '),
      });
    } catch (error) {
      unrecorded.push(`the audit log could not record it (${error instanceof Error ? error.message : String(error)})`);
    }

    return {
      inbox: alias,
      approvalId: options.approvalId,
      draftId: options.draftId,
      ...(sentMessageId === undefined ? {} : { sentMessageId }),
      said: sentMessageId === undefined ? SENT_WITHOUT_ID : `sent, message id ${sentMessageId}`,
      threadId: sent.threadId,
      to: claimed.expect.to,
      cc: claimed.expect.cc,
      bcc: claimed.expect.bcc,
      subject: claimed.expect.subject,
      verified,
      ...(unrecorded.length > 0 ? { note: unrecorded.join('; ') } : {}),
      approval: approval ?? (await approvalNow(context, options.approvalId, resolved.inbox.id, claimedApproval)),
      ...(legacyDrain === undefined ? {} : { legacyDrain }),
    };
  });
}

/**
 * The approvals on this machine, for `send list` and for the doctor — every form, none skipped — each looked at under
 * its own lock and classified, as a status is (design 2026-10-05 §D8), with the mailbox it belongs to by name,
 * `(removed)` for one no longer connected, and null for a record whose owner cannot be trusted. Narrowed to a mailbox
 * (`inbox`, or a pinned server's), only that mailbox's own: a record whose owner cannot be trusted — a stub — never
 * matches. What a sender wrote goes through this package's own field helpers: an address bare only while it is a plain
 * address, a subject always wrapped, a file name decoded and wrapped. Never a challenge hash or a claim token.
 *
 * Beside them, the unsent section (design 2026-10-05 §D9, `unsentSection`): the drafts whose last preparation expired
 * in the last seven days, each worded to the records the scan read, with what Drafts says of it now.
 */
export async function listApprovals(
  context: GmailContext,
  filter: { inbox?: string | undefined } = {},
): Promise<ApprovalList> {
  const config = await context.config();
  const byId = new Map(Object.entries(config.inboxes).map(([alias, inbox]) => [inbox.id, alias]));
  const name = filter.inbox;
  const inboxId = name
    ? resolveName(config, 'inbox', name, () => new CommsError('NOT_FOUND', `there is no mailbox called "${name}"`))
        .inbox.id
    : undefined;
  const seen = await context.core.approvals.inspectAll(inboxId ? { inboxId } : {});
  const approvals = seen.map(({ stored, outcome }) => {
    const owner = ownerOf(stored);
    const alias = owner === null ? null : (byId.get(owner) ?? '(removed)');
    // The envelope names the mailbox by its alias where it still has one, else by the id it was prepared for.
    const envelope = {
      boundary: newBoundary(),
      inbox: alias !== null && alias !== '(removed)' ? alias : (owner ?? 'none') || 'none',
      id: outcome.approval.id,
    };
    const wrap: SenderFieldWrapper = (text, field) =>
      field === 'subject'
        ? wrapField(text, 'subject', envelope)
        : field === 'filename'
          ? filenameField(text, envelope)
          : addressField(text, field, envelope);
    return {
      ...publicApproval(stored, outcome, {
        wrap,
        // Gmail's own surface: acceptance is sending, and says so (D2).
        ...(outcome.approval.channel === 'gmail' ? { usedSaid: (at: string) => `sent at ${at}` } : {}),
      }),
      inbox: alias,
    };
  });
  // Then the drafts whose last preparation expired, and what the records read can say of each (design §D9).
  return { approvals, unsent: await unsentSection(context, inboxId ? { inboxId } : {}) };
}

/**
 * Cancels an approval. Anyone may cancel: refusing to send is never the dangerous direction. One an earlier release
 * prepared is retired in its own shape; a corrupt or unreadable one is refused, and nothing is written to it.
 */
export async function revokeApproval(context: GmailContext, approvalId: string): Promise<StoredApproval> {
  const stored = await context.core.approvals.revoke(approvalId, 'cancelled', { disposition: 'person' });
  await context.core.audit.append({
    inboxId: ownerOf(stored) ?? '',
    alias: '',
    operation: 'send.revoke',
    outcome: 'ok',
    surface: context.surface,
    ids: { approvalIds: [approvalId] },
  });
  return stored;
}

/**
 * A send's approval as a person may be shown it to approve, classified under its lock for that approval (design
 * 2026-10-05 §D2): Gmail's own — another channel's id, another kind's or one nobody prepared is the one `NOT_FOUND`; a
 * corrupt or unreadable record is refused with only its stub; one an earlier release prepared by its version; one
 * expired, used, revoked — now, because its mailbox was removed or sending was turned off — or under way is refused for
 * what it is, with where it stands. Before any draft is read.
 */
async function sendToApprove(context: GmailContext, approvalId: string): Promise<ApprovalRecord> {
  const { outcome } = await context.core.approvals.inspect(
    approvalId,
    { kind: 'send', channel: 'gmail' },
    { action: 'approve' },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.record === null) throw new CommsError('UNEXPECTED', 'a send approval read as no record');
  return outcome.record;
}
