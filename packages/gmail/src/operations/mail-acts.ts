import {
  type ActDecision,
  actNotAllowed,
  allowedAct,
  allowedHereLine,
  type BehaviourAct,
  behaviourRefusalHint,
  type Config,
  canonicalJson,
  sha256Hex,
} from '@agentcomms/core';
import type { GmailContext, ResolvedInbox } from '../context.ts';
import { accountNameOf } from '../domain/agent-label.ts';
import type { DraftAnalysis } from '../domain/outbound.ts';
import { isPlainAddress, isPlainDomain } from '../domain/untrusted-fields.ts';
import type { GmailTransport } from '../gmail-api/transport.ts';

/**
 * What a send from a mailbox is, and whether the behaviour rules allow it (design 2026-10-19-agent-behaviour-rules,
 * B2–B4). Nothing here sends: `prepareSend` asks before it records an approval, and `executeSend` asks again, on the
 * configuration as it is then, before Gmail is called.
 *
 * A send is one of two acts. It is a `reply` only when its In-Reply-To names a message this mailbox holds, proven from
 * the mailbox at prepare; anything else — a forward, a new message with the thread id Gmail gives every draft, an
 * In-Reply-To nobody here received — is a `send`. Its places are its recipients, To, Cc and Bcc, each on its own: the
 * act must be allowed for every one of them, so one recipient a rule forbids refuses the whole message.
 *
 * The approval binds both. An approval record keeps one digest of what it permits, so for a send that digest covers
 * the draft's own digest and the act and places it was checked as; and since there are only two acts, the act an
 * approval was bound as is the one whose digest it holds. What is approved is what is checked at send, never an act
 * decided again from a mailbox that may have changed since.
 */

/** B2: what a Gmail send can be. */
export const MAIL_ACTS: readonly ['reply', 'send'] = Object.freeze(['reply', 'send'] as const);
export type MailAct = (typeof MAIL_ACTS)[number];

/**
 * A Message-ID plain enough that Gmail's search reads it as one word and nothing else: no space, quote, bracket, brace
 * or parenthesis, so nothing in a draft can become a search of its own (`… OR in:anywhere`). A stranger one is not
 * searched for, and proves no reply.
 */
