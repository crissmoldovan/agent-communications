import {
  type ApprovalRecord,
  type Caps,
  CommsError,
  canonicalAddress,
  domainOf,
  type Expectation,
  type MessagePreview,
  publicView,
  renderMessagePreview,
  type SendPolicy,
  stricterPolicy,
} from '@cloudpixel/comms-core';
import type { GmailContext, ResolvedInbox } from '../context.ts';
import { analyseDraft, type DraftAnalysis, type Unsendable, unsendable } from '../domain/outbound.ts';
import type { GmailTransport } from '../gmail-api/transport.ts';

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
  expect: Expectation;
  digest: string;
  expiresAt: string;
  /** What has to happen next, in the words to repeat to the user. */
  nextStep: string;
}

export interface SendResult {
  inbox: string;
  approvalId: string;
  draftId: string;
  sentMessageId: string;
  threadId: string | undefined;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** What Gmail says about the message it filed in Sent, read back after the send. */
  verified: { threadId: string | undefined; labelIds: string[] } | null;
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

/** A record state in the words a person would use, for the message they read when a send does not happen. */
function describeState(state: ApprovalRecord['state']): string {
  switch (state) {
    case 'used':
      return 'this approval has already been used — the message was sent once';
    case 'sending':
      return 'this approval is being sent by another process right now';
    case 'failed':
      return 'the send under this approval failed; whether it arrived is not known from here';
    case 'unknown':
      return 'a process died mid-send under this approval; whether the message went is not known';
    case 'expired':
      return 'this approval has expired';
    case 'revoked':
      return 'this approval was cancelled or voided';
    default:
      return `this approval is ${state}`;
  }
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
 * The domains this mailbox has written to recently.
 *
 * One list per prepare, from the last two hundred sent messages. It is the yardstick a lookalike is measured
 * against, so it has to come from the mailbox's history rather than from the draft under examination.
 */
async function correspondentDomains(transport: GmailTransport): Promise<Set<string>> {
  const domains = new Set<string>();
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
    // A mailbox that will not answer leaves the set empty, which fires no lookalike flags — a quieter preview, not
    // a wrong one, and every other check still runs.
  }
  return domains;
}

/**
 * Has this mailbox written to this address before?
 *
 * Gmail's `to:` matching is fuzzy — it matches display names and partial addresses — so a hit is confirmed by
 * comparing the parsed recipients of the messages it returns. A false "we have written to them" would remove exactly
 * the warning a first-time external recipient is there to raise.
 */
async function hasWrittenTo(transport: GmailTransport, address: string): Promise<boolean> {
  const canonical = canonicalAddress(address);
  const page = await transport.listMessages({ query: `in:sent to:${canonical}`, maxResults: 5 });
  for (const { id } of page.ids) {
    const message = await transport.getMessageMetadata(id);
    const headers = message.payload?.headers ?? [];
    const recipients = headers
      .filter((header) => /^(to|cc|bcc)$/i.test(header.name ?? ''))
      .flatMap((header) => (header.value ?? '').split(','))
      .map((value) => canonicalAddress(value.replace(/^.*<|>.*$/g, '').trim()));
    if (recipients.includes(canonical)) return true;
  }
  return false;
}

interface RecipientFacts {
  address: string;
  external: boolean;
  firstTime: boolean;
  tainted: boolean;
  lookalikeOf: string | null;
  note: string;
}

/**
 * What is known about each recipient, and what it means for the policy.
 *
 * Risk escalation exists because `chat` trusts the agent to show the preview: a send to somebody the user has never
 * written to, at an address that arrived in a message we read this week, is exactly the shape of an exfiltration, and
 * it is worth taking out of the agent's hands entirely.
 */
async function studyRecipients(
  context: GmailContext,
  transport: GmailTransport,
  inbox: ResolvedInbox,
  analysis: DraftAnalysis,
): Promise<{ facts: RecipientFacts[]; flags: string[] }> {
  const own = await ownAddresses(transport, inbox);
  const internal = new Set(inbox.inbox.internalDomains.map((domain) => domain.toLowerCase()));
  const everyone = [...new Set([...analysis.to, ...analysis.cc, ...analysis.bcc])];
  // The domains this mailbox actually corresponds with, read from Sent rather than assembled from this draft's own
  // recipients. Built the latter way, a message addressed *only* to a lookalike had nothing to compare against and
  // the check never fired — which is precisely the message the check exists for.
  const knownDomains = await correspondentDomains(transport);
  for (const address of own) {
    const domain = domainOf(address);
    if (domain) knownDomains.add(domain);
  }
  for (const domain of internal) knownDomains.add(domain);
  const facts: RecipientFacts[] = [];

  for (const address of everyone) {
    const canonical = canonicalAddress(address);
    const domain = domainOf(canonical) ?? '';
    const external = !own.has(canonical) && !internal.has(domain);
    const seen = await context.core.taint.check(canonical);
    const written = own.has(canonical) ? true : await hasWrittenTo(transport, canonical);
    // A domain in the taint store taints only when it is not a public mailbox provider — the store already decides
    // that; here, either kind of sighting counts, because both mean the address reached us through mail we read.
    const tainted = seen.address || seen.domain;
    facts.push({
      address,
      external,
      firstTime: external && !written,
      // A tainted address that we have written to before is somebody we already correspond with.
      tainted: tainted && !written,
      lookalikeOf: null,
      note: '',
    });
  }

  for (const fact of facts) {
    const domain = domainOf(canonicalAddress(fact.address)) ?? '';
    if (!fact.firstTime) continue;
    for (const known of knownDomains) {
      if (known !== domain && distance(known, domain) <= LOOKALIKE_DISTANCE) {
        fact.lookalikeOf = known;
        break;
      }
    }
  }

  for (const fact of facts) {
    fact.note = [
      fact.external ? 'EXTERNAL' : 'internal',
      fact.firstTime ? 'FIRST-TIME' : '',
      fact.tainted ? 'ADDRESS SEEN IN MAIL YOU READ' : '',
      fact.lookalikeOf ? `LOOKS LIKE ${fact.lookalikeOf}` : '',
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
  return { facts, flags };
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
      hint: 'List them with `agent-gmail draft list --inbox <alias>`.',
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
}): string {
  const { analysis, facts, record, alias } = options;
  const notes: Record<string, string> = {};
  for (const fact of facts) notes[fact.address] = fact.note;
  const warnings: string[] = [];
  if (analysis.signatureResources.length > 0) {
    warnings.push(`signature loads ${analysis.signatureResources.length} image(s) from the internet when opened`);
  }
  if (analysis.bcc.length > 0) {
    warnings.push(`${analysis.bcc.length} blind recipient(s) — the others will not see them`);
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
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const config = await context.config();
  const livePolicy: SendPolicy = resolved.inbox.sendPolicy ?? config.defaults.sendPolicy;
  if (livePolicy === 'never') {
    throw new CommsError('POLICY_NEVER', `sending from ${alias} is turned off (policy: never)`, {
      hint: `The draft is in Gmail; send it from there, or change the policy with \`agent-gmail inbox policy ${alias} --send confirm\` in a terminal.`,
    });
  }

  const transport = await context.transport(alias);
  const { analysis, draftMessageId, refusals } = await readDraft(context, alias, draftId);
  if (refusals.length > 0) throw unsendable(refusals);
  if (analysis.to.length === 0 && analysis.cc.length === 0 && analysis.bcc.length === 0) {
    throw new CommsError('BAD_DATA', 'this draft has no recipients', { hint: 'Add them and prepare the send again.' });
  }

  const { facts, flags } = config.defaults.riskEscalation
    ? await studyRecipients(context, transport, resolved, analysis)
    : { facts: [], flags: [] };
  const requiredPolicy: SendPolicy = flags.length > 0 ? 'confirm' : 'chat';
  const effectivePolicy = stricterPolicy(livePolicy, requiredPolicy);

  const record = await context.core.approvals.create({
    inboxId: resolved.inbox.id,
    inboxSub: resolved.inbox.sub,
    draftId,
    draftMessageId,
    digest: analysis.digest,
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
    preview: previewFor({ analysis, facts, record, alias, effectivePolicy }),
    policy: livePolicy,
    effectivePolicy,
    riskFlags: flags,
    expect: record.expect,
    digest: analysis.digest,
    expiresAt: record.expiresAt,
    nextStep:
      effectivePolicy === 'confirm'
        ? `Show the preview to the user, then have them run \`agent-gmail approve ${record.approvalId}\` in a terminal, or send it from Gmail. You cannot approve this yourself.`
        : 'Show the preview to the user verbatim and wait for an explicit yes. Then send it with the same approval id and the recipients and subject shown above.',
  };
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
  const record = await context.core.approvals.get(approvalId);
  if (!record) {
    throw new CommsError('NOT_FOUND', `there is no approval ${approvalId}`, {
      hint: 'Approvals last ten minutes. Prepare the send again.',
    });
  }
  const config = await context.config();
  const entry = Object.entries(config.inboxes).find(([, inbox]) => inbox.id === record.inboxId);
  if (!entry) {
    throw new CommsError('NOT_FOUND', 'the mailbox this approval belongs to is no longer connected');
  }
  const [alias, inbox] = entry;
  const livePolicy: SendPolicy = inbox.sendPolicy ?? config.defaults.sendPolicy;
  const { analysis, draftMessageId } = await readDraft(context, alias, record.draftId);
  if (draftMessageId !== record.draftMessageId || analysis.digest !== record.digest) {
    await context.core.approvals.revoke(approvalId, 'the draft changed after the preview was prepared');
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: the draft changed after the preview was prepared', {
      hint: 'Prepare the send again to see what it says now.',
    });
  }
  const transport = await context.transport(alias);
  const { facts } = config.defaults.riskEscalation
    ? await studyRecipients(context, transport, { alias, inbox }, analysis)
    : { facts: [] };
  const challenge = await context.core.approvals.issueChallenge(approvalId);
  return {
    approvalId,
    preview: previewFor({
      analysis,
      facts,
      record,
      alias,
      effectivePolicy: stricterPolicy(livePolicy, record.requiredPolicy),
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
  const record = await context.core.approvals.get(approvalId);
  if (!record) throw new CommsError('NOT_FOUND', `there is no approval ${approvalId}`);
  const config = await context.config();
  const entry = Object.entries(config.inboxes).find(([, inbox]) => inbox.id === record.inboxId);
  if (!entry) throw new CommsError('NOT_FOUND', 'the mailbox this approval belongs to is no longer connected');
  const [alias] = entry;
  const { analysis, draftMessageId } = await readDraft(context, alias, record.draftId);
  const approved = await context.core.approvals.approve(
    approvalId,
    via,
    { draftMessageId, digest: analysis.digest },
    answer,
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
  options: { draftId: string; approvalId: string; expect: Expectation },
): Promise<SendResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const config = await context.config();
  const livePolicy: SendPolicy = resolved.inbox.sendPolicy ?? config.defaults.sendPolicy;
  const transport = await context.transport(alias);

  // The record's own state first, before Google is called at all. A used approval means the draft has gone from
  // Drafts, and reading it would report a missing draft — true, but the wrong answer to "why did this not send".
  const known = await context.core.approvals.get(options.approvalId);
  if (!known) {
    throw new CommsError('NOT_FOUND', `there is no approval ${options.approvalId}`, {
      hint: 'Approvals last ten minutes. Prepare the send again and show the new preview.',
    });
  }
  if (known.state !== 'pending' && known.state !== 'approved') {
    throw new CommsError('APPROVAL_VOID', `nothing was sent: ${describeState(known.state)}`, {
      hint: 'Prepare the send again if it should still go.',
      details: { approvalId: options.approvalId, state: known.state },
    });
  }

  // Read first, claim second: the claim is single-use, and burning it on a draft that has since changed would cost
  // the user a fresh approval for no reason.
  const before = await readDraft(context, alias, options.draftId);
  if (before.refusals.length > 0) throw unsendable(before.refusals);

  const claimed = await context.core.approvals.claimForSend(options.approvalId, {
    draftMessageId: before.draftMessageId,
    digest: before.analysis.digest,
    inboxId: resolved.inbox.id,
    inboxSub: resolved.inbox.sub,
    policy: livePolicy,
    expect: options.expect,
  });
  if (claimed.draftId !== options.draftId) {
    await context.core.approvals.revoke(options.approvalId, 'the approval names a different draft');
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: this approval was prepared for a different draft', {
      hint: 'Prepare the send again for the draft you mean.',
    });
  }

  const caps = capsFor(config.defaults);
  try {
    await context.core.ledger.reserve(resolved.inbox.id, options.approvalId, caps);
  } catch (error) {
    await context.core.approvals.complete(options.approvalId, { error: 'rate capped' });
    throw error;
  }

  // The last look. Between the claim and here, nothing of ours can have changed the draft — `draft update` and
  // `draft delete` refuse while an approval is sending — but a person in Gmail web still can.
  const now = await readDraft(context, alias, options.draftId);
  if (now.draftMessageId !== claimed.draftMessageId || now.analysis.digest !== claimed.digest) {
    await context.core.ledger.release(resolved.inbox.id, options.approvalId);
    await context.core.approvals.complete(options.approvalId, { error: 'the draft changed' });
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: the draft changed while it was being sent', {
      hint: 'Prepare the send again to see what it says now.',
    });
  }

  let sent: { id: string; threadId: string | undefined };
  try {
    sent = await transport.sendDraft(options.draftId);
  } catch (error) {
    await context.core.ledger.release(resolved.inbox.id, options.approvalId);
    await context.core.approvals.complete(options.approvalId, {
      error: error instanceof Error ? error.message : String(error),
    });
    await context.core.audit.append({
      inboxId: resolved.inbox.id,
      alias,
      operation: 'send.execute',
      outcome: 'failed',
      surface: context.surface,
      ids: { approvalIds: [options.approvalId], draftIds: [options.draftId] },
      reason: error instanceof Error ? error.message : 'send failed',
    });
    throw error;
  }

  const sentMessageId = sent.id;
  await context.core.approvals.complete(options.approvalId, { sentMessageId });

  // Read the sent message back: it is the only evidence that what went out is what was approved, and the only way to
  // catch a reply that Gmail filed outside the conversation it was meant for.
  let verified: SendResult['verified'] = null;
  try {
    const message = await transport.getMessageMetadata(sentMessageId);
    verified = { threadId: message.threadId ?? undefined, labelIds: message.labelIds ?? [] };
  } catch {
    // The mail has gone either way; not being able to read it back is worth reporting, not worth failing.
  }

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'send.execute',
    outcome: 'ok',
    surface: context.surface,
    ids: { approvalIds: [options.approvalId], draftIds: [options.draftId], messageIds: [sentMessageId] },
    // From the record, not from what the caller claimed: the two are checked to be equal, but the record is the
    // one a person approved, and an audit line is worth having only if it says what actually happened.
    recipients: [...claimed.expect.to, ...claimed.expect.cc, ...claimed.expect.bcc].map(canonicalAddress),
    reason: `digest ${claimed.digest.slice(0, 12)} · policy ${livePolicy} · ${claimed.approvedVia ?? 'chat'}`,
  });

  return {
    inbox: alias,
    approvalId: options.approvalId,
    draftId: options.draftId,
    sentMessageId,
    threadId: sent.threadId,
    to: claimed.expect.to,
    cc: claimed.expect.cc,
    bcc: claimed.expect.bcc,
    subject: claimed.expect.subject,
    verified,
  };
}

