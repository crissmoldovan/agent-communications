import {
  type ActDecision,
  actNotAllowed,
  allowedAct,
  allowedHereLine,
  type BehaviourAct,
  behaviourRefusalHint,
  CommsError,
  type Config,
  canonicalAddress,
  canonicalJson,
  parseAddressList,
  sha256Hex,
  shownText,
} from '@agentcomms/core';
import type { GmailContext, ResolvedInbox } from '../context.ts';
import { accountNameOf, shownFrom } from '../domain/agent-label.ts';
import type { DraftAnalysis } from '../domain/outbound.ts';
import { isPlainAddress, isPlainDomain } from '../domain/untrusted-fields.ts';
import type { GmailTransport } from '../gmail-api/transport.ts';

/**
 * What a send from a mailbox is, and whether the behaviour rules allow it (design 2026-10-19-agent-behaviour-rules,
 * B2–B4). Nothing here sends: `prepareSend` asks before it records an approval, and `executeSend` asks again, on the
 * configuration as it is then, before Gmail is called.
 *
 * A send is one of two acts, and it is decided for each recipient on their own (lead's call, after review). It is a
 * `reply` to a recipient only when its In-Reply-To names a message this mailbox holds — outside Spam and Trash, proven
 * from the mailbox at prepare — and that recipient was on it: its From, Reply-To, To or Cc. To anyone else it is a
 * `send`, so a reply to an unrelated message cannot reach someone new as a reply. Anything else — a forward, a new
 * message with the thread id Gmail gives every draft, an In-Reply-To nobody here received — is a `send` to everyone.
 * Each recipient — To, Cc and Bcc — is a place of its own, checked as its own act: one recipient a rule forbids refuses
 * the whole message.
 *
 * The approval binds it. An approval record keeps one digest of what it permits, so for a send that digest covers the
 * draft's own digest and each recipient with the act it was checked as. What is approved is what is checked at send,
 * never an act decided again from a mailbox that may have changed since: the acts are recovered from the digest itself
 * (`bindingOf`), and a mailbox read again only offers a candidate the digest must confirm.
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

/** Labels whose messages prove nothing: a draft an agent can write, and mail in Spam or Trash anyone can send. */
const UNPROVEN_LABELS: ReadonlySet<string> = new Set(['DRAFT', 'SPAM', 'TRASH']);

/** The one Message-ID a header names, bare — `<id>`, or `id` as some mailers write it — when it is a plain one. */
export function messageIdOf(header: string | null | undefined): string | undefined {
  const value = (header ?? '').trim();
  const id = /^<([^<>\s]+)>$/.exec(value)?.[1] ?? (/^[^<>\s]+$/.test(value) ? value : undefined);
  return id !== undefined && MESSAGE_ID.test(id) ? id : undefined;
}

/** What the mailbox proved a draft answers: who was on that message, and who it was from, as a person reads it. */
export interface ReplyProof {
  /** Everyone on the proven message — its From, Reply-To, To and Cc — each canonical, as recipients are. */
  readonly participants: ReadonlySet<string>;
  /** Its From, as a preview shows it: a sender's words, so decoded, neutralised and flattened to one line. */
  readonly from: string;
  /** Gmail's id of the proven message, and of its thread: what the send's activity line says it answers (0.32.0). */
  readonly messageId: string;
  readonly threadId?: string | undefined;
}

/** A recipient as acts and rules compare it: canonical (lower-cased, its domain in ASCII) and trimmed. */
function placeOf(address: string): string {
  return canonicalAddress(address.trim());
}

/**
 * B3, lead's call after review: a Gmail outage is not an answer. A proof that could not be asked raises `TRANSIENT` —
 * nothing was sent and nothing is used — rather than reading as "not a reply", which a rule that allows only replies
 * would have refused for good.
 */
function proofUnavailable(error: unknown): CommsError {
  return new CommsError('TRANSIENT', 'Gmail could not be asked whether this draft answers a message in this mailbox', {
    hint: 'Nothing was sent, and no approval was used. Try again shortly.',
    details: { reason: 'reply-proof-unavailable', cause: error instanceof CommsError ? error.code : null },
    cause: error,
  });
}

/**
 * B2: the message this draft's In-Reply-To names, when this mailbox holds it — or nothing, when it does not.
 *
 * One Gmail search for that Message-ID, outside Spam and Trash, then a look at what it found: a hit counts only when it
 * is not a draft, in Spam or in Trash — a draft is a message Gmail holds too, and one an agent can write, and Spam is
 * mail anyone can send — and its own Message-ID is exactly the one asked for. A mailbox that cannot be asked raises
 * `TRANSIENT`; a hit that went between the search and the read is passed over.
 */
