import { type ApprovalRoute, unknownAtOf } from './approval-binding.ts';
import { type CorruptStub, corruptStubOf, integrityRefusal, type StoredApproval } from './approval-stored.ts';
import { CLOCK_ANOMALY } from './approval-validate.ts';
import {
  type ApprovalKind,
  type ApprovalRecord,
  type ApprovalState,
  otherVersionRefusal,
  stricterPolicy,
} from './approvals.ts';
import { channelLabel, isChannel } from './channel-servers.ts';
import { accountNoun } from './channel-words.ts';
import {
  type ChangePolicy,
  type Config,
  defaultChangePolicy,
  governingChangePolicy,
  type SendPolicy,
} from './config.ts';
import { CommsError, type ErrorCode } from './errors.ts';
import { sendEpochOf } from './send-epoch.ts';
import { newBoundary, wrapUntrusted } from './untrusted.ts';

/**
 * One locked classification of every record into an outcome (design 2026-10-05 §D2).
 *
 * `approvalOutcome` says what a record is now — its state, whether it can be claimed, and what an action on it would be
 * told — from the record as it was read under its own lock and the configuration read in that same lock (`LiveGate`).
 * Nothing here reads a file or a clock of its own, and nothing here writes: the store persists what the outcome
 * derives, and only from inside the lock it was classified under.
 */

/** What is being done with the record: an approval, a claim, a wait, a revoke, or a look. */
export type OutcomeAction = 'approve' | 'claim' | 'wait' | 'revoke' | 'inspect';

/**
 * What the configuration says now about a record's owner: whether it exists, how sending and changes are approved for
 * it, and its send epoch. Built by `liveGateOf` from the one configuration snapshot a locked transition read.
 */
export interface LiveGate {
  /**
   * `present` — the owner the record names exists; `removed` — an `owner`-scope record whose mailbox or account is
   * gone; `none` — a record with no owner to look for (`prospective` or `global`).
   */
  readonly owner: 'present' | 'removed' | 'none';
  /** The owner's effective send policy: its own, else the default. Only for a present owner. */
  readonly sendPolicy?: SendPolicy | undefined;
  /**
   * The change policy that governs it: a change's governing policy (`governingChangePolicy`), or for a download the
   * change policy of the account its files come from. Never for a removed owner: none is assumed.
   */
  readonly changePolicy?: ChangePolicy | undefined;
  /** The owner's send epoch (`sendEpochOf`). Only for a present owner. */
  readonly sendEpoch?: number | undefined;
}

/** The mailbox or account a record's owner id names in `config`, or undefined when there is none. */
function ownerEntry(
  config: Config,
  ownerId: string,
): { sendPolicy?: SendPolicy | undefined; changePolicy?: ChangePolicy | undefined } | undefined {
  return (
    Object.values(config.inboxes).find((inbox) => inbox.id === ownerId) ??
    Object.values(config.accounts).find((account) => account.id === ownerId)
  );
}

/**
 * The live gate of one record, from one configuration snapshot. Pure: the caller reads the configuration — once, inside
 * the record's lock — and passes it here.
 *
 * Only an `owner`-scope record can have lost its owner, found by the id it stores: a mailbox or account re-added under
 * the same name has a new id, so it never owns an old record again. For a removed owner nothing is assumed — no
 * default policy, no epoch 0.
 */
export function liveGateOf(
  config: Config,
  record: Pick<ApprovalRecord, 'kind' | 'ownerScope' | 'inboxId' | 'change'>,
): LiveGate {
  const governing = (fallback: ChangePolicy): ChangePolicy =>
    record.kind === 'change' && record.change !== undefined ? governingChangePolicy(config, record.change) : fallback;
  if (record.ownerScope !== 'owner') return { owner: 'none', changePolicy: governing(defaultChangePolicy(config)) };
  const entry = ownerEntry(config, record.inboxId);
  if (entry === undefined) return { owner: 'removed' };
  return {
    owner: 'present',
    sendPolicy: entry.sendPolicy ?? config.defaults.sendPolicy,
    changePolicy: governing(entry.changePolicy ?? defaultChangePolicy(config)),
    sendEpoch: sendEpochOf(config, record.inboxId),
  };
}

