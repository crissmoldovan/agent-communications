import { readFile } from 'node:fs/promises';
import {
  type ApprovalObject,
  type ApprovalRecord,
  approveAndWaitSentence,
  type CliHandoffs,
  CommsError,
  canonicalAddress,
  type Expectation,
  ensureSendEpochConfig,
  fenceOrStop,
  handoffSentence,
  handoffSentenceToFill,
  integrityRefusal,
  type LegacyDrainReport,
  type MessagePreview,
  ownerOf,
  type PublicApprovalView,
  publicApproval,
  renderMessagePreview,
  type SendPolicy,
  sendEpochOf,
  sha256Hex,
  stateOf,
  stricterPolicy,
  type UsedSaid,
  withApproval,
  withSendingLease,
} from '@agentcomms/core';
import { keyPermissionOf, type NamedAccount } from '../accounts.ts';
import { resendRequest, sendThrottleOf, throttledRefusal, type WriteOutcome } from '../api/client.ts';
import { APPROVAL_TAG, closedPermit, type FetchLike, spendOn } from '../api/guard.ts';
import {
  type BuiltMessage,
  buildMessage,
  digestOf,
  newPreparedId,
  type OutboundMessage,
  REACH_CONFIRM_THRESHOLD,
  type SendInput,
  uniqueRecipients,
} from '../compose/message.ts';
import { type PreparedMessage, PreparedStore, SendRecords, type SendSummary } from '../compose/store.ts';
import type { ResendContext } from '../context.ts';
import { type CurrentOutcome, outcomeOf, outcomeUnavailable } from './last-event.ts';

/**
 * The send gate: prepare → preview → approval → execute, once.
 *
 * The Gmail gate's shape, for an API that has no drafts. **`executeSend` is the only function in this package that
 * sends mail**: it alone opens the `emails.send` permit, and a test fails if anything else names that route or calls
 * the request builder. Everything before it exists to make one promise true — nothing leaves that a person has not
 * seen in the form it will arrive in:
 *
 * 1. **Prepare** builds the message (`compose/message.ts`), refuses a From on a domain that is not verified for sending
 *    before any approval exists, stores the message, and records an approval bound to its digest. The preview lists
 *    every recipient, BCC included, and the reach — unique recipients. Above `REACH_CONFIRM_THRESHOLD`, or to an
 *    address that arrived in mail read in the last seven days and never written to from here, the send needs a
 *    person at a terminal whatever the policy says.
 * 2. **Approval** is the account's send policy: under `chat` the person's yes in the conversation; under `confirm`
 *    this CLI's `approve <id>` and a typed code; under `never` nothing.
 * 3. **Execute** re-reads the stored message and its attachments, claims the approval once (a lock and an O_EXCL
 *    marker), reserves a slot under the rate caps, records the attempt **before** the request leaves, and sends with
 *    `Idempotency-Key` = the approval id and the tag `agentcomms_approval=<id>` — only while its claim still holds the
 *    send (the fence, design 2026-10-05 §D1). It never retries. An outcome it cannot know — a dropped connection, a
 *    5xx, a timeout — is `SEND_OUTCOME_UNKNOWN`, recorded and reported with how to check (`send status`), never sent
 *    again.
 */

export interface SendPreparation {
  approvalId: string;
  account: string;
  /** Show it verbatim; do not summarise it. */
  preview: string;
  policy: SendPolicy;
  effectivePolicy: SendPolicy;
  riskFlags: string[];
  /** Unique recipients, BCC included. */
  reach: number;
  expect: Expectation;
  expiresAt: string;
  nextStep: string;
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat sends it. */
  approval: ApprovalObject;
  /**
   * What became of the approvals an earlier release prepared, by id, when this call was one that retired them
   * (`ensureSendEpochConfig`). Absent otherwise.
   */
  legacyDrain?: LegacyDrainReport | undefined;
}

export interface SendResult {
  account: string;
  approvalId: string;
  /**
   * Resend's id for the email — absent when Resend accepted it without one, never empty (design 2026-10-05 §D8). The
   * approval is then not marked used: it reads as sending, then unknown.
   */
  resendId?: string | undefined;
  state: 'sent' | 'scheduled';
  scheduledAt: string | null;
  /**
   * What happened, in words: "sent"; "accepted by Resend, scheduled for <time>" (the time the request asked for); or,
   * without an id, "sent; the provider returned no id" and "accepted (scheduled); the provider returned no id".
   */
  said: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Bookkeeping that could not be written after Resend confirmed the send. */
  note?: string | undefined;
  /**
   * Where the approval stands now that Resend has the email (design 2026-10-05 §D8): `used`, with Resend's id — or
   * still `sending` when that could not be recorded, which later reads as `unknown`. Never a `used` invented.
   */
  approval: ApprovalObject;
  /**
   * What became of the approvals an earlier release prepared, by id, when this call was one that retired them
   * (`ensureSendEpochConfig`). Absent otherwise.
   */
  legacyDrain?: LegacyDrainReport | undefined;
}

/**
 * A used approval, as Resend's own surfaces refuse it (design 2026-10-05 §D2, the used-send row): Resend accepted the
 * email — which is not that it went, since one may be scheduled, bounce or be cancelled — and never "sent". The words
 * `resend_send_wait` shows for it too, core's for every provider.
 */
const ACCEPTED_BY_RESEND: UsedSaid = (usedAt) => `accepted by Resend at ${usedAt}`;

/**
 * A send's approval as the one account that may use it, classified under its lock as the claim would classify it
 * (design 2026-10-05 §D2), or a refusal that does not touch it.
 *
 * Whose and what first: another account's, another kind's, one whose owner cannot be trusted — an unreadable file, a
 * corrupt record whose binding does not verify — or one nobody prepared is the one NOT_FOUND. Then anything that cannot
 * be sent is refused for what it is, with where it stands: this account's corrupt record, one an earlier release
 * prepared, or one used, expired, revoked — now, because sending was turned off since — or under way.
 */
async function ownRecord(
  context: ResendContext,
  named: NamedAccount,
  approvalId: string,
): Promise<{ record: ApprovalRecord; approval: ApprovalObject }> {
  const { outcome } = await context.core.approvals.inspect(
    approvalId,
    { kind: 'send', owner: named.account.id },
    { action: 'claim', usedSaid: ACCEPTED_BY_RESEND },
  );
  if (outcome.error) throw outcome.error;
  if (outcome.record === null) throw new CommsError('UNEXPECTED', 'a send approval read as no record');
  return { record: outcome.record, approval: outcome.approval };
}