export async function replyProofOf(
  transport: GmailTransport,
  analysis: DraftAnalysis,
): Promise<ReplyProof | undefined> {
  const id = messageIdOf(analysis.inReplyTo);
  if (id === undefined) return undefined;
  let page: Awaited<ReturnType<GmailTransport['listMessages']>>;
  try {
    page = await transport.listMessages({
      query: `rfc822msgid:${id}`,
      maxResults: PROOF_HITS,
      includeSpamTrash: false,
    });
  } catch (error) {
    throw proofUnavailable(error);
  }
  for (const { id: messageId } of page.ids.slice(0, PROOF_HITS)) {
    if (!messageId) continue;
    let message: Awaited<ReturnType<GmailTransport['getMessageMetadata']>>;
    try {
      message = await transport.getMessageMetadata(messageId);
    } catch (error) {
      if (error instanceof CommsError && error.code === 'NOT_FOUND') continue;
      throw proofUnavailable(error);
    }
    if ((message.labelIds ?? []).some((label) => UNPROVEN_LABELS.has(label))) continue;
    const headers = message.payload?.headers ?? [];
    const header = (name: string): string[] =>
      headers.filter((each) => each.name?.toLowerCase() === name).map((each) => each.value ?? '');
    if (header('message-id').length !== 1 || messageIdOf(header('message-id')[0]) !== id) continue;
    const participants = new Set<string>();
    for (const name of ['from', 'reply-to', 'to', 'cc']) {
      for (const value of header(name))
        for (const { address } of parseAddressList(value)) participants.add(placeOf(address));
    }
    return {
      participants,
      from: shownText(shownFrom(header('from')[0]), 120),
      messageId,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    };
  }
  return undefined;
}

/** B4: every recipient — To, Cc and Bcc — once, each a place of its own, canonical as rules compare addresses. */
export function mailPlaces(analysis: DraftAnalysis): string[] {
  const places = new Set<string>();
  for (const address of [...analysis.to, ...analysis.cc, ...analysis.bcc]) {
    const place = placeOf(address);
    if (place) places.add(place);
  }
  return [...places];
}

/** Each recipient and the acts it is checked as, in recipient order. */
export type PlaceActs = readonly (readonly [place: string, acts: readonly MailAct[]])[];

/** B2, per recipient: `reply` to whoever was on the proven message, `send` to everyone else — and to all, unproven. */
export function placeActs(analysis: DraftAnalysis, proof: ReplyProof | undefined): PlaceActs {
  return mailPlaces(analysis).map((place) => [place, [proof?.participants.has(place) ? 'reply' : 'send']] as const);
}

/** The digest an approval for this draft, checked as `acts`, is bound to: the draft's digest, each recipient's act. */
export function boundDigest(analysis: DraftAnalysis, acts: PlaceActs): string {
  return sha256Hex(
    canonicalJson({ v: 2, content: analysis.digest, places: acts.map(([place, each]) => [place, each[0] ?? 'send']) }),
  );
}

/** What an approval's digest says of a draft as it reads now: the digest to compare, and the acts to check at send. */
export interface SendBinding {
  readonly digest: string;
  /** `bound`: this release's, one act per recipient. `legacy`: an earlier release's, the draft's digest alone. */
  readonly form: 'bound' | 'legacy';
  readonly places: PlaceActs;
  /** The proof that recovered it, when the mailbox was read to: for the preview's `Checked as:` line. */
  readonly proof?: ReplyProof | undefined;
}

/**
 * The acts an approval was bound as, recovered from its digest against the draft as it is now — or nothing, when no
 * reading of the draft gives that digest: the draft changed, or the message it answered went and the acts were mixed.
 *
 * The cheap readings first — every recipient a `send`, or every one a `reply` — then, only when neither is the digest,
 * the mailbox asked again for the message the draft answers, whose reading the digest must confirm: a mailbox changed
 * since can never turn a send into a reply, only fail to give the reading back. A transport error there raises
 * `TRANSIENT`, never a reading.
 *
 * An approval prepared before this release binds the draft's digest alone, and stays claimable for a day after a yes.
 * Its acts were never decided, so each recipient is checked as both a reply and a send when its In-Reply-To could
 * make it either, and as a send when it cannot: the stricter reading, as every rule is read.
 */
export async function bindingOf(
  transport: GmailTransport,
  digest: string,
  analysis: DraftAnalysis,
): Promise<SendBinding | undefined> {
  const places = mailPlaces(analysis);
  const replyable = messageIdOf(analysis.inReplyTo) !== undefined;
  if (digest === analysis.digest) {
    const acts: readonly MailAct[] = replyable ? ['reply', 'send'] : ['send'];
    return { digest, form: 'legacy', places: places.map((place) => [place, acts] as const) };
  }
  for (const act of replyable ? MAIL_ACTS : (['send'] as const)) {
    const uniform: PlaceActs = places.map((place) => [place, [act]] as const);
    if (boundDigest(analysis, uniform) === digest) return { digest, form: 'bound', places: uniform };
  }
  if (!replyable || places.length < 2) return undefined;
  const proof = await replyProofOf(transport, analysis);
  if (proof === undefined) return undefined;
  const mixed = placeActs(analysis, proof);
  return boundDigest(analysis, mixed) === digest ? { digest, form: 'bound', places: mixed, proof } : undefined;
}