/** The reason a record whose owner was removed is revoked with. */
export const OWNER_REMOVED_REASON = 'its mailbox or account was removed';
/** The reason a send prepared before a `never` is revoked with: its stored epoch is behind the live one. */
export const SEND_EPOCH_REASON = 'sending was turned off since this was prepared (policy: never)';
/** What an outcome says of a pending or approved send under a live `never`, before anything revokes it. */
export const NEVER_NOTICE = 'sending is turned off (policy: never); any use revokes it';
/** The refusal of a claim, an approval or an answer by a store opened without a configuration. */
export const NO_CONFIGURATION = 'this approval store was opened without a configuration';

/** A record's state as anyone may be told it: a download's answered question says `answered`. */
export type PublicApprovalState = ApprovalState | 'corrupt' | 'answered';

/**
 * Where an approval stands, as every surface may show it (design 2026-10-05 §D8): its id, kind, channel, state and
 * whether it can be claimed, with the timestamps its state carries. Never a challenge hash, and nothing a sender wrote.
 */
export interface ApprovalObject {
  readonly id: string;
  readonly kind: ApprovalKind | null;
  readonly channel: string | null;
  readonly state: PublicApprovalState;
  readonly claimable: boolean;
  readonly route?: ApprovalRoute | undefined;
  readonly ownerRemoved?: true | undefined;
  /** A record from an earlier release, read by its own rules: shown, never claimed. */
  readonly legacy?: true | undefined;
  readonly reason?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly approvedAt?: string | undefined;
  readonly usableUntil?: string | undefined;
  readonly sendingAt?: string | undefined;
  readonly sendingHeartbeatAt?: string | undefined;
  /** When a `sending` record reads `unknown` (`unknownAtOf`): derived, never stored. Also on an `unknown` one. */
  readonly unknownAt?: string | undefined;
  readonly usedAt?: string | undefined;
  readonly sentAt?: string | undefined;
  readonly sentMessageId?: string | undefined;
  readonly failedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
  readonly expiredAt?: string | undefined;
}

/** What an action on a record is, now. */
export interface ApprovalOutcome {
  readonly state: PublicApprovalState;
  readonly claimable: boolean;
  readonly ownerRemoved?: true | undefined;
  readonly reason?: string | undefined;
  /**
   * A version-2 record as this classification reads it: with a revocation it derived applied (an owner removed, a
   * stale send epoch, or — for a claim or an approval — a live `never`). Null for every other form.
   */
  readonly record: ApprovalRecord | null;
  /** Whether `record` carries a revocation the classification derived, for a locked action to persist. */
  readonly revokes: boolean;
  /** Where it stands, as D8 shows it (`publicApproval`). */
  readonly approval: ApprovalObject;
  /** What the action is refused with, when it is refused by the record's state alone. */
  readonly error?: CommsError | undefined;
}

export interface OutcomeContext {
  readonly action: OutcomeAction;
  /** The configuration's word on the record, or null for a store opened without one: nothing is then claimable. */
  readonly live: LiveGate | null;
  /** When it is classified: the time a derived revocation is written with. */
  readonly now: Date;
  /** The words a used send's refusal says what became of it in, on the surface refusing it: `sentAtWords` when left out. */
  readonly usedSaid?: UsedSaid | undefined;
}

/**
 * What became of a used send, in the words of the surface that says it, from the time the provider accepted it (D2's
 * used-send row): Gmail and Slack, where acceptance is sending, say it was "sent at …"; Resend's own surfaces that it
 * was "accepted by Resend at …"; core's generic surfaces "accepted by <provider> at …".
 */
export type UsedSaid = (usedAt: string) => string;

/** A used send, said as sent: the refusal's words where the surface gives none — acceptance is sending. */
export const sentAtWords: UsedSaid = (usedAt) => `sent at ${usedAt}`;

/** The refusal prefix and detail key of each kind: a send sends nothing, a change changes nothing, a question saves nothing. */
function refusalOf(kind: ApprovalKind) {
  const [prefix, idKey, hint] =
    kind === 'disclosure'
      ? [
          'nothing was disclosed',
          'approvalId',
          'Prepare a new standing disclosure authorisation and show its exact activation preview to the person.',
        ]
      : kind === 'change'
        ? ['nothing was changed', 'approvalId', 'Prepare the change again and show the new preview to the user.']
        : kind === 'download'
          ? [
              'nothing was saved',
              'choiceId',
              'Make the download again without an answer, and show the person the new question.',
            ]
          : ['nothing was sent', 'approvalId', 'Prepare the send again and show the new preview to the user.'];
  return (code: ErrorCode, reason: string, record: ApprovalRecord, approval: ApprovalObject, said = hint) =>
    new CommsError(code, `${prefix}: ${reason}`, {
      hint: said,
      details: { [idKey]: record.approvalId, state: record.state, approval },
    });
}