function requireSendMode(named: NamedAccount, handoffs: CliHandoffs): void {
  if (named.account.mode !== 'send') {
    throw new CommsError('SCOPE_MISSING', `"${named.name}" is in read mode, so it sends nothing`, {
      hint: handoffSentence(
        handoffs.own(['account', 'policy', named.name, '--mode', 'send']),
        (command) => `A person can allow sending with ${command}, which is a change they approve.`,
      ),
    });
  }
}

/** Resend's own `approve` for this send, located: what a person runs at their own terminal under `confirm`. */
function approveCommand(handoffs: CliHandoffs, approvalId: string) {
  return handoffs.own(['approve', approvalId]);
}

/** Resend's own `send status` for this send, located: how a send whose outcome is not known is checked. */
function statusCommand(handoffs: CliHandoffs, approvalId: string, name: string) {
  return handoffs.own(['send', 'status', approvalId, '--account', name]);
}

/**
 * Whether the From domain may send, checked before an approval exists.
 *
 * With a full-access key: the domain must be in the team's list, `verified`, and able to send. A sending-only key
 * cannot read the list; its declared domain, when there is one, must be the From domain, and the preview says the
 * verification could not be checked here — Resend refuses an unverified domain itself.
 */
async function checkFromDomain(context: ResendContext, named: NamedAccount, domain: string): Promise<string> {
  if (keyPermissionOf(named.account) === 'sending_access') {
    if (named.account.domainLock && named.account.domainLock !== domain) {
      throw new CommsError('BAD_DATA', `this key was declared to send only from ${named.account.domainLock}`, {
        hint: `Send from an address at ${named.account.domainLock}.`,
      });
    }
    return `From domain ${domain}: not checked — a sending-only key cannot read the domain list; Resend refuses an unverified domain`;
  }
  const page = await resendRequest<{
    data?: { name?: unknown; status?: unknown; capabilities?: { sending?: unknown } }[];
  }>(await context.transport(named), 'GET', '/domains');
  const found = (page.data ?? []).find((entry) => String(entry.name ?? '').toLowerCase() === domain);
  if (!found) {
    throw new CommsError(
      'BAD_DATA',
      `${domain} is not one of this Resend team's domains, so nothing can be sent from it`,
      {
        // With the account: `domains` without `--account` is a command commander refuses.
        hint: handoffSentence(
          context.handoffs.own(['domains', '--account', named.name]),
          (command) => `Send from an address at a verified domain: see ${command}.`,
        ),
      },
    );
  }
  if (found.status !== 'verified') {
    throw new CommsError('BAD_DATA', `${domain} is not verified at Resend (status: ${String(found.status)})`, {
      hint: handoffSentence(
        context.handoffs.own(['domains', '--account', named.name, '--domain', domain]),
        (command) => `A person finishes the DNS records for it first: ${command} lists them.`,
      ),
    });
  }
  const sending = found.capabilities?.sending;
  if (sending !== undefined && sending !== 'enabled') {
    throw new CommsError('BAD_DATA', `${domain} is verified, but sending from it is ${String(sending)}`);
  }
  return `From domain ${domain}: verified for sending at Resend`;
}

interface RecipientStudy {
  notes: Record<string, string>;
  flags: string[];
  /** For the preview's warnings: what is known about a Reply-To, which has no note of its own on its line. */
  warnings: string[];
}

/**
 * Who the email reaches, and what that means for the policy.
 *
 * The Reply-To is studied as a recipient is. It receives nothing itself, but every answer the recipients send goes
 * there: mail that says "reply to me at drop@evil.test" steers the replies as surely as a recipient steers the mail.
 */
async function studyRecipients(
  context: ResendContext,
  named: NamedAccount,
  message: OutboundMessage,
  riskEscalation: boolean,
): Promise<RecipientStudy> {
  const records = new SendRecords(context.core.paths.stateDir, context.now);
  const reach = uniqueRecipients(message);
  const notes: Record<string, string> = {};
  const flags: string[] = [];
  const warnings: string[] = [];
  const seenInMail = async (address: string): Promise<boolean> => {
    const seen = await context.core.taint.check(address);
    return (seen.address || seen.domain) && !(await records.hasSentTo(named.account.id, address));
  };
  let tainted = false;
  let replyToTainted = false;
  if (riskEscalation) {
    for (const address of reach) {
      if (await seenInMail(address)) {
        tainted = true;
        notes[address] = 'ADDRESS SEEN IN MAIL YOU READ · never written to from here';
      }
    }
    for (const address of message.replyTo.filter((candidate) => candidate !== message.fromAddress)) {
      if (await seenInMail(address)) {
        replyToTainted = true;
        warnings.push(
          `Reply-To ${address}: seen in mail you read, never written to from here — the recipients' replies go there`,
        );
      }
    }
  }
  if (tainted) flags.push('recipient-tainted');
  if (replyToTainted) flags.push('reply-to-tainted');
  if (reach.length > REACH_CONFIRM_THRESHOLD) flags.push(`reach-above-${REACH_CONFIRM_THRESHOLD}`);
  for (const address of message.bcc) notes[address] = notes[address] ? `BCC · ${notes[address]}` : 'BCC';
  return { notes, flags, warnings };
}

function expectationOf(message: OutboundMessage): Expectation {
  return { to: [...message.to], cc: [...message.cc], bcc: [...message.bcc], subject: message.subject };
}

/**
 * The preview's policy line. Under `confirm` it names Resend's own `approve`, located by the process that renders it —
 * the preparing one, then the approving one: a send's approval is bound to the message's digest, not to this line.
 */
function describePolicy(
  effective: SendPolicy,
  approvalId: string,
  flags: readonly string[],
  handoffs: CliHandoffs,
): string {
  if (effective === 'confirm') {
    const why = flags.length > 0 ? ` (${flags.join(', ')})` : '';
    return `Policy: confirm${why} — ${handoffSentence(
      approveCommand(handoffs, approvalId),
      (command) => `a person runs ${command} at their own terminal before this can go.`,
      { instead: 'a person approves it at their own terminal before this can go.' },
    )}`;
  }
  return 'Policy: chat — send only after the user approves this exact preview.';
}