/** Whether `binding`, recovered before a claim, still gives the claimed digest for the draft as it reads now. */
export function stillBound(binding: SendBinding, digest: string, analysis: DraftAnalysis): boolean {
  if (binding.digest !== digest) return false;
  if (binding.form === 'legacy') return analysis.digest === digest;
  const now = mailPlaces(analysis);
  return (
    now.length === binding.places.length &&
    now.every((place, index) => binding.places[index]?.[0] === place) &&
    boundDigest(analysis, binding.places) === digest
  );
}

/**
 * B4's second line for a send that answers a message, in the preview and on the approval screen: `Checked as: reply to
 * <who it was from>`, and how many recipients it goes to as a new message, not being on that message. Nothing for a
 * send that answers nothing here, or for an approval an earlier release bound, which recorded no act.
 */
export async function checkedAsLine(
  transport: GmailTransport,
  analysis: DraftAnalysis,
  acts: PlaceActs,
  proof: ReplyProof | undefined,
): Promise<string | undefined> {
  const replies = acts.filter(([, each]) => each.length === 1 && each[0] === 'reply').length;
  if (replies === 0) return undefined;
  const known = proof ?? (await replyProofOf(transport, analysis));
  const to = known === undefined ? 'a message no longer in this mailbox' : known.from;
  const fresh = acts.filter(([, each]) => each.length === 1 && each[0] === 'send').length;
  const others =
    fresh === 0 ? '' : `; a new message to ${fresh === 1 ? '1 recipient' : `${fresh} recipients`} not on that message`;
  return `Checked as: reply to ${to}${others}`;
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
  replyProven: boolean,
): string {
  // Meant as a reply, perhaps, and not one to this recipient: said, so the refusal is not a riddle.
  const unproven =
    decision.act === 'send' && decision.allowedActs.includes('reply') && analysis.inReplyTo?.trim()
      ? replyProven
        ? 'It answers a message in this mailbox, but this recipient was not on it (its From, Reply-To, To or Cc), so to them it is a new message.'
        : 'A message is a reply only when its In-Reply-To names a message in this mailbox, outside Spam and Trash, and this one does not.'
      : undefined;
  // Core's words, the same on every channel (`behaviourRefusalHint`): the command that shows the rules, never one that
  // widens them.
  return behaviourRefusalHint(context.handoffs, unproven);
}

/** What is allowed across every recipient, and the rule that narrowed it most: one decision for the preview's line. */
function combined(decisions: readonly Extract<ActDecision, { allowed: true }>[]): ActDecision {
  let allowedActs: BehaviourAct[] | 'all' = 'all';
  let narrowest: { size: number; rule: NonNullable<Extract<ActDecision, { allowed: true }>['rule']> } | undefined;
  for (const decision of decisions) {
    const acts = decision.allowedActs;
    if (acts === 'all') continue;
    allowedActs = allowedActs === 'all' ? [...acts] : allowedActs.filter((act) => acts.includes(act));
    if (decision.rule !== null && (narrowest === undefined || acts.length < narrowest.size)) {
      narrowest = { size: acts.length, rule: decision.rule };
    }
  }
  return { allowed: true, rule: narrowest?.rule ?? null, allowedActs };
}

/**
 * B4: whether the rules in `config` allow, at every recipient of this draft, every act it is checked as there. The
 * decision when they do — for the preview's line — and `ACT_NOT_ALLOWED` when they do not, naming the first recipient
 * refused, in recipient order.
 */
export function requireMailActs(
  context: GmailContext,
  config: Config,
  resolved: ResolvedInbox,
  acts: PlaceActs,
  analysis: DraftAnalysis,
): ActDecision {
  const account = accountNameOf(config, resolved);
  const replyProven = acts.some(([, each]) => each.length === 1 && each[0] === 'reply');
  const decisions: Extract<ActDecision, { allowed: true }>[] = [];
  for (const [place, each] of acts.length === 0 ? [[null, ['send']] as const] : acts) {
    const decision = allowedAct(config, {
      accountId: resolved.inbox.id,
      account,
      places: place === null ? [] : [[place]],
      acts: [...each],
    });
    if (!decision.allowed) {
      throw actNotAllowed(
        { ...decision, place: shownPlace(decision.place) },
        { account, place: null },
        refusalHint(context, decision, analysis, replyProven),
      );
    }
    decisions.push(decision);
  }
  return combined(decisions);
}

/** B4's line, for this mailbox's preview: what is allowed where this send lands, and the rule that says so. */
export function allowedHere(config: Config, resolved: ResolvedInbox, decision: ActDecision): string {
  return allowedHereLine(decision, { account: accountNameOf(config, resolved), place: null });
}