/**
 * The one `NOT_FOUND`: for an id that names nothing, and for one that names a record of another kind, another owner,
 * or one a pinned surface may not see — byte for byte the same, with `approval: null`, and nothing of any record in it.
 */
export function approvalNotFound(approvalId: string, kind: ApprovalKind | undefined): CommsError {
  const prefix =
    kind === 'disclosure'
      ? 'nothing was disclosed'
      : kind === 'change'
        ? 'nothing was changed'
        : kind === 'download'
          ? 'nothing was saved'
          : 'nothing was sent';
  return new CommsError('NOT_FOUND', `${prefix}: no approval ${approvalId}`, {
    hint: 'Check the id: an approval is only found by the surface, the kind and the owner it was prepared for.',
    details: { approval: null },
  });
}

/** D8's object for a version-2 record and its classification. */
function objectOf(
  record: ApprovalRecord,
  state: PublicApprovalState,
  claimable: boolean,
  ownerRemoved: boolean,
  reason: string | undefined,
): ApprovalObject {
  const optional = <K extends keyof ApprovalObject>(key: K, value: ApprovalObject[K] | undefined) =>
    value === undefined ? {} : { [key]: value };
  return {
    id: record.approvalId,
    kind: record.kind,
    channel: record.channel,
    state,
    claimable,
    ...optional('route', record.route),
    ...(ownerRemoved ? { ownerRemoved: true as const } : {}),
    ...optional('reason', reason),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...optional('approvedAt', record.approvedAt),
    ...optional('usableUntil', record.usableUntil),
    ...optional('sendingAt', record.sendingAt),
    ...optional('sendingHeartbeatAt', record.sendingHeartbeatAt),
    ...optional(
      'unknownAt',
      record.state === 'sending' || record.state === 'unknown' ? unknownAtOf(record) : undefined,
    ),
    ...optional('usedAt', record.usedAt),
    ...optional('sentAt', record.sentAt),
    ...optional('sentMessageId', record.state === 'used' ? record.sentMessageId : undefined),
    ...optional('failedAt', record.failedAt),
    ...optional('revokedAt', record.revokedAt),
    ...optional('expiredAt', record.expiredAt),
  };
}

/** Standing disclosure has no channel owner, draft, policy or sender-controlled field to classify. */
function disclosureObjectOf(record: ApprovalRecord, claimable: boolean, reason?: string): ApprovalObject {
  return {
    id: record.approvalId,
    kind: 'disclosure',
    channel: null,
    state: record.state,
    claimable,
    ...(reason === undefined ? {} : { reason }),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.approvedAt === undefined ? {} : { approvedAt: record.approvedAt }),
    ...(record.usableUntil === undefined ? {} : { usableUntil: record.usableUntil }),
    ...(record.usedAt === undefined ? {} : { usedAt: record.usedAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.expiredAt === undefined ? {} : { expiredAt: record.expiredAt }),
  };
}

/**
 * Every place an approval shows something a sender could have written (design 2026-10-05 §D8): the recipients and
 * subject a send expects — a draft's, which a reply takes from the mail it answers — and the names a download's
 * question would save its files under. Each is wrapped in the untrusted-content envelope on every record that shows it,
 * a removed owner's and an earlier release's included. Fixed: a field not on this list is never shown.
 */
export const SENDER_CONTROLLED_FIELDS: readonly string[] = Object.freeze([
  'expect.to',
  'expect.cc',
  'expect.bcc',
  'expect.subject',
  'files.names',
  'files.listing',
]);

/** The kind of sender-controlled field a string is, for the envelope it goes in. */
export type SenderField = 'to' | 'cc' | 'bcc' | 'subject' | 'filename';

/**
 * Wraps one sender-controlled string: core's envelope, always, by default. A channel that shows the object on its own
 * surface may wrap with its own helpers — Gmail's leaves a plain address bare and wraps anything that is not one.
 */
export type SenderFieldWrapper = (text: string, field: SenderField) => string;