function previewOf(options: {
  name: string;
  approvalId: string;
  built: Pick<BuiltMessage, 'message' | 'links' | 'warnings'>;
  study: RecipientStudy;
  domainNote: string;
  effective: SendPolicy;
  flags: readonly string[];
  handoffs: CliHandoffs;
}): string {
  const { message } = options.built;
  const reach = uniqueRecipients(message);
  const warnings = [
    `Reach: ${reach.length} unique recipient(s) — To ${message.to.length} · Cc ${message.cc.length} · Bcc ${message.bcc.length}${
      reach.length > REACH_CONFIRM_THRESHOLD
        ? ` — more than ${REACH_CONFIRM_THRESHOLD}, so a person approves it at a terminal`
        : ''
    }`,
    options.domainNote,
    ...(message.bcc.length > 0 ? [`${message.bcc.length} blind recipient(s) — the others will not see them`] : []),
    ...(message.scheduledAt
      ? [
          // The id is Resend's, known once it is sent: a word to fill in, after the account, which is known now.
          handoffSentenceToFill(
            options.handoffs.own(['scheduled', 'cancel', '--account', options.name]),
            ['<id>'],
            (command) => `Scheduled for ${message.scheduledAt}; until then it can be cancelled with ${command}`,
            {
              instead: `Scheduled for ${message.scheduledAt}; until then it can be cancelled with resend_scheduled_cancel.`,
            },
          ),
        ]
      : ['Sends as soon as it is approved and executed']),
    ...options.study.warnings,
    ...options.built.warnings,
  ];
  const preview: MessagePreview = {
    recipients: {
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: message.replyTo.filter((address) => address !== message.fromAddress),
    },
    subject: message.subject,
    body: message.text,
    attachments: message.attachments.map(({ filename, size, contentType }) => ({
      filename,
      size,
      mimeType: contentType,
    })),
    context: {
      inbox: options.name,
      approvalId: options.approvalId,
      note: `nothing has been sent · reaches ${reach.length}`,
    },
    recipientNotes: options.study.notes,
    thread: message.inReplyTo
      ? `reply to ${message.inReplyTo}${message.references.length > 1 ? ` (${message.references.length} references)` : ''}`
      : undefined,
    links: options.built.links,
    warnings,
    policy: describePolicy(options.effective, options.approvalId, options.flags, options.handoffs),
  };
  return renderMessagePreview(preview);
}

async function attachPolicy(context: ResendContext) {
  const config = await context.config();
  return {
    configDir: context.core.paths.configDir,
    env: context.env,
    roots: config.defaults.attachRoots,
    deny: config.defaults.attachDeny,
    // For the command the jail's refusal names, core's `attach roots add`: located from here.
    handoffs: context.handoffs,
  };
}

/**
 * Step one. Builds and checks the message, refuses a From on an unverified domain, and records an approval bound to
 * this exact content. Nothing is sent; preparing twice is free.
 */
export async function prepareSend(context: ResendContext, name: string, input: SendInput): Promise<SendPreparation> {
  // First: the configuration this send's epoch is read from is version 3, and an earlier release's records are retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const named = await context.accounts.require(name);
  requireSendMode(named, context.handoffs);
  const config = await context.config();
  const livePolicy = named.account.sendPolicy ?? config.defaults.sendPolicy;
  if (livePolicy === 'never') {
    throw new CommsError('POLICY_NEVER', `sending from ${name} is turned off (policy: never)`, {
      hint: handoffSentence(
        context.handoffs.own(['account', 'policy', name, '--send', 'confirm']),
        (command) => `A person can change it with ${command}.`,
      ),
    });
  }
  const built = await buildMessage(input, { now: context.now(), attach: await attachPolicy(context) });
  const domainNote = await checkFromDomain(context, named, built.message.fromDomain);
  const study = await studyRecipients(context, named, built.message, config.defaults.riskEscalation);
  const requiredPolicy: SendPolicy = study.flags.length > 0 ? 'confirm' : 'chat';
  const effective = stricterPolicy(livePolicy, requiredPolicy);
  const digest = digestOf(built.message);
  const preparedId = newPreparedId();

  const record = await context.core.approvals.create({
    channel: 'resend',
    inboxId: named.account.id,
    inboxSub: named.account.userId,
    draftId: preparedId,
    // A prepared message has no revision of its own: the same bytes are the same message, so the digest stands in.
    draftMessageId: digest,
    contentDigest: digest,
    sendEpoch: sendEpochOf(config, named.account.id),
    policy: livePolicy,
    requiredPolicy,
    riskFlags: study.flags,
    expect: expectationOf(built.message),
  });
  const prepared: PreparedMessage = {
    preparedId,
    accountId: named.account.id,
    message: built.message,
    digest,
    links: built.links,
    warnings: [domainNote, ...built.warnings],
    createdAt: context.now().toISOString(),
  };
  await new PreparedStore(context.core.paths.stateDir).put(prepared);
  await context.core.audit.append({
    inboxId: named.account.id,
    alias: name,
    operation: 'resend.send.prepare',
    outcome: 'ok',
    surface: context.surface,
    approvalId: record.approvalId,
    reason: study.flags.length > 0 ? `escalated: ${study.flags.join(', ')}` : `policy ${effective}`,
  });

  const reach = uniqueRecipients(built.message).length;
  return {
    approvalId: record.approvalId,
    account: name,
    preview: previewOf({
      name,
      approvalId: record.approvalId,
      built,
      study,
      domainNote,
      effective,
      flags: study.flags,
      handoffs: context.handoffs,
    }),
    policy: livePolicy,
    effectivePolicy: effective,
    riskFlags: study.flags,
    reach,
    expect: record.expect,
    expiresAt: record.expiresAt,
    nextStep:
      effective === 'confirm'
        ? `${approveAndWaitSentence(
            context.handoffs,
            context.surface,
            record.approvalId,
            // The person's `approve`, and the wait that learns when they have used it, as this surface takes it (§D7).
            (command, wait) =>
              `Show the preview to the user, then have them run ${command} in their own terminal${
                wait === undefined ? '' : `; learn when they have with ${wait}`
              }.`,
            { instead: 'Show the preview to the user; they approve it at their own terminal.' },
          )} You cannot approve this yourself. Then execute it with the same approval id and the recipients and subject shown.`
        : 'Show the preview to the user verbatim and wait for an explicit yes. Then execute it with the same approval id and the recipients and subject shown above.',
    approval: await context.core.approvals.approvalOf(record),
    ...(legacyDrain === undefined ? {} : { legacyDrain }),
  };
}