/** The approvals this mailbox has open, for `send list` and for the doctor. Never includes a challenge hash. */
export async function listApprovals(
  context: GmailContext,
  filter: { inbox?: string | undefined } = {},
): Promise<Array<Omit<ApprovalRecord, 'challengeHash'> & { inbox: string }>> {
  const config = await context.config();
  const byId = new Map(Object.entries(config.inboxes).map(([alias, inbox]) => [inbox.id, alias]));
  const inboxId = filter.inbox ? config.inboxes[filter.inbox]?.id : undefined;
  if (filter.inbox && !inboxId) {
    throw new CommsError('NOT_FOUND', `there is no mailbox called "${filter.inbox}"`);
  }
  const records = await context.core.approvals.list(inboxId ? { inboxId } : {});
  return records.map((record) => ({ ...publicView(record), inbox: byId.get(record.inboxId) ?? '(removed)' }));
}

/** Cancels an approval. Anyone may cancel: refusing to send is never the dangerous direction. */
export async function revokeApproval(context: GmailContext, approvalId: string): Promise<ApprovalRecord> {
  const record = await context.core.approvals.revoke(approvalId, 'cancelled');
  await context.core.audit.append({
    inboxId: record.inboxId,
    alias: '',
    operation: 'send.revoke',
    outcome: 'ok',
    surface: context.surface,
    ids: { approvalIds: [approvalId] },
  });
  return record;
}