/**
 * An approval as a status, a wait or a list shows it (design 2026-10-05 §D8): D8's object, under the id it is listed
 * by, with what it was for — every string a sender could have written inside its envelope — and a line saying where it
 * stands where the state has words of its own. Never a challenge hash or a claim token.
 */
export interface PublicApprovalObject extends ApprovalObject {
  readonly approvalId: string;
  /** The mailbox or account it belongs to, by its id: software data, never a name a sender chose. */
  readonly inboxId?: string | undefined;
  /** A send's draft, by the provider's id. */
  readonly draftId?: string | undefined;
  /** What a send expects, or a change's summary as its subject: each string enveloped. */
  readonly expect?: { readonly to: string[]; readonly cc: string[]; readonly bcc: string[]; readonly subject: string };
  /** A download's question: the names its files would be saved under, as listed, enveloped. */
  readonly files?: { readonly names: string[]; readonly listing?: string[] | undefined } | undefined;
  /**
   * Where it stands, in words, for the states that have their own: expired, used, an earlier release's, and a
   * download's question answered — where and to which folder, or `answered (in chat)` with no folder at all.
   */
  readonly said?: string | undefined;
}

/**
 * What a status, a wait or a list shows of one record: its public object, or — for a record whose owner cannot be
 * trusted, unreadable or with a binding that does not verify — exactly the stub `{ approvalId, state: 'corrupt',
 * reason }`, and nothing from the file (D2). Either way every key of the object can be read; a stub's are absent.
 */
export type PublicApprovalView =
  | PublicApprovalObject
  | (CorruptStub & { readonly [K in Exclude<keyof PublicApprovalObject, keyof CorruptStub>]?: undefined });

export interface PublicApprovalOptions {
  /** How each sender-controlled string is wrapped: core's envelope when left out. */
  readonly wrap?: SenderFieldWrapper | undefined;
  /** The words for a used send on the surface showing it: "accepted by <channel> at …" when left out. */
  readonly usedSaid?: ((usedAt: string) => string) | undefined;
}

/** A channel's label, from the manifest snapshot, or its word when it is none this release knows. */
function labelOf(channel: string): string {
  return isChannel(channel) ? channelLabel(channel) : channel;
}

/**
 * A download's question that expired, in words (D2): whether the person had answered it — at the terminal or in a
 * form, which the question records — and never when, since no answer time is kept.
 */
export function downloadExpiredWords(answered: boolean): string {
  return answered
    ? 'the question was answered and expired before it was used'
    : 'the question expired before it was answered';
}

/**
 * A download's answered question, in words (D2): where the person answered it and the folder they chose, when they
 * answered at the terminal or in a form, which the question records — or `answered (in chat)`, with no folder at all,
 * when it was claimed with an answer from the chat: that answer is never kept, so there is nothing to say it named.
 */
export function downloadAnsweredWords(record: Pick<ApprovalRecord, 'approvedVia' | 'download'>): string {
  const answer = record.download?.answer;
  if (record.approvedVia === undefined || answer === undefined) return 'answered (in chat)';
  const where = record.approvedVia === 'terminal' ? 'at the terminal' : 'in a form';
  const folder =
    answer.choice === 'other' ? answer.folder : `${answer.choice} (${record.download?.folders[answer.choice]})`;
  return `answered ${where}: save to ${folder}`;
}

/** Where a record stands, in words, for the states that have their own (D2): or nothing. */
function saidOf(
  approval: ApprovalObject,
  facts: { kind: ApprovalKind | null; answered: boolean; answeredWords: string | undefined },
  options: PublicApprovalOptions,
): string | undefined {
  if (approval.legacy === true) {
    return approval.channel === null
      ? 'an earlier release’s approval: shown, and never used here'
      : `an earlier release’s ${labelOf(approval.channel)} approval: shown, and never used here`;
  }
  if (approval.state === 'answered') return facts.answeredWords;
  if (approval.state === 'expired') {
    if (facts.kind === 'download') return downloadExpiredWords(facts.answered);
    const nothing =
      facts.kind === 'change'
        ? 'nothing was changed with it'
        : facts.kind === 'disclosure'
          ? 'nothing was disclosed with it'
          : 'nothing was sent with it';
    return approval.reason === CLOCK_ANOMALY
      ? `the clock moved backwards; this approval was expired safely at ${approval.expiredAt}; ${nothing}`
      : `this approval expired; ${nothing}`;
  }
  if (approval.state === 'used' && facts.kind === 'send' && approval.usedAt !== undefined) {
    return (
      options.usedSaid?.(approval.usedAt) ??
      `accepted by ${approval.channel === null ? 'its provider' : labelOf(approval.channel)} at ${approval.usedAt}`
    );
  }
  return undefined;
}