/** The stored message and its attachments' bytes, checked again: a file changed since the preview voids the send. */
async function reload(
  context: ResendContext,
  record: ApprovalRecord,
): Promise<{ prepared: PreparedMessage; digest: string; contents: Uint8Array[] }> {
  const prepared = await new PreparedStore(context.core.paths.stateDir).get(record.draftId);
  if (!prepared || prepared.accountId !== record.inboxId) {
    throw new CommsError('NOT_FOUND', 'the message this approval was prepared for is no longer on this machine', {
      hint: 'Prepare the send again.',
    });
  }
  const contents: Uint8Array[] = [];
  const attachments = [];
  for (const attachment of prepared.message.attachments) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(attachment.path));
    } catch {
      bytes = new Uint8Array();
    }
    contents.push(bytes);
    attachments.push({ ...attachment, size: bytes.byteLength, sha256: sha256Hex(bytes) });
  }
  return { prepared, digest: digestOf({ ...prepared.message, attachments }), contents };
}

/** The request body, built from the stored message and nothing else. */
function payloadOf(
  message: OutboundMessage,
  approvalId: string,
  contents: readonly Uint8Array[],
): Record<string, unknown> {
  const headers: Record<string, string> = {};
  if (message.inReplyTo) headers['In-Reply-To'] = message.inReplyTo;
  if (message.references.length > 0) headers.References = message.references.join(' ');
  return {
    from: message.from,
    to: message.to,
    ...(message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    ...(message.replyTo.length > 0 ? { reply_to: message.replyTo } : {}),
    subject: message.subject,
    // Always given, so Resend never derives a text part the preview did not show.
    text: message.text,
    ...(message.html === null ? {} : { html: message.html }),
    ...(message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment, index) => ({
            filename: attachment.filename,
            content_type: attachment.contentType,
            content: Buffer.from(contents[index] ?? new Uint8Array()).toString('base64'),
          })),
        }
      : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(message.scheduledAt ? { scheduled_at: message.scheduledAt } : {}),
    tags: [{ name: APPROVAL_TAG, value: approvalId }],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keeps the failure that stopped the send visible, adding what it means when it does not say so already — nothing was
 * sent (design 2026-10-05 §D2, `failed`) — and only what could not be settled afterwards, with where the approval stands
 * now that it is settled (decision 8), whatever the failure said of it before.
 */
function noSendError(error: unknown, unrecorded: readonly string[], approval: ApprovalObject): CommsError {
  const original =
    error instanceof CommsError ? error : new CommsError('UNEXPECTED', messageOf(error), { cause: error });
  const saysSo = /\bnothing was sent\b/i.test(`${original.message} ${original.hint ?? ''}`);
  const hint = [original.hint, saysSo ? undefined : 'Nothing was sent.', ...unrecorded].filter(
    (part) => part !== undefined,
  );
  return new CommsError(original.code, original.message, {
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
  context: ResendContext,
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
 * Settles a failure known to have happened before Resend sent anything, without one failed write skipping another.
 *
 * `approval` is `settled` when the approval was completed already — by the fence, which records why itself — and only
 * the rest is recorded here.
 */
async function recordNoSend(
  context: ResendContext,
  records: SendRecords,
  options: { name: string; accountId: string; approvalId: string },
  // The claim's own token, kept apart from what is recorded: only the call that claimed records the outcome.
  claimToken: string,
  // Where the approval stood when it was claimed: what the refusal says if its failure cannot be recorded.
  claimed: ApprovalObject,
  error: unknown,
  approval: 'complete' | 'settled' = 'complete',
): Promise<CommsError> {
  const unrecorded: string[] = [];
  const said = messageOf(error);
  let settled = claimed;
  try {
    await records.release(options.accountId, options.approvalId);
  } catch (failure) {
    unrecorded.push(`the capacity slot could not be released (${messageOf(failure)})`);
  }
  if (approval === 'settled') {
    settled = await approvalNow(context, options.approvalId, options.accountId, claimed);
  } else {
    try {
      settled = await context.core.approvals.approvalOf(
        await context.core.approvals.complete(options.approvalId, claimToken, { error: said }),
      );
    } catch (failure) {
      unrecorded.push(`the approval could not be marked failed (${messageOf(failure)})`);
    }
  }
  try {
    await records.record(options.accountId, {
      approvalId: options.approvalId,
      event: 'failed',
      error: said.slice(0, 300),
    });
  } catch (failure) {
    unrecorded.push(`the send record could not record the failure (${messageOf(failure)})`);
  }
  try {
    await context.core.audit.append({
      inboxId: options.accountId,
      alias: options.name,
      operation: 'resend.send.execute',
      outcome: 'failed',
      surface: context.surface,
      approvalId: options.approvalId,
      reason: [said.slice(0, 200), ...unrecorded].join('; '),
    });
  } catch (failure) {
    unrecorded.push(`the audit log could not record the failure (${messageOf(failure)})`);
  }
  return noSendError(error, unrecorded, settled);
}

/**
 * What Resend's acceptance means, in words (design 2026-10-05 §D2, §D8): a send that goes now is sent; a scheduled one is
 * accepted, for the time the request asked for — never "sent". Without an id, each says so, and nothing more.
 */
function acceptedSaid(withId: boolean, scheduledAt: string | null): string {
  if (!withId) {
    return scheduledAt ? 'accepted (scheduled); the provider returned no id' : 'sent; the provider returned no id';
  }
  return scheduledAt ? `accepted by Resend, scheduled for ${scheduledAt}` : 'sent';
}

/**
 * Step three, and the only place mail leaves.
 *
 * The order is the guarantee: claim the approval once, reserve a slot, record the attempt, open a permit for one
 * request, send — never retried, because a retried send may deliver twice.
 */
export async function executeSend(
  context: ResendContext,
  name: string,
  options: { approvalId: string; expect: Expectation },
): Promise<SendResult> {
  // First, as every claim does: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const named = await context.accounts.require(name);
  requireSendMode(named, context.handoffs);
  // Before anything else, as the claim would: this account's send, classified under its lock (design 2026-10-05 §D2).
  // An outcome nobody knows says so with its own code, and where to look: `send status`.
  const { record: known, approval: seen } = await ownRecord(context, named, options.approvalId).catch(
    (error: unknown) => {
      if (error instanceof CommsError && error.code === 'SEND_OUTCOME_UNKNOWN') {
        throw new CommsError(error.code, error.message, {
          hint: handoffSentence(
            statusCommand(context.handoffs, options.approvalId, name),
            (command) => `${error.hint ?? ''} Check what happened with ${command} before anything else.`.trim(),
            { instead: `${error.hint ?? ''} Check what happened with resend_send_status before anything else.`.trim() },
          ),
          ...(error.details === undefined ? {} : { details: error.details }),
        });
      }
      throw error;
    },
  );
  // Until the claim, a refusal says where the approval stands, as it was classified.
  return claimAndSend(context, named, name, options, known, seen, legacyDrain).catch((error: unknown) => {
    throw withApproval(error, seen);
  });
}

/** {@link executeSend}, once the approval is classified: from the message's reload to the one request that sends. */
async function claimAndSend(
  context: ResendContext,
  named: NamedAccount,
  name: string,
  options: { approvalId: string; expect: Expectation },
  known: ApprovalRecord,
  _seen: ApprovalObject,
  legacyDrain: LegacyDrainReport | undefined,
): Promise<SendResult> {
  const config = await context.config();
  const livePolicy = named.account.sendPolicy ?? config.defaults.sendPolicy;
  const { prepared, digest, contents } = await reload(context, known);
  // Everything that can refuse without sending does so before the approval is spent: the key, and a stop Resend asked for.
  const permit = closedPermit();
  const transport = await context.transport(named, permit);
  const blocked = await transport.throttle.blockedUntil();
  if (blocked !== null) {
    throw new CommsError('TRANSIENT', 'Resend asked this machine to stop for now (rate limit); nothing was sent', {
      hint: `The approval is untouched. Try again after ${blocked}.`,
      details: { blockedUntil: blocked },
    });
  }

  const {
    record: claimed,
    claimToken,
    approval: claimedApproval,
  } = await context.core.approvals.claimForSend(
    options.approvalId,
    {
      draftMessageId: digest,
      contentDigest: digest,
      inboxId: named.account.id,
      inboxSub: named.account.userId,
      expect: options.expect,
    },
    {
      pendingHint: `${approveAndWaitSentence(
        context.handoffs,
        context.surface,
        options.approvalId,
        (command, wait) =>
          `Ask the user to run ${command} in their own terminal${
            wait === undefined ? ',' : `; learn when they have with ${wait},`
          } then execute it again with the same approval.`,
        { instead: 'Ask the user to approve it at their own terminal, then execute it again with the same approval.' },
      )} You cannot approve it yourself.`,
      usedSaid: ACCEPTED_BY_RESEND,
      platform: context.platform,
    },
  );

  const records = new SendRecords(context.core.paths.stateDir, context.now);
  const message = prepared.message;
  const recipients = uniqueRecipients(message);
  const bookkeeping = {
    name,
    accountId: named.account.id,
    approvalId: options.approvalId,
  };
  // Claimed: from here until its outcome is recorded, the claim's lease is renewed while Resend's work is outstanding.
  return withSendingLease(context.core.approvals, options.approvalId, claimToken, async () => {
    try {
      await records.reserve(named.account.id, options.approvalId, config.defaults.sendCaps);
    } catch (error) {
      throw await recordNoSend(context, records, bookkeeping, claimToken, claimedApproval, error);
    }
    try {
      await records.record(named.account.id, {
        approvalId: options.approvalId,
        event: 'attempt',
        recipients,
        subject: message.subject,
        scheduledAt: message.scheduledAt,
      });
      await context.core.audit.append(
        {
          inboxId: named.account.id,
          alias: name,
          operation: 'resend.send.execute',
          outcome: 'started',
          surface: context.surface,
          approvalId: options.approvalId,
          recipients: recipients.map(canonicalAddress),
        },
        { durable: true },
      );
    } catch (error) {
      throw await recordNoSend(context, records, bookkeeping, claimToken, claimedApproval, error);
    }

    /*
     * A refusal Resend gave before acting that says "later" waits and tries again, within core's pacing (design
     * 2026-10-08 §R1, §R2). The message cannot change underneath: it was reloaded and held to its digest before the
     * claim. So each attempt repeats the fence, and nothing else (§R3).
     */
    const pacing = context.sendPacing();
    let resendId: string | undefined;
    for (;;) {
      /*
       * The fence (design 2026-10-05 §D1), the last thing before the one request that sends: while this claim still
       * holds a `sending` record its lease is renewed and the request may leave. Once another caller has found the lease
       * run out — the record `unknown` — nothing is sent: the fence completes the approval `failed`
       * (`lease-lost-before-send`), and the rest of the no-send bookkeeping follows.
       */
      const fenced = await fenceOrStop(context.core.approvals, options.approvalId, claimToken, { stepsStarted: 0 });
      if (!fenced.proceed) {
        const stopped =
          fenced.error ?? new CommsError('UNEXPECTED', 'the sending lease ran out before anything was sent');
        throw await recordNoSend(context, records, bookkeeping, claimToken, claimedApproval, stopped, 'settled');
      }

      let requestIssued = false;
      const innerFetch = transport.fetch ?? (fetch as FetchLike);
      // Mark the inner fetch, after the throttle and request guard: before this runs, Resend certainly saw nothing.
      const trackedTransport = {
        ...transport,
        fetch: async (...args: Parameters<FetchLike>) => {
          requestIssued = true;
          return innerFetch(...args);
        },
      };
      try {
        const response = await spendOn(permit, options.approvalId, 'emails.send', () =>
          resendRequest<{ id?: unknown }>(trackedTransport, 'POST', '/emails', {
            body: payloadOf(message, options.approvalId, contents),
            idempotencyKey: options.approvalId,
          }),
        );
        // Resend's id, when it gave one: no id, null, an empty or blank string, or anything not a string is no id at all —
        // absent, never '' (design 2026-10-05 §D8). Resend accepted the send either way.
        resendId = typeof response.id === 'string' && response.id.trim() !== '' ? response.id : undefined;
        break;
      } catch (error) {
        if (!requestIssued) {
          throw await recordNoSend(context, records, bookkeeping, claimToken, claimedApproval, error);
        }
        const outcome: WriteOutcome =
          error instanceof CommsError && error.details?.outcome === 'not-sent'
            ? 'not-sent'
            : error instanceof CommsError && error.code === 'SEND_REFUSED'
              ? 'not-sent'
              : 'unknown';
        const said = error instanceof Error ? error.message : String(error);
        if (outcome === 'not-sent') {
          const throttle = sendThrottleOf(error, context.now().getTime());
          const delay = throttle?.limit === 'rate' ? pacing.next(throttle.waitMs) : null;
          if (delay !== null) {
            await pacing.wait(delay);
            continue;
          }
          const refusal = throttle ? throttledRefusal(throttle, pacing.retries, error) : error;
          throw await recordNoSend(context, records, bookkeeping, claimToken, claimedApproval, refusal);
        }
        const unrecorded: string[] = [];
        try {
          await records.record(named.account.id, {
            approvalId: options.approvalId,
            event: 'unknown',
            error: said.slice(0, 300),
          });
        } catch (failure) {
          unrecorded.push(
            `the send record could not record this (${failure instanceof Error ? failure.message : String(failure)})`,
          );
        }
        try {
          await context.core.audit.append({
            inboxId: named.account.id,
            alias: name,
            operation: 'resend.send.execute',
            outcome: 'failed',
            surface: context.surface,
            approvalId: options.approvalId,
            reason: `outcome unknown: ${said.slice(0, 200)}`,
          });
        } catch (failure) {
          unrecorded.push(
            `the audit log could not record this (${failure instanceof Error ? failure.message : String(failure)})`,
          );
        }
        // At once, and never retryable: the send may have happened (design 2026-10-05 §D2).
        throw new CommsError('SEND_OUTCOME_UNKNOWN', `whether the email was sent is not known: ${said}`, {
          hint: [
            `Do not send it again, and do not prepare it again until you know it did not go. ${handoffSentence(
              statusCommand(context.handoffs, options.approvalId, name),
              (command) =>
                `Check the Resend dashboard or ask the recipient, and check with ${command}; this approval is not used again.`,
              {
                instead:
                  'Check the Resend dashboard or ask the recipient, and check with resend_send_status; this approval is not used again.',
              },
            )}`,
            ...unrecorded,
          ].join(' '),
          details: {
            ...(error instanceof CommsError ? error.details : {}),
            approvalId: options.approvalId,
            outcome: 'unknown',
            // Still `sending`: nothing is recorded of a send whose outcome is not known.
            approval: await approvalNow(context, options.approvalId, named.account.id, claimedApproval),
          },
          cause: error,
        });
      }
    }

    const unrecorded: string[] = [];
    // `used` only once it is written, and only with Resend's id; until then — and for good, if it cannot be — the record
    // as it stands: sending, then unknown.
    let approval: ApprovalObject | null = null;
    if (resendId === undefined) {
      unrecorded.push('Resend returned no id, so the approval is not marked used: it reads as sending, then unknown');
    } else {
      try {
        approval = await context.core.approvals.approvalOf(
          await context.core.approvals.complete(options.approvalId, claimToken, { sentMessageId: resendId }),
        );
      } catch (error) {
        unrecorded.push(
          `the approval could not be marked used (${error instanceof Error ? error.message : String(error)}), so it will read as unknown`,
        );
      }
    }
    try {
      await records.record(named.account.id, {
        approvalId: options.approvalId,
        event: 'sent',
        ...(resendId === undefined ? {} : { resendId }),
      });
    } catch (error) {
      unrecorded.push(
        `the send record could not record it (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    try {
      await context.core.audit.append({
        inboxId: named.account.id,
        alias: name,
        operation: 'resend.send.execute',
        outcome: 'ok',
        surface: context.surface,
        approvalId: options.approvalId,
        // No id, no field: an audit row never carries an empty one.
        ...(resendId === undefined ? {} : { ids: { resendIds: [resendId] } }),
        // From the record a person approved, not from what the caller restated: the two are checked equal.
        recipients: [...claimed.expect.to, ...claimed.expect.cc, ...claimed.expect.bcc].map(canonicalAddress),
        reason: [
          ...(resendId === undefined ? ['accepted without an id'] : []),
          `digest ${digest.slice(0, 12)} · policy ${livePolicy} · ${claimed.approvedVia ?? 'chat'}`,
          ...unrecorded,
        ].join(' · '),
      });
    } catch (error) {
      unrecorded.push(`the audit log could not record it (${error instanceof Error ? error.message : String(error)})`);
    }
    return {
      account: name,
      approvalId: options.approvalId,
      ...(resendId === undefined ? {} : { resendId }),
      state: message.scheduledAt ? 'scheduled' : 'sent',
      scheduledAt: message.scheduledAt,
      said: acceptedSaid(resendId !== undefined, message.scheduledAt),
      to: claimed.expect.to,
      cc: claimed.expect.cc,
      bcc: claimed.expect.bcc,
      subject: claimed.expect.subject,
      ...(unrecorded.length > 0 ? { note: unrecorded.join('; ') } : {}),
      approval: approval ?? (await approvalNow(context, options.approvalId, named.account.id, claimedApproval)),
      ...(legacyDrain === undefined ? {} : { legacyDrain }),
    };
  });
}

// ── What happened to a send ──────────────────────────────────────────────────────────────────────────────────────

export interface SendStatus {
  account: string;
  approvalId: string;
  /**
   * The approval as a status shows it (`publicApproval`) — every form, an earlier release's and a corrupt one's
   * included, the recipients and subject only inside the untrusted-content envelope — or none.
   */
  approval: PublicApprovalView | null;
  local: SendSummary | null;
  /**
   * What Resend says now, when it could be asked: the email's id, its last event — one this version does not interpret
   * only inside the untrusted-content envelope — its Message-ID and the time it is scheduled for.
   */
  resend: { id: string; lastEvent: string | null; messageId: string | null; scheduledAt: string | null } | null;
  /**
   * The email's current outcome, from Resend's own `last_event` through one fixed mapping and attributed to it — never
   * a claim about every recipient — or "current outcome unavailable" with why. None when there is no email to ask
   * about: nothing was attempted, nothing was sent, or Resend has no email by this approval's tag.
   */
  outcome: CurrentOutcome | null;
  /** The answer, in words. */
  verdict: string;
}

const CANNOT_READ = 'this key can only send, so it cannot read what Resend did with the email';

/**
 * What this machine knows Resend accepted, from its own send record: a scheduled send is accepted for the time the
 * request asked for, never "sent"; one with no id says so (design 2026-10-05 §D2, §D8).
 */
function acceptanceOf(local: SendSummary): string {
  if (local.resendId === undefined) {
    return local.scheduledAt
      ? 'accepted (scheduled); the provider returned no id'
      : 'accepted by Resend; the provider returned no id';
  }
  return local.scheduledAt
    ? `accepted by Resend, scheduled for ${local.scheduledAt}, as ${local.resendId}`
    : `accepted by Resend as ${local.resendId}`;
}

/** An outcome in the verdict's words: Resend's, or that it is unavailable and why. */
function outcomeWords(outcome: CurrentOutcome): string {
  return outcome.source === 'resend' ? outcome.said : `${outcome.said} (${outcome.why})`;
}

/**
 * What is known about a send: the approval, the local record, and — for an email Resend accepted, or one whose outcome
 * is not known — what Resend's own last event says now (design 2026-10-05 §D2, the `used` send row). Read only. It
 * never sends, and never repeats a send to find out.
 *
 * Nothing here is "sent" because this machine recorded Resend's acceptance, or because a scheduled time has passed:
 * only Resend's own event, through `outcomeOf`, says that. "Cancelled from this machine before sending" needs this
 * machine's own record of a cancellation Resend confirmed; without it, a cancellation is as Resend reports it.
 */
export async function sendStatus(context: ResendContext, name: string, approvalId: string): Promise<SendStatus> {
  const named = await context.accounts.require(name);
  const local = await new SendRecords(context.core.paths.stateDir, context.now).summary(named.account.id, approvalId);
  /*
   * Looked at under its lock, this account's send or the one NOT_FOUND (design 2026-10-05 §D2): another account's,
   * another kind's, one whose owner cannot be trusted and one nobody prepared alike — unless this account's own send
   * record knows the id, when its approval is simply gone.
   */
  const seen = await context.core.approvals
    .inspect(approvalId, { kind: 'send', owner: named.account.id })
    .catch((error: unknown) => {
      if (error instanceof CommsError && error.code === 'NOT_FOUND' && local !== null) return null;
      throw error;
    });
  const stored = seen?.stored ?? null;
  // Shown as the look classified it, what a sender wrote only inside its envelope (design 2026-10-05 §D8).
  const approval = seen ? publicApproval(seen.stored, seen.outcome) : null;
  const base = { account: name, approvalId, approval, local };
  if (!local) {
    return {
      ...base,
      resend: null,
      outcome: null,
      verdict: stored
        ? `not sent: the approval is ${stateOf(stored)} and no send was attempted`
        : 'nothing is known about this approval',
    };
  }
  if (local.state === 'failed') {
    // Certain: Resend was never asked, or refused before acting.
    const why = (local.error ?? 'no reason recorded').replace(/^nothing was sent: /i, '');
    return { ...base, resend: null, outcome: null, verdict: `nothing was sent: ${why}` };
  }

  const readable = keyPermissionOf(named.account) === 'full_access';
  const cancelledHere = local.state === 'cancelled';
  const facts = { scheduledAt: local.scheduledAt ?? null, cancelledHere };
  const transport = readable ? await context.transport(named) : null;
  /** Resend's own word on one email. A look-up that fails is an outcome that is unavailable, never a failed status. */
  const lookUp = async (id: string): Promise<{ resend: SendStatus['resend']; outcome: CurrentOutcome }> => {
    if (transport === null) return { resend: null, outcome: outcomeUnavailable(CANNOT_READ) };
    let email: { last_event?: unknown; message_id?: unknown; scheduled_at?: unknown };
    try {
      email = await resendRequest(transport, 'GET', `/emails/${id}`);
    } catch (error) {
      if (!(error instanceof CommsError)) throw error;
      return { resend: null, outcome: outcomeUnavailable(`Resend could not be asked: ${error.message}`) };
    }
    const outcome = outcomeOf(email.last_event, facts, { account: name, id });
    return {
      resend: {
        id,
        // The event as the mapping read it: an uninterpreted one only as its wrapped value.
        lastEvent:
          outcome.source !== 'resend'
            ? null
            : outcome.lastEvent === 'uninterpreted'
              ? (outcome.raw ?? null)
              : outcome.lastEvent,
        messageId: typeof email.message_id === 'string' ? email.message_id : null,
        scheduledAt: typeof email.scheduled_at === 'string' ? email.scheduled_at : null,
      },
      outcome,
    };
  };
  /**
   * The email this approval sent, found by its tag among the 100 most recent with its subject — when Resend gave no id,
   * or the outcome was never known. Bounded, and read only.
   */
  const byTag = async (): Promise<string | null> => {
    if (transport === null) return null;
    const page = await resendRequest<{ data?: { id?: unknown; subject?: unknown }[] }>(transport, 'GET', '/emails', {
      query: { limit: 100 },
    });
    const candidates = (page.data ?? [])
      .filter((email) => typeof email.id === 'string' && email.subject === local.subject)
      .slice(0, 5);
    for (const candidate of candidates) {
      const email = await resendRequest<{ tags?: { name?: unknown; value?: unknown }[] }>(
        transport,
        'GET',
        `/emails/${String(candidate.id)}`,
      );
      if ((email.tags ?? []).some((tag) => tag.name === APPROVAL_TAG && tag.value === approvalId)) {
        return String(candidate.id);
      }
    }
    return null;
  };
  const searched = async (): Promise<{ id: string | null } | { failed: string }> => {
    try {
      return { id: await byTag() };
    } catch (error) {
      if (!(error instanceof CommsError)) throw error;
      return { failed: `Resend could not be asked: ${error.message}` };
    }
  };

  if (local.state === 'sent' || local.state === 'cancelled') {
    // Resend accepted it. What has become of it since is Resend's to say.
    const accepted = acceptanceOf(local);
    // This machine's own record of a cancellation Resend confirmed: said whatever Resend can be asked now.
    const here = cancelledHere ? '; cancelled from this machine before sending' : '';
    if (transport === null) {
      const outcome = outcomeUnavailable(CANNOT_READ);
      return { ...base, resend: null, outcome, verdict: `${accepted}${here}; ${outcomeWords(outcome)}` };
    }
    let id = local.resendId;
    let found = '';
    if (id === undefined) {
      const search = await searched();
      if ('failed' in search || search.id === null) {
        const outcome = outcomeUnavailable(
          'failed' in search ? search.failed : 'not found by its approval tag among the 100 most recent sent emails',
        );
        return { ...base, resend: null, outcome, verdict: `${accepted}; ${outcomeWords(outcome)}` };
      }
      id = search.id;
      found = `; found by its approval tag as ${id}`;
    }
    const { resend, outcome } = await lookUp(id);
    // Resend's own `canceled` says it was this machine already, when this machine's record proves it; any other word,
    // or none, is said beside that record.
    const alsoHere = outcome.source === 'resend' && outcome.lastEvent === 'canceled' ? '' : here;
    return { ...base, resend, outcome, verdict: `${accepted}${found}${alsoHere}; ${outcomeWords(outcome)}` };
  }

  // The outcome was never known: Resend may have the email or not.
  if (transport === null) {
    return {
      ...base,
      resend: null,
      outcome: outcomeUnavailable(CANNOT_READ),
      verdict: `unknown, and this key cannot read sent mail. Look in the Resend dashboard for an email tagged ${APPROVAL_TAG}=${approvalId}; do not send it again`,
    };
  }
  const search = await searched();
  if ('failed' in search) {
    const outcome = outcomeUnavailable(search.failed);
    return {
      ...base,
      resend: null,
      outcome,
      verdict: `unknown: ${outcomeWords(outcome)}. Do not send it again under this approval; check again later`,
    };
  }
  if (search.id === null) {
    return {
      ...base,
      resend: null,
      outcome: null,
      verdict: `not found among the 100 most recent sent emails — probably not sent, but do not send it again under this approval; prepare a new one if it should go`,
    };
  }
  const { resend, outcome } = await lookUp(search.id);
  return {
    ...base,
    resend,
    outcome,
    verdict: `accepted by Resend as ${search.id}: found by its approval tag; ${outcomeWords(outcome)}`,
  };
}

// ── Approval at a terminal ───────────────────────────────────────────────────────────────────────────────────────

export interface SendApprovalPrompt {
  approvalId: string;
  account: string;
  preview: string;
  /** Printed to the person, never returned to an agent. */
  challenge: string;
}

/**
 * An approval at the terminal, and the account it belongs to: one that cannot be used is refused for what it is, and
 * says only that — this command is no account's in particular — and whose it is comes from `ownerOf`.
 */
async function recordAndAccount(
  context: ResendContext,
  approvalId: string,
): Promise<{ record: ApprovalRecord; named: NamedAccount }> {
  /*
   * Classified under its lock for the approval a person is about to give (design 2026-10-05 §D2): a Resend send's, or
   * the one NOT_FOUND — another channel's is not found, as one nobody prepared is not. One that cannot be approved is
   * refused for what it is, with where it stands — corrupt, an earlier release's, expired, used, revoked (now, if its
   * account was removed or sending turned off) — before the message is read again.
   */
  const { outcome } = await context.core.approvals.inspect(
    approvalId,
    { kind: 'send', channel: 'resend' },
    { action: 'approve', usedSaid: ACCEPTED_BY_RESEND },
  );
  if (outcome.error) throw outcome.error;
  const record = outcome.record;
  if (record === null) throw new CommsError('UNEXPECTED', 'a send approval read as no record');
  const named = await context.accounts.findById(record.inboxId);
  if (!named) {
    throw (
      outcome.error ?? new CommsError('NOT_FOUND', 'the Resend account this approval belongs to is no longer connected')
    );
  }
  return { record, named };
}

/**
 * Re-reads the stored message, renders the preview a person is about to approve, and issues the code they type back.
 * A message or attachment that changed since the preview voids the approval: the person would be approving something
 * the record does not describe.
 */
export async function beginSendApproval(context: ResendContext, approvalId: string): Promise<SendApprovalPrompt> {
  // Classified before the message is read again: the integrity check below would judge any other form by rules it was
  // not written under.
  const { record, named } = await recordAndAccount(context, approvalId);
  const { prepared, digest } = await reload(context, record).catch(async (error: unknown) => {
    throw withApproval(error, await context.core.approvals.approvalOf(record));
  });
  if (digest !== record.contentDigest) {
    const voided = await context.core.approvals.revoke(
      approvalId,
      'the message or an attachment changed after the preview',
      { disposition: 'integrity', expect: { kind: 'send' } },
    );
    throw new CommsError('APPROVAL_VOID', 'nothing was sent: the message or an attachment changed after the preview', {
      hint: 'Prepare the send again to see what it says now.',
      details: {
        approvalId,
        approval: voided.form === 'v2' ? await context.core.approvals.approvalOf(voided.record) : null,
      },
    });
  }
  const config = await context.config();
  const study = await studyRecipients(context, named, prepared.message, config.defaults.riskEscalation);
  const live = named.account.sendPolicy ?? config.defaults.sendPolicy;
  const effective = stricterPolicy(live, record.requiredPolicy);
  const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform, {
    usedSaid: ACCEPTED_BY_RESEND,
  });
  return {
    approvalId,
    account: named.name,
    preview: previewOf({
      name: named.name,
      approvalId,
      built: { message: prepared.message, links: prepared.links, warnings: prepared.warnings.slice(1) },
      study,
      domainNote: prepared.warnings[0] ?? '',
      effective,
      flags: record.riskFlags,
      handoffs: context.handoffs,
    }),
    challenge,
  };
}

export async function finishSendApproval(
  context: ResendContext,
  approvalId: string,
  answer: string,
): Promise<ApprovalRecord> {
  // First, as every approval does: version 3, and an earlier release's records retired.
  await ensureSendEpochConfig(context.core, { now: context.now });
  const { record, named } = await recordAndAccount(context, approvalId);
  const { digest } = await reload(context, record).catch(async (error: unknown) => {
    throw withApproval(error, await context.core.approvals.approvalOf(record));
  });
  const approved = await context.core.approvals.approve(
    approvalId,
    'terminal',
    { draftMessageId: digest, contentDigest: digest },
    answer,
    'send',
    context.platform,
    { usedSaid: ACCEPTED_BY_RESEND },
  );
  await context.core.audit.append({
    inboxId: named.account.id,
    alias: named.name,
    operation: 'resend.send.approve',
    outcome: 'ok',
    surface: context.surface,
    approvalId,
    reason: 'approved at a terminal',
  });
  return approved;
}

/** Cancels an approval. Anyone may: refusing to send is never the dangerous direction. */
export async function revokeSendApproval(context: ResendContext, approvalId: string): Promise<void> {
  /*
   * A send's, looked at under its lock, or the one NOT_FOUND; one that cannot be read is refused with only its stub. A
   * person's no reaches any other — an earlier release's is retired in its own shape — and a finished one is left as
   * it is, by the store.
   */
  const { stored, outcome } = await context.core.approvals.inspect(approvalId, { kind: 'send' });
  if (stored.form === 'corrupt' || stored.form === 'unreadable') throw outcome.error ?? integrityRefusal(stored);
  const owner = ownerOf(stored);
  const named = owner === null ? undefined : await context.accounts.findById(owner);
  if (!named) throw new CommsError('NOT_FOUND', 'the Resend account this approval belongs to is no longer connected');
  await context.core.approvals.revoke(approvalId, 'cancelled at the terminal', { disposition: 'person' });
  await context.core.audit.append({
    inboxId: named.account.id,
    alias: named.name,
    operation: 'resend.send.revoke',
    outcome: 'ok',
    surface: context.surface,
    approvalId,
  });
}