const MESSAGE_ID = /^[A-Za-z0-9!#$%&*+/=?^_|~.-]{1,256}@[A-Za-z0-9._-]{1,255}$/;

/** At most this many messages a proof reads: copies of one message — in Sent and in the inbox — are one each. */
const PROOF_HITS = 10;

/** The one Message-ID a header names, bare — `<id>`, or `id` as some mailers write it — when it is a plain one. */
export function messageIdOf(header: string | null | undefined): string | undefined {
  const value = (header ?? '').trim();
  const id = /^<([^<>\s]+)>$/.exec(value)?.[1] ?? (/^[^<>\s]+$/.test(value) ? value : undefined);
  return id !== undefined && MESSAGE_ID.test(id) ? id : undefined;
}

/**
 * B2: a `reply` when the draft's In-Reply-To names a message this mailbox holds; otherwise a `send`.
 *
 * One Gmail search for that Message-ID, then a look at what it found: a hit counts only when it is not a draft — a
 * draft is a message Gmail holds too, and one an agent can write, so answering it proves nothing — and its own
 * Message-ID is exactly the one asked for. A mailbox that does not answer proves nothing either.
 */
export async function mailActOf(transport: GmailTransport, analysis: DraftAnalysis): Promise<MailAct> {
  const id = messageIdOf(analysis.inReplyTo);
  if (id === undefined) return 'send';
  try {
    const page = await transport.listMessages({
      query: `rfc822msgid:${id}`,
      maxResults: PROOF_HITS,
      includeSpamTrash: true,
    });
    for (const { id: messageId } of page.ids.slice(0, PROOF_HITS)) {
      if (!messageId) continue;
      const message = await transport.getMessageMetadata(messageId);
      if ((message.labelIds ?? []).includes('DRAFT')) continue;
      const header = (message.payload?.headers ?? []).find((each) => each.name?.toLowerCase() === 'message-id');
      if (messageIdOf(header?.value) === id) return 'reply';
    }
  } catch {
    // Not proven: a new message, which a rule that allows only replies refuses.
  }
  return 'send';
}

/** B4: every recipient — To, Cc and Bcc — once, each a place of its own, lower-cased as rules compare addresses. */
export function mailPlaces(analysis: DraftAnalysis): string[][] {
  const places = new Set<string>();
  for (const address of [...analysis.to, ...analysis.cc, ...analysis.bcc]) {
    const place = address.trim().toLowerCase();
    if (place) places.add(place);
  }
  return [...places].map((place) => [place]);
}

/** The digest an approval for this draft, checked as `act`, is bound to: the draft's digest, the act, the places. */
export function boundDigest(analysis: DraftAnalysis, act: MailAct): string {
  return sha256Hex(canonicalJson({ v: 1, content: analysis.digest, act, places: mailPlaces(analysis) }));
}

/** What an approval's digest says of a draft as it reads now: the digest to compare, and the acts to check at send. */
export interface SendBinding {
  digest: string;
  acts: MailAct[];
}

/**
 * The act an approval was bound as, read from its digest against the draft as it is now — or nothing, when the digest
 * is not one of this draft's: the draft changed.
 *
 * An approval prepared before this release binds the draft's digest alone, and stays claimable for a day after a yes.
 * Its act was never decided, so it is checked as both a reply and a send when its In-Reply-To could make it either,
 * and as a send when it cannot: the stricter reading, as every rule is read.
 */
export function bindingOf(digest: string, analysis: DraftAnalysis): SendBinding | undefined {
  const act = MAIL_ACTS.find((candidate) => boundDigest(analysis, candidate) === digest);
  if (act !== undefined) return { digest, acts: [act] };
  if (digest === analysis.digest) {
    return { digest, acts: messageIdOf(analysis.inReplyTo) === undefined ? ['send'] : ['reply', 'send'] };
  }
  return undefined;
}

/**
 * A place as a refusal may name it: a recipient's address bare only while it is a plain address — it is a sender's,
 * and this text is the package's own voice — else its domain, while that is plain, else no name at all.
 */
function shownPlace(place: string | null): string | null {
  if (place === null || isPlainAddress(place)) return place;
  const domain = place.slice(place.lastIndexOf('@') + 1);
  return place.includes('@') && isPlainDomain(domain) ? `@${domain}` : "a recipient's address";
}

/** Where a refusal points: the command that shows the rules, never one that widens them. */
function refusalHint(
  context: GmailContext,
  decision: Extract<ActDecision, { allowed: false }>,
  analysis: DraftAnalysis,
): string {
  // Meant as a reply, perhaps, and not one this mailbox could prove: said, so the refusal is not a riddle.
  const unproven =
    decision.act === 'send' && decision.allowedActs.includes('reply') && analysis.inReplyTo?.trim()
      ? 'A message is a reply only when its In-Reply-To names a message in this mailbox, and this one does not.'
      : undefined;
  // Core's words, the same on every channel (`behaviourRefusalHint`): the command that shows the rules, never one that
  // widens them.
  return behaviourRefusalHint(context.handoffs, unproven);
}

/**
 * B4: whether the rules in `config` allow every one of `acts` for every recipient of this draft. The decision when
 * they do — for the preview's line — and `ACT_NOT_ALLOWED` when they do not, naming the recipient refused.
 */
export function requireMailAct(
  context: GmailContext,
  config: Config,
  resolved: ResolvedInbox,
  acts: readonly BehaviourAct[],
  analysis: DraftAnalysis,
): ActDecision {
  const account = accountNameOf(config, resolved);
  const decision = allowedAct(config, {
    accountId: resolved.inbox.id,
    account,
    places: mailPlaces(analysis),
    acts: [...acts],
  });
  if (decision.allowed) return decision;
  throw actNotAllowed(
    { ...decision, place: shownPlace(decision.place) },
    { account, place: null },
    refusalHint(context, decision, analysis),
  );
}

/** B4's line, for this mailbox's preview: what is allowed where this send lands, and the rule that says so. */
export function allowedHere(config: Config, resolved: ResolvedInbox, decision: ActDecision): string {
  return allowedHereLine(decision, { account: accountNameOf(config, resolved), place: null });
}