/**
 * D8's public object for one stored record and its classification — what a status, a wait and a list show
 * (design 2026-10-05 §D8). A record whose owner cannot be trusted is shown as its stub alone. Every other — version 2,
 * an earlier release's, a corrupt one whose binding verifies — shows what it was for, each sender-controlled field
 * (`SENDER_CONTROLLED_FIELDS`) wrapped, whoever its owner is now.
 */
export function publicApproval(
  stored: StoredApproval,
  outcome: ApprovalOutcome,
  options: PublicApprovalOptions = {},
): PublicApprovalView {
  const stub = corruptStubOf(stored);
  if (stub !== null && (stored.form === 'unreadable' || (stored.form === 'corrupt' && stored.safe === null))) {
    return stub;
  }
  const approval = outcome.approval;
  const boundary = newBoundary();
  const wrap: SenderFieldWrapper =
    options.wrap ?? ((text, field) => wrapUntrusted(text, { field, id: approval.id }, boundary));
  const source =
    stored.form === 'v2' && stored.record.kind !== 'disclosure'
      ? {
          inboxId: stored.record.inboxId,
          draftId: stored.record.draftId,
          expect: stored.record.expect,
          download: stored.record.download,
          answered: stored.record.approvedVia !== undefined,
          answeredWords: stored.record.kind === 'download' ? downloadAnsweredWords(stored.record) : undefined,
        }
      : stored.form === 'legacy'
        ? {
            inboxId: stored.view.inboxId,
            draftId: stored.record.draftId,
            expect: stored.view.expect,
            download: stored.record.download,
            answered: stored.record.approvedVia !== undefined,
            answeredWords: undefined,
          }
        : stored.form === 'corrupt' && stored.safe !== null && stored.safe.kind !== 'disclosure'
          ? {
              inboxId: stored.safe.inboxId,
              draftId: stored.safe.draftId,
              expect: stored.safe.expect,
              download: undefined,
              answered: false,
              answeredWords: undefined,
            }
          : null;
  const kind = approval.kind;
  const expect =
    source === null
      ? undefined
      : {
          to: source.expect.to.map((to) => wrap(to, 'to')),
          cc: source.expect.cc.map((cc) => wrap(cc, 'cc')),
          bcc: source.expect.bcc.map((bcc) => wrap(bcc, 'bcc')),
          subject: wrap(source.expect.subject, 'subject'),
        };
  const download = source?.download;
  const files =
    download === undefined
      ? undefined
      : {
          names: download.names.map((name) => wrap(name, 'filename')),
          ...(download.listing === undefined
            ? {}
            : { listing: download.listing.map((file) => wrap(file.name, 'filename')) }),
        };
  const said = saidOf(
    approval,
    { kind, answered: source?.answered ?? false, answeredWords: source?.answeredWords },
    options,
  );
  return {
    approvalId: approval.id,
    ...approval,
    ...(source === null ? {} : { inboxId: source.inboxId }),
    ...(source !== null && kind === 'send' ? { draftId: source.draftId } : {}),
    ...(expect === undefined ? {} : { expect }),
    ...(files === undefined ? {} : { files }),
    ...(said === undefined ? {} : { said }),
  };
}

/**
 * D8's object for a version-2 record as a result reports it: the record a call has just written or claimed, classified
 * as a look at it would be (`inspect`) against `live` — null when there is no configuration to read, which leaves
 * nothing claimable. Pure: what decides is the store's locked classification, and this only says where it stands.
 */
export function approvalObjectOf(record: ApprovalRecord, live: LiveGate | null, now: Date): ApprovalObject {
  if (record.kind === 'disclosure') return classifyDisclosure(record).approval;
  return classifyV2(record, { action: 'inspect', live, now }).approval;
}

/**
 * `error` saying where its approval stands (decision 8: a refusal carries its approval object in
 * `CommsError.details.approval`) — unless it says so already, `approval: null` for a `NOT_FOUND` included, or it is
 * not a refusal of ours at all. Everything else about the error is kept: its code, its words, its other details.
 */
export function withApproval(error: unknown, approval: ApprovalObject | null): unknown {
  if (!(error instanceof CommsError)) return error;
  if (error.details !== undefined && Object.hasOwn(error.details, 'approval')) return error;
  return new CommsError(error.code, error.message, {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    details: { ...error.details, approval },
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

/**
 * Classifies one stored approval for one action.
 *
 * A version-2 record arrives with its derived expiry already applied (the store's `#derive`). Then, in this order:
 *
 * - an `owner`-scope record whose owner is gone: `pending` and `approved` read `revoked` (`its mailbox or account was
 *   removed`); every other state keeps its own. Either way `ownerRemoved`, and nothing of a policy or an epoch is
 *   applied.
 * - a `pending` or `approved` send under a live `never` — the owner's policy, or `requiredPolicy` — keeps its real
 *   state and cannot be claimed; a claim or an approval revokes it (`POLICY_NEVER`). Said before a stale epoch, which
 *   a `never` always leaves behind it: sending is off now, and that is what the caller needs to hear.
 * - otherwise, a `pending` or `approved` send whose stored epoch is not the live one reads `revoked`
 *   (`SEND_EPOCH_REASON`), whatever the policy is by then: a record prepared before a `never` never sends.
 * - a pending send or change is claimable only on the `chat` route while the live policy is still `chat`; an approved
 *   one until its window closes. A download's question by its own matrix (`downloadClaimable`): pending, while both
 *   its own and the live change policy are `chat`; answered, until it expires.
 *
 * A store opened without a configuration (`live: null`) never makes anything claimable, and refuses a claim or an
 * approval with `CONFIG`. A record from an earlier release, or one that failed its integrity check, is never claimable
 * and is refused as such.
 */
export function approvalOutcome(stored: StoredApproval, context: OutcomeContext): ApprovalOutcome {
  if (stored.form === 'legacy') {
    const view = stored.view;
    const approval: ApprovalObject = {
      id: view.approvalId,
      kind: view.kind,
      channel: view.channel ?? null,
      state: view.state,
      claimable: false,
      legacy: true,
      createdAt: view.createdAt,
      expiresAt: view.expiresAt,
    };
    return {
      state: view.state,
      claimable: false,
      record: null,
      revokes: false,
      approval,
      error: withApproval(otherVersionRefusal(view), approval) as CommsError,
    };
  }
  if (stored.form === 'corrupt' || stored.form === 'unreadable') {
    const id = stored.form === 'corrupt' ? stored.approvalId : stored.stub.approvalId;
    const reason = stored.form === 'corrupt' ? stored.reason : stored.stub.reason;
    const safe = stored.form === 'corrupt' ? stored.safe : null;
    return {
      state: 'corrupt',
      claimable: false,
      reason,
      record: null,
      revokes: false,
      approval: {
        id,
        kind: safe?.kind ?? null,
        channel: safe?.kind === 'disclosure' ? null : (safe?.channel ?? null),
        state: 'corrupt',
        claimable: false,
        reason,
      },
      error: integrityRefusal(stored),
    };
  }
  return classifyV2(stored.record, context);
}

function classifyV2(read: ApprovalRecord, context: OutcomeContext): ApprovalOutcome {
  if (read.kind === 'disclosure') return classifyDisclosure(read);
  const { live, action } = context;
  const at = context.now.toISOString();
  const ownerRemoved = read.ownerScope === 'owner' && live?.owner === 'removed';
  const active = read.state === 'pending' || read.state === 'approved';
  const acting = action === 'approve' || action === 'claim';
  const never =
    read.kind === 'send' &&
    live?.owner === 'present' &&
    stricterPolicy(live.sendPolicy ?? 'never', read.requiredPolicy) === 'never';

  // A revocation the classification derives: from the configuration, not from anything the caller asked.
  // A live `never` is said as itself, before a stale epoch: whatever else is true of the record, sending is off now.
  let derived: string | null = null;
  if (active && ownerRemoved) derived = OWNER_REMOVED_REASON;
  else if (active && never) {
    if (acting) {
      // The owner by its kind, from the channel that prepared it: a mailbox, a workspace, an account.
      derived =
        live?.sendPolicy === 'never'
          ? `sending is turned off for this ${accountNoun(read.channel)} (policy: never)`
          : 'sending is turned off for this approval (policy: never)';
    }
  } else if (active && read.kind === 'send' && live?.owner === 'present' && (read.sendEpoch ?? 0) !== live.sendEpoch) {
    derived = SEND_EPOCH_REASON;
  }
  const record: ApprovalRecord =
    derived === null ? read : { ...read, state: 'revoked', reason: derived, revokedAt: at, challengeHash: undefined };
  const revokedByNever = derived !== null && derived !== OWNER_REMOVED_REASON && derived !== SEND_EPOCH_REASON;

  let claimable = false;
  let reason = record.reason;
  if (record.state === 'pending' || record.state === 'approved') {
    if (live === null) claimable = false;
    else if (never) reason = NEVER_NOTICE;
    else claimable = isClaimable(record, live);
  }
  const state: PublicApprovalState =
    record.kind === 'download' && (record.state === 'approved' || record.state === 'used') ? 'answered' : record.state;
  // A revocation a look derives is not written, and so has no time of its own: the next action writes it, with its own.
  const shown = derived !== null && !acting ? { ...record, revokedAt: undefined } : record;
  const approval = objectOf(shown, state, claimable, ownerRemoved, reason);
  const error = errorOf(record, approval, { action, live, revokedByNever, usedSaid: context.usedSaid ?? sentAtWords });
  return {
    state,
    claimable,
    ...(ownerRemoved ? { ownerRemoved: true as const } : {}),
    ...(reason === undefined ? {} : { reason }),
    record,
    revokes: derived !== null,
    approval,
    ...(error === undefined ? {} : { error }),
  };
}

/** The isolated disclosure state machine never follows a config policy or a channel-owner fence. */
function classifyDisclosure(record: ApprovalRecord): ApprovalOutcome {
  const claimable = record.state === 'approved';
  const approval = disclosureObjectOf(record, claimable, record.reason);
  let error: CommsError | undefined;
  switch (record.state) {
    case 'pending':
    case 'approved':
      break;
    case 'used':
      error = refusalOf('disclosure')(
        'APPROVAL_VOID',
        `the standing disclosure approval was used already at ${record.usedAt}`,
        record,
        approval,
      );
      break;
    case 'expired':
      error = refusalOf('disclosure')(
        'APPROVAL_EXPIRED',
        'the standing disclosure approval expired unused',
        record,
        approval,
      );
      break;
    case 'revoked':
      error = refusalOf('disclosure')(
        'APPROVAL_VOID',
        `the standing disclosure approval was voided (${record.reason ?? 'revoked'})`,
        record,
        approval,
      );
      break;
    default:
      error = refusalOf('disclosure')(
        'APPROVAL_VOID',
        'the standing disclosure approval is in an invalid state',
        record,
        approval,
      );
  }
  return {
    state: record.state,
    claimable,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    record,
    revokes: false,
    approval,
    ...(error === undefined ? {} : { error }),
  };
}

/** Whether an active record can be claimed under `live` (D2, `claimable`). */
function isClaimable(record: ApprovalRecord, live: LiveGate): boolean {
  switch (record.kind) {
    case 'send':
      return record.state === 'approved' || (record.route === 'chat' && live.sendPolicy === 'chat');
    case 'change':
      return record.state === 'approved' || (record.route === 'chat' && live.changePolicy === 'chat');
    case 'download':
      return downloadClaimable(record, live.changePolicy);
    case 'disclosure':
      return record.state === 'approved';
  }
}

/**
 * Whether a download's question can be claimed now — the download `claimable` matrix (design 2026-10-05 §D2):
 *
 * - pending, while both the policy it was asked under (`requiredPolicy`) and the live change policy are `chat`: it can
 *   be answered in the chat now;
 * - pending otherwise: it waits for the person, at their terminal or in a form — loosening the live policy does not
 *   move a question asked under `confirm`;
 * - answered at the terminal or in a form (`approved`), and so unexpired — the store derives expiry first: the save may
 *   proceed;
 * - used, expired, revoked — and corrupt, which never reaches here as a record: never.
 *
 * The one rule a wait, a status and the claim all decide by.
 */
export function downloadClaimable(
  record: Pick<ApprovalRecord, 'state' | 'requiredPolicy'>,
  liveChangePolicy: ChangePolicy | undefined,
): boolean {
  if (record.state === 'approved') return true;
  return record.state === 'pending' && record.requiredPolicy === 'chat' && liveChangePolicy === 'chat';
}

/**
 * The refusal the record's state alone gives an action, in the words of its kind — or undefined where the state does
 * not refuse it (an active record a claim may still check, or anything only looked at).
 *
 * `APPROVAL_REQUIRED` is never one of them: it says a person's approval is missing, and is given only by an approval
 * whose code was wrong (D2).
 */
function errorOf(
  record: ApprovalRecord,
  approval: ApprovalObject,
  context: { action: OutcomeAction; live: LiveGate | null; revokedByNever: boolean; usedSaid: UsedSaid },
): CommsError | undefined {
  const refuse = refusalOf(record.kind);
  const download = record.kind === 'download';
  switch (record.state) {
    case 'pending':
    case 'approved':
      if (context.live === null && (context.action === 'approve' || context.action === 'claim')) {
        return new CommsError('CONFIG', `nothing was done: ${NO_CONFIGURATION}`, {
          hint: 'This is a bug — please report it.',
          details: { approvalId: record.approvalId, state: record.state, approval },
        });
      }
      return undefined;
    case 'revoked':
      if (context.revokedByNever)
        return refuse('POLICY_NEVER', record.reason ?? 'sending is turned off', record, approval);
      return refuse(
        'APPROVAL_VOID',
        download
          ? `the question was voided (${record.reason ?? 'revoked'})`
          : `the approval was voided (${record.reason ?? 'revoked'})`,
        record,
        approval,
      );
    case 'expired': {
      // A question says whether the person had answered it, and never when (D2).
      if (download) {
        return refuse('APPROVAL_EXPIRED', downloadExpiredWords(record.approvedVia !== undefined), record, approval);
      }
      // Said as it happened (D2): before a person approved it, after — or because the clock moved backwards.
      const nothing = `nothing was ${record.kind === 'change' ? 'changed' : 'sent'} with it`;
      const message =
        record.reason === CLOCK_ANOMALY
          ? `the clock moved backwards; this approval was expired safely at ${record.expiredAt}; ${nothing}`
          : record.approvedAt !== undefined
            ? `this approval expired; ${nothing}: approved at ${record.approvedAt}, expired unused at ${record.expiredAt}`
            : `this approval expired; ${nothing}: prepared at ${record.createdAt}, expired at ${record.expiredAt}`;
      return new CommsError('APPROVAL_EXPIRED', message, {
        hint:
          record.kind === 'change'
            ? 'Prepare the change again and show the new preview to the user.'
            : 'Prepare the send again and show the new preview to the user.',
        details: { approvalId: record.approvalId, state: record.state, approval },
      });
    }
    case 'used':
      if (record.kind === 'disclosure') {
        return refuse(
          'APPROVAL_VOID',
          `the standing disclosure approval was used already at ${record.usedAt}`,
          record,
          approval,
        );
      }
      if (download) {
        return refuse(
          'APPROVAL_VOID',
          'the question was answered already, and an answer is used once',
          record,
          approval,
        );
      }
      if (record.kind === 'change') {
        return refuse('APPROVAL_VOID', `the approved change was already claimed at ${record.usedAt}`, record, approval);
      }
      return refuse(
        'APPROVAL_VOID',
        `the approval was used already: it was ${context.usedSaid(String(record.usedAt))}, message id ${record.sentMessageId}`,
        record,
        approval,
        'Prepare a new send only for a new message.',
      );
    case 'failed':
      return refuse(
        'APPROVAL_VOID',
        `the send it was claimed for failed${record.reason === undefined ? '' : ` (${record.reason})`}`,
        record,
        approval,
      );
    case 'sending':
      // Somebody else's call, under way and renewing its lease: retryable, and never "prepare again".
      return refuse(
        'APPROVAL_PENDING',
        `it is being sent by another call since ${record.sendingAt}; wait for it`,
        record,
        approval,
        `Wait for that call to finish — it holds the send until ${approval.unknownAt} unless it renews it — then look at the approval again. Do not prepare it again.`,
      );
    case 'unknown':
      return new CommsError('SEND_OUTCOME_UNKNOWN', 'the outcome of its send is unknown: it may have gone out', {
        hint: 'Check Sent, or the channel, before anything else: the call that claimed it may still record a late result. Prepare it again only once you know it did not go.',
        details: { approvalId: record.approvalId, state: record.state, approval },
      });
  }
}
